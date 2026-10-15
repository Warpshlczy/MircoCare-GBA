"""Privacy pipeline — the binding contract from `web/src/lib/api.ts`, enforced.

  * Raw audio / raw sensor streams MUST NOT be persisted or re-exported.
  * Only VAD-trimmed derived features and anonymized payloads cross the boundary.
  * Payloads are tagged with a pseudonymous DeviceId — never a real device id.
  * Regulators: HK PDPO, 澳门个人数据保护法 (Macao PDPA), 个人信息保护法 (PIPL).

Two ingestion modes (see config.privacy_mode):
  * "extract-and-burn" — audio is zeroed in memory as soon as features are out.
  * "vector-only"      — the client already sent features; no audio ever arrives.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any

from fastapi import Header

_SALT = "auragba-pseudonym-v1"

# Patterns that must never survive into analytics/audit storage.
_PII_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),                       # email
    re.compile(r"(?:\+?852|\+?853|\+?86)?[\s-]?\d{8,11}"),          # HK/MO/CN phone
    re.compile(r"\b[A-Z]{1,2}\d{6}\(?[0-9A]\)?"),                   # HKID-ish
    re.compile(r"\b\d{15,18}\b"),                                   # national id
)
# props keys that smell like free text / identifiers — dropped outright.
_FORBIDDEN_KEY_HINTS = ("text", "utterance", "transcript", "name", "phone", "email", "idcard")
_MAX_PROP_STR = 32  # coarse values only; anything longer is redacted


def pseudonymize(raw: str | None) -> str:
    """Stable, salted hash of a device-supplied id — one-way, no real id stored."""
    if not raw:
        return "anon-" + hashlib.sha256(b"anonymous").hexdigest()[:16]
    digest = hashlib.sha256((_SALT + raw).encode("utf-8")).hexdigest()
    return "dev-" + digest[:16]


def _looks_like_cjk_free_text(value: str) -> bool:
    """Any CJK content means free text: telemetry props are coarse latin/enum only."""
    return sum(1 for ch in value if "\u4e00" <= ch <= "\u9fff") >= 2


def scrub_props(props: dict[str, Any] | None) -> dict[str, Any]:
    """Strip free text / PII from a telemetry props bag (backend-side re-check).

    Keeps only coarse scalars: short strings, numbers, booleans. Anything that
    looks like free text, an identifier, or a PII pattern is dropped/redacted.
    """
    if not props:
        return {}
    clean: dict[str, Any] = {}
    for key, value in props.items():
        k = str(key)
        if any(hint in k.lower() for hint in _FORBIDDEN_KEY_HINTS):
            continue
        if isinstance(value, bool) or isinstance(value, (int, float)):
            clean[k] = value
        elif isinstance(value, str):
            if _looks_like_cjk_free_text(value):
                continue
            if any(pat.search(value) for pat in _PII_PATTERNS):
                continue  # a prop carrying an identifier is not a coarse prop
            clean[k] = value[:_MAX_PROP_STR]
    return clean


def scrub_text(text: str | None, *, keep: bool = False) -> str | None:
    """Redact PII inside free text when it must be stored (never audio)."""
    if text is None or keep:
        return text
    out = text
    for pat in _PII_PATTERNS:
        out = pat.sub("[redacted]", out)
    return out


def purge(buffer: bytearray | None) -> bool:
    """Best-effort zeroing of an in-memory audio buffer ("提取即焚").

    ponytail: CPython bytearrays are mutable so we can overwrite in place, but
    interpreter copies/GIL may leave traces; this is defence-in-depth, not a
    guarantee. Upgrade: process audio in a memory-locked, no-swap worker.
    """
    if buffer is None:
        return False
    for i in range(len(buffer)):
        buffer[i] = 0
    return True


def input_digest(*parts: str) -> str:
    """Short digest of a screening input for the audit log (no content stored)."""
    h = hashlib.sha256()
    for p in parts:
        h.update(p.encode("utf-8", "ignore"))
        h.update(b"\x00")
    return h.hexdigest()[:16]


# --------------------------------------------------------------------------- #
# FastAPI dependency: resolve the pseudonymous device id from a header.
# --------------------------------------------------------------------------- #
def device_id(x_device_id: str | None = Header(default=None, alias="X-Device-Id")) -> str:
    """Pseudonymous device id; falls back to a shared anonymous bucket.

    ponytail: no auth/token verification yet — the header is trusted as a
    pseudonym, not as an authenticated identity. Upgrade: issue signed device
    tokens (see DEV.md §8.5.1) before exposing beyond a demo.
    """
    return pseudonymize(x_device_id)