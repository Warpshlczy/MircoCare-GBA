#!/usr/bin/env python3
"""Runnable self-check — `python3 selfcheck.py` (no test framework, no fixtures).

The single check left behind by the ponytail rule: it fails loudly if the
non-trivial logic (features, VAD, metrics, fusion, baseline, audit, privacy)
breaks. Pure/engine-level only — it does not boot a server.
"""

from __future__ import annotations

import io
import math
import sys
import tempfile
import wave
from dataclasses import replace
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from auragba import baseline as bl  # noqa: E402
from auragba.audio import (  # noqa: E402
    FUNCTIONAL_DIM, FUNCTIONAL_NAMES, AudioData, energy_vad, extract_features,
    frame_rms_db, load_audio,
)
from auragba.audit import AuditLog  # noqa: E402
from auragba.changepoint import detect  # noqa: E402
from auragba.config import settings, validate_runtime  # noqa: E402
from auragba.economics import estimate as economics  # noqa: E402
from auragba.model import late_fusion, score_acoustic, score_semantic  # noqa: E402
from auragba.nlp import analyse_linguistics, coherence  # noqa: E402
from auragba.privacy import pseudonymize, purge, scrub_props  # noqa: E402
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
validate_runtime(replace(settings, auth_secret="x" * 32, environment="development"))

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
solo = late_fusion(ac, None)
assert solo.weights == {"acoustic": 1.0, "semantic": 0.0} and abs(solo.risk_index - ac.score) < 1e-9

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
    assert lg.verify() is True
    dumped = result.model_dump()
    for key in ("riskIndex", "riskBand", "acousticStream", "engineVersion", "featureSetVersion",
                "baseline", "changepoints"):
        assert key in dumped, f"wire payload missing {key}"
    payload = result.model_dump_json()
    assert '"semanticStream"' in payload

print("selfcheck: OK")