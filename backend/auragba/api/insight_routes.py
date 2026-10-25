"""Insight endpoints — the multimodal screening engine's own surface.

These are NOT in the frontend's nine-endpoint contract; they expose the engine
(audio ingestion, personal baseline, STEMB ledger, SaMD audit) for demos,
caregivers and reviewers.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from ..audit import audit_log
from ..config import ENGINE_VERSION, FEATURE_SET_VERSION, settings
from ..contract import BaselineReport, ChangePoint, Locale, MetricZScore, ScreeningResult
from ..privacy import device_id
from ..store import store
from ..screening import run_screening
from ..audio.io import load_audio
from ..nlp.asr import transcribe as asr_transcribe
from .. import baseline as baseline_mod

router = APIRouter(tags=["insight"])

_MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # ponytail: fixed cap; stream to disk for large batches


@router.post("/screening/analyze", response_model=ScreeningResult)
async def analyze_screening(
    file: UploadFile = File(..., description="WAV/FLAC speech sample"),
    # Literal-typed form field: an unsupported locale is a 422, never a 500 in
    # response validation (`ScreeningResult.locale` is the same Literal).
    locale: Locale = Form("zh-CN"),
    question: str = Form("", description="the digital-human prompt the senior answered"),
    dev: str = Depends(device_id),
) -> ScreeningResult:
    """Full pipeline: audio -> features -> ASR -> metrics -> fusion -> audit.

    Raw audio is extract-and-burned: it is zeroed as soon as features exist and
    is never written to disk or returned.
    """
    # Reject oversized uploads before `read()` buffers them in memory.
    if file.size is not None and file.size > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="audio exceeds 25 MB")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=422, detail="empty audio upload")
    if len(data) > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="audio exceeds 25 MB")
    return run_screening(
        data=data,
        filename=file.filename or "",
        locale=locale,
        device_id=dev,
        question=question,
        store=store,
        audit=audit_log,
    )


@router.post("/asr/transcribe")
async def transcribe_utterance(
    file: UploadFile = File(..., description="WAV/Opus speech sample"),
    locale: Locale = Form("zh-CN"),
    _dev: str = Depends(device_id),  # enforces the X-Device-Id contract; value unused
) -> dict:
    """Local-only speech-to-text for the digital human's push-to-talk button.

    The Android WebView has no Web Speech recognizer and the handset's system
    engine is cloud-backed, so the app records a clip and posts it here. Audio is
    decoded in memory, transcribed on-box and never persisted (same
    extract-and-burn rule as `/screening/analyze`). Returns `available=False`
    instead of raising when no local Whisper engine is installed.
    """
    if file.size is not None and file.size > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="audio exceeds 25 MB")
    data = await file.read()
    if not data:
        raise HTTPException(status_code=422, detail="empty audio upload")
    if len(data) > _MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="audio exceeds 25 MB")
    try:
        audio = load_audio(data, file.filename or "")
    except Exception:
        raise HTTPException(status_code=422, detail="unsupported audio format")
    if audio.duration_s < 0.2:  # a tap, not an utterance
        return {"text": "", "confidence": 0.0, "engine": "none", "available": True, "durationMs": 0}
    result = asr_transcribe(audio, locale)
    return {
        "text": result.text,
        "confidence": result.confidence,
        "engine": result.engine,
        "available": result.available,
        "durationMs": round(audio.duration_ms),
    }


@router.get("/baseline/me", response_model=BaselineReport)
def get_baseline(dev: str = Depends(device_id)) -> BaselineReport:
    """Personal baseline report: robust Z plus trend and change points."""
    now_ms = int(time.time() * 1000)
    since = now_ms - max(settings.baseline_days, settings.trend_days) * 86_400_000
    history = store.history(dev, "screening_metrics", since_ms=since)
    if not history:
        return BaselineReport(
            deviceId=dev, windowDays=settings.baseline_days, samples=0,
            sufficient=False, metrics=[], changepoints=[], note="no screening history yet",
        )
    today = history[-1].get("metrics", {})
    prior = history[:-1]
    outcome = baseline_mod.compute_baseline(
        [h.get("metrics", {}) for h in prior],
        today,
        at_ms=[int(h.get("at", 0)) for h in prior],
        z_window_days=settings.baseline_days,
    )
    return BaselineReport(
        deviceId=dev,
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


@router.get("/economics/me")
def get_economics(dev: str = Depends(device_id)) -> dict:
    """Aggregate STEMB ledger across this device's screenings (illustrative)."""
    from ..economics import estimate as estimate_economics

    results = store.history(dev, "screening_results")
    # Capture-only rows (A's `/screening/sessions`) have no riskIndex and reject
    # rows are unusable; counting them as "a screening at risk 0" inflates the
    # ledger with an estimate the engine never made.
    usable = [
        row for row in results
        if row.get("riskIndex") is not None
        and row.get("quality") != "reject"
        and row.get("insufficientStreams") is not True
    ]
    total_qaly = 0.0
    total_saved = 0.0
    for r in usable:
        effect = estimate_economics(float(r["riskIndex"]), str(r.get("riskBand", "low")))
        total_qaly += effect.qalyGained
        total_saved += effect.costSavedPerPatient
    return {
        "screeningCount": len(usable),
        "qalyGained": round(total_qaly, 4),
        "costSavedPerPatient": round(total_saved, 2),
        "currency": "HKD",
        "disclaimer": "Illustrative health-economic estimate — not a reimbursement determination.",
    }


@router.get("/audit/screening")
def get_audit(limit: int = 50, dev: str = Depends(device_id)) -> dict:
    """SaMD audit trail + chain-integrity check (tamper-evident).

    Requires a signed session and returns only this device's records: audit rows
    carry pseudonymous device ids and screening metadata for every user, which
    must not be enumerable cross-device.
    """
    limit = max(1, min(int(limit), 200))
    return {
        "integrityOk": audit_log.verify(),
        "engineVersion": ENGINE_VERSION,
        "featureSetVersion": FEATURE_SET_VERSION,
        "records": audit_log.records(limit, device_id=dev),
    }


@router.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "engineVersion": ENGINE_VERSION,
        "featureSetVersion": FEATURE_SET_VERSION,
        "privacyMode": settings.privacy_mode,
        "llmIntegration": "enabled" if settings.llm_available else "disabled-fallback",
        "weather": "open-meteo" if settings.weather_enabled else "disabled",
        # null = no deployment-prevalence assumption; clients must not print PPV.
        "deployPrevalence": settings.deploy_prevalence,
        "notForDiagnosis": True,
    }