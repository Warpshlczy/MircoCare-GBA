#!/usr/bin/env python3
# The self-check deliberately submits invalid payloads (to assert rejection) and
# swaps collaborators (to simulate failures). Type checkers flag those by design;
# the assertions below are the real contract. Keep the suppression local to this
# harness instead of weakening the production package's checks.
# mypy: disable-error-code="arg-type,assignment,attr-defined,misc,list-item,call-overload,call-arg,union-attr,return-value,type-var,operator,index,has-type,no-redef,func-returns-value"
"""Runnable self-check — `python3 selfcheck.py` (no test framework, no fixtures).

The single check left behind by the ponytail rule: it fails loudly if the
non-trivial logic (features, VAD, metrics, fusion, baseline, audit, privacy)
breaks. Pure/engine-level only — it does not boot a server.
"""

from __future__ import annotations

import io
import gc
import logging
import math
import os
import sys
import tempfile
import threading
import time
import wave
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

# The self-check must not depend on the developer's shell. Uvicorn still refuses
# to boot without a real AURA_ENCRYPTION_KEY (validated in config.validate_runtime).
os.environ.setdefault("AURA_ENCRYPTION_KEY", "selfcheck-encryption-key-" + "0" * 16)

from auragba import baseline as bl  # noqa: E402
from auragba.anonymity import assert_k_anonymity, merge_small_bands  # noqa: E402
from auragba.audio import (  # noqa: E402
    FUNCTIONAL_DIM, FUNCTIONAL_NAMES, AudioData, energy_vad, extract_features,
    frame_rms_db, load_audio,
)
from auragba.api.caregiver_routes import interaction_trend  # noqa: E402
from auragba.audit import AuditLog  # noqa: E402
from auragba.changepoint import detect  # noqa: E402
from auragba.config import settings, validate_runtime  # noqa: E402
from auragba.contract import (  # noqa: E402
    AgentCard, AgentIntentRequest, AgentTool, AgentTurnRequest, AssistantChatRequest,
    BehaviourDaily, BehaviourDailyEnvelope, Contact, ContactsRequest, ConversationTurn,
    GaitWindow, GeofenceEvent, HealthCardUpdate, ReminderEscalation, RecordSummary,
    ScreeningSession, SosEvent, StreamScore, TaskEvent, TelemetryEvent, ToolCall,
)
from auragba.crypto import decrypt_text, encrypt_text  # noqa: E402
from auragba.economics import estimate as economics  # noqa: E402
from auragba.llm.turn import (  # noqa: E402
    from_llm_message, needs_confirm, plan_turn, sanitize_calls,
)
from auragba.llm.errors import LLMUpstreamError  # noqa: E402
from auragba.llm.safety import filter_chat_reply, safe_chat_reply  # noqa: E402
from auragba.model import (  # noqa: E402
    late_fusion, load_stream, neutral_score, score_acoustic, score_behavior, score_semantic,
)
from auragba.nlp import analyse_linguistics, coherence  # noqa: E402
from auragba.privacy import pseudonymize, purge, scrub_props  # noqa: E402
from auragba.reports.weekly import (  # noqa: E402
    DIAGNOSTIC_WORDS, build_weekly_report, render_html, render_pdf,
)
from auragba.screening import ingest_session, run_screening  # noqa: E402
from auragba.store import Store  # noqa: E402

SR = 16_000


def _tone(seconds: float = 2.0, f0: float = 150.0, gap: tuple[float, float] | None = None) -> AudioData:
    t = np.arange(int(SR * seconds)) / SR
    freq = f0 + 20 * np.sin(2 * np.pi * 0.7 * t)
    sig = 0.5 * np.sin(2 * np.pi * np.cumsum(freq) / SR) * (0.6 + 0.4 * np.sin(2 * np.pi * 3 * t))
    if gap:
        sig[int(SR * gap[0]) : int(SR * gap[1])] = 0.0
    sig += 0.01 * np.random.RandomState(0).randn(sig.size)
    return AudioData(samples=sig.astype(np.float32), sample_rate=SR, duration_s=seconds, source="synth")


def _wav_bytes(audio: AudioData) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(audio.sample_rate)
        w.writeframes((audio.samples * 32767).astype("<i2").tobytes())
    return buf.getvalue()


# --- runtime configuration (DEV.md C0 / D5) -----------------------------------
# Code defaults must equal the 322-subject calibration in .env.example, otherwise
# a bare `python selfcheck.py` and a `--env-file .env` server disagree on bands.
assert settings.fusion_w_acoustic == 0.2, f"acoustic weight default drifted: {settings.fusion_w_acoustic}"
assert settings.fusion_w_semantic == 0.8, f"semantic weight default drifted: {settings.fusion_w_semantic}"
assert settings.risk_watch == 0.409, f"watch threshold drifted: {settings.risk_watch}"
assert settings.risk_elevated == 0.521, f"elevated threshold drifted: {settings.risk_elevated}"
# The committed template must carry the same values: a `--env-file .env` server
# and a bare `python selfcheck.py` must not disagree on bands (C0).
_example_env = (Path(__file__).resolve().parent / ".env.example").read_text(encoding="utf-8")
for _pinned in (
    "AURA_FUSION_W_ACOUSTIC=0.2",
    "AURA_FUSION_W_SEMANTIC=0.8",
    "AURA_RISK_WATCH=0.409",
    "AURA_RISK_ELEVATED=0.521",
):
    assert _pinned in _example_env, f".env.example drifted from code defaults: {_pinned}"
assert abs(settings.fusion_w_acoustic + settings.fusion_w_semantic - 1.0) < 1e-9
assert settings.fusion3_w_acoustic == 0.15 and settings.fusion3_w_semantic == 0.65
assert settings.fusion3_w_behavior == 0.20
assert abs(settings.fusion3_w_acoustic + settings.fusion3_w_semantic + settings.fusion3_w_behavior - 1.0) < 1e-9
# A spoken turn must not wait longer than the client's spoken budget.
assert settings.llm_timeout_s == 6.0 and settings.llm_turn_timeout_s == 6.0

# Day keys must follow the configured GBA timezone, not the server's local zone.
from auragba.timeutil import day_key  # noqa: E402

assert day_key(int(16.5 * 3_600_000)) == "1970-01-02", "UTC 16:30 is the next day in HKT"

# band boundaries are inclusive on the lower edge
assert settings.risk_band(0.408) == "low"
assert settings.risk_band(0.409) == "watch"
assert settings.risk_band(0.520) == "watch"
assert settings.risk_band(0.521) == "elevated"

# Importing the config must stay side-effect free (selfcheck runs with no server
# env), while the serve-time check still rejects unsafe configuration.
try:
    validate_runtime(replace(settings, auth_secret="too-short"))
except RuntimeError:
    pass
else:
    raise AssertionError("a short AURA_AUTH_SECRET must be rejected at serve time")
try:
    validate_runtime(replace(settings, auth_secret="x" * 32, encryption_key=""))
except RuntimeError:
    pass
else:
    raise AssertionError("a missing AURA_ENCRYPTION_KEY must be rejected at serve time")
try:
    validate_runtime(replace(settings, auth_secret="x" * 32, regulatory_claim_level="diagnostic"))
except RuntimeError:
    pass
else:
    raise AssertionError("the diagnostic claim level must be rejected without clearance")
validate_runtime(replace(settings, auth_secret="x" * 32, environment="development"))

# --- intent whitelist parity with web/src/lib/types.ts (Issue #2 P0) ----------
# A missing value here makes POST /agent/cards answer 422 before its 501 fallback.
AGENT_INTENTS = ("navigate", "call", "alarm", "message", "repeat", "cancel")
for _intent in AGENT_INTENTS:
    AgentIntentRequest(intent=_intent, utterance="打开微信", locale="zh-CN", now=0)
try:
    AgentIntentRequest(intent="teleport", utterance="", locale="zh-CN", now=0)
except Exception:
    pass
else:
    raise AssertionError("an unknown intent must still be rejected")

# --- /agent/turn mock + backend guardrails (Issue #2 P2/P3) -------------------
_TURN_TOOLS = [
    AgentTool(
        name="sos", description="escalate",
        schema={"type": "object", "properties": {"reason": {"type": "string"}},
                "required": ["reason"], "additionalProperties": False},
    ),
    AgentTool(
        name="create_task", description="record",
        schema={"type": "object", "properties": {"text": {"type": "string"}},
                "required": ["text"], "additionalProperties": False},
    ),
    # OpenAI wrapper shape, as emitted by openAiTools() in lib/tools.ts.
    AgentTool(
        type="function",
        function={
            "name": "call_contact", "description": "call",
            "parameters": {"type": "object", "properties": {"name": {"type": "string"}},
                           "required": ["name"], "additionalProperties": False},
        },
    ),
]


def _turn(utterance: str, locale: str = "zh-CN", tools: list[AgentTool] | None = None) -> AgentTurnRequest:
    return AgentTurnRequest(
        utterance=utterance, locale=locale, now=0,
        tools=_TURN_TOOLS if tools is None else tools,
    )


normal = plan_turn(_turn("帮我记住听日覆诊"))
assert normal.reply and len(normal.calls) == 1 and normal.calls[0].name == "create_task"
assert normal.calls[0].args["text"] == "帮我记住听日覆诊"
assert normal.needsConfirm is None

emergency = plan_turn(_turn("我跌亲起唔到身", tools=[]))  # safety works without a registry
assert [c.name for c in emergency.calls] == ["sos"] and "求助" in emergency.reply

forbidden = plan_turn(_turn("帮我转账畀阿明"))
assert forbidden.calls == [] and forbidden.reply, "money requests must never become tool calls"
for _phrase in ("畀钱阿明", "买股票", "transfer money", "password"):
    assert plan_turn(_turn(_phrase)).calls == [], f"backend refusal set must cover {_phrase}"

no_registry = plan_turn(_turn("帮我记住", tools=[_TURN_TOOLS[0]]))
assert no_registry.calls == [] and no_registry.reply, "no create_task in registry -> no call"

# Issue #7: the two new tools' boundaries are taught only when registered, so an
# older client cannot trigger an unknown-name call and lose the whole plan.
from auragba.llm import prompts as prompts_mod  # noqa: E402

