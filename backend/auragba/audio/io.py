"""Audio loading / conditioning.

WAV is decoded with the standard library (`wave`) so the pipeline runs with no
extra dependency; FLAC and other containers go through optional `soundfile`.
Everything is downmixed to mono float32 in [-1, 1] at `TARGET_SR`.

`ponytail:` linear resampling, not a polyphase filter — adequate for the
telephony-grade 16 kHz acoustic front-end, and it keeps numpy as the only dep.
Upgrade: `soundfile`/`librosa` resamplers when they are installed.
"""

from __future__ import annotations

import io as _io
import wave
from dataclasses import dataclass

import numpy as np

from ..config import TARGET_SR

try:  # optional: FLAC + non-PCM containers
    import soundfile as _sf  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    _sf = None


@dataclass
class AudioData:
    samples: np.ndarray  # mono float32, [-1, 1]
    sample_rate: int
    duration_s: float
    source: str  # "wav" | "soundfile"

    @property
    def duration_ms(self) -> float:
        return self.duration_s * 1000.0


def _pcm_to_float(raw: bytes, width: int) -> np.ndarray:
    """Decode interleaved PCM of a given sample width into float32."""
    if width == 1:  # 8-bit unsigned
        return (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    if width == 2:  # 16-bit signed
        return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if width == 4:  # 32-bit signed
        return np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    if width == 3:  # 24-bit signed, packed little-endian
        a = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        val = a[:, 0] | (a[:, 1] << 8) | (a[:, 2] << 16)
        val = np.where(val & 0x800000, val - 0x1000000, val)
        return val.astype(np.float32) / 8388608.0
    raise ValueError(f"unsupported sample width: {width}")


def _read_wav(data: bytes) -> tuple[np.ndarray, int]:
    with wave.open(_io.BytesIO(data), "rb") as wf:
        if wf.getcomptype() != "NONE":
            raise ValueError("compressed WAV is not supported by the stdlib reader")
        width = wf.getsampwidth()
        channels = wf.getnchannels()
        sr = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
    mono = _pcm_to_float(frames, width)
    if channels > 1:
        mono = mono.reshape(-1, channels).mean(axis=1)
    return mono.astype(np.float32), sr


def _read_soundfile(data: bytes) -> tuple[np.ndarray, int]:
    if _sf is None:
        raise RuntimeError(
            "FLAC / non-PCM audio needs the optional `soundfile` package "
            "(pip install soundfile). WAV works out of the box."
        )
    arr, sr = _sf.read(_io.BytesIO(data), dtype="float32", always_2d=True)
    return arr.mean(axis=1).astype(np.float32), int(sr)


def resample_linear(samples: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    if sr_in == sr_out or samples.size == 0:
        return samples
    n_out = int(round(samples.size * sr_out / sr_in))
    if n_out <= 0:
        return np.zeros(0, dtype=np.float32)
    x_out = np.linspace(0.0, samples.size - 1, n_out, dtype=np.float64)
    return np.interp(x_out, np.arange(samples.size), samples).astype(np.float32)


def load_audio(data: bytes, filename: str = "", target_sr: int | None = None) -> AudioData:
    """Decode bytes -> mono float32 @ target_sr. Never persists the input."""
    name = (filename or "").lower()
    is_wav = name.endswith(".wav") or data[:4] == b"RIFF"
    try:
        samples, sr = _read_wav(data) if is_wav else _read_soundfile(data)
        source = "wav" if is_wav else "soundfile"
    except (wave.Error, ValueError, EOFError):
        samples, sr = _read_soundfile(data)  # last resort for mislabelled containers
        source = "soundfile"

    sr_out = target_sr or TARGET_SR
    if not np.isfinite(samples).all():
        samples = np.nan_to_num(samples, nan=0.0, posinf=0.0, neginf=0.0)
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    if peak > 1.0:  # defensive: some decoders hand back overshoot
        samples = samples / peak
    samples = resample_linear(samples, sr, sr_out)
    return AudioData(samples=samples, sample_rate=sr_out, duration_s=samples.size / sr_out, source=source)