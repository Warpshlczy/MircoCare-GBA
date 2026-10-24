// Runnable self-check: `node src/selfcheck.ts` (Node 24 strips types natively).
// Imports ONLY pure modules (no window/DOM at module scope). No test framework.

import assert from "node:assert/strict";
import {
  magnitude,
  createFallDetector,
  gaitVariability,
  detectSteps,
  trimSilence,
  energyVad,
  escalationFor,
  G,
} from "./lib/signal.ts";
import { t } from "./lib/i18n.ts";
import { parseIntent, isQuestion } from "./lib/intent.ts";
import { localCardsFor, followupCard, todoCardFromUtterance, taskCard, placeCard, alarmCard, agentPlanCard } from "./lib/cards.ts";
import {
  latestNote,
  noteCard,
  noteFromUtterance,
  noteTextFromUtterance,
  recallCard,
} from "./lib/notes.ts";
import { shouldCheckIn } from "./lib/checkin.ts";
import { nextDueAt } from "./lib/datetime.ts";
import { homeWidgetPayload, onForeground, FOREGROUND_REASONS } from "./lib/native.ts";
import { haversineM, inCircle, observe, shouldAlert, markAlerted, formatDistance } from "./lib/geofence.ts";
import {
  backoffMs,
  nextAttemptAt,
  isExpired,
  trimToLimit,
  planDrain,
  onFailure,
  OUTBOX_MAX_ITEMS,
} from "./lib/outbox.ts";
import { refuseReason, riskOf, validateArgs, planCalls, dryRun, MAX_CALLS_PER_TURN } from "./lib/toolrun.ts";
import {
  newTask,
  taskTextFromUtterance,
  confirmDelayMin,
  markDone,
  deferTask,
  latestOpenTask,
  dayKey,
  taskStatsForDay,
  isOverdue,
  taskEventFor,
} from "./lib/tasks.ts";
import {
  behaviourForDay,
  behaviourEnvelope,
  gaitCvForDay,
  fallEventsForDay,
  hasMeasuredSignal,
} from "./lib/behaviour.ts";
import { runTurn } from "./lib/agent.ts";
import type { AgentDeps } from "./lib/agent.ts";
import { createToolRunner, emergencyNumber } from "./lib/toolExec.ts";
import {
  careSignals,
  careLine,
  caregiverLine,
  carePrompt,
  mentionsDiagnosis,
  CARE,
  DIAGNOSIS_WORDS,
} from "./lib/care.ts";
import type { CareSignal } from "./lib/care.ts";
import { planForeground, shouldRaiseSos, SOS_EVENT, SOS_DEBOUNCE_MS } from "./lib/foreground.ts";
import {
  TOOLS,
  confirmToolNames,
  openAiTools,
  requiredPermissions,
  toolByName,
} from "./lib/tools.ts";
import type { GaitWindow, OutboxItem, ReminderItem, SosEvent, Task, TaskEvent, ToolCall } from "./lib/types.ts";

// --- magnitude ---------------------------------------------------------------
assert.equal(magnitude(3, 4, 0), 5);

// --- fall detector: free-fall -> impact -> stillness fires -------------------
{
  const det = createFallDetector();
  const at = (t: number, az: number) => ({
    t,
    ax: 0,
    ay: 0,
    az,
    gx: 0.1,
    gy: 0.1,
    gz: 0.1,
  });
  const seq = [
    at(0, G),
    at(100, G),
    at(200, G),
    at(300, 2), // free-fall (|a| < 0.5g)
    at(400, 2),
    at(500, 45), // impact spike
    at(600, G),
    at(700, G),
    at(800, G),
    at(900, G), // >= 300ms stillness -> confirm
  ];
  const hits = seq.map((s) => det.push(s)).filter((r) => r.fall);
  assert.equal(hits.length, 1, "fall should fire exactly once");
  assert.equal(hits[0].reason, "free-fall+impact");
}

// --- fall detector: walking stays silent -------------------------------------
{
  const det = createFallDetector();
  let fired = false;
  for (let i = 0; i < 24; i++) {
    const az = G + 1.2 * Math.sin(i);
    const r = det.push({
      t: i * 100,
      ax: 0.6 * Math.sin(i * 2),
      ay: 0.6 * Math.cos(i * 2),
      az,
      gx: 2 * Math.sin(i),
      gy: 2 * Math.cos(i),
      gz: 2 * Math.sin(i * 1.5),
    });
    if (r.fall) fired = true;
  }
  assert.equal(fired, false, "walking must not trigger the fall detector");
}

// --- gaitVariability ---------------------------------------------------------
{
  const reg = gaitVariability([0, 500, 1000, 1500, 2000]);
  assert.equal(reg.steps, 5);
  assert.ok(Math.abs(reg.cadence - 120) < 1e-9, `cadence=${reg.cadence}`);
  assert.ok(Math.abs(reg.cv) < 1e-9, `cv=${reg.cv}`);
  const one = gaitVariability([0]);
  assert.equal(one.cadence, 0);
  assert.equal(one.cv, 0);
  assert.ok(!Number.isNaN(one.cv));
  const empty = gaitVariability([]);
  assert.deepEqual(empty, { steps: 0, cadence: 0, cv: 0 });
  const varied = gaitVariability([0, 400, 1000, 1300, 2000]);
  assert.ok(varied.cv > 0 && Number.isFinite(varied.cv), `varied cv=${varied.cv}`);
}

// --- detectSteps finds injected peaks ----------------------------------------
{
  const injected = [300, 800, 1300, 1800];
  const samples: { t: number; ax: number; ay: number; az: number }[] = [];
  for (let t = 0; t <= 2000; t += 20) {
    samples.push({ t, ax: 0, ay: 0, az: G + 0.5 * Math.sin(t / 100) });
  }
  for (const c of injected) {
    const s = samples.find((x) => x.t === c);
    if (s) s.az += 6;
  }
  const steps = detectSteps(samples);
  assert.equal(steps.length, injected.length, `detected=${steps.length}`);
  injected.forEach((c, i) => assert.equal(steps[i], c));
}

// --- trimSilence cuts padding ------------------------------------------------
{
  const frames = [
    ...Array.from({ length: 5 }, () => ({ rmsDb: -80 })),
    ...Array.from({ length: 6 }, () => ({ rmsDb: -20 })),
    ...Array.from({ length: 5 }, () => ({ rmsDb: -80 })),
  ];
  const { start, end } = trimSilence(frames);
  assert.equal(start, 3);
  assert.equal(end, 12);
  assert.deepEqual(trimSilence(frames.slice(0, 5)), { start: 0, end: 0 });
}

// --- energyVad ---------------------------------------------------------------
{
  const vad = energyVad([-80, -20, -20, -80], { hangoverFrames: 0 });
  assert.equal(vad.speech, true);
  assert.equal(vad.ratio, 0.5);
}

