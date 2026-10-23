"""Notification outbox used by push/SMS/voice adapters.

The MVP records durable delivery intents and exposes them to the caregiver UI.
Production providers can consume this outbox without changing domain routes.
"""

from __future__ import annotations

import time
from typing import Any

from .auth_store import auth_store
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
    # Accounts/relations live in SQLite (auth_store), not the JSON store; reading
    # the old "__system__" docs here silently produced zero notifications.
    return auth_store.family_accounts_for_device(device_id)
