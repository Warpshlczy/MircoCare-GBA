"""Automatic speech recognition (ASR).

Local Whisper-Tiny (Cantonese/Mandarin) is used when available; the remote
Whisper API call is intentionally **left blank** (see `transcribe_via_remote_api`)
— the project keeps all LLM/paid-API integration unimplemented by design.

Back-ends, in order:
  1. `faster-whisper` (CTranslate2) — fastest local path.
  2. `openai-whisper` — reference local path.
  3. none installed -> `AsrResult(available=False)`, and the screening pipeline
     degrades to an ACOUSTIC-ONLY risk estimate (never fails).

`ponytail:` vanilla Whisper has no separate Cantonese (`yue`) language code, so
zh-HK/zh-MO are routed to `zh` and Cantonese handling depends on the model's own
code-switching. Upgrade: a Cantonese fine-tune (e.g. a `yue`-adapted Whisper).
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from ..config import ENGINE_VERSION

try:  # optional: fast local inference
    from faster_whisper import WhisperModel as _FasterWhisper  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    _FasterWhisper = None

try:  # optional: reference implementation
    import whisper as _whisper  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    _whisper = None

_MODEL_SIZE = os.getenv("AURA_WHISPER_MODEL", "tiny")
_LOCALE_TO_LANG = {"zh-HK": "zh", "zh-MO": "zh", "zh-CN": "zh"}
_faster_model = None
_faster_failed = False


@dataclass
class AsrResult:
    text: str = ""
    language: str = "zh"
    engine: str = "none"
    available: bool = False
    confidence: float = 0.0
    note: str | None = None


def _faster(audio) -> AsrResult | None:
    global _faster_model, _faster_failed
    if _FasterWhisper is None or _faster_failed:
        return None
    if _faster_model is None:
        try:
            _faster_model = _FasterWhisper(_MODEL_SIZE, device="cpu", compute_type="int8")
        except Exception:  # pragma: no cover - model download / offline
            _faster_failed = True
            return None
    segments, info = _faster_model.transcribe(audio.samples.astype("float32"), language="zh", beam_size=1)
    text = "".join(seg.text for seg in segments).strip()
    return AsrResult(
        text=text,
        language=getattr(info, "language", "zh") or "zh",
        engine=f"faster-whisper-{_MODEL_SIZE}",
        available=True,
        confidence=float(getattr(info, "language_probability", 0.0) or 0.0),
    )


def _openai_whisper(audio) -> AsrResult | None:
    if _whisper is None:
        return None
    model = _whisper.load_model(_MODEL_SIZE)
    result = model.transcribe(audio.samples.astype("float32"), language="zh", fp16=False)
    return AsrResult(
        text=str(result.get("text", "")).strip(),
        language="zh",
        engine=f"openai-whisper-{_MODEL_SIZE}",
        available=True,
    )


def transcribe(audio, locale: str = "zh-CN") -> AsrResult:
    """Local ASR; returns `available=False` (never raises) when no engine exists."""
    language = _LOCALE_TO_LANG.get(locale, "zh")
    for backend in (_faster, _openai_whisper):
        try:
            result = backend(audio)
        except Exception as exc:  # pragma: no cover - inference failure
            result = None
            _ = exc
        if result is not None:
            result.language = language
            return result
    return AsrResult(
        text="",
        language=language,
        engine="none",
        available=False,
        note=(
            "No local ASR engine. Install `faster-whisper` (or `openai-whisper`) to "
            "enable the linguistic stream; the acoustic stream still runs."
        ),
    )


def transcribe_via_remote_api(*_args, **_kwargs):  # noqa: ANN002, ANN003
    """Intentionally unimplemented — the paid Whisper/LMM API path is out of scope.

    Kept as a named seam (mirrors `DEV.md` §8: LLM / external-API calls stay blank)
    so wiring it later is a one-function change and no caller has to be touched.
    """
    raise NotImplementedError(
        f"remote Whisper API is intentionally not implemented in {ENGINE_VERSION}"
    )