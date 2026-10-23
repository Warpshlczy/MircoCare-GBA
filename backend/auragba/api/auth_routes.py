"""Account bootstrap and senior-to-family pairing endpoints."""

from __future__ import annotations

import time
import os

from fastapi import APIRouter, Depends, Header, Response

from ..auth import (
    PAIRING_TTL_SECONDS,
    Principal,
    create_account,
    create_pairing_code,
    current_principal,
    redeem_pairing_code,
    require_role,
)
from ..contract import (
    FamilyRelation,
    PairingCodeResponse,
    PairingRedeemRequest,
    RegisterRequest,
    RegisterResponse,
)

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
