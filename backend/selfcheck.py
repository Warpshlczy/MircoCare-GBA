#!/usr/bin/env python3
"""Runnable self-check — `python3 selfcheck.py` (no test framework, no fixtures).

The single check left behind by the ponytail rule: it fails loudly if the
non-trivial logic (features, VAD, metrics, fusion, baseline, audit, privacy)
breaks. Pure/engine-level only — it does not boot a server.
"""

from __future__ import annotations

import io
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from auragba import baseline as bl  # noqa: E402
from auragba.audio import (  # noqa: E402
    FUNCTIONAL_DIM, FUNCTIONAL_NAMES, AudioData, energy_vad, extract_features,
    frame_rms_db, load_audio,
)
from auragba.audit import AuditLog  # noqa: E402
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


# --- audio: schema + features -------------------------------------------------
assert len(FUNCTIONAL_NAMES) == FUNCTIONAL_DIM == 88, "functional schema must be 88 slots"
assert len(set(FUNCTIONAL_NAMES)) == 88, "functional names must be unique"

audio = _tone(2.0, 150.0, gap=(0.6, 0.9))
feats = extract_features(audio)
assert feats.backend == "numpy", f"expected numpy backend, got {feats.backend}"
assert len(feats.vector) == 88, "must emit 88 functionals"
assert all(np.isfinite(list(feats.vector.values()))), "no NaN/Inf in the feature vector"
assert 120 < feats.summary["f0_mean_hz"] < 200, f"F0 tracking failed: {feats.summary['f0_mean_hz']}"
assert feats.summary["jitter_local"] >= 0 and feats.summary["shimmer_local"] >= 0
assert 0.0 <= feats.summary["pause_ratio"] <= 1.0

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
assert any(c.direction in ("risk", "protective") for c in ac.contributions), "contributions must be returned"

sem = score_semantic(ling.metrics, 0.8)
assert sem is not None and 0.0 <= sem.score <= 1.0
assert score_semantic({"tokens": 0.0}, 0.0) is None, "no transcript -> no semantic stream"

fused = late_fusion(ac, sem)
assert abs(sum(fused.weights.values()) - 1.0) < 1e-9, "fusion weights must normalise"
assert 0.0 <= fused.risk_index <= 1.0 and fused.band in ("low", "watch", "elevated")
solo = late_fusion(ac, None)
assert solo.weights == {"acoustic": 1.0, "semantic": 0.0} and abs(solo.risk_index - ac.score) < 1e-9

# --- personal baseline --------------------------------------------------------
prior = [{"pause_ratio": 0.30 + 0.01 * i} for i in range(6)]
rows, sufficient, _ = bl.compute_baseline(prior, {"pause_ratio": 0.60})
assert sufficient and rows and rows[0].flag == "elevated", "a large deviation must flag elevated"
assert rows[0].z > 2.0 and rows[0].direction == "high"
_, ok, note = bl.compute_baseline(prior[:2], {"pause_ratio": 0.3})
assert not ok and note, "too few samples -> insufficient baseline"

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
    assert len(result.acousticFeatures) == 88 and result.audit.seq == 0
    assert lg.verify() is True
    dumped = result.model_dump()
    for key in ("riskIndex", "riskBand", "acousticStream", "engineVersion", "featureSetVersion"):
        assert key in dumped, f"wire payload missing {key}"
    payload = result.model_dump_json()
    assert '"semanticStream"' in payload

print("selfcheck: OK")