// --- escalationFor -----------------------------------------------------------
{
  const MIN = 60 * 1000;
  assert.equal(escalationFor(5 * MIN), "none");
  assert.equal(escalationFor(9 * MIN), "none");
  assert.equal(escalationFor(10 * MIN), "retry");
  assert.equal(escalationFor(29 * MIN), "retry");
  assert.equal(escalationFor(30 * MIN), "notify-caregiver");
}

// --- i18n sanity -------------------------------------------------------------
{
  assert.ok(t("zh-HK", "medReminder").includes("食藥"), "HK wording must be Cantonese");
  assert.ok(t("zh-CN", "sosConfirmQuestion").includes("不舒服"), "CN wording must be Mandarin");
  assert.ok(t("zh-MO", "healthCardTitle").length > 0);
  // req 1 (this round): the top-row toggle shows the OTHER language, so the two
  // locales must never share the same label; the wake greeting is localized too.
  assert.notEqual(t("zh-HK", "langOther"), t("zh-CN", "langOther"), "lang toggle label must differ per locale");
  assert.ok(t("zh-HK", "wakeGreeting").includes("身體"), "HK wake greeting must be Cantonese");
  assert.ok(t("zh-CN", "wakeGreeting").includes("身体"), "CN wake greeting must be Mandarin");
}

// --- intent parsing ----------------------------------------------------------
{
  assert.equal(parseIntent("听日天气点呀"), "weather");
  assert.equal(parseIntent("记得食药"), "medication");
  assert.equal(parseIntent("帮我影相"), "camera");
  assert.equal(parseIntent("救命呀"), "sos");
  assert.equal(parseIntent("今日要做咩"), "tasks");
  // req 1: "打开按钮" reveals the hidden options
  assert.equal(parseIntent("打开按钮"), "tools");
  assert.equal(parseIntent("下星期覆诊"), "followup");
  assert.equal(parseIntent("帮我记住钥匙喺抽屉"), "note");
  assert.equal(parseIntent("我记低咗咩"), "recall");
  assert.equal(parseIntent("blah blah"), "unknown");
  // conversational questions are routed to assistantChat instead of a todo card
  assert.equal(isQuestion("点算呀？"), true);
  assert.equal(isQuestion("为什么会这样"), true);
  assert.equal(isQuestion("钥匙喺抽屉"), false);
  assert.equal(isQuestion(""), false);
}

// --- memory notes (pure) -----------------------------------------------------
{
  assert.equal(noteTextFromUtterance("帮我记住钥匙喺抽屉"), "钥匙喺抽屉");
  assert.equal(noteTextFromUtterance("記住：聽日買藥"), "聽日買藥");
  assert.equal(noteTextFromUtterance("钥匙喺抽屉"), "钥匙喺抽屉");
  const note = noteFromUtterance("幫我記低 眼鏡放喺枱面", "zh-HK", 5000);
  assert.equal(note.text, "眼鏡放喺枱面");
  assert.equal(noteCard(note, "zh-HK", 5000).data?.headline, "眼鏡放喺枱面");
  assert.equal(recallCard(note, "zh-HK", 5000).kind, "info");
  const latest = latestNote([{ ...note, id: "n1", text: "a" }, { ...note, id: "n2", at: 6000, text: "b" }]);
  assert.equal(latest?.text, "b");
  assert.equal(latestNote([]), null);
}

// --- follow-up reminder card -------------------------------------------------
{
  const f = followupCard(
    { id: "f1", kind: "followup", title: "覆診", dueAt: 60_000, status: "pending", stage: "none", createdAt: 1 },
    "zh-HK",
    5000
  );
  assert.equal(f.kind, "info");
  assert.equal(f.data?.headline, "覆診");
  assert.ok(f.data?.rows?.[0]?.value, "follow-up card must show the due time");
}

// --- medication schedule -> due time -----------------------------------------
{
  const morning = new Date(2026, 0, 1, 7, 0).getTime();
  assert.equal(nextDueAt("早上", morning), new Date(2026, 0, 1, 8, 0).getTime());
  const evening = new Date(2026, 0, 1, 21, 0).getTime();
  assert.equal(nextDueAt("早上", evening), new Date(2026, 0, 2, 8, 0).getTime());
  assert.equal(nextDueAt("未注明", morning), morning + 60 * 60 * 1000);
}

// --- local card factory ------------------------------------------------------
{
  const r: ReminderItem = {
    id: "r1",
    kind: "med",
    med: { id: "m1", name: "降压药", dosage: "1粒" },
    title: "食药",
    dueAt: 1,
    status: "pending",
    stage: "none",
    createdAt: 1,
  };
  const weather = localCardsFor("weather", "zh-HK", { reminders: [], now: 1000 });
  assert.equal(weather.length, 1);
  assert.equal(weather[0].kind, "weather");
  assert.ok(weather[0].data?.headline, "weather card needs a headline");

  const tasks = localCardsFor("tasks", "zh-CN", { reminders: [r], now: 2000 });
  assert.equal(tasks[0].data?.checklist?.[0]?.text, "降压药");
  assert.equal(tasks[0].data?.checklist?.[0]?.done, false);

  const empty = localCardsFor("tasks", "zh-CN", { reminders: [], now: 3000 });
  assert.ok(empty[0].data?.headline && !empty[0].data?.checklist, "empty tasks -> headline only");

  // req 6: "say anything → a todo" — the senior's own words become the todo text
  const todo = todoCardFromUtterance("提醒我聽日去街市買餸", "zh-HK", 4000);
  assert.equal(todo.kind, "task");
  assert.equal(todo.data?.checklist?.[0]?.text, "提醒我聽日去街市買餸");
  assert.equal(todo.data?.checklist?.[0]?.done, false);
}

// --- daily check-in (req 4) --------------------------------------------------
{
  const day = 24 * 60 * 60 * 1000;
  const base = new Date(2026, 9, 11, 23, 30).getTime(); // 2026-10-11 23:30 local
  assert.equal(shouldCheckIn(null, base), true, "first ever open -> check in");
  assert.equal(shouldCheckIn(base, base + 10 * 60 * 1000), false, "same day -> no");
  assert.equal(shouldCheckIn(base, base + day), true, "next day -> yes");
}

// --- home-screen widget payload (native-shell contract) ----------------------
{
  const p = homeWidgetPayload(
    [{ id: "c1", kind: "weather", title: "天气", createdAt: 1, data: { headline: "27°C" } }],
    [],
    42
  );
  assert.equal(p.updatedAt, 42);
  assert.equal(p.topCard?.headline, "27°C");
  assert.deepEqual(p.items, []);
}

