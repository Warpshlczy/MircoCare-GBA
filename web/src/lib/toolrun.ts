// toolrun.ts — PURE tool-call validation and planning. No execution, no DOM.
//
// The split matters: this file decides *whether* and *in what order* a call may
// run, and what we say to the senior. The actual side effects (dialler, alarm,
// accessibility service) are async, platform-bound, and live in W2's executor.
// Everything here is therefore testable in `node src/selfcheck.ts`.
//
// Three guards, in this order (docs/dev.md §3.4 B1):
//   1. refusal   — some requests must never become a tool call (转账/密码)
//   2. validation— unknown tool or bad args are dropped, never "best effort"
//   3. confirmation — `risk: "confirm"` needs a spoken yes before it runs

import { toolByName, type ToolDecl, type ToolRisk } from "./tools.ts";
import type { Locale, ToolCall } from "./types";

/** The backend contract caps a turn at 3 calls (docs/dev.md §3.5). */
export const MAX_CALLS_PER_TURN = 3;

// ---------------------------------------------------------------------------
// 1. Refusal — utterance level, before any tool is considered.
// ---------------------------------------------------------------------------

/**
 * `risk: "forbidden"` is not a tool (see tools.ts). It is this list: requests we
 * refuse outright, with zero calls, because a wrong action is irreversible.
 */
const FORBIDDEN_WORDS = [
  "转账",
  "轉賬",
  "轉帳",
  "转账",
  "汇款",
  "匯款",
  "付款",
  "过数",
  "過數",
  "俾钱",
  "畀钱",
  "给钱",
  "買股票",
  "买股票",
  "支付",
  "密码",
  "密碼",
  "验证码",
  "驗證碼",
  "otp",
  "transfer money",
  "password",
];

const REFUSE_COPY: Record<Locale, string> = {
  "zh-HK": "呢個我做唔到，要你自己或者屋企人做。",
  "zh-MO": "呢個我做唔到，要你自己或者屋企人做。",
  "zh-CN": "这个我做不了，得你自己或者家里人来做。",
};

/** Non-null = refuse, and say this. Null = not a forbidden request. */
export function refuseReason(utterance: string, locale: Locale): string | null {
  const s = (utterance ?? "").toLowerCase();
  if (!s.trim()) return null;
  return FORBIDDEN_WORDS.some((w) => s.includes(w.toLowerCase())) ? REFUSE_COPY[locale] : null;
}

// ---------------------------------------------------------------------------
// 2. Argument validation against the declared JSON Schema.
// ---------------------------------------------------------------------------

export interface Validation {
  ok: boolean;
  errors: string[];
}

function typeOk(expected: string, value: unknown): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return true; // unknown schema types are not our business
  }
}

/**
 * Strict: `additionalProperties: false` is enforced, because a hallucinated
 * field ("phone": "+852...") must not reach the dialler.
 */
