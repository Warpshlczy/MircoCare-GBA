// care.ts — "signals worth asking about", NOT emotion recognition.
//
// The boundary this file enforces, and why it exists:
//
//   The device can observe that interaction dropped, that we failed to hear the
//   senior three times, that he mentioned discomfort, that he woke at night. It
//   CANNOT observe sadness, loneliness, anxiety or depression. Treating the first
//   list as evidence of the second is the single most dangerous mistake this
//   product could make — it would tell a family their parent is depressed when
//   he simply held the phone too far from his mouth, or was tired, or had the TV
//   on, or never liked talking much.
//
// So every output here is an OBSERVATION plus an OPEN QUESTION. Never a label.
// The senior-facing line asks; it never concludes. The caregiver-facing line
// reports what happened and suggests a call; it never names a condition.
//
// Silence alone is deliberately NOT a signal. A day with zero interactions and
// no personal baseline produces nothing at all: "we did not observe" and "he
// withdrew" are different facts, and only the second one deserves a phone call.
//
// Tested in src/selfcheck.ts, including a scan proving no copy names a condition.

import type { Locale } from "./types";

export type CareSignal =
  | "fewer_interactions"
  | "repeated_unheard"
  | "repeated_question"
  | "pain_mentions"
  | "night_activity"
  | "falls_or_sos";

/**
 * Per-day counters. EVERY field is nullable on purpose: a counter that was never
 * measured must not be passed as 0, or the drop rule below would fire on a
 * device that simply does not track that thing yet.
 */
export interface CareCounters {
  /** utterances + deliberate taps handled that day */
  interactions: number | null;
  /** times the assistant could not make out what was said */
  unheard: number | null;
  /** times the same question was asked again (from local conversation only) */
  repeats: number | null;
  /** times the senior said something hurt — counted on-device, never uploaded */
  painMentions: number | null;
  nightWakeCount: number | null;
  fallEvents: number | null;
  /**
   * Times help was actually SENT, not times the SOS screen was opened.
   * Opening the overlay and cancelling within the 15s countdown is a mistap, and
   * counting it would fire `falls_or_sos` at a senior who merely fumbled the
   * phone — then the family gets paged for nothing, which is how the app gets
   * muted before the day it matters. Increment on the send path only.
   */
  sosEvents: number | null;
}

export interface CareInput {
  today: Partial<CareCounters>;
  /**
   * Personal median over the previous ~14 days, per counter. With no baseline
   * there is no "less than usual" — only an absolute count — so the comparison
   * rules simply do not fire.
   */
  baseline?: Partial<CareCounters>;
}

/** Thresholds, exported so the demo slide and the tests cannot drift apart. */
export const CARE = {
  /** today < 60% of the personal median ... */
  dropRatio: 0.6,
  /** ... and only when that median is meaningful (>= 5 interactions/day) */
  minBaselineInteractions: 5,
  unheardAtLeast: 3,
  repeatsAtLeast: 3,
  painAtLeast: 3,
  nightWakeAtLeast: 3,
} as const;

/**
 * Words this module must never emit. Kept next to the copy, checked in
 * selfcheck, because the easiest way to break this file is a well-meaning
 * copy edit.
 */
export const DIAGNOSIS_WORDS = [
  "抑鬱", "抑郁", "depress",
  "情緒低落", "情绪低落",
  "孤獨", "孤独", "lonely",
  "焦慮", "焦虑", "anxiety",
  "認知障礙", "认知障碍", "腦退化", "脑退化",
  "阿茲海默", "阿尔茨海默", "dementia", "alzheimer",
  "抑鬱症", "抑郁症",
] as const;

// Deliberately NOT in the list: 「精神」. It reads as a diagnosis in 「精神差」
// but is ordinary Cantonese in 「今日精神點？」, which is the daily check-in this
// product already asks and the phrase the design doc itself uses. A word-level
// scan cannot tell those apart, and a guard that cries wolf on the greeting
// would get deleted within a week.

export function mentionsDiagnosis(text: string): boolean {
  const hay = (text ?? "").toLowerCase();
  return DIAGNOSIS_WORDS.some((w) => hay.includes(w.toLowerCase()));
}

/**
 * Words that report bodily discomfort — the `pain_mentions` counter's vocabulary.
 *
 * WHY THIS IS SEPARATE FROM `careCue`: `interview.ts#careCue` answers "should the
 * interview stop and hand over to a human?" and its four cues (refuse / tired /
 * sad / lost) are about the CONVERSATION. A said plainly in issue #1 that
 * counting `sad` or `tired` as pain would report a low mood as a physical
 * problem, which is the exact misreading this module forbids. So pain gets its
 * own list, and `careCue` is left alone.
 *
 * Coverage rule: the senior is 70-90 and may speak Cantonese, Mandarin, or a
 * mix, often one short clause. So the list is short, high-frequency, and
 * body-located — not a medical vocabulary ("心悸", "眩晕" are not how he talks).
 */
