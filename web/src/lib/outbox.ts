// outbox.ts — PURE replay policy for the offline queue. No IndexedDB here.
//
// The store (`db.ts`) and the actual flush (`W2`) live elsewhere; this file only
// answers "should I retry now?", "is this too old?", "what order, and how many
// at a time?". Keeping the policy pure is what makes it testable and lets the
// same rules run in the doctor script.
//
// Contract: replay is AT-LEAST-ONCE. Every consumer must de-duplicate by
// `payload.id` — the backend already does this for gait/screening/telemetry.

import type { OutboxItem } from "./types";

/** 1s → 5s → 30s → 5min, then stay at 5min (docs/dev.md §3.6 B6). */
export const BACKOFF_MS = [1_000, 5_000, 30_000, 300_000] as const;

export const OUTBOX_MAX_ITEMS = 500;
export const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Cap one drain pass so a long offline stretch cannot flood the event loop. */
export const DRAIN_BATCH = 10;

/** `attempts` is 1-based (1 = the first retry). */
export function backoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  const idx = Math.min(attempts - 1, BACKOFF_MS.length - 1);
  return BACKOFF_MS[idx];
}

export function nextAttemptAt(attempts: number, now: number): number {
  return now + backoffMs(attempts);
}

/** Past the 7-day TTL — the item is dropped rather than replayed. */
export function isExpired(item: Pick<OutboxItem, "createdAt">, now: number, ttlMs = OUTBOX_TTL_MS): boolean {
  return now - item.createdAt > ttlMs;
}

export interface TrimResult<T> {
  keep: T[];
  dropped: T[];
}

/**
 * Enforces the 500-item ceiling by dropping the OLDEST entries first.
 * Returns both halves so the caller can log `outbox_drop`.
 */
export function trimToLimit<T extends { id: string; createdAt: number }>(
  items: T[],
  max = OUTBOX_MAX_ITEMS
): TrimResult<T> {
  if (items.length <= max) return { keep: items.slice(), dropped: [] };
  const sorted = items.slice().sort((a, b) => a.createdAt - b.createdAt);
  const cut = sorted.length - max;
  return { keep: sorted.slice(cut), dropped: sorted.slice(0, cut) };
}

export interface DrainPlan {
  /** FIFO by createdAt, at most `limit` entries, all due at `now`. */
  ready: OutboxItem[];
  /** Past TTL — delete without sending. */
  expired: OutboxItem[];
  /** Not due yet. */
  waiting: number;
}

/**
 * Decides what one drain pass sends. FIFO matters: a forced SOS queued behind
 * 40 telemetry events must not be starved, which is why `kind` is not used for
 * ordering but SOS is allowed to jump ahead explicitly.
 */
export function planDrain(
  items: OutboxItem[],
  now: number,
  limit = DRAIN_BATCH
): DrainPlan {
  const expired: OutboxItem[] = [];
  const due: OutboxItem[] = [];
  let waiting = 0;

  for (const it of items) {
    if (isExpired(it, now)) expired.push(it);
    else if (it.nextAttemptAt <= now) due.push(it);
    else waiting++;
  }

  due.sort((a, b) => {
    // SOS always goes first regardless of age (safety beats fairness).
    const aSos = a.kind === "sos" ? 0 : 1;
    const bSos = b.kind === "sos" ? 0 : 1;
    if (aSos !== bSos) return aSos - bSos;
    return a.createdAt - b.createdAt;
  });

  return { ready: due.slice(0, Math.max(0, limit)), expired, waiting };
}

/** Applies a failed attempt: bump attempts and schedule the next try. */
export function onFailure(item: OutboxItem, now: number, error?: string): OutboxItem {
  const attempts = item.attempts + 1;
  return {
    ...item,
    attempts,
    nextAttemptAt: nextAttemptAt(attempts, now),
    lastError: error ?? item.lastError,
  };
}
