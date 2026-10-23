"""LLM orchestration: safety gate -> model -> schema validation.

Every function either returns a validated result or raises a typed LLM error;
the route maps that to 501/429/502 so the frontend always has a fallback.
"""

from __future__ import annotations

import time
import uuid
from typing import Any

from ..config import settings
from ..contract import (
    AgentCard,
    AgentIntentRequest,
    AssistantChatRequest,
    CardAction,
    CardChecklistItem,
    CardData,
    CardRow,
    MedicationPlan,
    MedicationPlanItem,
    MedicationPlanRequest,
)
from ..privacy import scrub_text
from . import prompts, safety, usage, weather
from .client import LLMClient
from .errors import LLMInvalidInput, LLMInvalidOutput, LLMNotConfigured

_ALLOWED_ACTIONS = {
    "weather", "medication", "tasks", "camera", "sos",
    "help", "tools", "followup", "note", "recall", "unknown",
}


def _require_llm() -> None:
    if not settings.llm_available:
        raise LLMNotConfigured("LLM is not configured")


def _now_ms() -> int:
    return int(time.time() * 1000)


def plan_cards(req: AgentIntentRequest, device_id: str) -> list[AgentCard]:
    now = _now_ms()

    # Safety and weather do not need a model.
    if safety.is_emergency(req.utterance):
        card = safety.emergency_card(req.locale)
        card.createdAt = now
        return [card]
    if req.intent == "weather":
        return [_weather_card(req.locale, now)]

    _require_llm()
    usage.reserve(device_id)
    safe_req = req.model_copy(update={"utterance": scrub_text(req.utterance, keep=False)})
    payload = LLMClient().complete_json(prompts.card_messages(safe_req))
    return _validate_cards(payload, now)


def plan_medication(req: MedicationPlanRequest, device_id: str) -> MedicationPlan:
    source = f"{req.utterance}\n" + "\n".join(turn.text for turn in req.history)
    if safety.is_emergency(source):
        return MedicationPlan(items=[], basis="utterance")

    _require_llm()
    usage.reserve(device_id)
    history_lines = [
        f"{turn.role}: {scrub_text(turn.text, keep=False)[:300]}"
        for turn in req.history[-10:]
    ]
    safe_req = req.model_copy(update={"utterance": scrub_text(req.utterance, keep=False)})
    payload = LLMClient().complete_json(prompts.medication_messages(safe_req, history_lines))
    return _validate_medication(payload, source, req.locale)


def assistant_reply(req: AssistantChatRequest, device_id: str) -> str:
    lines = [
        scrub_text(message.content, keep=False)[:500]
        for message in req.messages
        if message.role == "user" and message.content.strip()
    ][-8:]
    if not lines:
        raise LLMInvalidInput("at least one user message is required")
    if any(safety.is_emergency(line) for line in lines):
        return safety.emergency_reply(req.locale)

    _require_llm()
    usage.reserve(device_id)
    text = LLMClient().complete_text(prompts.chat_messages(req.locale, lines), max_tokens=220)
    return safety.filter_chat_reply(text, req.locale)


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #
def _weather_card(locale: str, now: int) -> AgentCard:
    snapshot = weather.weather_for_locale(locale)
    if locale == "zh-CN":
        title, unavailable = "今日天气", "暂时拿不到实时天气，请稍后再试。"
        labels = ("湿度", "风速", "地点")
    else:
        title, unavailable = "今日天氣", "暫時攞唔到實時天氣，請遲啲再試。"
        labels = ("濕度", "風速", "地點")

    if not snapshot:
        return AgentCard(
            id="llm-weather-unavailable",
            kind="weather",
            title=title,
            createdAt=now,
            data=CardData(icon="🌤️", headline=unavailable),
        )

    return AgentCard(
        id="llm-weather",
        kind="weather",
        title=title,
        createdAt=now,
        data=CardData(
            icon=str(snapshot["icon"]),
            headline=f"{snapshot['temperature_c']:.0f}°C {snapshot['condition']}",
            rows=[
                CardRow(label=labels[0], value=f"{snapshot['humidity']}%"),
                CardRow(label=labels[1], value=f"{snapshot['wind_kmh']:.0f} km/h"),
                CardRow(label=labels[2], value=str(snapshot["location"])),
            ],
        ),
    )


def _validate_cards(payload: dict[str, Any], now: int) -> list[AgentCard]:
    raw_cards = payload.get("cards")
    if not isinstance(raw_cards, list):
        raise LLMInvalidOutput("missing cards array")

    cards: list[AgentCard] = []
    for raw in raw_cards[:2]:
        if not isinstance(raw, dict) or raw.get("html"):
            continue
        # Drop invalid actions before Pydantic so one bad intent does not reject
        # an otherwise usable card.
        if isinstance(raw.get("actions"), list):
            raw["actions"] = [
                action for action in raw["actions"]
                if isinstance(action, dict) and action.get("intent") in _ALLOWED_ACTIONS
            ][:2]
        try:
            card = AgentCard.model_validate(raw)
        except Exception:
            continue
        if card.data is None:
            continue

        card.id = f"llm-card-{uuid.uuid4().hex[:8]}"
        card.createdAt = now
        card.html = None
        card.title = card.title.strip()[:40]
        data = card.data
        data.image = None  # only the camera screen may produce images
        if data.headline:
            data.headline = data.headline.strip()[:120]
        if data.rows:
            data.rows = [
                CardRow(label=row.label.strip()[:20], value=row.value.strip()[:80])
                for row in data.rows[:6]
            ]
        if data.checklist:
            data.checklist = [
                CardChecklistItem(id=f"cl-{i}", text=item.text.strip()[:60], done=bool(item.done))
                for i, item in enumerate(data.checklist[:8])
            ]
        if card.actions:
            card.actions = [
                CardAction(id=f"act-{i}", label=action.label.strip()[:16], intent=action.intent)
                for i, action in enumerate(card.actions[:2])
                if action.intent in _ALLOWED_ACTIONS
            ]
        cards.append(card)
    return cards


def _validate_medication(payload: dict[str, Any], source: str, locale: str) -> MedicationPlan:
    raw_items = payload.get("items")
    if not isinstance(raw_items, list):
        raise LLMInvalidOutput("missing items array")

    unknown = "未注明" if locale == "zh-CN" else "未註明"

    items: list[MedicationPlanItem] = []
    seen: set[str] = set()
    for raw in raw_items[:6]:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name", "")).strip()[:40]
        # Safety: a medication the user never mentioned is not accepted.
        if not name or not safety.name_mentioned(name, source):
            continue
        key = safety.normalize(name)
        if key in seen:
            continue
        seen.add(key)
        items.append(
            MedicationPlanItem(
                name=name,
                dosage=str(raw.get("dosage", "")).strip()[:40] or unknown,
                schedule=str(raw.get("schedule", "")).strip()[:40] or unknown,
            )
        )

    basis = payload.get("basis")
    if basis not in ("history", "profile", "utterance", "mixed"):
        basis = "mixed"
    return MedicationPlan(items=items, basis=basis)
