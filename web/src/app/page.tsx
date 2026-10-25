"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Avatar } from "@/components/Avatar";
import { CardBoard } from "@/components/CardBoard";
import { CardSheet } from "@/components/CardSheet";
import { CameraOverlay } from "@/components/CameraOverlay";
import { ReminderOverlay } from "@/components/ReminderOverlay";
import { SosOverlay } from "@/components/SosOverlay";
import { HealthCardSheet } from "@/components/HealthCardSheet";
import { ScreeningOverlay } from "@/components/ScreeningOverlay";
import { FollowupSheet } from "@/components/FollowupSheet";
import { useReminder } from "@/hooks/useReminder";
import { useGaitMonitor, flushGaitUploads } from "@/hooks/useGaitMonitor";
import { useWakeWord } from "@/hooks/useWakeWord";
import { useAgentBridge } from "@/hooks/useAgentBridge";
import {
  cancelSpeech,
  ensureAudioUnlocked,
  speak,
  listenOnce,
  createAmplitudeMeter,
  sttSupported,
  usesBackendStt,
} from "@/lib/audio";
import { parseIntent, isQuestion } from "@/lib/intent";
import {
  localCardsFor,
  followupCard,
  photoCard,
  recordsCard,
  tasksCard,
  weatherSpoken,
} from "@/lib/cards";
import { latestNote, noteCard, noteFromUtterance, recallCard } from "@/lib/notes";
import { nextDueAt } from "@/lib/datetime";
import { assistantChat, createPairingCode, ensureSeniorSession, getAgentCards, getHealthCard, getMedicationPlan, postConversationMemory, postReminderEscalation } from "@/lib/api";
import { all, get, put } from "@/lib/db";
import { flush, track } from "@/lib/analytics";
import { bridge, homeWidgetPayload, nativeAvailable, onForeground } from "@/lib/native";
import { planForeground, planOpen, shouldRaiseSos, SOS_EVENT } from "@/lib/foreground";
import { dayKey } from "@/lib/tasks";
import { addRecord, todayRecords } from "@/lib/recordStore";
import { completeTask, listTasks } from "@/lib/taskStore";
import { careForSenior, saveCareCounters } from "@/lib/careStore";
import { setHome } from "@/lib/geofenceStore";
import { recordInteractionForBehaviour } from "@/lib/behaviourStore";
import type { CareCounters } from "@/lib/care";
import {
  emptyProactiveRecord,
  planProactive,
  recordSpoke,
  WAKE_HINT_DAYS,
  type ProactiveRecord,
  type ProactiveTrigger,
} from "@/lib/proactive";
import {
  ANSWER_TIMEOUT_MS,
  careCue,
  isYes,
  pickNext,
  shouldStop,
  textFor,
  todayLine,
  type InterviewHistory,
  type InterviewState,
} from "@/lib/interview";
import { t, pickT, type MsgKey } from "@/lib/i18n";
import type {
  AgentCard,
  AssistantState,
  ConversationTurn,
  HealthCard,
  Intent,
  Locale,
  Note,
  RecordEntry,
  ReminderItem,
  SosEvent,
} from "@/lib/types";

const DEMO_CARD: HealthCard = {
  id: "hc-demo",
  name: "陈婆婆",
  age: 82,
  bloodType: "A+",
  allergies: ["青霉素"],
  chronicConditions: ["高血压", "二型糖尿病"],
  medications: ["氨氯地平 5mg", "二甲双胍 500mg"],
  emergencyContact: { name: "陈先生（儿子）", phone: "+852 9000 0000" },
  updatedAt: Date.now(),
};

function reminderFromPlanItem(
  it: { name: string; dosage: string; schedule: string },
  now: number,
  i: number
): ReminderItem {
  // ponytail: only common slots (早上/中午/下午/晚上/睡前) map to a due time;
  // unknown schedules fall back to +1h. Upgrade: backend returns explicit dueAt.
  const title = it.schedule ? `${it.name}（${it.schedule}）` : it.name;
  return {
    id: `plan-${now}-${i}`,
    kind: "med",
    med: { id: `m-${now}-${i}`, name: title, dosage: it.dosage },
    title,
    dueAt: nextDueAt(it.schedule, now),
    status: "pending",
    stage: "none",
    createdAt: now,
  };
}

type DisplayMode = "standard" | "hc" | "large";
const DISPLAY_NEXT: Record<DisplayMode, DisplayMode> = { standard: "hc", hc: "large", large: "standard" };
const DISPLAY_LABEL: Record<DisplayMode, MsgKey> = { standard: "displayStandard", hc: "displayHc", large: "displayLarge" };
const DISPLAY_KEY = "memomate.display";

/**
 * A's daily care counters (care.ts contract). Only counters A can actually
 * observe are filled; `null`/absent stays "not measured", never 0.
 * Persisted in `meta` so a reload does not restart today at zero.
 */
interface CareDayCounts {
  id: "careDay";
  day: string;
  interactions: number;
  unheard: number;
  repeats: number;
  sos: number;
}

const emptyCareDay = (): CareDayCounts => ({
  id: "careDay",
  day: dayKey(Date.now()),
  interactions: 0,
  unheard: 0,
  repeats: 0,
  sos: 0,
});

const MAX_CARDS = 6;
const MEMORY_TURNS = 20;
/** "今日會唔會落雨?" → the spoken answer must lead with yes/no. */
function isRainQuestion(text: string): boolean {
  return /(落雨|下雨|雨|雪)/.test(text ?? "");
}
/** Speech must be at least this loud (0..1 meter) to count as a real utterance. */
const VOICE_PEAK_MIN = 0.08;
/** Two misses in a row (or no voice at all) → the buttons open by themselves. */
const STT_FAILS_BEFORE_BUTTONS = 2;
/** Returning to the foreground more often than this does not re-greet. */
const OPEN_COOLDOWN_MS = 20_000;
/** The native alarm wakes the app for the daily interview at this local time. */
const INTERVIEW_HOUR = 10;
const TICK_MS = 60_000;

