"""SaMD-grade audit log — append-only, hash-chained, tamper-evident.

Every screening decision is stamped with engine / feature-set / fusion versions
and the digest of its inputs, then chained: each record embeds the previous
record's hash. `verify()` recomputes the chain to detect edits or deletions.
This is the structured trace a medical-software (SaMD) reviewer needs, and it
stores **no** audio and no raw transcript — only digests and derived numbers.

`ponytail:` a single JSONL file with an in-process lock. Upgrade: append-only
object storage with periodic external anchoring (e.g. WORM bucket / Merkle root).
"""

from __future__ import annotations

import hashlib
import json
import threading
from pathlib import Path
from typing import Any

from .config import settings

_GENESIS = "0" * 64


class AuditLog:
    def __init__(self, path: Path | None = None) -> None:
        self._path = Path(path or (settings.data_dir / "audit.jsonl"))
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _last(self) -> tuple[int, str]:
        if not self._path.exists():
            return -1, _GENESIS
        seq, digest = -1, _GENESIS
        for line in self._path.read_text("utf-8").splitlines():
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
                seq, digest = int(rec["seq"]), str(rec["hash"])
            except (json.JSONDecodeError, KeyError, ValueError):
                continue
        return seq, digest

    @staticmethod
    def _hash(prev_hash: str, payload: dict[str, Any]) -> str:
        blob = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        return hashlib.sha256((prev_hash + blob).encode("utf-8")).hexdigest()

    def append(
        self,
        *,
        kind: str,
        device_id: str,
        engine_version: str,
        feature_set_version: str,
        fusion_version: str,
        input_digest: str,
        output: dict[str, Any],
    ) -> dict[str, Any]:
        """Append one decision record and return `{seq, hash}`."""
        with self._lock:
            seq, prev = self._last()
            payload = {
                "seq": seq + 1,
                "kind": kind,
                "deviceId": device_id,
                "engineVersion": engine_version,
                "featureSetVersion": feature_set_version,
                "fusionVersion": fusion_version,
                "inputDigest": input_digest,
                "output": output,
                "prev": prev,
            }
            rec = dict(payload)
            rec["hash"] = self._hash(prev, payload)
            with self._path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            return {"seq": rec["seq"], "hash": rec["hash"]}

    def records(self, limit: int = 50) -> list[dict[str, Any]]:
        if not self._path.exists():
            return []
        lines = [ln for ln in self._path.read_text("utf-8").splitlines() if ln.strip()]
        return [json.loads(ln) for ln in lines[-limit:]]

    def verify(self) -> bool:
        """Recompute the hash chain; False if any record was altered/removed."""
        prev = _GENESIS
        for line in self._path.read_text("utf-8").splitlines() if self._path.exists() else []:
            if not line.strip():
                continue
            rec = json.loads(line)
            stored = rec.pop("hash")
            if self._hash(prev, rec) != stored or rec.get("prev") != prev:
                return False
            prev = stored
        return True


audit_log = AuditLog()