// --- agent tool registry (B contract, docs/dev.md §3.5) ----------------------
{
  assert.equal(TOOLS.length, 10, "exactly 10 tools are declared");
  const names = TOOLS.map((x) => x.name);
  assert.equal(new Set(names).size, names.length, "tool names must be unique");

  for (const x of TOOLS) {
    assert.ok(x.name.length > 0 && x.description.length > 0, `${x.name}: name+description required`);
    assert.ok(x.risk === "safe" || x.risk === "confirm", `${x.name}: illegal risk "${x.risk}"`);
    assert.equal(x.schema.type, "object", `${x.name}: parameters must be an object`);
    assert.equal(x.schema.additionalProperties, false, `${x.name}: must reject extra args`);
    for (const req of x.schema.required) {
      assert.ok(req in x.schema.properties, `${x.name}: required "${req}" is not in properties`);
    }
  }

  // The safe/confirm split is a product decision, not an accident.
  assert.deepEqual(confirmToolNames().sort(), [
    "call_contact",
    "open_app",
    "send_message",
    "ui_tap_text",
  ]);
  assert.equal(TOOLS.filter((x) => x.risk === "safe").length, 6);

  // "forbidden" is an utterance-level refusal in agent.ts, never a callable tool.
  assert.equal(names.some((n) => n.includes("transfer") || n.includes("pay")), false);

  // The shape C feeds to the model.
  const oa = openAiTools();
  assert.equal(oa.length, TOOLS.length);
  assert.equal(oa[0].type, "function");
  assert.equal(oa[0].function.parameters, TOOLS[0].schema);

  assert.equal(toolByName("sos")?.risk, "safe");
  assert.equal(toolByName("sos")?.permissions.length, 0, "sos must need no permission");
  assert.equal(toolByName("nope"), undefined);
  assert.deepEqual(requiredPermissions().sort(), [
    "ACCESSIBILITY",
    "ACCESS_FINE_LOCATION",
    "CALL_PHONE",
    "SCHEDULE_EXACT_ALARM",
  ]);
}

// --- geofence: distance, hysteresis, alert policy (B / W1) -------------------
{
  const hk = { lat: 22.2819, lng: 114.1582 };
  assert.equal(haversineM(hk, hk), 0);
  const dist = haversineM(hk, { lat: 22.2976, lng: 114.1722 }); // Central -> TST
  assert.ok(dist > 2100 && dist < 2500, `Central->TST ≈ 2.3km, got ${Math.round(dist)}`);

  const centre = { lat: 22.28, lng: 114.16 };
  assert.equal(inCircle({ lat: 22.283, lng: 114.16 }, centre, 500), true, "333m is inside");
  assert.equal(inCircle({ lat: 22.286, lng: 114.16 }, centre, 500), false, "667m is outside");

  const T0 = 1_000_000;
  let p = observe(null, { at: T0, distanceM: 100 });
  assert.equal(p.inside, true);
  assert.equal(p.since, T0);

  // a 1-second stray reading must not flip the state
  p = observe(p, { at: T0 + 1_000, distanceM: 700 });
  assert.equal(p.inside, true, "jitter must not flip state");
  assert.ok(p.pending, "jitter is held as pending");
  p = observe(p, { at: T0 + 2_000, distanceM: 100 });
  assert.equal(p.pending, null, "coming back cancels the pending flip");

  // a sustained reading DOES flip, keeping the first-seen timestamp
  p = observe(p, { at: T0 + 10_000, distanceM: 700 });
  p = observe(p, { at: T0 + 16_000, distanceM: 700 });
  assert.equal(p.inside, false);
  assert.equal(p.since, T0 + 10_000, "since = when the outside state was first seen");

  const away = { inside: false, since: T0, lastAlertAt: 0, pending: null };
  assert.equal(shouldAlert(away, T0 + 59 * 60_000), false, "59min away -> quiet");
  assert.equal(shouldAlert(away, T0 + 61 * 60_000), true, "61min away -> alert");
  const alerted = markAlerted(away, T0 + 61 * 60_000);
  assert.equal(shouldAlert(alerted, T0 + 71 * 60_000), false, "30min cooldown");
  assert.equal(shouldAlert(alerted, T0 + 92 * 60_000), true, "after cooldown -> alert again");
  assert.equal(
    shouldAlert({ inside: true, since: T0, lastAlertAt: 0, pending: null }, T0 + 600 * 60_000),
    false,
    "never alert while inside"
  );

  assert.equal(formatDistance(340), "340 米");
  assert.equal(formatDistance(1234), "1.2 公里");
}

// --- outbox replay policy (B / W1) ------------------------------------------
{
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(backoffMs), [0, 1000, 5000, 30000, 300000, 300000]);
  const now = 2_000_000;
  assert.equal(nextAttemptAt(2, now), now + 5_000);

  const mk = (id: string, createdAt: number, extra: Partial<OutboxItem> = {}): OutboxItem => ({
    id,
    kind: "telemetry",
    payload: { id },
    createdAt,
    attempts: 0,
    nextAttemptAt: 0,
    ...extra,
  });

  assert.equal(isExpired(mk("a", now - 8 * 86400_000), now), true, "8 days -> expired");
  assert.equal(isExpired(mk("b", now - 6 * 86400_000), now), false, "6 days -> keep");

  const many = Array.from({ length: OUTBOX_MAX_ITEMS + 5 }, (_, i) => mk(`m${i}`, i));
  const trimmed = trimToLimit(many);
  assert.equal(trimmed.keep.length, OUTBOX_MAX_ITEMS);
  assert.equal(trimmed.dropped.length, 5);
  assert.equal(trimmed.dropped[0].id, "m0", "oldest dropped first");
  assert.equal(trimmed.keep[0].id, "m5");

  const sosItem = mk("sos1", 900, { kind: "sos" });
  const oldItem = mk("old1", 10);
  const waiting = mk("w1", 20, { nextAttemptAt: now + 60_000 });
  const expired = mk("e1", now - 8 * 86400_000);
  const plan = planDrain([oldItem, sosItem, waiting, expired], now);
  assert.deepEqual(plan.ready.map((x) => x.id), ["sos1", "old1"], "sos jumps the queue");
  assert.deepEqual(plan.expired.map((x) => x.id), ["e1"]);
  assert.equal(plan.waiting, 1);

  assert.equal(planDrain([mk("a", 1), mk("b", 2), mk("c", 3)], now, 2).ready.length, 2);

  const failed = onFailure(mk("f", now), now, "ENETUNREACH");
  assert.equal(failed.attempts, 1);
  assert.equal(failed.nextAttemptAt, now + 1_000);
  assert.equal(failed.lastError, "ENETUNREACH");
}

