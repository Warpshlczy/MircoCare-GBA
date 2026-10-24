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
  circadianRow,
  countInteractions,
  dayToUpload,
  emptyAccumulator,
  shouldUploadDay,
  addDays,
  MAX_ACC_IDS,
} from "./behaviour.ts";
import type { GaitAccumulator } from "./behaviour.ts";
import { all, del, get, put } from "./db.ts";
import { bridge } from "./native.ts";
import { enqueue } from "./outboxStore.ts";
import { listTasks } from "./taskStore.ts";
import { dayKey } from "./tasks.ts";
import { CARE_DAY_PREFIX, hearingProxyFrom } from "./care.ts";
import type { CareCounters } from "./care.ts";
import type { BehaviourDaily, CircadianDaily, ConversationTurn, GaitWindow } from "./types";

const ACC_PREFIX = "behaviour_acc.";
const INTERACTION_PREFIX = "interaction_acc.";
const PROXY_PREFIX = "interview_proxy.";
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

interface InteractionDoc {
  id: string;
  day: string;
  count: number;
}

interface ProxyDoc {
  id: string;
  hearing?: number | null;
  vision?: number | null;
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

/**
 * Counts one interaction, wherever it came from — voice, text, a tap, an
 * interview answer.
 *
 * WHY THIS EXISTS: the `conversation` store only holds utterances, so a senior
 * who mostly TAPS the three big buttons (the likeliest path for someone who
 * cannot read) looked like he had gone quiet. `interactionCount` is a care
 * signal, and getting it wrong in that direction is the worst kind of wrong.
 *
 * The UI calls this from its single `noteInteraction()` choke point, so all four
 * sources are counted once. When this counter exists it WINS over the
 * conversation store (not added to it — voice turns would be counted twice).
 *
 * Serialised: a burst of taps must not lose a read-modify-write race.
 */
let interactionQueue: Promise<unknown> = Promise.resolve();

export function recordInteractionForBehaviour(at = Date.now()): Promise<void> {
  const next = interactionQueue
    .then(async () => {
      const day = dayKey(at);
      const id = `${INTERACTION_PREFIX}${day}`;
      const doc = await get<InteractionDoc>("meta", id).catch(() => undefined);
      const count = (Number.isFinite(doc?.count) ? Number(doc?.count) : 0) + 1;
      await put<InteractionDoc>("meta", { id, day, count });
    })
    .catch(() => {
      /* losing one tap is survivable; breaking the tap handler is not */
    });
  interactionQueue = next;
  return next;
}

/** Null when nothing was counted that day — the caller must then fall back, not assume 0. */
export async function readInteractionCount(day: string): Promise<number | null> {
  const doc = await get<InteractionDoc>("meta", `${INTERACTION_PREFIX}${day}`).catch(() => undefined);
  return doc && Number.isFinite(doc.count) ? doc.count : null;
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
  const rows = await all<{ id?: string }>("meta").catch(() => []);
  for (const row of rows) {
    const id = row?.id;
    if (typeof id !== "string") continue;
    const prefix = id.startsWith(ACC_PREFIX)
      ? ACC_PREFIX
      : id.startsWith(INTERACTION_PREFIX)
        ? INTERACTION_PREFIX
        : id.startsWith(PROXY_PREFIX)
          ? PROXY_PREFIX
          : null;
    if (!prefix) continue;
    if (id.slice(prefix.length) < oldest) await del("meta", id).catch(() => {});
  }
}

/** Native circadian snapshot for `day`; null on the web or when nothing was seen. */
async function readCircadian(day: string): Promise<CircadianDaily | null> {
  try {
    return (await bridge()?.getCircadian(day)) ?? null;
  } catch {
    return null;
  }
}

async function readProxy(day: string): Promise<ProxyDoc | null> {
  const doc = await get<ProxyDoc>("meta", `${PROXY_PREFIX}${day}`).catch(() => undefined);
  return doc ?? null;
}

/**
 * The care counters for one day, read straight from the shared `meta` row.
 *
 * Deliberately NOT `careStore.readCareDayCounters`: careStore already imports
 * `readAccumulator` from this file, so calling back into it would close an
 * import cycle between two IndexedDB modules. The key itself is exported from
 * care.ts, so there is still one definition of it.
 */
async function readCareCountersFor(day: string): Promise<Partial<CareCounters>> {
  const doc = await get<{ id?: string; counters?: Partial<CareCounters> }>("meta", `${CARE_DAY_PREFIX}${day}`).catch(
    () => undefined
  );
  return doc?.counters ?? {};
}

/**
 * Report-only hearing/vision proxies from the interview (C's
 * `BehaviourDaily.hearingProxy/visionProxy`, contract.py:307).
 *
 * They never enter the behaviour score — C's own comment says so — but they DO
 * reach the weekly report, and a field the client never sends is a number the
 * family never sees. Values are 0..1 shares, not clinical measures.
 */
export async function recordInterviewProxy(
  day: string,
  proxy: { hearing?: number | null; vision?: number | null },
  now = Date.now()
): Promise<void> {
  const clean = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
  await put<ProxyDoc>("meta", {
    id: `${PROXY_PREFIX}${day}`,
    hearing: clean(proxy.hearing),
    vision: clean(proxy.vision),
    at: now,
  }).catch(() => {});
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
  const [tasks, turns, gait, acc, counted, proxy, care] = await Promise.all([
    listTasks().catch(() => []),
    all<ConversationTurn>("conversation").catch(() => []),
    // Windows that never reached the backend are still on the device; the
    // accumulator covers the ones that uploaded and were deleted.
    all<GaitWindow>("gait").catch(() => []),
    readAccumulator(day),
    readInteractionCount(day),
    readProxy(day),
    readCareCountersFor(day),
  ]);

  // The tap counter WINS when it exists (it is the only source that sees button
  // presses); otherwise fall back to utterances. Never sum the two.
  const interactions = counted ?? countInteractions(turns, day);
  // Either side of a conversation proves the app was open; so does a tap count.
  const appUsed = appUsedOn(turns, day) || counted !== null;

  // An explicitly recorded proxy wins; otherwise DERIVE the hearing one from the
  // care counters that already exist on the device. Deriving it here rather than
  // asking the UI to record it means the weekly report has a real number even
  // though nobody wired a producer — and `null` (not 0) when the day was silent.
  const hearingProxy = proxy?.hearing ?? hearingProxyFrom(care);

  return {
    behaviour: behaviourForDay({
      day,
      tasks,
      gait,
      gaitAcc: acc,
      interactionCount: interactions,
      hearingProxy,
      visionProxy: proxy?.vision ?? null,
    }),
    appUsed,
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

  // Screen/unlock/charging row, when the shell actually observed that day.
  // Null means "we did not see anything", and then the row is OMITTED rather
  // than sent full of zeros.
  const circadian = circadianRow(day, await readCircadian(day));

  await enqueue("behaviour", behaviourEnvelope(behaviour, circadian), now);
  await markUploaded(day, now);
  await pruneAccumulators(now);
  return { uploaded: day, checked: day };
}

/** Diagnostics for the doctor page / issue reports. */
export async function lastUploadedDay(): Promise<string | null> {
  return readMarker();
}
