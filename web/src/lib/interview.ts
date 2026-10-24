// interview.ts — PURE. The daily 3-minute chat: item bank, item selection, stop
// rules, and the cue words both the interview and normal conversation react to.
// No DOM. Tested in src/selfcheck.ts. Spec: docs/dev.md §2.4 A1 / §2.5.
//
// Design rule: every item is an open, everyday topic with no right answer. The
// device never grades an answer and never corrects the senior — it only records
// derived numbers (how long, how many characters, timed out or not).

import { sameLocalDay } from "./proactive.ts";

export type InterviewDomain = "memory" | "orientation" | "language" | "daily_living" | "mood";

type Text = { hk: string; cn: string };

export interface InterviewItem {
  id: string;
  domain: InterviewDomain;
  prompt: Text;
  /** A hint when the senior is stuck — never the answer. */
  followUp?: Text;
  scoreHint: "recall" | "fluency" | "sequencing" | "orientation" | "self_report";
  /** Afterwards, gently say today's date (orientation support, not correction). */
  sayToday?: boolean;
}

export interface InterviewAnswer {
  id: string;
  at: number;
  durationMs: number;
  textLen: number;
  confidence: number;
  timedOut: boolean;
}

export type CareCue = "refuse" | "tired" | "sad" | "lost";

export interface InterviewState {
  startedAt: number;
  answers: InterviewAnswer[];
  stop?: Exclude<CareCue, "lost">;
}

/** Last time each item was asked. Persisted in the `meta` store. */
export type InterviewHistory = Record<string, { at: number; timedOut: boolean }>;

export const MAX_ITEMS = 4;
export const MAX_SESSION_MS = 180_000;
export const ANSWER_TIMEOUT_MS = 8_000;
const FRESH_MS = 7 * 86_400_000;
const DOMAINS: InterviewDomain[] = ["memory", "orientation", "language", "daily_living", "mood"];

export const ITEMS: InterviewItem[] = [
  { id: "memory-01", domain: "memory", scoreHint: "recall",
    prompt: { hk: "今朝食咗啲咩早餐呀？", cn: "今天早上吃了什么早餐呀？" },
    followUp: { hk: "粥、麵包、點心都得，諗到乜講乜。", cn: "粥、面包、点心都行，想到什么说什么。" } },
  { id: "memory-02", domain: "memory", scoreHint: "recall",
    prompt: { hk: "尋日做咗啲咩呀？有冇出過街？", cn: "昨天做了些什么呀？有没有出门？" },
    followUp: { hk: "譬如去咗街市、公園，定係喺屋企？", cn: "比如去了菜市场、公园，还是在家？" } },
  { id: "memory-03", domain: "memory", scoreHint: "recall",
    prompt: { hk: "最近有冇同屋企人或者朋友傾過電話？傾咗啲咩呀？", cn: "最近有没有和家人或朋友通过电话？聊了些什么呀？" },
    followUp: { hk: "記得幾多講幾多，唔使全部記得。", cn: "记得多少说多少，不用全记得。" } },
  { id: "orientation-01", domain: "orientation", scoreHint: "orientation", sayToday: true,
    prompt: { hk: "今日係星期幾呀？", cn: "今天是星期几呀？" },
    followUp: { hk: "唔肯定都唔緊要，估吓都得。", cn: "不确定也没关系，猜猜看也行。" } },
  { id: "orientation-02", domain: "orientation", scoreHint: "orientation", sayToday: true,
    prompt: { hk: "而家係朝早、下晝定係夜晚呀？", cn: "现在是早上、下午还是晚上呀？" } },
  { id: "orientation-03", domain: "orientation", scoreHint: "orientation",
    prompt: { hk: "你而家喺屋企邊度呀？客廳定係房？", cn: "您现在在家里哪个地方呀？客厅还是房间？" } },
  { id: "language-01", domain: "language", scoreHint: "fluency",
    prompt: { hk: "講幾樣街市買得到嘅生果畀我聽吓？", cn: "说几样菜市场能买到的水果给我听听？" },
    followUp: { hk: "譬如蘋果，仲有呢？", cn: "比如苹果，还有呢？" } },
  { id: "language-02", domain: "language", scoreHint: "fluency",
    prompt: { hk: "你最鍾意食邊味餸呀？點煮㗎？", cn: "您最喜欢吃哪道菜呀？怎么做的？" } },
  { id: "language-03", domain: "language", scoreHint: "fluency",
    prompt: { hk: "講幾隻動物嘅名畀我聽吓？", cn: "说几种动物的名字给我听听？" },
    followUp: { hk: "譬如貓，仲有呢？", cn: "比如猫，还有呢？" } },
  { id: "daily-01", domain: "daily_living", scoreHint: "sequencing",
    prompt: { hk: "沖一杯茶，要點樣做呀？", cn: "泡一杯茶，要怎么做呀？" },
    followUp: { hk: "第一步係做咩呢？", cn: "第一步做什么呢？" } },
  { id: "daily-02", domain: "daily_living", scoreHint: "sequencing",
    prompt: { hk: "你平時出街之前，要帶齊啲咩呀？", cn: "您平时出门前，要带好哪些东西呀？" },
    followUp: { hk: "譬如鎖匙，仲有呢？", cn: "比如钥匙，还有呢？" } },
  { id: "daily-03", domain: "daily_living", scoreHint: "recall",
    prompt: { hk: "今日有冇出去行吓？去咗邊呀？", cn: "今天有没有出去走走？去了哪里呀？" } },
  { id: "mood-01", domain: "mood", scoreHint: "self_report",
    prompt: { hk: "最近瞓得好唔好呀？", cn: "最近睡得好不好呀？" } },
  { id: "mood-02", domain: "mood", scoreHint: "self_report",
    prompt: { hk: "今日心情點呀？", cn: "今天心情怎么样呀？" } },
  { id: "mood-03", domain: "mood", scoreHint: "self_report",
    prompt: { hk: "最近有冇咩開心嘢想同我講？", cn: "最近有什么开心的事想跟我说？" } },
];

