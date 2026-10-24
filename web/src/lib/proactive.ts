// proactive.ts — PURE. Decides whether the assistant should start talking on its
// own, and why. No DOM. Tested in src/selfcheck.ts. Rules: docs/dev.md §2.4 A2.
//
// ponytail: "today" is the device's LOCAL calendar day and quiet hours read the
// device clock. A senior who changes time zone (HK ↔ 横琴 share one) is fine; a
// wrong device clock shifts the quiet window with it. Upgrade path: none needed
// until the product leaves UTC+8.

export type ProactiveKind = "reminder" | "silence" | "interview" | "greeting";
export type ProactiveTrigger = "tick" | "open" | "alarm" | "boot";

export interface ProactiveCtx {
  now: number;
  trigger: ProactiveTrigger;
  lastSpokeAt: number | null;
  /** As stored; ignored when `lastSpokeAt` was on an earlier day. */
  spokenToday: number;
  lastInteractionAt: number | null;
  /** When today's (or the last) interview started. */
  interviewAt: number | null;
  hasDueReminder: boolean;
}

export interface ProactiveAction {
  kind: ProactiveKind;
  reason: string;
  silentDays: number;
}

/** The persisted slice of ProactiveCtx (one `meta` row). */
export interface ProactiveRecord {
  id: "proactive";
  lastSpokeAt: number | null;
  spokenToday: number;
  lastInteractionAt: number | null;
  interviewAt: number | null;
}

export const DAILY_BUDGET = 3;
export const MIN_GAP_MS = 90 * 60 * 1000;
export const QUIET_FROM_HOUR = 21;
export const QUIET_TO_HOUR = 8;
export const SILENCE_DAYS = 2;
/** From this many silent days on, the care line also teaches the wake word. */
export const WAKE_HINT_DAYS = 3;

export function emptyProactiveRecord(): ProactiveRecord {
  return { id: "proactive", lastSpokeAt: null, spokenToday: 0, lastInteractionAt: null, interviewAt: null };
}

function midnight(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function sameLocalDay(a: number, b: number): boolean {
  return midnight(a) === midnight(b);
}

/** Whole local calendar days between two instants (DST-safe via rounding). */
export function calendarDaysBetween(from: number, to: number): number {
  return Math.round((midnight(to) - midnight(from)) / 86_400_000);
}

export function isQuietHour(now: number): boolean {
  const h = new Date(now).getHours();
  return h >= QUIET_FROM_HOUR || h < QUIET_TO_HOUR;
}

export function planProactive(c: ProactiveCtx): ProactiveAction | null {
  const silentDays = c.lastInteractionAt === null ? 0 : calendarDaysBetween(c.lastInteractionAt, c.now);
  const act = (kind: ProactiveKind, reason: string): ProactiveAction => ({ kind, reason, silentDays });

  if (c.hasDueReminder) return act("reminder", "due reminder (allowed in quiet hours)");
  if (c.trigger === "boot") return null; // boot only re-arms alarms; never startle
  if (isQuietHour(c.now)) return null;

  const spoken = c.lastSpokeAt !== null && sameLocalDay(c.lastSpokeAt, c.now) ? c.spokenToday : 0;
  const budgetLeft = spoken < DAILY_BUDGET && (c.lastSpokeAt === null || c.now - c.lastSpokeAt >= MIN_GAP_MS);
  if (budgetLeft) {
    // Silence care before the interview: two silent days imply no interview
    // today either, so the reverse order would never reach this branch.
    if (silentDays >= SILENCE_DAYS) return act("silence", `${silentDays} silent days`);
    if (c.interviewAt === null || !sameLocalDay(c.interviewAt, c.now)) return act("interview", "no interview today");
  }
  // The senior opened the app themselves — answering is not an interruption.
  if (c.trigger === "open") return act("greeting", "app opened");
  return null;
}

/** Record that a budgeted proactive line was spoken. PURE. */
export function recordSpoke(r: ProactiveRecord, now: number): ProactiveRecord {
  const spoken = r.lastSpokeAt !== null && sameLocalDay(r.lastSpokeAt, now) ? r.spokenToday : 0;
  return { ...r, lastSpokeAt: now, spokenToday: spoken + 1 };
}