_sys_new = prompts_mod.agent_turn_messages(
    _turn("我食咗藥", tools=[AgentTool(name="log_medication"), AgentTool(name="compose_card")])
)[0]["content"]
assert "工具边界" in _sys_new and "log_medication" in _sys_new and "compose_card" in _sys_new
assert "提醒（提醒我食藥）用 create_task" in _sys_new, (
    "reported-taken vs reminder must be explicit"
)
_sys_old = prompts_mod.agent_turn_messages(_turn("帮我记住", tools=[_TURN_TOOLS[1]]))[0]["content"]
assert "工具边界" not in _sys_old, "hints must not mention tools the caller never registered"

assert _TURN_TOOLS[2].normalized()[0] == "call_contact", "OpenAI wrapper must normalise"

_schemas = {name: schema for name, _, schema in (t.normalized() for t in _TURN_TOOLS)}
_kept = sanitize_calls(
    [
        {"name": "delete_everything", "args": {}},  # unknown -> dropped
        {"name": "create_task", "args": {}},        # missing required "text"
        {"name": "create_task", "args": {"text": "买药"}},
    ],
    _schemas,
)
assert [c.name for c in _kept] == ["create_task"] and _kept[0].args["text"] == "买药"

assert len(sanitize_calls(
    [{"name": "create_task", "args": {"text": str(i)}} for i in range(5)], _schemas
)) == 3, "calls must be capped at 3"

_confirm = needs_confirm([ToolCall(name="call_contact", args={"name": "阿明"})], "zh-CN")
assert _confirm is not None and _confirm.callIndex == 0 and "阿明" in _confirm.question

# --- C3: real planner message validation + model fallback --------------------
_llm_req = _turn("帮我记住买药")
_llm_schemas = {name: schema for name, _, schema in (t.normalized() for t in _TURN_TOOLS)}

_ok = from_llm_message(
    {"content": "好，我帮你记住。",
     "tool_calls": [{"function": {"name": "create_task", "arguments": "{\"text\":\"买药\"}"}}]},
    _llm_req, _llm_schemas,
)
assert _ok.calls and _ok.calls[0].name == "create_task" and _ok.calls[0].args["text"] == "买药"

_unknown = from_llm_message(
    {"content": "好",
     "tool_calls": [{"function": {"name": "delete_everything", "arguments": "{}"}},
                    {"function": {"name": "create_task", "arguments": "{\"text\":\"买药\"}"}}]},
    _llm_req, _llm_schemas,
)
assert _unknown.calls == [], "one illegal call discards the whole plan"
assert "再" in _unknown.reply

_bad_args = from_llm_message(
    {"content": "好", "tool_calls": [{"function": {"name": "create_task", "arguments": "not json"}}]},
    _llm_req, _llm_schemas,
)
assert _bad_args.calls == [], "malformed args discard the plan"

# A JSON-Schema property may declare a LIST of types (e.g. nullable union). The
# old check passed that list to dict.get(), which raises "unhashable type"; the
# fix must neither crash nor reject a valid call.
_flex_tool = AgentTool(
    name="flex_note", description="",
    schema={
        "type": "object",
        "properties": {"note": {"type": ["string", "null"]}},
        "required": ["note"],
        "additionalProperties": False,
    },
)
_flex_req = _turn("记低", tools=[_flex_tool])
_flex = from_llm_message(
    {"content": "好",
     "tool_calls": [{"function": {"name": "flex_note", "arguments": "{\"note\":\"ok\"}"}}]},
    _flex_req, {"flex_note": _flex_tool.normalized()[2]},
)
assert [c.name for c in _flex.calls] == ["flex_note"], (
    "a list-valued schema type must not crash the validator"
)

_confirm_msg = from_llm_message(
    {"content": "系咪打畀阿明？",
     "tool_calls": [{"function": {"name": "call_contact", "arguments": "{\"name\":\"阿明\"}"}}]},
    _llm_req, _llm_schemas,
)
assert _confirm_msg.needsConfirm is not None and _confirm_msg.needsConfirm.callIndex == 0

_many = from_llm_message(
    {"content": "好",
     "tool_calls": [{"function": {"name": "create_task", "arguments": "{\"text\":\"%d\"}" % i}}
                    for i in range(4)]},
    _llm_req, _llm_schemas,
)
assert len(_many.calls) == 3, "calls capped at 3"

_advice = from_llm_message(
    {"content": "你患有痴呆，建议服用多奈哌齐", "tool_calls": []},
    _llm_req, _llm_schemas,
)
assert "痴呆" not in _advice.reply and "建议服用" not in _advice.reply

# GLM sometimes writes a tool call as prose markup; never speak that to a senior.
_markup = from_llm_message(
    {"content": "create_task<arg_key>text</arg_key><arg_value>听日覆诊</arg_value></tool_call>",
     "tool_calls": []},
    _llm_req, _llm_schemas,
)
assert _markup.calls == [] and "<arg_key>" not in _markup.reply and "再" in _markup.reply

# --- /assistant/chat reply word list (A's copy assertions cannot cover this) --
_bad_reply = filter_chat_reply("你患有痴呆，建议服用多奈哌齐。", "zh-CN")
assert _bad_reply == safe_chat_reply("zh-CN")
for _word in DIAGNOSTIC_WORDS:
    assert _word not in _bad_reply, f"diagnostic word leaked into a chat reply: {_word}"
_clean_reply = filter_chat_reply("今日天氣幾好，記得飲多啲水。", "zh-HK")
assert "飲多啲水" in _clean_reply, "benign replies must pass through unchanged"

class _ChatLLM:
    def complete_text(self, messages, max_tokens=None, temperature=0.2):
        return "你患有痴呆，建议服用多奈哌齐。"


class _VariedChatLLM:
    """Same prompt twice must not be forced to the same output by the client."""

    def __init__(self) -> None:
        self.seen: list[list[dict[str, str]]] = []
        self.temperatures: list[float] = []

    def complete_text(self, messages, max_tokens=None, temperature=0.2):
        self.seen.append(messages)
        self.temperatures.append(temperature)
        return "今日天氣唔錯，不如出去行下？"


import auragba.llm.service as service_mod  # noqa: E402

_real_service_settings = service_mod.settings
_real_service_client = service_mod.LLMClient
_real_reserve = service_mod.usage.reserve
service_mod.settings = replace(settings, llm_enabled=True)
service_mod.LLMClient = lambda: _ChatLLM()
service_mod.usage.reserve = lambda device_id: 0
try:
    _chat_reply = service_mod.assistant_reply(
        AssistantChatRequest(messages=[{"role": "user", "content": "我最近记性差"}], locale="zh-CN"),
        "",
    )
finally:
    service_mod.settings = _real_service_settings
    service_mod.LLMClient = _real_service_client
    service_mod.usage.reserve = _real_reserve
assert _chat_reply == safe_chat_reply("zh-CN")
for _word in DIAGNOSTIC_WORDS:
    assert _word not in _chat_reply, f"/assistant/chat leaked {_word}"

# Issue #2: the chat turn must carry the assistant side of the conversation and
# run at a temperature that actually varies the wording.
_varied = _VariedChatLLM()
service_mod.settings = replace(settings, llm_enabled=True)
service_mod.LLMClient = lambda: _varied
service_mod.usage.reserve = lambda device_id: 0
try:
    service_mod.assistant_reply(
        AssistantChatRequest(
            messages=[
                {"role": "user", "content": "今日天氣點呀？"},
                {"role": "assistant", "content": "幾好呀，有陽光。"},
                {"role": "user", "content": "咁我出街好唔好？"},
            ],
            locale="zh-HK",
        ),
        "",
    )
finally:
    service_mod.settings = _real_service_settings
    service_mod.LLMClient = _real_service_client
    service_mod.usage.reserve = _real_reserve
_roles = [m["role"] for m in _varied.seen[0]]
assert _roles.count("assistant") == 1, "chat must keep the assistant turn for context"
assert _varied.temperatures[0] > 0.5, "chat temperature must allow varied wording"

import auragba.llm.turn as turn_mod  # noqa: E402


class _FakeLLM:
    def complete_tools(self, messages, tools, timeout=None):
        assert timeout == settings.llm_turn_timeout_s
        assert any(t["function"]["name"] == "create_task" for t in tools)
        return {"content": "好，我帮你记住。",
                "tool_calls": [{"function": {"name": "create_task",
                                             "arguments": "{\"text\":\"买药\"}"}}]}


class _BoomLLM:
    def complete_tools(self, messages, tools, timeout=None):
        raise LLMUpstreamError("boom")


_real_settings, _real_client = turn_mod.settings, turn_mod.LLMClient
try:
    turn_mod.settings = replace(settings, llm_enabled=True)
    turn_mod.LLMClient = lambda: _FakeLLM()
    _planned = plan_turn(_turn("帮我记住买药"), "")
    assert _planned.calls and _planned.calls[0].name == "create_task", "real planner branch"

    turn_mod.LLMClient = lambda: _BoomLLM()
    _previous_level = turn_mod.logger.level
    turn_mod.logger.setLevel(logging.CRITICAL)
    try:
        plan_turn(_turn("帮我记住买药"), "")
    except LLMUpstreamError:
        pass
    else:
        raise AssertionError("upstream failure must surface as 503, not a silent 200")
    finally:
        turn_mod.logger.setLevel(_previous_level)
finally:
    turn_mod.settings = _real_settings
    turn_mod.LLMClient = _real_client

# --- behaviour daily envelope (Issue #2 P1b) ----------------------------------
_beh = BehaviourDaily(
    id="b1", day="2026-10-24",
    taskConfirmDelayMin=None, taskTimeoutRate=None, taskCompletionRate=None,
    deferCount=0, interactionCount=3, gaitCv=None, fallEvents=0,
)
_env = BehaviourDailyEnvelope(behaviour=_beh)
assert _env.circadian is None and _env.digitalSkill is None, "optional rows stay omitted"
_dumped = _env.model_dump()
assert _dumped["behaviour"]["taskTimeoutRate"] is None, "null must never become 0"
assert _dumped["behaviour"]["gaitCv"] is None