/** zh-HK and zh-MO share the written-Cantonese form (same rule as i18n.ts). */
export function textFor(x: Text, locale: string): string {
  return locale === "zh-CN" ? x.cn : x.hk;
}

/**
 * Next item, or null when nothing is left. Order: a domain not yet asked in this
 * session → not asked in the last 7 days → did not time out last time → the
 * day's rotating domain order → bank order. Never twice on one day.
 */
export function pickNext(s: InterviewState, h: InterviewHistory, now: number): InterviewItem | null {
  const inSession = new Set(s.answers.map((a) => a.id));
  const usedDomains = new Set(ITEMS.filter((i) => inSession.has(i.id)).map((i) => i.domain));
  const offset = Math.floor(now / 86_400_000) % DOMAINS.length;
  const key = (i: InterviewItem, idx: number): number[] => {
    const last = h[i.id];
    return [
      usedDomains.has(i.domain) ? 1 : 0,
      last && now - last.at < FRESH_MS ? 1 : 0,
      last?.timedOut ? 1 : 0,
      (DOMAINS.indexOf(i.domain) - offset + DOMAINS.length) % DOMAINS.length,
      idx,
    ];
  };
  const ranked = ITEMS.map((item, idx) => ({ item, k: key(item, idx) }))
    .filter(({ item }) => !inSession.has(item.id) && !(h[item.id] && sameLocalDay(h[item.id].at, now)))
    .sort((a, b) => {
      for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return a.k[i] - b.k[i];
      return 0;
    });
  return ranked[0]?.item ?? null;
}

export function shouldStop(s: InterviewState, now: number): boolean {
  return s.stop !== undefined || s.answers.length >= MAX_ITEMS || now - s.startedAt >= MAX_SESSION_MS;
}

// Order matters: a refusal wins over everything ("唔想講，好攰" ends politely).
const CUES: { cue: CareCue; words: string[] }[] = [
  { cue: "refuse", words: ["唔想講", "唔想讲", "不想说", "不想講", "唔講喇", "唔讲喇", "唔好問", "唔好问", "不要问", "别问", "唔想傾", "不想聊"] },
  { cue: "sad", words: ["唔開心", "唔开心", "不开心", "不開心", "難過", "难过", "傷心", "伤心", "想喊", "想哭", "好悶", "孤獨", "孤独"] },
  { cue: "tired", words: ["攰", "好累", "累了", "累喇", "想瞓", "想睡"] },
  { cue: "lost", words: ["唔見咗", "唔见咗", "唔見左", "搵唔到", "揾唔到", "找不到", "不见了", "不見了"] },
];

export function careCue(text: string): CareCue | null {
  const s = (text ?? "").toLowerCase();
  for (const c of CUES) if (c.words.some((w) => s.includes(w))) return c.cue;
  return null;
}

/** Spoken yes/no. `null` = not sure — callers MUST treat that as "no". */
export function isYes(text: string): boolean | null {
  const s = (text ?? "").trim().toLowerCase();
  if (!s) return null;
  if (["冇問題", "没问题", "無問題", "冇问题"].some((w) => s.includes(w))) return true;
  if (["唔係", "唔系", "不是", "唔好", "不好", "不要", "唔要", "唔使", "不用", "算了", "算啦", "唔得", "不行", "no"].some((w) => s.includes(w))) return false;
  if (["係", "系", "是", "好", "得", "要", "可以", "對", "对", "嗯", "ok", "yes"].some((w) => s.includes(w))) return true;
  return null;
}

/** "今日係10月24號，星期六。" — said after orientation items, never as a correction. */
export function todayLine(locale: string, now: number): string {
  const d = new Date(now);
  const w = "日一二三四五六"[d.getDay()];
  return locale === "zh-CN"
    ? `今天是${d.getMonth() + 1}月${d.getDate()}日，星期${w}。`
    : `今日係${d.getMonth() + 1}月${d.getDate()}號，星期${w}。`;
}
