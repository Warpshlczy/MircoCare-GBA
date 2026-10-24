"""AES-GCM encryption for conversation text at rest (C5).

Stored form: ``v1:<base64(nonce || ciphertext+tag)>``. The additional data (AAD)
is bound to ``(device_id, turn_id)``, so a ciphertext copied onto another row or
device fails to open instead of decrypting to someone else's sentence.

Legacy rows written before C5 have no prefix; ``decrypt_text`` returns them
unchanged so an export does not silently lose history. The TTL purge removes
them within the retention window.

`ponytail:` key derivation is SHA-256 over an env-provided secret. Production
should pass a KMS-managed 32-byte key and rotate it with a versioned prefix.
"""

from __future__ import annotations

import base64
import hashlib
import os

from .config import settings

_PREFIX = "v1:"
_NONCE_BYTES = 12


def _aead():
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as exc:  # pragma: no cover - deploy-time failure
        raise RuntimeError("cryptography is required for conversation encryption") from exc

    key = settings.encryption_key
    if not key or len(key.encode("utf-8")) < 32:
        raise RuntimeError("AURA_ENCRYPTION_KEY must be set to at least 32 bytes")
    return AESGCM(hashlib.sha256(key.encode("utf-8")).digest())


def _aad(device_id: str, turn_id: str) -> bytes:
    return f"{device_id}:{turn_id}".encode("utf-8")


def encrypt_text(device_id: str, turn_id: str, text: str) -> str:
    nonce = os.urandom(_NONCE_BYTES)
    ciphertext = _aead().encrypt(nonce, (text or "").encode("utf-8"), _aad(device_id, turn_id))
    return _PREFIX + base64.b64encode(nonce + ciphertext).decode("ascii")


def decrypt_text(device_id: str, turn_id: str, stored: str) -> str:
    if not isinstance(stored, str) or not stored.startswith(_PREFIX):
        return stored
    raw = base64.b64decode(stored[len(_PREFIX):], validate=True)
    plain = _aead().decrypt(raw[:_NONCE_BYTES], raw[_NONCE_BYTES:], _aad(device_id, turn_id))
    return plain.decode("utf-8")
