"""The nine frontend-facing contract endpoints (DEV.md §8.1).

Paths and payloads match `web/src/lib/api.ts` exactly. The three LLM-dependent
routes — `/assistant/chat`, `/agent/cards`, `/medication/plan` — are **left
blank** (HTTP 501) by design: the project keeps all LLM integration
unimplemented, and the frontend already treats any error as "no agent" and falls
back to its local cards/reminders. Implementing them later changes only these
bodies.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException

from ..contract import (
    AgentIntentRequest,
    AssistantChatRequest,
    ConversationTurn,
    GaitWindow,
    HealthCard,
    MedicationPlanRequest,
    ScreeningSession,
    SosEvent,
    TelemetryEvent,
)
from ..privacy import device_id, scrub_props, scrub_text
from ..screening import ingest_session
from ..store import store

router = APIRouter(tags=["contract"])

# A demo health card, seeded per device so `GET /health-card/me` returns something
# real before a clinic backend is wired. Upgrade: sync from the family/clinic side.
_DEMO_CARD = {
    "name": "陳阿婆",
    "age": 78,
    "bloodType": "A+",
    "allergies": ["青霉素"],
    "chronicConditions": ["高血压", "2 型糖尿病"],
    "medications": ["氨氯地平", "二甲双胍"],
    "emergencyContact": {"name": "陳小明（儿子）", "phone": "+852 9000 0000"},
}


def _llm_blank(route: str) -> HTTPException:
    """A clean, explicit 501 so the frontend's fallback path engages."""
    return HTTPException(status_code=501, detail=f"NOT_IMPLEMENTED: {route} (LLM integration intentionally blank)")


@router.post("/gait/windows", status_code=204)
def post_gait_window(w: GaitWindow, dev: str = Depends(device_id)) -> None:
    """Derived gait features only — never raw accelerometer streams."""
    store.record(dev, "gait", w.model_dump())
    if w.fall:  # a fall is a safety signal — keep a coarse marker for trends
        store.record(dev, "gait_falls", {"at": w.endedAt, "reason": w.fallReason})


@router.post("/screening/sessions", status_code=204)
def post_screening_session(s: ScreeningSession, dev: str = Depends(device_id)) -> None:
    """VAD-trimmed derived features only (vector-only ingestion)."""
    ingest_session(s, dev)


@router.post("/sos", status_code=204)
def post_sos(e: SosEvent, dev: str = Depends(device_id)) -> None:
    """Record the SOS + an escalation ledger entry.

    ponytail: records the escalation intent only — it does NOT yet notify family
    / carers over SMS/push (no provider wired). Upgrade: fan out to family +
    community carer, with HK/MO/CN emergency numbers (DEV.md §8.5.2).
    """
    store.record(dev, "sos", e.model_dump())
    store.set_doc(dev, "sos_last", {"at": e.at, "status": "pending", "reason": e.reason})


@router.get("/health-card/me")
def get_health_card(dev: str = Depends(device_id)) -> HealthCard:
    """Cross-border medication / health card. Versioned via `updatedAt`."""
    stored = store.get_doc(dev, "health_card")
    if not stored:
        stored = {**_DEMO_CARD, "id": f"hc-{dev}", "updatedAt": int(time.time() * 1000)}
        store.set_doc(dev, "health_card", stored)
    return HealthCard(**stored)


@router.post("/telemetry/events", status_code=204)
def post_telemetry(events: list[TelemetryEvent], dev: str = Depends(device_id)) -> None:
    """Batched COARSE events only — re-scrubbed server-side as defence in depth."""
    for e in events:
        store.record(
            dev,
            "telemetry",
            {"id": e.id, "name": e.name, "at": e.at, "locale": e.locale, "props": scrub_props(e.props)},
        )


@router.post("/conversation/turns", status_code=204)
def post_conversation_memory(turn: ConversationTurn, dev: str = Depends(device_id)) -> None:
    """Persist one conversation turn (text only; the app keeps it locally first).

    ponytail: transcripts are retained to learn the senior's habits per DEV.md
    §8.6 — that is personal data under PDPO/PDPA. Retention, encryption-at-rest
    and a revocation path are REQUIRED before production. Upgrade: encrypt at
    rest + TTL + explicit consent record.
    """
    store.record(dev, "conversation", {**turn.model_dump(), "text": scrub_text(turn.text, keep=True)})


# --------------------------------------------------------------------------- #
# LLM-dependent routes — intentionally blank (501). Do not implement.
# --------------------------------------------------------------------------- #
@router.post("/assistant/chat")
def assistant_chat(_req: AssistantChatRequest) -> dict:
    raise _llm_blank("/assistant/chat")


@router.post("/agent/cards")
def get_agent_cards(_req: AgentIntentRequest) -> list:
    raise _llm_blank("/agent/cards")


@router.post("/medication/plan")
def get_medication_plan(_req: MedicationPlanRequest) -> dict:
    raise _llm_blank("/medication/plan")