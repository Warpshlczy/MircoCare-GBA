"""Pseudonymous persistence — one SQLite database for all devices.

`ponytail:` a single SQLite file instead of a database server: the demo needs
durable rows and time-window queries without another service to run. The four
methods (``record`` / ``history`` / ``get_doc`` / ``set_doc``) keep their exact
signatures, so callers never learn how storage works underneath.

Why SQLite: the old JSON-per-device store rewrote the whole file on every append
(concurrent writes could lose rows) and could not answer "rows in this window"
without loading everything. WAL + an ``(device, kind, at)`` index fixes both.

`ponytail:` no schema versioning or migration of the old JSON files — the demo
directory is disposable. Upgrade: Postgres + Alembic when several services write.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .config import settings

_DB_NAME = "memomate.db"


class Store:
    def __init__(self, data_dir: Path | None = None, db_name: str = _DB_NAME) -> None:
        self._dir = Path(data_dir or settings.data_dir)
        self._dir.mkdir(parents=True, exist_ok=True)
        self.path = self._dir / db_name
        # Serialise writes inside this process. SQLite's busy handler can still
        # time out when 20 threads each autocommit a statement (observed on
        # Windows); reads stay lock-free because WAL readers never block.
        self._lock = threading.Lock()
        self._initialize()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        """Short-lived connection: no open handle lingers between calls.

        Keeping the handle open would also block temp-directory cleanup on
        Windows. WAL is a persistent database property, so it is set once in
        ``_initialize``; only the per-connection busy timeout is repeated here.
        """
        conn = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        try:
            yield conn
        finally:
            conn.close()

    def _initialize(self) -> None:
        with self._lock, self._connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=NORMAL")
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    at INTEGER NOT NULL,
                    payload TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_records_device_kind_at
                    ON records (device_id, kind, at);
                CREATE TABLE IF NOT EXISTS docs (
                    device_id TEXT NOT NULL,
                    key TEXT NOT NULL,
                    value TEXT NOT NULL,
                    PRIMARY KEY (device_id, key)
                );
                """
            )

    def record(self, device_id: str, kind: str, obj: dict[str, Any]) -> None:
        """Append a derived-feature / event record under a stream name."""
        at = int(obj.get("at") or obj.get("startedAt") or obj.get("endedAt") or 0)
        with self._lock, self._connect() as db:
            db.execute(
                "INSERT INTO records (device_id, kind, at, payload) VALUES (?, ?, ?, ?)",
                (device_id, kind, at, json.dumps(obj, ensure_ascii=False)),
            )

    def history(
        self, device_id: str, kind: str, since_ms: int | None = None
    ) -> list[dict[str, Any]]:
        query = "SELECT payload FROM records WHERE device_id = ? AND kind = ?"
        params: list[Any] = [device_id, kind]
        if since_ms is not None:
            query += " AND at >= ?"
            params.append(int(since_ms))
        query += " ORDER BY id ASC"
        with self._connect() as db:
            rows = db.execute(query, params).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def get_doc(self, device_id: str, key: str) -> Any:
        with self._connect() as db:
            row = db.execute(
                "SELECT value FROM docs WHERE device_id = ? AND key = ?", (device_id, key)
            ).fetchone()
        return None if row is None else json.loads(row["value"])

    def set_doc(self, device_id: str, key: str, value: Any) -> None:
        with self._lock, self._connect() as db:
            db.execute(
                "INSERT INTO docs (device_id, key, value) VALUES (?, ?, ?) "
                "ON CONFLICT(device_id, key) DO UPDATE SET value = excluded.value",
                (device_id, key, json.dumps(value, ensure_ascii=False)),
            )


store = Store()
