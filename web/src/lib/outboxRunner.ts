// outboxRunner.ts — the missing caller for outboxStore#drain.
//
// Why this file exists at all: `drain()` shipped in W2 with a fully tested
// policy (backoff, TTL, 500-item ceiling, SOS-first ordering) and ZERO callers.
// A queue with no flush is worse than no queue — SOS events and task events
// accumulated on the phone and never left it, so the family's "已通知" was a
// statement about the outbox's contents, not about anything that happened.
//
// Three things live here, in dependency order:
//
//   1. `makeSender(transport)` — maps an OutboxKind to a real HTTP call. The
//      transport is INJECTED so the mapping itself is testable in plain Node
//      (a missing branch here is exactly how `geofence` would silently never
//      leave the device).
//   2. `flushOutboxOnce()` — one drain pass, de-duplicated so the interval, the
//      `online` event and a post-enqueue kick cannot run three passes at once
//      (that would send the same SOS twice).
//   3. `startOutboxAutoFlush()` — the triggers: on start, on `online`, on
//      returning to the foreground, and every minute. Idempotent.

import {
  postBehaviourDaily,
  postConversationMemory,
  postGaitWindow,
  postGeofenceEvent,
  postReminderEscalation,
  postScreeningSession,
  postSos,
  postTaskEvent,
  postTelemetry,
} from "./api.ts";
import type { ReminderEscalation } from "./api.ts";
import { drain } from "./outboxStore.ts";
import type { DrainResult } from "./outboxStore.ts";
import type {
  BehaviourDaily,
  ConversationTurn,
  GaitWindow,
  GeofenceEvent,
  OutboxItem,
  ScreeningSession,
  SosEvent,
  TaskEvent,
  TelemetryEvent,
} from "./types";

/** Body of POST /behaviour/daily (C's envelope; W4 adds the two optional rows). */
export type BehaviourBody = {
  behaviour: BehaviourDaily;
  circadian?: unknown;
  digitalSkill?: unknown;
};

export interface OutboxTransport {
  sos: (e: SosEvent) => Promise<unknown>;
  taskEvent: (e: TaskEvent) => Promise<void>;
  behaviour: (body: BehaviourBody) => Promise<void>;
  geofence: (e: GeofenceEvent) => Promise<void>;
  gait: (w: GaitWindow) => Promise<void>;
  screening: (s: ScreeningSession) => Promise<void>;
  /** accepts one event or a batch: the endpoint takes an array */
  telemetry: (events: TelemetryEvent[]) => Promise<void>;
  reminder: (e: ReminderEscalation) => Promise<void>;
  conversation: (t: ConversationTurn) => Promise<void>;
}

export const defaultTransport: OutboxTransport = {
  sos: postSos,
  taskEvent: postTaskEvent,
  behaviour: postBehaviourDaily as (b: BehaviourBody) => Promise<void>,
  geofence: postGeofenceEvent,
  gait: postGaitWindow,
  screening: postScreeningSession,
  telemetry: postTelemetry,
  reminder: postReminderEscalation,
  conversation: postConversationMemory,
};

/**
 * Accepts either the envelope `{behaviour}` or a bare BehaviourDaily.
 * Callers enqueue from different layers, and a shape mismatch here would fail
 * the POST with a 422 that retries forever (backoff caps at 5 min).
 */
export function behaviourBody(payload: unknown): BehaviourBody {
  if (payload && typeof payload === "object" && "behaviour" in payload) {
    return payload as BehaviourBody;
  }
  return { behaviour: payload as BehaviourDaily };
}

/** Accepts one telemetry event or an array — the endpoint always takes an array. */
export function telemetryBatch(payload: unknown): TelemetryEvent[] {
  return Array.isArray(payload) ? (payload as TelemetryEvent[]) : [payload as TelemetryEvent];
}

/**
 * Kind -> HTTP call. An UNKNOWN kind throws rather than resolving: silently
 * dropping it would delete the row and lose the event, and the retry cost of a
 * programming error (backoff caps at 5 min, TTL 7 days) is far cheaper than a
 * task completion that never reaches the backend.
 */
export function makeSender(transport: OutboxTransport = defaultTransport) {
  return async function send(item: OutboxItem): Promise<void> {
    switch (item.kind) {
      case "sos":
        await transport.sos(item.payload as SosEvent);
        return;
      case "taskEvent":
        await transport.taskEvent(item.payload as TaskEvent);
        return;
      case "behaviour":
        await transport.behaviour(behaviourBody(item.payload));
        return;
      case "geofence":
        await transport.geofence(item.payload as GeofenceEvent);
        return;
      case "gait":
        await transport.gait(item.payload as GaitWindow);
        return;
      case "screening":
        await transport.screening(item.payload as ScreeningSession);
        return;
      case "telemetry":
        await transport.telemetry(telemetryBatch(item.payload));
        return;
      case "reminder":
        await transport.reminder(item.payload as ReminderEscalation);
        return;
      case "conversation":
        await transport.conversation(item.payload as ConversationTurn);
        return;
      default: {
        const unknown: string = item.kind;
        throw new Error(`outbox: no sender for kind "${unknown}"`);
      }
    }
  };
}

export function flushOutbox(
  now = Date.now(),
  limit?: number,
  transport: OutboxTransport = defaultTransport
): Promise<DrainResult> {
  return drain(makeSender(transport), now, limit);
}

let inFlight: Promise<DrainResult> | null = null;

/**
 * One drain pass, never two at once. Concurrent passes would send the same SOS
 * twice: `drain` deletes after a successful send, so both passes see the row as
 * ready before either finishes.
 */
export function flushOutboxOnce(now = Date.now(), limit?: number): Promise<DrainResult> {
  if (inFlight) return inFlight;
  inFlight = flushOutbox(now, limit).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** How often to look for retry-eligible rows while the app is open. */
export const AUTO_FLUSH_INTERVAL_MS = 60_000;

let stopAutoFlush: (() => void) | null = null;

/**
 * Starts the triggers and returns a stop function. Idempotent: a second call
 * returns the existing stop function instead of installing a second timer.
 *
 * `online` matters most — it is the moment a reconnect makes every queued SOS
 * deliverable, and waiting up to a minute for it would be indefensible.
 */
export function startOutboxAutoFlush(
  opts: { intervalMs?: number; onDrained?: (r: DrainResult) => void } = {}
): () => void {
  if (typeof window === "undefined") return () => {};
  if (stopAutoFlush) return stopAutoFlush;

  const intervalMs = opts.intervalMs ?? AUTO_FLUSH_INTERVAL_MS;

  const kick = () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    void flushOutboxOnce()
      .then((r) => {
        if (r.sent > 0 || r.failed > 0 || r.dropped > 0) opts.onDrained?.(r);
      })
      .catch(() => {});
  };

  const onVisible = () => {
    if (document.visibilityState === "visible") kick();
  };

  kick();
  const timer = window.setInterval(kick, intervalMs);
  window.addEventListener("online", kick);
  document.addEventListener("visibilitychange", onVisible);

  stopAutoFlush = () => {
    window.clearInterval(timer);
    window.removeEventListener("online", kick);
    document.removeEventListener("visibilitychange", onVisible);
    stopAutoFlush = null;
  };
  return stopAutoFlush;
}
