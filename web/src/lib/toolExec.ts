// toolExec.ts — the device half of the agent: turns one validated plan step into
// a real local effect, plus ONE sentence a 78-year-old can act on.
//
// Division of labour, so nothing is decided twice:
//   tools.ts     declares what may exist (name, args, risk, permission)
//   toolrun.ts   decides what may run THIS turn (refusal, args, cap, order)
//   toolExec.ts  runs it and says what actually happened        <-- this file
//
// Every side effect is INJECTED (saveTask / recordEvent / sendSos / locate /
// raiseSos), which is what lets selfcheck drive the whole executor with fakes:
// no IndexedDB, no Capacitor, no device. It is also why this file must never
// import api.ts — the outbox owns the network, the executor owns the device.
//
// Three product rules encoded below, all learned from the actual failure modes:
//
// 1. NEVER invent an effect the senior did not ask for. A `dueAt` already in the
//    past is dropped rather than saved: saving it would make the reminder fire
//    "overdue" the instant it is written (the bug f87d930 fixed).
// 2. NEVER tick the wrong chore. If the spoken words match no open task and more
//    than one is open, say "I don't know which one" instead of completing the
//    most recent — a wrong tick corrupts C's completion rate and, worse, tells
//    the family he did something he did not.
// 3. NEVER read a coordinate, an id or an error code aloud. Location is
//    confirmed as "I have it", never as "22.3193, 114.1694".
//
// Tested in src/selfcheck.ts.

import {
  DUPLICATE_WINDOW_MS,
  latestOpenTask,
  markDone,
  newTask,
  taskEventFor,
  taskTextFromUtterance,
} from "./tasks.ts";
import type { ToolExecResult } from "./agent.ts";
import type { PlannedStep } from "./toolrun.ts";
import type { Locale, SosEvent, Task, TaskEvent } from "./types";

/**
 * Tools this runner can actually perform. Everything else (set_alarm,
 * navigate_home, call_contact, send_message, open_app, ui_tap_text) needs a
 * native method that does not exist yet; `canRun()` reports them as unrunnable
 * so the orchestrator never asks "shall I call 阿明?" and then admits it cannot.
 */
const LOCAL_TOOLS = new Set(["sos", "create_task", "complete_task", "locate"]);

export interface ToolRunnerDeps {
  locale: Locale;
  now: number;
  /** snapshot of local tasks; the runner never re-reads storage mid-turn */
  tasks: Task[];
  saveTask: (task: Task) => Promise<void>;
  /** durable task-event append (outbox in production, a spy in tests) */
  recordEvent?: (event: TaskEvent) => Promise<void>;
  /** hand an escalation to the delivery path — MUST be idempotent on `event.id` */
  sendSos?: (event: SosEvent) => Promise<void>;
  /** UI/native reaction so the senior sees the emergency even offline */
  raiseSos?: (event: SosEvent) => void;
  /** foreground coarse location; resolve null when denied or unavailable */
  locate?: () => Promise<{ lat: number; lng: number; accuracy?: number } | null>;
}

export interface ToolRunner {
  /** false = we must not even ask for confirmation, the action cannot run */
  canRun: (name: string) => boolean;
  run: (step: PlannedStep) => Promise<ToolExecResult>;
}

/**
 * HK/MO use 999, the mainland uses 120. Mirrors SosOverlay.tsx:20 — duplicated
 * here on purpose so `lib/` never imports a `.tsx` (that would drag React into
 * the pure modules and break `node src/selfcheck.ts`).
 */
export function emergencyNumber(locale: Locale): string {
  return locale === "zh-CN" ? "120" : "999";
}

interface Copy {
  taskSaved: (text: string) => string;
  taskSavedDue: (text: string) => string;
  taskRepeat: (text: string) => string;
  taskEmpty: string;
  taskDone: string;
  taskAlreadyDone: (min: number) => string;
  noOpenTask: string;
  noMatch: string;
  located: string;
  noLocation: string;
  sosSent: string;
  sosQueued: string;
  sosLocalOnly: (emergency: string) => string;
  notFound: string;
}

