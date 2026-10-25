"""Screening orchestrator — audio in, auditable risk estimate out.

    audio -> VAD trim -> (acoustic features) -> ASR -> linguistic metrics
          -> semantic coherence -> dual-stream scores -> late fusion
          -> personal-baseline Z -> health-economics -> SaMD audit record

The raw audio is discarded ("提取即焚") as soon as the derived features exist.
Only derived numbers, a pseudonymous DeviceId and a hash-chained audit entry
survive. Never raises on bad/empty audio — it degrades to an acoustic-only,
low-confidence result.
"""

from __future__ import annotations

import time
import uuid

import numpy as np

from . import baseline as baseline_mod
from .audio import AudioData, extract_features, frame_rms_db, energy_vad, load_audio
from .audit import AuditLog, audit_log
from .config import ENGINE_VERSION, FEATURE_SET_VERSION, FUSION_VERSION, settings
from .contract import AuditRef, BaselineReport, ChangePoint, MetricZScore, ScreeningResult, ScreeningSession
from .economics import estimate as estimate_economics
from .model import acoustic as model_acoustic
from .model import behavior as model_behavior
from .model import late_fusion, score_acoustic, score_semantic
from .model import semantic as model_semantic
from .nlp import analyse_linguistics, coherence, transcribe
from .privacy import input_digest, purge
from .store import Store, store as default_store


def _flat_metrics(summary: dict[str, float], ling: dict[str, float], coh: float) -> dict[str, float]:
    """The single flat metric bag baseline tracking and storage both consume."""
    flat = {k: float(v) for k, v in summary.items()}
    for key in ("ttr", "mattr", "sentence_len_variance", "filler_ratio", "mean_sentence_len"):
        flat[key] = float(ling.get(key, 0.0))
    flat["coherence"] = float(coh)
    return flat


def _baseline_report(device_id: str, flat: dict[str, float], store: Store) -> BaselineReport:
    # Z uses the narrow baseline window; trend/CUSUM look back further so a slow
    # drift is visible even when no single day looks abnormal.
    now_ms = int(time.time() * 1000)
    since = now_ms - max(settings.baseline_days, settings.trend_days) * 86_400_000
    history = store.history(device_id, "screening_metrics", since_ms=since)
    outcome = baseline_mod.compute_baseline(
        [h.get("metrics", {}) for h in history],
        flat,
        at_ms=[int(h.get("at", 0)) for h in history],
        z_window_days=settings.baseline_days,
    )
    return BaselineReport(
        deviceId=device_id,
        windowDays=settings.baseline_days,
        samples=outcome.samples,
        sufficient=outcome.sufficient,
        metrics=[
            MetricZScore(
                name=r.name, value=r.value, baselineMean=r.mean, baselineStd=r.std,
                baselineMedian=r.median, baselineScale=r.scale,
                z=r.z, direction=r.direction, flag=r.flag,
                trend=r.trend, changepointAt=r.changepoint_at, sustained=r.sustained,
            )
            for r in outcome.rows
        ],
        changepoints=[ChangePoint(**p) for p in outcome.changepoints],
        note=outcome.note,
    )


def _capture_quality(
    frames_db: np.ndarray, speech_ratio: float, duration_ms: float
) -> tuple[str, float | None]:
    """Grade one capture with the same formula as A's `signal.ts#qualityOf`.

    SNR is ``P90 - P10`` over the UNTRIMMED frame energies: trimming would delete
    the noise floor the measure depends on. ``speech_ratio`` is the VAD ratio of
    the TRIMMED clip, matching `vad.ts`; the two sides must agree or the weekly
    fair/reject counts would describe different samples.
    """
    snr = float(np.percentile(frames_db, 90) - np.percentile(frames_db, 10))
    if speech_ratio < 0.25 or snr < 15.0 or duration_ms < 8_000:
        return "reject", snr
    if speech_ratio >= 0.40 and snr >= 20.0:
        return "good", snr
    return "fair", snr


