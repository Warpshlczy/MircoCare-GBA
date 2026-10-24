#!/usr/bin/env python3
"""Runnable self-check — `python3 selfcheck.py` (no test framework, no fixtures).

The single check left behind by the ponytail rule: it fails loudly if the
non-trivial logic (features, VAD, metrics, fusion, baseline, audit, privacy)
breaks. Pure/engine-level only — it does not boot a server.
"""

from __future__ import annotations

import io
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
from auragba.audit import AuditLog  # noqa: E402
from auragba.changepoint import detect  # noqa: E402
from auragba.config import settings, validate_runtime  # noqa: E402
from auragba.contract import (  # noqa: E402
    AgentCard, AgentIntentRequest, AgentTool, AgentTurnRequest, BehaviourDaily,
    BehaviourDailyEnvelope, GeofenceEvent, SosEvent, TaskEvent, ToolCall,
)
from auragba.crypto import decrypt_text, encrypt_text  # noqa: E402
from auragba.economics import estimate as economics  # noqa: E402
from auragba.llm.turn import (  # noqa: E402
    from_llm_message, needs_confirm, plan_turn, sanitize_calls,
)
from auragba.llm.errors import LLMUpstreamError  # noqa: E402
from auragba.model import (  # noqa: E402
    late_fusion, load_stream, score_acoustic, score_behavior, score_semantic,
)
from auragba.nlp import analyse_linguistics, coherence  # noqa: E402
from auragba.privacy import pseudonymize, purge, scrub_props  # noqa: E402
from auragba.reports.weekly import DIAGNOSTIC_WORDS, build_weekly_report, render_html  # noqa: E402
from auragba.screening import run_screening  # noqa: E402
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
assert abs(settings.fusion_w_acoustic + settings.fusion_w_semantic - 1.0) < 1e-9
assert settings.fusion3_w_acoustic == 0.15 and settings.fusion3_w_semantic == 0.65
assert settings.fusion3_w_behavior == 0.20
assert abs(settings.fusion3_w_acoustic + settings.fusion3_w_semantic + settings.fusion3_w_behavior - 1.0) < 1e-9

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
        _failed = plan_turn(_turn("帮我记住买药"), "")
    finally:
        turn_mod.logger.setLevel(_previous_level)
    assert _failed.calls == [], "upstream failure must not execute a guessed action"
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
    assert [r["v"] for r in st.history("dev-sql", "metrics")] == [1, 2], "insertion order"
    assert [r["v"] for r in st.history("dev-sql", "metrics", since_ms=1_500)] == [2]
    assert st.history("dev-sql", "gait", since_ms=2_500)[0]["steps"] == 4, "startedAt is the time column"

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
               "trimmedStartMs": 0, "trimmedEndMs": 0})
    st.record("dev-rep", "gait",
              {"id": "g1", "startedAt": now_ms - 86_400_000, "endedAt": now_ms - 86_400_000 + 5_000,
               "steps": 12, "cadence": 60, "cv": 0.08, "fall": False})
    st.record("dev-rep", "gait_falls", {"at": now_ms - 86_400_000, "reason": "impact"})
    st.record("dev-rep", "reminder_escalations",
              {"id": "r1", "at": now_ms - 7_200_000, "locale": "zh-CN", "kind": "med",
               "stage": "notify-caregiver"})
    st.record("dev-rep", "screening_results",
              {"at": now_ms - 86_400_000, "id": "s1", "riskIndex": 0.55, "riskBand": "elevated"})
    st.record("dev-rep", "telemetry",
              {"id": "t1", "name": "daily_checkin", "at": now_ms - 3_600_000, "locale": "zh-CN"})
    _today_key = time.strftime("%Y-%m-%d", time.localtime(now_ms / 1000))
    st.set_doc("dev-rep", f"behaviour:{_today_key}", {
        "behaviour": {"id": "b1", "day": _today_key, "taskConfirmDelayMin": 8.0,
                      "taskTimeoutRate": 0.1, "taskCompletionRate": 0.8, "deferCount": 1,
                      "interactionCount": 5, "gaitCv": 0.06, "fallEvents": 0},
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
    blob = report.model_dump_json() + html_doc
    for word in DIAGNOSTIC_WORDS:
        assert word not in blob, f"diagnostic word leaked into the family report: {word}"

    assert report.claimLevel == "observation" and "辅助观察" in report.disclaimer

    import auragba.reports.weekly as weekly_mod  # noqa: E402

    _real_weekly_settings = weekly_mod.settings
    weekly_mod.settings = replace(settings, regulatory_claim_level="triage_support")
    try:
        _triage = build_weekly_report("dev-rep", st, now=now_ms)
    finally:
        weekly_mod.settings = _real_weekly_settings
    assert _triage.claimLevel == "triage_support" and "辅助分诊" in _triage.disclaimer

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
                "featureSetVersion", "baseline", "changepoints"):
        assert key in dumped, f"wire payload missing {key}"
    payload = result.model_dump_json()
    assert '"semanticStream"' in payload

print("selfcheck: OK")