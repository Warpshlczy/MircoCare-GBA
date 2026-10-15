"""Personal-baseline dynamic tracking — Z-score anomaly detection.

Compares today's derived metrics against the senior's OWN trailing window
(default 14 days), not a fixed population threshold. A metric that is "normal"
for the population but a clear departure from this person's baseline is the
signal we want (research: longitudinal first).

`ponytail:` mean/std Z-score over a rolling window with a minimum-sample guard;
no seasonality, no robust median/MAD, no drift model. Upgrade: robust MAD-based
scores + trend slope once more history accumulates.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

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
_MIN_SAMPLES = 5  # below this we do not claim a baseline


@dataclass
class MetricZ:
    name: str
    value: float
    mean: float
    std: float
    z: float
    direction: str
    flag: str


def _flag(z: float, concern_sign: int) -> str:
    """Flag only deviations in the concerning direction; a big protective swing
    is not a risk signal."""
    if concern_sign > 0 and z >= _ELEVATED_Z or concern_sign < 0 and z <= -_ELEVATED_Z:
        return "elevated"
    if concern_sign > 0 and z >= _WATCH_Z or concern_sign < 0 and z <= -_WATCH_Z:
        return "watch"
    return "normal"


def compute_baseline(history: list[dict[str, float]], today: dict[str, float]) -> tuple[list[MetricZ], bool, str | None]:
    """-> (per-metric Z rows, sufficient?, note).

    `history` is a list of past metric dicts (one per prior screening);
    `today` is the current screening's metrics.
    """
    samples = len(history)
    if samples < _MIN_SAMPLES:
        return [], False, (
            f"insufficient baseline: {samples}/{_MIN_SAMPLES} prior samples "
            f"needed in the last {settings.baseline_days} days"
        )

    rows: list[MetricZ] = []
    for name, concern_sign in TRACKED.items():
        if name not in today:
            continue
        series = np.array([float(h[name]) for h in history if name in h], dtype=float)
        if series.size < _MIN_SAMPLES:
            continue
        mean, std = float(np.mean(series)), float(np.std(series))
        z = (float(today[name]) - mean) / std if std > 1e-9 else 0.0
        direction = "normal"
        if z >= _WATCH_Z:
            direction = "high"
        elif z <= -_WATCH_Z:
            direction = "low"
        rows.append(
            MetricZ(
                name=name, value=float(today[name]), mean=mean, std=std, z=z,
                direction=direction, flag=_flag(z, concern_sign),
            )
        )
    return rows, True, None