// Cantonese for HK/MO, plain Mandarin for the mainland. Short sentences, no
// "系统/接口/失败" vocabulary — the senior is a person, not a log reader.
const COPY: Record<Locale, Copy> = {
  "zh-HK": {
    taskSaved: (t) => `好，我記低咗：${t}`,
    taskSavedDue: (t) => `好，我記低咗：${t}，到時我提你。`,
    taskRepeat: (t) => `你之前已經叫我記過：${t}`,
    taskEmpty: "我未聽清楚要記咩，你再講一次？",
    taskDone: "好，我記低咗。",
    taskAlreadyDone: (m) => (m <= 0 ? "你啱啱已經確認過喇。" : `你 ${m} 分鐘前已經確認過喇。`),
    noOpenTask: "我而家冇未做嘅事，要記新嘅就同我講。",
    noMatch: "我唔知你講邊件事，你話我知係邊件？",
    located: "位置攞到咗，要話畀屋企人知就同我講。",
    noLocation: "我攞唔到位置，你睇下個定位開咗未。",
    sosSent: "我即刻通知屋企人，你坐低唔好走開。",
    sosQueued: "我記低咗你嘅求助，一有網就通知屋企人。",
    sosLocalOnly: (n) => `我仲未接到屋企人。你打 ${n}。`,
    notFound: "我搵唔到呢件事。",
  },
  "zh-MO": {
    taskSaved: (t) => `好，我記低咗：${t}`,
    taskSavedDue: (t) => `好，我記低咗：${t}，到時我提你。`,
    taskRepeat: (t) => `你之前已經叫我記過：${t}`,
    taskEmpty: "我未聽清楚要記咩，你再講一次？",
    taskDone: "好，我記低咗。",
    taskAlreadyDone: (m) => (m <= 0 ? "你啱啱已經確認過喇。" : `你 ${m} 分鐘前已經確認過喇。`),
    noOpenTask: "我而家冇未做嘅事，要記新嘅就同我講。",
    noMatch: "我唔知你講邊件事，你話我知係邊件？",
    located: "位置攞到咗，要話畀屋企人知就同我講。",
    noLocation: "我攞唔到位置，你睇下個定位開咗未。",
    sosSent: "我即刻通知屋企人，你坐低唔好走開。",
    sosQueued: "我記低咗你嘅求助，一有網就通知屋企人。",
    sosLocalOnly: (n) => `我仲未接到屋企人。你打 ${n}。`,
    notFound: "我搵唔到呢件事。",
  },
  "zh-CN": {
    taskSaved: (t) => `好，我记下了：${t}`,
    taskSavedDue: (t) => `好，我记下了：${t}，到时会提醒你。`,
    taskRepeat: (t) => `你之前已经让我记过了：${t}`,
    taskEmpty: "我没听清要记什么，你再说一次？",
    taskDone: "好，我记下了。",
    taskAlreadyDone: (m) => (m <= 0 ? "你刚才已经确认过了。" : `你 ${m} 分钟前已经确认过了。`),
    noOpenTask: "你现在没有没做完的事，要记新的就告诉我。",
    noMatch: "我不知道你说的是哪一件，你告诉我是哪件？",
    located: "位置拿到了，要告诉家里人就跟我说。",
    noLocation: "我拿不到位置，你看看定位开了没有。",
    sosSent: "我马上通知家里人，你坐下别走开。",
    sosQueued: "我记下了你的求助，一联网就通知家里人。",
    sosLocalOnly: (n) => `我还没联系上家里人。你打 ${n}。`,
    notFound: "我找不到这件事。",
  },
};

function norm(text: unknown): string {
  return typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
}

/** Spoken words -> the one task they can only mean, or null. */
function matchTask(tasks: Task[], query: string, now: number): Task | null {
  const q = query.trim();
  if (!q) return null;

  // Recently completed tasks stay in the pool: "我食咗藥" said twice must be
  // answered with "你 20 分鐘前已經確認過", not "你冇未做嘅事".
  const pool = tasks.filter(
    (t) => !t.done || (t.doneAt !== undefined && now - t.doneAt <= DUPLICATE_WINDOW_MS)
  );

  const exact = pool.find((t) => t.text === q);
  if (exact) return exact;

  const partial = pool.filter((t) => t.text.includes(q) || q.includes(t.text));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    // Ambiguous: only accept it when exactly one of them is still open.
    const openPartial = partial.filter((t) => !t.done);
    return openPartial.length === 1 ? openPartial[0] : null;
  }

  // No textual overlap ("我食咗藥" vs "食降壓藥"): accept the ONLY candidate,
  // because there is nothing else it could mean. Two or more -> refuse to guess.
  const open = pool.filter((t) => !t.done);
  if (open.length === 1) return open[0];
  if (open.length === 0 && pool.length === 1) return pool[0];
  return null;
}

