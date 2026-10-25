// foreground.ts — PURE decision table for "why did the app come to the front?".
//
// The native shell answers that question (widget tap, alarm, reminder, system
// notification, boot) and the Web layer must turn it into exactly one behaviour.
// Keeping the mapping here, away from page.tsx, means the rules are testable and
// A only has to do:
//
//     onForeground((e) => {
//       const plan = planOpen(e.open) ?? planForeground(e.reason, locale);
//       if (plan.kind === "silent") return;
//       if (plan.kind === "listen") startListening(plan.say);
//       if (plan.kind === "speak") speakLine(plan.say);
//       if (plan.kind === "refresh") refreshReminders();
//       if (plan.kind === "records") showTodayRecords();
//     });
//
// `planOpen` comes first because a tap on the widget's record row is a request
// to SEE today's records — the reason ("widget") would otherwise open the mic,
// which is the wrong answer to "did I take my pill?".
//
// Two rules worth stating out loud:
//
// * `boot` is SILENT. A reboot is not a reason to start talking in an empty room
//   at 3am; the shell only re-armed the alarms.
// * a widget tap LISTENS, it does not speak first: the senior already reached
//   for the app, so the next thing he expects is to be listened to, not lectured.
//
// Tested in src/selfcheck.ts.

import type { ForegroundReason, WidgetOpenTarget } from "./native.ts";
import type { Locale } from "./types";

export type ForegroundPlan =
  | { kind: "silent" }
  /** open the mic and say one short line first */
  | { kind: "listen"; say: string }
  | { kind: "speak"; say: string }
  /** pull fresh reminder / card state, say nothing */
  | { kind: "refresh" }
  /**
   * The widget's record row was tapped: show the 今日記錄 card. No mic, no
   * speech — he asked to SEE something, and a spoken "我喺度" would only delay
   * the list he reached for.
   */
  | { kind: "records" };

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

/**
 * The widget can name WHAT it wants opened (the closed set `WidgetOpenTarget`),
 * separately from WHY the app came forward. Returns null when there is no
 * target — the caller then falls back to `planForeground`.
 *
 * Kept apart from `planForeground` on purpose: the reason table stays a total
 * function of the reason alone, and A's existing `planForeground(reason, locale)`
 * call site keeps compiling untouched.
 */
export function planOpen(open: WidgetOpenTarget | undefined): ForegroundPlan | null {
  if (open === "record") return { kind: "records" };
  return null;
}

export function planForeground(reason: ForegroundReason, locale: Locale): ForegroundPlan {
  const copy = COPY[locale] ?? COPY["zh-HK"];
  switch (reason) {
    case "widget":
      return { kind: "listen", say: copy.widget };
    case "wake":
      // He said the assistant's name WHILE it was talking. That is a request to
      // stop and listen, so: open the mic, say nothing. It is the only
      // listen-with-no-greeting plan on purpose — a "我喺度" here would talk over
      // the very sentence he just interrupted, and delay the mic by ~1s.
      return { kind: "listen", say: "" };
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
