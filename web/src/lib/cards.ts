// cards.ts — PURE local card factory. Frontend-rendered cards, used as the
// offline fallback when the backend agent is unreachable (api.getAgentCards
// throws NOT_IMPLEMENTED today). No DOM. Tested in src/selfcheck.ts.

import { t } from "./i18n.ts";
import { formatWhen } from "./datetime.ts";
import { formatDistance } from "./geofence.ts";
import type {
  AgentCard,
  CardChecklistItem,
  CardData,
  CardRow,
  Intent,
  Locale,
  RecordEntry,
  ReminderItem,
  Task,
} from "./types";

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
 * A walking plan: ordered steps on one screen, tickable, text only (§3.4 B3 —
 * we ship no map SDK). `title` is the destination in the senior's own words.
 */
export function routePlanCard(title: string, steps: string[], now: number): AgentCard {
  return {
    id: `route-${now}`,
    kind: "agentPlan",
    title,
    createdAt: now,
    data: {
      icon: "🧭",
      checklist: steps.map((text, i) => ({ id: `route-${now}-${i}`, text, done: false })),
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

// ---------------------------------------------------------------------------
// Records: what the senior already did, kept on the device.
// ---------------------------------------------------------------------------

function clockOf(at: number): string {
  const d = new Date(at);
  return `${`${d.getHours()}`.padStart(2, "0")}:${`${d.getMinutes()}`.padStart(2, "0")}`;
}

/** Today's durable records as one floatable card ("今日食藥 08:12"). */
export function recordsCard(records: RecordEntry[], locale: Locale, now: number): AgentCard {
  const rows = [...records].sort((a, b) => b.at - a.at).slice(0, 8);
  return {
    id: `records-${now}`,
    kind: "record",
    title: t(locale, "recordsTitle"),
    createdAt: now,
    data: rows.length
      ? {
          icon: "📝",
          checklist: rows.map((r) => ({
            id: r.id,
            text: `${clockOf(r.at)} ${r.title}${r.detail ? ` · ${r.detail}` : ""}`,
            done: true,
          })),
        }
      : { icon: "📝", headline: t(locale, "recordsEmpty") },
  };
}

/** The card a just-logged medication produces (also used by the voice tool). */
export function medRecordCard(name: string, at: number, locale: Locale): AgentCard {
  return {
    id: `med-rec-${at}`,
    kind: "record",
    title: t(locale, "recordsTitle"),
    createdAt: at,
    data: {
      icon: "💊",
      headline: t(locale, "medLogged"),
      checklist: [{ id: `med-rec-${at}`, text: `${clockOf(at)} ${name}`, done: true }],
    },
  };
}

/** Open chores as a tickable card; ticking one really completes it. */
export function tasksCard(tasks: Task[], locale: Locale, now: number): AgentCard {
  const open = tasks.filter((task) => !task.done).slice(0, 8);
  return {
    id: `tasks-${now}`,
    kind: "task",
    title: t(locale, "tasksTitle"),
    createdAt: now,
    data: open.length
      ? { icon: "✅", checklist: open.map((task) => ({ id: task.id, text: task.text, done: false })) }
      : { icon: "✅", headline: t(locale, "cardEmpty") },
  };
}

// ---------------------------------------------------------------------------
// Card scripts — the agent writes a tiny plain-text DSL, NOT HTML.
//
// The model gets ONE string field (the tool schema only supports flat scalar
// properties), so it can compose a record/summary card without any HTML, JS or
// URL ever reaching the renderer. Unknown lines are ignored; nothing is
// interpreted as code. Pure and asserted in selfcheck.ts.
// ---------------------------------------------------------------------------

const SCRIPT_ROWS = 8;
const SCRIPT_CHECKS = 12;

function cleanLine(text: string): string {
  return text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

export interface CardScript {
  title: string;
  data: CardData;
}

/** Parses `title: / icon: / headline: / row: a = b / check: [x] text`. */
export function parseCardScript(script: string): CardScript | null {
  const lines = (script ?? "").split(/\r?\n/);
  let title = "";
  let icon = "";
  let headline = "";
  const rows: CardRow[] = [];
  const checklist: CardChecklistItem[] = [];

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const m = /^([a-z]+)\s*[:：]\s*(.+)$/i.exec(line);
    if (!m) return;
    const key = m[1].toLowerCase();
    const value = cleanLine(m[2]);
    if (!value) return;
    if (key === "title" && !title) title = value;
    else if (key === "icon" && !icon) icon = value.slice(0, 4);
    else if (key === "headline" && !headline) headline = value;
    else if (key === "row" && rows.length < SCRIPT_ROWS) {
      const sep = /^(.+?)\s*[=＝]\s*(.+)$/.exec(value);
      if (sep) rows.push({ label: cleanLine(sep[1]).slice(0, 12), value: cleanLine(sep[2]) });
      else rows.push({ label: "", value });
    } else if (key === "check" && checklist.length < SCRIPT_CHECKS) {
      const box = /^\[(x|X|✓| )\]\s*(.*)$/.exec(value);
      const done = !!box && box[1].toLowerCase() !== " ";
      const text = box ? cleanLine(box[2]) : value;
      if (text) checklist.push({ id: `script-${i}`, text, done });
    }
  });

  if (!title && !icon && !headline && rows.length === 0 && checklist.length === 0) return null;
  return {
    title: title || t("zh-HK", "recordsTitle"),
    data: {
      icon: icon || undefined,
      headline: headline || undefined,
      rows: rows.length ? rows : undefined,
      checklist: checklist.length ? checklist : undefined,
    },
  };
}

export function cardFromScript(script: CardScript, now: number, id = `script-card-${now}`): AgentCard {
  return { id, kind: "record", title: script.title, createdAt: now, data: script.data };
}