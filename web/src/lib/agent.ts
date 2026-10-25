// agent.ts — the turn orchestration. PURE: no fetch, no IndexedDB, no DOM.
//
// Everything that touches the outside world is INJECTED (requestTurn / runTool /
// confirm). That keeps the order of operations testable under plain `node`, and
// it means this file has no dependency on C's backend or on B's native shell —
// both arrive later as arguments.
//
// Order is deliberate and mirrors docs/dev.md §3.4 B1:
//   refuse → local card → backend turn → plan calls → confirm → execute
// A refusal or a local card never reaches the network. A backend failure is
// NOT "handled": we hand the turn back (`handled: false`) so the caller's
// pre-agent path still runs — speaking a generic apology there would be a
// regression against the behaviour the app already had.

import { localCardsFor } from "./cards.ts";
import { isQuestion, parseIntent } from "./intent.ts";
import { fitUtterance } from "./speech.ts";
import { planCalls, planLocal, refuseReason } from "./toolrun.ts";
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
// `weather` is deliberately NOT here: the local weather card has no live data,
// so it must go through A's own path (real card, spoken answer, answer sheet).
export const LOCAL_CARD_INTENTS = new Set(["tasks", "medication"]);

/** How many turns of history travel with a request (contract: ≤10, oldest first). */
export const MAX_RECENT_TURNS = 10;

export interface RecentTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * Appends one turn and keeps the last `MAX_RECENT_TURNS`.
 *
 * Why this is not just `[...turns, t].slice(-10)`: an empty or whitespace-only
 * turn is not a turn. Pushing one would teach the model that the senior
 * sometimes says nothing, which is exactly the kind of "quiet = withdrawn"
 * inference this product must not encourage.
 */
export function appendTurn(
  turns: readonly RecentTurn[],
  turn: RecentTurn,
  limit = MAX_RECENT_TURNS
): RecentTurn[] {
  const text = (turn.text ?? "").trim();
  if (!text) return [...turns];
  return [...turns, { role: turn.role, text }].slice(-limit);
}

/** The only fields of GET /health this client cares about. */
export interface HealthLike {
  llmIntegration?: string | null;
}

/**
 * FAIL CLOSED. `AURA_LLM_ENABLED=true` without an API key leaves the backend
 * answering 200 with a fixed "我帮你记住了" echo (config.llm_available does not
 * check the key). The health endpoint is the only way to tell a real planner
 * from that echo, so anything unrecognised — a 502, a renamed field, an older
 * backend — must mean "keep the local path", never "assume it works".
 */
export function isLlmReady(health: HealthLike | null | undefined): boolean {
  return health?.llmIntegration === "enabled";
}

export interface ToolExecResult {
  ok: boolean;
  /** spoken after the call; must be senior-legible, never an error code */
  message?: string;
  /** cards the tool itself produced (a route plan, a place…) */
  cards?: AgentCard[];
}

export interface AgentDeps {
  locale: Locale;
  now: number;
  reminders: ReminderItem[];
  tasks: Task[];
  /** ≤10 latest turns, oldest first. Empty is fine. */
  recentTurns?: RecentTurn[];
  /** backend turn; resolve null when unavailable (501 / 503 / offline). */
  requestTurn?: (req: AgentTurnRequest) => Promise<AgentTurnResponse | null>;
  /**
   * Which tools this build can actually perform. Checked BEFORE the confirm
   * question: asking "shall I call 阿明?" and then admitting we cannot dial is
   * worse than never asking. Omit it only when `runTool` is absent entirely.
   */
  canRun?: (name: string) => boolean;
  /** tool executor; omit when the native shell is not wired yet. */
  runTool?: (step: PlannedStep) => Promise<ToolExecResult>;
  /** spoken yes/no; resolves false on decline or silence. */
  confirm?: (question: string) => Promise<boolean>;
  /**
   * How many turns in a row already failed to be understood (0 on a good day).
   * The bridge owns this counter; the turn itself only decides what to say.
   */
  confusedStreak?: number;
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
  /**
   * false = 这一轮我们其实没听懂（既没规划出工具、也没给卡片、也没回答）。
   * 桥用它累计"连续听不懂"的次数，到 `CONFUSED_ESCALATE_AFTER` 就换出口。
   */
  understood: boolean;
  reply: string;
  cards: AgentCard[];
  steps: PlannedStep[];
  executed: ExecutedCall[];
  skipped: SkippedCall[];
}