// --- B intents (W1) ---------------------------------------------------------
{
  assert.equal(parseIntent("帮我打电话畀阿明"), "call");
  assert.equal(parseIntent("聽日八點較鬧鐘"), "alarm");
  assert.equal(parseIntent("发消息畀阿女"), "message");
  assert.equal(parseIntent("带我去医院"), "navigate");
  assert.equal(parseIntent("再讲一次"), "repeat");
  assert.equal(parseIntent("取消"), "cancel");

  // precedence: each of these would be swallowed by an older, broader rule
  assert.equal(parseIntent("取消聽日覆診"), "cancel", "cancel beats followup");
  assert.equal(parseIntent("幫我打畀阿明"), "call", "call beats help");
  assert.equal(parseIntent("再講一次食藥"), "repeat", "repeat beats medication");

  // no regression on the original rules
  assert.equal(parseIntent("听日天气点呀"), "weather");
  assert.equal(parseIntent("记得食药"), "medication");
  assert.equal(parseIntent("我记低咗咩"), "recall");
}

// --- B card factories (W1) --------------------------------------------------
{
  const task: Task = {
    id: "t1",
    text: "聽日十點覆診",
    dueAt: 1_800_000_000_000,
    done: false,
    source: "voice",
    deferredCount: 0,
    createdAt: 1,
  };
  const tc = taskCard(task, "zh-HK", 10);
  assert.equal(tc.kind, "task");
  assert.equal(tc.data?.checklist?.[0]?.text, "聽日十點覆診");
  assert.equal(tc.data?.checklist?.[0]?.done, false);
  assert.ok(tc.data?.rows?.[0]?.value, "a spoken due time renders a when-row");
  assert.equal(taskCard({ ...task, done: true }, "zh-HK", 10).title, "做好咗");
  assert.equal(taskCard({ ...task, dueAt: undefined }, "zh-CN", 10).data?.rows, undefined);

  const near = placeCard({ distanceM: 120, nearHome: true }, "zh-CN", 10);
  assert.equal(near.kind, "place");
  assert.equal(near.data?.headline, "在家附近");
  const far = placeCard({ distanceM: 1234, nearHome: false }, "zh-HK", 10);
  assert.equal(far.data?.headline, "離屋企 1.2 公里");
  assert.equal(far.data?.rows?.[0]?.value, "1.2 公里");

  const ac = alarmCard({ at: 1_800_000_000_000, label: "起身" }, "zh-CN", 10);
  assert.equal(ac.kind, "alarm");
  assert.equal(ac.data?.headline, "起身");

  const pc = agentPlanCard(["記住覆診", "較鬧鐘", "話畀阿女知"], "zh-HK", 10);
  assert.equal(pc.kind, "agentPlan");
  assert.equal(pc.data?.checklist?.length, 3);
  assert.equal(pc.data?.checklist?.[2]?.text, "話畀阿女知");
}

// --- toolrun: refusal / validation / planning (W1) ---------------------------
{
  assert.ok(refuseReason("帮我转账 5000 蚊", "zh-HK"), "transfer must be refused");
  assert.ok(refuseReason("你帮我输入密码", "zh-CN"), "password must be refused");
  assert.equal(refuseReason("帮我打电话畀阿明", "zh-HK"), null, "calling is allowed");
  assert.equal(refuseReason("", "zh-HK"), null);

  assert.equal(riskOf("call_contact"), "confirm");
  assert.equal(riskOf("create_task"), "safe");
  assert.equal(riskOf("transfer_money"), "unknown");

  const callTool = toolByName("call_contact")!;
  assert.equal(validateArgs(callTool, {}).ok, false, "missing required name");
  assert.equal(validateArgs(callTool, { name: "阿明" }).ok, true);
  assert.equal(validateArgs(callTool, { name: "阿明", phone: "+852" }).ok, false, "extra arg rejected");
  const openTool = toolByName("open_app")!;
  assert.equal(validateArgs(openTool, { app: "wechat" }).ok, true);
  assert.equal(validateArgs(openTool, { app: "bank" }).ok, false, "enum enforced");
  assert.equal(validateArgs(toolByName("set_alarm")!, { at: "ten", label: "x" }).ok, false, "wrong type");

  const plan = planCalls(
    [
      { name: "create_task", args: { text: "買藥" } },
      { name: "nope", args: {} },
      { name: "sos", args: { reason: "fell_down" } },
    ],
    "zh-HK"
  );
  assert.deepEqual(plan.steps.map((s) => s.name), ["sos", "create_task"], "sos runs first");
  assert.equal(plan.rejected.length, 1);
  assert.equal(plan.rejected[0].reason, "unknown_tool");

  const tooMany = planCalls(
    [
      { name: "create_task", args: { text: "a" } },
      { name: "create_task", args: { text: "b" } },
      { name: "create_task", args: { text: "c" } },
      { name: "create_task", args: { text: "d" } },
    ],
    "zh-HK"
  );
  assert.equal(tooMany.steps.length, MAX_CALLS_PER_TURN);
  assert.equal(tooMany.rejected[0].reason, "too_many");

  const confirmPlan = planCalls([{ name: "call_contact", args: { name: "陳小明" } }], "zh-HK");
  assert.equal(confirmPlan.steps[0].risk, "confirm");
  assert.ok(confirmPlan.steps[0].say.includes("陳小明"), "confirm question must name the contact");

  assert.ok(dryRun([{ name: "create_task", args: { text: "買藥" } }], "zh-CN").includes("create_task"));
  assert.equal(dryRun([], "zh-CN"), "（冇動作）");
}

