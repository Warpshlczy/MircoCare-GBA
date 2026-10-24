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

    # extract-and-burn: hold audio only in a mutable buffer we can zero out.
    buffer = bytearray(data) if settings.burn_audio else None
    audio: AudioData = load_audio(data, filename)
    frames_db = frame_rms_db(audio.samples, audio.sample_rate)
    vad = energy_vad(frames_db)
    hop_s = 0.010
    trim_start = int(vad.segments[0][0] * hop_s * audio.sample_rate) if vad.segments else 0
    trim_end = int(vad.segments[-1][1] * hop_s * audio.sample_rate) if vad.segments else audio.samples.size
    trimmed = audio.samples[trim_start:trim_end] if trim_end > trim_start else audio.samples
    trimmed_audio = AudioData(trimmed, audio.sample_rate, trimmed.size / audio.sample_rate, audio.source)

    features = extract_features(trimmed_audio)

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
    economics = estimate_economics(fusion.risk_index, fusion.band) if fusion.band != "low" else None
    audio_discarded = purge(buffer)

    result = ScreeningResult(
        id=result_id,
        at=int(started * 1000),
        locale=locale,  # type: ignore[arg-type]
        privacyMode=settings.privacy_mode,
        audioDiscarded=audio_discarded,
        durationMs=audio.duration_ms,
        speechRatio=float(vad.ratio),
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
        },
    )
    return result


def ingest_session(session: ScreeningSession, device_id: str, store: Store | None = None) -> None:
    """Vector-only ingestion for the frontend contract endpoint.

    Accepts pre-computed on-device features (no audio ever arrives) and feeds the
    same personal-baseline store.
    """
    store = store or default_store
    flat = {k: float(v) for k, v in session.features.items()}
    flat["speech_ratio"] = float(session.speechRatio)
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