def run_screening(
    *,
    data: bytes,
    filename: str,
    locale: str,
    device_id: str,
    question: str = "",
    store: Store | None = None,
    audit: AuditLog | None = None,
) -> ScreeningResult:
    store = store or default_store
    audit = audit or audit_log
    started = time.time()
    result_id = f"scr-{int(started * 1000)}-{uuid.uuid4().hex[:6]}"

    # extract-and-burn: decode from the SAME mutable buffer that `purge` zeroes.
    # The caller's immutable `bytes` cannot be overwritten in Python, so this is
    # best-effort (no copy is left holding the waveform).
    buffer = bytearray(data) if settings.burn_audio else None
    audio: AudioData = load_audio(buffer if buffer is not None else data, filename)
    frames_db = frame_rms_db(audio.samples, audio.sample_rate)
    vad = energy_vad(frames_db)
    hop_s = 0.010
    trim_start = int(vad.segments[0][0] * hop_s * audio.sample_rate) if vad.segments else 0
    trim_end = int(vad.segments[-1][1] * hop_s * audio.sample_rate) if vad.segments else audio.samples.size
    trimmed = audio.samples[trim_start:trim_end] if trim_end > trim_start else audio.samples
    trimmed_audio = AudioData(trimmed, audio.sample_rate, trimmed.size / audio.sample_rate, audio.source)

    features = extract_features(trimmed_audio)
    # Quality parity with the device: SNR from the untrimmed energy envelope,
    # speech ratio from the trimmed clip (A's `vad.ts#qualityOf` uses the same pair).
    trimmed_vad = energy_vad(frame_rms_db(trimmed_audio.samples, trimmed_audio.sample_rate))
    quality, snr_db = _capture_quality(frames_db, trimmed_vad.ratio, audio.duration_ms)

    asr = transcribe(trimmed_audio, locale)
    ling = analyse_linguistics(asr.text)
    coh = coherence(question, asr.text)

    acoustic = score_acoustic(features.summary, features.vector)
    semantic = score_semantic(ling.metrics, coh)
    behavior = model_behavior.load_stream(
        store, device_id, now_ms=int(started * 1000), days=settings.baseline_days
    )
    fusion = late_fusion(acoustic, semantic, behavior)

    flat = _flat_metrics(features.summary, ling.metrics, coh)
    baseline = _baseline_report(device_id, flat, store)
    economics = (
        estimate_economics(fusion.risk_index, fusion.band)
        if fusion.band != "low" and quality != "reject"
        else None
    )
    audio_discarded = purge(buffer)

    result = ScreeningResult(
        id=result_id,
        at=int(started * 1000),
        locale=locale,  # type: ignore[arg-type]
        privacyMode=settings.privacy_mode,
        audioDiscarded=audio_discarded,
        durationMs=audio.duration_ms,
        speechRatio=float(trimmed_vad.ratio),
        acousticFeatures=features.vector,
        acousticSummary=features.summary,
        asr={
            "engine": asr.engine, "available": asr.available, "language": asr.language,
            "textLength": len(asr.text), "confidence": asr.confidence, "note": asr.note,
            # NB: the transcript itself is NOT stored — only its derived metrics.
        },
        linguisticMetrics=ling.metrics,
        coherence=coh,
        acousticStream=acoustic,
        semanticStream=semantic,
        behaviorStream=behavior,
        riskIndex=fusion.risk_index,
        riskBand=fusion.band,  # type: ignore[arg-type]
        fusionWeights=fusion.weights,
        insufficientStreams=fusion.insufficient_streams,
        quality=quality,  # type: ignore[arg-type]
        snrDb=None if snr_db is None else round(snr_db, 1),
        baseline=baseline,
        changepoints=baseline.changepoints,
        economics=economics,
        engineVersion=ENGINE_VERSION,
        featureSetVersion=FEATURE_SET_VERSION,
        notForDiagnosis=True,
        audit={"seq": -1, "hash": ""},
    )

    ref = audit.append(
        kind="screening",
        device_id=device_id,
        engine_version=ENGINE_VERSION,
        feature_set_version=FEATURE_SET_VERSION,
        fusion_version=FUSION_VERSION,
        input_digest=input_digest(device_id, str(result.at), f"{audio.duration_ms:.0f}"),
        output={
            "riskIndex": fusion.risk_index,
            "riskBand": fusion.band,
            "weights": fusion.weights,
            "acoustic": acoustic.score,
            "semantic": None if semantic is None else semantic.score,
            "behavior": None if behavior is None else behavior.score,
            "insufficientStreams": fusion.insufficient_streams,
            "baselineSufficient": baseline.sufficient,
            "quality": quality,
            "snrDb": result.snrDb,
            # 模型来源指纹：换模型后历史分数仍可追溯是哪个文件打的
            "models": {
                "acoustic": acoustic.model,
                "semantic": None if semantic is None else semantic.model,
                "behavior": None if behavior is None else behavior.model,
                "acousticFile": model_acoustic.model_fingerprint(),
                "semanticFile": model_semantic.model_fingerprint(),
            },
        },
    )
    result.audit = AuditRef(seq=ref["seq"], hash=ref["hash"])

    if quality != "reject":
        # A rejected capture is reported but never poisons the personal baseline.
        store.record(device_id, "screening_metrics", {"at": result.at, "metrics": flat})
    store.record(
        device_id,
        "screening_results",
        {
            "at": result.at, "id": result.id, "riskIndex": fusion.risk_index,
            "riskBand": fusion.band,
            # Data-quality flags only (booleans). The family dashboard needs them
            # to show "not enough data" instead of a misleading low risk.
            "insufficientStreams": fusion.insufficient_streams,
            "baselineSufficient": baseline.sufficient,
            "quality": quality, "snrDb": result.snrDb,
            "usedInBaseline": quality != "reject",
        },
    )
    return result


