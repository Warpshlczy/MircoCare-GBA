"""Late-fusion layer — combine the two stream scores into one MCI risk index.

Weighted average of the acoustic and semantic streams (weights from settings,
auto-normalised). When the semantic stream is missing (no ASR), the acoustic
stream carries the full weight rather than inventing a score.

`ponytail:` the fusion is a fixed weighted mean, not a stacked meta-learner —
it is transparent and auditable, which is the point at this stage. Upgrade: a
logistic stacker over both streams' outputs once labelled outcomes exist.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..config import settings
from ..contract import StreamScore


@dataclass
class FusionResult:
    risk_index: float
    band: str
    weights: dict[str, float]
    acoustic: StreamScore
    semantic: StreamScore | None


def late_fusion(acoustic: StreamScore, semantic: StreamScore | None) -> FusionResult:
    w_a = max(0.0, settings.fusion_w_acoustic)
    w_s = max(0.0, settings.fusion_w_semantic)
    if semantic is None or (w_a + w_s) == 0.0:
        weights = {"acoustic": 1.0, "semantic": 0.0}
        risk = acoustic.score
    else:
        total = w_a + w_s
        weights = {"acoustic": w_a / total, "semantic": w_s / total}
        risk = weights["acoustic"] * acoustic.score + weights["semantic"] * semantic.score
    risk = float(min(1.0, max(0.0, risk)))
    return FusionResult(
        risk_index=risk,
        band=settings.risk_band(risk),
        weights=weights,
        acoustic=acoustic,
        semantic=semantic,
    )