with tempfile.TemporaryDirectory() as tmp:
    st = Store(Path(tmp))
    st.set_doc("dev-b", "behaviour:2026-10-24", _dumped)
    stored = st.get_doc("dev-b", "behaviour:2026-10-24")
    assert stored["behaviour"]["taskConfirmDelayMin"] is None
    st.set_doc("dev-b", "behaviour:2026-10-24", _dumped)  # outbox replay
    assert st.get_doc("dev-b", "behaviour:2026-10-24") == stored, "replay must overwrite, not duplicate"

_env2 = BehaviourDailyEnvelope(
    behaviour=_beh,
    circadian={"id": "c1", "day": "2026-10-24", "firstActiveAt": 1, "lastActiveAt": 2,
               "nightWakeCount": 0, "chargingHours": 12.5},
    digitalSkill={"id": "d1", "day": "2026-10-24", "appSwitchCount": None,
                  "opFailRate": None, "firstTouchDelayMs": None},
)
assert _env2.circadian.nightWakeCount == 0 and _env2.digitalSkill.appSwitchCount is None

for _bad in (
    {"id": "b", "day": "2026/10/24"},
    {"id": "b", "day": "2026-10-24", "taskTimeoutRate": 1.5},
    {"id": "b", "day": "2026-10-24", "fallEvents": -1},
    {"id": "b", "day": "2026-10-24", "hearingProxy": 1.2},
    {"id": "b", "day": "2026-10-24", "visionProxy": -0.1},
):
    try:
        BehaviourDaily(**_bad)
    except Exception:
        pass
    else:
        raise AssertionError(f"invalid BehaviourDaily accepted: {_bad}")
try:
    BehaviourDailyEnvelope()
except Exception:
    pass
else:
    raise AssertionError("behaviour is required in the envelope")

# --- task events (Issue #2 P1c, shape provisional until types.ts lands) -------
_event = TaskEvent(id="e1", taskId="t1", state="completed", at=1_000,
                   source="voice", dueAt=900, doneAt=1_200)
assert _event.doneAt == 1_200
for _bad in (
    {"state": "paid", "source": "voice"},
    {"state": "created", "source": "robot"},
):
    try:
        TaskEvent(id="e", taskId="t", at=1, **_bad)
    except Exception:
        pass
    else:
        raise AssertionError(f"invalid TaskEvent accepted: {_bad}")

# --- CardKind / SosEvent.source / geofence (B ↔ C follow-ups) ------------------
for _kind in ("task", "med", "weather", "camera", "info", "place", "alarm", "agentPlan"):
    AgentCard(id="card-x", kind=_kind, title="t", createdAt=0)
try:
    AgentCard(id="card-x", kind="video", title="t", createdAt=0)
except Exception:
    pass
else:
    raise AssertionError("unknown CardKind must be rejected")

_sos = {"id": "s1", "at": 1, "locale": "zh-CN", "reason": "button",
        "confirmed": True, "status": "pending"}
assert SosEvent(**_sos).source == "app", "existing clients default to app"
assert SosEvent(**_sos, source="widget").source == "widget"

_ge = GeofenceEvent(id="ge1", at=1, kind="exit", distanceM=1240.0)
assert _ge.minutesAway is None
assert GeofenceEvent(id="ge2", at=2, kind="enter", distanceM=15.0, minutesAway=62.0).minutesAway == 62.0
for _bad in ({"kind": "left", "distanceM": 10}, {"kind": "exit", "distanceM": -1}):
    try:
        GeofenceEvent(id="g", at=1, **_bad)
    except Exception:
        pass
    else:
        raise AssertionError(f"invalid GeofenceEvent accepted: {_bad}")

# --- audio: schema + features -------------------------------------------------
assert len(FUNCTIONAL_NAMES) == FUNCTIONAL_DIM == 88, "functional schema must be 88 slots"
assert len(set(FUNCTIONAL_NAMES)) == 88, "functional names must be unique"

audio = _tone(2.0, 150.0, gap=(0.6, 0.9))
feats = extract_features(audio)
# 装了 opensmile 时走真 eGeMAPS，未装时降级为 numpy 近似 —— 两者都合法。
# 注意：线上装了 opensmile 才能与训练数据(真 eGeMAPS)同分布。
assert feats.backend in ("numpy", "opensmile"), f"unexpected backend {feats.backend}"
assert len(feats.vector) >= 88, "must emit at least the 88 core functionals"
assert all(np.isfinite(list(feats.vector.values()))), "no NaN/Inf in the feature vector"
# 两个后端都必须暴露同一套 snake_case 规范摘要键，
# 否则 baseline.py 的 TRACKED 表与手工权重表会静默丢指标。
for key in ("f0_mean_hz", "f0_cv", "jitter_local", "shimmer_local", "hnr_db",
            "f1_hz", "f2_hz", "articulation_rate", "speech_rate", "pause_ratio",
            "mean_pause_s", "voiced_ratio", "loudness_db_mean", "duration_s"):
    assert key in feats.summary, f"missing canonical summary key {key} (backend={feats.backend})"
    assert np.isfinite(feats.summary[key]), f"{key} must be finite"
assert 120 < feats.summary["f0_mean_hz"] < 200, f"F0 tracking failed: {feats.summary['f0_mean_hz']}"
assert feats.summary["jitter_local"] >= 0 and feats.summary["shimmer_local"] >= 0
assert 0.0 <= feats.summary["pause_ratio"] <= 1.0
assert 0.0 <= feats.speech_ratio <= 1.0, "speech_ratio must be a real VAD ratio, not hardcoded"

silent = extract_features(AudioData(np.zeros(SR, dtype=np.float32), SR, 1.0, "synth"))
assert silent.vector["loudness_sma3_amean"] <= 0.0 or True  # must not raise
assert all(np.isfinite(list(silent.vector.values()))), "silent clip must stay finite"

# --- audio: WAV round-trip ----------------------------------------------------
decoded = load_audio(_wav_bytes(audio), "x.wav")
assert decoded.sample_rate == SR and decoded.samples.size > 0
assert np.max(np.abs(decoded.samples)) <= 1.0

# --- VAD ----------------------------------------------------------------------
vad = energy_vad(frame_rms_db(audio.samples, SR))
assert vad.speech and 0.0 < vad.ratio < 1.0, "VAD must find speech in a gapped tone"
assert energy_vad(frame_rms_db(np.zeros(SR, dtype=np.float32), SR)).speech is False, "silence is not speech"

# --- NLP metrics --------------------------------------------------------------
ling = analyse_linguistics("今日天气几好，我去公园散步，然后买个菜。唔舒服。")
assert ling.tokens > 0 and 0.0 < ling.ttr <= 1.0
assert ling.sentences >= 2 and ling.sentence_len_variance > 0
assert ling.noun_to_verb_ratio >= 0.0 and ling.filler_ratio >= 0.0
empty = analyse_linguistics("")
assert empty.tokens == 0 and empty.ttr == 0.0 and empty.metrics["tokens"] == 0.0

# --- coherence ----------------------------------------------------------------
assert coherence("今日身体点呀?", "今日身体几好") > 0.0
assert coherence("今日身体点呀?", "") == 0.0
assert coherence("", "随意答一句") == 1.0

# --- streams + fusion ---------------------------------------------------------
ac = score_acoustic(feats.summary, feats.vector)
assert 0.0 <= ac.score <= 1.0 and ac.stream == "acoustic"
# 可解释贡献分解只存在于回退路径；装了真模型（AURA_ACOUSTIC_MODEL）时走
# booster 分支，按设计不产 contributions，不应伪造。
if ac.model == "linear-interpretable":
    assert any(c.direction in ("risk", "protective") for c in ac.contributions), "contributions must be returned"
else:
    assert ac.model.startswith(("lightgbm:", "xgboost:")), f"unexpected acoustic model: {ac.model}"

sem = score_semantic(ling.metrics, 0.8)
assert sem is not None and 0.0 <= sem.score <= 1.0
assert score_semantic({"tokens": 0.0}, 0.0) is None, "no transcript -> no semantic stream"

fused = late_fusion(ac, sem)
assert abs(sum(fused.weights.values()) - 1.0) < 1e-9, "fusion weights must normalise"
assert 0.0 <= fused.risk_index <= 1.0 and fused.band in ("low", "watch", "elevated")

# Two-stream regression: without behaviour the calibrated 0.2/0.8 result must be
# reproduced exactly (DEV.md C1 acceptance).
legacy = late_fusion(ac, sem)
assert abs(legacy.weights["acoustic"] - 0.2) < 1e-9 and abs(legacy.weights["semantic"] - 0.8) < 1e-9
assert abs(legacy.risk_index - (0.2 * ac.score + 0.8 * sem.score)) < 1e-9

# A single stream can never produce watch/elevated.
solo = late_fusion(ac, None)
assert solo.weights == {"acoustic": 1.0} and abs(solo.risk_index - ac.score) < 1e-9
assert solo.insufficient_streams is True and solo.band == "low", "one stream must be pinned to low"

# --- behaviour stream (DEV.md C1) ---------------------------------------------
_EMPTY_DAY = {
    "task_confirm_delay_min": None, "task_timeout_rate": None,
    "task_completion_rate": None, "defer_count": None, "interaction_count": None,
    "gait_cv": None, "fall_events": None, "night_wake_count": None,
    "app_switch_count": None, "op_fail_rate": None,
}
assert score_behavior(_EMPTY_DAY, []) is None, "all-null rollup -> no behaviour stream"

beh = score_behavior(
    {**_EMPTY_DAY, "task_confirm_delay_min": 10.0, "fall_events": 1,
     "interaction_count": 2, "task_completion_rate": 0.5,
     "task_timeout_rate": 0.3, "defer_count": 2, "gait_cv": 0.1},
    [],
)
assert beh is not None and beh.stream == "behavior" and 0.0 <= beh.score <= 1.0
assert beh.model == "rules-illustrative", "no history -> illustrative prior label"
_names = {c.name for c in beh.contributions}
assert "task_confirm_delay_min" in _names and "night_wake_count" not in _names, "nulls are skipped"

