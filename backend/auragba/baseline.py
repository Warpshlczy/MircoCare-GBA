"""Personal-baseline dynamic tracking — robust Z, trend and change point.

Compares today's derived metrics against the senior's OWN trailing window
(default 14 days), not a fixed population threshold. A metric that is "normal"
for the population but a clear departure from this person's baseline is the
signal we want (research: longitudinal first).

Robustness: the reference is the median and ``1.4826 * MAD`` instead of mean/std,
so one bad sample (a cough, the TV, a cold) does not move the baseline. The
classic mean/std are still reported for transparency, but they never decide a Z.
Trend and CUSUM run over a longer window (``settings.trend_days``) so a drift is
visible even while the Z window itself stays narrow.

`ponytail:` per-feature independent tests; no seasonality, no covariance between
features, no hierarchical shrinkage. Upgrade once cohorts exist.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .changepoint import detect
from .config import settings

# Which biomarkers are tracked, and how to read the sign of a deviation.
# (+1 = a HIGHER value is the concern, -1 = a LOWER value is the concern.)
TRACKED: dict[str, int] = {
    "jitter_local": +1,
    "shimmer_local": +1,
    "hnr_db": -1,
    "f0_cv": -1,
    "articulation_rate": -1,
    "speech_rate": -1,
    "pause_ratio": +1,
    "mean_pause_s": +1,
    "voiced_ratio": -1,
    "f2_hz": -1,
    "ttr": -1,
    "mattr": -1,
    "sentence_len_variance": +1,
    "filler_ratio": +1,
    "coherence": -1,
}
_WATCH_Z = 1.5
_ELEVATED_Z = 2.5
# 5 samples make the MAD meaningless (it is the median of 5 residuals); claiming
# a personal baseline needs at least 10.
_MIN_SAMPLES = 10
_MIN_TREND_SPAN_DAYS = 7
_EPS = 1e-9


@dataclass
class MetricZ:
    name: str
    value: float
    mean: float  # classic arithmetic mean of the reference window (transparency)
    std: float  # classic std of the reference window (transparency)
    median: float  # robust centre actually used for Z
    scale: float  # robust scale (1.4826 * MAD) actually used for Z
    z: float
    direction: str
    flag: str
    trend: float = 0.0  # slope in feature units per week (0 when too short)
    changepoint_at: int | None = None
    sustained: bool = False  # >= 3 same-direction deviations, not one spike


@dataclass
class BaselineOutcome:
    rows: list[MetricZ] = field(default_factory=list)
    sufficient: bool = False
    note: str | None = None
    samples: int = 0  # reference samples inside the Z window
    changepoints: list[dict] = field(default_factory=list)  # {feature, at, direction}


def _flag(z: float, concern_sign: int) -> str:
    """Flag only deviations in the concerning direction; a big protective swing
    is not a risk signal."""
    if concern_sign > 0 and z >= _ELEVATED_Z or concern_sign < 0 and z <= -_ELEVATED_Z:
        return "elevated"
    if concern_sign > 0 and z >= _WATCH_Z or concern_sign < 0 and z <= -_WATCH_Z:
        return "watch"
    return "normal"


def _trend_per_week(at_ms: list[int | None], values: list[float]) -> float:
    """Least-squares slope per week; 0.0 when the span is shorter than a week."""
    if len(values) < 3 or any(t is None for t in at_ms):
        return 0.0
    stamps = np.asarray([float(t) for t in at_ms], dtype=float)
    weeks = (stamps - stamps.min()) / 604_800_000.0
    if float(weeks.max()) < _MIN_TREND_SPAN_DAYS / 7.0:
        return 0.0
    slope = float(np.polyfit(weeks, np.asarray(values, dtype=float), 1)[0])
    return slope if np.isfinite(slope) else 0.0


def compute_baseline(
    history: list[dict[str, float]],
    today: dict[str, float],
    *,
    at_ms: list[int] | None = None,
    z_window_days: int | None = None,
) -> BaselineOutcome:
    """-> robust per-metric rows, sufficiency, sample count and change points.

    ``history`` holds prior metric dicts (one per screening). ``at_ms`` are the
    matching epoch-ms timestamps; when supplied together with ``z_window_days``
    only samples inside that window feed the Z reference, while trend/CUSUM use
    the whole (longer) history window the caller passed.
    """
    total = len(history)
    times = at_ms if at_ms is not None and len(at_ms) == total else None

    if times and z_window_days:
        cutoff = max(times) - z_window_days * 86_400_000
        ref_idx = {i for i, t in enumerate(times) if t >= cutoff}
    else:
        ref_idx = set(range(total))

    if len(ref_idx) < _MIN_SAMPLES:
        return BaselineOutcome(
            sufficient=False,
            samples=len(ref_idx),
            note=(
                f"insufficient baseline: {len(ref_idx)}/{_MIN_SAMPLES} prior samples "
                f"needed in the last {settings.baseline_days} days"
            ),
        )

    rows: list[MetricZ] = []
    points: list[dict] = []
    for name, concern_sign in TRACKED.items():
        if name not in today:
            continue
        pairs = [
            (i, times[i] if times else None, float(history[i][name]))
            for i in range(total)
            if name in history[i]
        ]
        ref_vals = np.asarray([v for i, _, v in pairs if i in ref_idx], dtype=float)
        if ref_vals.size < _MIN_SAMPLES:
            continue

        median = float(np.median(ref_vals))
        scale = 1.4826 * float(np.median(np.abs(ref_vals - median)))
        if scale <= _EPS:
            # MAD collapses when >half the samples are identical; fall back to a
            # fraction of the centre so the Z stays finite instead of dividing by 0.
            scale = 0.05 * abs(median)
        z = (float(today[name]) - median) / scale if scale > _EPS else 0.0

        values = [v for _, _, v in pairs]
        stamps = [t for _, t, _ in pairs]
        change = detect(values, at=stamps) if all(t is not None for t in stamps) else detect(values)
        if change is not None:
            points.append({"feature": name, "at": change.at, "direction": change.direction})

        historic_z = [(v - median) / scale for v in values] if scale > _EPS else [0.0] * len(values)
        if z > 0:
            same_direction = sum(1 for hz in historic_z if hz >= _WATCH_Z)
        else:
            same_direction = sum(1 for hz in historic_z if hz <= -_WATCH_Z)
        sustained = same_direction + (1 if abs(z) >= _WATCH_Z else 0) >= 3

        rows.append(
            MetricZ(
                name=name,
                value=float(today[name]),
                mean=float(np.mean(ref_vals)),
                std=float(np.std(ref_vals)),
                median=median,
                scale=scale,
                z=z,
                direction="normal" if abs(z) < _WATCH_Z else ("high" if z > 0 else "low"),
                flag=_flag(z, concern_sign),
                trend=_trend_per_week(stamps, values),
                changepoint_at=change.at if change is not None else None,
                sustained=sustained,
            )
        )

    points.sort(key=lambda p: (p["at"] is None, p["at"] or 0, p["feature"]))
    if not rows:
        # Sample count alone is not a baseline: a device that only uploads
        # energy/envelope features has nothing comparable to the tracked
        # biomarkers, and claiming "stable" here would be an assertion.
        return BaselineOutcome(
            sufficient=False,
            samples=len(ref_idx),
            note="insufficient baseline: no tracked biomarker metrics in the samples",
        )
    return BaselineOutcome(rows=rows, sufficient=True, samples=len(ref_idx), changepoints=points)
