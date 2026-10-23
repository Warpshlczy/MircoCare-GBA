// Pure date/time formatting shared by cards and notes. No DOM.

import type { Locale } from "./types";

/** Locale-aware, 24-hour timestamp used on cards ("2026/10/25 09:00"). */
export function formatWhen(at: number, locale: Locale): string {
  const tag = locale === "zh-CN" ? "zh-CN" : "zh-HK";
  return new Date(at).toLocaleString(tag, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

const SLOTS: { words: string[]; hour: number }[] = [
  { words: ["早上", "朝早", "上午", "晨早", "morning"], hour: 8 },
  { words: ["中午", "lunch", "noon"], hour: 12 },
  { words: ["下午", "afternoon"], hour: 15 },
  { words: ["晚上", "夜晚", "傍晚", "evening"], hour: 20 },
  { words: ["睡前", "bedtime", "night"], hour: 22 },
];

/**
 * Maps a free-text medication schedule to the next plausible due time.
 * Unrecognized schedules fall back to one hour from now instead of firing
 * immediately (the old behaviour caused every generated reminder to pop at once).
 */
export function nextDueAt(schedule: string, now: number): number {
  const text = (schedule ?? "").toLowerCase();
  for (const slot of SLOTS) {
    if (slot.words.some((word) => text.includes(word))) {
      const due = new Date(now);
      due.setHours(slot.hour, 0, 0, 0);
      if (due.getTime() <= now) due.setDate(due.getDate() + 1);
      return due.getTime();
    }
  }
  return now + 60 * 60 * 1000;
}
