"""Read model for the family-facing dashboard."""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException

from ..auth import Principal, current_principal, family_relations, require_role
from ..notifications import notify_families
from ..store import store

DAY_MS = 86_400_000


def _day(ms: int) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(ms / 1000))


def interaction_trend(store: object, device_id: str, now_ms: int | None = None) -> dict | None:
    """Today's interaction count vs the senior's own recent median.

    B uploads only CLOSED days, so `today` below means "the latest closed day",
    not necessarily the calendar date. Returns None until there are at least
    three baseline days — no startup-day alarm.
    """
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    latest: float | None = None
    history: list[float] = []
    for offset in range(8):
        document = store.get_doc(device_id, f"behaviour:{_day(now_ms - offset * DAY_MS)}")
        if not document:
            continue
        value = (document.get("behaviour") or {}).get("interactionCount")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if latest is None:
            latest = float(value)
        else:
            history.append(float(value))
    if latest is None or len(history) < 3:
        return None

    ordered = sorted(history)
    mid = len(ordered) // 2
    median = (
        ordered[mid]
        if len(ordered) % 2
        else (ordered[mid - 1] + ordered[mid]) / 2
    )
    delta = round((latest - median) / median, 3) if median > 0 else None
    return {
        "today": int(latest),
        "baselineMedian": median,
        "deltaPct": delta,
        "decreased": bool(median > 0 and latest <= median * 0.5),
        "samples": len(history),
    }

router = APIRouter(prefix="/caregiver", tags=["caregiver"])


def linked_device(principal: Principal, senior_device_id: str | None) -> str:
    """Resolve a family account to one of its bound senior devices."""
    relations = family_relations(require_role(principal, "family"))
    if senior_device_id:
        if not any(r["seniorDeviceId"] == senior_device_id for r in relations):
            raise HTTPException(status_code=403, detail="Senior is not bound to this account")
        return senior_device_id
    if not relations:
        raise HTTPException(status_code=404, detail="No senior device is bound")
    return relations[0]["seniorDeviceId"]


@router.get("/overview")
def overview(
    senior_device_id: str | None = None,
    principal: Principal = Depends(current_principal),
) -> dict:
    device = linked_device(principal, senior_device_id)
    card = store.get_doc(device, "health_card")
    if not card:
        card = {"id": f"hc-{device}", "updatedAt": 0}
    updates = {
        row["id"]: row["status"]
        for row in store.history(device, "sos_updates")
        if row.get("id")
    }
    alerts = []
    for row in store.history(device, "sos")[-20:]:
        item = dict(row)
        if item.get("id") in updates:
            item["status"] = updates[item["id"]]
        alerts.append(item)
    alerts.extend(store.history(device, "gait_falls")[-20:])
    trend = store.history(device, "screening_results")[-30:]
    # Skip rejected captures: an unusable sample cannot speak for the baseline.
    # Rows that predate the flag have no `quality`, so they still count.
    usable = [row for row in trend if row.get("quality") != "reject"]
    return {
        "seniorDeviceId": device,
        "healthCard": card,
        "riskTrend": trend,
        # Top-level shortcut for clients that only render a single badge. Older
        # rows predate the flag, so `None` means "unknown", never "sufficient".
        "sufficient": usable[-1].get("baselineSufficient") if usable else None,
        "interactionTrend": interaction_trend(store, device),
        "screeningSessions": store.history(device, "screening_sessions")[-30:],
        "activityTrend": store.history(device, "gait")[-30:],
        "alerts": alerts[-30:],
        "notifications": [
            row for row in store.history("__system__", "notification_outbox")
            if row.get("familyAccountId") == principal.account_id
        ][-30:],
    }


@router.post("/sos/{sos_id}/ack")
def acknowledge_sos(
    sos_id: str,
    senior_device_id: str,
    principal: Principal = Depends(current_principal),
) -> dict:
    device = linked_device(principal, senior_device_id)
    events = store.history(device, "sos")
    event = next((item for item in events if item.get("id") == sos_id), None)
    if not event:
        raise HTTPException(status_code=404, detail="SOS event not found")
    event["status"] = "resolved"
    store.record(device, "sos_updates", {"id": sos_id, "status": "resolved", "by": principal.account_id})
    return {"id": sos_id, "status": "resolved"}
