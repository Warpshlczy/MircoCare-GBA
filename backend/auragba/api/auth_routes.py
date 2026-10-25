"""Account bootstrap and senior-to-family pairing endpoints."""

from __future__ import annotations

import time
import os

from fastapi import APIRouter, Depends, Header, HTTPException, Response

from ..audit import audit_log
from ..auth import (
    PAIRING_TTL_SECONDS,
    Principal,
    create_account,
    create_pairing_code,
    current_principal,
    redeem_pairing_code,
    require_role,
)
from ..auth_store import auth_store
from ..config import ENGINE_VERSION, FEATURE_SET_VERSION, FUSION_VERSION
from ..contract import (
    FamilyRelation,
    PairingCodeResponse,
    PairingRedeemRequest,
    RegisterRequest,
    RegisterResponse,
)
from ..privacy import input_digest
from ..store import store

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=RegisterResponse)
def register(
    response: Response,
    req: RegisterRequest,
    x_device_id: str | None = Header(default=None, alias="X-Device-Id"),
) -> RegisterResponse:
    account, token = create_account(req.role, x_device_id)
    if response is not None:
        response.set_cookie(
            "aura_session",
            token,
            max_age=60 * 60 * 24 * 30,
            httponly=True,
            secure=os.getenv("AURA_COOKIE_SECURE", "false").lower() == "true",
            samesite="lax",
            path="/",
        )
    return RegisterResponse(accountId=account["id"], role=account["role"])


@router.get("/me", response_model=RegisterResponse)
def me(principal: Principal = Depends(current_principal)) -> RegisterResponse:
    """Return the caller's session, or 401 when the cookie/bearer is invalid.

    The web app calls this before any data request so it can reuse an existing
    HttpOnly session instead of re-registering (and potentially switching roles).
    """
    return RegisterResponse(accountId=principal.account_id, role=principal.role)


@router.post("/pairing-code", response_model=PairingCodeResponse)
def pairing_code(principal: Principal = Depends(current_principal)) -> PairingCodeResponse:
    senior = require_role(principal, "senior")
    return PairingCodeResponse(
        code=create_pairing_code(senior),
        expiresAt=int((time.time() + PAIRING_TTL_SECONDS) * 1000),
    )


@router.post("/pair", response_model=FamilyRelation)
def pair(
    req: PairingRedeemRequest,
    principal: Principal = Depends(current_principal),
) -> FamilyRelation:
    family = require_role(principal, "family")
    return FamilyRelation(**redeem_pairing_code(family, req.code))


@router.delete("/me", status_code=204)
def delete_me(
    response: Response,
    principal: Principal = Depends(current_principal),
) -> None:
    """Erase this account, its pairings, and (for a senior) the device store.

    The signed cookie/token becomes invalid as soon as the account row is gone;
    the caller must register again to use the app. The cookie is cleared too, so
    the browser does not keep a credential that can only answer 401. Audit
    records only digests.
    """
    response.delete_cookie("aura_session", path="/")
    deleted = auth_store.delete_account(principal.account_id)
    if deleted is None:
        raise HTTPException(status_code=404, detail="account not found")
    if deleted["role"] == "senior" and deleted.get("deviceId"):
        store.delete_device(str(deleted["deviceId"]))
    audit_log.append(
        kind="account_delete",
        device_id=str(deleted.get("deviceId") or ""),
        engine_version=ENGINE_VERSION,
        feature_set_version=FEATURE_SET_VERSION,
        fusion_version=FUSION_VERSION,
        input_digest=input_digest(principal.account_id, "account-delete"),
        output={"role": deleted["role"], "deviceErased": deleted["role"] == "senior"},
    )
