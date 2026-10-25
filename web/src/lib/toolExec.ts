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
  dayKey,
  deferTask,
  latestOpenTask,
  markDone,
  newTask,
  taskEventFor,
  taskTextFromUtterance,
} from "./tasks.ts";
import { formatDistance } from "./geofence.ts";
import { alarmCard, cardFromScript, medRecordCard, parseCardScript, routePlanCard } from "./cards.ts";
// 回读长者自己的话必须截断：任务文本长度由他决定，整句回读可以轻易超过
// 一个呼吸（speech.ts 的第 4 条理由）。
import { clip } from "./speech.ts";
import type { ToolExecResult } from "./agent.ts";
import type { PlannedStep } from "./toolrun.ts";
import type { Locale, RecordEntry, RecordKind, SosEvent, Task, TaskEvent } from "./types";

/**
 * Tools this runner can actually perform. Everything else (navigate_home,
 * call_contact, send_message, open_app, ui_tap_text) needs a native method that
 * does not exist yet; `canRun()` reports them as unrunnable so the orchestrator
 * never asks "shall I call 阿明?" and then admits it cannot.
 */
const LOCAL_TOOLS = new Set([
  "sos",
  "create_task",
  "complete_task",
  "log_medication",
  "compose_card",
  "defer_task",
  "locate",
  "navigate_home",
  "plan_route",
  "call_contact",
  "open_app",
  "set_alarm",
]);

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
  /** arm a one-shot alarm; resolve false when the OS refused (permission/slot) */
  setAlarm?: (atMs: number, label: string) => Promise<boolean>;
  /**
   * Contacts we are allowed to dial — in practice the health card's emergency
   * contact. Empty array means "we know nobody", which is a refusal, not a
   * licence to dial whatever the model named.
   */
  contacts?: () => Promise<{ name: string; phone: string; relation?: string | null }[]>;
  /** open the dialler with the number prefilled; the senior still presses call */
  dial?: (phone: string) => Promise<boolean>;
  /** metres from home, or null when there is no home point / no fix yet */
  homeDistanceM?: () => Promise<number | null>;
  /** launch one whitelisted app ('wechat' | 'phone' | 'camera' | 'settings') */
  openApp?: (key: string) => Promise<boolean>;
  /** durable on-device record write (medication / alarm / measurement) */
  saveRecord?: (entry: RecordEntry) => Promise<void>;
  /** snapshot of today's records, used to refuse a double dose log */
  records?: RecordEntry[];
  /** clear the medication reminder the senior just confirmed */
  onMedTaken?: (name: string) => void;
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
  /** the alarm really is armed, and when it will ring (already resolved to a day) */
  alarmSet: (when: string) => string;
  /** the model sent something that is not HH:MM */
  alarmBadTime: string;
  /** native refused: no exact-alarm permission, or the OS rejected it */
  alarmFailed: string;
  /** nobody in the health card we are allowed to dial */
  noContact: string;
  /** the senior named someone we do not have: refuse, never guess */
  strangerContact: (name: string) => string;
  /** two people share that name — say so, never claim they are unknown */
  ambiguousContact: (name: string, relations: string[]) => string;
  /** the dialler refused to open */
  dialFailed: string;
  /** the dialler is open, prefilled — the senior still presses call */
  called: (name: string) => string;
  /** no home point configured yet */
  noHome: string;
  /** he is at home (or close enough that a distance would be silly) */
  homeNear: string;
  homeFar: (distance: string) => string;
  deferDone: (minutes: number) => string;
  deferNoMatch: string;
  appOpened: (key: string) => string;
  appFailed: string;
  /** plan_route: the card's title, e.g. "去街市嘅路線" */
  routeTitle: (destination: string) => string;
  routeHomeTitle: string;
  /** the one line spoken right after a plan is made (≤ SPEECH_BUDGET) */
  routeLead: (destination: string) => string;
  routeHomeLead: (distance: string | null) => string;
  /** medication really logged; the card stays on screen */
  medLogged: (name: string) => string;
  medLoggedPlain: string;
  /** the same dose was already logged minutes ago */
  medAlready: (min: number) => string;
  /** compose_card got a script with nothing renderable in it */
  cardNoContent: string;
  /** the task text saved so the plan has a "next" the senior can tick off */
  routeTaskAway: (destination: string) => string;
  routeTaskHome: string;
  /** away-from-home plan steps, `d` = the destination */
  routeStepsAway: (destination: string) => string[];
  /** home plan steps, `d` = formatted distance or null */
  routeStepsHome: (distance: string | null) => string[];
}