/**
 * Offline spoken fallbacks. Each slot is a POOL, not a sentence: the senior
 * should never hear the same line twice in a row (issue #2). These are only
 * used when the model cannot answer at all.
 */
const COPY: Record<
  Locale,
  { refusedFallback: string[]; notWired: string[]; unknownTool: string[]; outOfScope: string[]; failed: string[]; nothing: string[] }
> = {
  "zh-HK": {
    refusedFallback: [
      "呢個我做唔到，要你自己或者屋企人做。",
      "呢件事我幫唔到手，你同屋企人講聲好嗎？",
      "我唔可以幫你做呢樣，要你本人或者屋企人處理。",
    ],
    notWired: [
      "呢個功能仲未接好，我記低咗，轉頭再試。",
      "呢樣嘢我暫時做唔到，已經記低咗。",
      "呢個掣仲未駁通，你遲啲再叫我試。",
    ],
    unknownTool: [
      "呢樣我未識做，你講第二樣啦。",
      "呢樣嘢我未學識，對唔住。",
      "呢樣我未識搞，你叫屋企人幫你啦。",
    ],
    // 能力边界：设备上真的没有这个工具。说"做不到"，并给一个人，不建待办。
    outOfScope: [
      "呢樣我真係做唔到，你叫屋企人幫你。",
      "我未識做呢樣，要屋企人幫手。",
      "呢件事超出我能力，你同屋企人講。",
    ],
    failed: [
      "有啲做唔到，你試多次或者叫屋企人幫手。",
      "今次差少少，再講一次好嗎？",
      "做唔成，你慢慢再試，或者叫屋企人幫你。",
    ],
    nothing: [
      "我唔係好肯定，你再講一次？",
      "我未聽得明，你慢慢講多一次？",
      "你再講清楚少少，我驚聽錯。",
    ],
  },
  "zh-MO": {
    refusedFallback: [
      "呢個我做唔到，要你自己或者屋企人做。",
      "呢件事我幫唔到手，你同屋企人講聲好嗎？",
      "我唔可以幫你做呢樣，要你本人或者屋企人處理。",
    ],
    notWired: [
      "呢個功能仲未接好，我記低咗，轉頭再試。",
      "呢樣嘢我暫時做唔到，已經記低咗。",
      "呢個掣仲未駁通，你遲啲再叫我試。",
    ],
    unknownTool: [
      "呢樣我未識做，你講第二樣啦。",
      "呢樣嘢我未學識，對唔住。",
      "呢樣我未識搞，你叫屋企人幫你啦。",
    ],
    outOfScope: [
      "呢樣我真係做唔到，你叫屋企人幫你。",
      "我未識做呢樣，要屋企人幫手。",
      "呢件事超出我能力，你同屋企人講。",
    ],
    failed: [
      "有啲做唔到，你試多次或者叫屋企人幫手。",
      "今次差少少，再講一次好嗎？",
      "做唔成，你慢慢再試，或者叫屋企人幫你。",
    ],
    nothing: [
      "我唔係好肯定，你再講一次？",
      "我未聽得明，你慢慢講多一次？",
      "你再講清楚少少，我驚聽錯。",
    ],
  },
  "zh-CN": {
    refusedFallback: [
      "这个我做不了，得你自己或者家里人来做。",
      "这件事我帮不上，您跟家里人说一声好吗？",
      "这个我不能替您做，要您本人或者家里人来处理。",
    ],
    notWired: [
      "这个功能还没接好，我记下来了，回头再试。",
      "这个我暂时做不到，已经记下来了。",
      "这个按钮还没接好，您晚点再叫我试。",
    ],
    unknownTool: [
      "这个我不会做，您说别的吧。",
      "这个我还没学会，对不起。",
      "这个我不会弄，您让家里人帮您吧。",
    ],
    outOfScope: [
      "这个我真的做不了，您让家里人帮您。",
      "这个我不会做，得家里人帮忙。",
      "这件事超出我的能力，您跟家里人说。",
    ],
    failed: [
      "有些没做成，你再试一次或者让家里人帮忙。",
      "这次差一点，再说一次好吗？",
      "没做成，您慢慢再试，或者叫家里人帮您。",
    ],
    nothing: [
      "我不太确定，你再说一次？",
      "我没听明白，您慢慢再说一遍？",
      "您再说清楚一点，我怕听错。",
    ],
  },
};

