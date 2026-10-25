// tasks.ts — PURE task rules. No IndexedDB, no DOM (that is taskStore.ts).
//
// Why split: the confirm-delay maths and the "already taken it" rule are the
// numbers C's behaviour stream consumes (task_confirm_delay_min / timeout_rate).
// They must be testable with plain asserts, so they live apart from storage.
//
// Tested in src/selfcheck.ts.

import type { Task, TaskEvent } from "./types";

/** "You already confirmed this 20 minutes ago" window (docs/dev.md §1.8). */
export const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;

const PREFIX = /^(提醒我|提我|記住|记住|幫我記|帮我记|記低|记低|記一下|记一下|我要|同我)\s*/;

/** Strips the command verb so the card shows what to do, not how it was asked. */
export function taskTextFromUtterance(utterance: string): string {
  return (utterance ?? "").trim().replace(PREFIX, "").trim();
}

export interface NewTaskInput {
  text: string;
  now: number;
  dueAt?: number;
  source?: Task["source"];
  id?: string;
}

export function newTask(input: NewTaskInput): Task {
  const text = (input.text ?? "").trim();
  return {
    id: input.id ?? `task-${input.now}-${Math.random().toString(36).slice(2, 7)}`,
    text,
    dueAt: input.dueAt,
    done: false,
    source: input.source ?? "voice",
    deferredCount: 0,
    createdAt: input.now,
  };
}

/**
 * Minutes from the reminder's due time to the spoken confirmation.
 * `null` when the task had no deadline — never 0, because "no reminder was due"
 * is not "confirmed instantly" (see BehaviourDaily's null contract).
 */
export function confirmDelayMin(task: Task, at: number): number | null {
  if (task.dueAt === undefined) return null;
  return Math.max(0, Math.round((at - task.dueAt) / 60_000));
}

export interface DoneResult {
  task: Task;
  /** it was already marked done — the caller should say so out loud */
  alreadyDone: boolean;
  /** minutes since the earlier confirmation (null when not done before) */
  elapsedMin: number | null;
  /** delay vs. dueAt for THIS confirmation; null when there was no deadline */
  delayMin: number | null;
}

/**
 * Idempotent completion. A second "我食咗药" 30 minutes later must NOT create a
 * second confirmation — it must be flagged so the assistant can say
 * "你 20 分钟前已确认过".
 */
export function markDone(task: Task, at: number): DoneResult {
  if (task.done && task.doneAt !== undefined) {
    return {
      task,
      alreadyDone: true,
      elapsedMin: Math.max(0, Math.round((at - task.doneAt) / 60_000)),
      delayMin: confirmDelayMin(task, task.doneAt),
    };
  }
  const done: Task = { ...task, done: true, doneAt: at };
  return { task: done, alreadyDone: false, elapsedMin: null, delayMin: confirmDelayMin(task, at) };
}

/** Keep at most this many deferral timestamps per task. */
export const MAX_DEFERRALS_KEPT = 20;

/**
 * The senior pushed it back — an executive-function signal, not a failure.
 *
 * `at` is REQUIRED at the call site because the day rollup attributes deferrals
 * by timestamp; a bare counter cannot answer "did he defer today?". The due date
 * moves forward by `delayMs` so the reminder actually comes back.
 */
export function deferTask(task: Task, at: number, delayMs = 10 * 60 * 1000): Task {
  const stamps = [...(task.deferredAt ?? []), at].slice(-MAX_DEFERRALS_KEPT);
  return {
    ...task,
    deferredCount: task.deferredCount + 1,
    deferredAt: stamps,
    dueAt: task.dueAt === undefined ? undefined : at + delayMs,
  };
}

/** Deferrals that happened on `day`. Unknown-timestamp deferrals count 0, not N. */
export function deferralCountForDay(task: Task, day: string): number {
  return (task.deferredAt ?? []).filter((at) => dayKey(at) === day).length;
}

/**
 * Builds the wire event for one transition. Uploaded to POST /task/events,
 * which keys on `id` — so the id must be DETERMINISTIC for a given
 * (task, state, at): a replayed outbox item then overwrites the same doc
 * instead of counting twice.
 *
 * `source` defaults to how the task was created. Pass it explicitly when the
 * transition's cause differs — e.g. a `reminder` firing on a `voice` task.
 *
 * NOTE: never call this for `timeout` events produced by the boot-time rescan.
 * A reboot is not a behaviour observation; see docs and issue #2.
 */
export function taskEventFor(
  task: Task,
  state: TaskEvent["state"],
  at: number,
  source: TaskEvent["source"] = task.source
): TaskEvent {
  return {
    id: `te-${task.id}-${state}-${at}`,
    taskId: task.id,
    state,
    at,
    source,
    dueAt: task.dueAt,
    doneAt: state === "completed" ? task.doneAt ?? at : undefined,
  };
}

export function openTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.done);
}

/** Most recent still-open task; used by "我食咗药" when no id was spoken. */
export function latestOpenTask(tasks: Task[], prefer?: (t: Task) => boolean): Task | null {
  const open = openTasks(tasks);
  const pool = prefer ? open.filter(prefer) : open;
  if (pool.length === 0) return null;
  return pool.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a));
}

export function isOverdue(task: Task, now: number): boolean {
  return !task.done && task.dueAt !== undefined && task.dueAt <= now;
}

/** Local calendar day key "YYYY-MM-DD" (never UTC — the senior lives in HKT). */
export function dayKey(at: number): string {
  const d = new Date(at);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export interface DayStats {
  dueCount: number;
  doneCount: number;
  deferredCount: number;
  /** null when nothing was due — the caller must not substitute 0 */
  completionRate: number | null;
  timeoutRate: number | null;
  avgConfirmDelayMin: number | null;
}

/**
 * One-day rollup; maps 1:1 onto BehaviourDaily's task fields.
 * A task counts for the day it was DUE (not the day it was created), because
 * the behaviour signal is "did he act on the reminder".
 */
export function taskStatsForDay(tasks: Task[], day: string): DayStats {
  const due = tasks.filter((t) => t.dueAt !== undefined && dayKey(t.dueAt) === day);
  const done = due.filter((t) => t.done);
  const delays = done
    .map((t) => (t.doneAt === undefined ? null : confirmDelayMin(t, t.doneAt)))
    .filter((x): x is number => x !== null);

  return {
    dueCount: due.length,
    doneCount: done.length,
    // Day-granular: the cumulative counter would report last week's deferrals
    // again every day. Tasks recorded before `deferredAt` existed report 0 —
    // "we cannot attribute this to today" is honest, "3 every day" is not.
    deferredCount: due.reduce((sum, t) => sum + deferralCountForDay(t, day), 0),
    completionRate: due.length === 0 ? null : done.length / due.length,
    timeoutRate: due.length === 0 ? null : (due.length - done.length) / due.length,
    avgConfirmDelayMin:
      delays.length === 0 ? null : Math.round((delays.reduce((a, b) => a + b, 0) / delays.length) * 10) / 10,
  };
}