_proxy_day = BehaviourDaily(id="b-proxy", day="2026-01-01", hearingProxy=0.7)
assert _proxy_day.visionProxy is None and _proxy_day.hearingProxy == 0.7
assert BehaviourDaily(id="b-nogait", day="2026-01-02", gaitCv=None, fallEvents=0).fallEvents is None
assert BehaviourDaily(id="b-gait", day="2026-01-02", gaitCv=0.1, fallEvents=0).fallEvents == 0
assert BehaviourDaily(id="b-fall", day="2026-01-02", gaitCv=0.1, fallEvents=2).fallEvents == 2
_beh_proxy = score_behavior(
    {**_EMPTY_DAY, "task_confirm_delay_min": 10.0, "fall_events": 1,
     "interaction_count": 2, "task_completion_rate": 0.5,
     "task_timeout_rate": 0.3, "defer_count": 2, "gait_cv": 0.1,
     "hearing_proxy": 0.9, "vision_proxy": 0.1},
    [],
)
assert _beh_proxy is not None and _beh_proxy.score == beh.score, "proxies must not move the score"
_missing_falls = score_behavior({**_EMPTY_DAY, "interaction_count": 0, "fall_events": None}, [])
assert _missing_falls is not None and all(c.name != "fall_events" for c in _missing_falls.contributions)

personal = score_behavior(
    {"task_confirm_delay_min": 20.0},
    [{"task_confirm_delay_min": 2.0} for _ in range(5)],
)
assert personal is not None and personal.model == "rules-personal"
_contrib = next(c for c in personal.contributions if c.name == "task_confirm_delay_min")
assert _contrib.contribution > 2.0 and _contrib.direction == "risk"

three = late_fusion(ac, sem, beh)
assert abs(sum(three.weights.values()) - 1.0) < 1e-9
assert abs(three.weights["acoustic"] - 0.15) < 1e-9
assert abs(three.weights["semantic"] - 0.65) < 1e-9
assert abs(three.weights["behavior"] - 0.20) < 1e-9
assert three.insufficient_streams is False

# Three-stream thresholds are transferred from the two-stream calibration so a
# senior with typical behaviour keeps the same band boundary (DEV.md C1).
def _equal_streams(value: float) -> tuple[StreamScore, StreamScore, StreamScore]:
    return (
        StreamScore(stream="acoustic", score=value, model="test"),
        StreamScore(stream="semantic", score=value, model="test"),
        StreamScore(stream="behavior", score=value, model="test"),
    )


_neutral = neutral_score()
_watch3 = 0.8 * settings.risk_watch + 0.2 * _neutral
_elev3 = 0.8 * settings.risk_elevated + 0.2 * _neutral
assert late_fusion(*_equal_streams(_watch3 + 0.001)).band == "watch"
assert late_fusion(*_equal_streams(_watch3 - 0.001)).band == "low"
assert late_fusion(*_equal_streams(_elev3 + 0.001)).band == "elevated"
assert late_fusion(*_equal_streams(_elev3 - 0.001)).band == "watch"

_two_watch = StreamScore(stream="acoustic", score=0.409, model="test")
_two_watch_sem = StreamScore(stream="semantic", score=0.409, model="test")
_two_low = StreamScore(stream="acoustic", score=0.408, model="test")
_two_low_sem = StreamScore(stream="semantic", score=0.408, model="test")
assert late_fusion(_two_watch, _two_watch_sem).band == "watch"
assert late_fusion(_two_low, _two_low_sem).band == "low", "two-stream thresholds stay calibrated"

partial = late_fusion(ac, None, beh)
assert set(partial.weights) == {"acoustic", "behavior"}
assert abs(sum(partial.weights.values()) - 1.0) < 1e-9
assert partial.insufficient_streams is False

# load_stream: read stored daily docs, newest becomes "today".
with tempfile.TemporaryDirectory() as tmp:
    st = Store(Path(tmp))
    _now = int(time.time() * 1000)
    for _offset in (2, 1, 0):
        _day_key = time.strftime("%Y-%m-%d", time.localtime((_now - _offset * 86_400_000) / 1000))
        st.set_doc("dev-beh", f"behaviour:{_day_key}", {
            "behaviour": {"id": f"b{_offset}", "day": _day_key, "taskConfirmDelayMin": 2.0 + _offset,
                          "taskTimeoutRate": 0.1, "taskCompletionRate": 0.9, "deferCount": 0,
                          "interactionCount": 5, "gaitCv": 0.05, "fallEvents": 0},
            "circadian": None, "digitalSkill": None,
        })
    stream = load_stream(st, "dev-beh", now_ms=_now, days=14)
    assert stream is not None and stream.stream == "behavior"
    assert load_stream(st, "dev-none", now_ms=_now, days=14) is None

# --- personal baseline: robust Z, trend, sufficiency (DEV.md C2) --------------
WEEK_MS = 7 * 86_400_000
BASE_MS = 1_700_000_000_000


def _weekly(count: int) -> list[int]:
    return [BASE_MS + i * WEEK_MS for i in range(count)]


# One spike, not a trend: stable 0.300/0.302 history, today far outside.
stable_hist = [{"pause_ratio": 0.300 + 0.002 * (i % 2)} for i in range(12)]
out = bl.compute_baseline(
    stable_hist, {"pause_ratio": 0.60}, at_ms=_weekly(12), z_window_days=120
)
assert out.sufficient and out.rows, "12 weekly samples must be sufficient"
row0 = out.rows[0]
assert row0.flag == "elevated" and row0.direction == "high", "a large deviation must flag elevated"
assert abs(row0.z) > 2.0
assert abs(row0.median - 0.301) < 1e-9, "Z must be centred on the median"
assert row0.sustained is False, "a single spike must not be marked sustained"
assert out.changepoints == [], "a stable history must not produce a change point"

# Fewer than 10 reference samples -> no baseline claim (D6).
out2 = bl.compute_baseline(stable_hist[:2], {"pause_ratio": 0.3})
assert not out2.sufficient and out2.note and out2.samples == 2

# The narrower Z window really is enforced: 12 weekly samples -> only ~2 in 14 days.
out3 = bl.compute_baseline(stable_hist, {"pause_ratio": 0.3}, at_ms=_weekly(12), z_window_days=14)
assert not out3.sufficient and out3.samples <= 3

# Zero-MAD guard: constant history must not divide by zero.
flat_hist = [{"pause_ratio": 0.30} for _ in range(10)]
out4 = bl.compute_baseline(flat_hist, {"pause_ratio": 0.42}, at_ms=_weekly(10), z_window_days=120)
assert out4.sufficient and math.isfinite(out4.rows[0].z) and out4.rows[0].z > 2.0

# Trend is a per-week slope over timestamped history.
rising = [{"pause_ratio": 0.30 + 0.01 * i} for i in range(12)]
out5 = bl.compute_baseline(rising, {"pause_ratio": 0.42}, at_ms=_weekly(12), z_window_days=120)
assert abs(out5.rows[0].trend - 0.01) < 1e-6, f"trend must be 0.01/week, got {out5.rows[0].trend}"

# A missing timestamp means "unknown time": it must not crash max(), enter the
# Z window, or invent a trend (regression for the None-safe cutoff).
out_gap = bl.compute_baseline(
    rising, {"pause_ratio": 0.42}, at_ms=[*_weekly(11), None], z_window_days=120
)
assert out_gap.sufficient and out_gap.rows[0].trend == 0.0, (
    "a None timestamp must be excluded, not propagate or crash"
)

# A path only sends energy/envelope features; sample count alone must not turn
# into a "stable" baseline with zero comparable biomarkers.
energy_hist = [
    {"frameCount": 300, "meanRmsDb": -30.0, "speech_ratio": 0.6} for _ in range(12)
]
out_energy = bl.compute_baseline(
    energy_hist, {"frameCount": 300}, at_ms=_weekly(12), z_window_days=120
)
assert not out_energy.sufficient and not out_energy.rows
assert "no tracked" in (out_energy.note or "")

# --- CUSUM change point: stable 8 weeks, then 4 weeks of worsening -------------
cp = detect(
    [0.300 + 0.002 * (i % 2) for i in range(8)] + [0.30 + 0.02 * k for k in range(1, 5)],
    at=_weekly(12),
)
assert cp is not None and cp.direction == "high", "a sustained worsening must alarm"
assert cp.index <= 10, f"CUSUM must alarm within 2 weeks of the turn, got index {cp.index}"
assert cp.at is not None
assert detect([0.300 + 0.002 * (i % 2) for i in range(12)]) is None, "stable series must not alarm"
assert detect([0.3] * 12) is None, "constant series must not alarm"
assert detect([0.3] * 5) is None, "fewer than 6 points cannot be judged"

# --- SQLite store: windows, docs, persistence, concurrency (DEV.md C6) --------
with tempfile.TemporaryDirectory() as tmp:
    st = Store(Path(tmp))
    st.record("dev-sql", "metrics", {"at": 1_000, "v": 1})
    st.record("dev-sql", "metrics", {"at": 2_000, "v": 2})
    st.record("dev-sql", "gait", {"startedAt": 3_000, "steps": 4})
    assert [r["v"] for r in st.history("dev-sql", "metrics")] == [1, 2], "chronological order"
    assert [r["v"] for r in st.history("dev-sql", "metrics", since_ms=1_500)] == [2]
    assert st.history("dev-sql", "gait", since_ms=2_500)[0]["steps"] == 4, "startedAt is the time column"

    # Outbox replay can insert an OLD sample after a newer one; history must still
    # come back in time order or baseline/CUSUM/report all read the wrong "today".
    st.record("dev-sql", "out_of_order", {"at": 3_000, "v": 3})
    st.record("dev-sql", "out_of_order", {"at": 1_000, "v": 1})
    st.record("dev-sql", "out_of_order", {"at": 2_000, "v": 2})
    assert [r["v"] for r in st.history("dev-sql", "out_of_order")] == [1, 2, 3], (
        "history must be ordered by `at`, not by insertion id"
    )

    assert st.get_doc("dev-sql", "health_card") is None
    st.set_doc("dev-sql", "health_card", {"name": "陳阿婆"})
    st.set_doc("dev-sql", "health_card", {"name": "陳阿婆", "age": 78})
    assert st.get_doc("dev-sql", "health_card") == {"name": "陳阿婆", "age": 78}, "upsert"

    reopened = Store(Path(tmp))
    assert reopened.get_doc("dev-sql", "health_card")["age"] == 78
    assert len(reopened.history("dev-sql", "metrics")) == 2

