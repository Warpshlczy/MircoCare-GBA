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