export function validateArgs(tool: ToolDecl, args: Record<string, unknown>): Validation {
  const errors: string[] = [];
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, errors: ["args must be an object"] };
  }

  for (const req of tool.schema.required) {
    if (!(req in args) || args[req] === undefined || args[req] === null) {
      errors.push(`missing required "${req}"`);
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const prop = tool.schema.properties[key];
    if (!prop) {
      errors.push(`unexpected "${key}"`);
      continue;
    }
    if (!typeOk(prop.type, value)) {
      errors.push(`"${key}" must be ${prop.type}`);
      continue;
    }
    if (prop.enum && !prop.enum.includes(value as string)) {
      errors.push(`"${key}" must be one of ${prop.enum.join("|")}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function riskOf(name: string): ToolRisk | "unknown" {
  return toolByName(name)?.risk ?? "unknown";
}

// ---------------------------------------------------------------------------
// 3. Planning — what we will do, in what order, and what we say.
// ---------------------------------------------------------------------------

export interface PlannedStep {
  name: string;
  risk: ToolRisk;
  args: Record<string, unknown>;
  /** spoken BEFORE running; for `confirm` this is the question itself */
  say: string;
}

export interface RejectedCall {
  name: string;
  reason: "unknown_tool" | "invalid_args" | "too_many";
  detail?: string;
}

export interface CallPlan {
  steps: PlannedStep[];
  rejected: RejectedCall[];
}

const SAY: Record<string, Record<Locale, string>> = {
  sos: {
    "zh-HK": "我而家幫你叫人，唔好行開。",
    "zh-MO": "我而家幫你叫人，唔好行開。",
    "zh-CN": "我现在帮你叫人，先别走开。",
  },
  create_task: {
    "zh-HK": "好，我同你記住。",
    "zh-MO": "好，我同你記住。",
    "zh-CN": "好，我帮你记着。",
  },
  complete_task: {
    "zh-HK": "好，幫你勾咗。",
    "zh-MO": "好，幫你勾咗。",
    "zh-CN": "好，帮你勾掉了。",
  },
  log_medication: {
    "zh-HK": "好，我幫你記低食藥。",
    "zh-MO": "好，我幫你記低食藥。",
    "zh-CN": "好，我帮您记下吃药。",
  },
  compose_card: {
    "zh-HK": "好，我整好張卡。",
    "zh-MO": "好，我整好張卡。",
    "zh-CN": "好，我做好卡片。",
  },
  set_alarm: {
    "zh-HK": "好，鬧鐘較好喇。",
    "zh-MO": "好，鬧鐘較好喇。",
    "zh-CN": "好，闹钟设好了。",
  },
  locate: {
    "zh-HK": "我睇下你喺邊。",
    "zh-MO": "我睇下你喺邊。",
    "zh-CN": "我看一下你在哪。",
  },
  navigate_home: {
    "zh-HK": "我睇下你離屋企幾遠。",
    "zh-MO": "我睇下你離屋企幾遠。",
    "zh-CN": "我看一下你离家多远。",
  },
  plan_route: {
    "zh-HK": "我同你諗下點行。",
    "zh-MO": "我同你諗下點行。",
    "zh-CN": "我帮你想想怎么走。",
  },
};

function confirmQuestion(call: ToolCall, locale: Locale): string {
  const name = typeof call.args?.name === "string" ? call.args.name : "";
  if (call.name === "call_contact" && name) {
    return locale === "zh-CN" ? `是打给${name}吗？` : `係咪打畀${name}？`;
  }
  if (call.name === "send_message" && name) {
    return locale === "zh-CN" ? `是要发消息给${name}吗？` : `係咪發訊息畀${name}？`;
  }
  return locale === "zh-CN" ? "要我现在做这件事吗？" : "要唔要我而家做呢件事？";
}

function sayFor(call: ToolCall, risk: ToolRisk, locale: Locale): string {
  if (risk === "confirm") return confirmQuestion(call, locale);
  return SAY[call.name]?.[locale] ?? (locale === "zh-CN" ? "好，我做。" : "好，我做。");
}

/**
 * Turns the model's `calls` array into something executable, or explains why
 * not. Never throws: a bad turn degrades to "say it again", never to a crash.
 */
export function planCalls(calls: ToolCall[], locale: Locale): CallPlan {
  const steps: PlannedStep[] = [];
  const rejected: RejectedCall[] = [];

  for (const call of calls) {
    const name = (call?.name ?? "").trim();
    if (!name) {
      rejected.push({ name, reason: "unknown_tool", detail: "empty name" });
      continue;
    }
    const tool = toolByName(name);
    if (!tool) {
      rejected.push({ name, reason: "unknown_tool" });
      continue;
    }
    if (steps.length >= MAX_CALLS_PER_TURN) {
      rejected.push({ name, reason: "too_many", detail: `max ${MAX_CALLS_PER_TURN} per turn` });
      continue;
    }
    const args = (call.args ?? {}) as Record<string, unknown>;
    const v = validateArgs(tool, args);
    if (!v.ok) {
      rejected.push({ name, reason: "invalid_args", detail: v.errors[0] });
      continue;
    }
    steps.push({ name, risk: tool.risk, args, say: sayFor(call, tool.risk, locale) });
  }

  // Safety first: an SOS in the plan always runs before anything else.
  steps.sort((a, b) => (a.name === "sos" ? -1 : b.name === "sos" ? 1 : 0));
  return { steps, rejected };
}

/** Dry-run summary for the demo and for C's mock integration. */
export function dryRun(calls: ToolCall[], locale: Locale): string {
  const { steps, rejected } = planCalls(calls, locale);
  if (steps.length === 0) return "（冇動作）";
  const lines = steps.map((s, i) => `${i + 1}. ${s.name} ${JSON.stringify(s.args)} → ${s.say}`);
  if (rejected.length) lines.push(`略過：${rejected.map((r) => `${r.name}(${r.reason})`).join("、")}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 4. Local planning — the same agent loop, with no model in it.
// ---------------------------------------------------------------------------

/**
 * The route cues we trust. A bare "去" is deliberately absent: "我去咗街市"
 * is a report, not a request, and planning a route for it would be nonsense.
 * "路線" alone is absent for the same reason ("呢條路線好好" is a comment).
 */
const ROUTE_CUE =
  /(?:帶我去|带我去|帶我行|带我行|帶我走|带我走|點樣去|点样去|點去|点去|怎麼去|怎么去|怎樣去|怎样去|規劃路線|规划路线|規劃行程|规划行程)/;
const HOME_WORD = /(屋企|返家|回家|歸家|归家)/;

/**
 * "帶我去街市" → "街市"; "" → home; null → this is not a route request.
 *
 * Three outcomes, because "where" and "whether" are different questions: an
 * empty destination that also mentions 屋企 is the way home, while an empty
 * destination on its own ("帶我去") is too vague to plan and must fall through.
 */
export function routeDestination(utterance: string): string | null {
  const text = (utterance ?? "").trim();
  const m = ROUTE_CUE.exec(text);
  if (!m) return null;
  let rest = text.slice(m.index + m[0].length).replace(/^[，,。.：:\s]+/, "");
  rest = rest.replace(/^(去|到|返|往|行去|行到)/, "");
  rest = rest.replace(/[呀啦喇嘅呢嘛囉㗎。.！!？?~～\s]+$/g, "").trim();
  if (rest) return rest;
  return HOME_WORD.test(text) ? "" : null;
}

/**
 * What the DEVICE can plan with no model and no network.
 *
 * This is not a second agent: it is the same tool contract (`planCalls`
 * validates every argument below), so a locally planned turn runs through the
 * identical confirm → execute → speak path. Without it, a route request is
 * answered "好，我幫你記住" with nothing behind it — the exact complaint that
 * the assistant talks about the plan and then does nothing.
 *
 * Deliberately narrow. Weather is A's path (real data, answer sheet), and
 * `open_app`/`call_contact` stay model-driven because guessing a contact or an
 * app from a keyword is how a wrong person gets dialled.
 */
// --- medication, from the senior's own words --------------------------------

const MED_WORD = /(藥|药)/;
/** "I already took it" — note these are REPORT verbs, not reminder verbs. */
const MED_TAKEN_VERB = /(食咗|食完|食過|食过|吃咗|吃完|吃过|吃了|服咗|服了|飲咗|饮了|已食|已吃)/;
/** A question or a denial is not a report: "食咗藥未呀" must never log a dose. */
const NOT_A_REPORT = /(未|冇|沒|没|嗎|吗|？|\?|幾時|几时|邊時|哪时|唔記得|不记得)/;

/**
 * `undefined` = not a medication report; `null` = taken, no name said;
 * string = the medication name in the senior's own words.
 */
export function medTakenName(utterance: string): string | null | undefined {
  const text = (utterance ?? "").trim();
  if (!text || !MED_WORD.test(text) || !MED_TAKEN_VERB.test(text)) return undefined;
  if (NOT_A_REPORT.test(text)) return undefined;
  const rest = text.replace(/^.*?(?:食咗|食完|食過|食过|吃咗|吃完|吃过|吃了|服咗|服了|飲咗|饮了|已食|已吃)/, "");
  const m = /([A-Za-z0-9\u4e00-\u9fff]{1,10}(?:藥|药|片|丸|膠囊|胶囊))/.exec(rest);
  const name = (m?.[1] ?? "")
    .replace(/^(我|你|佢|佢嘅|已經|已经|啱啱|刚刚|剛剛|今日|今朝|今晚)/g, "")
    .trim();
  return /^(藥|药|食藥|食药|嘅藥|嘅药)$/.test(name) || !name ? null : name;
}

/** "提醒我食藥" / "記得食藥" → a task. A question does not create one. */
const MED_REMIND =
  /((提醒我|提我|記得|记得|記住|记住|夠鐘|够钟|夠時間|够时间).{0,10}(食藥|食药|吃药|服藥|服药))|((食藥|食药|吃药).{0,6}(提醒|提我))/;

const MEASURE_WORD = /(血壓|血压|血糖|體溫|体温|體重|体重|心跳|脉搏|脈搏)/;
const RECORD_WORD = /(記|记|錄|录|寫|写|保存)/;
const CARD_ASK = /(做張卡|做张卡|整張卡|整张卡|生成.{0,4}卡|寫張卡|写张卡|記低.{0,4}卡)/;

/** Script the device can write itself when the model is unavailable. */
function localCardScript(text: string): string {
  const num = /(\d{2,3}\s*[/／]\s*\d{2,3}|\d{1,3}(?:\.\d)?)/.exec(text)?.[1]?.replace(/\s+/g, "");
  return ["title: 健康記錄", "icon: 🩺", `headline: ${text}`, num ? `row: 數值 = ${num}` : ""]
    .filter(Boolean)
    .join("\n");
}

export function planLocal(utterance: string): ToolCall[] {
  const text = (utterance ?? "").trim();
  if (!text) return [];

  const destination = routeDestination(text);
  if (destination !== null) {
    return [{ name: "plan_route", args: destination ? { destination } : {} }];
  }
  const medName = medTakenName(text);
  if (medName !== undefined) {
    return [{ name: "log_medication", args: medName ? { name: medName } : {} }];
  }
  if (MED_REMIND.test(text)) {
    return [{ name: "create_task", args: { text } }];
  }
  if ((MEASURE_WORD.test(text) && RECORD_WORD.test(text)) || CARD_ASK.test(text)) {
    return [{ name: "compose_card", args: { script: localCardScript(text) } }];
  }
  if (/(我喺邊|我在哪|喺邊度|在边度|係邊度|where am i)/i.test(text)) {
    return [{ name: "locate", args: {} }];
  }
  if (/(返屋企|回家|離屋企幾遠|离家多远|离家几远|幾遠|几远|how far)/i.test(text)) {
    return [{ name: "navigate_home", args: {} }];
  }
  return [];
}
