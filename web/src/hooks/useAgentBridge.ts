"use client";

// useAgentBridge.ts — B's ONLY seam into A's page.tsx (docs/dev.md §0.2).
//
// A owns page.tsx and never imports lib/agent.ts directly. A calls
// `handleUtterance(text)` in place of its old `runIntent(...)`:
//
//     if (!(await agent.handleUtterance(text))) void runIntent(parseIntent(text), text);
//
// Returning `false` means "not mine, keep your existing path".
//
// Two switches decide what this bridge can do, and both fail CLOSED:
//
//   llmReady  — GET /health says `llmIntegration: "enabled"`. Without it we do
//               NOT send the turn to /agent/turn: `config.llm_available` does not
//               check the API key, so a backend started with AURA_LLM_ENABLED=true
//               and no key still answers 200 with a fixed "我帮你记住了" echo.
//               Routing there would be worse than not trying at all.
//   canRun    — the local executor can actually perform the tool. Unrunnable
//               tools are skipped BEFORE any confirmation question, so the senior
//               is never asked "shall I call 阿明?" and then told it cannot.
//
// History is accumulated here (A's suggestion): the utterance we received plus
// the line we spoke are exactly one question-answer pair. An UNHANDLED turn is
// NOT recorded — we never saw A's answer, and a user turn with no reply would
// teach the model that the senior sometimes speaks and gets ignored.

import { useCallback, useEffect, useRef, useState } from "react";
import { appendTurn, isLlmReady, runTurn } from "@/lib/agent";
import type { RecentTurn } from "@/lib/agent";
import { getHealth, postAgentTurn } from "@/lib/api";
import { recordAudit } from "@/lib/auditStore";
import { flushClosedDay } from "@/lib/behaviourStore";
import { pruneCareHistory, markCareDayOpened, MEASURED_DWELL_MS } from "@/lib/careStore";
import { emergencyContacts } from "@/lib/contactStore";
import { distanceFromHomeM, startFenceWatch } from "@/lib/geofenceStore";
import { bridge, armedAlarmsFromRecords, reconcileAlarms } from "@/lib/native";
import { flushOutboxOnce, startOutboxAutoFlush } from "@/lib/outboxRunner";
import { enqueue } from "@/lib/outboxStore";
import { listRecords, saveRecord } from "@/lib/recordStore";
import { listTasks, saveTask } from "@/lib/taskStore";
import { createToolRunner } from "@/lib/toolExec";
import type { AgentCard, Locale, RecordEntry, ReminderItem, Task } from "@/lib/types";

/** How often to re-probe a backend that is not ready yet (ms). */
const PROBE_INTERVAL_MS = 30_000;

/**
 * Tools whose success changes the local task list. The bridge re-reads the
 * store only for these — a `locate` must not trigger a disk read on every turn.
 */
const MUTATING_TOOLS = new Set(["create_task", "complete_task", "defer_task", "plan_route"]);

/** Tools that append a durable record; the bridge re-reads the store for these. */
const RECORD_TOOLS = new Set(["log_medication", "compose_card", "set_alarm"]);

export interface AgentBridgeDeps {
  locale: Locale;
  reminders: ReminderItem[];
  /** A's card board entry point. */
  onCards: (cards: AgentCard[]) => void;
  /** A's speakLine(); used for refusal lines and tool outcomes. */
  onSpeak?: (text: string) => void;
  /** A's spoken yes/no; resolves false when the senior declines or stays silent. */
  onConfirm?: (question: string) => Promise<boolean>;
  /** A's SOS overlay. Called the instant an emergency tool runs, before any IO. */
  onSos?: () => void;
  /** The senior just confirmed medication: clear the reminder, refresh A's summary. */
  onMedTaken?: (name: string) => void;
}

export interface AgentBridge {
  /** `true` = handled here; `false` = A should run its own intent path. */
  handleUtterance: (text: string) => Promise<boolean>;
  /** True while a turn is in flight (drives A's "thinking" state). */
  busy: boolean;
  /** True once /health confirms a real planner. False = local path only. */
  llmReady: boolean;
  /** Local task list, kept in sync with the `tasks` store. */
  tasks: Task[];
}

