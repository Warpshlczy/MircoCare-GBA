"""Agent-turn orchestration — real LLM tool planning plus final guardrails.

When a model is configured (`AURA_LLM_ENABLED=true`), the planner asks it for
OpenAI-style tool calls; otherwise it falls back to the deterministic
`create_task` mock so B can keep integrating without an API key.

Everything else is final and model-independent:

* emergency language short-circuits to a single ``sos`` call;
* money / credential requests never become tool calls;
* unknown tool names and bad arguments discard ALL calls;
* ``confirm``-risk tools come back with a spoken confirmation question;
* at most three calls.

On upstream failure or quota exhaustion the response carries no calls — the
senior hears "say that again" rather than a guessed action.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Iterable

from ..config import settings
from ..contract import AgentTurnRequest, AgentTurnResponse, NeedsConfirm, ToolCall
from . import prompts, safety, usage
from .client import LLMClient
from .errors import LLMInvalidOutput, LLMNotConfigured, LLMQuotaExceeded, LLMUpstreamError

logger = logging.getLogger("auragba.llm.turn")

MAX_CALLS = 3

# Mirrors `confirmToolNames()` in web/src/lib/tools.ts. Kept here as a hard set:
# the client supplies tool descriptions, but it must not be able to downgrade a
# confirm-risk tool to "safe" by editing its declaration.
CONFIRM_TOOLS = frozenset({"call_contact", "send_message", "open_app", "ui_tap_text"})

# Utterance-level refusal (never a tool). Mirrors toolrun.ts#refuseReason — keep
# this a superset so a third-party client hitting the API directly is covered too.
_FORBIDDEN = (
    "转账", "轉賬", "轉帳", "汇款", "匯款", "付款", "过数", "過數",
    "密码", "密碼", "验证码", "驗證碼", "otp",
    "俾钱", "畀钱", "给钱", "給錢", "買股票", "买股票", "支付",
    "transfer money", "password",
)

_REPLY = {
    "zh-HK": "好，我幫你記住咗。",
    "zh-MO": "好，我幫你記住咗。",
    "zh-CN": "好，我帮你记住了。",
}
_RETRY = {
    "zh-HK": "我唔係好肯定，你再講一次？",
    "zh-MO": "我唔係好肯定，你再講一次？",
    "zh-CN": "我没听清楚，你再说一次？",
}
_REFUSE = {
    "zh-HK": "呢個我做唔到，要你自己或者屋企人做。",
    "zh-MO": "呢個我做唔到，要你自己或者屋企人做。",
    "zh-CN": "这件事我做不了，要你自己或者家里人做。",
}
_CONFIRM = {
    "zh-HK": "係咪{label}？",
    "zh-MO": "係咪{label}？",
    "zh-CN": "是{label}吗？",
}
_CONFIRM_GENERIC = {
    "zh-HK": "要我做呢件事嗎？",
    "zh-MO": "要我做呢件事嗎？",
    "zh-CN": "要我做这件事吗？",
}


def registry(req: AgentTurnRequest) -> dict[str, dict[str, Any]]:
    """-> {tool name: JSON schema} from either accepted declaration shape."""
    out: dict[str, dict[str, Any]] = {}
    for tool in req.tools:
        name, _, schema = tool.normalized()
        if name:
            out[name] = schema
    return out


def is_forbidden(text: str) -> bool:
    haystack = (text or "").lower()
    return any(word in haystack for word in _FORBIDDEN)


def _valid_args(args: Any, schema: dict[str, Any]) -> bool:
    """Narrow JSON-Schema check for the slice tools.ts actually emits."""
    if not isinstance(args, dict):
        return False
    if schema.get("type") not in (None, "object"):
        return True  # no usable schema: do not over-reject
    properties = schema.get("properties") or {}
    for required in schema.get("required") or []:
        if required not in args:
            return False
    if schema.get("additionalProperties") is False:
        if any(key not in properties for key in args):
            return False
    expected_types = {"string": str, "number": (int, float), "boolean": bool}
    for key, value in args.items():
        spec = properties.get(key)
        if not isinstance(spec, dict):
            continue
        expected = spec.get("type")
        if expected == "number" and isinstance(value, bool):
            return False
        wanted = expected_types.get(expected)
        if wanted is not None and not isinstance(value, wanted):
            return False
    return True


def sanitize_calls(
    calls: Iterable[Any], schemas: dict[str, dict[str, Any]]
) -> list[ToolCall]:
    """Keep only registered tools with valid args, capped at ``MAX_CALLS``."""
    kept: list[ToolCall] = []
    for raw in calls:
        if isinstance(raw, ToolCall):
            name, args = raw.name, raw.args
        elif isinstance(raw, dict):
            name = str(raw.get("name") or "")
            args = raw.get("args") or {}
        else:
            continue
        if name not in schemas or not _valid_args(args, schemas[name]):
            continue
        kept.append(ToolCall(name=name, args=dict(args)))
        if len(kept) >= MAX_CALLS:
            break
    return kept


def needs_confirm(calls: list[ToolCall], locale: str) -> NeedsConfirm | None:
    """First confirm-risk call must be read back before the device executes it."""
    for index, call in enumerate(calls):
        if call.name not in CONFIRM_TOOLS:
            continue
        label = str(call.args.get("name") or call.args.get("app") or "").strip()
        template = _CONFIRM.get(locale)
        question = template.format(label=label) if template and label else _CONFIRM_GENERIC.get(
            locale, _CONFIRM_GENERIC["zh-CN"]
        )
        return NeedsConfirm(callIndex=index, question=question)
    return None


def _mock_plan(req: AgentTurnRequest, schemas: dict[str, dict[str, Any]]) -> list[Any]:
    """Deterministic planner used when no model is configured (P2 contract)."""
    if "create_task" not in schemas:
        return []
    return [{"name": "create_task", "args": {"text": req.utterance.strip()}}]


def _safe_reply(locale: str) -> str:
    return _RETRY.get(locale, _RETRY["zh-CN"])


def _declaration(tool: Any) -> dict[str, Any] | None:
    """Client declaration -> OpenAI tool wrapper (name/description/schema only)."""
    name, description, schema = tool.normalized()
    if not name:
        return None
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": schema or {"type": "object", "properties": {}},
        },
    }


def from_llm_message(
    message: dict[str, Any],
    req: AgentTurnRequest,
    schemas: dict[str, dict[str, Any]],
) -> AgentTurnResponse:
    """Validate one assistant message. Any illegal call discards ALL calls.

    The model must never be able to smuggle in an unregistered tool or malformed
    arguments: if even one call fails validation, the safe outcome is "say that
    again" with zero actions, not a partial plan.
    """
    locale = req.locale
    raw_content = message.get("content")
    reply = raw_content.strip() if isinstance(raw_content, str) else ""

    raw_calls = message.get("tool_calls") or []
    if not isinstance(raw_calls, list):
        raw_calls = []

    parsed: list[dict[str, Any]] = []
    invalid = False
    for item in raw_calls:
        function = item.get("function") if isinstance(item, dict) else None
        if not isinstance(function, dict):
            invalid = True
            continue
        name = str(function.get("name") or "")
        raw_args = function.get("arguments")
        try:
            args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
        except (TypeError, ValueError):
            args = None
        if not isinstance(args, dict):
            invalid = True
            args = {}
        parsed.append({"name": name, "args": args})

    # Truncation to MAX_CALLS is allowed, but a dropped call (unknown name /
    # invalid args) means the model lied about the registry, so the whole plan is
    # discarded.
    if invalid or any(
        call["name"] not in schemas or not _valid_args(call["args"], schemas[call["name"]])
        for call in parsed
    ):
        return AgentTurnResponse(reply=_safe_reply(locale))
    kept = [ToolCall(name=call["name"], args=dict(call["args"])) for call in parsed[:MAX_CALLS]]

    filtered = safety.filter_chat_reply(reply, locale) if reply else ""
    if not kept:
        return AgentTurnResponse(reply=filtered or _safe_reply(locale))
    return AgentTurnResponse(
        reply=filtered or _REPLY.get(locale, _REPLY["zh-CN"]),
        calls=kept,
        needsConfirm=needs_confirm(kept, locale),
    )


def _plan_with_llm(
    req: AgentTurnRequest, device_id: str, schemas: dict[str, dict[str, Any]]
) -> AgentTurnResponse:
    if device_id:
        usage.reserve(device_id)
    tools = [decl for decl in (_declaration(tool) for tool in req.tools) if decl]
    message = LLMClient().complete_tools(
        prompts.agent_turn_messages(req),
        tools,
        timeout=settings.llm_turn_timeout_s,
    )
    return from_llm_message(message, req, schemas)


def plan_turn(req: AgentTurnRequest, device_id: str = "") -> AgentTurnResponse:
    text = (req.utterance or "").strip()
    locale = req.locale

    # Safety first: an emergency must never wait for a model or a tool registry.
    if safety.is_emergency(text):
        return AgentTurnResponse(
            reply=safety.emergency_reply(locale),
            calls=[ToolCall(name="sos", args={"reason": "voice_emergency"})],
        )
    if not text or is_forbidden(text):
        reply = _safe_reply(locale) if not text else _REFUSE.get(locale, _REFUSE["zh-CN"])
        return AgentTurnResponse(reply=reply)

    schemas = registry(req)
    if settings.llm_available:
        try:
            return _plan_with_llm(req, device_id, schemas)
        except LLMNotConfigured:
            logger.info("agent turn: model unavailable, using mock planner")
            return _mock_turn(req, schemas)
        except LLMQuotaExceeded:
            logger.warning("agent turn: daily quota exhausted, returning no calls")
            return AgentTurnResponse(reply=_safe_reply(locale))
        except (LLMUpstreamError, LLMInvalidOutput):
            logger.warning("agent turn: model failed, returning no calls")
            return AgentTurnResponse(reply=_safe_reply(locale))
    return _mock_turn(req, schemas)


def _mock_turn(req: AgentTurnRequest, schemas: dict[str, dict[str, Any]]) -> AgentTurnResponse:
    locale = req.locale
    calls = sanitize_calls(_mock_plan(req, schemas), schemas)
    if not calls:
        return AgentTurnResponse(reply=_safe_reply(locale))
    return AgentTurnResponse(
        reply=_REPLY.get(locale, _REPLY["zh-CN"]),
        calls=calls,
        needsConfirm=needs_confirm(calls, locale),
    )
