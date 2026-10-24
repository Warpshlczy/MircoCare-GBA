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
} from "./lib/tasks.ts";
import { runTurn } from "./lib/agent.ts";
import type { AgentDeps } from "./lib/agent.ts";
import {
  TOOLS,
  confirmToolNames,
  openAiTools,
  requiredPermissions,
  toolByName,
} from "./lib/tools.ts";
import type { OutboxItem, ReminderItem, Task, ToolCall } from "./lib/types.ts";

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

  // backend unavailable still produces something hearable
  const down = await runTurn("打开微信", baseDeps({ requestTurn: async () => null }));
  assert.equal(down.handled, true);
  assert.ok(down.reply.length > 0);

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

console.log("selfcheck: OK");