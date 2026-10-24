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
import { flushClosedDay } from "@/lib/behaviourStore";
import { pruneCareHistory } from "@/lib/careStore";
import { startFenceWatch } from "@/lib/geofenceStore";
import { bridge } from "@/lib/native";
import { flushOutboxOnce, startOutboxAutoFlush } from "@/lib/outboxRunner";
import { enqueue } from "@/lib/outboxStore";
import { listTasks, saveTask } from "@/lib/taskStore";
import { createToolRunner } from "@/lib/toolExec";
import type { AgentCard, Locale, ReminderItem, Task } from "@/lib/types";

/** How often to re-probe a backend that is not ready yet (ms). */
const PROBE_INTERVAL_MS = 30_000;

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
  const turnsRef = useRef<RecentTurn[]>([]);
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

    return () => {
      stopQueue();
      stopFence();
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
        // One-shot alarm. Without this the executor reports "我設唔到鬧鐘" —
        // which is true on the web, and honest on a phone with the permission off.
        setAlarm: bridge()
          ? async (atMs, label) => (await bridge()?.scheduleOnce(atMs, label)) ?? false
          : undefined,
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
      });

      if (!out.handled) return false;

      // Record the pair only now: we know both halves of it.
      let next = appendTurn(history, { role: "user", text });
      if (out.reply) next = appendTurn(next, { role: "assistant", text: out.reply });
      turnsRef.current = next;

      if (out.reply && d.onSpeak) d.onSpeak(out.reply);
      if (out.cards.length > 0) d.onCards(out.cards);

      // A mutation happened: re-read so the next turn sends correct openTasks
      // and A's task list stops showing the chore that was just completed.
      if (out.executed.some((e) => e.ok && (e.name === "create_task" || e.name === "complete_task"))) {
        try {
          setTasks(await listTasks());
        } catch {
          /* stale list is survivable; a thrown hook is not */
        }
      }
      return true;
    } finally {
      setBusy(false);
    }
  }, []);

  return { handleUtterance, busy, llmReady, tasks };
}
