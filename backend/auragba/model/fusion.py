"""Late-fusion layer — combine stream scores into one MCI risk index.

Two modes:

* behaviour stream present -> three-stream weights from `settings.fusion3_*`
  (initial prior 0.15 / 0.65 / 0.20), renormalised over the streams that exist.
* behaviour absent -> the calibrated two-stream weights from `settings.fusion_*`
  (0.2 / 0.8). This is deliberately NOT "renormalise the three-stream weights",
  because it would move historical results away from the 322-subject calibration.

A single remaining stream can never produce `watch`/`elevated`: the result is
pinned to `low` and flagged `insufficient_streams`, so no one is labelled from
one signal alone.

`ponytail:` a fixed weighted mean, not a stacked meta-learner — transparent and
auditable, which is the point at this stage. Upgrade: a logistic stacker over
all three stream outputs once labelled outcomes exist.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..config import settings
from ..contract import StreamScore
from .behavior import neutral_score


@dataclass
class FusionResult:
    risk_index: float
    band: str
    weights: dict[str, float]
    acoustic: StreamScore
    semantic: StreamScore | None
    behavior: StreamScore | None = None
    insufficient_streams: bool = False


def late_fusion(
    acoustic: StreamScore,
    semantic: StreamScore | None,
    behavior: StreamScore | None = None,
) -> FusionResult:
    available: dict[str, StreamScore] = {"acoustic": acoustic}
    if semantic is not None:
        available["semantic"] = semantic
    if behavior is not None:
        available["behavior"] = behavior

    if behavior is not None:
        raw = {
            "acoustic": max(0.0, settings.fusion3_w_acoustic),
            "semantic": max(0.0, settings.fusion3_w_semantic),
            "behavior": max(0.0, settings.fusion3_w_behavior),
        }
    else:
        raw = {
            "acoustic": max(0.0, settings.fusion_w_acoustic),
            "semantic": max(0.0, settings.fusion_w_semantic),
        }

    total = sum(raw[name] for name in available)
    if total <= 0.0:
        # Misconfiguration: fall back to the acoustic stream rather than invent
        # numbers, and keep the single-stream guard below active.
        weights = {"acoustic": 1.0}
    else:
        weights = {name: raw[name] / total for name in available}

    risk = sum(weights[name] * available[name].score for name in available)
    risk = float(min(1.0, max(0.0, risk)))
    insufficient = len(available) < 2
    return FusionResult(
        risk_index=risk,
        band="low" if insufficient else _band(risk, weights.get("behavior"), behavior is not None),
        weights=weights,
        acoustic=acoustic,
        semantic=semantic,
        behavior=behavior,
        insufficient_streams=insufficient,
    )


def _band(risk: float, behavior_weight: float | None, has_behavior: bool) -> str:
    """Two-stream thresholds, transferred onto the three-stream scale.

    With behaviour present the calibrated cut-offs no longer sit at the same
    place: a senior whose behaviour is *typical* (every feature at its prior
    median) should still fall on the same band boundary as before. So we shift
    each cut-off by the behaviour stream's neutral score:

        t3 = (1 - w_b) * t2 + w_b * neutral

    This is a calibration transfer, not a re-validation — documented as such in
    `docs/evidence/fusion-sweep.md`.
    """
    if not has_behavior or behavior_weight is None:
        return settings.risk_band(risk)
    neutral = neutral_score()
    watch = (1.0 - behavior_weight) * settings.risk_watch + behavior_weight * neutral
    elevated = (1.0 - behavior_weight) * settings.risk_elevated + behavior_weight * neutral
    if risk >= elevated:
        return "elevated"
    if risk >= watch:
        return "watch"
    return "low"
