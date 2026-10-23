"""Minimal signed sessions and senior/family pairing.

This is intentionally provider-free: accounts are stored by the existing
Store abstraction and tokens are short-lived HMAC-signed bearer credentials.
Replace the persistence and key management before production deployment.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from typing import Literal

from fastapi import Cookie, Header, HTTPException

from .config import settings
from .privacy import pseudonymize
from .auth_store import auth_store

Role = Literal["senior", "family"]
TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30
PAIRING_TTL_SECONDS = 10 * 60
_TOKEN_SECRET = settings.auth_secret.encode("utf-8")


@dataclass(frozen=True)
class Principal:
    account_id: str
    role: Role
    device_id: str | None


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _sign(body: str) -> str:
    return _b64(hmac.new(_TOKEN_SECRET, body.encode("ascii"), hashlib.sha256).digest())


def issue_token(account_id: str, role: Role, device: str | None) -> str:
    payload = {
        "sub": account_id,
        "role": role,
        "device": device,
        "exp": int(time.time()) + TOKEN_TTL_SECONDS,
    }
    body = _b64(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    return f"{body}.{_sign(body)}"


def _account(account_id: str) -> dict | None:
    return auth_store.get_account(account_id)


def principal_from_token(token: str) -> Principal:
    try:
        body, signature = token.split(".", 1)
        if not hmac.compare_digest(signature, _sign(body)):
            raise ValueError("signature")
        payload = json.loads(_unb64(body))
        if int(payload["exp"]) < int(time.time()):
            raise ValueError("expired")
        account = _account(str(payload["sub"]))
        if not account or account.get("role") != payload.get("role"):
            raise ValueError("account")
        return Principal(
            account_id=str(payload["sub"]),
            role=account["role"],
            device_id=account.get("deviceId"),
        )
    except (ValueError, KeyError, TypeError, json.JSONDecodeError, UnicodeError):
        raise HTTPException(status_code=401, detail="Invalid or expired session") from None


def current_principal(
    authorization: str | None = Header(default=None),
    aura_session: str | None = Cookie(default=None),
) -> Principal:
    token = authorization[7:].strip() if authorization and authorization.startswith("Bearer ") else None
    if not token and aura_session:
        token = aura_session
    if not token:
        raise HTTPException(status_code=401, detail="Authenticated session required")
    return principal_from_token(token)


def require_role(principal: Principal, role: Role) -> Principal:
    if principal.role != role:
        raise HTTPException(status_code=403, detail=f"{role} role required")
    return principal


def create_account(role: Role, raw_device_id: str | None = None) -> tuple[dict, str]:
    if role == "senior" and not raw_device_id:
        raise HTTPException(status_code=400, detail="Senior device binding is required")
    # Bind family accounts to the device pseudonym too: registration stays
    # idempotent instead of creating a new caregiver account (and losing the
    # previous pairing) on every page load.
    device_id = pseudonymize(raw_device_id) if raw_device_id else None
    account = auth_store.create_account(role, device_id)
    return account, issue_token(account["id"], role, account["deviceId"])


def create_pairing_code(senior: Principal) -> str:
    if not senior.device_id:
        raise HTTPException(status_code=400, detail="Senior device binding is required")
    return auth_store.create_pairing(senior.account_id, senior.device_id, PAIRING_TTL_SECONDS)[0]


def redeem_pairing_code(family: Principal, code: str) -> dict:
    try:
        return auth_store.redeem_pairing(family.account_id, code)
    except ValueError as error:
        if str(error) != "locked":
            auth_store.record_failed_pairing(family.account_id, code)
        raise HTTPException(status_code=400, detail="Pairing is temporarily unavailable") from None


def family_relations(family: Principal) -> list[dict]:
    return auth_store.relations_for(family.account_id)


def authorized_device(principal: Principal, device_id: str) -> str:
    if principal.role == "senior" and principal.device_id == device_id:
        return device_id
    if any(r.get("seniorDeviceId") == device_id for r in family_relations(principal)):
        return device_id
    raise HTTPException(status_code=403, detail="Device is not bound to this account")
