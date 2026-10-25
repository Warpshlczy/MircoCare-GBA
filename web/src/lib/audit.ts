// audit.ts — "what the assistant ITSELF did", in words a family member can read.
//
// Two streams, two questions, deliberately not merged:
//   `records`  (recordStore.ts)  → what HE did: took a dose, measured BP
//   `agent_audit` (auditStore.ts) → what IT did: set an alarm for him, opened
//                                   an app, refused to transfer money
//
// The family screen needs both. A weekly report that only shows "食藥 08:12"
// cannot answer "did anything actually happen when he asked for help at 3pm",
// and a refusal ("he asked me to transfer money, I said no") is the single most
// valuable line in the whole product — it is the difference between "the
// assistant was silent" and "the assistant was working correctly".
//
// PURE FILE: no IndexedDB, no DOM, no fetch. `node src/selfcheck.ts` drives it.
// Storage lives in auditStore.ts, which imports this.

import { AUDIT_SUMMARY_MAX } from "./types.ts";
import type { AgentAuditEntry, AgentAuditOutcome, Locale } from "./types";

/**
 * zh-HK and zh-MO are the same language in this product (see toolExec.ts COPY),
 * so one helper keeps both keys in sync instead of duplicating every string and
 * letting them drift apart.
 */
const L = (hk: string, cn: string): Record<Locale, string> => ({
  "zh-HK": hk,
  "zh-MO": hk,
  "zh-CN": cn,
});

/**
 * The completed-action phrase for a tool that worked.
 *
 * Written as what the assistant DID, not as the tool's name: "較好鬧鐘" reads to
 * a daughter; "set_alarm" does not. Every entry is ≤ 6 code points so the
 * generic failure form below also fits the budget.
 */
const TOOL_OK: Record<string, Record<Locale, string>> = {
  sos: L("叫咗屋企人", "叫了家里人"),
  create_task: L("記低咗件事", "记下这件事"),
  complete_task: L("勾好咗", "打勾好了"),
  log_medication: L("記低咗食藥", "记下吃药了"),
  compose_card: L("整好張卡", "做好卡片了"),
  set_alarm: L("較好鬧鐘", "闹钟设好了"),
  locate: L("攞到位置", "拿到位置了"),
  navigate_home: L("睇咗距離", "看了距离"),
  plan_route: L("畀咗路線", "给了路线"),
  call_contact: L("開咗撥號", "打开拨号了"),
  send_message: L("發咗訊息", "发了消息"),
  open_app: L("開咗個app", "打开了app"),
  ui_tap_text: L("代你按咗掣", "代你按了按钮"),
  defer_task: L("推遲咗件事", "推迟了这件事"),
};

/**
 * The noun for a tool, used to say WHICH thing failed.
 *
 * "做唔到" alone is useless to a family member — they need to know it was the
 * alarm and not the phone call. Kept separate from TOOL_OK because the two
 * sentences have different grammar, not because one is derived from the other.
 */
const TOOL_NOUN: Record<string, Record<Locale, string>> = {
  sos: L("求救", "求救"),
  create_task: L("件事", "这件事"),
  complete_task: L("件事", "这件事"),
  log_medication: L("食藥", "吃药"),
  compose_card: L("張卡", "卡片"),
  set_alarm: L("鬧鐘", "闹钟"),
  locate: L("位置", "位置"),
  navigate_home: L("距離", "距离"),
  plan_route: L("路線", "路线"),
  call_contact: L("電話", "电话"),
  send_message: L("訊息", "消息"),
  open_app: L("app", "app"),
  ui_tap_text: L("按掣", "按钮"),
  defer_task: L("件事", "这件事"),
};

const GENERIC_OK = L("搞好咗", "办好了");
const FAILED_SUFFIX = L("做唔到", "没办成");
/**
 * A refusal is not a failure. It is the assistant doing its job: 转账/密码
 * requests land here by design (toolrun.ts#FORBIDDEN_WORDS), and the family must
 * be able to tell "it would not" apart from "it could not". Merging the two
 * would make a working safety guard look like a broken feature.
 */
const REFUSED_SUFFIX = L("冇做，拒絕咗", "没做，拒绝了");

/** Code-point truncation so an emoji or a CJK char is never split in half. */
function clipChars(s: string, max: number): string {
  const chars = Array.from(s.replace(/\s+/g, " ").trim());
  return chars.length <= max ? chars.join("") : chars.slice(0, max).join("");
}

/**
 * The ≤14-character line the family reads next to one tool.
 *
 * It NEVER contains a value from the call's arguments. That is the whole
 * redaction strategy: a phone number, a name, a coordinate or a task text can
 * only reach this function through `args`, and `args` is not an input — the tool
 * name and the outcome are. Server-side scrubbing (contract.py) is a second
 * layer, not the primary one.
 */
export function auditSummary(tool: string, outcome: AgentAuditOutcome, locale: Locale): string {
  const noun = TOOL_NOUN[tool]?.[locale];
  if (outcome === "ok") {
    const ok = TOOL_OK[tool]?.[locale] ?? GENERIC_OK[locale];
    return clipChars(ok, AUDIT_SUMMARY_MAX);
  }
  const suffix = outcome === "refused" ? REFUSED_SUFFIX[locale] : FAILED_SUFFIX[locale];
  // No noun (a tool we have not seen before): fall back to the bare outcome
  // rather than inventing a word. "做唔到" is vague but true; a wrong noun is not.
  const text = noun ? `${noun}${suffix}` : suffix;
  return clipChars(text, AUDIT_SUMMARY_MAX);
}

/**
 * One audit row.
 *
 * `at` is the moment the tool ran, so a row can be attributed to the right day
 * by the same `dayKey` every other stream uses. `id` is derived from tool+at so
 * a double-executed step collapses into one row instead of two — the outbox
 * replays batches, and a duplicated "鬧鐘" line would read as two alarms set.
 */
export function newAuditEntry(input: {
  tool: string;
  outcome: AgentAuditOutcome;
  locale: Locale;
  at: number;
  /** distinguishes two calls of the same tool inside one turn */
  seq?: number;
}): AgentAuditEntry {
  const seq = Number.isFinite(input.seq) ? Math.max(0, Math.trunc(input.seq as number)) : 0;
  return {
    id: `aa-${input.tool}-${input.at}-${seq}`,
    at: input.at,
    tool: input.tool,
    outcome: input.outcome,
    summary: auditSummary(input.tool, input.outcome, input.locale),
  };
}

/** Newest first, capped — the family screen shows one day, not an archive. */
export function auditForDay(rows: AgentAuditEntry[], day: string, limit = 20): AgentAuditEntry[] {
  return rows
    .filter((r) => typeof r.at === "number" && localDay(r.at) === day)
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

/** Local day key. Mirrors tasks.ts#dayKey, duplicated to keep this file import-free. */
function localDay(at: number): string {
  const d = new Date(at);
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
