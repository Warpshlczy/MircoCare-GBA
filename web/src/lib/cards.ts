// cards.ts — PURE local card factory. Frontend-rendered cards, used as the
// offline fallback when the backend agent is unreachable (api.getAgentCards
// throws NOT_IMPLEMENTED today). No DOM. Tested in src/selfcheck.ts.

import { t } from "./i18n.ts";
import { formatWhen } from "./datetime.ts";
import type { AgentCard, Intent, Locale, ReminderItem } from "./types";

export interface CardCtx {
  reminders: ReminderItem[];
  now: number;
}

function taskChecklist(reminders: ReminderItem[]): AgentCard["data"] {
  const open = reminders.filter((r) => r.status === "pending" || r.status === "taken");
  return {
    checklist: open.map((r) => ({ id: r.id, text: r.med?.name ?? r.title, done: r.status === "taken" })),
  };
}

/** Builds the deterministic cards this app can render without a backend. */
export function localCardsFor(intent: Intent, locale: Locale, ctx: CardCtx): AgentCard[] {
  const { now } = ctx;
  switch (intent) {
    case "weather":
      // ponytail: no weather API wired — demo values. Upgrade: backend agent
      // returns a real weather card (data or pre-rendered html).
      return [
        {
          id: `weather-${now}`,
          kind: "weather",
          title: t(locale, "weatherTitle"),
          createdAt: now,
          data: {
            icon: "☀️",
            headline: "27°C 天晴",
            rows: [
              { label: "湿度", value: "68%" },
              { label: "风速", value: "和缓" },
              { label: "提示", value: "出门带遮" },
            ],
          },
        },
      ];
    case "tasks":
    case "medication": {
      const data = taskChecklist(ctx.reminders);
      const empty = !data?.checklist?.length;
      return [
        {
          id: `tasks-${now}`,
          kind: intent === "medication" ? "med" : "task",
          title: t(locale, "tasksTitle"),
          createdAt: now,
          data: empty ? { headline: t(locale, "cardEmpty") } : data,
        },
      ];
    }
    default:
      return [];
  }
}

/** A card for a just-captured photo (frontend-rendered). */
export function photoCard(dataUrl: string, locale: Locale, now: number): AgentCard {
  return {
    id: `photo-${now}`,
    kind: "camera",
    title: t(locale, "cameraTitle"),
    createdAt: now,
    data: { image: dataUrl, headline: t(locale, "photoTaken") },
  };
}

/** A confirmation card for a scheduled follow-up / appointment reminder. */
export function followupCard(item: ReminderItem, locale: Locale, now: number): AgentCard {
  return {
    id: `followup-card-${item.id}`,
    kind: "info",
    title: t(locale, "followupCardTitle"),
    createdAt: now,
    data: {
      icon: "🏥",
      headline: item.title,
      rows: [{ label: t(locale, "reminderWhen"), value: formatWhen(item.dueAt, locale) }],
    },
  };
}

/**
 * Offline fallback for "say anything → a todo appears". The senior's own words
 * become the todo text. `utterance` MUST be non-empty (callers guard this).
 */
export function todoCardFromUtterance(utterance: string, locale: Locale, now: number): AgentCard {
  const text = utterance.trim();
  return {
    id: `todo-${now}`,
    kind: "task",
    title: t(locale, "todoSaved"),
    createdAt: now,
    data: { checklist: [{ id: `td-${now}`, text, done: false }] },
  };
}