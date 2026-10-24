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

import { TOOLS, toolByName, type ToolDecl, type ToolRisk } from "./tools.ts";
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
