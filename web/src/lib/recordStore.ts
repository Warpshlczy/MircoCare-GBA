// recordStore.ts — IndexedDB IO for durable on-device records.
//
// Medication confirmations, alarms and measurements all land here so they
// survive an app restart instead of living only in React state. Browser-only
// (needs indexedDB); the pure card/script helpers stay in cards.ts so
// `node src/selfcheck.ts` never touches this file.

import { all, put } from "./db.ts";
import { dayKey } from "./tasks.ts";
import type { RecordEntry, RecordKind } from "./types.ts";

export interface NewRecord {
  kind: RecordKind;
  title: string;
  detail?: string;
  at: number;
  source: RecordEntry["source"];
}

export function newRecord(input: NewRecord): RecordEntry {
  return {
    id: `rec-${input.kind}-${input.at}`,
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    at: input.at,
    day: dayKey(input.at),
    source: input.source,
  };
}

export async function saveRecord(entry: RecordEntry): Promise<RecordEntry> {
  await put("records", entry);
  return entry;
}

export function addRecord(input: NewRecord): Promise<RecordEntry> {
  return saveRecord(newRecord(input));
}

export function listRecords(): Promise<RecordEntry[]> {
  return all<RecordEntry>("records");
}

/** Records written today, newest first — what the senior sees after a restart. */
export async function recordsForDay(day: string): Promise<RecordEntry[]> {
  const rows = await all<RecordEntry>("records");
  return rows.filter((r) => r.day === day).sort((a, b) => b.at - a.at);
}

export function todayRecords(now: number): Promise<RecordEntry[]> {
  return recordsForDay(dayKey(now));
}

/** The latest medication record on a given day, or null. */
export function latestMedRecord(rows: RecordEntry[], day: string): RecordEntry | null {
  const meds = rows.filter((r) => r.kind === "med" && r.day === day).sort((a, b) => b.at - a.at);
  return meds[0] ?? null;
}