// --- tasks: rules and day stats (B / W2) -------------------------------------
{
  assert.equal(taskTextFromUtterance("提醒我聽日買藥"), "聽日買藥");
  assert.equal(taskTextFromUtterance("記住覆診"), "覆診");
  assert.equal(taskTextFromUtterance("買藥"), "買藥");

  const t = newTask({ text: "食藥", now: 1_000, dueAt: 1_000 + 10 * 60_000 });
  assert.equal(t.done, false);
  assert.equal(t.deferredCount, 0);
  assert.equal(t.source, "voice");

  assert.equal(confirmDelayMin(t, t.dueAt! + 12 * 60_000), 12);
  assert.equal(confirmDelayMin({ ...t, dueAt: undefined }, 9_999), null, "no deadline -> null, not 0");
  assert.equal(confirmDelayMin(t, t.dueAt! - 5 * 60_000), 0, "early confirm clamps to 0");

  const first = markDone(t, t.dueAt! + 12 * 60_000);
  assert.equal(first.alreadyDone, false);
  assert.equal(first.delayMin, 12);
  assert.equal(first.task.done, true);

  const second = markDone(first.task, t.dueAt! + 25 * 60_000);
  assert.equal(second.alreadyDone, true, "second confirm must be flagged");
  assert.equal(second.elapsedMin, 13);
  assert.equal(second.task, first.task, "an already-done task is not rewritten");

  assert.equal(deferTask(deferTask(t)).deferredCount, 2);

  const a = newTask({ text: "a", now: 1 });
  const b = newTask({ text: "b", now: 2 });
  assert.equal(latestOpenTask([a, b])?.text, "b");
  assert.equal(latestOpenTask([{ ...a, done: true }, { ...b, done: true }]), null);

  assert.equal(dayKey(new Date(2026, 9, 24, 23, 59).getTime()), "2026-10-24");
  assert.equal(isOverdue(t, t.dueAt! + 1), true);
  assert.equal(isOverdue(first.task, t.dueAt! + 1), false, "a done task is never overdue");

  const empty = taskStatsForDay([], "2026-10-24");
  assert.equal(empty.completionRate, null, "no tasks -> null, never 0");
  assert.equal(empty.timeoutRate, null);
  assert.equal(empty.avgConfirmDelayMin, null);

  const day = "2026-10-24";
  const due1 = newTask({ text: "d1", now: 1, dueAt: new Date(2026, 9, 24, 8, 0).getTime() });
  const due2 = newTask({ text: "d2", now: 1, dueAt: new Date(2026, 9, 24, 20, 0).getTime() });
  const other = newTask({ text: "x", now: 1, dueAt: new Date(2026, 9, 25, 8, 0).getTime() });
  const stats = taskStatsForDay(
    [markDone(due1, due1.dueAt! + 10 * 60_000).task, due2, other],
    day
  );
  assert.equal(stats.dueCount, 2, "only tasks due that day count");
  assert.equal(stats.doneCount, 1);
  assert.equal(stats.completionRate, 0.5);
  assert.equal(stats.timeoutRate, 0.5);
  assert.equal(stats.avgConfirmDelayMin, 10);
}

// --- agent turn orchestration (B / W2) ---------------------------------------
{
  const baseDeps = (extra: Partial<AgentDeps> = {}): AgentDeps => ({
    locale: "zh-HK",
    now: 1_000_000,
    reminders: [],
    tasks: [],
    ...extra,
  });

  // refusal short-circuits even when a backend is available
  let reachedBackend = false;
  const refused = await runTurn(
    "帮我转账 5000",
    baseDeps({
      requestTurn: async () => {
        reachedBackend = true;
        return { reply: "x", calls: [], cards: [] };
      },
    })
  );
  assert.equal(refused.refused, true);
  assert.equal(refused.steps.length, 0);
  assert.equal(reachedBackend, false, "a refusal must never reach the network");

  // local card path needs no backend
  const local = await runTurn("听日天气点呀", baseDeps());
  assert.equal(local.handled, true);
  assert.equal(local.cards.length, 1);

  // nothing wired and not a local intent -> not ours
  assert.equal((await runTurn("打开微信", baseDeps())).handled, false);

  // backend unavailable -> NOT ours: the caller's original path must still run
  const down = await runTurn("打开微信", baseDeps({ requestTurn: async () => null }));
  assert.equal(down.handled, false, "a dead backend must not swallow the caller's fallback");
  assert.equal(down.reply, "", "no apology: the caller will speak its own answer");

  // requestTurn THROWS (timeout / 501 / offline) -> same rule
  const threw = await runTurn(
    "打开微信",
    baseDeps({
      requestTurn: async () => {
        throw new Error("502 Bad Gateway");
      },
    })
  );
  assert.equal(threw.handled, false);
  assert.equal(threw.steps.length, 0);

  // backend plans a call but no executor is wired yet -> honest degradation
  const noExec = await runTurn(
    "帮我记住听日覆诊",
    baseDeps({
      requestTurn: async () => ({
        reply: "好",
        calls: [{ name: "create_task", args: { text: "听日覆诊" } }],
        cards: [],
      }),
    })
  );
  assert.equal(noExec.steps.length, 1);
  assert.equal(noExec.skipped[0].reason, "no_executor");
  assert.ok(noExec.reply.includes("未接"), `reply=${noExec.reply}`);

  // confirm declined -> nothing runs
  let ran = false;
  const declined = await runTurn(
    "帮我打电话畀阿明",
    baseDeps({
      requestTurn: async () => ({
        reply: "",
        calls: [{ name: "call_contact", args: { name: "阿明" } }],
        cards: [],
      }),
      confirm: async () => false,
      runTool: async () => {
        ran = true;
        return { ok: true };
      },
    })
  );
  assert.equal(ran, false);
  assert.equal(declined.skipped[0].reason, "declined");

  // confirm accepted -> executes once
  const accepted = await runTurn(
    "帮我打电话畀阿明",
    baseDeps({
      requestTurn: async () => ({
        reply: "打緊",
        calls: [{ name: "call_contact", args: { name: "阿明" } }],
        cards: [],
      }),
      confirm: async () => true,
      runTool: async () => ({ ok: true }),
    })
  );
  assert.equal(accepted.executed.length, 1);
  assert.equal(accepted.executed[0].ok, true);

  // executor throws -> spoken failure, no crash
  const boom = await runTurn(
    "帮我打电话畀阿明",
    baseDeps({
      requestTurn: async () => ({
        reply: "",
        calls: [{ name: "call_contact", args: { name: "阿明" } }],
        cards: [],
      }),
      confirm: async () => true,
      runTool: async () => {
        throw new Error("no sim");
      },
    })
  );
  assert.equal(boom.executed[0].ok, false);
  assert.ok(boom.reply.includes("做唔到"), `reply=${boom.reply}`);

  // a hallucinated tool name is dropped, not executed
  const bogus = await runTurn(
    "而家几点",
    baseDeps({
      requestTurn: async () => ({
        reply: "",
        calls: [{ name: "transfer_money", args: {} }],
        cards: [],
      }),
    })
  );
  assert.equal(bogus.steps.length, 0);
  assert.equal(bogus.skipped.length, 1);
}

// --- native seam contract (B / W3) -------------------------------------------
{
  // The five reasons MainActivity can deliver; each maps to its own greeting.
  assert.equal(FOREGROUND_REASONS.length, 5);
  assert.ok(FOREGROUND_REASONS.includes("widget"));
  assert.ok(FOREGROUND_REASONS.includes("alarm"));

  // Widget payload: at most 4 rows, done flag preserved, title overridable.
  const many: ReminderItem[] = Array.from({ length: 6 }, (_, i) => ({
    id: `r${i}`,
    kind: "med",
    title: `t${i}`,
    dueAt: i,
    status: i === 0 ? "taken" : "pending",
    stage: "none",
    createdAt: 1,
  }));
  const wp = homeWidgetPayload([], many, 7, "忆伴");
  assert.equal(wp.items.length, 4, "widget shows at most 4 rows");
  assert.equal(wp.items[0].done, true);
  assert.equal(wp.title, "忆伴");
  assert.equal(wp.topCard, undefined, "no cards -> no top card");

  // Outside a browser the foreground subscription must be a harmless no-op.
  const off = onForeground(() => {});
  assert.equal(typeof off, "function");
  off();
}