with tempfile.TemporaryDirectory() as tmp:
    st = Store(Path(tmp))

    def _writer(n: int) -> None:
        for i in range(100):
            st.record("dev-conc", "events", {"at": n * 1000 + i, "n": n, "i": i})

    threads = [threading.Thread(target=_writer, args=(n,)) for n in range(20)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    rows = st.history("dev-conc", "events")
    assert len(rows) == 2_000, f"concurrent writes lost {2_000 - len(rows)} rows"
    assert len({(r["n"], r["i"]) for r in rows}) == 2_000, "duplicate rows under concurrency"

# --- weekly family report: six sections, traceable evidence, no disease words --
with tempfile.TemporaryDirectory() as tmp:
    st = Store(Path(tmp))
    now_ms = int(time.time() * 1000)
    for i in range(12):
        value = 0.300 + (0.002 if i % 2 else 0.0) + 0.02 * max(0, i - 7)
        st.record("dev-rep", "screening_metrics",
                  {"at": now_ms - (11 - i) * 86_400_000, "metrics": {"pause_ratio": value}})
    for i in range(10):
        st.record("dev-rep", "conversation",
                  {"id": f"c{i}", "at": now_ms - i * 3_600_000, "role": "user",
                   "text": "你好", "locale": "zh-CN"})
    st.record("dev-rep", "screening_sessions",
              {"at": now_ms - 3_600_000, "id": "s1", "durationMs": 60_000, "speechRatio": 0.6,
               "trimmedStartMs": 0, "trimmedEndMs": 0, "quality": "good", "snrDb": 18.0})
    st.record("dev-rep", "screening_sessions",
              {"at": now_ms - 3_000_000, "id": "s2", "durationMs": 60_000, "speechRatio": 0.5,
               "trimmedStartMs": 0, "trimmedEndMs": 0, "quality": "fair", "snrDb": 12.0})
    st.record("dev-rep", "screening_sessions",
              {"at": now_ms - 2_400_000, "id": "s3", "durationMs": 60_000, "speechRatio": 0.1,
               "trimmedStartMs": 0, "trimmedEndMs": 0, "quality": "reject", "snrDb": 3.0})
    st.record("dev-rep", "gait",
              {"id": "g1", "startedAt": now_ms - 86_400_000, "endedAt": now_ms - 86_400_000 + 5_000,
               "steps": 12, "cadence": 60, "cv": 0.08, "fall": False})
    st.record("dev-rep", "gait_falls", {"at": now_ms - 86_400_000, "reason": "impact"})
    # B writes minutesAway on the closing `enter`, never on `exit`.
    st.record("dev-rep", "geofence_events",
              {"id": "gf1", "at": now_ms - 4_300_000, "kind": "exit", "distanceM": 620.0})
    st.record("dev-rep", "geofence_events",
              {"id": "gf2", "at": now_ms - 4_200_000, "kind": "enter",
               "distanceM": 12.0, "minutesAway": 45.0})
    st.record("dev-rep", "geofence_events",
              {"id": "gf3", "at": now_ms - 3_800_000, "kind": "exit", "distanceM": 40.0})
    # A short trip still counts as an outing; it just never pages the family.
    st.record("dev-rep", "geofence_events",
              {"id": "gf4", "at": now_ms - 3_700_000, "kind": "exit",
               "distanceM": 30.0, "alert": False})
    st.record("dev-rep", "reminder_escalations",
              {"id": "r1", "at": now_ms - 7_200_000, "locale": "zh-CN", "kind": "med",
               "stage": "notify-caregiver"})
    st.record("dev-rep", "screening_results",
              {"at": now_ms - 86_400_000, "id": "s1", "riskIndex": 0.55, "riskBand": "elevated"})
    # `/screening/analyze` keeps its quality flag on the result row; a reject
    # result must be counted in the quality note but never drive the advice tier.
    st.record("dev-rep", "screening_results",
              {"at": now_ms - 2_300_000, "id": "scr-analyze-1", "riskIndex": 0.9,
               "riskBand": "elevated", "quality": "reject"})
    st.record("dev-rep", "telemetry",
              {"id": "t1", "name": "proactive", "at": now_ms - 3_600_000, "locale": "zh-CN",
               "props": {"kind": "greeting", "trigger": "open"}})
    st.record("dev-rep", "telemetry",
              {"id": "t2", "name": "interview_answer", "at": now_ms - 3_500_000, "locale": "zh-CN",
               "props": {"questionId": 3, "answerLen": 12}})
    st.record("dev-rep", "telemetry",
              {"id": "t3", "name": "interview_end", "at": now_ms - 3_400_000, "locale": "zh-CN",
               "props": {"answered": 6, "durationSec": 240}})
    _today_key = time.strftime("%Y-%m-%d", time.localtime(now_ms / 1000))
    st.set_doc("dev-rep", f"behaviour:{_today_key}", {
        "behaviour": {"id": "b1", "day": _today_key, "taskConfirmDelayMin": 8.0,
                      "taskTimeoutRate": 0.1, "taskCompletionRate": 0.8, "deferCount": 1,
                      "interactionCount": 5, "gaitCv": 0.06, "fallEvents": 0,
                      "hearingProxy": 0.72, "visionProxy": None},
        "circadian": None, "digitalSkill": None,
    })

    report = build_weekly_report("dev-rep", st, now=now_ms)
    assert [s.key for s in report.sections] == [
        "talk", "change", "tasks", "activity", "advice", "privacy"
    ], "the report must always contain exactly the six fixed sections"

    change = report.sections[1]
    assert change.available and change.evidence, "a worsening series must surface a change"
    ev = change.evidence[0]
    assert ev.feature and ev.samples >= 10 and ev.windowDays == settings.baseline_days
    assert ev.z > 0 and ev.direction == "high"
    assert report.sections[4].counts[0].value == "尽快就医"
    _task_counts = {c.label: c.value for c in report.sections[2].counts}
    assert _task_counts["任务完成率"] == "80%", "behaviour stream must feed section 3"
    assert _task_counts["平均确认延迟"] == "8 分钟"
    assert "行为流已接入" in report.sections[2].summary
    assert next(c.value for c in report.sections[5].counts if c.label == "上传原始音频") == "0"

    html_doc = render_html(report)
    assert "<!doctype html>" in html_doc and "查看依据" in html_doc
    _pdf = render_pdf(report)
    assert _pdf.startswith(b"%PDF") and len(_pdf) > 500, "C4 PDF must be a real PDF"
    blob = report.model_dump_json() + html_doc
    for word in DIAGNOSTIC_WORDS:
        assert word not in blob, f"diagnostic word leaked into the family report: {word}"

    assert report.claimLevel == "observation" and "辅助观察" in report.disclaimer
    change_section = next(s for s in report.sections if s.key == "change")
    assert "1 条 fair" in change_section.note and "2 次采集质量不合格" in change_section.note
    talk_section = next(s for s in report.sections if s.key == "talk")
    assert any(
        c.label == "完成访谈" and c.value == "1 次" for c in talk_section.counts
    ), "interview_end counts once; interview_answer must not double-count"
    assert any(
        c.label == "主动开口" and c.value == "1 次" for c in talk_section.counts
    ), "A's `proactive` telemetry must feed the talk section (the old names are gone)"
    activity_section = next(s for s in report.sections if s.key == "activity")
    assert "代理指标" in activity_section.note
    assert any(
        c.label == "听力/视觉代理" and "能听清 72%" in c.value and "能看清 —" in c.value
        for c in activity_section.counts
    ), "proxies are shown as 'can hear %' (higher is better), missing side as dash"
    _activity_counts = {c.label: c.value for c in activity_section.counts}
    assert _activity_counts["外出次数"] == "3 次", "every exit counts, alerted or not"
    assert _activity_counts["外出时长"] == "45 分钟（1 次）", "minutesAway lives on enter, not exit"

    # Zero usable screening -> no advice, not a fabricated "low / continue observing".
    st.record("dev-nodata", "screening_results",
              {"at": now_ms - 3_000_000, "id": "cap-1", "source": "screening_session",
               "riskBand": "low", "insufficientStreams": True, "quality": "good"})
    _nodata = build_weekly_report("dev-nodata", st, now=now_ms)
    _nodata_advice = next(s for s in _nodata.sections if s.key == "advice")
    assert _nodata_advice.available is False, "no usable screening means no advice tier"
    assert "暂不给出建议" in _nodata_advice.summary
    assert any(c.value == "样本不足" for c in _nodata_advice.counts)

    # A real low band must still produce the normal tier (the new branch must not
    # swallow usable data).
    st.record("dev-low", "screening_results",
              {"at": now_ms - 3_000_000, "id": "low-1", "riskIndex": 0.2,
               "riskBand": "low", "quality": "good", "insufficientStreams": False})
    _low = build_weekly_report("dev-low", st, now=now_ms)
    _low_advice = next(s for s in _low.sections if s.key == "advice")
    assert _low_advice.available and "继续观察" in _low_advice.summary

    import auragba.reports.weekly as weekly_mod  # noqa: E402

    _real_weekly_settings = weekly_mod.settings
    weekly_mod.settings = replace(settings, regulatory_claim_level="triage_support")
    try:
        _triage = build_weekly_report("dev-rep", st, now=now_ms)
    finally:
        weekly_mod.settings = _real_weekly_settings
    assert _triage.claimLevel == "triage_support" and "辅助分诊" in _triage.disclaimer

    # zh-HK / zh-MO must actually change the copy, not just the `locale` field.
    for _loc in ("zh-HK", "zh-MO"):
        _hk = build_weekly_report("dev-rep", st, now=now_ms, locale=_loc)
        assert _hk.locale == _loc
        assert _hk.sections[0].title == "這一週他講了多少話", f"{_loc} title not localized"
        assert "本報告是認知變化的輔助觀察" in _hk.disclaimer
        assert _hk.sections[4].counts[0].value == "盡快就醫"
        _hk_blob = _hk.model_dump_json() + render_html(_hk)
        for _word in DIAGNOSTIC_WORDS:
            assert _word not in _hk_blob, f"diagnostic word leaked into {_loc}: {_word}"

# A reject result or a capture-only row must neither set nor mask the advice tier.
with tempfile.TemporaryDirectory() as tmp:
    st_adv = Store(Path(tmp))
    _now_adv = int(time.time() * 1000)
    st_adv.record("dev-adv", "screening_results",
                  {"at": _now_adv - 2 * 86_400_000, "id": "ok",
                   "riskIndex": 0.45, "riskBand": "watch"})
    st_adv.record("dev-adv", "screening_results",
                  {"at": _now_adv - 86_400_000, "id": "bad",
                   "riskIndex": 0.9, "riskBand": "elevated", "quality": "reject"})
    st_adv.record("dev-adv", "screening_results",
                  {"at": _now_adv - 3_600_000, "id": "capture",
                   "riskBand": "low", "insufficientStreams": True, "quality": "good"})
    _adv = build_weekly_report("dev-adv", st_adv, now=_now_adv)
    assert _adv.sections[4].counts[0].value == "本月内做一次认知评估", (
        "reject/capture rows must not raise or mask the weekly advice tier"
    )

# Full duration coverage drops the redundant "(n 次)"; a sub-minute round must
# not read as "did not go out".
with tempfile.TemporaryDirectory() as tmp:
    st_out = Store(Path(tmp))
    t_out = int(time.time() * 1000)
    st_out.record("dev-out", "geofence_events",
                  {"id": "o1", "at": t_out - 3 * 86_400_000, "kind": "exit", "distanceM": 500.0})
    st_out.record("dev-out", "geofence_events",
                  {"id": "i1", "at": t_out - 3 * 86_400_000 + 1_800_000, "kind": "enter",
                   "distanceM": 10.0, "minutesAway": 30.0})
    st_out.record("dev-out", "geofence_events",
                  {"id": "o2", "at": t_out - 2 * 86_400_000, "kind": "exit", "distanceM": 300.0})
    st_out.record("dev-out", "geofence_events",
                  {"id": "i2", "at": t_out - 2 * 86_400_000 + 1_200_000, "kind": "enter",
                   "distanceM": 10.0, "minutesAway": 20.0})
    _out_counts = {c.label: c.value for c in next(
        s for s in build_weekly_report("dev-out", st_out, now=t_out).sections
        if s.key == "activity").counts}
    assert _out_counts["外出次数"] == "2 次"
    assert _out_counts["外出时长"] == "50 分钟", "full coverage must drop the redundant count"

with tempfile.TemporaryDirectory() as tmp:
    st_zero = Store(Path(tmp))
    t_zero = int(time.time() * 1000)
    st_zero.record("dev-zero", "geofence_events",
                   {"id": "z1", "at": t_zero - 86_400_000, "kind": "exit", "distanceM": 20.0})
    st_zero.record("dev-zero", "geofence_events",
                   {"id": "z2", "at": t_zero - 86_400_000 + 20_000, "kind": "enter",
                    "distanceM": 5.0, "minutesAway": 0.0})
    _zero_counts = {c.label: c.value for c in next(
        s for s in build_weekly_report("dev-zero", st_zero, now=t_zero).sections
        if s.key == "activity").counts}
    assert _zero_counts["外出时长"] == "不足 1 分钟", "a sub-minute trip is not 0"

# --- k-anonymity gate (DPIA D.3) ---------------------------------------------
_small = (
    [{"band": "low"} for _ in range(5)]
    + [{"band": "watch"} for _ in range(20)]
    + [{"band": "elevated"} for _ in range(20)]
)
assert_k_anonymity([{"band": "watch"} for _ in range(20)])
try:
    assert_k_anonymity(_small)
except ValueError:
    pass
else:
    raise AssertionError("a band below k must be refused")
_merged = merge_small_bands(_small)
assert {row["band"] for row in _merged} == {"watch", "elevated"}
assert sum(1 for row in _merged if row["band"] == "watch") == 25
assert_k_anonymity(_merged)
try:
    assert_k_anonymity([{"band": "low"} for _ in range(10)])
except ValueError:
    pass
else:
    raise AssertionError("a total below k must be refused")

# --- health economics ---------------------------------------------------------
lo = economics(0.2, "low")
hi = economics(0.8, "elevated")
assert hi.qalyGained > lo.qalyGained and hi.costSavedPerPatient >= lo.costSavedPerPatient
assert lo.costSavedPerPatient >= 0.0 and hi.currency == "HKD" and hi.disclaimer

# --- privacy ------------------------------------------------------------------
assert pseudonymize("abc") == pseudonymize("abc") and pseudonymize("abc") != pseudonymize("abd")
scrubbed = scrub_props({"intent": "weather", "mode": "agent", "note": "联络我 a@b.com 或者 91234567", "phone": "91234567"})
assert "phone" not in scrubbed and "note" not in scrubbed, "PII / free text must be dropped"
assert "a@b.com" not in str(scrubbed)
# A's interview_answer sends `textLen`: the numeric count must survive, while a
# string under the same key is still free text and must be dropped.
assert scrub_props({"textLen": 12, "answerLen": 8}) == {"textLen": 12, "answerLen": 8}
assert "textLen" not in scrub_props({"textLen": "我今日唔舒服"})
buf = bytearray(b"secret-audio")
assert purge(buf) and set(buf) == {0}, "extract-and-burn must zero the buffer"

# --- conversation encryption + retention primitives (DEV.md C5) ---------------
_cipher = encrypt_text("dev-x", "turn-1", "我今日唔舒服，想睇医生")
assert _cipher.startswith("v1:") and "唔舒服" not in _cipher, "ciphertext must not leak text"
assert decrypt_text("dev-x", "turn-1", _cipher) == "我今日唔舒服，想睇医生"
assert decrypt_text("dev-x", "turn-1", "legacy plaintext") == "legacy plaintext", "pre-C5 rows"
try:
    decrypt_text("dev-x", "turn-2", _cipher)
except Exception:
    pass
else:
    raise AssertionError("AAD must bind ciphertext to its turn id")

with tempfile.TemporaryDirectory() as tmp:
    st = Store(Path(tmp))
    st.record("dev-r", "conversation", {"id": "c1", "at": 1_000, "text": "a"})
    st.record("dev-r", "conversation", {"id": "c2", "at": 9_000, "text": "b"})
    st.record("dev-other", "conversation", {"id": "o1", "at": 1_000, "text": "c"})
    assert st.count_before("conversation", 5_000) == 2
    assert st.delete_by_id("dev-r", "conversation", "c1") is True
    assert st.delete_by_id("dev-r", "conversation", "c1") is False, "second delete must be a no-op"
    assert [r["id"] for r in st.history("dev-r", "conversation")] == ["c2"]
    assert st.delete_before("conversation", 10_000, "dev-r") == 1
    assert st.history("dev-r", "conversation") == []
    assert len(st.history("dev-other", "conversation")) == 1, "purge must be device-scoped here"

# --- audit chain (tamper-evident) --------------------------------------------
with tempfile.TemporaryDirectory() as tmp:
    log = AuditLog(Path(tmp) / "audit.jsonl")
    for i in range(3):
        log.append(kind="screening", device_id="dev-x", engine_version="e", feature_set_version="f",
                   fusion_version="u", input_digest=f"d{i}", output={"riskIndex": 0.1 * i})
    log.append(kind="screening", device_id="dev-y", engine_version="e", feature_set_version="f",
               fusion_version="u", input_digest="dy", output={"riskIndex": 0.3})
    assert [r["deviceId"] for r in log.records(10, device_id="dev-y")] == ["dev-y"]
    assert len(log.records(10, device_id="dev-x")) == 3, "audit reads must be device-scoped"
    assert log.verify() is True
    lines = (Path(tmp) / "audit.jsonl").read_text().splitlines()
    lines[1] = lines[1].replace('"riskIndex": 0.1', '"riskIndex": 9.9')
    (Path(tmp) / "audit.jsonl").write_text("\n".join(lines) + "\n")
    assert log.verify() is False, "a tampered record must break the chain"

# --- full orchestrator (isolated store + audit) -------------------------------
with tempfile.TemporaryDirectory() as tmp:
    st = Store(Path(tmp))
    lg = AuditLog(Path(tmp) / "audit.jsonl")
    result = run_screening(data=_wav_bytes(audio), filename="t.wav", locale="zh-HK",
                           device_id="dev-check", question="今日身体点呀?", store=st, audit=lg)
    assert 0.0 <= result.riskIndex <= 1.0 and result.notForDiagnosis is True
    assert result.audioDiscarded is True, "extract-and-burn must discard the audio buffer"
    # openSMILE 后端会附带额外的 openSMILE 列（>=88），numpy 后端恰好 88
    assert len(result.acousticFeatures) >= 88 and result.audit.seq == 0
    assert result.changepoints == [], "a fresh device has no change points yet"
    assert result.baseline is not None and not result.baseline.sufficient
    assert result.baseline.samples < 10 and result.baseline.note
    assert result.behaviorStream is None, "no daily rollup -> no behaviour stream"
    assert result.insufficientStreams is (
        result.semanticStream is None and result.behaviorStream is None
    ), "single-stream guard"
    assert lg.verify() is True
    dumped = result.model_dump()
    for key in ("riskIndex", "riskBand", "acousticStream", "semanticStream",
                "behaviorStream", "insufficientStreams", "engineVersion",
                "featureSetVersion", "baseline", "changepoints", "quality", "snrDb"):
        assert key in dumped, f"wire payload missing {key}"
    # The 2s synthetic clip fails A's gate (8s minimum), so it must be labelled
    # reject and excluded from the baseline.
    assert result.quality == "reject", f"short capture must be reject, got {result.quality}"
    payload = result.model_dump_json()
    assert '"semanticStream"' in payload
    rows = st.history("dev-check", "screening_results")
    assert rows and rows[-1]["insufficientStreams"] is True
    assert rows[-1]["baselineSufficient"] is False, "family badge needs the baseline flag"
    assert rows[-1]["quality"] == "reject" and rows[-1]["usedInBaseline"] is False
    assert st.history("dev-check", "screening_metrics") == [], "reject samples stay out of the baseline"

# --- ingest_session: quality is persisted, reject never enters the baseline ----
with tempfile.TemporaryDirectory() as tmp:
    st = Store(Path(tmp))
    now_q = int(time.time() * 1000)
    base = dict(durationMs=3000, speechRatio=0.8, trimmedStartMs=0, trimmedEndMs=3000,
                features={"jitter": 0.1})
    ingest_session(ScreeningSession(id="q-reject", startedAt=now_q, quality="reject", snrDb=3.0, **base),
                   "dev-q", store=st)
    assert st.history("dev-q", "screening_metrics") == [], "reject must not enter the baseline"
    rejected_row = st.history("dev-q", "screening_sessions")[-1]
    assert rejected_row["quality"] == "reject" and rejected_row["snrDb"] == 3.0
    assert rejected_row["usedInBaseline"] is False
    rejected_result = st.history("dev-q", "screening_results")[-1]
    assert rejected_result["insufficientStreams"] is True
    assert rejected_result["riskBand"] == "low" and "riskIndex" not in rejected_result
    assert rejected_result["quality"] == "reject" and rejected_result["usedInBaseline"] is False
    assert rejected_result["baselineSufficient"] is False, "a 1-sample baseline is not sufficient"

    ingest_session(ScreeningSession(id="q-fair", startedAt=now_q + 1000, quality="fair", snrDb=12.0, **base),
                   "dev-q", store=st)
    assert len(st.history("dev-q", "screening_metrics")) == 1, "fair still feeds the baseline"
    fair_row = st.history("dev-q", "screening_sessions")[-1]
    assert fair_row["quality"] == "fair" and fair_row["snrDb"] == 12.0
    assert fair_row["usedInBaseline"] is True
    fair_result = st.history("dev-q", "screening_results")[-1]
    assert fair_result["id"] == "q-fair" and fair_result["source"] == "screening_session"
    assert fair_result["insufficientStreams"] is True, "capture-only rows never claim a band"
    assert "riskIndex" not in fair_result, "no stream -> no invented score"

    # Outbox replay: the same session id must not add a second baseline sample.
    ingest_session(ScreeningSession(id="q-fair", startedAt=now_q + 1000, quality="fair", snrDb=12.0, **base),
                   "dev-q", store=st)
    assert len(st.history("dev-q", "screening_metrics")) == 1, "replayed session must be idempotent"
    assert len(st.history("dev-q", "screening_sessions")) == 2, "replayed session must not be re-recorded"
    assert len(st.history("dev-q", "screening_results")) == 2, "replayed session must not add a result"

    ingest_session(ScreeningSession(id="q-legacy", startedAt=now_q + 2000, **base), "dev-q", store=st)
    assert len(st.history("dev-q", "screening_metrics")) == 2, "old clients without quality still count"
    assert len(st.history("dev-q", "screening_results")) == 3

# --- telemetry: an at-least-once upload must not double the counters ----------
import auragba.api.contract_routes as contract_routes  # noqa: E402

with tempfile.TemporaryDirectory() as tmp:
    st = Store(Path(tmp))
    _real_contract_store = contract_routes.store
    contract_routes.store = st
    try:
        _event = TelemetryEvent(
            id="t-dup", name="interview_end", at=int(time.time() * 1000),
            locale="zh-CN", props={"answered": 3},
        )
        contract_routes.post_telemetry([_event], "dev-t")
        contract_routes.post_telemetry([_event], "dev-t")
    finally:
        contract_routes.store = _real_contract_store
    assert len(st.history("dev-t", "telemetry")) == 1, "replayed telemetry must be ingested once"

# --- records summary: coarse daily aggregate only, replay-safe (issue #7) -----
with tempfile.TemporaryDirectory() as tmp:
    st = Store(Path(tmp))
    _real_records_store = contract_routes.store
    contract_routes.store = st
    _rs_day = day_key(int(time.time() * 1000))
    _rs_now = int(time.time() * 1000)
    try:
        contract_routes.post_records_summary(
            RecordSummary(day=_rs_day, kind="med", count=2, lastAt=_rs_now), "dev-rs"
        )
        contract_routes.post_records_summary(  # outbox replay: replace, never add
            RecordSummary(day=_rs_day, kind="med", count=2, lastAt=_rs_now), "dev-rs"
        )
        _rs_doc = st.get_doc("dev-rs", f"records_summary:{_rs_day}:med")
        assert _rs_doc["count"] == 2 and _rs_doc["kind"] == "med"
    finally:
        contract_routes.store = _real_records_store

    for _bad in (
        {"day": _rs_day, "kind": "med", "count": -1},
        {"day": "2026/10/25", "kind": "med", "count": 1},
        {"day": _rs_day, "kind": "unknown", "count": 1},
    ):
        try:
            RecordSummary(**_bad)
        except Exception:
            pass
        else:
            raise AssertionError(f"invalid RecordSummary accepted: {_bad}")
    _record_card = AgentCard(
        id="rec-1", kind="record", title="今日記錄", createdAt=0,
        data={"headline": "食藥 08:12"},
    )
    assert _record_card.kind == "record", "CardKind must accept `record` (issue #7)"

# --- geofence: `alert=false` stays silent but still feeds the weekly count ----
with tempfile.TemporaryDirectory() as tmp:
    st = Store(Path(tmp))
    _real_geo_store = contract_routes.store
    _real_notify = contract_routes.notify_dispatch
    _notified: list[dict] = []
    contract_routes.store = st
    contract_routes.notify_dispatch = lambda dev, kind, payload: _notified.append(payload) or []
    _gf_now = int(time.time() * 1000)
    try:
        _quiet = GeofenceEvent(
            id="gf-quiet", at=_gf_now, kind="exit", distanceM=30.0, alert=False
        )
        contract_routes.post_geofence_event(_quiet, "dev-gf")
        # The same crossing escalates at the away threshold: page once, one row.
        contract_routes.post_geofence_event(
            GeofenceEvent(id="gf-quiet", at=_gf_now, kind="exit", distanceM=30.0, alert=True),
            "dev-gf",
        )
        # A late silent replay must not downgrade or duplicate the alert.
        contract_routes.post_geofence_event(_quiet, "dev-gf")
        contract_routes.post_geofence_event(
            GeofenceEvent(id="gf-loud", at=_gf_now + 1000, kind="exit", distanceM=620.0),
            "dev-gf",
        )
    finally:
        contract_routes.store = _real_geo_store
        contract_routes.notify_dispatch = _real_notify
    assert [p["id"] for p in _notified] == ["gf-quiet", "gf-loud"], "only escalations page the family"
    rows = st.history("dev-gf", "geofence_events")
    assert len(rows) == 2 and all(r["alert"] is True for r in rows), (
        "one row per outing; the silent start is replaced by the escalation"
    )

# --- contacts: family-managed callable list, SOS contact untouched ------------
_contact = Contact(id="c1", name="陳小明", relation="儿子", phone="+852 9000 0000")
assert _contact.phone == "+85290000000", "phone formatting is normalised before validation"
for _bad_contacts in (
    {"contacts": [{"id": f"c{i}", "name": "x", "phone": "123456"} for i in range(6)]},
    {"contacts": [{"id": "c", "name": "x", "phone": "not-a-phone"}]},
    {"contacts": [{"id": "c", "name": "x", "phone": "123456"},
                  {"id": "c", "name": "y", "phone": "123456"}]},
):
    try:
        ContactsRequest(**_bad_contacts)
    except Exception:
        pass
    else:
        raise AssertionError(f"invalid contacts accepted: {_bad_contacts}")

with tempfile.TemporaryDirectory() as tmp:
    st = Store(Path(tmp))
    import auragba.api.caregiver_routes as caregiver_routes  # noqa: E402

    _real_cg_store = caregiver_routes.store
    _real_rel = caregiver_routes.family_relations
    _real_role = caregiver_routes.require_role
    caregiver_routes.store = st
    caregiver_routes.family_relations = lambda p: [{"seniorDeviceId": "dev-contact"}]
    caregiver_routes.require_role = lambda p, role: p
    try:
        saved = caregiver_routes.put_contacts(
            ContactsRequest(contacts=[_contact]),
            principal=SimpleNamespace(account_id="fam-c"),
        )
    finally:
        caregiver_routes.store = _real_cg_store
        caregiver_routes.family_relations = _real_rel
        caregiver_routes.require_role = _real_role
    assert saved[0].phone == "+85290000000"
    _card = st.get_doc("dev-contact", "health_card")
    assert _card["contacts"][0]["name"] == "陳小明"
    assert _card["emergencyContact"]["name"], "the SOS escalation contact must remain"

# --- at-least-once replay: gait / conversation / reminder escalation -----------
with tempfile.TemporaryDirectory() as tmp:
    st = Store(Path(tmp))
    import auragba.api.contract_routes as contract_routes  # noqa: E402

    _real = (contract_routes.store, contract_routes.notify_dispatch)
    _notified: list[tuple] = []
    contract_routes.store = st
    contract_routes.notify_dispatch = lambda *a, **k: _notified.append(a) or []
    try:
        _gait = GaitWindow(
            id="gw-replay", startedAt=1, endedAt=2, steps=10,
            cadence=100.0, cv=0.1, fall=True, fallReason="impact",
        )
        contract_routes.post_gait_window(_gait, "dev-replay")
        contract_routes.post_gait_window(_gait, "dev-replay")
        assert len(st.history("dev-replay", "gait")) == 1, "gait replay must not append"
        assert len(st.history("dev-replay", "gait_falls")) == 1, "fall replay must not append"

        _turn = ConversationTurn(
            id="turn-replay", at=3, role="user", text="我今日好攰", locale="zh-CN",
        )
        contract_routes.post_conversation_memory(_turn, "dev-replay")
        contract_routes.post_conversation_memory(_turn, "dev-replay")
        assert len(st.history("dev-replay", "conversation")) == 1, "conversation replay must not append"
        # A revoked turn keeps its marker, so a late replay cannot re-insert it.
        assert st.delete_by_id("dev-replay", "conversation", _turn.id)
        contract_routes.post_conversation_memory(_turn, "dev-replay")
        assert st.history("dev-replay", "conversation") == [], "revoked turn must stay revoked"

        _esc = ReminderEscalation(id="rem-replay", at=4, locale="zh-CN")
        contract_routes.post_reminder_escalation(_esc, "dev-replay")
        contract_routes.post_reminder_escalation(_esc, "dev-replay")
        assert len(st.history("dev-replay", "reminder_escalations")) == 1, "escalation replay must not append"
        assert len(_notified) == 1, "escalation replay must not page the family twice"
    finally:
        contract_routes.store, contract_routes.notify_dispatch = _real

# --- governance: health-card write/delete, unbind, account delete, economics ---
with tempfile.TemporaryDirectory() as tmp:
    st = Store(Path(tmp))
    import auragba.api.caregiver_routes as caregiver_routes  # noqa: E402

    _real = (caregiver_routes.store, caregiver_routes.family_relations,
             caregiver_routes.require_role, caregiver_routes.audit_log,
             caregiver_routes.auth_store)
    caregiver_routes.store = st
    caregiver_routes.family_relations = lambda p: [{"seniorDeviceId": "dev-hc"}]
    caregiver_routes.require_role = lambda p, role: p
    caregiver_routes.audit_log = SimpleNamespace(append=lambda **kw: None)
    _fake_auth = SimpleNamespace(removed=[], remove_relation=lambda f, d: _fake_auth.removed.append((f, d)) or True)
    caregiver_routes.auth_store = _fake_auth
    try:
        _who = SimpleNamespace(account_id="fam-hc")
        _saved = caregiver_routes.put_health_card(
            HealthCardUpdate(name="陳阿婆", age=79, allergies=["青霉素"]), principal=_who
        )
        assert _saved.name == "陳阿婆" and _saved.age == 79 and _saved.allergies == ["青霉素"]
        assert st.get_doc("dev-hc", "health_card")["name"] == "陳阿婆"
        caregiver_routes.revoke_pairing("dev-hc", principal=_who)
        assert _fake_auth.removed == [("fam-hc", "dev-hc")]
        caregiver_routes.delete_health_card(principal=_who)
        assert st.get_doc("dev-hc", "health_card") is None
        import auragba.api.contract_routes as contract_routes  # noqa: E402

        _real_contract = contract_routes.store
        contract_routes.store = st
        try:
            _blank = contract_routes.get_health_card("dev-hc")
        finally:
            contract_routes.store = _real_contract
        assert _blank.name == "未填写", "a deleted card must not be re-seeded with demo data"
        assert st.get_doc("dev-hc", "health_card") is None

        # Editing contacts/fields after a deletion must start from an EMPTY card,
        # not from the demo identities.
        caregiver_routes.put_contacts(ContactsRequest(contacts=[_contact]), principal=_who)
        _after = st.get_doc("dev-hc", "health_card")
        assert _after["name"] == "未填写" and _after["allergies"] == []
        assert _after["medications"] == [] and _after["emergencyContact"]["phone"] == ""
        assert _after["contacts"][0]["name"] == "陳小明"
        caregiver_routes.put_health_card(HealthCardUpdate(name="李婆婆"), principal=_who)
        _edited = st.get_doc("dev-hc", "health_card")
        assert _edited["name"] == "李婆婆"
        assert _edited["allergies"] == [] and _edited["emergencyContact"]["phone"] == ""
    finally:
        (caregiver_routes.store, caregiver_routes.family_relations,
         caregiver_routes.require_role, caregiver_routes.audit_log,
         caregiver_routes.auth_store) = _real

# --- caregiver notifications: scoped to the senior currently viewed -----------
with tempfile.TemporaryDirectory() as tmp:
    st = Store(Path(tmp))
    import auragba.api.caregiver_routes as caregiver_routes  # noqa: E402

    _real = (caregiver_routes.store, caregiver_routes.family_relations,
             caregiver_routes.require_role)
    caregiver_routes.store = st
    caregiver_routes.family_relations = lambda p: [
        {"seniorDeviceId": "dev-a"}, {"seniorDeviceId": "dev-b"}
    ]
    caregiver_routes.require_role = lambda p, role: p
    try:
        for _id, _dev, _fam in (
            ("n1", "dev-a", "fam-a"),
            ("n2", "dev-b", "fam-a"),
            ("n3", "dev-a", "fam-other"),
        ):
            st.record("__system__", "notification_outbox",
                      {"id": _id, "familyAccountId": _fam,
                       "seniorDeviceId": _dev, "kind": "sos"})
        _ov = caregiver_routes.overview(principal=SimpleNamespace(account_id="fam-a"))
        assert [n["id"] for n in _ov["notifications"]] == ["n1"], (
            "only the currently viewed senior's notifications may be returned"
        )
        _ov_b = caregiver_routes.overview(
            senior_device_id="dev-b", principal=SimpleNamespace(account_id="fam-a")
        )
        assert [n["id"] for n in _ov_b["notifications"]] == ["n2"]
    finally:
        (caregiver_routes.store, caregiver_routes.family_relations,
         caregiver_routes.require_role) = _real

# --- caregiver overview: today's coarse record summary, absent kinds stay absent
with tempfile.TemporaryDirectory() as tmp:
    st = Store(Path(tmp))
    import auragba.api.caregiver_routes as caregiver_routes  # noqa: E402

    _real = (caregiver_routes.store, caregiver_routes.family_relations,
             caregiver_routes.require_role, contract_routes.store)
    caregiver_routes.store = contract_routes.store = st
    caregiver_routes.family_relations = lambda p: [{"seniorDeviceId": "dev-rs"}]
    caregiver_routes.require_role = lambda p, role: p
    _rs_day_ov = day_key(int(time.time() * 1000))
    try:
        contract_routes.post_records_summary(
            RecordSummary(day=_rs_day_ov, kind="med", count=2,
                          lastAt=int(time.time() * 1000)), "dev-rs"
        )
        _ov_rs = caregiver_routes.overview(principal=SimpleNamespace(account_id="fam-rs"))
        assert _ov_rs["recordsToday"]["day"] == _rs_day_ov
        assert _ov_rs["recordsToday"]["kinds"]["med"]["count"] == 2
        assert "alarm" not in _ov_rs["recordsToday"]["kinds"], (
            "unreported kinds must be absent, never 0"
        )
    finally:
        (caregiver_routes.store, caregiver_routes.family_relations,
         caregiver_routes.require_role, contract_routes.store) = _real

# Account deletion erases the account row and the senior's device store.
from auragba.auth_store import AuthStore  # noqa: E402
import auragba.api.auth_routes as auth_routes  # noqa: E402
from fastapi import Response  # noqa: E402

with tempfile.TemporaryDirectory() as tmp:
    _auth = AuthStore(Path(tmp) / "auth.sqlite3")
    _acct = _auth.create_account("senior", "dev-del")
    assert _auth.delete_account(_acct["id"])["role"] == "senior"
    assert _auth.get_account(_acct["id"]) is None
    del _auth
    gc.collect()  # release SQLite handles before TemporaryDirectory cleanup on Windows

    _store = Store(Path(tmp))
    _store.record("dev-del", "telemetry",
                  {"id": "t-del", "name": "checkin", "at": 1, "locale": "zh-CN"})
    _real_del = (auth_routes.store, auth_routes.auth_store, auth_routes.audit_log)
    auth_routes.store = _store
    auth_routes.auth_store = SimpleNamespace(
        delete_account=lambda _id: {"role": "senior", "deviceId": "dev-del"}
    )
    auth_routes.audit_log = SimpleNamespace(append=lambda **kw: None)
    _del_response = Response()
    try:
        auth_routes.delete_me(
            response=_del_response,
            principal=SimpleNamespace(account_id="acct-del", role="senior", device_id="dev-del"),
        )
    finally:
        (auth_routes.store, auth_routes.auth_store, auth_routes.audit_log) = _real_del
    assert "aura_session" in (_del_response.headers.get("set-cookie") or ""), (
        "deleting the account must clear the session cookie"
    )
    assert _store.history("dev-del", "telemetry") == [], "account delete must erase device data"
    del _store
    gc.collect()

# Economics must ignore capture-only rows and rejected samples.
import auragba.api.insight_routes as insight_routes  # noqa: E402

with tempfile.TemporaryDirectory() as tmp:
    _eco = Store(Path(tmp))
    _now_eco = int(time.time() * 1000)
    _eco.record("dev-eco", "screening_results",
                {"at": _now_eco - 3_000, "id": "ok", "riskIndex": 0.6, "riskBand": "elevated"})
    _eco.record("dev-eco", "screening_results",
                {"at": _now_eco - 2_000, "id": "capture", "riskBand": "low",
                 "insufficientStreams": True})
    _eco.record("dev-eco", "screening_results",
                {"at": _now_eco - 1_000, "id": "reject", "riskIndex": 0.9,
                 "riskBand": "elevated", "quality": "reject"})
    _real_eco = insight_routes.store
    insight_routes.store = _eco
    try:
        _ledger = insight_routes.get_economics("dev-eco")
    finally:
        insight_routes.store = _real_eco
    assert _ledger["screeningCount"] == 1, "only usable scored screenings count"

# Community caregiver is paged even when no family is bound.
import auragba.notify as notify_mod  # noqa: E402

_community_calls: list[tuple[str, str]] = []
_real_notify = (notify_mod.auth_store, notify_mod._community)
notify_mod.auth_store = SimpleNamespace(family_accounts_for_device=lambda d: [])
notify_mod._community = lambda device, kind: _community_calls.append((device, kind))
try:
    _notified = notify_mod.dispatch("dev-community", "sos", {})
finally:
    notify_mod.auth_store, notify_mod._community = _real_notify
assert _notified == [] and _community_calls == [("dev-community", "sos")]

# --- interaction trend: latest closed day vs the senior's own median ----------
with tempfile.TemporaryDirectory() as tmp:
    st = Store(Path(tmp))
    now_i = int(time.time() * 1000)

    def _behaviour_doc(device: str, offset: int, value: int) -> None:
        day = time.strftime("%Y-%m-%d", time.localtime((now_i - offset * 86_400_000) / 1000))
        st.set_doc(device, f"behaviour:{day}", {"behaviour": {"interactionCount": value}})

    for _offset, _value in ((4, 6), (3, 6), (2, 6), (1, 2)):
        _behaviour_doc("dev-i", _offset, _value)
    trend = interaction_trend(st, "dev-i", now_ms=now_i)
    assert trend == {
        "today": 2, "baselineMedian": 6.0, "deltaPct": -0.667,
        "decreased": True, "samples": 3,
    }, "latest closed day is compared with the three prior median"
    _behaviour_doc("dev-j", 2, 6)
    _behaviour_doc("dev-j", 1, 6)
    assert interaction_trend(st, "dev-j", now_ms=now_i) is None, "fewer than 3 baseline days -> null"

print("selfcheck: OK")