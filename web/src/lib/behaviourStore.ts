// behaviourStore.ts — IO for the daily behaviour rollup. Browser-only.
//
// Split from behaviour.ts for the same reason tasks/taskStore are split: the
// rollup rules must stay runnable in plain Node (no `indexedDB`), because those
// are the numbers that decide whether the family gets a phone call.
//
// Storage layout — deliberately in the generic `meta` KV store, NOT a new
// object store: adding one means a DB version bump, and a version bump is the
// one change that can leave an already-installed phone with a half-migrated
// database. Two keys are all we need:
//
//   behaviour_acc.<YYYY-MM-DD>  {ids, cvSum, cvCount, fallEvents}
//   behaviour.lastUploadedDay   {day}
//
// The accumulator exists because `useGaitMonitor` deletes each window as soon as
// it uploads. See the header of behaviour.ts.

import {
  accumulateGait,
  appUsedOn,
  behaviourEnvelope,
  behaviourForDay,
  countInteractions,
  dayToUpload,
  emptyAccumulator,
  shouldUploadDay,
  addDays,
  MAX_ACC_IDS,
} from "./behaviour.ts";
import type { GaitAccumulator } from "./behaviour.ts";
import { all, del, get, put } from "./db.ts";
import { enqueue } from "./outboxStore.ts";
import { listTasks } from "./taskStore.ts";
import { dayKey } from "./tasks.ts";
import type { BehaviourDaily, ConversationTurn, GaitWindow } from "./types";

const ACC_PREFIX = "behaviour_acc.";
const LAST_UPLOAD_KEY = "behaviour.lastUploadedDay";
/** Keep a week of accumulators for late catch-up, then drop them. */
const KEEP_ACC_DAYS = 8;

interface AccDoc extends GaitAccumulator {
  id: string;
}

interface MarkerDoc {
  id: string;
  day: string;
  at?: number;
}

function accKey(day: string): string {
  return `${ACC_PREFIX}${day}`;
}

export async function readAccumulator(day: string): Promise<GaitAccumulator> {
  const doc = await get<AccDoc>("meta", accKey(day)).catch(() => undefined);
  if (!doc || doc.day !== day) return emptyAccumulator(day);
  return {
    day,
    ids: Array.isArray(doc.ids) ? doc.ids.slice(0, MAX_ACC_IDS) : [],
    cvSum: Number.isFinite(doc.cvSum) ? doc.cvSum : 0,
    cvCount: Number.isFinite(doc.cvCount) ? doc.cvCount : 0,
    fallEvents: Number.isFinite(doc.fallEvents) ? doc.fallEvents : 0,
  };
}

/**
 * Folds one gait window into its day. Called at OBSERVATION time, before the
 * window is uploaded and deleted.
 *
 * Serialised through a promise chain: motion callbacks can fire within
 * milliseconds of each other, and a read-modify-write race would silently lose
 * a window (i.e. lose a fall).
 */
let gaitQueue: Promise<unknown> = Promise.resolve();

export function recordGaitForBehaviour(w: GaitWindow): Promise<void> {
  const next = gaitQueue
    .then(async () => {
      const day = dayKey(w.startedAt);
      const acc = accumulateGait(await readAccumulator(day), w);
      await put<AccDoc>("meta", { ...acc, id: accKey(day) });
    })
    .catch(() => {
      /* a lost accumulator must never break gait monitoring itself */
    });
  gaitQueue = next;
  return next;
}

async function readMarker(): Promise<string | null> {
  const doc = await get<MarkerDoc>("meta", LAST_UPLOAD_KEY).catch(() => undefined);
  return doc?.day ?? null;
}

/** Only ever moves forward — a late duplicate run cannot rewind the marker. */
async function markUploaded(day: string, now: number): Promise<void> {
  const current = await readMarker();
  if (current && current >= day) return;
  await put<MarkerDoc>("meta", { id: LAST_UPLOAD_KEY, day, at: now });
}

async function pruneAccumulators(now: number): Promise<void> {
  const oldest = addDays(dayKey(now), -KEEP_ACC_DAYS);
  const rows = await all<AccDoc>("meta").catch(() => []);
  for (const row of rows) {
    if (!row?.id?.startsWith(ACC_PREFIX)) continue;
    const day = row.id.slice(ACC_PREFIX.length);
    if (day < oldest) await del("meta", row.id).catch(() => {});
  }
}

export interface DayRollup {
  behaviour: BehaviourDaily;
  /** the app was open that day — makes a silent day uploadable */
  appUsed: boolean;
  /** the senior's own utterances that day */
  interactions: number;
}

/** Builds one day's rollup from local tasks + conversation memory + accumulator. */
export async function buildDayRollup(day: string, now = Date.now()): Promise<DayRollup> {
  const [tasks, turns, gait, acc] = await Promise.all([
    listTasks().catch(() => []),
    all<ConversationTurn>("conversation").catch(() => []),
    // Windows that never reached the backend are still on the device; the
    // accumulator covers the ones that uploaded and were deleted.
    all<GaitWindow>("gait").catch(() => []),
    readAccumulator(day),
  ]);

  const interactions = countInteractions(turns, day);
  return {
    behaviour: behaviourForDay({ day, tasks, gait, gaitAcc: acc, interactionCount: interactions }),
    appUsed: appUsedOn(turns, day),
    interactions,
  };
}

export interface BehaviourFlushResult {
  /** day pushed to the outbox, or null */
  uploaded: string | null;
  /** day that was examined (null = marker already covers everything closed) */
  checked: string | null;
  /** why nothing was sent */
  skipped?: "no-signal";
}

/**
 * Uploads ONE closed day, at most. Safe to call on every app open:
 *   - only closed days (yesterday and earlier) — see behaviour.ts#dayToUpload
 *   - the payload id is `bd-<day>`, so the outbox and the backend both de-dup
 *   - nothing measured AND the app never opened -> marker advances, no request
 *
 * The request itself goes through the outbox, so an offline evening still
 * reports once the phone comes back on.
 */
export async function flushClosedDay(now = Date.now()): Promise<BehaviourFlushResult> {
  const marker = await readMarker();
  const day = dayToUpload(now, marker);
  if (!day) return { uploaded: null, checked: null };

  const { behaviour, appUsed } = await buildDayRollup(day, now);

  if (!shouldUploadDay(behaviour, appUsed)) {
    // Nothing to say about that day. Advance the marker anyway, otherwise every
    // future open re-examines it forever.
    await markUploaded(day, now);
    await pruneAccumulators(now);
    return { uploaded: null, checked: day, skipped: "no-signal" };
  }

  await enqueue("behaviour", behaviourEnvelope(behaviour), now);
  await markUploaded(day, now);
  await pruneAccumulators(now);
  return { uploaded: day, checked: day };
}

/** Diagnostics for the doctor page / issue reports. */
export async function lastUploadedDay(): Promise<string | null> {
  return readMarker();
}
