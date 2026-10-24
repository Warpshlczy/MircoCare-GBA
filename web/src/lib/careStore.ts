// careStore.ts — IO for the care-signal BASELINE. Browser-only.
//
// care.ts stays pure (thresholds + copy, testable in Node). This file answers
// the one question that needs storage: "what is usual for THIS senior?"
//
// Why the baseline must be persisted here rather than recomputed from the
// backend: the backend only stores `behaviour:<day>` AFTER an upload, and the
// days before a senior started using the device do not exist at all. The
// comparison rule ("today < 60% of his median") is worthless unless we keep our
// own per-day counters from day one, on the device, where they were counted.
//
// Contract for the UI (frozen — A builds `CareCounters` in page.tsx):
//
//   saveCareCounters(today, now)            // cheap upsert; call on every change
//   careForSenior(today, locale, now)       // -> the ONE sentence, or null
//   careForCaregiver(today, locale, now)    // -> what the family sees, or null
//   readCareBaseline(now)                   // diagnostics only
//
// `today` is `Partial<CareCounters>` with NULLABLE fields. A counter nobody
// measured must stay null/absent — passing 0 turns "not tracked" into "he did
// nothing today", which is exactly the mistake this module exists to prevent.
//
// Tested in src/selfcheck.ts (the pure half: median / baselineFrom / thresholds).

import {
  BASELINE,
  baselineFrom,
  careLine,
  caregiverLine,
  careSignals,
  normalizeCounters,
} from "./care.ts";
import type { CareCounters } from "./care.ts";
import { addDays } from "./behaviour.ts";
import { all, del, get, put } from "./db.ts";
import { dayKey } from "./tasks.ts";
import type { Locale } from "./types";

const DAY_PREFIX = "care_day.";
/** Keep a little more than the window so a late open can still fill the median. */
const KEEP_DAYS = BASELINE.windowDays + 7;

interface CareDayDoc {
  id: string;
  day: string;
  counters: Partial<CareCounters>;
  at: number;
}

function dayDocId(day: string): string {
  return `${DAY_PREFIX}${day}`;
}

function sameCounters(a: Partial<CareCounters>, b: Partial<CareCounters>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const key = k as keyof CareCounters;
    if ((a[key] ?? null) !== (b[key] ?? null)) return false;
  }
  return true;
}

/**
 * Upserts today's counters (latest value wins per field, other fields kept).
 * Skips the write when nothing changed: the caller may invoke this on every
 * interaction, and IndexedDB writes are not free.
 *
 * Serialised through a promise chain — a burst of taps must not interleave
 * read-modify-write and lose the higher count.
 */
let queue: Promise<unknown> = Promise.resolve();

export function saveCareCounters(today: Partial<CareCounters>, now: number): Promise<void> {
  const next = queue
    .then(async () => {
      const incoming = normalizeCounters(today);
      if (Object.keys(incoming).length === 0) return;

      const day = dayKey(now);
      const existing = await get<CareDayDoc>("meta", dayDocId(day)).catch(() => undefined);
      const merged: Partial<CareCounters> = { ...(existing?.counters ?? {}), ...incoming };
      if (existing && sameCounters(existing.counters, merged)) return;

      await put<CareDayDoc>("meta", { id: dayDocId(day), day, counters: merged, at: now });
    })
    .catch(() => {
      /* a missing baseline is survivable; a thrown hook is not */
    });
  queue = next;
  return next;
}

/** Previous `windowDays` days, newest first. Today is NEVER included. */
export async function readCareDays(now: number, windowDays = BASELINE.windowDays): Promise<Partial<CareCounters>[]> {
  const today = dayKey(now);
  const days: Partial<CareCounters>[] = [];
  for (let i = 1; i <= windowDays; i++) {
    const day = addDays(today, -i);
    const doc = await get<CareDayDoc>("meta", dayDocId(day)).catch(() => undefined);
    if (doc?.counters) days.push(doc.counters);
  }
  return days;
}

export async function readCareBaseline(now: number, windowDays = BASELINE.windowDays): Promise<Partial<CareCounters>> {
  return baselineFrom(await readCareDays(now, windowDays));
}

/**
 * The line to SAY, or null when there is nothing worth interrupting him about.
 * Records today's counters first, so the baseline grows even on days when no
 * signal fires — otherwise a good week would never become the reference.
 */
export async function careForSenior(today: Partial<CareCounters>, locale: Locale, now = Date.now()): Promise<string | null> {
  await saveCareCounters(today, now);
  const baseline = await readCareBaseline(now);
  return careLine(careSignals({ today: normalizeCounters(today), baseline }), locale);
}

/** What the family sees: an observation plus a suggestion, never a condition. */
export async function careForCaregiver(
  today: Partial<CareCounters>,
  locale: Locale,
  now = Date.now()
): Promise<string | null> {
  await saveCareCounters(today, now);
  const baseline = await readCareBaseline(now);
  return caregiverLine(careSignals({ today: normalizeCounters(today), baseline }), locale);
}

/** Diagnostics: which days the device actually has counters for. */
export async function listCareDays(): Promise<string[]> {
  const rows = await all<CareDayDoc>("meta").catch(() => []);
  return rows
    .filter((r) => typeof r?.id === "string" && r.id.startsWith(DAY_PREFIX))
    .map((r) => r.id.slice(DAY_PREFIX.length))
    .sort();
}

/** Drops counters older than the window: they can no longer influence a median. */
export async function pruneCareHistory(now = Date.now()): Promise<void> {
  const oldest = addDays(dayKey(now), -KEEP_DAYS);
  const rows = await all<CareDayDoc>("meta").catch(() => []);
  for (const row of rows) {
    if (typeof row?.id !== "string" || !row.id.startsWith(DAY_PREFIX)) continue;
    if (row.id.slice(DAY_PREFIX.length) < oldest) await del("meta", row.id).catch(() => {});
  }
}