export function useAgentBridge(deps: AgentBridgeDeps): AgentBridge {
  const [busy, setBusy] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [llmReady, setLlmReady] = useState(false);

  const ref = useRef(deps);
  ref.current = deps;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  /** today's records, mirrored so a turn can refuse a double dose log */
  const recordsRef = useRef<RecordEntry[]>([]);
  const turnsRef = useRef<RecentTurn[]>([]);
  /**
   * 连续几轮我们其实没听懂。第二轮之后不再要求他重说，改为给出口
   * （`agent.ts#CONFUSED_ESCALATE_AFTER`）。任何一轮听懂了就归零。
   */
  const confusedRef = useRef(0);
  /** mirrored into a ref so handleUtterance's empty dep list stays correct */
  const llmRef = useRef(false);
  llmRef.current = llmReady;

  // Load once on mount. A missing DB (private mode) just leaves the list empty —
  // it must never block the senior from talking.
  useEffect(() => {
    let alive = true;
    void listTasks()
      .then((rows) => {
        if (alive) setTasks(rows);
      })
      .catch(() => {});
    void listRecords()
      .then((rows) => {
        if (alive) recordsRef.current = rows;
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Probe the backend until it reports a real planner, then stop asking.
  // Failures stay silent: an unreachable backend simply means the local path.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const probe = async () => {
      try {
        const health = await getHealth();
        if (!alive) return;
        const ok = isLlmReady(health);
        setLlmReady(ok);
        if (ok && timer) {
          clearInterval(timer);
          timer = null;
        }
      } catch {
        if (alive) setLlmReady(false);
      }
    };

    void probe();
    timer = setInterval(probe, PROBE_INTERVAL_MS);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, []);

  // Start the offline queue flush and the daily behaviour rollup.
  //
  // This hook is the only mount point B owns, so the queue is started here
  // rather than in page.tsx (A's file). Everything below fails closed and
  // silently: a missing backend must never stop the senior from talking.
  useEffect(() => {
    const stopQueue = startOutboxAutoFlush();
    // Foreground fence sampling (A's call, issue #1). It samples nothing until
    // a home point exists, and it never asks for location permission itself —
    // see geofenceStore.ts for why that is a product decision, not a bug.
    const stopFence = startFenceWatch();
    // Screen/unlock/charging rollup: a native receiver, because SCREEN_ON is a
    // protected broadcast and the WebView is asleep exactly when we need it.
    void bridge()?.startCircadian().catch(() => {});

    // A day the app was OPEN but quiet is still a measured day.
    //
    // Without this, `care_day.<day>` only exists for days the senior talked or
    // tapped, so the 14-day median is built from talkative days only — raising
    // the reference until an ordinary quiet day looks like withdrawal. A said
    // in issue #1 that this makes the 5-day baseline arrive late; measuring it
    // here means A does not have to add anything to page.tsx.
    //
    // The dwell gate (60s of visible time) is what keeps a pocket mistap from
    // writing a 0 into his baseline. Idempotent per day: safe to call every tick.
    let visibleMs = 0;
    let visibleSince = typeof document !== "undefined" && document.visibilityState === "visible" ? Date.now() : 0;
    const tickDwell = () => {
      const now = Date.now();
      if (visibleSince) visibleMs += now - visibleSince;
      visibleSince = typeof document !== "undefined" && document.visibilityState === "visible" ? now : 0;
      if (visibleMs >= MEASURED_DWELL_MS) void markCareDayOpened(now);
    };
    const dwellTimer = typeof window === "undefined" ? null : window.setInterval(tickDwell, 30_000);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", tickDwell);

    // One closed day at most per open. Runs after the first flush attempt so an
    // item left over from last night goes out before we enqueue a new one.
    void (async () => {
      try {
        const r = await flushClosedDay();
        if (r.uploaded) void flushOutboxOnce();
      } catch {
        /* offline / no DB — the next open tries again */
      }
      // Care counters older than the median window cannot affect a result.
      void pruneCareHistory().catch(() => {});
    })();

    // Alarms: does the OS still hold what `records` believes — for EVERY alarm?
    //
    // The record is written first and the OS call second, so a process death in
    // between leaves a record with no armed alarm — "聽日八點叫我食藥" would
    // never ring, and nothing on screen would say so. `reconcileAlarms` re-arms
    // in that direction only; it never cancels a FUTURE alarm that has no
    // record, because a pruned row is not evidence that he changed his mind.
    void (async () => {
      const b = bridge();
      if (!b) return;
      try {
        const now = Date.now();
        const [armed, rows] = await Promise.all([
          b.getScheduledAlarms(),
          listRecords().catch(() => [] as RecordEntry[]),
        ]);
        const plan = reconcileAlarms(armedAlarmsFromRecords(rows, now), armed.once, now);
        // Re-arming an already-armed slot is idempotent (same request code), so
        // a redundant arm is harmless; a missed one is a missed dose.
        for (const rec of plan.arm) {
          await b.scheduleOnce(rec.dueAt, rec.label, rec.slot);
        }
        for (const slot of plan.cancel) {
          await b.cancelOnce(slot);
        }
      } catch {
        /* a broken bridge must never block the senior from talking */
      }
    })();

    return () => {
      stopQueue();
      stopFence();
      if (dwellTimer !== null) window.clearInterval(dwellTimer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", tickDwell);
      tickDwell(); // bank the last visible stretch before unmount
    };
  }, []);

  const handleUtterance = useCallback(async (text: string): Promise<boolean> => {
    const d = ref.current;
    const now = Date.now();
    const history = turnsRef.current;
    setBusy(true);
    try {
      // A fresh runner per turn: it reads the task snapshot, and its effects go
      // straight to the local stores. Nothing here touches the network.
      const runner = createToolRunner({
        locale: d.locale,
        now,
        tasks: tasksRef.current,
        saveTask: async (t) => {
          await saveTask(t);
        },
        // Task transitions ride the outbox: durable offline, and /task/events is
        // idempotent per event id, so a replay cannot double-count.
        recordEvent: async (e) => {
          await enqueue("taskEvent", e, now);
          // Kick, don't wait: the turn must finish speaking before the phone
          // finishes talking to the backend.
          void flushOutboxOnce(now);
        },
        // Same id on every replay -> the family is paged once, not once per retry.
        sendSos: async (e) => {
          await enqueue("sos", e, now);
          void flushOutboxOnce(now);
        },
        raiseSos: () => d.onSos?.(),
        locate: bridge()
          ? async () => {
              const pos = await bridge()?.getLocation();
              return pos ?? null;
            }
          : undefined,
        // One-shot alarm, addressed by SLOT so several can coexist. Without the
        // slot the shell's single fixed request code made the second "叫我九點"
        // silently replace the first while `records` still listed both — a
        // screen that showed two alarms while only one was armed.
        setAlarm: bridge()
          ? async (atMs, label, slot) => (await bridge()?.scheduleOnce(atMs, label, slot)) ?? false
          : undefined,
        // The number always comes from the health card (cached for offline);
        // the model's name is only a lookup key.
        contacts: emergencyContacts,
        dial: bridge()
          ? async (phone) => (await bridge()?.dial(phone)) ?? false
          : undefined,
        homeDistanceM: bridge() ? distanceFromHomeM : undefined,
        openApp: bridge()
          ? async (key) => (await bridge()?.openApp(key)) ?? false
          : undefined,
        // Durable records stay on this device. The snapshot lets a repeated
        // "我食咗藥" answer "already recorded" instead of logging twice.
        records: recordsRef.current,
        saveRecord: async (entry) => {
          await saveRecord(entry);
          recordsRef.current = [...recordsRef.current.filter((r) => r.id !== entry.id), entry];
        },
        onMedTaken: d.onMedTaken,
        // Every executed step leaves one row in `agent_audit` and one item in the
        // outbox. Fire-and-forget: auditStore swallows its own failures, and a
        // report about the product must never be able to break the product.
        recordAudit: (e) => {
          void recordAudit({ ...e, locale: d.locale });
        },
      });

      const out = await runTurn(text, {
        locale: d.locale,
        now,
        reminders: d.reminders,
        tasks: tasksRef.current,
        recentTurns: history,
        // Gated: without a confirmed planner the turn never leaves the device.
        requestTurn: llmRef.current ? postAgentTurn : undefined,
        canRun: runner.canRun,
        runTool: runner.run,
        confirm: d.onConfirm,
        confusedStreak: confusedRef.current,
        // Calls that never reach the executor (a safety refusal, a hallucinated
        // tool, a senior who said 唔使) are audited from the orchestrator side.
        onAudit: (e) => {
          void recordAudit({ ...e, locale: d.locale });
        },
      });

      if (!out.handled) return false;

      // A turn the app could not follow counts towards the escape hatch. It is
      // reset by any understood turn, so the counter is "how long has he been
      // stuck", not "how many times in his life".
      confusedRef.current = out.understood ? 0 : confusedRef.current + 1;

      // Record the pair only now: we know both halves of it.
      let next = appendTurn(history, { role: "user", text });
      if (out.reply) next = appendTurn(next, { role: "assistant", text: out.reply });
      turnsRef.current = next;

      if (out.reply && d.onSpeak) d.onSpeak(out.reply);
      // A card with no spoken line just pops up unexplained (issue #3/#5). The
      // local task/med cards carry only a checklist, so read their title (or
      // the "nothing today" headline) instead of leaving the senior silent.
      else if (out.cards.length > 0 && d.onSpeak) {
        const first = out.cards[0];
        const line = first.data?.headline?.trim() || first.title;
        if (line) d.onSpeak(line);
      }
      if (out.cards.length > 0) d.onCards(out.cards);

      // A mutation happened: re-read so the next turn sends correct openTasks
      // and A's task list stops showing the chore that was just completed.
      //
      // `defer_task` belongs in this list: it rewrites `dueAt` + `deferredAt`.
      // Leaving it out kept the old due time in `tasks` state, so the very next
      // turn told the planner the wrong deadline and A's board showed a time
      // that had already been pushed back — the senior hears "10 分鐘後提你"
      // while the screen still says 14:00.
      if (out.executed.some((e) => e.ok && MUTATING_TOOLS.has(e.name))) {
        try {
          setTasks(await listTasks());
        } catch {
          /* stale list is survivable; a thrown hook is not */
        }
      }
      if (out.executed.some((e) => e.ok && RECORD_TOOLS.has(e.name))) {
        try {
          recordsRef.current = await listRecords();
        } catch {
          /* the in-memory append above is already correct */
        }
      }
      return true;
    } finally {
      setBusy(false);
    }
  }, []);

  return { handleUtterance, busy, llmReady, tasks };
}