// --- task events + behaviour rollup (B, wired to C's /task/events) ------------
{
  const at = (h: number, m = 0) => new Date(2026, 9, 24, h, m, 0).getTime();
  const day = dayKey(at(10));
  assert.equal(day, "2026-10-24");

  // A completed transition carries dueAt + doneAt, and its id is DETERMINISTIC:
  // an outbox replay overwrites the same backend doc instead of double-counting.
  const taken: Task = {
    ...newTask({ text: "食降壓藥", now: at(7), dueAt: at(8), id: "task-a" }),
    done: true,
    doneAt: at(8, 20),
  };
  const doneEv = taskEventFor(taken, "completed", at(8, 20));
  assert.equal(doneEv.id, `te-task-a-completed-${at(8, 20)}`);
  assert.equal(doneEv.taskId, "task-a");
  assert.equal(doneEv.dueAt, at(8));
  assert.equal(doneEv.doneAt, at(8, 20));
  assert.equal(doneEv.source, "voice");
  assert.equal(taskEventFor(taken, "completed", at(8, 20)).id, doneEv.id, "same inputs -> same id");

  // The task text NEVER enters the wire event (it may hold a drug or a name).
  assert.equal(JSON.stringify(doneEv).includes("降壓"), false, "events carry ids only, never text");

  // A deferral has no doneAt, and the cause can differ from how it was created.
  const deferredEv = taskEventFor(taken, "deferred", at(9), "reminder");
  assert.equal(deferredEv.doneAt, undefined);
  assert.equal(deferredEv.source, "reminder");
  assert.notEqual(deferredEv.id, doneEv.id, "state is part of the id");

  // --- one day's rollup -----------------------------------------------------
  const missed: Task = newTask({ text: "覆診", now: at(7), dueAt: at(9), id: "task-b" });
  const gait: GaitWindow[] = [
    { id: "g1", startedAt: at(8), endedAt: at(8) + 60_000, steps: 60, cadence: 1.8, cv: 0.2, fall: false },
    { id: "g2", startedAt: at(9), endedAt: at(9) + 60_000, steps: 55, cadence: 1.7, cv: 0.4, fall: true },
    // previous day — must not leak into today's rollup
    { id: "g0", startedAt: at(10) - 86_400_000, endedAt: at(10) - 86_400_000 + 60_000, steps: 90, cadence: 2, cv: 0.9, fall: true },
  ];

  const b = behaviourForDay({ day, tasks: [taken, missed], gait, interactionCount: 7 });
  assert.equal(b.id, "bd-2026-10-24");
  assert.equal(b.taskCompletionRate, 0.5);
  assert.equal(b.taskTimeoutRate, 0.5);
  assert.equal(b.taskConfirmDelayMin, 20);
  assert.equal(b.deferCount, 0);
  assert.equal(b.gaitCv, 0.3, "mean of 0.2 and 0.4");
  assert.equal(b.fallEvents, 1, "yesterday's fall is not today's");
  assert.equal(b.interactionCount, 7);
  assert.equal(gaitCvForDay(gait, "2026-10-23"), 0.9);
  assert.equal(fallEventsForDay(gait, "2026-10-23"), 1);

  // An unmeasured day is NULL, never 0 — "no reminder was due" is not "0% done".
  const blank = behaviourForDay({ day: "2026-10-25", tasks: [], gait: [], interactionCount: 0 });
  assert.equal(blank.taskCompletionRate, null);
  assert.equal(blank.taskTimeoutRate, null);
  assert.equal(blank.taskConfirmDelayMin, null);
  assert.equal(blank.gaitCv, null, "no window is not cv=0");
  assert.equal(blank.fallEvents, 0);
  assert.equal(hasMeasuredSignal(blank), false);
  assert.equal(hasMeasuredSignal(b), true);

  // The envelope omits circadian/digitalSkill (W4) rather than nulling them.
  assert.deepEqual(Object.keys(behaviourEnvelope(b)), ["behaviour"]);
}

