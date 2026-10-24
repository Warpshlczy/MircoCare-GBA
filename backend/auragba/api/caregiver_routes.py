"""Read model for the family-facing dashboard."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..auth import Principal, current_principal, family_relations, require_role
from ..notifications import notify_families
from ..store import store

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
    return {
        "seniorDeviceId": device,
        "healthCard": card,
        "riskTrend": store.history(device, "screening_results")[-30:],
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
