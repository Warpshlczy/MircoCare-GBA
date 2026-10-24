// agent.ts — the turn orchestration. PURE: no fetch, no IndexedDB, no DOM.
//
// Everything that touches the outside world is INJECTED (requestTurn / runTool /
// confirm). That keeps the order of operations testable under plain `node`, and
// it means this file has no dependency on C's backend or on B's native shell —
// both arrive later as arguments.
//
// Order is deliberate and mirrors docs/dev.md §3.4 B1:
//   refuse → local card → backend turn → plan calls → confirm → execute
// A refusal or a local card never reaches the network; a backend failure
// degrades to "I didn't catch that", never to a crash.

import { localCardsFor } from "./cards.ts";
import { parseIntent } from "./intent.ts";
import { planCalls, refuseReason } from "./toolrun.ts";
import { TOOLS } from "./tools.ts";
import type { PlannedStep } from "./toolrun.ts";
import type {
  AgentCard,
  AgentTurnRequest,
  AgentTurnResponse,
  Locale,
  ReminderItem,
  Task,
} from "./types";

/** Intents the local card factory can satisfy without any backend. */
export const LOCAL_CARD_INTENTS = new Set(["weather", "tasks", "medication"]);

export interface ToolExecResult {
  ok: boolean;
  /** spoken after the call; must be senior-legible, never an error code */
  message?: string;
}

export interface AgentDeps {
  locale: Locale;
  now: number;
  reminders: ReminderItem[];
  tasks: Task[];
  /** ≤10 latest turns, oldest first. Empty is fine. */
  recentTurns?: { role: "user" | "assistant"; text: string }[];
  /** backend turn; resolve null when unavailable (501 / 503 / offline). */
  requestTurn?: (req: AgentTurnRequest) => Promise<AgentTurnResponse | null>;
  /** tool executor; omit when the native shell is not wired yet. */
  runTool?: (step: PlannedStep) => Promise<ToolExecResult>;
  /** spoken yes/no; resolves false on decline or silence. */
  confirm?: (question: string) => Promise<boolean>;
}

export interface ExecutedCall {
  name: string;
  ok: boolean;
  message?: string;
}

export interface SkippedCall {
  name: string;
  reason: "declined" | "no_executor" | "invalid";
  /** why it was skipped — for the audit trail, never spoken to the senior */
  detail?: string;
}

export interface TurnOutcome {
  /** false = not ours; the caller keeps its existing path. */
  handled: boolean;
  refused: boolean;
  reply: string;
  cards: AgentCard[];
  steps: PlannedStep[];
  executed: ExecutedCall[];
  skipped: SkippedCall[];
}

const COPY: Record<Locale, { refusedFallback: string; notWired: string; failed: string; nothing: string }> = {
  "zh-HK": {
    refusedFallback: "呢個我做唔到，要你自己或者屋企人做。",
    notWired: "呢個功能仲未接好，我記低咗，轉頭再試。",
    failed: "有啲做唔到，你試多次或者叫屋企人幫手。",
    nothing: "我唔係好肯定，你再講一次？",
  },
  "zh-MO": {
    refusedFallback: "呢個我做唔到，要你自己或者屋企人做。",
    notWired: "呢個功能仲未接好，我記低咗，轉頭再試。",
    failed: "有啲做唔到，你試多次或者叫屋企人幫手。",
    nothing: "我唔係好肯定，你再講一次？",
  },
  "zh-CN": {
    refusedFallback: "这个我做不了，得你自己或者家里人来做。",
    notWired: "这个功能还没接好，我记下来了，回头再试。",
    failed: "有些没做成，你再试一次或者让家里人帮忙。",
    nothing: "我不太确定，你再说一次？",
  },
};

function emptyOutcome(): TurnOutcome {
  return { handled: false, refused: false, reply: "", cards: [], steps: [], executed: [], skipped: [] };
}

function buildTurnRequest(utterance: string, deps: AgentDeps): AgentTurnRequest {
  return {
    utterance,
    locale: deps.locale,
    now: deps.now,
    context: {
      recentTurns: deps.recentTurns ?? [],
      openTasks: deps.tasks
        .filter((t) => !t.done)
        .slice(-5)
        .map((t) => ({ id: t.id, text: t.text, dueAt: t.dueAt })),
    },
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, schema: t.schema })),
  };
}

/**
 * Runs one senior utterance end to end (minus the outer speech layer).
 * Never throws: every failure path resolves to something speakable.
 */
export async function runTurn(utterance: string, deps: AgentDeps): Promise<TurnOutcome> {
  const text = (utterance ?? "").trim();
  const copy = COPY[deps.locale];
  if (!text) return emptyOutcome();

  // 1. Refusal beats everything — including a backend that would happily act.
  const refuse = refuseReason(text, deps.locale);
  if (refuse) {
    return { ...emptyOutcome(), handled: true, refused: true, reply: refuse };
  }

  // 2. Local card: fast, offline, and identical to what the app already does.
  const intent = parseIntent(text);
  if (LOCAL_CARD_INTENTS.has(intent)) {
    const cards = localCardsFor(intent, deps.locale, { reminders: deps.reminders, now: deps.now });
    if (cards.length > 0) {
      return { ...emptyOutcome(), handled: true, cards };
    }
  }

  // 3. Backend turn (optional).
  if (!deps.requestTurn) return emptyOutcome();

  let res: AgentTurnResponse | null = null;
  try {
    res = await deps.requestTurn(buildTurnRequest(text, deps));
  } catch {
    res = null;
  }
  if (!res) {
    return { ...emptyOutcome(), handled: true, reply: copy.nothing };
  }

  // 4. Validate the calls against OUR registry — never trust the model's names.
  const plan = planCalls(res.calls ?? [], deps.locale);
  const skipped: SkippedCall[] = plan.rejected.map((r) => ({
    name: r.name,
    // unknown tool / bad args / too many calls are all "this cannot run".
    reason: "invalid",
    detail: `${r.reason}${r.detail ? `: ${r.detail}` : ""}`,
  }));

  // 5. Confirm + execute, in the planner's order (sos first).
  const executed: ExecutedCall[] = [];
  for (const step of plan.steps) {
    if (step.risk === "confirm") {
      const yes = deps.confirm ? await deps.confirm(step.say) : false;
      if (!yes) {
        skipped.push({ name: step.name, reason: "declined" });
        continue;
      }
    }
    if (!deps.runTool) {
      skipped.push({ name: step.name, reason: "no_executor" });
      continue;
    }
    try {
      const out = await deps.runTool(step);
      executed.push({ name: step.name, ok: out.ok, message: out.message });
    } catch {
      executed.push({ name: step.name, ok: false });
    }
  }

  // 6. Assemble the spoken reply: the agent's line, then honest status.
  const parts: string[] = [];
  if (res.reply) parts.push(res.reply);
  if (skipped.some((s) => s.reason === "no_executor")) parts.push(copy.notWired);
  if (executed.some((e) => !e.ok)) parts.push(copy.failed);
  const reply = parts.join(" ").trim() || (plan.steps.length > 0 ? "" : copy.nothing);

  return {
    handled: true,
    refused: false,
    reply,
    cards: res.cards ?? [],
    steps: plan.steps,
    executed,
    skipped,
  };
}