export const PAIN_WORDS = [
  "痛", "疼",
  "唔舒服", "不舒服", "难受", "難受",
  "頭暈", "头晕", "暈", "晕",
  "作嘔", "作呕", "想呕", "想嘔", "反胃",
  "發燒", "发烧", "發冷", "发冷",
  "咳", "氣促", "气促", "喘唔到", "喘不到", "抖唔到氣", "抖不到气",
  "肚屙", "肚泻", "肚痾", "拉肚子",
  "食唔落", "吃不下", "冇胃口", "没胃口",
] as const;

/**
 * Negations are stripped BEFORE the scan, because 「我唔痛」 contains 痛 and a
 * word-level match would report pain for the sentence that denies it. Missing a
 * real complaint costs one unasked question; inventing one costs the family's
 * trust in every future alert.
 *
 * Longest first so 「冇唔舒服」 is removed before 「唔舒服」 is matched.
 */
const PAIN_NEGATIONS = [
  "冇唔舒服", "没有不舒服", "沒有不舒服", "冇不舒服",
  "唔痛", "不痛", "冇痛", "没痛", "無痛", "无痛",
  "唔疼", "不疼", "冇疼", "没疼",
  "唔暈", "不晕", "冇暈", "没晕",
  "冇事", "没事", "沒事", "冇問題", "没问题", "沒問題",
  "唔使擔心", "不用担心", "唔緊要", "不要紧",
] as const;

export function mentionsPain(text: string): boolean {
  let hay = (text ?? "").toLowerCase();
  if (!hay.trim()) return false;
  for (const n of PAIN_NEGATIONS) hay = hay.split(n).join("");
  return PAIN_WORDS.some((w) => hay.includes(w.toLowerCase()));
}

/**
 * Counts pain reports in one day's utterances. Returns null when nothing was
 * heard at all, so "a silent day" never becomes "zero complaints" — see the
 * header of this file.
 */
export function countPainMentions(utterances: readonly string[]): number | null {
  const heard = utterances.filter((u) => typeof u === "string" && u.trim().length > 0);
  if (heard.length === 0) return null;
  return heard.reduce((n, u) => n + (mentionsPain(u) ? 1 : 0), 0);
}

/**
 * Report-only hearing proxy: the share of interactions the device could hear.
 * 1 = everything was understood, 0 = nothing was. `null` when there were no
 * interactions at all (absence of evidence, not evidence of deafness).
 *
 * This is NOT an audiogram and must never be presented as one — it is dominated
 * by the TV, the distance to the microphone and how loudly he speaks. It goes in
 * the weekly report next to "代理指标"，and never into a risk score.
 */
export function hearingProxyFrom(counters: Partial<CareCounters>): number | null {
  const interactions = num(counters.interactions);
  const unheard = num(counters.unheard);
  if (interactions === null || interactions <= 0 || unheard === null) return null;
  return Math.round(Math.max(0, 1 - unheard / interactions) * 100) / 100;
}

/**
 * Every counter, in a fixed order. Exported so the store and the tests iterate
 * the same list — a counter added here and forgotten there is a silent blind
 * spot in the baseline.
 */
export const CARE_KEYS = [
  "interactions",
  "unheard",
  "repeats",
  "painMentions",
  "nightWakeCount",
  "fallEvents",
  "sosEvents",
] as const;

export const BASELINE = {
  /** look back this many days */
  windowDays: 14,
  /**
   * Fewer than this many measured days -> no baseline for that counter.
   * Two quiet days are not a "usual level"; a median over 2 points is noise
   * dressed as a reference range.
   */
  minDays: 5,
} as const;

/**
 * Storage key for one day's counters (`meta` KV, `care_day.<YYYY-MM-DD>`).
 *
 * Lives here, in the pure module, so both IO layers can agree on it without
 * importing each other: `careStore` writes it, `behaviourStore` reads it to
 * derive the hearing proxy. A shared literal in one place beats a circular
 * import between two IndexedDB modules.
 */
export const CARE_DAY_PREFIX = "care_day.";

