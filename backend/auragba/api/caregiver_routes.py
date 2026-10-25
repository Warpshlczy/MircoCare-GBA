"""Read model for the family-facing dashboard."""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException

from ..audit import audit_log
from ..auth import Principal, current_principal, family_relations, require_role
from ..auth_store import auth_store
from ..config import ENGINE_VERSION, FEATURE_SET_VERSION, FUSION_VERSION
from ..contract import Contact, ContactsRequest, HealthCard, HealthCardUpdate
from ..privacy import input_digest
from ..store import Store, store
from ..timeutil import day_key

DAY_MS = 86_400_000
# Kinds A writes locally and reports through `POST /records/summary` (issue #7).
_RECORD_KINDS = ("med", "alarm", "measure", "card")


def _day(ms: int) -> str:
    return day_key(ms)


def records_today(store: Store, device_id: str, now_ms: int | None = None) -> dict:
    """Today's coarse on-device record counts for the family screen.

    Only kinds the device actually reported appear: an absent kind means "not
    reported", never 0 — same rule as the behaviour rollup. No medication name,
    note or transcript is stored on this side.
    """
    day = _day(int(time.time() * 1000) if now_ms is None else now_ms)
    kinds: dict[str, dict] = {}
    for kind in _RECORD_KINDS:
        document = store.get_doc(device_id, f"records_summary:{day}:{kind}")
        if not document:
            continue
        kinds[kind] = {"count": document.get("count"), "lastAt": document.get("lastAt")}
    return {"day": day, "kinds": kinds}


def interaction_trend(store: Store, device_id: str, now_ms: int | None = None) -> dict | None:
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


def _seed_card(device: str) -> dict:
    """Seed a missing health card.

    A family deletion is sticky: after `DELETE /caregiver/health-card`, editing
    contacts or another field must start from an empty card, never from the demo
    identities (a fake name/phone on the caregiver screen is worse than a blank).
    """
    from .contract_routes import _DEMO_CARD, _blank_card

    if store.get_doc(device, "health_card_deleted") is not None:
        return _blank_card(device)
    return {**_DEMO_CARD, "id": f"hc-{device}"}


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
        # "今日记录咗未" without shipping the readable records: coarse counts only.
        "recordsToday": records_today(store, device),
        "screeningSessions": store.history(device, "screening_sessions")[-30:],
        "activityTrend": store.history(device, "gait")[-30:],
        "alerts": alerts[-30:],
        # Also scope to the senior currently being viewed: after
        # `DELETE /caregiver/pairing/{device}` this account must stop seeing that
        # senior's queued notifications even if it still has another pairing.
        "notifications": [
            row for row in store.history("__system__", "notification_outbox")
            if row.get("familyAccountId") == principal.account_id
            and row.get("seniorDeviceId") == device
        ][-30:],
    }


@router.post("/contacts", response_model=list[Contact])
def put_contacts(
    req: ContactsRequest,
    senior_device_id: str | None = None,
    principal: Principal = Depends(current_principal),
) -> list[Contact]:
    """Replace the callable contact list for one bound senior (family only).

    The senior app must not edit this list: deleting one's own emergency contacts
    is not recoverable on the device. `emergencyContact` (the SOS escalation
    chain) is deliberately left untouched — daily calls and emergency paging are
    different jobs.
    """
    device = linked_device(principal, senior_device_id)
    now = int(time.time() * 1000)
    card = store.get_doc(device, "health_card")
    if not card:
        card = {
            **_seed_card(device),
            "updatedAt": now,
        }
    card["contacts"] = [c.model_dump() for c in req.contacts]
    card["updatedAt"] = now
    store.set_doc(device, "health_card", card)
    return req.contacts


@router.put("/health-card", response_model=HealthCard)
def put_health_card(
    req: HealthCardUpdate,
    senior_device_id: str | None = None,
    principal: Principal = Depends(current_principal),
) -> HealthCard:
    """Family edits the health card (name/age/allergies/meds/SOS contact).

    `contacts` is deliberately not part of this payload: the callable list has
    its own endpoint, and SOS escalation must stay independent of it.
    """
    device = linked_device(principal, senior_device_id)
    now = int(time.time() * 1000)
    card = store.get_doc(device, "health_card")
    if not card:
        card = {
            **_seed_card(device),
            "updatedAt": now,
        }
    card.update(req.model_dump(exclude_unset=True, exclude_none=True))
    card["updatedAt"] = now
    store.set_doc(device, "health_card", card)
    store.delete_doc(device, "health_card_deleted")
    return HealthCard(**card)


@router.delete("/health-card", status_code=204)
def delete_health_card(
    senior_device_id: str | None = None,
    principal: Principal = Depends(current_principal),
) -> None:
    """Erase the family-entered health card (and its callable contacts)."""
    device = linked_device(principal, senior_device_id)
    deleted = store.delete_doc(device, "health_card")
    store.set_doc(device, "health_card_deleted", {"at": int(time.time() * 1000)})
    audit_log.append(
        kind="health_card_delete",
        device_id=device,
        engine_version=ENGINE_VERSION,
        feature_set_version=FEATURE_SET_VERSION,
        fusion_version=FUSION_VERSION,
        input_digest=input_digest(device, "health-card"),
        output={"deleted": deleted},
    )


@router.delete("/pairing/{senior_device_id}", status_code=204)
def revoke_pairing(
    senior_device_id: str,
    principal: Principal = Depends(current_principal),
) -> None:
    """Revoke one family account's access to one senior device."""
    device = linked_device(principal, senior_device_id)
    if not auth_store.remove_relation(principal.account_id, device):
        raise HTTPException(status_code=404, detail="pairing not found")
    audit_log.append(
        kind="pairing_revoke",
        device_id=device,
        engine_version=ENGINE_VERSION,
        feature_set_version=FEATURE_SET_VERSION,
        fusion_version=FUSION_VERSION,
        input_digest=input_digest(principal.account_id, device),
        output={"revoked": True},
    )


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
