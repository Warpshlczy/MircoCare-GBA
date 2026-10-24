// outboxStore.ts — IndexedDB IO for the offline replay queue. Browser-only.
//
// The policy (backoff, TTL, ceiling, ordering) lives in outbox.ts and is pure.
// Here we only persist and call an INJECTED `send`, which is why this file has
// no dependency on api.ts — the transport is decided by the caller, and W3 can
// swap it without touching the queue.

import { all, del, put } from "./db.ts";
import { onFailure, planDrain, trimToLimit } from "./outbox.ts";
import type { OutboxKind, OutboxItem } from "./types";

export function listOutbox(): Promise<OutboxItem[]> {
  return all<OutboxItem>("outbox");
}

export function outboxSize(): Promise<number> {
  return listOutbox().then((items) => items.length);
}

/**
 * Appends one item and enforces the 500-item ceiling.
 * `payload` MUST carry its own `id` — replay is at-least-once, so the receiver
 * de-duplicates on it.
 */
export async function enqueue(
  kind: OutboxKind,
  payload: unknown,
  now: number,
  id?: string
): Promise<OutboxItem> {
  const item: OutboxItem = {
    id: id ?? `ob-${now}-${Math.random().toString(36).slice(2, 7)}`,
    kind,
    payload,
    createdAt: now,
    attempts: 0,
    nextAttemptAt: now, // eligible immediately
  };

  const { keep, dropped } = trimToLimit([...(await listOutbox()), item]);
  for (const d of dropped) await del("outbox", d.id);
  for (const k of keep) await put("outbox", k);
  return item;
}

export function removeItem(id: string): Promise<void> {
  return del("outbox", id);
}

export interface DrainResult {
  sent: number;
  failed: number;
  /** past TTL and deleted without sending */
  dropped: number;
}

/**
 * One drain pass. Failures are re-queued with exponential backoff, never
 * discarded — except past the 7-day TTL, which is the only silent drop.
 */
export async function drain(
  send: (item: OutboxItem) => Promise<void>,
  now: number,
  limit?: number
): Promise<DrainResult> {
  const plan = planDrain(await listOutbox(), now, limit);
  let sent = 0;
  let failed = 0;

  for (const item of plan.expired) {
    await del("outbox", item.id);
  }

  for (const item of plan.ready) {
    try {
      await send(item);
      await del("outbox", item.id);
      sent++;
    } catch (err) {
      await put("outbox", onFailure(item, now, err instanceof Error ? err.message : String(err)));
      failed++;
    }
  }

  return { sent, failed, dropped: plan.expired.length };
}
