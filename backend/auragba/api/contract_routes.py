"""The nine frontend-facing contract endpoints (DEV.md §8.1).

Paths and payloads match `web/src/lib/api.ts` exactly. The three LLM-dependent
routes — `/assistant/chat`, `/agent/cards`, `/medication/plan` — are **left
blank** (HTTP 501) by design: the project keeps all LLM integration
unimplemented, and the frontend already treats any error as "no agent" and falls
back to its local cards/reminders. Implementing them later changes only these
bodies.
"""

from __future__ import annotations

import logging
import time

from fastapi import APIRouter, Depends, HTTPException

from ..contract import (
    AgentCard,
    AgentIntentRequest,
    AgentTurnRequest,
    AgentTurnResponse,
    AssistantChatRequest,
    BehaviourDailyEnvelope,
    ConversationTurn,
    GaitWindow,
    HealthCard,
    MedicationPlan,
    MedicationPlanRequest,
    ReminderEscalation,
    ScreeningSession,
    SosEvent,
    TaskEvent,
    TelemetryEvent,
)
from ..llm import service as llm_service
from ..llm import turn as llm_turn
from ..llm.errors import (
    LLMInvalidInput,
    LLMInvalidOutput,
    LLMNotConfigured,
    LLMQuotaExceeded,
    LLMUpstreamError,
)
from ..privacy import device_id, scrub_props, scrub_text
from ..screening import ingest_session
from ..store import store
from ..notify import dispatch as notify_dispatch

router = APIRouter(tags=["contract"])
logger = logging.getLogger("auragba.contract")

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
    """A clean 501 when no LLM is configured, so the frontend fallback engages."""
    return HTTPException(status_code=501, detail=f"NOT_IMPLEMENTED: {route} (set AURA_LLM_ENABLED/API_KEY to enable)")


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


@router.post("/sos", status_code=202)
def post_sos(e: SosEvent, dev: str = Depends(device_id)) -> dict:
    """Record the SOS and queue a family notification.

    The outbox row is durable and the caregiver dashboard reads it; the demo
    provider is a log line (+ optional `AURA_NOTIFY_WEBHOOK`). We return 202
    because delivery is queued, not confirmed — never claim "sent".
    """
    store.record(dev, "sos", e.model_dump())
    store.set_doc(dev, "sos_last", {"at": e.at, "status": "pending", "reason": e.reason})
    notified = notify_dispatch(dev, "sos", e.model_dump())
    return {"id": e.id, "notified": notified, "channel": "outbox", "delivered": False}


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


@router.post("/behaviour/daily", status_code=204)
def post_behaviour_daily(body: BehaviourDailyEnvelope, dev: str = Depends(device_id)) -> None:
    """Daily behaviour rollup (BehaviourDaily + optional circadian/digitalSkill).

    Idempotent per (device, day): an outbox replay overwrites the same doc instead
    of appending a duplicate. `null` readings are stored as null — never 0 — so C
    can tell "not measured" apart from "zero".
    """
    store.set_doc(dev, f"behaviour:{body.behaviour.day}", body.model_dump())


@router.post("/reminders/escalate", status_code=204)
def post_reminder_escalation(e: ReminderEscalation, dev: str = Depends(device_id)) -> None:
    """A reminder timed out. Record the coarse event and queue a family notice.

    The outbox is the delivery seam: a provider worker (push/SMS/voice) consumes
    it later. We never claim in the senior UI that a message was actually
    delivered, only that the escalation was recorded.
    """
    store.record(dev, "reminder_escalations", e.model_dump())
    notify_dispatch(dev, "reminder", e.model_dump())


@router.post("/task/events", status_code=204)
def post_task_event(event: TaskEvent, dev: str = Depends(device_id)) -> None:
    """One task state transition (created/completed/deferred/timeout).

    Stored by event id so an outbox replay overwrites rather than duplicating.
    Only ids/states are logged — never the task text (it may contain names).
    """
    store.set_doc(dev, f"task_event:{event.id}", event.model_dump())
    logger.info("task_event %s state=%s source=%s", event.id, event.state, event.source)


# --------------------------------------------------------------------------- #
# Agent turn — the mock planner is always on so B can integrate before the model
# is wired. The guardrails inside are final; C3 only replaces the planning step.
# --------------------------------------------------------------------------- #
@router.post("/agent/turn")
def agent_turn(req: AgentTurnRequest, dev: str = Depends(device_id)) -> AgentTurnResponse:
    return llm_turn.plan_turn(req)


# --------------------------------------------------------------------------- #
# LLM-dependent routes — configurable; fall back to 501/429/502 so the frontend
# local card factory stays the safe path.
# --------------------------------------------------------------------------- #
def _llm_http_error(route: str, exc: Exception) -> HTTPException:
    if isinstance(exc, LLMNotConfigured):
        return _llm_blank(route)
    if isinstance(exc, LLMQuotaExceeded):
        return HTTPException(status_code=429, detail="LLM daily quota exceeded")
    if isinstance(exc, LLMInvalidInput):
        return HTTPException(status_code=400, detail="Invalid LLM request payload")
    if isinstance(exc, (LLMUpstreamError, LLMInvalidOutput)):
        return HTTPException(status_code=502, detail="LLM temporarily unavailable")
    return HTTPException(status_code=502, detail="LLM error")


@router.post("/assistant/chat")
def assistant_chat(req: AssistantChatRequest, dev: str = Depends(device_id)) -> dict:
    try:
        return {"reply": llm_service.assistant_reply(req, dev)}
    except (LLMNotConfigured, LLMQuotaExceeded, LLMInvalidInput, LLMUpstreamError, LLMInvalidOutput) as exc:
        raise _llm_http_error("/assistant/chat", exc) from exc


@router.post("/agent/cards")
def get_agent_cards(req: AgentIntentRequest, dev: str = Depends(device_id)) -> list[AgentCard]:
    try:
        return llm_service.plan_cards(req, dev)
    except (LLMNotConfigured, LLMQuotaExceeded, LLMInvalidInput, LLMUpstreamError, LLMInvalidOutput) as exc:
        raise _llm_http_error("/agent/cards", exc) from exc


@router.post("/medication/plan")
def get_medication_plan(req: MedicationPlanRequest, dev: str = Depends(device_id)) -> MedicationPlan:
    try:
        return llm_service.plan_medication(req, dev)
    except (LLMNotConfigured, LLMQuotaExceeded, LLMInvalidInput, LLMUpstreamError, LLMInvalidOutput) as exc:
        raise _llm_http_error("/medication/plan", exc) from exc