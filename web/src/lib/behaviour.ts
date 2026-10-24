// behaviour.ts — PURE rollup of one local day into BehaviourDaily.
//
// This is the only input C's behaviour stream accepts, and every field it holds
// must be MEASURED. Three rules follow from that, and they are the whole reason
// this file is separate from the uploader:
//
// 1. `null` is not 0. A day with no reminder due has `taskCompletionRate: null`,
//    not 0 — "we did not measure" and "he completed nothing" point in opposite
//    clinical directions.
// 2. `circadian` / `digitalSkill` are OMITTED, not filled with null fields,
//    until W4 can really observe them. The backend envelope allows omission
//    (contract.py:329) precisely so that an honest device can send less.
// 3. `interactionCount` is REQUIRED from the caller. There is no sane default:
//    0 would read as "he spoke to nobody today".
//
// WHY A GAIT ACCUMULATOR EXISTS
// `useGaitMonitor` DELETES each window from IndexedDB the moment it uploads
// (useGaitMonitor.ts:17), so by evening the `gait` store is empty and a rollup
// computed from it would report `gaitCv: null` every single day — silently
// discarding the one stream that feeds 20% of the fusion weight. The accumulator
// here is fed at OBSERVATION time and keeps only sums plus the ids already
// counted, so a window can never be counted twice (uploaded-and-deleted, or
// still-on-device).
//
// Tested in src/selfcheck.ts.

import { dayKey, taskStatsForDay } from "./tasks.ts";
import type { BehaviourDaily, GaitWindow, Task } from "./types";

/** Bound the id list so one day's meta doc cannot grow without limit. */
export const MAX_ACC_IDS = 500;
/** Never backfill more than this many days — a 3-week-old day is not diagnostic. */
export const MAX_BACKFILL_DAYS = 7;

export interface BehaviourInputs {
  /** local day key "YYYY-MM-DD" (see tasks.ts#dayKey) */
  day: string;
  tasks: Task[];
  /** windows still on the device; merged with `gaitAcc` and de-duplicated by id */
  gait?: GaitWindow[];
  /** what was observed during the day even if the window is already gone */
  gaitAcc?: GaitAccumulator;
  /**
   * Utterances/cards the app handled that day. Required on purpose — see the
   * header. A caller that cannot count it yet should not upload a day at all.
   */
  interactionCount: number;
}

// --------------------------------------------------------------------------- //
// Day arithmetic (local time, matching tasks.ts#dayKey)
// --------------------------------------------------------------------------- //

/** Shifts a "YYYY-MM-DD" key by whole days; handles month/year rollover. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + n).getTime());
}

/**
 * The closed day to upload now, or null when there is nothing to do.
 *
 * Only CLOSED days (yesterday and earlier) are sent: uploading today's partial
 * rollup would push a temporarily low completion rate, and the backend keys the
 * doc by day, so it would be corrected only if the upload finished — an honest
 * "we do not know yet" is better than a wrong number that later flips.
 *
 * `lastUploadedDay` is the device's marker. One day per call, so a long gap
 * catches up over several opens instead of firing a month of stale rows at once.
 */
export function dayToUpload(now: number, lastUploadedDay: string | null): string | null {
  const today = dayKey(now);
  const yesterday = addDays(today, -1);
  if (!lastUploadedDay) return yesterday;
  // A marker dated in the future can only come from a clock jump. Trusting it
  // would silence the stream until that date arrives, so resend instead —
  // `bd-<day>` makes the duplicate harmless.
  if (lastUploadedDay > today) return yesterday;
  // ISO date keys compare correctly as plain strings.
  if (lastUploadedDay >= yesterday) return null;
  const next = addDays(lastUploadedDay, 1);
  const oldest = addDays(yesterday, -(MAX_BACKFILL_DAYS - 1));
  return next < oldest ? oldest : next;
}

// --------------------------------------------------------------------------- //
// Gait accumulation
// --------------------------------------------------------------------------- //

export interface GaitAccumulator {
  day: string;
  /** window ids already folded in — the de-duplication key */
  ids: string[];
  cvSum: number;
  cvCount: number;
  fallEvents: number;
}

export function emptyAccumulator(day: string): GaitAccumulator {
  return { day, ids: [], cvSum: 0, cvCount: 0, fallEvents: 0 };
}

/** Folds one window in. Idempotent per `window.id`, so a retry cannot double count. */
export function accumulateGait(acc: GaitAccumulator, w: GaitWindow): GaitAccumulator {
  if (w.id && acc.ids.includes(w.id)) return acc;
  const hasCv = Number.isFinite(w.cv);
  return {
    day: acc.day,
    ids: w.id && acc.ids.length < MAX_ACC_IDS ? [...acc.ids, w.id] : acc.ids,
    cvSum: hasCv ? acc.cvSum + w.cv : acc.cvSum,
    cvCount: hasCv ? acc.cvCount + 1 : acc.cvCount,
    fallEvents: acc.fallEvents + (w.fall ? 1 : 0),
  };
}