export function createToolRunner(deps: ToolRunnerDeps): ToolRunner {
  const copy = COPY[deps.locale];

  function canRun(name: string): boolean {
    if (!LOCAL_TOOLS.has(name)) return false;
    if (name === "locate") return typeof deps.locate === "function";
    if (name === "sos") return typeof deps.sendSos === "function" || typeof deps.raiseSos === "function";
    return true; // create_task / complete_task need nothing but storage
  }

  async function createTask(args: Record<string, unknown>): Promise<ToolExecResult> {
    const raw = norm(args.text);
    const text = taskTextFromUtterance(raw) || raw;
    if (!text) return { ok: false, message: copy.taskEmpty };

    // Saying the same thing twice is the senior repeating himself, not a second
    // chore. Silence here is kinder than a duplicate row he then has to clear.
    const same = deps.tasks.find((t) => !t.done && t.text === text);
    if (same) return { ok: true, message: copy.taskRepeat(text) };

    // A deadline in the past would fire an overdue reminder the moment it saves.
    const due = args.dueAt;
    const dueAt = typeof due === "number" && Number.isFinite(due) && due > deps.now ? due : undefined;

    const task = newTask({ text, now: deps.now, dueAt, source: "voice" });
    await deps.saveTask(task);
    if (deps.recordEvent) await deps.recordEvent(taskEventFor(task, "created", deps.now));

    return { ok: true, message: dueAt ? copy.taskSavedDue(text) : copy.taskSaved(text) };
  }

  async function completeTask(args: Record<string, unknown>): Promise<ToolExecResult> {
    const byId = norm(args.taskId);
    const query = norm(args.query);

    let target: Task | null = null;
    if (byId) {
      // A hallucinated id must not silently tick some other task.
      target = deps.tasks.find((t) => t.id === byId) ?? null;
      if (!target) return { ok: false, message: copy.notFound };
    } else if (query) {
      target = matchTask(deps.tasks, query, deps.now);
      if (!target) {
        const anyOpen = deps.tasks.some((t) => !t.done);
        return { ok: false, message: anyOpen ? copy.noMatch : copy.noOpenTask };
      }
    } else {
      target = latestOpenTask(deps.tasks);
      if (!target) return { ok: false, message: copy.noOpenTask };
    }

    const result = markDone(target, deps.now);
    if (result.alreadyDone) {
      // No save, no event: a second "我食咗藥" must not double-count in C's
      // completion rate (docs/dev.md §1.8 duplicate window).
      return { ok: true, message: copy.taskAlreadyDone(result.elapsedMin ?? 0) };
    }

    await deps.saveTask(result.task);
    if (deps.recordEvent) await deps.recordEvent(taskEventFor(result.task, "completed", deps.now));
    return { ok: true, message: copy.taskDone };
  }

  async function locate(): Promise<ToolExecResult> {
    if (!deps.locate) return { ok: false, message: copy.noLocation };
    let pos: { lat: number; lng: number } | null = null;
    try {
      pos = await deps.locate();
    } catch {
      pos = null;
    }
    // Deliberately silent about the numbers: a senior cannot use "22.3193".
    return pos ? { ok: true, message: copy.located } : { ok: false, message: copy.noLocation };
  }

  async function sos(): Promise<ToolExecResult> {
    // Never confirm, never queue behind anything else (toolrun.ts already sorts
    // sos first). `confirmed` is true because the senior either said it or
    // pressed the button — an emergency is not a preference.
    const event: SosEvent = {
      id: `sos-${deps.now}`,
      at: deps.now,
      locale: deps.locale,
      reason: "voice",
      confirmed: true,
      status: "pending",
      source: "app",
    };

    // Raise the UI FIRST: if the storage layer is what is broken, the senior
    // still gets a screen and a vibration instead of silence.
    try {
      deps.raiseSos?.(event);
    } catch {
      /* the overlay must never be able to block the escalation */
    }

    if (!deps.sendSos) return { ok: true, message: copy.sosLocalOnly(emergencyNumber(deps.locale)) };
    try {
      await deps.sendSos(event);
      return { ok: true, message: copy.sosSent };
    } catch {
      return { ok: false, message: copy.sosQueued };
    }
  }

  async function run(step: PlannedStep): Promise<ToolExecResult> {
    const args = step.args ?? {};
    switch (step.name) {
      case "create_task":
        return createTask(args);
      case "complete_task":
        return completeTask(args);
      case "locate":
        return locate();
      case "sos":
        return sos();
      default:
        // Reached only if the orchestrator ignored canRun().
        return { ok: false, message: copy.notFound };
    }
  }

  return { canRun, run };
}
