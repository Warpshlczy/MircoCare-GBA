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
    GeofenceEvent,
    HealthCard,
    MedicationPlan,
    MedicationPlanRequest,
    RecordSummary,
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
from ..audit import audit_log
from ..config import ENGINE_VERSION, FEATURE_SET_VERSION, FUSION_VERSION
from ..crypto import encrypt_text
from ..privacy import device_id, input_digest, scrub_props
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
    # Demo seed only: the phone MUST stay empty. A dialable fake number would be
    # pre-filled by the client's SOS fallback and dialled in a live demo; an empty
    # number makes the senior hear "未有屋企人嘅電話，叫屋企人設定一次".
    "emergencyContact": {"name": "陳小明", "phone": ""},
}


def _blank_card(device: str) -> dict:
    """A non-fabricated card for a device whose family erased the demo card.

    Re-seeding the demo identities after an explicit deletion would put a fake
    name/phone back on the caregiver screen. Callers add `updatedAt` themselves.
    """
    return {
        "id": f"hc-{device}",
        "name": "未填写",
        "age": 0,
        "bloodType": "—",
        "allergies": [],
        "chronicConditions": [],
        "medications": [],
        "emergencyContact": {"name": "未设置", "phone": ""},
        "contacts": [],
    }


def _llm_blank(route: str) -> HTTPException:
    """A clean 501 when no LLM is configured, so the frontend fallback engages."""
    return HTTPException(status_code=501, detail=f"NOT_IMPLEMENTED: {route} (set AURA_LLM_ENABLED/API_KEY to enable)")


@router.post("/gait/windows", status_code=204)
def post_gait_window(w: GaitWindow, dev: str = Depends(device_id)) -> None:
    """Derived gait features only — never raw accelerometer streams.

    The client's outbox is at-least-once, so a replay must not append a second
    window (or a second fall marker): the weekly step/fall counts would double.
    """
    marker = f"gait_window:{w.id}"
    if store.get_doc(dev, marker) is not None:
        return
    store.record(dev, "gait", w.model_dump())
    if w.fall:  # a fall is a safety signal — keep a coarse marker for trends
        store.record(dev, "gait_falls", {"id": w.id, "at": w.endedAt, "reason": w.fallReason})
    store.set_doc(dev, marker, {"at": w.endedAt, "fall": w.fall})


@router.post("/screening/sessions", status_code=204)
def post_screening_session(s: ScreeningSession, dev: str = Depends(device_id)) -> None:
    """VAD-trimmed derived features only (vector-only ingestion)."""
    ingest_session(s, dev)


@router.post("/sos", status_code=202)
def post_sos(e: SosEvent, dev: str = Depends(device_id)) -> dict:
    """Record the SOS and queue a family notification (idempotent per event id).

    The outbox is at-least-once: the client may retry after a response timeout
    even though the server already processed the event. Without de-duplication
    that retry pages the family a second time. The marker stores the first
    outcome so a replay returns it verbatim without dispatching again.

    `ponytail:` the marker is written after dispatch, so a crash in between can
    still replay — for an SOS a duplicate alert is safer than a missed one.
    """
    key = f"sos_event:{e.id}"
    existing = store.get_doc(dev, key)
    if existing is not None:
        return {
            "id": e.id,
            "notified": list(existing.get("notified") or []),
            "channel": "outbox",
            "delivered": False,
        }

    store.record(dev, "sos", e.model_dump())
    store.set_doc(dev, "sos_last", {"at": e.at, "status": "pending", "reason": e.reason})
    notified = notify_dispatch(dev, "sos", e.model_dump())
    store.set_doc(dev, key, {"id": e.id, "at": e.at, "notified": notified})
    # Tamper-evident ledger entry: who was queued, not what was said.
    audit_log.append(
        kind="sos",
        device_id=dev,
        engine_version=ENGINE_VERSION,
        feature_set_version=FEATURE_SET_VERSION,
        fusion_version=FUSION_VERSION,
        input_digest=input_digest(dev, e.id, e.reason),
        output={"notified": len(notified), "reason": e.reason, "source": e.source},
    )
    return {"id": e.id, "notified": notified, "channel": "outbox", "delivered": False}


