"""Notification fan-out — outbox rows first, then an optional demo webhook.

The MVP has no push/SMS provider. This module is the single seam every route
(SOS, reminder escalation, weekly report) calls so delivery is consistent and
observable:

1. find the family accounts bound to this senior (SQLite, not the JSON store);
2. append one `notification_outbox` row per recipient (durable, caregiver UI
   reads it);
3. log a coarse "已通知家属 N 人" line — never the payload, never free text;
4. if ``AURA_NOTIFY_WEBHOOK`` is set, POST a coarse envelope to it.

`ponytail:` webhook + logs only. Production swaps in FCM/APNs/Twilio behind the
same ``dispatch`` signature; nothing else in the backend changes.
"""

from __future__ import annotations

import logging
from typing import Any

from .auth_store import auth_store
from .config import settings
from .notifications import notify_families

logger = logging.getLogger("auragba.notify")


def dispatch(device_id: str, kind: str, payload: dict[str, Any]) -> list[str]:
    """-> family account ids the event was queued for (possibly empty)."""
    families = auth_store.family_accounts_for_device(device_id)
    if not families:
        logger.info("notify %s: no family bound to %s", kind, device_id)
        return []

    notify_families(device_id, kind, payload)  # durable outbox rows
    logger.info("已通知家属 %d 人（kind=%s, device=%s）", len(families), kind, device_id)
    _webhook(device_id, kind, len(families))
    return families


def _webhook(device_id: str, kind: str, recipients: int) -> None:
    url = settings.notify_webhook
    if not url:
        return
    try:
        import httpx

        httpx.post(
            url,
            json={"kind": kind, "deviceId": device_id, "recipients": recipients},
            timeout=3.0,
        )
    except Exception as exc:  # missing httpx, DNS, timeout — never block the SOS
        logger.warning("notify webhook failed (kind=%s): %s", kind, type(exc).__name__)
