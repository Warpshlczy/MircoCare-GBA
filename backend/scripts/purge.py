#!/usr/bin/env python3
"""One-shot conversation TTL purge — run daily by cron / Task Scheduler.

    python scripts/purge.py            # delete turns older than the TTL
    python scripts/purge.py --dry-run  # report how many would be deleted

Retention is `AURA_CONVERSATION_TTL_DAYS` (default 90). Only the `conversation`
stream is purged; screening metrics and the hash-chained audit log are kept (the
audit log stores digests, never transcripts).
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from auragba.config import settings  # noqa: E402
from auragba.store import store  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="Purge expired conversation turns")
    parser.add_argument("--dry-run", action="store_true", help="count without deleting")
    args = parser.parse_args()

    cutoff = int((time.time() - settings.conversation_ttl_days * 86_400) * 1000)
    if args.dry_run:
        expired = store.count_before("conversation", cutoff)
        print(f"dry-run: {expired} conversation turns older than "
              f"{settings.conversation_ttl_days} days")
        return 0

    removed = store.delete_before("conversation", cutoff)
    print(f"purged {removed} conversation turns older than "
          f"{settings.conversation_ttl_days} days")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