const pick = (pool: string[]): string => pool[Math.floor(Math.random() * pool.length)];

/**
 * Requests this device has NO tool for.
 *
 * Why this exists: the offline fallback turns "any utterance" into a todo, so
 * 「你能帮我做个 PDF 吗」used to answer 「好，幫你記低咗」 — a capability QUESTION
 * was silently turned into a promise nothing would ever fulfil. The senior
 * cannot tell the difference, and the family report gains a chore that does not
 * exist.
 *
 * The rule is an explicit allow-list of things we genuinely cannot do, never a
 * "unknown verb" guess: a false negative (we miss one) costs nothing, while a
 * false positive tells him "I can't" about something the app actually does.
 * Supported asks (call someone, set an alarm, remember a chore, plan a route)
 * are matched by `planLocal` first and never reach this check.
 */
const OUT_OF_SCOPE: readonly RegExp[] = [
  // Documents / files we cannot read, write or export.
  /(?:做|整|寫|写|印|生成|製作|制作|導出|导出|下載|下载).{0,8}(?:pdf|word|excel|ppt|文檔|文档|文件|檔案|档案|表格|簡報|简报|幻灯片|圖片|图片)/i,
  // Mail is a free-text channel; we only share whitelisted templates.
  /(?:發|发|寫|写|回|寄).{0,6}(?:郵件|邮件|電郵|电邮|email|e-mail)/i,
  // Hardware we do not drive.
  /(?:打印|列印|掃描|扫描|傳真|传真)/,
  // Bookings / commerce / clinical appointments: a wrong action is irreversible.
  /(?:掛號|挂号|掛.{0,2}號|挂.{0,2}号)/,
  /(?:網購|网购|落單|下单|購物|购物)/,
  // Video calls and programming are outside an elder-care assistant.
  /(?:視頻通話|视频通话|視像通話|视像通话)/,
  /(?:寫程式|写程序|寫代碼|写代码|編程|编程)/,
];

