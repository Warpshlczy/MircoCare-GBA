// analytics.ts — privacy-first 关键数据埋点.
//
// Binding rule (same contract as api.ts): events carry a NAME, a timestamp, the
// locale and coarse non-identifying props. NEVER free text, raw audio, sensor
// streams, health values or any PII. Events buffer in IndexedDB ("events") and
// are flushed to the backend in batches; a failed flush keeps them buffered.

import { all, del, put } from "./db";
import { postTelemetry } from "./api";
import type { Locale, TelemetryEvent } from "./types";

export function track(name: string, locale: Locale, props?: TelemetryEvent["props"]): void {
  const e: TelemetryEvent = {
    id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    at: Date.now(),
    locale,
    props,
  };
  void put("events", e);
}

export function pending(): Promise<TelemetryEvent[]> {
  return all<TelemetryEvent>("events");
}

/** Attempts to upload the buffer. Returns how many events were sent (0 if the
 *  backend stub throws — the buffer is preserved). */
export async function flush(): Promise<number> {
  const events = await pending();
  if (!events.length) return 0;
  try {
    await postTelemetry(events);
  } catch {
    return 0; // NOT_IMPLEMENTED / offline — keep the buffer
  }
  for (const e of events) await del("events", e.id);
  return events.length;
}