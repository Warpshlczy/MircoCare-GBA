// recordSync.ts — the only thing about `records` that leaves the phone.
//
// The senior's readable records (药名、备注、随口说的话) stay in IndexedDB. What
// the family screen needs is far less: "今日記錄咗幾次、最後一次幾點". C's
// `POST /records/summary` takes exactly that, keyed by (device, day, kind) so a
// replay replaces the aggregate instead of doubling it (issue #7).
//
// This module is deliberately PURE above the queue boundary: it takes the day's
// rows as an argument instead of reading them, because recordStore.ts calls it
// and an import back into recordStore would make the two modules cyclic.

import { flushOutboxOnce } from "./outboxRunner.ts";
import { enqueue } from "./outboxStore.ts";
import type { RecordEntry, RecordKind } from "./types.ts";

export interface RecordSummary {
  day: string;
  kind: RecordKind;
  count: number;
  lastAt: number;
}

const KINDS: readonly RecordKind[] = ["med", "alarm", "measure", "card"];

/**
 * One kind's aggregate for one day, or null when there is nothing to report.
 *
 * `lastAt` is the newest `at` (when it happened), never `dueAt` (when an alarm
 * will ring): an alarm that has not rung is not a thing the senior did.
 */
export function summarizeRecords(rows: RecordEntry[], day: string, kind: RecordKind): RecordSummary | null {
  const mine = rows.filter((r) => r.day === day && r.kind === kind);
  if (!mine.length) return null;
  let lastAt = 0;
  for (const r of mine) if (r.at > lastAt) lastAt = r.at;
  return { day, kind, count: mine.length, lastAt };
}

/** Every non-empty aggregate for a day — what a flush sends. */
export function summarizeAll(rows: RecordEntry[], day: string): RecordSummary[] {
  const out: RecordSummary[] = [];
  for (const kind of KINDS) {
    const s = summarizeRecords(rows, day, kind);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Queue id. It carries the state, not just the key: `enqueue` is idempotent by
 * id, so keying on day+kind alone would keep the FIRST count of the day in the
 * queue and silently discard the later ones. Keying on the state makes each
 * distinct aggregate its own row while a replay of the same one still dedupes.
 */
export function recordSummaryId(s: RecordSummary): string {
  return `rs-${s.day}-${s.kind}-${s.count}-${s.lastAt}`;
}

/** Enqueues one aggregate and kicks the queue. Never throws at the caller. */
export async function enqueueRecordSummary(rows: RecordEntry[], day: string, kind: RecordKind): Promise<void> {
  const body = summarizeRecords(rows, day, kind);
  if (!body) return;
  await enqueue("recordSummary", body, Date.now(), recordSummaryId(body));
  void flushOutboxOnce();
}