/** Non-null = this request is outside the product's capability set. */
export function outOfScopeRequest(utterance: string): boolean {
  const text = utterance ?? "";
  // A supported local action claims the turn first: 「帶我去打印店」 mentions 打印
  // but is a ROUTE request, and answering "I can't print" would be a regression.
  if (planLocal(text).length > 0) return false;
  return OUT_OF_SCOPE.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Talking TO the assistant is not a task.
//
// 「能听到我说话吗」used to reach the offline todo fallback and answer
// 「好，幫你記低咗」 — a question about whether the device can hear was filed as
// a chore. These patterns are deliberately narrow (the assistant's own hearing /
// presence / identity), so a real request that merely contains 你 or 聽 is not
// swallowed.
// ---------------------------------------------------------------------------

const SOCIAL: { re: RegExp; reply: Record<Locale, string> }[] = [
  {
    re: /(?:你|妳).{0,4}(?:聽|听)(?:得)?(?:到|見|见|明)|(?:能|可以|可否).{0,3}(?:聽|听)(?:得)?(?:到|見|见).{0,4}我/,
    reply: {
      "zh-HK": "我聽到，你慢慢講。",
      "zh-MO": "我聽到，你慢慢講。",
      "zh-CN": "我听到了，您慢慢说。",
    },
  },
  {
    re: /(?:你|妳).{0,2}(?:喺|在)(?:唔|不)?(?:喺|在)度|你在吗|你還喺度/,
    reply: {
      "zh-HK": "我喺度，你講。",
      "zh-MO": "我喺度，你講。",
      "zh-CN": "我在，您说。",
    },
  },
  {
    re: /你(?:係|是)(?:咪|不是)?(?:人|機械|机械|機械人|机器人|ai|AI)|你叫咩名|你叫什么/,
    reply: {
      "zh-HK": "我係憶伴，陪你講嘢嘅。",
      "zh-MO": "我係憶伴，陪你講嘢嘅。",
      "zh-CN": "我是忆伴，陪您说话的。",
    },
  },
];

/** A direct answer to "can you hear me / are you there / who are you", or null. */
export function socialReply(utterance: string, locale: Locale): string | null {
  const text = utterance ?? "";
  for (const s of SOCIAL) {
    if (s.re.test(text)) return s.reply[locale] ?? s.reply["zh-HK"];
  }
  return null;
}

/** "提醒我…" / "記住…" turn a question INTO an action; nothing else does. */
const REMEMBER_CUE = /(記住|记住|記得|记得|提醒|提我|叫我|幫我記|帮我记)/;
/** Tools that CREATE something. For a plain question they are never right. */
const MUTATING_CALLS = new Set(["create_task", "log_medication", "compose_card", "defer_task"]);

/**
 * 连续第几次"没听懂"之后不再要求他重说，而是给他一个人。
 *
 * 为什么要这条界线：`nothing` 池里三句都是"你再说一次"。第一次是提示，
 * 第三次就是**推卸**——认知退化的长者不会在第三次突然想明白该怎么说，他会
 * 停下来不再说话。而那之后的两天里，我们的行为流只会看到"互动变少"，把他
 * 的技术失败记成社交退缩，然后去关怀、去告警。一次听不清不该变成一次误判。
 *
 * 出口必须是人，不是重试。也不给"救命"之类的急救词——老人会把任何能叫来人的
 * 词当口头禅用，那会把假 SOS 变成日常。这里给的是最朴素的那一句：叫屋企人帮。
 */
export const CONFUSED_ESCALATE_AFTER = 2;

const ESCAPE: Record<Locale, string> = {
  "zh-HK": "我聽唔明，你叫屋企人幫你啦。",
  "zh-MO": "我聽唔明，你叫屋企人幫你啦。",
  "zh-CN": "我没听明白，您让家里人帮您吧。",
};

function emptyOutcome(): TurnOutcome {
  return {
    handled: false,
    refused: false,
    understood: true,
    reply: "",
    cards: [],
    steps: [],
    executed: [],
    skipped: [],
  };
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
  if (!text) return emptyOutcome();

  // 1. Refusal beats everything — including a backend that would happily act.
  const refuse = refuseReason(text, deps.locale);
  if (refuse) {
    return { ...emptyOutcome(), handled: true, refused: true, reply: refuse };
  }

  // 1b. "Can you hear me?" is a question about the assistant, not a chore.
  //     Answer it here so it can never reach the tool planner or the todo
  //     fallback ("好，幫你記低咗" was the reported failure).
  const social = socialReply(text, deps.locale);
  if (social) {
    return { ...emptyOutcome(), handled: true, reply: social };
  }

  // 2. Local tool intent first: "我食咗藥" reports a dose and must WRITE a
  // record, not render the medication checklist card. Only when no tool can
  // act do we fall back to the local card for the same utterance.
  const localCalls = planLocal(text).filter((c) => (deps.canRun ? deps.canRun(c.name) : true));

  // 2b. Capability boundary: what the device cannot do is said out loud and is
  // NEVER filed as a todo (see OUT_OF_SCOPE). Checked only when no local tool
  // claimed the turn, so 「帶我去打印店」 still plans a route.
  if (localCalls.length === 0 && outOfScopeRequest(text)) {
    return { ...emptyOutcome(), handled: true, reply: pick(COPY[deps.locale].outOfScope) };
  }

  const intent = parseIntent(text);
  if (localCalls.length === 0 && LOCAL_CARD_INTENTS.has(intent)) {
    const cards = localCardsFor(intent, deps.locale, { reminders: deps.reminders, now: deps.now });
    if (cards.length > 0) {
      return { ...emptyOutcome(), handled: true, cards };
    }
  }

  // 3. Backend turn (optional).
  //
  // The model is tried first, but it is not the only planner: `planLocal` below
  // is what makes the agent work when the model is off, slow, or answers a route
  // request with "好，我幫你記住" and no call at all. That asymmetry — talking
  // about the plan but doing nothing — is the exact failure this guards.
  let res: AgentTurnResponse | null = null;
  if (deps.requestTurn) {
    try {
      res = await deps.requestTurn(buildTurnRequest(text, deps));
    } catch {
      res = null;
    }
  }

  const modelCalls = res?.calls ?? [];
  const modelCards = res?.cards ?? [];
  // A plain QUESTION must not create anything. The model (and the mock) reach
  // for `create_task` as a catch-all, which is how 「能听到我说话吗」became
  // 「幫你記住咗」. Drop mutating calls unless he actually asked to remember.
  const askOnly = isQuestion(text) && !REMEMBER_CUE.test(text);
  const cleanModelCalls = askOnly ? modelCalls.filter((c) => !MUTATING_CALLS.has(c.name)) : modelCalls;

  // A medication REPORT is deterministic: "我食咗藥" must write a record.
  // The backend mock (and any planner that has not learned the tool yet) still
  // answers `create_task`, which would turn a taken dose into a chore and never
  // reach `records`. The device plan wins unless the model itself chose
  // `log_medication` — then the model's richer args (name/note) are kept.
  const medReport = localCalls.some((c) => c.name === "log_medication");
  const modelLoggedMed = cleanModelCalls.some((c) => c.name === "log_medication");
  const calls =
    medReport && !modelLoggedMed
      ? localCalls
      : cleanModelCalls.length > 0 || modelCards.length > 0
        ? cleanModelCalls
        : localCalls;

  // Everything the model proposed was a mutation on a plain question, and it
  // said nothing useful: hand the turn back so A's chat path can answer it.
  if (askOnly && cleanModelCalls.length === 0 && !(res?.reply ?? "").trim() && modelCards.length === 0) {
    return emptyOutcome();
  }

  if (!res && calls.length === 0) {
    // No answer from the model AND nothing this device can plan: not ours.
    // `handled: false` returns the utterance to the caller's original
    // `runIntent` path — the behaviour the app shipped with. Claiming `true`
    // here would swallow that path and leave the senior hearing "I didn't
    // catch that" instead of the old answer.
    //
    // Note the distinction: a backend that DID answer with an empty reply is
    // not the same as no backend. That turn is ours, and `composeReply` picks
    // "我未聽得明" / the caregiver escape from it (see the confused-streak test).
    return emptyOutcome();
  }

  // 4. Validate the calls against OUR registry — never trust the model's names.
  const plan = planCalls(calls, deps.locale);
  const skipped: SkippedCall[] = plan.rejected.map((r) => ({
    name: r.name,
    // unknown tool / bad args / too many calls are all "this cannot run".
    reason: "invalid",
    detail: `${r.reason}${r.detail ? `: ${r.detail}` : ""}`,
  }));

  // 5. Confirm + execute, in the planner's order (sos first).
  const executed: ExecutedCall[] = [];
  const toolCards: AgentCard[] = [];
  for (const step of plan.steps) {
    if (deps.canRun && !deps.canRun(step.name)) {
      // Cannot be performed in this build — skip it silently rather than
      // asking for permission we would then have to withdraw.
      skipped.push({ name: step.name, reason: "no_executor" });
      continue;
    }
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
      if (out.cards?.length) toolCards.push(...out.cards);
      executed.push({ name: step.name, ok: out.ok, message: out.message });
    } catch {
      executed.push({ name: step.name, ok: false });
    }
  }

  // 6. Assemble the spoken reply.
  //
  // 只挑**一句**，不拼接（speech.ts 的第 3 条理由）。
  // 之前这里是 parts.join(" ")：两个工具都成功时，长者在一次呼吸里听到两件事，
  // 而且字幕（13–14 字）连第一件都装不下 —— 第二件必然落在可视区外。
  // 现在"发生了什么"完整留在 `executed`（审计与卡片），"该说哪一句"由
  // composeReply 按优先级决定，读者只有一个：他本人。
  const doneLines = executed.filter((e) => e.ok && e.message).map((e) => e.message as string);
  const failLines = executed.filter((e) => !e.ok && e.message).map((e) => e.message as string);
  const reply = composeReply({
    doneLines,
    failLines,
    executed,
    skipped,
    plannerReply: res?.reply ?? "",
    hadSteps: plan.steps.length > 0,
    locale: deps.locale,
    confusedStreak: deps.confusedStreak,
  });

  // "Did we actually understand him?" — a tool plan, a card or a real answer
  // all mean yes. Nothing at all means the turn went nowhere; the bridge counts
  // those, because two in a row is when the app should stop asking him to repeat.
  const cards = [...modelCards, ...toolCards];
  const understood =
    plan.steps.length > 0 || cards.length > 0 || (res?.reply ?? "").trim().length > 0;

  return {
    handled: true,
    refused: false,
    understood,
    reply,
    cards,
    steps: plan.steps,
    executed,
    skipped,
  };
}