/** Drops anything that is not a finite non-negative number. */
export function normalizeCounters(input: Partial<CareCounters> | null | undefined): Partial<CareCounters> {
  const out: Partial<CareCounters> = {};
  if (!input) return out;
  for (const key of CARE_KEYS) {
    const v = num(input[key]);
    if (v !== null) out[key] = v;
  }
  return out;
}

/**
 * Median of the non-null samples, or null when there are not enough of them.
 * Median rather than mean: one 40-interaction day (a birthday, a visit) must
 * not raise the bar so high that every ordinary day looks like withdrawal.
 */
export function medianOrNull(values: (number | null | undefined)[], minDays = BASELINE.minDays): number | null {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (nums.length < Math.max(1, minDays)) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/**
 * Personal baseline from previous days' counters. Keys without enough data are
 * OMITTED (not set to 0), so the comparison rules stay silent instead of
 * comparing today against a made-up usual level.
 */
export function baselineFrom(
  days: readonly (Partial<CareCounters> | null | undefined)[],
  minDays = BASELINE.minDays
): Partial<CareCounters> {
  const out: Partial<CareCounters> = {};
  for (const key of CARE_KEYS) {
    const median = medianOrNull(days.map((d) => d?.[key] ?? null), minDays);
    if (median !== null) out[key] = median;
  }
  return out;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Observations, strongest first. The array is ordered so callers can take the
 * first one; a senior should hear ONE sentence, not a list of findings.
 */
export function careSignals(input: CareInput): CareSignal[] {
  const t = input.today ?? {};
  const b = input.baseline ?? {};
  const out: CareSignal[] = [];

  const falls = num(t.fallEvents);
  const sos = num(t.sosEvents);
  if ((falls ?? 0) > 0 || (sos ?? 0) > 0) out.push("falls_or_sos");

  if ((num(t.painMentions) ?? 0) >= CARE.painAtLeast) out.push("pain_mentions");

  const interactions = num(t.interactions);
  const baseInteractions = num(b.interactions);
  if (
    interactions !== null &&
    baseInteractions !== null &&
    baseInteractions >= CARE.minBaselineInteractions &&
    interactions < baseInteractions * CARE.dropRatio
  ) {
    out.push("fewer_interactions");
  }

  if ((num(t.unheard) ?? 0) >= CARE.unheardAtLeast) out.push("repeated_unheard");
  if ((num(t.nightWakeCount) ?? 0) >= CARE.nightWakeAtLeast) out.push("night_activity");
  if ((num(t.repeats) ?? 0) >= CARE.repeatsAtLeast) out.push("repeated_question");

  return out;
}

interface Copy {
  /** spoken to the senior: an open question, never a conclusion */
  ask: Record<CareSignal, string>;
  /** shown to the family: what happened + what to do */
  caregiver: Record<CareSignal, string>;
}

const COPY: Record<Locale, Copy> = {
  "zh-HK": {
    ask: {
      falls_or_sos: "我見你今日有跌倒或者叫過人幫手，而家行得OK嗎？要唔要我叫屋企人？",
      pain_mentions: "你今日講過幾次唔舒服，而家係咪仲有邊度痛？",
      fewer_interactions: "我見你今日好似少講咗啲嘢，係咪有邊度唔舒服？要唔要我叫屋企人？",
      repeated_unheard: "我今日有幾次聽唔清楚你講嘢，而家講嘢我聽得到嗎？",
      night_activity: "你琴晚好似醒咗幾次，係咪瞓得唔好？",
      repeated_question: "你今日問咗幾次同一件事，係咪有啲嘢唔放心？",
    },
    caregiver: {
      falls_or_sos: "今日有跌倒或求助紀錄，建議盡快聯絡長者。",
      pain_mentions: "長者今日多次表達身體唔舒服，建議聯絡確認。",
      fewer_interactions: "今日互動較平時減少，建議聯絡長者確認情況。",
      repeated_unheard: "今日多次未能聽清長者說話，可能同聽力、收音距離或者環境有關，建議確認。",
      night_activity: "夜間活動次數較平時多，建議了解睡眠情況。",
      repeated_question: "今日多次重複同一個問題，建議主動聯絡。",
    },
  },
  "zh-MO": {
    ask: {
      falls_or_sos: "我見你今日有跌倒或者叫過人幫手，而家行得OK嗎？要唔要我叫屋企人？",
      pain_mentions: "你今日講過幾次唔舒服，而家係咪仲有邊度痛？",
      fewer_interactions: "我見你今日好似少講咗啲嘢，係咪有邊度唔舒服？要唔要我叫屋企人？",
      repeated_unheard: "我今日有幾次聽唔清楚你講嘢，而家講嘢我聽得到嗎？",
      night_activity: "你琴晚好似醒咗幾次，係咪瞓得唔好？",
      repeated_question: "你今日問咗幾次同一件事，係咪有啲嘢唔放心？",
    },
    caregiver: {
      falls_or_sos: "今日有跌倒或求助紀錄，建議盡快聯絡長者。",
      pain_mentions: "長者今日多次表達身體唔舒服，建議聯絡確認。",
      fewer_interactions: "今日互動較平時減少，建議聯絡長者確認情況。",
      repeated_unheard: "今日多次未能聽清長者說話，可能同聽力、收音距離或者環境有關，建議確認。",
      night_activity: "夜間活動次數較平時多，建議了解睡眠情況。",
      repeated_question: "今日多次重複同一個問題，建議主動聯絡。",
    },
  },
  "zh-CN": {
    ask: {
      falls_or_sos: "我看到你今天有跌倒或者求助过，现在走路还行吗？要不要我叫家里人？",
      pain_mentions: "你今天说过几次不舒服，现在还有哪里疼吗？",
      fewer_interactions: "我发现你今天说话比平时少一些，是不是哪里不舒服？需要我通知家人吗？",
      repeated_unheard: "我今天有几次没听清你说话，现在说话我能听到吗？",
      night_activity: "你昨晚好像醒了几次，是不是没睡好？",
      repeated_question: "你今天问了几次同一件事，是不是有什么不放心？",
    },
    caregiver: {
      falls_or_sos: "今天有跌倒或求助记录，建议尽快联系长者。",
      pain_mentions: "长者今天多次表达身体不适，建议联系确认。",
      fewer_interactions: "今天互动比平时减少，建议联系长者确认情况。",
      repeated_unheard: "今天多次未能听清长者说话，可能与听力、收音距离或环境有关，建议确认。",
      night_activity: "夜间活动次数比平时多，建议了解睡眠情况。",
      repeated_question: "今天多次重复同一个问题，建议主动联系。",
    },
  },
};

/**
 * The ONE sentence to say out loud, or null when there is nothing worth raising.
 * Strongest signal wins — asking five questions is worse than asking none.
 */
export function careLine(signals: readonly CareSignal[], locale: Locale): string | null {
  const first = signals[0];
  if (!first) return null;
  return COPY[locale].ask[first] ?? COPY["zh-HK"].ask[first];
}

/** What the family sees. A report plus a suggestion — never a condition. */
export function caregiverLine(signals: readonly CareSignal[], locale: Locale): string | null {
  const first = signals[0];
  if (!first) return null;
  return COPY[locale].caregiver[first] ?? COPY["zh-HK"].caregiver[first];
}

/**
 * C's `interactionTrend` block from `GET /caregiver/overview` — the same
 * comparison this file makes, but computed over uploaded (closed) days on the
 * server, so it works on a family phone that has none of the local counters.
 *
 * Mirrored rather than imported: the family client must not depend on
 * `api.ts` types to render one sentence, and a field the server renames should
 * break a build, not a demo. `decreased` is C's decision — we only phrase it.
 */
export interface InteractionTrend {
  today: number;
  baselineMedian: number;
  deltaPct: number | null;
  decreased: boolean;
  samples: number;
}

export function caregiverLineFromTrend(trend: InteractionTrend | null | undefined, locale: Locale): string | null {
  if (!trend || !trend.decreased) return null;
  const pct = trend.deltaPct === null ? null : Math.round(Math.abs(trend.deltaPct) * 100);
  const copy: Record<Locale, (p: number | null) => string> = {
    "zh-HK": (p) =>
      `最近一日互動 ${trend.today} 次，比之前中位數 ${trend.baselineMedian} 次${p === null ? "少" : `少約 ${p}%`}，建議聯絡長者確認情況。`,
    "zh-MO": (p) =>
      `最近一日互動 ${trend.today} 次，比之前中位數 ${trend.baselineMedian} 次${p === null ? "少" : `少約 ${p}%`}，建議聯絡長者確認情況。`,
    "zh-CN": (p) =>
      `最近一天互动 ${trend.today} 次，比此前中位数 ${trend.baselineMedian} 次${p === null ? "偏少" : `少约 ${p}%`}，建议联系长者确认情况。`,
  };
  return (copy[locale] ?? copy["zh-HK"])(pct);
}

/**
 * One-tap path for the senior screen: the same call, but only when the system
 * has enough evidence to be worth interrupting him.
 */
export function carePrompt(input: CareInput, locale: Locale): string | null {
  return careLine(careSignals(input), locale);
}