// --- tool executors: create / complete / locate / sos (B, local only) --------
{
  const NOW = new Date(2026, 9, 24, 10, 0, 0).getTime();
  const saved: Task[] = [];
  const events: TaskEvent[] = [];
  const deps = (extra: Record<string, unknown> = {}) => ({
    locale: "zh-HK" as const,
    now: NOW,
    tasks: [] as Task[],
    saveTask: async (t: Task) => {
      saved.push(t);
    },
    recordEvent: async (e: TaskEvent) => {
      events.push(e);
    },
    ...extra,
  });
  const step = (name: string, args: Record<string, unknown> = {}) => ({
    name,
    risk: "safe" as const,
    args,
    say: "",
  });

  // create_task: strips the command verb, saves once, emits one event.
  const made = await createToolRunner(deps()).run(step("create_task", { text: "記住買降壓藥" }));
  assert.equal(made.ok, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].text, "買降壓藥", "the command verb is stripped before saving");
  assert.equal(events.length, 1);
  assert.equal(events[0].state, "created");
  assert.ok(made.message?.includes("買降壓藥"), `message=${made.message}`);

  // A deadline already in the past is DROPPED — saving it would fire "overdue"
  // the instant the reminder is written (regression f87d930).
  const past = await createToolRunner(deps()).run(
    step("create_task", { text: "食藥", dueAt: NOW - 3_600_000 })
  );
  assert.equal(past.ok, true);
  assert.equal(saved[1].dueAt, undefined, "a past deadline is never saved");
  const future = await createToolRunner(deps()).run(
    step("create_task", { text: "覆診", dueAt: NOW + 86_400_000 })
  );
  assert.equal(saved[2].dueAt, NOW + 86_400_000);
  assert.ok(future.message?.includes("提你"), "a real deadline is acknowledged");

  // Saying it twice is the senior repeating himself, not a second chore.
  const openOne = newTask({ text: "買降壓藥", now: NOW - 60_000, id: "task-open" });
  const beforeSaved = saved.length;
  const beforeEvents = events.length;
  const repeat = await createToolRunner(deps({ tasks: [openOne] })).run(
    step("create_task", { text: "買降壓藥" })
  );
  assert.equal(repeat.ok, true);
  assert.equal(saved.length, beforeSaved, "no duplicate task row");
  assert.equal(events.length, beforeEvents, "no duplicate created event");
  assert.ok(repeat.message?.includes("記過"), `message=${repeat.message}`);

  // Empty words are never a task.
  assert.equal((await createToolRunner(deps()).run(step("create_task", { text: "  " }))).ok, false);

  // --- complete_task --------------------------------------------------------
  const med = newTask({ text: "食降壓藥", now: NOW - 600_000, dueAt: NOW - 300_000, id: "task-med" });
  const doneSaves: Task[] = [];
  const doneEvents: TaskEvent[] = [];
  const completeDeps = (tasks: Task[]) =>
    deps({
      tasks,
      saveTask: async (t: Task) => {
        doneSaves.push(t);
      },
      recordEvent: async (e: TaskEvent) => {
        doneEvents.push(e);
      },
    });

  // Spoken words with no textual overlap still resolve, because ONE task is open.
  const first = await createToolRunner(completeDeps([med])).run(
    step("complete_task", { query: "我食咗藥" })
  );
  assert.equal(first.ok, true);
  assert.equal(doneSaves.length, 1);
  assert.equal(doneSaves[0].done, true);
  assert.equal(doneEvents.length, 1);
  assert.equal(doneEvents[0].state, "completed");
  assert.equal(doneEvents[0].taskId, "task-med");

  // Saying it again within the duplicate window: no second event, and the reply
  // says "you already confirmed" instead of "you have nothing to do".
  const second = await createToolRunner(completeDeps([doneSaves[0]])).run(
    step("complete_task", { query: "我食咗藥" })
  );
  assert.equal(second.ok, true);
  assert.equal(doneSaves.length, 1, "a second confirmation never rewrites the task");
  assert.equal(doneEvents.length, 1, "a second confirmation never double-counts");
  assert.ok(second.message?.includes("已經確認過"), `message=${second.message}`);

  // Two open tasks and words that match neither: refuse to guess.
  const twoOpen = [
    newTask({ text: "交電費", now: NOW - 7_200_000, id: "task-a" }),
    newTask({ text: "覆診", now: NOW - 3_600_000, id: "task-b" }),
  ];
  const guessSaves: Task[] = [];
  const ambiguous = await createToolRunner(
    deps({ tasks: twoOpen, saveTask: async (t: Task) => { guessSaves.push(t); } })
  ).run(step("complete_task", { query: "我食咗藥" }));
  assert.equal(ambiguous.ok, false, "ticking the wrong chore is worse than asking");
  assert.equal(guessSaves.length, 0);
  assert.ok(ambiguous.message?.includes("邊件"), `message=${ambiguous.message}`);

  // A hallucinated id must not tick some other task.
  const ghost = await createToolRunner(deps({ tasks: [med] })).run(
    step("complete_task", { taskId: "task-does-not-exist" })
  );
  assert.equal(ghost.ok, false);
  assert.equal(guessSaves.length, 0);

  // Nothing open at all.
  const idle = await createToolRunner(deps()).run(step("complete_task", {}));
  assert.equal(idle.ok, false);
  assert.ok(idle.message?.includes("冇未做"), `message=${idle.message}`);

  // --- locate: never read the numbers aloud --------------------------------
  const here = await createToolRunner(
    deps({ locate: async () => ({ lat: 22.3193, lng: 114.1694, accuracy: 40 }) })
  ).run(step("locate"));
  assert.equal(here.ok, true);
  assert.equal(/22\.3|114\.1/.test(here.message ?? ""), false, "a senior cannot use a coordinate");

  const denied = await createToolRunner(deps({ locate: async () => null })).run(step("locate"));
  assert.equal(denied.ok, false);
  assert.ok(denied.message?.includes("定位"), `message=${denied.message}`);

  // --- sos ------------------------------------------------------------------
  const raised: string[] = [];
  const sent: string[] = [];
  const sosRunner = createToolRunner(
    deps({
      raiseSos: (e: SosEvent) => {
        raised.push(e.id);
      },
      sendSos: async (e: SosEvent) => {
        sent.push(e.id);
      },
    })
  );
  const sosOut = await sosRunner.run(step("sos", { reason: "fell_down" }));
  assert.equal(sosOut.ok, true);
  assert.equal(raised.length, 1, "the overlay is raised before any IO");
  assert.equal(sent[0], `sos-${NOW}`, "the id is deterministic so a replay pages the family once");
  assert.equal(raised[0], sent[0]);

  // A failed queue still raised the UI, and says so honestly.
  const offline = await createToolRunner(
    deps({
      raiseSos: () => {},
      sendSos: async () => {
        throw new Error("offline");
      },
    })
  ).run(step("sos", {}));
  assert.equal(offline.ok, false);
  assert.ok(offline.message?.includes("一有網"), `message=${offline.message}`);

  // No delivery path at all -> tell him the number instead of pretending.
  const localOnly = await createToolRunner(deps()).run(step("sos", {}));
  assert.equal(localOnly.ok, true);
  assert.ok(localOnly.message?.includes("999"), `message=${localOnly.message}`);
  assert.equal(emergencyNumber("zh-CN"), "120");

  // --- canRun: never ask a question we cannot follow through on ------------
  const runner = createToolRunner(deps());
  assert.equal(runner.canRun("create_task"), true);
  assert.equal(runner.canRun("complete_task"), true);
  assert.equal(runner.canRun("locate"), false, "no locate dependency -> not runnable");
  assert.equal(runner.canRun("call_contact"), false);
  assert.equal(runner.canRun("set_alarm"), false);
  assert.equal(runner.canRun("ui_tap_text"), false);

  let asked = false;
  const noAsk = await runTurn(
    "帮我打电话畀阿明",
    {
      locale: "zh-HK",
      now: NOW,
      reminders: [],
      tasks: [],
      canRun: runner.canRun,
      runTool: runner.run,
      confirm: async () => {
        asked = true;
        return true;
      },
      requestTurn: async () => ({
        reply: "",
        calls: [{ name: "call_contact", args: { name: "阿明" } }],
        cards: [],
      }),
    }
  );
  assert.equal(asked, false, "must not ask 'shall I call 阿明?' when dialing is not wired");
  assert.equal(noAsk.executed.length, 0);
  assert.ok(noAsk.reply.includes("未接"), `reply=${noAsk.reply}`);

  // The executor's own line is what gets spoken — not the planner's filler.
  const spoke = await runTurn(
    "帮我记住买药",
    {
      locale: "zh-HK",
      now: NOW,
      reminders: [],
      tasks: [],
      canRun: runner.canRun,
      runTool: runner.run,
      requestTurn: async () => ({
        reply: "好，我幫你記住咗。",
        calls: [{ name: "create_task", args: { text: "買藥" } }],
        cards: [],
      }),
    }
  );
  assert.equal(spoke.executed.length, 1);
  assert.equal(spoke.reply, made.message?.replace("買降壓藥", "買藥"), "one sentence, not two");
  assert.equal(spoke.reply.includes("幫你記住咗"), false, "the planner's filler is dropped");
}

