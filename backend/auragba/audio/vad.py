"""Voice-activity detection — framing, adaptive energy threshold, silence trim.

Mirrors the frontend `lib/signal.ts` contract `{speech, ratio}` so the backend and
the on-device VAD speak the same language (see DEV.md §6 #9).

`ponytail:` energy/threshold VAD, not a learned model — it misses quiet or
low-pitched speech and can be fooled by steady noise. The upgrade path is Silero
(onnxruntime) with the SAME `{speech, ratio}` + segment contract, so callers need
no change.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class VadResult:
    speech: bool
    ratio: float
    segments: list[tuple[int, int]] = field(default_factory=list)  # (start_frame, end_frame)


def frame_signal(samples: np.ndarray, sr: int, frame_ms: float = 25.0, hop_ms: float = 10.0) -> np.ndarray:
    """Split into overlapping frames -> shape (n_frames, frame_len)."""
    frame_len = max(1, int(sr * frame_ms / 1000.0))
    hop = max(1, int(sr * hop_ms / 1000.0))
    if samples.size < frame_len:
        return samples.reshape(1, -1).astype(np.float64)
    windows = np.lib.stride_tricks.sliding_window_view(samples, frame_len)[::hop]
    return windows.astype(np.float64)


def frame_rms_db(samples: np.ndarray, sr: int, frame_ms: float = 25.0, hop_ms: float = 10.0) -> np.ndarray:
    """Per-frame loudness in dBFS (clamped to -100)."""
    frames = frame_signal(samples, sr, frame_ms, hop_ms)
    rms = np.sqrt(np.mean(frames**2, axis=1) + 1e-12)
    return np.clip(20.0 * np.log10(rms), -100.0, 0.0)


def energy_vad(
    frames_db: np.ndarray,
    *,
    noise_margin_db: float = 8.0,
    hangover_frames: int = 6,
    min_speech_frames: int = 3,
) -> VadResult:
    """Adaptive-threshold VAD with hangover smoothing."""
    if frames_db.size == 0:
        return VadResult(speech=False, ratio=0.0)
    noise_floor = float(np.percentile(frames_db, 20))
    threshold = max(noise_floor + noise_margin_db, -55.0)
    active = frames_db > threshold

    # hangover: keep the tail of short inter-word gaps attached to speech
    if hangover_frames > 0 and active.any():
        idx = np.where(active)[0]
        keep = np.zeros_like(active)
        for i in idx:
            keep[i : i + hangover_frames + 1] = True
        active = active | (keep & (frames_db > threshold - 4.0))

    segments = _runs(active, min_speech_frames)
    ratio = float(active.mean())
    return VadResult(speech=bool(segments), ratio=ratio, segments=segments)


def _runs(mask: np.ndarray, min_len: int) -> list[tuple[int, int]]:
    segments: list[tuple[int, int]] = []
    start: int | None = None
    for i, on in enumerate(mask):
        if on and start is None:
            start = i
        elif not on and start is not None:
            if i - start >= min_len:
                segments.append((start, i))
            start = None
    if start is not None and len(mask) - start >= min_len:
        segments.append((start, len(mask)))
    return segments


def trim_silence(frames_db: np.ndarray, noise_margin_db: float = 8.0) -> tuple[int, int]:
    """First/last active frame index (end is exclusive); (0, 0) if all silent."""
    if frames_db.size == 0:
        return 0, 0
    vad = energy_vad(frames_db, noise_margin_db=noise_margin_db)
    if not vad.segments:
        return 0, 0
    return vad.segments[0][0], vad.segments[-1][1]