@router.post("/geofence/events", status_code=204)
def post_geofence_event(event: GeofenceEvent, dev: str = Depends(device_id)) -> None:
    """Home-fence crossing (exit / enter).

    Kept separate from `/sos`: a walk out of the fence can happen several times a
    day and must not flood the family's emergency queue. Stored per event id so
    an outbox replay is idempotent.

    `alert` separates the two jobs this event serves: every crossing is stored
    (so the weekly outing count is complete), but only `alert=true` ones page the
    family. Old clients omit the field and default to True, preserving the old
    "only long absences produce an event" behaviour.
    """
    key = f"geofence_event:{event.id}"
    existing = store.get_doc(dev, key)
    if existing is None:
        store.record(dev, "geofence_events", event.model_dump())
        store.set_doc(dev, key, event.model_dump())
        if event.alert:
            notify_dispatch(
                dev,
                "geofence",
                {"id": event.id, "at": event.at, "kind": event.kind,
                 "distanceM": event.distanceM, "minutesAway": event.minutesAway},
            )
        return
    # The same crossing can arrive twice: silently at departure, then escalated
    # once the away threshold is crossed. Replace the row (the weekly count must
    # stay one per outing) and page only on the escalation. Replays of an already
    # alerted event, and late silent copies, are no-ops.
    if event.alert and existing.get("alert", True) is False:
        store.delete_by_id(dev, "geofence_events", event.id)
        store.record(dev, "geofence_events", event.model_dump())
        store.set_doc(dev, key, event.model_dump())
        notify_dispatch(
            dev,
            "geofence",
            {"id": event.id, "at": event.at, "kind": event.kind,
             "distanceM": event.distanceM, "minutesAway": event.minutesAway},
        )


@router.get("/health-card/me")
def get_health_card(dev: str = Depends(device_id)) -> HealthCard:
    """Cross-border medication / health card. Versioned via `updatedAt`."""
    stored = store.get_doc(dev, "health_card")
    if not stored:
        # A family deletion must not be resurrected by the demo seed on the next
        # read; return a blank card instead of re-creating fake data.
        if store.get_doc(dev, "health_card_deleted") is not None:
            return HealthCard(**{**_blank_card(dev), "updatedAt": 0})
        stored = {**_DEMO_CARD, "id": f"hc-{dev}", "updatedAt": int(time.time() * 1000)}
        store.set_doc(dev, "health_card", stored)
    return HealthCard(**stored)


@router.post("/telemetry/events", status_code=204)
def post_telemetry(events: list[TelemetryEvent], dev: str = Depends(device_id)) -> None:
    """Batched COARSE events only — re-scrubbed server-side as defence in depth.

    The client upload is at-least-once (`analytics.ts#flush` keeps its buffer if
    the response is lost), so a replayed batch would double every counter — and
    a duplicated `interview_end` becomes "2 次访谈". Marker documents keyed by
    event id make ingestion idempotent, exactly like `/sos`.
    """
    for e in events:
        marker = f"telemetry_event:{e.id}"
        if store.get_doc(dev, marker) is not None:
            continue
        store.record(
            dev,
            "telemetry",
            {"id": e.id, "name": e.name, "at": e.at, "locale": e.locale, "props": scrub_props(e.props)},
        )
        store.set_doc(dev, marker, {"at": e.at, "name": e.name})


@router.post("/conversation/turns", status_code=204)
def post_conversation_memory(turn: ConversationTurn, dev: str = Depends(device_id)) -> None:
    """Persist one conversation turn as AES-GCM ciphertext (C5).

    The transcript is personal data under PDPO/PDPA. It is encrypted at rest with
    AAD bound to (device, turn id), kept for `AURA_CONVERSATION_TTL_DAYS`, and can
    be withdrawn through `DELETE /conversation/turns/{id}`.
    """
    marker = f"conversation_turn:{turn.id}"
    if store.get_doc(dev, marker) is not None:
        # At-least-once replay: a second row would inflate the weekly turn count.
        # The marker survives revocation, so a replayed pre-revocation turn cannot
        # be re-inserted after `DELETE /conversation/turns/{id}`.
        return
    store.record(
        dev,
        "conversation",
        {**turn.model_dump(), "text": encrypt_text(dev, turn.id, turn.text), "enc": "aes-gcm-v1"},
    )
    store.set_doc(dev, marker, {"at": turn.at, "role": turn.role})


