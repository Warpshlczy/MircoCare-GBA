// cards.ts — PURE local card factory. Frontend-rendered cards, used as the
// offline fallback when the backend agent is unreachable (api.getAgentCards
// throws NOT_IMPLEMENTED today). No DOM. Tested in src/selfcheck.ts.

import { t } from "./i18n.ts";
import { formatWhen } from "./datetime.ts";
import { formatDistance } from "./geofence.ts";
import type { AgentCard, Intent, Locale, ReminderItem, Task } from "./types";

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
      // No live data (backend unreachable). Never invent a temperature — an
      // honest "not right now" is better than a fake 27°C the senior will act on.
      return [
        {
          id: `weather-${now}`,
          kind: "weather",
          title: t(locale, "weatherTitle"),
          createdAt: now,
          data: { icon: "🌤️", headline: t(locale, "weatherUnavailable") },
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

/**
 * Does the card say it will rain today? `undefined` when the card carries no
 * rain row at all (older backend, or the "no live data" fallback).
 */
export function weatherWillRain(card: AgentCard): boolean | undefined {
  const row = card.data?.rows?.find((r) => /雨|雪|雷/.test(r.label));
  if (!row) return undefined;
  return !/(冇|沒|没|唔會|不会|不會)/.test(row.value);
}

/**
 * Spoken version of exactly what the weather card shows — same words, in the
 * order the senior reads them. When the question was about rain, the direct
 * yes/no leads the sentence (issue #4: no dodging the question).
 */
export function weatherSpoken(card: AgentCard, locale: Locale, askedRain: boolean): string {
  const headline = (card.data?.headline ?? "").trim();
  if (!headline || headline === t(locale, "weatherUnavailable")) {
    return headline || t(locale, "weatherUnavailable");
  }
  const zhCN = locale === "zh-CN";
  const rain = weatherWillRain(card);
  const parts: string[] = [];
  if (askedRain && rain !== undefined) {
    parts.push(
      rain
        ? (zhCN ? "是的，今天会下雨。" : "係，今日會落雨。")
        : (zhCN ? "不会，今天不下雨。" : "唔係，今日唔會落雨。")
    );
  }
  parts.push(`${headline.replace(/\s+/g, " ")}。`);
  // Read every row the card shows. The rain row is skipped only when the
  // yes/no sentence above has already said the same thing.
  const rows = (card.data?.rows ?? []).filter((r) => !(askedRain && /雨|雪|雷/.test(r.label)));
  if (rows.length) parts.push(rows.map((r) => `${r.label}${r.value}。`).join(""));
  return parts.join("");
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

// ---------------------------------------------------------------------------
// B (agent layer) card factories: task / place / alarm / agentPlan.
//
// Copy stays local to this file on purpose: lib/i18n.ts belongs to A (§0.2) and
// has no keys for place/alarm/agentPlan yet. Fold these in once A agrees — the
// three locales are already written, so it is a mechanical move.
// ---------------------------------------------------------------------------

interface BCopy {
  taskSaved: string;
  taskDone: string;
  whenLabel: string;
  placeTitle: string;
  placeHome: string;
  placeAway: string; // "{d}" = formatted distance
  distanceLabel: string;
  alarmTitle: string;
  planTitle: string;
  planLead: string;
}

const B_COPY: Record<Locale, BCopy> = {
  "zh-HK": {
    taskSaved: "記住咗",
    taskDone: "做好咗",
    whenLabel: "幾時",
    placeTitle: "你喺邊",
    placeHome: "喺屋企附近",
    placeAway: "離屋企 {d}",
    distanceLabel: "距離",
    alarmTitle: "鬧鐘",
    planTitle: "我準備做",
    planLead: "我準備做呢幾件事",
  },
  "zh-MO": {
    taskSaved: "記住咗",
    taskDone: "做好咗",
    whenLabel: "幾時",
    placeTitle: "你喺邊",
    placeHome: "喺屋企附近",
    placeAway: "離屋企 {d}",
    distanceLabel: "距離",
    alarmTitle: "鬧鐘",
    planTitle: "我準備做",
    planLead: "我準備做呢幾件事",
  },
  "zh-CN": {
    taskSaved: "记住了",
    taskDone: "做完了",
    whenLabel: "什么时候",
    placeTitle: "你在哪",
    placeHome: "在家附近",
    placeAway: "离家 {d}",
    distanceLabel: "距离",
    alarmTitle: "闹钟",
    planTitle: "我准备做",
    planLead: "我准备做这几件事",
  },
};

/** A saved task as the senior sees it. `dueAt` only shows when it was spoken. */
export function taskCard(task: Task, locale: Locale, now: number): AgentCard {
  const copy = B_COPY[locale];
  return {
    id: `task-card-${task.id}`,
    kind: "task",
    title: task.done ? copy.taskDone : copy.taskSaved,
    createdAt: now,
    data: {
      checklist: [{ id: task.id, text: task.text, done: task.done }],
      rows: task.dueAt ? [{ label: copy.whenLabel, value: formatWhen(task.dueAt, locale) }] : undefined,
    },
  };
}

export interface PlaceInfo {
  distanceM: number;
  /** defaults to "within the fence radius" */
  nearHome?: boolean;
}

/** Whereabouts card. Text + distance only — we ship no map SDK (§3.4 B3). */
export function placeCard(info: PlaceInfo, locale: Locale, now: number): AgentCard {
  const copy = B_COPY[locale];
  const near = info.nearHome ?? info.distanceM <= 500;
  const dist = formatDistance(info.distanceM);
  return {
    id: `place-${now}`,
    kind: "place",
    title: copy.placeTitle,
    createdAt: now,
    data: {
      icon: near ? "🏠" : "📍",
      headline: near ? copy.placeHome : copy.placeAway.replace("{d}", dist),
      rows: [{ label: copy.distanceLabel, value: dist }],
    },
  };
}

export interface AlarmInfo {
  at: number;
  label: string;
}

export function alarmCard(info: AlarmInfo, locale: Locale, now: number): AgentCard {
  return {
    id: `alarm-${info.at}`,
    kind: "alarm",
    title: B_COPY[locale].alarmTitle,
    createdAt: now,
    data: {
      icon: "⏰",
      headline: info.label,
      rows: [{ label: B_COPY[locale].whenLabel, value: formatWhen(info.at, locale) }],
    },
  };
}

/**
 * "I'm about to do these 3 things" — shown BEFORE any `confirm` tool runs, so
 * the senior can veto the whole plan with one word.
 */
export function agentPlanCard(steps: string[], locale: Locale, now: number): AgentCard {
  return {
    id: `plan-${now}`,
    kind: "agentPlan",
    title: B_COPY[locale].planTitle,
    createdAt: now,
    data: {
      icon: "📋",
      headline: B_COPY[locale].planLead,
      checklist: steps.map((text, i) => ({ id: `plan-${now}-${i}`, text, done: false })),
    },
  };
}