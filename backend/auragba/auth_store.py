"""Transactional SQLite state for accounts, sessions, and pairing."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import sqlite3
import time
from pathlib import Path
from typing import Any

from .config import settings


class AuthStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = Path(path or settings.data_dir / "auth.sqlite3")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=10000")
        return connection

    def _initialize(self) -> None:
        with self._connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS accounts (
                    id TEXT PRIMARY KEY,
                    role TEXT NOT NULL CHECK (role IN ('senior', 'family')),
                    device_id TEXT,
                    created_at INTEGER NOT NULL,
                    UNIQUE (role, device_id)
                );
                CREATE TABLE IF NOT EXISTS pairing_codes (
                    id TEXT PRIMARY KEY,
                    code_hash TEXT NOT NULL UNIQUE,
                    senior_account_id TEXT NOT NULL,
                    senior_device_id TEXT NOT NULL,
                    expires_at INTEGER NOT NULL,
                    failed_attempts INTEGER NOT NULL DEFAULT 0,
                    consumed_at INTEGER,
                    invalidated_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS pairing_attempts (
                    pairing_id TEXT NOT NULL,
                    family_account_id TEXT NOT NULL,
                    failures INTEGER NOT NULL DEFAULT 0,
                    locked_until INTEGER NOT NULL DEFAULT 0,
                    lock_round INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (pairing_id, family_account_id)
                );
                CREATE TABLE IF NOT EXISTS family_pairing_limits (
                    family_account_id TEXT PRIMARY KEY,
                    failures INTEGER NOT NULL DEFAULT 0,
                    locked_until INTEGER NOT NULL DEFAULT 0,
                    lock_round INTEGER NOT NULL DEFAULT 0,
                    disabled_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS family_relations (
                    family_account_id TEXT NOT NULL,
                    senior_account_id TEXT NOT NULL,
                    senior_device_id TEXT NOT NULL,
                    bound_at INTEGER NOT NULL,
                    PRIMARY KEY (family_account_id, senior_account_id)
                );
                """
            )
        self._migrate_account_uniqueness()

    def _migrate_account_uniqueness(self) -> None:
        """Rebuild `accounts` if it still has the old global `device_id UNIQUE`.

        A senior and a family account may live on the same physical device (the
        same browser can open both apps), so uniqueness must be per-role. SQLite
        cannot drop a column constraint in place; the table is rebuilt once and
        existing rows are carried over.
        """
        with self._connect() as db:
            row = db.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'"
            ).fetchone()
            if not row or "device_id TEXT UNIQUE" not in (row["sql"] or ""):
                return
            db.execute("BEGIN IMMEDIATE")
            db.execute("ALTER TABLE accounts RENAME TO accounts_legacy")
            db.execute(
                """
                CREATE TABLE accounts (
                    id TEXT PRIMARY KEY,
                    role TEXT NOT NULL CHECK (role IN ('senior', 'family')),
                    device_id TEXT,
                    created_at INTEGER NOT NULL,
                    UNIQUE (role, device_id)
                )
                """
            )
            db.execute(
                """
                INSERT INTO accounts (id, role, device_id, created_at)
                SELECT id, role, device_id, created_at FROM accounts_legacy
                """
            )
            db.execute("DROP TABLE accounts_legacy")
            db.commit()

    def create_account(self, role: str, device_id: str | None) -> dict[str, Any]:
        """Return the existing account for (role, device), or create one.

        Registration is idempotent so a new browser session (or a second tab)
        never hits the uniqueness constraint and never fragments a senior's
        history across several accounts.
        """
        with self._connect() as db:
            existing = self._find(db, role, device_id)
            if existing:
                return existing
            account = {
                "id": f"acct-{secrets.token_urlsafe(12)}",
                "role": role,
                "deviceId": device_id,
                "createdAt": int(time.time() * 1000),
            }
            try:
                db.execute(
                    "INSERT INTO accounts(id, role, device_id, created_at) VALUES (?, ?, ?, ?)",
                    (account["id"], role, device_id, account["createdAt"]),
                )
            except sqlite3.IntegrityError:
                # Lost a race against a concurrent request — return the winner.
                existing = self._find(db, role, device_id)
                if not existing:
                    raise
                return existing
        return account

    @staticmethod
    def _find(db: sqlite3.Connection, role: str, device_id: str | None) -> dict[str, Any] | None:
        if device_id is None:
            return None
        row = db.execute(
            "SELECT id, role, device_id, created_at FROM accounts WHERE role = ? AND device_id = ?",
            (role, device_id),
        ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "role": row["role"],
            "deviceId": row["device_id"],
            "createdAt": row["created_at"],
        }

    def get_account(self, account_id: str) -> dict[str, Any] | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT id, role, device_id, created_at FROM accounts WHERE id = ?",
                (account_id,),
            ).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "role": row["role"],
            "deviceId": row["device_id"],
            "createdAt": row["created_at"],
        }

    def create_pairing(self, senior_account_id: str, senior_device_id: str, ttl: int) -> tuple[str, int]:
        code = f"{secrets.randbelow(1_000_000):06d}"
        expires_at = int(time.time()) + ttl
        code_hash = self._hash_code(code)
        with self._connect() as db:
            db.execute(
                """
                INSERT INTO pairing_codes
                    (id, code_hash, senior_account_id, senior_device_id, expires_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (secrets.token_urlsafe(12), code_hash, senior_account_id, senior_device_id, expires_at),
            )
        return code, expires_at

    def redeem_pairing(self, family_account_id: str, code: str) -> dict[str, Any]:
        now = int(time.time())
        code_hash = self._hash_code(code)
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            limit = db.execute(
                "SELECT locked_until, disabled_at FROM family_pairing_limits WHERE family_account_id = ?",
                (family_account_id,),
            ).fetchone()
            if limit and (limit["disabled_at"] or int(limit["locked_until"]) > now):
                db.rollback()
                raise ValueError("locked")
            row = db.execute(
                "SELECT * FROM pairing_codes WHERE code_hash = ?",
                (code_hash,),
            ).fetchone()
            if not row or row["consumed_at"] or row["invalidated_at"] or row["expires_at"] < now:
                db.rollback()
                raise ValueError("invalid")

            attempt = db.execute(
                "SELECT * FROM pairing_attempts WHERE pairing_id = ? AND family_account_id = ?",
                (row["id"], family_account_id),
            ).fetchone()
            failures = int(attempt["failures"]) if attempt else 0
            locked_until = int(attempt["locked_until"]) if attempt else 0
            if locked_until > now:
                db.rollback()
                raise ValueError("locked")

            # A valid guess consumes the credential atomically.
            db.execute(
                "UPDATE pairing_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL AND invalidated_at IS NULL",
                (now, row["id"]),
            )
            if db.total_changes != 1:
                db.rollback()
                raise ValueError("invalid")
            bound_at = now * 1000
            db.execute(
                """
                INSERT OR IGNORE INTO family_relations
                    (family_account_id, senior_account_id, senior_device_id, bound_at)
                VALUES (?, ?, ?, ?)
                """,
                (family_account_id, row["senior_account_id"], row["senior_device_id"], bound_at),
            )
            db.commit()
            return {
                "seniorAccountId": row["senior_account_id"],
                "seniorDeviceId": row["senior_device_id"],
                "boundAt": bound_at,
            }

    def record_failed_pairing(self, family_account_id: str, code: str) -> None:
        now = int(time.time())
        code_hash = self._hash_code(code)
        with self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            limit = db.execute(
                "SELECT failures, lock_round FROM family_pairing_limits WHERE family_account_id = ?",
                (family_account_id,),
            ).fetchone()
            account_failures = (int(limit["failures"]) if limit else 0) + 1
            account_round = account_failures // 10
            account_lock = 0
            account_disabled = None
            if account_failures % 10 == 0:
                if account_failures >= 40:
                    account_disabled = now
                else:
                    minutes = 15 if account_round == 1 else 30 * (account_round - 1)
                    account_lock = now + minutes * 60
            db.execute(
                """
                INSERT INTO family_pairing_limits(family_account_id, failures, locked_until, lock_round, disabled_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(family_account_id) DO UPDATE SET
                    failures = excluded.failures,
                    locked_until = excluded.locked_until,
                    lock_round = excluded.lock_round,
                    disabled_at = COALESCE(excluded.disabled_at, family_pairing_limits.disabled_at)
                """,
                (family_account_id, account_failures, account_lock, account_round, account_disabled),
            )
            row = db.execute(
                "SELECT id, failed_attempts, invalidated_at FROM pairing_codes WHERE code_hash = ?",
                (code_hash,),
            ).fetchone()
            if row and not row["invalidated_at"]:
                attempt = db.execute(
                    "SELECT failures, lock_round FROM pairing_attempts WHERE pairing_id = ? AND family_account_id = ?",
                    (row["id"], family_account_id),
                ).fetchone()
                failures = (int(attempt["failures"]) if attempt else 0) + 1
                total = int(row["failed_attempts"]) + 1
                round_number = failures // 10
                locked_until = 0
                if failures % 10 == 0:
                    if total >= 40:
                        db.execute("UPDATE pairing_codes SET failed_attempts = ?, invalidated_at = ? WHERE id = ?", (total, now, row["id"]))
                    else:
                        minutes = 15 if round_number == 1 else 30 * (round_number - 1)
                        locked_until = now + minutes * 60
                        db.execute("UPDATE pairing_codes SET failed_attempts = ? WHERE id = ?", (total, row["id"]))
                else:
                    db.execute("UPDATE pairing_codes SET failed_attempts = ? WHERE id = ?", (total, row["id"]))
                db.execute(
                    """
                    INSERT INTO pairing_attempts(pairing_id, family_account_id, failures, locked_until, lock_round)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(pairing_id, family_account_id) DO UPDATE SET
                        failures = excluded.failures,
                        locked_until = excluded.locked_until,
                        lock_round = excluded.lock_round
                    """,
                    (row["id"], family_account_id, failures, locked_until, round_number),
                )
            db.commit()

    def relations_for(self, family_account_id: str) -> list[dict[str, Any]]:
        with self._connect() as db:
            rows = db.execute(
                """
                SELECT senior_account_id, senior_device_id, bound_at
                FROM family_relations WHERE family_account_id = ?
                """,
                (family_account_id,),
            ).fetchall()
        return [
            {
                "seniorAccountId": row["senior_account_id"],
                "seniorDeviceId": row["senior_device_id"],
                "boundAt": row["bound_at"],
            }
            for row in rows
        ]

    def family_accounts_for_device(self, senior_device_id: str) -> list[str]:
        """Family account ids bound to a senior device (used by notifications)."""
        with self._connect() as db:
            rows = db.execute(
                """
                SELECT DISTINCT family_account_id
                FROM family_relations WHERE senior_device_id = ?
                """,
                (senior_device_id,),
            ).fetchall()
        return [row["family_account_id"] for row in rows]

    @staticmethod
    def _hash_code(code: str) -> str:
        return hmac.new(settings.auth_secret.encode("utf-8"), code.encode("ascii", "ignore"), hashlib.sha256).hexdigest()


auth_store = AuthStore()
