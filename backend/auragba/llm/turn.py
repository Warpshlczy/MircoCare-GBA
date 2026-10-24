"""Agent-turn orchestration — P2 mock planner plus the guardrails that are final.

The real model call arrives with C3; everything in this module already owns the
rules that must never depend on the model or on client-side validation:

* emergency language short-circuits to a single ``sos`` call;
* money / credential requests never become tool calls;
* unknown tool names and bad arguments are dropped;
* ``confirm``-risk tools come back with a spoken confirmation question;
* at most three calls.

`ponytail:` the planner is a fixed ``create_task`` echo so B can exercise the
client chain with ``dryRun()``. Replace only ``_plan`` with the LLM call later.
"""

from __future__ import annotations

from typing import Any, Iterable

from ..contract import AgentTurnRequest, AgentTurnResponse, NeedsConfirm, ToolCall
from . import safety

MAX_CALLS = 3

# Mirrors `confirmToolNames()` in web/src/lib/tools.ts. Kept here as a hard set:
# the client supplies tool descriptions, but it must not be able to downgrade a
# confirm-risk tool to "safe" by editing its declaration.
CONFIRM_TOOLS = frozenset({"call_contact", "send_message", "open_app", "ui_tap_text"})

# Utterance-level refusal (never a tool). Mirrors toolrun.ts#refuseReason.
_FORBIDDEN = (
    "转账", "轉賬", "轉帳", "汇款", "匯款", "付款", "过数", "過數",
    "密码", "密碼", "验证码", "驗證碼", "otp",
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


def _plan(req: AgentTurnRequest, schemas: dict[str, dict[str, Any]]) -> list[Any]:
    """P2 mock: echo the senior's words into one `create_task` call."""
    if "create_task" not in schemas:
        return []
    return [{"name": "create_task", "args": {"text": req.utterance.strip()}}]


def plan_turn(req: AgentTurnRequest) -> AgentTurnResponse:
    text = (req.utterance or "").strip()
    locale = req.locale

    # Safety first: an emergency must never wait for a model or a tool registry.
    if safety.is_emergency(text):
        return AgentTurnResponse(
            reply=safety.emergency_reply(locale),
            calls=[ToolCall(name="sos", args={"reason": "voice_emergency"})],
        )
    if not text or is_forbidden(text):
        reply = _RETRY.get(locale, _RETRY["zh-CN"]) if not text else _REFUSE.get(locale, _REFUSE["zh-CN"])
        return AgentTurnResponse(reply=reply)

    schemas = registry(req)
    calls = sanitize_calls(_plan(req, schemas), schemas)
    if not calls:
        return AgentTurnResponse(reply=_RETRY.get(locale, _RETRY["zh-CN"]))
    return AgentTurnResponse(
        reply=_REPLY.get(locale, _REPLY["zh-CN"]),
        calls=calls,
        needsConfirm=needs_confirm(calls, locale),
    )
