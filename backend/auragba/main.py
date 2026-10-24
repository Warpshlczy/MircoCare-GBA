"""FastAPI application factory for the MemoMate (忆伴) screening backend.

Run:  uvicorn auragba.main:app --reload --port 8000
"""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import auth_router, caregiver_router, contract_router, insight_router, report_router
from .config import ENGINE_VERSION, FEATURE_SET_VERSION, settings, validate_runtime

# Refuse to serve with a missing/short AURA_AUTH_SECRET or a wildcard CORS origin.
# This lives here (not at config import) so `python selfcheck.py` stays runnable.
validate_runtime()

# Make the coarse audit lines visible under uvicorn (e.g. "已通知家属 N 人").
# Scoped to the app logger so library importers are unaffected.
_app_logger = logging.getLogger("auragba")
if not _app_logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
    _app_logger.addHandler(_handler)
_app_logger.setLevel(logging.INFO)
_app_logger.propagate = False

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
app.include_router(report_router)


@app.get("/", tags=["meta"])
def root() -> dict:
    return {
        "name": "忆伴 MemoMate",
        "engineVersion": ENGINE_VERSION,
        "featureSetVersion": FEATURE_SET_VERSION,
        "privacyMode": settings.privacy_mode,
        "docs": "/docs",
        "contract": [
            "POST /gait/windows", "POST /screening/sessions", "POST /sos (202)",
            "GET /health-card/me",
            "POST /assistant/chat (configurable)", "POST /agent/cards (configurable)",
            "POST /agent/turn (mock planner)",
            "POST /telemetry/events", "POST /conversation/turns",
            "DELETE /conversation/turns/{id}",
            "POST /behaviour/daily", "POST /task/events", "POST /geofence/events",
            "POST /medication/plan (configurable)", "POST /reminders/escalate",
        ],
        "auth": ["POST /auth/register", "POST /auth/pairing-code", "POST /auth/pair"],
        "insight": ["POST /screening/analyze", "GET /baseline/me", "GET /economics/me", "GET /audit/screening"],
        "reports": [
            "GET /reports/weekly/me", "GET /reports/weekly/me.html",
            "POST /reports/weekly/send",
            "GET /caregiver/reports/weekly", "GET /caregiver/reports/weekly.html",
        ],
    }