// Cantonese for HK/MO, plain Mandarin for the mainland. Short sentences, no
// "系统/接口/失败" vocabulary — the senior is a person, not a log reader.
const COPY: Record<Locale, Copy> = {
  "zh-HK": {
    taskSaved: (t) => `好，我記低咗：${clip(t, 8)}`,
    taskSavedDue: (t) => `好，我記低咗：${clip(t, 6)}，到時我提你。`,
    taskRepeat: (t) => `你之前已經叫我記過：${clip(t, 6)}`,
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
    alarmSet: (w) => `好，${w}叫你。`,
    alarmBadTime: "我聽唔清幾點，你講多次，例如「朝早八點」。",
    alarmFailed: "我設唔到鬧鐘，你睇下手機有冇閂咗鬧鐘權限。",
    noContact: "我部機未有屋企人嘅電話，你叫屋企人設定一次。",
    strangerContact: (n) => `我冇${clip(n, 6)}嘅電話，你叫屋企人幫你打。`,
    ambiguousContact: (n, rel) =>
      rel.length > 0
        ? `有兩個${clip(n, 6)}：${rel.map((r) => clip(r, 4)).join("同")}，你講係邊個？`
        : `有兩個${clip(n, 6)}，你講清楚係邊個？`,
    dialFailed: "我開唔到撥號，你睇下手機。",
    called: (n) => `好，撥咗${clip(n, 6)}嘅電話，你按綠色個掣。`,
    noHome: "我未知你屋企喺邊，你叫屋企人設定一次。",
    homeNear: "你而家就喺屋企附近。",
    homeFar: (d) => `你而家離屋企大約 ${d}。`,
    deferDone: (m) => `好，我 ${m} 分鐘後再提你。`,
    deferNoMatch: "我唔知你講邊件事，你話我知係邊件？",
    appOpened: (k) => `好，幫你開咗${k}。`,
    appFailed: "我開唔到，你睇下手機。",
    routeTitle: (d) => `去${clip(d, 8)}嘅路線`,
    routeHomeTitle: "返屋企嘅路線",
    routeLead: (d) => `好，去${clip(d, 4)}嘅路線：先帶鎖匙同電話。`,
    routeHomeLead: (dist) => (dist ? `你離屋企大約${dist}，行返平日條路就得。` : "好，我陪你行返屋企，唔認得路就企定定同我講。"),
    medLogged: (n) => `好，我記低咗你食咗${clip(n, 6)}。`,
    medLoggedPlain: "好，我記低咗你食咗藥。",
    medAlready: (m) => (m <= 0 ? "你呢次已經記低咗喇。" : `你 ${m} 分鐘前已經記低咗食藥喇。`),
    cardNoContent: "我寫唔到呢張卡，你再講一次？",
    routeTaskAway: (d) => `去${d}`,
    routeTaskHome: "返屋企",
    routeStepsAway: (d) => [`帶鎖匙、電話同身份證`, `行平日去${clip(d, 6)}嗰條路，慢慢行`, "到咗同我講一聲"],
    routeStepsHome: (dist) =>
      dist
        ? [`你而家離屋企大約 ${dist}`, "行返平日條路返去", "唔認得路就企定定，同我講"]
        : ["行返頭先行過嗰條路", "唔認得路就企定定，同我講", `要就打電話畀屋企人`],
  },
  "zh-MO": {
    taskSaved: (t) => `好，我記低咗：${clip(t, 8)}`,
    taskSavedDue: (t) => `好，我記低咗：${clip(t, 6)}，到時我提你。`,
    taskRepeat: (t) => `你之前已經叫我記過：${clip(t, 6)}`,
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
    alarmSet: (w) => `好，${w}叫你。`,
    alarmBadTime: "我聽唔清幾點，你講多次，例如「朝早八點」。",
    alarmFailed: "我設唔到鬧鐘，你睇下手機有冇閂咗鬧鐘權限。",
    noContact: "我部機未有屋企人嘅電話，你叫屋企人設定一次。",
    strangerContact: (n) => `我冇${clip(n, 6)}嘅電話，你叫屋企人幫你打。`,
    ambiguousContact: (n, rel) =>
      rel.length > 0
        ? `有兩個${clip(n, 6)}：${rel.map((r) => clip(r, 4)).join("同")}，你講係邊個？`
        : `有兩個${clip(n, 6)}，你講清楚係邊個？`,
    dialFailed: "我開唔到撥號，你睇下手機。",
    called: (n) => `好，撥咗${clip(n, 6)}嘅電話，你按綠色個掣。`,
    noHome: "我未知你屋企喺邊，你叫屋企人設定一次。",
    homeNear: "你而家就喺屋企附近。",
    homeFar: (d) => `你而家離屋企大約 ${d}。`,
    deferDone: (m) => `好，我 ${m} 分鐘後再提你。`,
    deferNoMatch: "我唔知你講邊件事，你話我知係邊件？",
    appOpened: (k) => `好，幫你開咗${k}。`,
    appFailed: "我開唔到，你睇下手機。",
    routeTitle: (d) => `去${clip(d, 8)}嘅路線`,
    routeHomeTitle: "返屋企嘅路線",
    routeLead: (d) => `好，去${clip(d, 4)}嘅路線：先帶鎖匙同電話。`,
    routeHomeLead: (dist) => (dist ? `你離屋企大約${dist}，行返平日條路就得。` : "好，我陪你行返屋企，唔認得路就企定定同我講。"),
    medLogged: (n) => `好，我記低咗你食咗${clip(n, 6)}。`,
    medLoggedPlain: "好，我記低咗你食咗藥。",
    medAlready: (m) => (m <= 0 ? "你呢次已經記低咗喇。" : `你 ${m} 分鐘前已經記低咗食藥喇。`),
    cardNoContent: "我寫唔到呢張卡，你再講一次？",
    routeTaskAway: (d) => `去${d}`,
    routeTaskHome: "返屋企",
    routeStepsAway: (d) => [`帶鎖匙、電話同身份證`, `行平日去${clip(d, 6)}嗰條路，慢慢行`, "到咗同我講一聲"],
    routeStepsHome: (dist) =>
      dist
        ? [`你而家離屋企大約 ${dist}`, "行返平日條路返去", "唔認得路就企定定，同我講"]
        : ["行返頭先行過嗰條路", "唔認得路就企定定，同我講", "要就打電話畀屋企人"],
  },
  "zh-CN": {
    taskSaved: (t) => `好，我记下了：${clip(t, 8)}`,
    taskSavedDue: (t) => `好，我记下了：${clip(t, 6)}，到时会提醒你。`,
    taskRepeat: (t) => `你之前已经让我记过了：${clip(t, 6)}`,
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
    alarmSet: (w) => `好，${w}叫你。`,
    alarmBadTime: "我没听清几点，你再说一次，比如说「早上八点」。",
    alarmFailed: "我设不了闹钟，你看看手机是不是关了闹钟权限。",
    noContact: "我这里还没有家里人的电话，你让家里人设一次。",
    strangerContact: (n) => `我没有${clip(n, 6)}的电话，你让家里人帮你打。`,
    ambiguousContact: (n, rel) =>
      rel.length > 0
        ? `有两个${clip(n, 6)}：${rel.map((r) => clip(r, 4)).join("和")}，你说的是哪个？`
        : `有两个${clip(n, 6)}，你说清楚是哪个？`,
    dialFailed: "我打不开拨号，你看看手机。",
    called: (n) => `好，拨了${clip(n, 6)}的电话，你按绿色的按钮。`,
    noHome: "我还不知道你家在哪，你让家里人设一次。",
    homeNear: "你现在就在家附近。",
    homeFar: (d) => `你现在离家大约 ${d}。`,
    deferDone: (m) => `好，我 ${m} 分钟后再提醒你。`,
    deferNoMatch: "我不知道你说的是哪一件，你告诉我是哪件？",
    appOpened: (k) => `好，帮你打开了${k}。`,
    appFailed: "我打不开，你看看手机。",
    routeTitle: (d) => `去${clip(d, 8)}的路线`,
    routeHomeTitle: "回家的路线",
    routeLead: (d) => `好，去${clip(d, 4)}的路线：先带钥匙和手机。`,
    routeHomeLead: (dist) => (dist ? `你离家大约${dist}，走平时那条路就行。` : "好，我陪你走回家，不认得路就站定跟我说。"),
    medLogged: (n) => `好，我记下您吃过${clip(n, 6)}了。`,
    medLoggedPlain: "好，我记下您吃过药了。",
    medAlready: (m) => (m <= 0 ? "这次已经记下了。" : `您 ${m} 分钟前已经记下吃过药了。`),
    cardNoContent: "我写不出这张卡，您再说一次？",
    routeTaskAway: (d) => `去${d}`,
    routeTaskHome: "回家",
    routeStepsAway: (d) => ["带上钥匙、手机和身份证", `走平时去${clip(d, 6)}的那条路，慢慢走`, "到了跟我说一声"],
    routeStepsHome: (dist) =>
      dist
        ? [`你现在离家大约 ${dist}`, "走平时那条路回去", "不认得路就站定，跟我说"]
        : ["沿刚才走过的路回去", "不认得路就站定，跟我说", "需要就打给家里人"],
  },
};

