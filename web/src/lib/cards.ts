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