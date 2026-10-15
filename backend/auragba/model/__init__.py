"""Dual-stream fusion classifier: interpretable acoustic / semantic streams."""

from .acoustic import ACOUSTIC_NORMS, score_acoustic
from .fusion import FusionResult, late_fusion
from .semantic import SEMANTIC_NORMS, score_semantic

__all__ = [
    "score_acoustic",
    "score_semantic",
    "late_fusion",
    "FusionResult",
    "ACOUSTIC_NORMS",
    "SEMANTIC_NORMS",
]