export interface ReplyParts {
  /** 真做成了的朗读行，按执行顺序 */
  doneLines: string[];
  /** 失败了但带话的朗读行 */
  failLines: string[];
  executed: ExecutedCall[];
  skipped: SkippedCall[];
  /** 规划器自己的那句话（可能很长，也可能是"好，我幫你記住"这种空话） */
  plannerReply: string;
  hadSteps: boolean;
  locale: Locale;
  /** 这一轮之前已经连续几次没听懂（0 = 第一句就听不懂） */
  confusedStreak?: number;
}

/**
 * 从"这一轮发生了什么"里挑出**一句**给长者听。
 *
 * 优先级不是随意的，每条都对应一个长者实际会遇到的场景：
 *
 *   ① 做成了 → 报第一件。计划里 sos 排第一（toolrun.ts），所以第一件就是
 *      最要紧的那件；第二、第三件进 `executed`，需要时看卡片。
 *   ② 失败 → 报第一条具体原因。"我開唔到撥號，你睇下手機" 让长者知道该动哪里；
 *      "有啲做唔到" 只会让他再问一次。
 *   ③ 他自己说了"唔使" → **不说话**。刚刚做完决定的人不需要被告知他做过决定。
 *   ④ 会做但这台机没接 → 说实话。绝不念规划器的"好，我幫你做咗"。
 *   ⑤ 模型乱来（工具名不存在 / 参数坏）→ "呢樣我未識做"。同样绝不念规划器的
 *      "好，我幫你記住咗"——那件事根本没有发生；也**不能**落到 `nothing` 池，
 *      那是把机器的错记到长者头上（他会以为自己讲错了，然后换种说法再试）。
 *   ⑥ 规划器只是聊天 / 只推卡 → 用它那句，压成一句。
 *   ⑦ 有计划但一句都没说成 → 沉默（卡片会解释）。
 *   ⑧ 完全没有计划 → "我未聽得明"，这就是 `nothing`；但如果他上一轮也没被听懂
 *      （`confusedStreak`），就不再要求他重说，直接给出口：叫屋企人帮。
 */
export function composeReply(p: ReplyParts): string {
  const copy = COPY[p.locale];
  if (p.doneLines.length > 0) return fitUtterance(p.doneLines[0]);
  if (p.failLines.length > 0) return fitUtterance(p.failLines[0]);
  if (p.executed.length > 0) return pick(copy.failed);
  if (p.skipped.some((s) => s.reason === "declined")) return "";
  if (p.skipped.some((s) => s.reason === "no_executor")) return pick(copy.notWired);
  if (p.skipped.some((s) => s.reason === "invalid")) return pick(copy.unknownTool);
  if (p.plannerReply) return fitUtterance(p.plannerReply);
  if (p.hadSteps) return "";
  if ((p.confusedStreak ?? 0) >= CONFUSED_ESCALATE_AFTER) return ESCAPE[p.locale];
  return pick(copy.nothing);
}
