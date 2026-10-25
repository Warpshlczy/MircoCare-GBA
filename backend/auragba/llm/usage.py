"""Per-device daily LLM quota.

The counter lives in the same pseudonymous JSON store as the rest of the
device's derived data. A quota of 0 means unlimited (useful for local demos).
"""

from __future__ import annotations

import threading

from ..config import settings
from ..store import store
from ..timeutil import today_key
from .errors import LLMQuotaExceeded

_LOCK = threading.Lock()
_USAGE_KEY = "llm_usage"


def reserve(device_id: str) -> int:
    """Reserve one LLM call for today; returns the remaining quota."""
    quota = settings.llm_daily_quota
    if quota <= 0:
        return 0

    today = today_key()
    with _LOCK:
        doc = store.get_doc(device_id, _USAGE_KEY) or {}
        count = int(doc.get("count", 0)) if doc.get("date") == today else 0
        if count >= quota:
            raise LLMQuotaExceeded("daily LLM quota exceeded")
        store.set_doc(device_id, _USAGE_KEY, {"date": today, "count": count + 1})
    return max(0, quota - count - 1)