// --- care signals: observations, never an emotion label (B / elderly UX) -----
{
  // THE rule this module exists for: a quiet day with no personal baseline is
  // NOT a signal. "We did not observe" and "he withdrew" are different facts.
  assert.deepEqual(careSignals({ today: { interactions: 0 } }), [], "silence alone is not a signal");
  assert.deepEqual(careSignals({ today: { interactions: 0 }, baseline: { interactions: 4 } }), [],
    "a baseline below the floor is not a baseline");
  assert.deepEqual(careSignals({ today: {} }), [], "no measurement, no finding");

  // A genuine drop against a real personal baseline IS worth asking about.
  assert.deepEqual(careSignals({ today: { interactions: 2 }, baseline: { interactions: 10 } }), [
    "fewer_interactions",
  ]);
  assert.deepEqual(careSignals({ today: { interactions: 6 }, baseline: { interactions: 10 } }), [],
    "a normal day is normal");

  // Thresholds are inclusive at the boundary and ordered strongest-first.
  assert.deepEqual(careSignals({ today: { fallEvents: 1, interactions: 2 }, baseline: { interactions: 10 } }),
    ["falls_or_sos", "fewer_interactions"]);
  assert.deepEqual(careSignals({ today: { painMentions: CARE.painAtLeast } }), ["pain_mentions"]);
  assert.deepEqual(careSignals({ today: { painMentions: CARE.painAtLeast - 1 } }), []);
  assert.deepEqual(careSignals({ today: { unheard: 3 } }), ["repeated_unheard"]);
  assert.deepEqual(careSignals({ today: { nightWakeCount: 3 } }), ["night_activity"]);
  assert.deepEqual(careSignals({ today: { repeats: 3 } }), ["repeated_question"]);
  assert.deepEqual(careSignals({ today: { sodEvents: 1 } as never }), [], "an unknown counter is ignored");

  // The senior hears ONE open question, the strongest one.
  const hot = careSignals({ today: { fallEvents: 1, interactions: 1, painMentions: 5 }, baseline: { interactions: 10 } });
  assert.equal(careLine(hot, "zh-HK"), careLine(["falls_or_sos"], "zh-HK"));
  assert.equal(carePrompt({ today: {} }, "zh-HK"), null, "nothing to say means saying nothing");

  // Every line, every locale: an observation + a question, never a diagnosis.
  const allSignals: CareSignal[] = [
    "fewer_interactions",
    "repeated_unheard",
    "repeated_question",
    "pain_mentions",
    "night_activity",
    "falls_or_sos",
  ];
  for (const locale of ["zh-HK", "zh-MO", "zh-CN"] as const) {
    for (const s of allSignals) {
      const ask = careLine([s], locale) ?? "";
      const fam = caregiverLine([s], locale) ?? "";
      assert.ok(ask.length > 0, `missing senior copy for ${s}/${locale}`);
      assert.ok(fam.length > 0, `missing caregiver copy for ${s}/${locale}`);
      assert.equal(mentionsDiagnosis(ask), false, `${s}/${locale} senior copy must not diagnose: ${ask}`);
      assert.equal(mentionsDiagnosis(fam), false, `${s}/${locale} caregiver copy must not diagnose: ${fam}`);
    }
  }
  // The scanner itself has to work, or the loop above proves nothing.
  assert.equal(mentionsDiagnosis("長者可能抑鬱"), true);
  assert.equal(mentionsDiagnosis("detected low mood"), false, "the word list is Chinese + a few English stems");
  assert.ok(DIAGNOSIS_WORDS.length > 5);
}

// --- foreground decision table (B / W3 consumption side) --------------------
{
  for (const reason of FOREGROUND_REASONS) {
    const plan = planForeground(reason, "zh-HK");
    assert.ok(["silent", "listen", "speak", "refresh"].includes(plan.kind), `no plan for ${reason}`);
    if (plan.kind === "silent") assert.equal(reason, "boot", "only boot may stay silent");
    if (plan.kind === "listen" || plan.kind === "speak") {
      assert.ok(plan.say.length > 0);
      assert.equal(mentionsDiagnosis(plan.say), false);
    }
  }

  // A reboot re-arms alarms; it must never start talking in an empty room.
  assert.equal(planForeground("boot", "zh-HK").kind, "silent");
  // Reaching for the widget means "listen to me", not "lecture me".
  const widget = planForeground("widget", "zh-HK");
  assert.equal(widget.kind, "listen");
  assert.equal(planForeground("alarm", "zh-HK").kind, "speak");
  // A reminder's own prompt is already on screen; two voices would collide.
  assert.equal(planForeground("reminder", "zh-HK").kind, "refresh");
  assert.equal(planForeground("notification", "zh-HK").kind, "refresh");
  assert.equal(planForeground("widget", "zh-CN").kind, "listen");

  // The lock-screen SOS hot zone is pressable from a pocket.
  const now = 1_000_000;
  assert.equal(shouldRaiseSos(null, now), true);
  assert.equal(shouldRaiseSos(now - SOS_DEBOUNCE_MS + 1, now), false, "a double tap must not page twice");
  assert.equal(shouldRaiseSos(now - SOS_DEBOUNCE_MS, now), true);
  assert.equal(SOS_EVENT, "memomate:sos");
}

// --- elderly regression: unlettered, mixed-language, unhandled --------------
{
  const NOW = new Date(2026, 9, 24, 11, 0, 0).getTime();
  const quiet: AgentDeps = { locale: "zh-HK", now: NOW, reminders: [], tasks: [] };

  // Nothing wired and nothing understood -> NOT ours. A's own path still runs.
  assert.equal((await runTurn("我唔識點做", quiet)).handled, false);
  assert.equal((await runTurn("喂？有人嗎？", quiet)).handled, false);

  // Cantonese + English in one breath must not be mangled into a chore.
  const mixed = await runTurn("幫我 remember 買牛奶", {
    ...quiet,
    requestTurn: async (req) => ({
      reply: "",
      calls: [{ name: "create_task", args: { text: req.utterance } }],
      cards: [],
    }),
  });
  assert.equal(mixed.executed.length > 0 || mixed.skipped.length > 0, true);

  // A refusal is spoken, never silently swallowed, and never reaches the model.
  let reached = false;
  const refused = await runTurn("幫我轉賬畀阿明", {
    ...quiet,
    requestTurn: async () => {
      reached = true;
      return { reply: "", calls: [], cards: [] };
    },
  });
  assert.equal(refused.refused, true);
  assert.equal(reached, false);
  assert.ok(refused.reply.includes("做唔到"), `reply=${refused.reply}`);
}

console.log("selfcheck: OK");