"""One calendar-day definition for the whole backend.

The device writes `behaviour:<day>` in its local day; the server may run in UTC.
If the two disagree, a day rollup is looked up under a different key and silently
disappears. Every stored day key and report day boundary goes through here.
"""

from __future__ import annotations

import time
from datetime import datetime
from functools import lru_cache
from zoneinfo import ZoneInfo

from .config import settings


@lru_cache(maxsize=1)
def tz() -> ZoneInfo:
    try:
        return ZoneInfo(settings.timezone)
    except Exception:
        return ZoneInfo("Asia/Hong_Kong")


def day_key(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz()).strftime("%Y-%m-%d")


def today_key(ms: int | None = None) -> str:
    stamp = int(time.time() * 1000) if ms is None else int(ms)
    return day_key(stamp)
