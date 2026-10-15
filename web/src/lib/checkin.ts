// checkin.ts — PURE. Decides whether the assistant should proactively open a
// daily chat to check on the senior. No DOM. Tested in src/selfcheck.ts.
//
// ponytail: "a new day" is a LOCAL calendar-date comparison, not a 24h timer —
// the senior's morning is the trigger, not an elapsed duration. Ceiling: it fires
// on the next app open after midnight, never while the app is closed (a web page
// can't run a background cron). Upgrade path: native shell schedules a OS-level
// daily notification and calls the app forward.

/** True when `now` falls on a different local calendar day than `lastAt`. */
export function shouldCheckIn(lastAt: number | null, now: number): boolean {
  if (lastAt === null) return true;
  const a = new Date(lastAt);
  const b = new Date(now);
  return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth() || a.getDate() !== b.getDate();
}