def ingest_session(session: ScreeningSession, device_id: str, store: Store | None = None) -> None:
    """Vector-only ingestion for the frontend contract endpoint.

    Accepts pre-computed on-device features (no audio ever arrives) and feeds the
    same personal-baseline store.
    """
    store = store or default_store
    marker = f"screening_session:{session.id}"
    if store.get_doc(device_id, marker) is not None:
        # Outbox is at-least-once: a replayed session must not add a second
        # baseline sample (or a second report row).
        return
    flat = {k: float(v) for k, v in session.features.items()}
    flat["speech_ratio"] = float(session.speechRatio)
    # Sufficiency is decided by the PRIOR samples, so compute before storing this
    # one (same order as `run_screening`).
    baseline = _baseline_report(device_id, flat, store)
    if session.quality != "reject":
        # Only reject samples are excluded from the personal baseline; `fair` is
        # kept because a quiet senior at home rarely reaches "good".
        store.record(device_id, "screening_metrics", {"at": session.startedAt, "metrics": flat})
    store.record(
        device_id,
        "screening_sessions",
        {
            "at": session.startedAt, "id": session.id, "durationMs": session.durationMs,
            "speechRatio": session.speechRatio, "trimmedStartMs": session.trimmedStartMs,
            "trimmedEndMs": session.trimmedEndMs,
            "quality": session.quality, "snrDb": session.snrDb,
            "usedInBaseline": session.quality != "reject",
        },
    )
    # A's path carries no biomarkers/transcript, so no risk score can be computed.
    # Write a capture-only result row instead: the family dashboard gets a real
    # timeline and `sufficient` flag, and the badge stays "样本不足" because
    # `insufficientStreams` is true. `riskBand="low"` is the documented
    # single/missing-stream degradation, not an estimate; no `riskIndex` is made up.
    store.record(
        device_id,
        "screening_results",
        {
            "at": session.startedAt, "id": session.id, "source": "screening_session",
            "riskBand": "low", "insufficientStreams": True,
            "quality": session.quality, "snrDb": session.snrDb,
            "usedInBaseline": session.quality != "reject",
            "baselineSufficient": baseline.sufficient,
            "notForDiagnosis": True,
        },
    )
    store.set_doc(
        device_id,
        marker,
        {"at": session.startedAt, "quality": session.quality, "usedInBaseline": session.quality != "reject"},
    )