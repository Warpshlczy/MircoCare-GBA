"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Avatar } from "@/components/Avatar";
import { CardBoard } from "@/components/CardBoard";
import { CameraOverlay } from "@/components/CameraOverlay";
import { ReminderOverlay } from "@/components/ReminderOverlay";
import { SosOverlay } from "@/components/SosOverlay";
import { HealthCardSheet } from "@/components/HealthCardSheet";
import { ScreeningOverlay } from "@/components/ScreeningOverlay";
import { useReminder } from "@/hooks/useReminder";
import { useGaitMonitor, flushGaitUploads } from "@/hooks/useGaitMonitor";
import { useWakeWord } from "@/hooks/useWakeWord";
import {
  ensureAudioUnlocked,
  speak,
  startListening,
  createAmplitudeMeter,
  sttSupported,
} from "@/lib/audio";
import { parseIntent } from "@/lib/intent";
import { localCardsFor, photoCard, todoCardFromUtterance } from "@/lib/cards";
import { createPairingCode, ensureSeniorSession, getAgentCards, getHealthCard, getMedicationPlan, postConversationMemory } from "@/lib/api";
import { all, get, put } from "@/lib/db";
import { shouldCheckIn } from "@/lib/checkin";
import { flush, track } from "@/lib/analytics";
import { bridge, homeWidgetPayload, nativeAvailable } from "@/lib/native";
import { t } from "@/lib/i18n";
import type {
  AgentCard,
  AssistantState,
  ConversationTurn,
  HealthCard,
  Intent,
  Locale,
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

const demoReminder = (): ReminderItem => ({
  id: "demo-med",
  kind: "med",
  med: { id: "m1", name: "降压药 氨氯地平 5mg", dosage: "1 粒" },
  title: "食药提醒",
  dueAt: Date.now(),
  status: "pending",
  stage: "none",
  createdAt: Date.now(),
});

/** One reminder per item in a backend-derived medication plan. */
function reminderFromPlanItem(
  it: { name: string; dosage: string; schedule: string },
  now: number,
  i: number
): ReminderItem {
  // ponytail: the plan's `schedule` string (e.g. "早上") is not parsed into a real
  // due time — the reminder fires on creation. Upgrade path: the backend returns an
  // explicit dueAt (or the agent parses the slot) so reminders land at the right hour.
  const title = it.schedule ? `${it.name}（${it.schedule}）` : it.name;
  return {
    id: `plan-${now}-${i}`,
    kind: "med",
    med: { id: `m-${now}-${i}`, name: title, dosage: it.dosage },
    title,
    dueAt: now,
    status: "pending",
    stage: "none",
    createdAt: now,
  };
}

const MAX_CARDS = 6;
const MEMORY_TURNS = 20;
const CHECKIN_KEY = "checkin";
/** Speech must be at least this loud (0..1 meter) to count as a real utterance. */
const VOICE_PEAK_MIN = 0.08;

export default function Page() {
  const [locale, setLocale] = useState<Locale>("zh-HK");
  const [state, setState] = useState<AssistantState>("idle");
  const [level, setLevel] = useState(0);
  const [sosOpen, setSosOpen] = useState(false);
  const [sosReason, setSosReason] = useState<SosEvent["reason"]>("button");
  const [cardOpen, setCardOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [hc, setHc] = useState(false);
  const [healthCard, setHealthCard] = useState<HealthCard>(DEMO_CARD);
  const [screeningOpen, setScreeningOpen] = useState(false);
  // Wake word is ON by default (req 2). The extra options stay hidden behind voice.
  const [wakeOn, setWakeOn] = useState(true);
  // Req 1: only 吃药提醒 + 高对比 are visible by default. Everything else is
  // revealed by voice ("打开按钮" → `tools`) or automatically when voice can't work.
  const [showTools, setShowTools] = useState(false);
  const [text, setText] = useState("");
  const [cards, setCards] = useState<AgentCard[]>([]);
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  const reminder = useReminder();
  const gait = useGaitMonitor();
  const meterRef = useRef<{ getLevel: () => number; stop: () => void } | null>(null);
  const levelTimer = useRef<number | null>(null);
  const historyRef = useRef<ConversationTurn[]>([]);
  const startedRef = useRef(false);

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

  // --- conversation memory (local first; the POST never loses it) ---
  const remember = useCallback(
    async (role: ConversationTurn["role"], content: string) => {
      const turn: ConversationTurn = {
        id: `t-${Date.now()}-${role}`,
        at: Date.now(),
        role,
        text: content,
        locale,
      };
      historyRef.current = [...historyRef.current, turn].slice(-MEMORY_TURNS);
      void put("conversation", turn);
      try {
        await postConversationMemory(turn);
      } catch {
        /* stubbed backend — the turn is already safe in IndexedDB */
      }
    },
    [locale]
  );

  // --- wake word (foreground only; see lib/native.ts for the background seam) ---
  const onTalkRef = useRef<() => void>(() => {});
  // converseRef lets the wake callback (and boot / visibility-change) speak a
  // greeting and start listening without depending on re-created closures.
  const converseRef = useRef<(line: string) => void>(() => {});
  const stateRef = useRef<AssistantState>(state);
  stateRef.current = state;
  // Req 2: the assistant only answers once the senior says its name — then it
  // greets and asks about their day before listening.
  const wake = useWakeWord(locale, wakeOn, () => converseRef.current(t(locale, "wakeGreeting")));
  const { activity: wakeActivity, sleep: wakeSleep, stopListening: stopWake } = wake;

  const speakWithMouth = useCallback(
    async (content: string) => {
      setState("speaking");
      const start = performance.now();
      // ponytail: TTS exposes no amplitude source, so the mouth is driven by a
      // synthetic oscillator. Upgrade path: route TTS through an analyser or a
      // Live2D viseme timeline for real lip-sync.
      const id = window.setInterval(() => {
        const p = (performance.now() - start) / 1000;
        setLevel(((Math.sin(p * 9) + 1) / 2) * 0.85);
      }, 60);
      await speak(content, locale);
      window.clearInterval(id);
      setLevel(0);
      setState("idle");
      wakeSleep(); // re-arm the wake listener now that we're quiet
    },
    [locale, wakeSleep]
  );

  // --- one spoken turn: any (recognized, valid) utterance is routed to the agent ---
  const runIntent = useCallback(
    async (intent: Intent, utterance: string) => {
      const now = Date.now();
      track("intent", locale, { intent });

      if (intent === "camera") {
        setCameraOpen(true);
        setState("idle");
        wakeSleep();
        return;
      }
      if (intent === "sos") {
        setSosReason("voice");
        setSosOpen(true);
        setState("idle");
        wakeSleep();
        return;
      }
      if (intent === "tools") {
        setShowTools(true);
        await speakWithMouth(t(locale, "toolsOpened"));
        return;
      }

      // Req 3: medication can be derived from past conversations + profile + what
      // the senior just said. The backend agent does the deriving; offline we fall
      // through to the local card path below.
      if (intent === "medication") {
        try {
          const plan = await getMedicationPlan({ locale, utterance, history: historyRef.current, now });
          if (plan.items?.length) {
            const built = plan.items.map((it, i) => reminderFromPlanItem(it, now, i));
            built.forEach((r) => reminder.schedule(r));
            pushCards(localCardsFor("tasks", locale, { reminders: built, now }));
            track("med_plan", locale, { basis: plan.basis ?? "mixed" });
            await speakWithMouth(t(locale, "medTaken"));
            return;
          }
        } catch {
          /* offline: fall through */
        }
      }

      // Req 6: the agent plans the cards (API first, local fallback). An
      // unrecognized but real utterance becomes a todo — "say anything → a todo".
      let next: AgentCard[] = [];
      let mode: "agent" | "local" = "agent";
      try {
        next = await getAgentCards({ intent, utterance, locale, now });
      } catch {
        mode = "local";
        next = localCardsFor(intent, locale, { reminders: reminder.items, now });
        if (!next.length && utterance.trim()) next = [todoCardFromUtterance(utterance, locale, now)];
      }
      pushCards(next);
      track("card_shown", locale, { intent, mode });

      if (next.length) {
        setState("idle");
        wakeSleep();
      } else {
        await speakWithMouth(t(locale, "intentUnknown"));
      }
    },
    [locale, reminder.items, reminder.schedule, pushCards, speakWithMouth, wakeSleep]
  );

  const onTalk = useCallback(async () => {
    stopWake(); // free the mic for the interaction recognizer
    await ensureAudioUnlocked();
    setState("listening");

    // amplitude meter doubles as the valid-voice gate (peak loudness)
    let peak = 0;
    let metered = false;
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
      /* no mic: we can still transcribe, just without lip-sync / the energy gate */
    }

    let done = false;
    const finish = (raw: string) => {
      if (done) return;
      done = true;
      clearMeter();
      setLevel(0);
      const said = raw.trim();
      // Req 2: ignore noise/silence — real speech is long enough AND loud enough.
      if (said.length < 2 || (metered && peak < VOICE_PEAK_MIN)) {
        setState("idle");
        void speakWithMouth(t(locale, "noSpeech"));
        return;
      }
      setState("thinking");
      const intent = parseIntent(said);
      void remember("user", said);
      window.setTimeout(() => void runIntent(intent, said), 300);
    };

    const handle = startListening(
      locale,
      (text, isFinal) => {
        if (isFinal) finish(text);
      },
      () => finish("")
    );
    if (!handle) {
      // Req 1 fallback: STT unsupported / refused → fail OPEN to the buttons so
      // the senior is never locked out of the app.
      done = true;
      clearMeter();
      setLevel(0);
      setState("idle");
      setShowTools(true);
      void speakWithMouth(t(locale, "voiceUnavailable"));
    }
  }, [locale, clearMeter, speakWithMouth, runIntent, remember, stopWake]);
  onTalkRef.current = () => void onTalk();

  // Req 2 + 3 + 4: one "converse" primitive — speak a line, then start listening.
  // Used by the wake callback (ask how they are after the name is heard), by the
  // daily check-in, and by app-open / return-to-foreground. The idle guard keeps
  // two triggers from talking over each other.
  const converse = useCallback(
    async (line: string) => {
      if (stateRef.current !== "idle") return;
      await ensureAudioUnlocked();
      await speakWithMouth(line);
      onTalkRef.current();
    },
    [speakWithMouth]
  );
  converseRef.current = (line) => void converse(line);

  const submitText = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const said = text.trim();
      if (!said) return;
      setText("");
      setState("thinking");
      void remember("user", said);
      await runIntent(parseIntent(said), said);
    },
    [text, remember, runIntent]
  );

  // boot: hydrate conversation memory, run the daily check-in once, fail open if no STT
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (!sttSupported()) setShowTools(true);
    // Req 2 (native): keep listening for the name even when the app is not in the
    // foreground. No-op on the web (bridge() is undefined there).
    if (wakeOn) void bridge()?.startBackgroundWake();
    let alive = true;
    void (async () => {
      // Authenticate before any data call. This is the ONLY place that creates a
      // senior session — the caregiver page must never be re-registered as one.
      await ensureSeniorSession().catch(() => {});
      track("app_open", locale);
      await flush();
      // Data wiring: replay offline gait windows and hydrate the real health card.
      void flushGaitUploads();
      void getHealthCard()
        .then((card) => {
          if (alive) setHealthCard(card);
        })
        .catch(() => {
          /* offline: keep the local demo card */
        });
      const rows = await all<ConversationTurn>("conversation").catch(() => []);
      if (alive) historyRef.current = rows.sort((a, b) => a.at - b.at).slice(-MEMORY_TURNS);
      const rec = await get<{ id: string; lastAt: number | null }>("meta", CHECKIN_KEY).catch(() => undefined);
      if (!alive) return;
      const firstToday = shouldCheckIn(rec?.lastAt ?? null, Date.now());
      if (firstToday) {
        void put("meta", { id: CHECKIN_KEY, lastAt: Date.now() });
        track("daily_checkin", locale);
      }
      // Req 3: opening the app starts a voice conversation by default — the first
      // open of the day asks the daily check-in question, later opens just greet.
      window.setTimeout(
        () => converseRef.current(t(locale, firstToday ? "dailyCheckIn" : "openGreeting")),
        1500
      );
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => clearMeter(), [clearMeter]);
  // Req 3: coming back to the foreground resumes the voice conversation (e.g. the
  // senior unlocks the phone). A 20s cooldown keeps it from chattering on every
  // trivial tab switch.
  useEffect(() => {
    let last = 0;
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < 20000) return;
      last = now;
      converseRef.current(t(locale, "openGreeting"));
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [locale]);
  useEffect(() => {
    void gait.start();
  }, [gait]);
  useEffect(() => {
    document.body.classList.toggle("hc", hc);
  }, [hc]);
  useEffect(() => {
    if (gait.lastWindow?.fall) {
      setSosReason("fall");
      setSosOpen(true);
      track("gait_fall", locale, { reason: gait.lastWindow.fallReason ?? "impact" });
    }
  }, [gait.lastWindow, locale]);

  // keep a home-screen widget payload ready for the native shell (no-op on web)
  const widgetRef = useMemo(() => homeWidgetPayload(cards, reminder.items), [cards, reminder.items]);
  useEffect(() => {
    void bridge()?.updateHomeWidget(widgetRef);
  }, [widgetRef]);

  const scheduleDemoReminder = useCallback(() => {
    const item = demoReminder();
    reminder.schedule(item);
    // Build the card from the MERGED list: reminder.items is React state and has
    // not updated yet, so a card built from it would miss the item added now.
    const merged = [...reminder.items.filter((r) => r.id !== item.id), item];
    pushCards(localCardsFor("tasks", locale, { reminders: merged, now: Date.now() }));
  }, [reminder, locale, pushCards]);

  const sleepingHint = wakeOn && wakeActivity === "sleeping";

  return (
    <main className="flex min-h-[100dvh] flex-col items-center gap-6 bg-aura-bg px-5 pb-10 pt-[max(1rem,env(safe-area-inset-top))]">
      {/* Req 1: the ONLY two always-on options are the medication reminder + high
          contrast. Everything else is voice-first (see the tools panel below). */}
      <div className="flex w-full flex-wrap items-center justify-center gap-2">
        <button
          onClick={scheduleDemoReminder}
          className="elderly-tap inline-flex items-center justify-center rounded-2xl bg-white px-5 py-3 text-2xl font-bold text-aura-deep"
        >
          {t(locale, "reminderTitle")}
        </button>
        <button
          onClick={() => setHc((v) => !v)}
          aria-pressed={hc}
          className={`elderly-tap inline-flex items-center justify-center rounded-2xl px-5 py-3 text-2xl font-bold ${
            hc ? "bg-aura-accent text-white" : "bg-white text-aura-deep"
          }`}
        >
          {t(locale, "highContrast")}
        </button>
        {/* Req 1: one tap flips between Cantonese and Mandarin — the label always
            shows the OTHER language, i.e. what you'd switch TO. */}
        <button
          onClick={() => setLocale((l) => (l === "zh-CN" ? "zh-HK" : "zh-CN"))}
          aria-label={t(locale, "langOther")}
          className="elderly-tap inline-flex items-center justify-center rounded-2xl bg-white px-5 py-3 text-2xl font-bold text-aura-deep"
        >
          {t(locale, "langOther")}
        </button>
      </div>

      {/* the avatar dominates the top of the screen */}
      <div className="flex flex-col items-center gap-4">
        <Avatar state={state} level={level} size={280} />
        <p aria-live="polite" className="text-3xl font-bold text-aura-deep hc:text-white">
          {state === "listening"
            ? t(locale, "listening")
            : state === "thinking"
              ? t(locale, "thinking")
              : state === "speaking"
                ? t(locale, "speaking")
                : sleepingHint
                  ? t(locale, "sleeping")
                  : t(locale, "greeting")}
        </p>
      </div>

      {/* voice + SOS stay visible: they are the primary input and the safety lifeline */}
      <div className="flex w-full max-w-md gap-4">
        <button
          onClick={() => void onTalk()}
          className="flex-1 rounded-[2rem] bg-aura-accent px-6 py-8 text-4xl font-extrabold text-white shadow-xl focus:outline-none focus-visible:ring-8 focus-visible:ring-aura-warm hc:bg-yellow-300 hc:text-black"
        >
          {t(locale, "talkButton")}
        </button>
        <button
          onClick={() => {
            setSosReason("button");
            setSosOpen(true);
            track("sos_trigger", locale, { reason: "button" });
          }}
          className="flex-1 rounded-[2rem] bg-aura-danger px-6 py-8 text-4xl font-extrabold text-white shadow-xl focus:outline-none focus-visible:ring-8 focus-visible:ring-aura-warm hc:bg-red-500"
        >
          {t(locale, "sosButton")}
        </button>
      </div>

      {/* Req 1 + 3 + 6: revealed by voice ("打开按钮"), or automatically when voice
          is unavailable. Locale, health card, camera, wake toggle, and a text
          channel for when speaking isn't possible. */}
      {showTools ? (
        <section
          aria-label="更多选项"
          className="flex w-full max-w-md flex-col gap-4 rounded-3xl bg-white p-5 hc:bg-black"
        >
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setCardOpen(true)}
              className="elderly-tap inline-flex items-center justify-center rounded-2xl bg-aura-bg px-5 py-3 text-2xl font-bold text-aura-deep hc:bg-neutral-800 hc:text-white"
            >
              {t(locale, "healthCardTitle")}
            </button>
            <button
              onClick={() => setCameraOpen(true)}
              className="elderly-tap inline-flex items-center justify-center rounded-2xl bg-aura-bg px-5 py-3 text-2xl font-bold text-aura-deep hc:bg-neutral-800 hc:text-white"
            >
              {t(locale, "cameraTitle")}
            </button>
            <button
              onClick={() => {
                stopWake(); // free the mic for the one-minute recording
                setState("listening"); // block converse()/visibility triggers
                setScreeningOpen(true);
              }}
              className="elderly-tap inline-flex items-center justify-center rounded-2xl bg-aura-bg px-5 py-3 text-2xl font-bold text-aura-deep hc:bg-neutral-800 hc:text-white"
            >
              {t(locale, "screeningTitle")}
            </button>
            <button
              onClick={() => {
                const next = !wakeOn;
                setWakeOn(next);
                // Req 2 (native): mirror the toggle to the background listener.
                if (next) void bridge()?.startBackgroundWake();
                else void bridge()?.stopBackgroundWake();
              }}
              aria-pressed={wakeOn}
              className={`elderly-tap inline-flex items-center justify-center rounded-2xl px-5 py-3 text-2xl font-bold ${
                wakeOn ? "bg-aura-accent text-white" : "bg-aura-bg text-aura-deep hc:bg-neutral-800 hc:text-white"
              }`}
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
              className="elderly-tap inline-flex items-center justify-center rounded-2xl bg-aura-bg px-5 py-3 text-2xl font-bold text-aura-deep hc:bg-neutral-800 hc:text-white"
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
        </section>
      ) : null}

      {/* agent-driven card stream — the app's own "desktop" */}
      <CardBoard cards={cards} onAction={(intent) => void runIntent(intent, "")} />

      {gait.running ? (
        <p className="text-2xl text-aura-deep hc:text-white">
          守护中 · 步数 {gait.lastWindow?.steps ?? 0} · 步态 {(gait.lastWindow?.cadence ?? 0).toFixed(0)}
        </p>
      ) : null}
      {nativeAvailable() ? null : (
        <p className="text-xl text-aura-deep opacity-70 hc:text-white">
          网页版：后台唤醒 / 系统桌面小组件需原生壳（见 DEV.md）
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

      <SosOverlay open={sosOpen} locale={locale} reason={sosReason} onClose={() => setSosOpen(false)} />
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
          setState("idle");
          wakeSleep(); // re-arm the wake listener now that recording stopped
        }}
      />
      <HealthCardSheet open={cardOpen} card={healthCard} locale={locale} onClose={() => setCardOpen(false)} />
    </main>
  );
}