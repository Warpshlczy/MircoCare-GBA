"""Pseudonymous persistence — one JSON file per (already-hashed) DeviceId.

`ponytail:` a file-backed store, not a database: it keeps the demo dependency-free
and readable. It is NOT concurrency-hardened beyond an in-process lock and will
not scale past a handful of devices. Upgrade: SQLite (stdlib) or Postgres behind
this same four-method interface — callers never see the storage choice.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from .config import settings


class Store:
    def __init__(self, data_dir: Path | None = None) -> None:
        self._dir = Path(data_dir or settings.data_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _path(self, device_id: str) -> Path:
        # device_id is already pseudonymised upstream; strip any path separators.
        safe = "".join(ch for ch in device_id if ch.isalnum() or ch in "-_") or "anon"
        return self._dir / f"{safe}.json"

    def _load(self, device_id: str) -> dict[str, Any]:
        p = self._path(device_id)
        if not p.exists():
            return {"kinds": {}, "docs": {}}
        try:
            return json.loads(p.read_text("utf-8"))
        except (json.JSONDecodeError, OSError):
            return {"kinds": {}, "docs": {}}

    def _save(self, device_id: str, doc: dict[str, Any]) -> None:
        self._path(device_id).write_text(json.dumps(doc, ensure_ascii=False), "utf-8")

    def record(self, device_id: str, kind: str, obj: dict[str, Any]) -> None:
        """Append a derived-feature / event record under a stream name."""
        with self._lock:
            doc = self._load(device_id)
            doc["kinds"].setdefault(kind, []).append(obj)
            self._save(device_id, doc)

    def history(self, device_id: str, kind: str, since_ms: int | None = None) -> list[dict[str, Any]]:
        with self._lock:
            rows = list(self._load(device_id)["kinds"].get(kind, []))
        if since_ms is None:
            return rows
        key = "at" if rows and "at" in rows[0] else "startedAt"
        return [r for r in rows if r.get(key, 0) >= since_ms]

    def get_doc(self, device_id: str, key: str) -> Any:
        with self._lock:
            return self._load(device_id)["docs"].get(key)

    def set_doc(self, device_id: str, key: str, value: Any) -> None:
        with self._lock:
            doc = self._load(device_id)
            doc["docs"][key] = value
            self._save(device_id, doc)


store = Store()