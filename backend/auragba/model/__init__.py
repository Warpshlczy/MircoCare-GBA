"""Three-stream fusion classifier: interpretable acoustic / semantic / behavior."""

from .acoustic import ACOUSTIC_NORMS, score_acoustic
from .behavior import flatten, load_stream, score_behavior
from .fusion import FusionResult, late_fusion
from .semantic import SEMANTIC_NORMS, score_semantic

__all__ = [
    "score_acoustic",
    "score_semantic",
    "score_behavior",
    "load_stream",
    "flatten",
    "late_fusion",
    "FusionResult",
    "ACOUSTIC_NORMS",
    "SEMANTIC_NORMS",
]