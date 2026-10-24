"""MemoMate (忆伴) backend — multimodal MCI/AD speech-screening engine.

Privacy-first: raw audio and raw sensor streams never leave the device. This
backend ingests VAD-trimmed derived features (or audio that it extracts-and-burns
on the spot) and tags everything with a pseudonymous DeviceId only.
"""

from .config import ENGINE_VERSION, FEATURE_SET_VERSION, settings

__all__ = ["ENGINE_VERSION", "FEATURE_SET_VERSION", "settings"]