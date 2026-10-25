#!/usr/bin/env python3
"""Cross-device band aggregate with the k>=20 anonymity gate (DPIA D.3).

    python scripts/aggregate_export.py            # JSON on stdout
    python scripts/aggregate_export.py --k 20

Only bands are read; no device id, timestamp, feature or transcript is emitted.
If the cohort (or any band) is below k, `merge_small_bands` merges it and the
final `assert_k_anonymity` refuses to export.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from auragba.anonymity import assert_k_anonymity, merge_small_bands  # noqa: E402
from auragba.store import store  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description="k-anonymous risk-band export")
    parser.add_argument("--k", type=int, default=20)
    args = parser.parse_args()

    rows = []
    for row in store.all_payloads("screening_results"):
        # Capture-only rows and rejected samples are not risk estimates.
        if row.get("riskBand") not in ("low", "watch", "elevated"):
            continue
        if row.get("insufficientStreams") is True or row.get("quality") == "reject":
            continue
        rows.append({"band": row["riskBand"]})

    merged = merge_small_bands(rows, k=args.k)
    assert_k_anonymity(merged, k=args.k)
    print(json.dumps({
        "k": args.k,
        "total": len(rows),
        "bands": dict(Counter(r["band"] for r in merged)),
        "note": "k-anonymous aggregate; no device-level rows are exported",
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
