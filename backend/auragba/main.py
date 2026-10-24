"""FastAPI application factory for the MemoMate (忆伴) screening backend.

Run:  uvicorn auragba.main:app --reload --port 8000
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import auth_router, caregiver_router, contract_router, insight_router
from .config import ENGINE_VERSION, FEATURE_SET_VERSION, settings, validate_runtime

# Refuse to serve with a missing/short AURA_AUTH_SECRET or a wildcard CORS origin.
# This lives here (not at config import) so `python selfcheck.py` stays runnable.
validate_runtime()

_DESCRIPTION = """
MemoMate (忆伴) backend — non-invasive MCI/AD screening from everyday speech.

**Privacy-first.** Raw audio and raw sensor streams never leave the device; this
service ingests VAD-trimmed derived features (or audio it extract-and-burns on the
spot) tagged with a pseudonymous `X-Device-Id` only.

**Not a diagnostic device.** Outputs are for demonstration, evaluation and human
review. No automated clinical decisions.
"""

app = FastAPI(
    title="MemoMate Screening Engine",
    version=ENGINE_VERSION,
    description=_DESCRIPTION,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(contract_router)
app.include_router(insight_router)
app.include_router(auth_router)
app.include_router(caregiver_router)


@app.get("/", tags=["meta"])
def root() -> dict:
    return {
        "name": "忆伴 MemoMate",
        "engineVersion": ENGINE_VERSION,
        "featureSetVersion": FEATURE_SET_VERSION,
        "privacyMode": settings.privacy_mode,
        "docs": "/docs",
        "contract": [
            "POST /gait/windows", "POST /screening/sessions", "POST /sos", "GET /health-card/me",
            "POST /assistant/chat (configurable)", "POST /agent/cards (configurable)",
            "POST /telemetry/events", "POST /conversation/turns",
            "POST /medication/plan (configurable)", "POST /reminders/escalate",
        ],
        "auth": ["POST /auth/register", "POST /auth/pairing-code", "POST /auth/pair"],
        "insight": ["POST /screening/analyze", "GET /baseline/me", "GET /economics/me", "GET /audit/screening"],
    }