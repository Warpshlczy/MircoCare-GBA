"""Notification outbox used by push/SMS/voice adapters.

The MVP records durable delivery intents and exposes them to the caregiver UI.
Production providers can consume this outbox without changing domain routes.
"""

from __future__ import annotations

import time
from typing import Any

from .auth import family_relations
from .store import store


def notify_families(device_id: str, kind: str, payload: dict[str, Any]) -> int:
    count = 0
    for family in _families_for(device_id):
        store.record(
            "__system__",
            "notification_outbox",
            {
                "id": f"notif-{int(time.time() * 1000)}-{count}",
                "familyAccountId": family,
                "seniorDeviceId": device_id,
                "kind": kind,
                "payload": payload,
                "status": "pending",
                "createdAt": int(time.time() * 1000),
            },
        )
        count += 1
    return count


def _families_for(device_id: str) -> list[str]:
    accounts = store.get_doc("__system__", "accounts") or {}
    relations = store.get_doc("__system__", "relations") or {}
    return [
        account_id
        for account_id, linked in relations.items()
        if any(row.get("seniorDeviceId") == device_id for row in linked)
        and accounts.get(account_id, {}).get("role") == "family"
    ]
