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
    total_qaly = 0.0
    total_saved = 0.0
    for r in results:
        effect = estimate_economics(float(r.get("riskIndex", 0.0)), str(r.get("riskBand", "low")))
        total_qaly += effect.qalyGained
        total_saved += effect.costSavedPerPatient
    return {
        "screeningCount": len(results),
        "qalyGained": round(total_qaly, 4),
        "costSavedPerPatient": round(total_saved, 2),
        "currency": "HKD",
        "disclaimer": "Illustrative health-economic estimate — not a reimbursement determination.",
    }


@router.get("/audit/screening")
def get_audit(limit: int = 50) -> dict:
    """SaMD audit trail + chain-integrity check (tamper-evident)."""
    return {
        "integrityOk": audit_log.verify(),
        "engineVersion": ENGINE_VERSION,
        "featureSetVersion": FEATURE_SET_VERSION,
        "records": audit_log.records(limit),
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
        "notForDiagnosis": True,
    }