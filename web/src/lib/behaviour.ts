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
//    (contract.py:310) precisely so that an honest device can send less.
// 3. `interactionCount` is REQUIRED from the caller. There is no sane default:
//    0 would read as "he spoke to nobody today". Until A's event wiring lands,
//    callers must pass a counted value rather than let this file guess.
//
// Tested in src/selfcheck.ts.

import { dayKey, taskStatsForDay } from "./tasks.ts";
import type { BehaviourDaily, GaitWindow, Task } from "./types";

export interface BehaviourInputs {
  /** local day key "YYYY-MM-DD" (see tasks.ts#dayKey) */
  day: string;
  tasks: Task[];
  gait: GaitWindow[];
  /**
   * Utterances/cards the app handled that day. Required on purpose — see the
   * header. A caller that cannot count it yet should not upload a day at all.
   */
  interactionCount: number;
}

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
 */
export function behaviourForDay(input: BehaviourInputs): BehaviourDaily {
  const stats = taskStatsForDay(input.tasks, input.day);
  return {
    id: `bd-${input.day}`,
    day: input.day,
    taskConfirmDelayMin: stats.avgConfirmDelayMin,
    taskTimeoutRate: stats.timeoutRate,
    taskCompletionRate: stats.completionRate,
    deferCount: stats.deferredCount,
    interactionCount: Math.max(0, Math.round(input.interactionCount)),
    gaitCv: gaitCvForDay(input.gait, input.day),
    fallEvents: fallEventsForDay(input.gait, input.day),
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