function norm(text: unknown): string {
  return typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
}

/** Spoken words -> the one task they can only mean, or null. */function matchTask(tasks: Task[], query: string, now: number): Task | null {
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

/** Tomorrow is the furthest anyone means by "叫我起身". */
export const ALARM_MAX_DAY_OFFSET = 1;

/**
 * "HH:MM" (+ dayOffset) -> epoch ms, or null when it is not a clock time.
 *
 * WHY THE MODEL DOES NOT SEND AN EPOCH: asking a language model to add "聽日八點"
 * to a millisecond timestamp is arithmetic it gets wrong quietly — the alarm then
 * rings at 3am and nobody knows why. The model only reports the time of day it
 * heard; the device resolves the date.
 *
 * A time already past today ("八點" said at 9am) rolls to tomorrow rather than
 * being rejected: that is what a person means, and the spoken confirmation says
 * which day it picked so he can correct it.
 */
export function alarmAtFrom(time: string, dayOffset: number, now: number): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((time ?? "").trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) return null;

  const offset = Number.isFinite(dayOffset)
    ? Math.max(0, Math.min(ALARM_MAX_DAY_OFFSET, Math.trunc(dayOffset)))
    : 0;

  const at = new Date(now);
  at.setDate(at.getDate() + offset);
  at.setHours(hour, minute, 0, 0);
  if (offset === 0 && at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

/** "今日三點" / "聽日八點" — the day is stated out loud so a mistake is correctable. */
export function alarmWhenLabel(atMs: number, now: number, locale: Locale): string {
  const at = new Date(atMs);
  const hour = at.getHours();
  const minute = at.getMinutes();
  const sameDay = new Date(now).toDateString() === at.toDateString();
  const cjk = locale === "zh-CN";
  const clock = cjk
    ? `${hour}点${minute ? `${minute}分` : ""}`
    : `${hour}點${minute ? `${minute}分` : ""}`;
  const day = cjk ? (sameDay ? "今天" : "明天") : sameDay ? "今日" : "聽日";
  return `${day}${clock}`;
}

export function createToolRunner(deps: ToolRunnerDeps): ToolRunner {
  const copy = COPY[deps.locale];

  function canRun(name: string): boolean {
    if (!LOCAL_TOOLS.has(name)) return false;
    if (name === "locate") return typeof deps.locate === "function";
    if (name === "sos") return typeof deps.sendSos === "function" || typeof deps.raiseSos === "function";
    if (name === "set_alarm") return typeof deps.setAlarm === "function";
    if (name === "call_contact") return typeof deps.contacts === "function" && typeof deps.dial === "function";
    if (name === "navigate_home") return typeof deps.homeDistanceM === "function";
    if (name === "open_app") return typeof deps.openApp === "function";
    if (name === "log_medication" || name === "compose_card") return true;
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

  async function setAlarm(args: Record<string, unknown>): Promise<ToolExecResult> {
    const label = norm(args.label)
      || norm(args.time);
    if (!label) return { ok: false, message: copy.alarmBadTime };

    const dayOffset = typeof args.dayOffset === "number" ? args.dayOffset : 0;
    const at = alarmAtFrom(typeof args.time === "string" ? args.time : "", dayOffset, deps.now);
    if (at === null) return { ok: false, message: copy.alarmBadTime };
    if (!deps.setAlarm) return { ok: false, message: copy.alarmFailed };

    try {
      if (!(await deps.setAlarm(at, label))) return { ok: false, message: copy.alarmFailed };
    } catch {
      return { ok: false, message: copy.alarmFailed };
    }
    const when = alarmWhenLabel(at, deps.now, deps.locale);
    // The alarm is a record too: a restart must still show "聽日八點 覆診".
    // `dueAt` is what makes that record actionable — on the next cold start the
    // bridge compares it with the OS scheduler and re-arms a lost alarm.
    if (deps.saveRecord) {
      await deps.saveRecord({
        id: `rec-alarm-${at}`,
        kind: "alarm",
        title: label,
        detail: when,
        at: deps.now,
        dueAt: at,
        day: dayKey(deps.now),
        source: "voice",
      });
    }
    // Say WHICH day it landed on: "八點" at 9am means tomorrow, and he must hear that.
    return { ok: true, cards: [alarmCard({ at, label }, deps.locale, deps.now)], message: copy.alarmSet(when) };
  }

  /**
   * "我食咗藥" → one durable record, the matching chore ticked, today's reminder
   * cleared, and a card that stays on screen. A report is not a request, so
   * nothing here needs confirmation.
   */
  async function logMedication(args: Record<string, unknown>): Promise<ToolExecResult> {
    const name = norm(args.name).slice(0, 16);
    const note = norm(args.note).slice(0, 30);

    // Same dose logged twice in the duplicate window: say it was already
    // recorded instead of inflating the family report with a second dose.
    const recent = (deps.records ?? [])
      .filter((r) => r.kind === "med" && deps.now - r.at <= DUPLICATE_WINDOW_MS)
      .sort((a, b) => b.at - a.at)[0];
    if (recent) {
      return { ok: true, message: copy.medAlready(Math.round((deps.now - recent.at) / 60_000)) };
    }

    // Only medication chores, and only when the words identify exactly one.
    const medTasks = deps.tasks.filter((t) => !t.done && /(藥|药)/.test(t.text));
    const target = name ? matchTask(medTasks, name, deps.now) : medTasks.length === 1 ? medTasks[0] : null;
    if (target) {
      const done = markDone(target, deps.now);
      if (!done.alreadyDone) {
        await deps.saveTask(done.task);
        if (deps.recordEvent) await deps.recordEvent(taskEventFor(done.task, "completed", deps.now));
      }
    }

    const title = name ? `食藥：${name}` : "食藥";
    if (deps.saveRecord) {
      await deps.saveRecord({
        id: `rec-med-${deps.now}`,
        kind: "med",
        title,
        detail: note || undefined,
        at: deps.now,
        day: dayKey(deps.now),
        source: "voice",
      });
    }
    try {
      deps.onMedTaken?.(name || "藥");
    } catch {
      /* the reminder overlay must never block the record */
    }

    return {
      ok: true,
      cards: [medRecordCard(name || "藥", deps.now, deps.locale)],
      message: name ? copy.medLogged(name) : copy.medLoggedPlain,
    };
  }

  /**
   * The agent's own card script — plain text, never HTML. Rendering happens in
   * CardRenderer's structured branch, so a hostile model cannot inject script.
   */
  async function composeCard(args: Record<string, unknown>): Promise<ToolExecResult> {
    // NOT `norm()`: that collapses whitespace and would fold every directive
    // into the first line. The parser needs the real newlines.
    const script = typeof args.script === "string" ? args.script.trim() : "";
    const parsed = parseCardScript(script);
    if (!parsed) return { ok: false, message: copy.cardNoContent };
    const kinds: RecordKind[] = ["measure", "med", "alarm", "card"];
    const rawKind = norm(args.kind) as RecordKind;
    const kind = kinds.includes(rawKind) ? rawKind : "measure";

    if (deps.saveRecord) {
      await deps.saveRecord({
        id: `rec-card-${deps.now}`,
        kind,
        title: parsed.title,
        detail: parsed.data.headline?.slice(0, 30),
        at: deps.now,
        day: dayKey(deps.now),
        source: "agent",
      });
    }
    return {
      ok: true,
      cards: [cardFromScript(parsed, deps.now)],
      message: clip(parsed.data.headline || parsed.title, 12),
    };
  }


  /** Case/space-insensitive, so "陳小明" == "陈小明" == " 陳小明 ". */
  function normName(v: string): string {
    return v.replace(/\s+/g, "").trim();
  }

  /**
   * Dialling is the one place a wrong guess reaches a real person.
   *
   * The name the MODEL said is only a lookup key: the number always comes from
   * the health card, and a name that matches nothing there is refused. A model
   * that hallucinates "打畀陳小明" must not be able to ring an arbitrary number.
   */
  async function callContact(args: Record<string, unknown>): Promise<ToolExecResult> {
    const said = norm(args.name);
    if (!said || !deps.contacts || !deps.dial) return { ok: false, message: copy.noContact };

    const known = await deps.contacts().catch(() => []);
    if (known.length === 0) return { ok: false, message: copy.noContact };

    const q = normName(said);
    const matches = known.filter((c) => {
      const n = normName(c.name);
      if (!q || !n) return false;
      if (n === q) return true;
      // Cantonese nicknames drop the surname: "小明" for "陳小明". One character
      // is never enough ("明" could be anyone), so require two.
      return q.length >= 2 && (n.includes(q) || q.includes(n));
    });

    if (matches.length === 0) {
      // A stranger: the number never comes from the model, so we cannot help.
      return { ok: false, message: copy.strangerContact(said) };
    }
    if (matches.length > 1) {
      // Two people share the name. Say who they are and stop — guessing here is
      // how a call reaches the wrong person, and that cannot be taken back.
      const relations = matches.map((c) => (c.relation ?? "").trim()).filter((r) => r.length > 0);
      return { ok: false, message: copy.ambiguousContact(said, relations) };
    }

    try {
      if (!(await deps.dial(matches[0].phone))) return { ok: false, message: copy.dialFailed };
    } catch {
      return { ok: false, message: copy.dialFailed };
    }
    // Deliberately no retry and no auto-redial: the dialler is open, the rest is
    // the senior's own decision (ACTION_DIAL does not place the call).
    return { ok: true, message: copy.called(matches[0].name) };
  }

  /**
   * Distance only. A bearing ("north-west") cannot be turned into "turn left"
   * without a compass, so we do not pretend: the number he can act on is how far.
   */
  async function navigateHome(): Promise<ToolExecResult> {
    if (!deps.homeDistanceM) return { ok: false, message: copy.noHome };
    const distance = await deps.homeDistanceM().catch(() => null);
    if (distance === null) return { ok: false, message: copy.noHome };
    if (distance < 100) return { ok: true, message: copy.homeNear };
    return { ok: true, message: copy.homeFar(formatDistance(distance)) };
  }

  /**
   * A walking plan, not a map: no SDK, no coordinates, no invented landmarks.
   *
   * Three ordered things he can actually do, the real distance when the goal is
   * home, and a saved task — so the plan has a "next" he can tick off instead of
   * ending at "好，我記住". The task is also what lets the family see that he
   * intended to go out, which is a real signal, not decoration.
   */
  async function planRoute(args: Record<string, unknown>): Promise<ToolExecResult> {
    const destination = norm(args.destination);
    const home = !destination || /(屋企|返家|回家|歸家|归家)/.test(destination);
    const distance = deps.homeDistanceM ? await deps.homeDistanceM().catch(() => null) : null;
    const dist = distance === null ? "" : formatDistance(distance);

    const title = home ? copy.routeHomeTitle : copy.routeTitle(destination);
    const steps = home ? copy.routeStepsHome(dist || null) : copy.routeStepsAway(destination);
    const text = home ? copy.routeTaskHome : copy.routeTaskAway(destination);

    // Same text twice is him repeating himself, not a second outing.
    if (!deps.tasks.some((t) => !t.done && t.text === text)) {
      const task = newTask({ text, now: deps.now, source: "voice" });
      await deps.saveTask(task);
      if (deps.recordEvent) await deps.recordEvent(taskEventFor(task, "created", deps.now));
    }

    return {
      ok: true,
      cards: [routePlanCard(title, steps, deps.now)],
      message: home ? copy.routeHomeLead(dist || null) : copy.routeLead(destination),
    };
  }

  async function deferTaskExec(args: Record<string, unknown>): Promise<ToolExecResult> {
    const query = norm(args.query);
    const id = norm(args.taskId);
    let target: Task | null = null;

    if (id) {
      target = deps.tasks.find((t) => t.id === id && !t.done) ?? null;
      if (!target) return { ok: false, message: copy.noMatch };
    } else if (query) {
      target = matchTask(deps.tasks, query, deps.now);
      if (!target || target.done) {
        return { ok: false, message: deps.tasks.some((t) => !t.done) ? copy.deferNoMatch : copy.noOpenTask };
      }
    } else {
      target = latestOpenTask(deps.tasks);
      if (!target) return { ok: false, message: copy.noOpenTask };
    }

    const raw = typeof args.minutes === "number" && Number.isFinite(args.minutes) ? args.minutes : 10;
    const minutes = Math.max(1, Math.min(120, Math.round(raw)));
    const updated = deferTask(target, deps.now, minutes * 60_000);

    await deps.saveTask(updated);
    if (deps.recordEvent) {
      await deps.recordEvent(taskEventFor(updated, "deferred", deps.now, "voice"));
    }
    return { ok: true, message: copy.deferDone(minutes) };
  }

  async function openApp(args: Record<string, unknown>): Promise<ToolExecResult> {
    const key = typeof args.app === "string" ? args.app : "";
    if (!deps.openApp) return { ok: false, message: copy.appFailed };
    const ok = await deps.openApp(key).catch(() => false);
    return ok ? { ok: true, message: copy.appOpened(key) } : { ok: false, message: copy.appFailed };
  }

  async function run(step: PlannedStep): Promise<ToolExecResult> {
    const args = step.args ?? {};
    switch (step.name) {
      case "create_task":
        return createTask(args);
      case "complete_task":
        return completeTask(args);
      case "log_medication":
        return logMedication(args);
      case "compose_card":
        return composeCard(args);
      case "locate":
        return locate();
      case "sos":
        return sos();
      case "set_alarm":
        return setAlarm(args);
      case "defer_task":
        return deferTaskExec(args);
      case "navigate_home":
        return navigateHome();
      case "plan_route":
        return planRoute(args);
      case "call_contact":
        return callContact(args);
      case "open_app":
        return openApp(args);
      default:
        // Reached only if the orchestrator ignored canRun().
        return { ok: false, message: copy.notFound };
    }
  }

  return { canRun, run };
}