@router.delete("/conversation/turns/{turn_id}", status_code=204)
def delete_conversation_turn(turn_id: str, dev: str = Depends(device_id)) -> None:
    """Withdraw one turn (PDPO/PDPA erasure request).

    The ciphertext row is removed and a tamper-evident audit entry proves the
    revocation. The personal baseline is recomputed on demand from screening
    metrics (which never contain transcripts), so only a marker is written here.
    """
    if not store.delete_by_id(dev, "conversation", turn_id):
        raise HTTPException(status_code=404, detail="conversation turn not found")
    now = int(time.time() * 1000)
    store.set_doc(
        dev,
        "conversation_revocation",
        {"turnId": turn_id, "at": now, "baselineRecomputedAt": now},
    )
    audit_log.append(
        kind="conversation_revoke",
        device_id=dev,
        engine_version=ENGINE_VERSION,
        feature_set_version=FEATURE_SET_VERSION,
        fusion_version=FUSION_VERSION,
        input_digest=input_digest(dev, turn_id),
        output={"deleted": True},
    )


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
    marker = f"reminder_escalation:{e.id}"
    if store.get_doc(dev, marker) is not None:
        # A replay must not page the family twice or double the weekly
        # "reminder timed out" count.
        return
    store.record(dev, "reminder_escalations", e.model_dump())
    notify_dispatch(dev, "reminder", e.model_dump())
    store.set_doc(dev, marker, {"at": e.at, "kind": e.kind})


@router.post("/task/events", status_code=204)
def post_task_event(event: TaskEvent, dev: str = Depends(device_id)) -> None:
    """One task state transition (created/completed/deferred/timeout).

    Stored by event id so an outbox replay overwrites rather than duplicating.
    Only ids/states are logged — never the task text (it may contain names).
    """
    store.set_doc(dev, f"task_event:{event.id}", event.model_dump())
    logger.info("task_event %s state=%s source=%s", event.id, event.state, event.source)


@router.post("/records/summary", status_code=204)
def post_records_summary(body: RecordSummary, dev: str = Depends(device_id)) -> None:
    """Coarse daily count for one record kind (issue #7).

    The senior's readable records stay in the device's IndexedDB; this endpoint
    receives only `{day, kind, count, lastAt}` — no medication name, note or
    transcript. Keyed by (device, day, kind), so an at-least-once replay replaces
    the same aggregate instead of adding a second count. The family screen reads
    it through `/caregiver/overview#recordsToday`.
    """
    store.set_doc(dev, f"records_summary:{body.day}:{body.kind}", body.model_dump())


# --------------------------------------------------------------------------- #
# Agent turn — real tool planning when the model is configured, deterministic
# mock otherwise. Guardrails are identical on both paths.
# --------------------------------------------------------------------------- #
@router.post("/agent/turn")
def agent_turn(req: AgentTurnRequest, dev: str = Depends(device_id)) -> AgentTurnResponse:
    """Tool planning. A model failure is a 503/429, never a silent empty plan.

    The client treats any non-2xx as "no agent" and runs its local card, so the
    senior still gets a reply even when the model is slow or unavailable.
    """
    try:
        return llm_turn.plan_turn(req, dev)
    except LLMQuotaExceeded as exc:
        raise HTTPException(status_code=429, detail="LLM daily quota exceeded") from exc
    except (LLMUpstreamError, LLMInvalidOutput) as exc:
        raise HTTPException(status_code=503, detail="LLM temporarily unavailable") from exc


# --------------------------------------------------------------------------- #
# LLM-dependent routes — configurable; fall back to 501/429/503 so the frontend
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
        return HTTPException(status_code=503, detail="LLM temporarily unavailable")
    return HTTPException(status_code=503, detail="LLM error")


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