export function accumulateGaitAll(acc: GaitAccumulator, windows: GaitWindow[]): GaitAccumulator {
  return windows.reduce(accumulateGait, acc);
}

/**
 * Merges an accumulator with windows still on the device, without double
 * counting and WITHOUT letting another day leak in: the store holds several
 * days at once, and a fall yesterday is not a fall today.
 */
export function mergeGaitAcc(acc: GaitAccumulator, windows: GaitWindow[]): GaitAccumulator {
  return accumulateGaitAll(
    { ...acc, ids: [...acc.ids] },
    windows.filter((w) => dayKey(w.startedAt) === acc.day)
  );
}

/** Mean CV rounded to 3dp; null when nothing was measured (NOT 0). */
export function accCv(acc: GaitAccumulator): number | null {
  if (acc.cvCount === 0) return null;
  return Math.round((acc.cvSum / acc.cvCount) * 1000) / 1000;
}

// --------------------------------------------------------------------------- //
// Interaction counting (from A's local conversation memory)
// --------------------------------------------------------------------------- //

export interface CountableTurn {
  at: number;
  role: "user" | "assistant";
}

/** Turns the senior actually said, on `day`. Assistant lines would double it. */
export function countInteractions(turns: CountableTurn[], day: string): number {
  return turns.filter((t) => t.role === "user" && dayKey(t.at) === day).length;
}

/**
 * Whether the app was used at all that day — either side of the conversation.
 *
 * This is the difference between "he stayed silent" (0 interactions, meaningful)
 * and "the phone was off" (no data, meaningless). Without it a quiet day and an
 * unused day look identical, and the first is exactly the signal worth sending.
 */
export function appUsedOn(turns: CountableTurn[], day: string): boolean {
  return turns.some((t) => dayKey(t.at) === day);
}

// --------------------------------------------------------------------------- //
// Rollup
// --------------------------------------------------------------------------- //

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Gait windows that STARTED on `day` — a window straddling midnight belongs to the day it began. */
export function gaitWindowsForDay(gait: GaitWindow[], day: string): GaitWindow[] {
  return gait.filter((w) => dayKey(w.startedAt) === day);
}

/**
 * Mean coefficient of variation of inter-step intervals for the day.
 * `null` when no window was recorded — same "not measured" rule as above.
 */
export function gaitCvForDay(gait: GaitWindow[], day: string): number | null {
  const windows = gaitWindowsForDay(gait, day).filter((w) => Number.isFinite(w.cv));
  if (windows.length === 0) return null;
  return Math.round(mean(windows.map((w) => w.cv)) * 1000) / 1000;
}

export function fallEventsForDay(gait: GaitWindow[], day: string): number {
  return gaitWindowsForDay(gait, day).filter((w) => w.fall).length;
}

/**
 * One day's rollup. Every number here is derived from a real local record; the
 * task fields come from `taskStatsForDay`, which counts a task for the day it
 * was DUE (not created) — the signal is "did he act on the reminder".
 *
 * Gait comes from the accumulator when available, because the store is emptied
 * as windows upload. Windows passed in are folded in and de-duplicated by id.
 */
export function behaviourForDay(input: BehaviourInputs): BehaviourDaily {
  const stats = taskStatsForDay(input.tasks, input.day);
  // A stale accumulator (wrong day) is ignored rather than trusted.
  const base =
    input.gaitAcc && input.gaitAcc.day === input.day ? input.gaitAcc : emptyAccumulator(input.day);
  const acc = mergeGaitAcc(base, input.gait ?? []);

  return {
    id: `bd-${input.day}`,
    day: input.day,
    taskConfirmDelayMin: stats.avgConfirmDelayMin,
    taskTimeoutRate: stats.timeoutRate,
    taskCompletionRate: stats.completionRate,
    deferCount: stats.deferredCount,
    interactionCount: Math.max(0, Math.round(input.interactionCount)),
    gaitCv: accCv(acc),
    fallEvents: acc.fallEvents,
  };
}

/**
 * The POST /behaviour/daily body. Only `behaviour` — W4 adds the other two rows
 * when the broadcasts actually exist, and C already accepts their absence.
 */
export function behaviourEnvelope(b: BehaviourDaily): { behaviour: BehaviourDaily } {
  return { behaviour: b };
}

/** True when the day carries at least one measured signal worth uploading. */
export function hasMeasuredSignal(b: BehaviourDaily): boolean {
  return (
    b.taskConfirmDelayMin !== null ||
    b.taskCompletionRate !== null ||
    b.gaitCv !== null ||
    b.fallEvents > 0 ||
    b.interactionCount > 0
  );
}

/**
 * Upload gate. `appUsed` is what makes a SILENT day uploadable: 0 interactions
 * on a day the app was open is the strongest care signal we can report, while
 * 0 interactions on a day the phone never left the drawer means nothing.
 */
export function shouldUploadDay(b: BehaviourDaily, appUsed: boolean): boolean {
  return appUsed || hasMeasuredSignal(b);
}
