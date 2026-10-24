// foreground.ts — PURE decision table for "why did the app come to the front?".
//
// The native shell answers that question (widget tap, alarm, reminder, system
// notification, boot) and the Web layer must turn it into exactly one behaviour.
// Keeping the mapping here, away from page.tsx, means the rules are testable and
// A only has to do:
//
//     onForeground(({ reason }) => {
//       const plan = planForeground(reason, locale);
//       if (plan.kind === "silent") return;
//       if (plan.kind === "listen") startListening(plan.say);
//       if (plan.kind === "speak") speakLine(plan.say);
//       if (plan.kind === "refresh") refreshReminders();
//     });
//
// Two rules worth stating out loud:
//
// * `boot` is SILENT. A reboot is not a reason to start talking in an empty room
//   at 3am; the shell only re-armed the alarms.
// * a widget tap LISTENS, it does not speak first: the senior already reached
//   for the app, so the next thing he expects is to be listened to, not lectured.
//
// Tested in src/selfcheck.ts.

import type { ForegroundReason } from "./native.ts";
import type { Locale } from "./types";

export type ForegroundPlan =
  | { kind: "silent" }
  /** open the mic and say one short line first */
  | { kind: "listen"; say: string }
  | { kind: "speak"; say: string }
  /** pull fresh reminder / card state, say nothing */
  | { kind: "refresh" };

/** Window event the native SOS hot zone dispatches (MainActivity). */
export const SOS_EVENT = "memomate:sos";

/** Re-tapping the widget inside this window must not page the family twice. */
export const SOS_DEBOUNCE_MS = 10_000;

const COPY: Record<Locale, { widget: string; alarm: string }> = {
  "zh-HK": {
    widget: "我喺度，有咩需要幫手？",
    alarm: "早晨，今日精神點？有冇邊度唔舒服？",
  },
  "zh-MO": {
    widget: "我喺度，有咩需要幫手？",
    alarm: "早晨，今日精神點？有冇邊度唔舒服？",
  },
  "zh-CN": {
    widget: "我在，有什么需要帮忙？",
    alarm: "早上好，今天精神怎么样？有没有哪里不舒服？",
  },
};

export function planForeground(reason: ForegroundReason, locale: Locale): ForegroundPlan {
  const copy = COPY[locale] ?? COPY["zh-HK"];
  switch (reason) {
    case "widget":
      return { kind: "listen", say: copy.widget };
    case "alarm":
      return { kind: "speak", say: copy.alarm };
    case "reminder":
    case "notification":
      // The reminder card / alert is already waiting in the UI; speaking over it
      // would fight with the reminder's own prompt.
      return { kind: "refresh" };
    case "boot":
      return { kind: "silent" };
    default:
      return { kind: "silent" };
  }
}

/**
 * Guards the widget SOS hot zone. The button sits on the lock screen, so a
 * pocket press or a double tap is realistic; only the first one escalates.
 */
export function shouldRaiseSos(lastAt: number | null, now: number, windowMs = SOS_DEBOUNCE_MS): boolean {
  if (lastAt === null || !Number.isFinite(lastAt)) return true;
  return now - lastAt >= windowMs;
}