export default function Page() {
  const [locale, setLocale] = useState<Locale>("zh-HK");
  const [state, setState] = useState<AssistantState>("idle");
  const [level, setLevel] = useState(0);
  const [caption, setCaption] = useState("");
  const [sosOpen, setSosOpen] = useState(false);
  const [sosReason, setSosReason] = useState<SosEvent["reason"]>("button");
  const [sosSource, setSosSource] = useState<SosEvent["source"]>("app");
  const [cardOpen, setCardOpen] = useState(false);
  /** Query answers (weather / free chat) take the whole screen, not the card stream. */
  const [sheetCard, setSheetCard] = useState<AgentCard | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [display, setDisplay] = useState<DisplayMode>("standard");
  const [healthCard, setHealthCard] = useState<HealthCard>(DEMO_CARD);
  const [screeningOpen, setScreeningOpen] = useState(false);
  const [followupOpen, setFollowupOpen] = useState(false);
  // Wake word is ON by default. The extra options stay hidden behind voice.
  const [wakeOn, setWakeOn] = useState(true);
  // Zero-UI: the tools panel is revealed by voice ("打开按钮" → `tools`) or
  // automatically when voice can't work.
  const [showTools, setShowTools] = useState(false);
  const [text, setText] = useState("");
  const [cards, setCards] = useState<AgentCard[]>([]);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  /** today's durable records, mirrored so the home screen can show one line */
  const [todayLog, setTodayLog] = useState<RecordEntry[]>([]);
  /** open chores, mirrored so a card tick updates the home screen at once */
  const [openCount, setOpenCount] = useState(0);

  const reminder = useReminder([], {
    onEscalate: (item) => {
      track("reminder_escalated", locale, { kind: item.kind });
      void postReminderEscalation({
        id: item.id,
        at: Date.now(),
        locale,
        kind: item.kind,
        stage: "notify-caregiver",
      }).catch(() => {
        /* offline: the local escalation still shows; the outbox is the delivery seam */
      });
    },
  });
  const gait = useGaitMonitor();
  const meterRef = useRef<{ getLevel: () => number; stop: () => void } | null>(null);
  const levelTimer = useRef<number | null>(null);
  const historyRef = useRef<ConversationTurn[]>([]);
  const startedRef = useRef(false);
  const talkButtonRef = useRef<HTMLButtonElement>(null);
  const toolsRef = useRef<HTMLElement>(null);
  const focusToolsRef = useRef(false);

  // --- the conversation state machine ---------------------------------------
  // `stateRef` is written synchronously by go() so two triggers in the same tick
  // (e.g. a widget tap + the visibility change it causes) see each other.
  const stateRef = useRef<AssistantState>(state);
  const go = (s: AssistantState) => {
    stateRef.current = s;
    setState(s);
  };
  // Every utterance gets a generation number. interrupt() bumps it, so a
  // cancelled line can never flip the state back to idle under a newer turn.
  const speechGen = useRef(0);
  const lastLineRef = useRef("");
  const interviewing = useRef(false);
  const interviewAbort = useRef(false);
  const sttFails = useRef(0);
  const proRef = useRef<ProactiveRecord>(emptyProactiveRecord());
  const proLoaded = useRef(false);
  const repeats = useRef(new Map<string, number>());
  const careRef = useRef<CareDayCounts>(emptyCareDay());
  // Any overlay owns the screen and the speaker; proactive talk must wait.
  const blockedRef = useRef(false);
  blockedRef.current = sosOpen || cameraOpen || cardOpen || screeningOpen || followupOpen || !!sheetCard || !!reminder.due;

  const clearMeter = useCallback(() => {
    if (levelTimer.current !== null) {
      window.clearInterval(levelTimer.current);
      levelTimer.current = null;
    }
    meterRef.current?.stop();
    meterRef.current = null;
  }, []);

  const pushCards = useCallback((next: AgentCard[]) => {
    if (!next.length) return;
    setCards((prev) => [...next, ...prev].slice(0, MAX_CARDS));
  }, []);

  /** Re-read today's durable records (one indexed read; the volume is tiny). */
  const refreshRecords = useCallback(async () => {
    setTodayLog(await todayRecords(Date.now()).catch(() => []));
  }, []);

  const refreshTasks = useCallback(async () => {
    const rows = await listTasks().catch(() => []);
    setOpenCount(rows.filter((x) => !x.done).length);
  }, []);

  // --- conversation memory (local first; the POST never loses it) ---
  const remember = async (role: ConversationTurn["role"], content: string) => {
    const turn: ConversationTurn = { id: `t-${Date.now()}-${role}`, at: Date.now(), role, text: content, locale };
    historyRef.current = [...historyRef.current, turn].slice(-MEMORY_TURNS);
    void put("conversation", turn);
    try {
      await postConversationMemory(turn);
    } catch {
      /* offline — the turn is already safe in IndexedDB */
    }
  };

  const latest = useRef({
    onTalk: (_prompt?: string) => Promise.resolve(),
    proactive: (_trigger: ProactiveTrigger) => {},
    openSos: (_reason: SosEvent["reason"], _source?: SosEvent["source"]) => {},
    say: (_line: string) => {},
    refresh: () => {},
    /** widget 「今日記錄」 row: show the card, no mic, no speech */
    showRecords: () => {},
  });

  const wake = useWakeWord(locale, wakeOn, () => {
    // Calling the name is an explicit request (requirement 1 & 3): answer it and
    // start listening — including when it interrupts a sentence half-spoken.
    // Only screens that own the microphone/screen (SOS, reminder, camera,
    // screening, follow-up form) keep priority over it.
    if (sosOpen || cameraOpen || screeningOpen || followupOpen || reminder.due) return;
    if (sheetCard) {
      cancelSpeech();
      setSheetCard(null);
    }
    if (interviewing.current) interviewAbort.current = true;
    // A short acknowledgement, not the long greeting: he called the name to
    // interrupt, so the listening window must open in about a second.
    void latest.current.onTalk(t(locale, "wakeAck"));
  });
  const { activity: wakeActivity, sleep: wakeSleep, stopListening: stopWake } = wake;

  const settle = () => {
    go("idle");
    wakeSleep(); // re-arm the wake listener now that we're quiet
  };

  /** Speak one line with lip-sync + caption. Resolves false if interrupted. */
  const say = async (line: string): Promise<boolean> => {
    const my = ++speechGen.current;
    lastLineRef.current = line;
    setCaption(line);
    go("speaking");
    await speak(line, locale, (v) => {
      if (speechGen.current === my) setLevel(v);
    });
    if (speechGen.current !== my) return false;
    setLevel(0);
    return true;
  };

  /** say() and then go back to idle. B's bridge speaks through this. */
  const speechRef = useRef<Promise<boolean> | null>(null);
  const speakLine = async (line: string) => {
    const run = say(line);
    speechRef.current = run;
    if (await run) settle();
  };
  /** Resolves when nothing is being said — the interview must not talk over it. */
  const speechIdle = async () => {
    await speechRef.current?.catch(() => false);
  };

  /** Barge-in: stop talking, stop the interview, keep the mic for the senior. */
  const interrupt = () => {
    speechGen.current++;
    interviewAbort.current = true;
    cancelSpeech();
    setLevel(0);
  };

  const saveProactive = (r: ProactiveRecord) => {
    proRef.current = r;
    void put("meta", r).catch(() => {});
  };

  // --- A's care counters (care.ts contract, issue #1) ---------------------
  // Only the counters A can actually observe are filled. `unheard` counts
  // failed recognitions, `repeats` counts a question asked again, `sos`
  // counts SOS screens opened. painMentions / nightWakeCount / fallEvents
  // stay absent: A has no honest measurement for the first two, and
  // careStore fills falls from B's gait accumulator.
  const careCounters = (): Partial<CareCounters> => {
    const c = careRef.current;
    return {
      interactions: c.interactions,
      unheard: c.unheard,
      repeats: c.repeats,
      sosEvents: c.sos,
    };
  };

  /** Bumps one counter, keeps today's row across reloads, feeds the baseline. */
  const bumpCare = (key: "interactions" | "unheard" | "repeats" | "sos") => {
    const today = dayKey(Date.now());
    if (careRef.current.day !== today) careRef.current = emptyCareDay();
    careRef.current[key] += 1;
    void put("meta", careRef.current).catch(() => {});
    // A day with at least one measured interaction becomes baseline material.
    void saveCareCounters(careCounters(), Date.now());
  };

  // Feeds `lastInteractionAt` (silence care), A's current-day counters, and
  // C's interaction telemetry (issue #3).
  const noteInteraction = (source: "voice" | "text" | "button" | "interview") => {
    saveProactive({ ...proRef.current, lastInteractionAt: Date.now() });
    bumpCare("interactions");
    // B's behaviour counter sees taps; conversation memory does not.
    void recordInteractionForBehaviour(Date.now());
    track("interaction", locale, { source });
  };

  const openSos = (reason: SosEvent["reason"], source: SosEvent["source"] = "app") => {
    interrupt();
    // The care counter is bumped by SosOverlay once the backend ACCEPTS the
    // event (issue #1 §2.1): a screen the senior cancels during the countdown
    // is not an SOS and must not enter the weekly report.
    setSosReason(reason);
    setSosSource(source);
    setSosOpen(true);
    track("sos_trigger", locale, { reason, source });
    settle();
  };

  /** `refresh` plan: re-read persisted state, say nothing (docs/dev.md §2.4 A-9). */
  const refresh = () => {
    void all<ReminderItem>("reminders")
      .then((rows) => rows.forEach((r) => reminder.schedule(r)))
      .catch(() => {});
  };

  const openTools = () => {
    focusToolsRef.current = true;
    setShowTools(true);
  };

  /** Voice cannot work here: open the buttons and say so (never a dead end). */
  const failOpen = () => {
    openTools();
    void speakLine(t(locale, "voiceUnavailable"));
  };

  /**
   * Explicit "this is my home" confirmation (B's setHome). The fence never
   * infers a home point: asking for location before the senior opts in is the
   * fastest way to get the app uninstalled, and "first fix = home" breaks when
   * that fix happens at a clinic.
   */
  const confirmHome = async () => {
    const native = bridge();
    let loc: { lat: number; lng: number } | null = native ? await native.getLocation().catch(() => null) : null;
    if (!loc && typeof navigator !== "undefined" && navigator.geolocation) {
      loc = await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
          () => resolve(null),
          { timeout: 8000, maximumAge: 0 }
        );
      });
    }
    if (!loc) {
      await speakLine(t(locale, "setHomeFail"));
      return;
    }
    await setHome({ lat: loc.lat, lng: loc.lng });
    track("home_set", locale);
    await speakLine(t(locale, "setHomeOk"));
  };

  // ponytail: "the same question" = the same normalized text on the same day,
  // kept in memory only (resets on reload). Ceiling: paraphrases count as new.
  // Upgrade path: on-device sentence embedding. Never told to the senior.
  const countRepeat = (said: string) => {
    if (!isQuestion(said)) return;
    const key = `${new Date().toDateString()}|${said.replace(/[\s，。？?！!、]/g, "")}`;
    const n = (repeats.current.get(key) ?? 0) + 1;
    repeats.current.set(key, n);
    if (n >= 2) bumpCare("repeats"); // asked again — the care signal, not the first ask
    if (n === 3) track("repeat_question", locale, { count: n });
  };

  /** Spoken yes/no for B's confirm-class tools. Silence or doubt → false. */
  const askYesNo = async (question: string): Promise<boolean> => {
    stopWake();
    if (!(await say(question))) return false;
    go("listening");
    const heard = await listenOnce(locale, ANSWER_TIMEOUT_MS);
    go("thinking");
    if (heard?.text) {
      noteInteraction("voice");
      void remember("user", heard.text);
    }
    return heard ? isYes(heard.text) === true : false;
  };

  // §2.4 A5 #9：`onSos` 由桥在急救工具真正执行时回调（issue #1）。
  const agentDeps = {
    locale,
    reminders: reminder.items,
    onCards: pushCards,
    onSpeak: (line: string) => void speakLine(line),
    onConfirm: askYesNo,
    onSos: () => openSos("voice"),
    // "我食咗藥" answered by voice must also clear today's reminder, not only
    // write the record — otherwise the overlay keeps asking a dose already taken.
    onMedTaken: (name: string) => {
      reminder.takeMedication(name);
      void refreshRecords();
    },
  };
  const agent = useAgentBridge(agentDeps);

  // Appointment reminders use a native date/time picker instead of fragile
  // speech-to-time parsing. Opening it stops the wake listener and blocks
  // converse() triggers until the sheet closes.
  const openFollowup = () => {
    interrupt();
    stopWake();
    go("confirming");
    setFollowupOpen(true);
    setCaption(t(locale, "followupPrompt"));
    void speak(t(locale, "followupPrompt"), locale);
  };

  // --- one spoken turn: any (recognized, valid) utterance is routed to the agent ---
  const runIntent = async (intent: Intent, utterance: string) => {
    const now = Date.now();
    track("intent", locale, { intent });

    if (intent === "camera") {
      setCameraOpen(true);
      settle();
      return;
    }
    if (intent === "sos") {
      openSos("voice");
      return;
    }
    if (intent === "tools") {
      openTools();
      await speakLine(t(locale, "toolsOpened"));
      return;
    }
    if (intent === "followup") {
      openFollowup();
      return;
    }
    if (intent === "repeat") {
      await speakLine(lastLineRef.current || t(locale, "greeting"));
      return;
    }
    if (intent === "cancel") {
      await speakLine(t(locale, "cancelled"));
      return;
    }
    // Private memory notes: text stays on-device; only a coarse length is tracked.
    if (intent === "note") {
      const note = noteFromUtterance(utterance, locale, now);
      await put("notes", note).catch(() => undefined);
      pushCards([noteCard(note, locale, now)]);
      track("note_saved", locale, { length: note.text.length });
      await speakLine(`${t(locale, "noteSavedTitle")}：${note.text}`);
      return;
    }
    if (intent === "recall") {
      const rows = await all<Note>("notes").catch(() => []);
      const note = latestNote(rows);
      if (!note) {
        await speakLine(t(locale, "noteEmpty"));
        return;
      }
      pushCards([recallCard(note, locale, now)]);
      track("note_recall", locale);
      await speakLine(`${t(locale, "noteRecallTitle")}：${note.text}`);
      return;
    }

    // Weather: real data from C (no LLM needed), a direct answer, then the card
    // on its own screen. The senior asked a yes/no question — never answer with
    // silence (issue #3 / #4).
    if (intent === "weather") {
      let weatherCard: AgentCard | null = null;
      try {
        const planned = await getAgentCards({
          intent,
          utterance: utterance || t(locale, "weatherTitle"),
          locale,
          now,
        });
        weatherCard = planned[0] ?? null;
      } catch {
        /* offline: the honest local card below */
      }
      const mode: "agent" | "local" = weatherCard ? "agent" : "local";
      if (!weatherCard) weatherCard = localCardsFor("weather", locale, { reminders: reminder.items, now })[0];
      pushCards([weatherCard]);
      track("card_shown", locale, { intent, mode });
      setSheetCard(weatherCard);
      await speakLine(weatherSpoken(weatherCard, locale, isRainQuestion(utterance)));
      return;
    }

    // Free-form conversation gets a real, non-templated answer from the model
    // (with the last few turns as context). Failures fall through to the normal
    // card/todo path so the senior is never blocked by a slow backend.
    if (intent === "unknown" || intent === "help") {
      try {
        const recent = historyRef.current.slice(-8).map((turn) => ({ role: turn.role, content: turn.text }));
        const last = recent[recent.length - 1];
        if (!last || last.content !== utterance) recent.push({ role: "user", content: utterance });
        const { reply } = await assistantChat({ messages: recent, locale });
        const answer = reply.trim();
        if (answer) {
          const card: AgentCard = {
            id: `chat-${now}`,
            kind: "info",
            title: t(locale, "assistantTitle"),
            createdAt: now,
            data: { icon: "💬", headline: answer },
          };
          pushCards([card]);
          track("assistant_chat", locale);
          setSheetCard(card);
          await speakLine(answer);
          return;
        }
      } catch {
        /* LLM disabled/offline: fall through to the todo path */
      }
    }

    // Medication can be derived from past conversations + profile + what the
    // senior just said. Offline we fall through to the local card path below.
    if (intent === "medication") {
      try {
        const plan = await getMedicationPlan({ locale, utterance, history: historyRef.current, now });
        if (plan.items?.length) {
          const built = plan.items.map((it, i) => reminderFromPlanItem(it, now, i));
          built.forEach((r) => reminder.schedule(r));
          pushCards(localCardsFor("tasks", locale, { reminders: built, now }));
          track("med_plan", locale, { basis: plan.basis ?? "mixed" });
          await speakLine(t(locale, "medPlanSaved"));
          return;
        }
      } catch {
        /* offline: fall through */
      }
    }

    // The agent plans the cards (API first, local fallback). If nothing can
    // plan a card and no earlier branch answered, we stay in chat mode: an
    // unrecognized sentence is conversation, never a silently-filed promise.
    let next: AgentCard[] = [];
    let mode: "agent" | "local" = "agent";
    try {
      next = await getAgentCards({ intent, utterance, locale, now });
    } catch {
      next = [];
    }
    if (!next.length) {
      mode = "local";
      next = localCardsFor(intent, locale, { reminders: reminder.items, now });
    }
    pushCards(next);
    track("card_shown", locale, { intent, mode });
    // A card that carries an answer is also read out; otherwise the senior just
    // sees something appear with no explanation.
    const headline = next[0]?.data?.headline;
    if (next.length) await speakLine(headline?.trim() ? headline.trim() : t(locale, "todoSaved"));
    else await speakLine(pickT(locale, ["intentUnknown", "intentUnknownAlt"]));
  };

  /** Everything the senior says or types lands here. */
  const handleSaid = async (said: string) => {
    void remember("user", said);
    countRepeat(said);
    go("thinking");
    const intent = parseIntent(said);
    // Weather is a question with a fixed answer path (real data + card + sheet),
    // so it must not be swallowed by the agent bridge's card-only shortcut.
    if (intent === "weather") {
      await runIntent(intent, said);
      return;
    }
    // Safety first: an emergency word skips every other branch.
    if (intent !== "sos") {
      switch (careCue(said)) {
        case "lost": // comfort + count; never guess where the thing is
          track("lost_item", locale);
          await speakLine(t(locale, "careLost"));
          return;
        case "sad": // keep them company; no judgement, no score
          track("mood_report", locale);
          void onTalk(t(locale, "careSad"));
          return;
        case "tired":
          await speakLine(t(locale, "interviewTired"));
          return;
        case "refuse": // "唔講喇" → quiet for today, including the interview
          saveProactive({ ...proRef.current, interviewAt: Date.now() });
          await speakLine(t(locale, "interviewRefused"));
          return;
      }
      if (await agent.handleUtterance(said)) {
        void refreshRecords();
        void refreshTasks();
        if (stateRef.current === "thinking") settle(); // handled with cards only
        return;
      }
    }
    await runIntent(intent, said);
  };

  /** Main button / wake word / long-press / widget: (optionally say a line, then) listen. */
  const onTalk = async (prompt?: string) => {
    interrupt();
    stopWake(); // free the mic for the interaction recognizer
    go("listening");
    await ensureAudioUnlocked();
    if (prompt) {
      if (!(await say(prompt))) return;
      go("listening");
    }
    const my = speechGen.current;

    // Amplitude meter doubles as the valid-voice gate (peak loudness). Skipped
    // when Web Speech is missing: the backend-ASR path below opens its own
    // recorder, and two live mic streams on Android fight over the input.
    let peak = 0;
    let metered = false;
    if (!usesBackendStt()) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        meterRef.current = createAmplitudeMeter(stream);
        metered = true;
        levelTimer.current = window.setInterval(() => {
          const l = meterRef.current?.getLevel() ?? 0;
          if (l > peak) peak = l;
          setLevel(l);
        }, 100);
      } catch {
        /* no mic meter: listenOnce below reports whether voice works at all */
      }
    }

    const heard = await listenOnce(locale, ANSWER_TIMEOUT_MS);
    clearMeter();
    setLevel(0);
    if (speechGen.current !== my) return; // someone interrupted us (SOS, tap…)
    if (heard === null) {
      failOpen();
      return;
    }
    const said = heard.text;
    // ignore noise/silence — real speech is long enough AND loud enough
    if (said.length < 2 || (metered && peak < VOICE_PEAK_MIN)) {
      sttFails.current++;
      bumpCare("unheard");
      if (sttFails.current >= STT_FAILS_BEFORE_BUTTONS) failOpen();
      else void speakLine(pickT(locale, ["noSpeech", "noSpeechAlt"]));
      return;
    }
    sttFails.current = 0;
    noteInteraction("voice");
    await handleSaid(said);
  };

  /** Speak a line, then listen — only from idle, never over an overlay. */
  const converse = (line: string) => {
    if (stateRef.current !== "idle" || blockedRef.current) return;
    void onTalk(line);
  };

  // --- the daily interview (docs/dev.md §2.4 A1) -----------------------------
  const runInterview = async () => {
    interviewing.current = true;
    interviewAbort.current = false;
    stopWake();
    const hist: InterviewHistory =
      (await get<{ id: string; items: InterviewHistory }>("meta", "interview").catch(() => undefined))?.items ?? {};
    const s: InterviewState = { startedAt: Date.now(), answers: [] };
    let reason = "done";
    /** undefined = interrupted, null = voice unavailable */
    const ask = async (line: string) => {
      if (!(await say(line)) || interviewAbort.current) return undefined;
      go("listening");
      const heard = await listenOnce(locale, ANSWER_TIMEOUT_MS);
      return interviewAbort.current ? undefined : heard;
    };
    try {
      if (!(await say(t(locale, "interviewIntro")))) {
        reason = "abort";
        return;
      }
      while (!shouldStop(s, Date.now())) {
        const item = pickNext(s, hist, Date.now());
        if (!item) break;
        const prompt = textFor(item.prompt, locale);
        let heard = await ask(prompt);
        // silent once → repeat (or hint), silent twice → skip; never pressure
        if (heard && !heard.text) {
          heard = await ask(item.followUp ? textFor(item.followUp, locale) : `${t(locale, "interviewRepeat")}${prompt}`);
        }
        if (heard === undefined) {
          reason = "abort";
          break;
        }
        if (heard === null) {
          reason = "unavailable";
          break;
        }
        const at = Date.now();
        const timedOut = !heard.text;
        s.answers.push({ id: item.id, at, durationMs: heard.durationMs, textLen: heard.text.length, confidence: heard.confidence, timedOut });
        hist[item.id] = { at, timedOut };
        track("interview_answer", locale, {
          item: item.id,
          domain: item.domain,
          durationMs: heard.durationMs,
          textLen: heard.text.length,
          confidence: Math.round(heard.confidence * 100) / 100,
          timedOut,
        });
        if (timedOut) {
          if (!(await say(t(locale, "interviewSkip")))) {
            reason = "abort";
            break;
          }
          continue;
        }
        noteInteraction("interview");
        void remember("user", heard.text);
        if (parseIntent(heard.text) === "sos") {
          reason = "sos";
          openSos("voice");
          break;
        }
        const cue = careCue(heard.text);
        if (cue && cue !== "lost") {
          s.stop = cue;
          reason = cue;
          break;
        }
        const ack = item.sayToday ? `${t(locale, "interviewAck")}${todayLine(locale, at)}` : t(locale, "interviewAck");
        if (!(await say(ack))) {
          reason = "abort";
          break;
        }
      }
    } finally {
      interviewing.current = false;
      void put("meta", { id: "interview", items: hist }).catch(() => {});
      track("interview_end", locale, { answered: s.answers.filter((a) => !a.timedOut).length, reason });
    }
    if (reason === "abort" || reason === "sos") return;
    if (reason === "sad") {
      void onTalk(t(locale, "careSad"));
      return;
    }
    if (reason === "unavailable") openTools();
    const closing: MsgKey =
      reason === "refuse" ? "interviewRefused"
      : reason === "tired" ? "interviewTired"
      : reason === "unavailable" ? "voiceUnavailable"
      : "interviewDone";
    await speakLine(t(locale, closing));
  };

  // --- proactive talk (docs/dev.md §2.4 A2): one planner for every trigger ---
  const proactive = (trigger: ProactiveTrigger) => {
    if (!proLoaded.current || stateRef.current !== "idle" || blockedRef.current || interviewing.current) return;
    const now = Date.now();
    const rec = proRef.current;
    const act = planProactive({ now, trigger, ...rec, hasDueReminder: !!reminder.due });
    if (!act || act.kind === "reminder") return; // ReminderOverlay owns due reminders
    track("proactive", locale, { kind: act.kind, trigger });
    if (act.kind === "greeting") {
      converse(t(locale, "openGreeting"));
      return;
    }
    const spoke = recordSpoke(rec, now);
    if (act.kind === "interview") {
      // Marked at the START: a refused or failed interview still counts for today.
      saveProactive({ ...spoke, interviewAt: now });
      // Medication + open chores first: the senior answers one question, and the
      // answer ("吃了") is routed through the agent so it becomes a real record.
      // `speechIdle()` keeps the interview from starting on top of the answer he
      // just heard — a reply cut in half by the next question is not "complete".
      void dailyCheckIn().then(async () => {
        await speechIdle();
        await runInterview();
      });
      return;
    }
    saveProactive(spoke);
    // Timing stays here (budget, 90-min gap, quiet hours). The wording is B's
    // care signal: it returns one line, or null when there is nothing worth
    // interrupting him about — then the plain silence copy still runs.
    const hint = act.silentDays >= WAKE_HINT_DAYS ? t(locale, "wakeHintSpoken") : "";
    const fallback = t(locale, "silenceCare");
    void careForSenior(careCounters(), locale)
      .then((line) => converse((line ?? fallback) + hint))
      .catch(() => converse(fallback + hint));
  };

  latest.current = { onTalk, proactive, openSos, say: (line) => void speakLine(line), refresh, showRecords: () => void showTodayRecords() };

  const submitText = async (e: FormEvent) => {
    e.preventDefault();
    const said = text.trim();
    if (!said) return;
    setText("");
    interrupt();
    noteInteraction("text");
    await handleSaid(said);
  };

  // boot: hydrate memory + proactive state, schedule the daily alarm, fail open if no STT
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (!sttSupported()) setShowTools(true);
    const saved = window.localStorage.getItem(DISPLAY_KEY);
    if (saved === "hc" || saved === "large") setDisplay(saved);
    // Native: keep listening for the name even when the app is not in the
    // foreground, and wake the app daily for the interview. No-ops on the web.
    const native = bridge();
    if (wakeOn) void native?.startBackgroundWake();
    void native?.scheduleDaily(INTERVIEW_HOUR, 0).then((ok) => {
      if (!ok) track("schedule_daily_failed", locale);
    });
    let alive = true;
    track("app_open", locale);

    // Session + remote sync run in the background: a slow/unreachable backend
    // must never delay the local greeting.
    void (async () => {
      await ensureSeniorSession().catch(() => {});
      void flush();
      void flushGaitUploads();
      void getHealthCard()
        .then((card) => {
          if (alive) setHealthCard(card);
        })
        .catch(() => {
          /* offline: keep the local demo card */
        });
    })();

    void (async () => {
      const rows = await all<ConversationTurn>("conversation").catch(() => []);
      const rec = await get<ProactiveRecord>("meta", "proactive").catch(() => undefined);
      const care = await get<CareDayCounts>("meta", "careDay").catch(() => undefined);
      if (!alive) return;
      historyRef.current = rows.sort((a, b) => a.at - b.at).slice(-MEMORY_TURNS);
      if (rec) proRef.current = { ...emptyProactiveRecord(), ...rec };
      proLoaded.current = true;
      // Restore today's care counters; a row from another day is discarded.
      if (care?.day === dayKey(Date.now())) {
        careRef.current = {
          id: "careDay",
          day: care.day,
          interactions: Math.max(care.interactions ?? 0, careRef.current.interactions),
          unheard: Math.max(care.unheard ?? 0, careRef.current.unheard),
          repeats: Math.max(care.repeats ?? 0, careRef.current.repeats),
          sos: Math.max(care.sos ?? 0, careRef.current.sos),
        };
      }
      // Opening the app starts a voice conversation by default.
      window.setTimeout(() => latest.current.proactive("open"), 1500);
    })();

    // Records survive a restart: today's card comes back so the senior sees the
    // dose was already logged instead of wondering whether it counted.
    void todayRecords(Date.now())
      .then((rows) => {
        if (alive && rows.length) pushCards([recordsCard(rows, locale, Date.now())]);
      })
      .catch(() => {});
    void refreshRecords();
    void refreshTasks();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => clearMeter(), [clearMeter]);

  /**
   * NOTE (2026-10-25 真机回归): the wake listener is deliberately NOT re-armed
   * while the assistant is speaking.
   *
   * It used to be, so the senior could barge in by name. On this handset the
   * wake-word recognizer (Xiaomi ASR) restarts exactly when TTS starts and takes
   * the audio path with it — speech became intermittent ("有时有有时无"). Sound
   * reliability wins: during a reply, use the big 講嘢 / 求助 buttons to take
   * over (onTalk() already cancels speech). Name-based barge-in needs a native
   * recognizer with echo cancellation (B), not a second WebView recognizer.
   */

  // Coming back to the foreground (e.g. the senior unlocks the phone) asks the
  // planner; the cooldown keeps trivial app switches from re-greeting.
  useEffect(() => {
    let last = 0;
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < OPEN_COOLDOWN_MS) return;
      last = now;
      latest.current.proactive("open");
    };
    document.addEventListener("visibilitychange", onVis);
    const tick = window.setInterval(() => {
      if (document.visibilityState === "visible") latest.current.proactive("tick");
    }, TICK_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.clearInterval(tick);
    };
  }, []);

  // Load the bundled neural voice for this language at start-up, so the very
  // first line is not spoken by the fallback engine while the model loads.
  useEffect(() => {
    void bridge()?.warmTts(locale);
  }, [locale]);

  // Native shell brought us forward (B, W3). `planForeground` is B's decision
  // table (lib/foreground.ts) — A only executes the planned kind.
  useEffect(
    () =>
      onForeground((e) => {
        // `planOpen` first: tapping the widget's record row is a request to SEE
        // today's records. Falling back to the reason ("widget" → listen) would
        // answer "did I take my pill?" by opening the microphone.
        const plan = planOpen(e.open) ?? planForeground(e.reason, locale);
        if (plan.kind === "silent") return; // boot only re-arms alarms
        if (plan.kind === "listen") void latest.current.onTalk(plan.say);
        else if (plan.kind === "speak") latest.current.say(plan.say);
        else if (plan.kind === "records") latest.current.showRecords();
        else latest.current.refresh();
      }),
    [locale]
  );
  // Lock-screen widget SOS hot zone: open the SOS screen at once, no voice step.
  // A pocket press or double tap must not page the family twice (B's 10s window).
  useEffect(() => {
    let lastAt: number | null = null;
    const h = () => {
      const now = Date.now();
      if (!shouldRaiseSos(lastAt, now)) return;
      lastAt = now;
      latest.current.openSos("button", "widget");
    };
    window.addEventListener(SOS_EVENT, h);
    return () => window.removeEventListener(SOS_EVENT, h);
  }, []);

  // Haptic confirmation for every button press (ignored where unsupported).
  useEffect(() => {
    const h = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.("button, a")) navigator.vibrate?.(30);
    };
    document.addEventListener("pointerdown", h);
    return () => document.removeEventListener("pointerdown", h);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("hc", display === "hc");
    document.documentElement.classList.toggle("lg", display === "large");
  }, [display]);

  useEffect(() => {
    if (showTools && focusToolsRef.current) {
      focusToolsRef.current = false;
      toolsRef.current?.focus();
    }
  }, [showTools]);

  // A due reminder takes the speaker: ReminderOverlay talks over us, so end any
  // interview turn quietly (no cancelSpeech — that would cut the reminder off).
  useEffect(() => {
    if (!reminder.due) return;
    speechGen.current++;
    interviewAbort.current = true;
    settle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reminder.due]);

  useEffect(() => {
    void gait.start();
  }, [gait]);
  useEffect(() => {
    if (gait.lastWindow?.fall) {
      latest.current.openSos("fall");
      track("gait_fall", locale, { reason: gait.lastWindow.fallReason ?? "impact" });
    }
  }, [gait.lastWindow, locale]);

  // keep a home-screen widget payload ready for the native shell (no-op on web)
  // `todayLog` feeds the 「今日記錄」 row (issue #8): the widget must answer
  // "did I take my pill?" without opening the app.
  const widgetRef = useMemo(
    () => homeWidgetPayload(cards, reminder.items, Date.now(), t(locale, "appName"), todayLog),
    [cards, reminder.items, locale, todayLog]
  );
  useEffect(() => {
    void bridge()?.updateHomeWidget(widgetRef);
  }, [widgetRef]);

  /**
   * "今日記錄" — what the senior already did today, read back from IndexedDB.
   * This is the durable counterpart of the floating record card: the button
   * only reveals it, the data lives in the `records` store.
   */
  const showTodayRecords = async () => {
    noteInteraction("button");
    const rows = await todayRecords(Date.now()).catch(() => []);
    pushCards([recordsCard(rows, locale, Date.now())]);
    track("records_shown", locale, { count: rows.length });
  };

  /** "今日安排" — open chores as a tickable card, no reminder schema involved. */
  const showOpenTasks = async () => {
    noteInteraction("button");
    const tasks = await listTasks().catch(() => []);
    pushCards([tasksCard(tasks, locale, Date.now())]);
  };

  /**
   * Ticking a card item is a real completion: the chore leaves the list, the
   * medication reminder is cleared, and the senior hears it happened. Without
   * this a checklist is decoration, and requirement #4 stays unmet.
   */
  const onCheckCard = async (itemId: string) => {
    const done = await completeTask(itemId, Date.now()).catch(() => null);
    if (!done) {
      // Not a task: it may be a pending reminder on the medication card.
      if (reminder.takeById(itemId)) {
        await addRecord({
          kind: "med",
          title: "食藥",
          at: Date.now(),
          source: "reminder",
        }).catch(() => undefined);
        await speakLine(t(locale, "medDailyAck"));
      }
      return;
    }
    noteInteraction("button");
    track("task_done_card", locale);
    await addRecord({
      kind: "card",
      title: done.task.text,
      at: Date.now(),
      source: "reminder",
    }).catch(() => undefined);
    await speakLine(t(locale, "taskTicked"));
    const open = (await listTasks().catch(() => [])).filter((x) => !x.done);
    setOpenCount(open.length);
    pushCards([tasksCard(open, locale, Date.now())]);
  };

  /**
   * Daily check-in before the interview: ask about medication when today has no
   * dose logged, then say how many chores are still open. The senior answers
   * once; "吃了" is routed through the normal agent turn and really logs it.
   */
  const dailyCheckIn = async () => {
    const [tasks, recs] = await Promise.all([
      listTasks().catch(() => []),
      todayRecords(Date.now()).catch(() => []),
    ]);
    const open = tasks.filter((x) => !x.done);
    const medLogged = recs.some((r) => r.kind === "med");
    if (open.length) pushCards([tasksCard(tasks, locale, Date.now())]);
    if (!open.length && medLogged) return;

    const ask = !medLogged
      ? t(locale, "medAskDaily")
      : t(locale, "tasksPending").replace("{n}", `${open.length}`);
    stopWake();
    if (!(await say(ask))) return;
    go("listening");
    const heard = await listenOnce(locale, ANSWER_TIMEOUT_MS);
    go("thinking");
    if (!heard?.text) {
      settle();
      return;
    }
    noteInteraction("voice");
    await handleSaid(heard.text);
  };

  const closeTools = () => {
    setShowTools(false);
    talkButtonRef.current?.focus();
  };

  /** Closing an answer sheet stops the reading and gives the mic back. */
  const closeSheet = () => {
    cancelSpeech();
    setSheetCard(null);
    settle();
  };

  const status =
    state === "listening"
      ? t(locale, "listening")
      : state === "thinking" || agent.busy
        ? t(locale, "thinking")
        : state === "speaking"
          ? t(locale, "speaking")
          : wakeOn && wakeActivity === "sleeping"
            ? t(locale, "sleeping")
            : t(locale, "greeting");

  const tap = "elderly-tap inline-flex items-center justify-center rounded-2xl px-5 py-3 text-2xl font-bold";
  const secondary = `${tap} bg-aura-bg text-aura-deep hc:bg-neutral-800 hc:text-white`;
  const onTop = `${tap} bg-white text-aura-deep`;
  const pressed = `${tap} bg-aura-accent text-white`;
  const quick =
    "flex min-h-[80px] items-center justify-center rounded-2xl bg-aura-accent px-3 py-4 text-center text-2xl font-extrabold text-white hc:bg-yellow-300 hc:text-black";

  // The home-screen summary line is the in-app "record card": one glance tells
  // the senior whether today's dose is logged and how many chores are open.
  const medLoggedToday = todayLog.some((r) => r.kind === "med");

  return (
    <main className="flex min-h-[100dvh] flex-col items-center gap-6 bg-aura-bg px-5 pb-10 pt-[max(1rem,env(safe-area-inset-top))]">
      {/* Focus order: avatar → talk → SOS → secondary → tools (docs/dev.md §2.7 ②). */}
      <div className="flex flex-col items-center gap-3">
        <Avatar
          state={state}
          level={level}
          size={280}
          label={`${t(locale, "appName")}，${status.replace(/[。…]+$/, "")}。${t(locale, "avatarHint")}`}
          onTap={() => {
            interrupt();
            void speakLine(lastLineRef.current || t(locale, "greeting"));
          }}
          onLongPress={() => void onTalk(t(locale, "longPressPrompt"))}
          onMode={(m) => {
            // §2.3.1 ⑤：L2 Canvas-2D 是默认态，记录只是噪声。
            if (m === "canvas") return;
            track(m === "live2d" ? "avatar_mode" : "avatar_fallback", locale, { mode: m });
          }}
        />
        <p aria-live="polite" className="text-3xl font-bold text-aura-deep hc:text-white">
          {status}
        </p>
        {/* Captions: everything the assistant says, for seniors who hear poorly. */}
        {caption ? <p className="caption">{caption}</p> : null}
      </div>

      {/* voice + SOS stay visible: they are the primary input and the safety lifeline */}
      <div className="flex w-full max-w-md flex-col gap-3">
        <div className="flex gap-4">
          <button
            ref={talkButtonRef}
            onClick={() => void onTalk()}
            className="min-h-[80px] flex-1 rounded-[2rem] bg-aura-accent px-6 py-8 text-4xl font-extrabold text-white shadow-xl focus:outline-none focus-visible:ring-8 focus-visible:ring-aura-warm hc:bg-yellow-300 hc:text-black"
          >
            {t(locale, "talkButton")}
          </button>
          <button
            onClick={() => openSos("button")}
            className="min-h-[80px] flex-1 rounded-[2rem] bg-aura-danger px-6 py-8 text-4xl font-extrabold text-white shadow-xl focus:outline-none focus-visible:ring-8 focus-visible:ring-aura-warm hc:bg-red-500"
          >
            {t(locale, "sosButton")}
          </button>
        </div>
        <p className="text-center text-2xl text-aura-deep hc:text-white">{t(locale, "wakeHint")}</p>
        <div
          aria-live="polite"
          className="flex w-full flex-wrap items-center justify-center gap-x-6 gap-y-1 rounded-2xl bg-white px-5 py-4 hc:border hc:border-white hc:bg-black"
        >
          <span className="whitespace-nowrap text-2xl font-bold text-aura-deep hc:text-white">
            {`💊 ${medLoggedToday ? t(locale, "medTodayDone") : t(locale, "medTodayNone")}`}
          </span>
          <span className="whitespace-nowrap text-2xl font-bold text-aura-deep hc:text-white">
            {`✅ ${t(locale, "tasksOpenCount").replace("{n}", `${openCount}`)}`}
          </span>
        </div>
      </div>

      <div className="flex w-full flex-wrap items-center justify-center gap-4">
        {/* Issue #1 §2.1: the tools panel (call family, health card, camera,
            screening, typing, pairing) used to be reachable ONLY by voice, so a
            senior who cannot speak had no way to open the buttons for people
            who cannot speak. One always-visible entry, same size as the rest. */}
        <button onClick={openTools} className={onTop}>
          {t(locale, "quickTitle")}
        </button>
        <button
          onClick={() => {
            const next = DISPLAY_NEXT[display];
            setDisplay(next);
            window.localStorage.setItem(DISPLAY_KEY, next);
            track("display_mode", locale, { mode: next });
          }}
          className={onTop}
        >
          {`${t(locale, "displayMode")}：${t(locale, DISPLAY_LABEL[display])}`}
        </button>
        {/* one tap flips between Cantonese and Mandarin — the label always shows
            the OTHER language, i.e. what you'd switch TO. */}
        <button
          onClick={() => setLocale((l) => (l === "zh-CN" ? "zh-HK" : "zh-CN"))}
          className={onTop}
        >
          {t(locale, "langOther")}
        </button>
      </div>

      {showTools ? (
        <section
          ref={toolsRef}
          tabIndex={-1}
          aria-label={t(locale, "quickTitle")}
          onKeyDown={(e) => {
            if (e.key === "Escape") closeTools();
          }}
          className="flex w-full max-w-md flex-col gap-4 rounded-3xl bg-white p-5 hc:bg-black"
        >
          {/* Works with no voice at all: each one does its job in one tap. */}
          <div className="grid grid-cols-3 gap-4">
            <button
              onClick={() => {
                noteInteraction("button");
                void showTodayRecords();
              }}
              className={quick}
            >
              {t(locale, "quickRecords")}
            </button>
            <button
              onClick={() => void showOpenTasks()}
              className={quick}
            >
              {t(locale, "quickToday")}
            </button>
            <a
              href={`tel:${healthCard.emergencyContact.phone.replace(/\s/g, "")}`}
              onClick={() => noteInteraction("button")}
              className={quick}
            >
              {t(locale, "quickCallFamily")}
            </a>
          </div>
          <div className="flex flex-wrap gap-4">
            <button
              onClick={() => {
                noteInteraction("button");
                void confirmHome();
              }}
              className={secondary}
            >
              {t(locale, "setHome")}
            </button>
            <button onClick={() => setCardOpen(true)} className={secondary}>
              {t(locale, "healthCardTitle")}
            </button>
            <button onClick={() => setCameraOpen(true)} className={secondary}>
              {t(locale, "cameraTitle")}
            </button>
            <button
              onClick={() => {
                interrupt();
                stopWake(); // free the mic for the one-minute recording
                go("listening"); // block converse()/visibility triggers
                setScreeningOpen(true);
              }}
              className={secondary}
            >
              {t(locale, "screeningTitle")}
            </button>
            <button onClick={openFollowup} className={secondary}>
              {t(locale, "followupTitle")}
            </button>
            <button
              onClick={() => {
                const next = !wakeOn;
                setWakeOn(next);
                // mirror the toggle to the background listener (native only)
                if (next) void bridge()?.startBackgroundWake();
                else void bridge()?.stopBackgroundWake();
              }}
              aria-pressed={wakeOn}
              className={wakeOn ? pressed : secondary}
            >
              {t(locale, "wakeOn")}
            </button>
            <button
              onClick={async () => {
                try {
                  const result = await createPairingCode();
                  setPairingCode(result.code);
                } catch {
                  setPairingCode("暂时无法生成");
                }
              }}
              className={secondary}
            >
              家属绑定
            </button>
          </div>
          {pairingCode ? (
            <p aria-live="polite" className="rounded-2xl bg-aura-warm p-4 text-center text-3xl font-black text-aura-deep">
              配对码：{pairingCode}
            </p>
          ) : null}

          <form onSubmit={submitText} className="flex gap-3">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t(locale, "typeHere")}
              aria-label={t(locale, "typeHere")}
              className="elderly-tap min-w-0 flex-1 rounded-2xl border-4 border-aura-deep bg-aura-bg px-4 py-3 text-2xl font-bold text-aura-deep hc:border-white hc:bg-neutral-800 hc:text-white"
            />
            <button
              type="submit"
              className="elderly-tap inline-flex items-center justify-center rounded-2xl bg-aura-deep px-6 py-3 text-2xl font-extrabold text-white hc:bg-yellow-300 hc:text-black"
            >
              {t(locale, "send")}
            </button>
          </form>
          <p className="text-xl text-aura-deep opacity-70 hc:text-white">{t(locale, "noteHint")}</p>
          <button onClick={closeTools} className={secondary}>
            {t(locale, "toolsClose")}
          </button>
        </section>
      ) : null}

      {/* agent-driven card stream — the app's own "desktop" */}
      <CardBoard
        cards={cards}
        onAction={(intent) => void runIntent(intent, "")}
        onCheck={(id) => void onCheckCard(id)}
      />

      {gait.running ? (
        <p className="text-2xl text-aura-deep hc:text-white">
          守护中 · 步数 {gait.lastWindow?.steps ?? 0} · 步态 {(gait.lastWindow?.cadence ?? 0).toFixed(0)}
        </p>
      ) : null}
      {nativeAvailable() ? null : (
        <p className="text-xl text-aura-deep opacity-70 hc:text-white">
          网页版：后台唤醒 / 系统桌面小组件需原生壳（见 docs/dev.md）
        </p>
      )}

      {reminder.due ? (
        <ReminderOverlay
          item={reminder.due}
          locale={locale}
          escalation={reminder.escalation}
          onTaken={() => {
            reminder.confirmTaken();
            track("med_taken", locale);
          }}
          onSnooze={reminder.snooze}
        />
      ) : null}

      <SosOverlay
        open={sosOpen}
        locale={locale}
        reason={sosReason}
        source={sosSource}
        onEscalated={() => bumpCare("sos")}
        onClose={() => {
          setSosOpen(false);
          settle(); // re-arm the wake listener and clear the "confirming" state
        }}
      />
      <CardSheet card={sheetCard} locale={locale} onClose={closeSheet} />
      <CameraOverlay
        open={cameraOpen}
        locale={locale}
        onCapture={(dataUrl) => {
          setCameraOpen(false);
          pushCards([photoCard(dataUrl, locale, Date.now())]);
          track("camera_capture", locale);
        }}
        onClose={() => setCameraOpen(false)}
      />
      <ScreeningOverlay
        open={screeningOpen}
        locale={locale}
        onClose={() => {
          setScreeningOpen(false);
          settle(); // re-arm the wake listener now that recording stopped
        }}
      />
      <FollowupSheet
        open={followupOpen}
        locale={locale}
        onSave={(item) => {
          reminder.schedule(item);
          pushCards([followupCard(item, locale, Date.now())]);
          track("followup_scheduled", locale);
        }}
        onClose={() => {
          setFollowupOpen(false);
          settle();
        }}
      />
      <HealthCardSheet open={cardOpen} card={healthCard} locale={locale} onClose={() => setCardOpen(false)} />
    </main>
  );
}
