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
import { parseIntent } from "./lib/intent.ts";
import { localCardsFor, followupCard, todoCardFromUtterance } from "./lib/cards.ts";
import {
  latestNote,
  noteCard,
  noteFromUtterance,
  noteTextFromUtterance,
  recallCard,
} from "./lib/notes.ts";
import { shouldCheckIn } from "./lib/checkin.ts";
import { homeWidgetPayload } from "./lib/native.ts";
import type { ReminderItem } from "./lib/types.ts";

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

console.log("selfcheck: OK");