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
// What is wired here: refusal rules, the local card fallback page.tsx already
// does, and the LOCAL tool executor (task create/complete, location, SOS).
//
// What is deliberately NOT wired: `requestTurn`. C's /agent/turn is live but its
// planner is still a fixed `create_task` echo, so routing "幫我打電話畀阿明"
// there would answer "好，我幫你記住了" and file a chore — visibly wrong in front
// of a judge. Until C3 replaces `_plan`, a non-local utterance returns false and
// A's original path runs unchanged. No fabricated answers.

import { useCallback, useEffect, useRef, useState } from "react";
import { runTurn } from "@/lib/agent";
import { bridge } from "@/lib/native";
import { enqueue } from "@/lib/outboxStore";
import { listTasks, saveTask } from "@/lib/taskStore";
import { createToolRunner } from "@/lib/toolExec";
import type { AgentCard, Locale, ReminderItem, Task } from "@/lib/types";

export interface AgentBridgeDeps {
  locale: Locale;
  reminders: ReminderItem[];
  /** A's card board entry point. */
  onCards: (cards: AgentCard[]) => void;
  /** A's speak(); used for refusal lines and tool outcomes. */
  onSpeak?: (text: string) => void;
  /** A's spoken yes/no; resolves false when the senior declines or stays silent. */
  onConfirm?: (question: string) => Promise<boolean>;
  /** A's SOS overlay. Called the instant an emergency tool runs, before any IO. */
  onSos?: () => void;
}

export interface AgentBridge {
  /** `true` = handled here; `false` = A should run its own intent path. */
  handleUtterance: (text: string) => Promise<boolean>;
  /** True while a turn is in flight (drives A's state). */
  busy: boolean;
  /** Local task list, kept in sync with the `tasks` store. */
  tasks: Task[];
}

export function useAgentBridge(deps: AgentBridgeDeps): AgentBridge {
  const [busy, setBusy] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const ref = useRef(deps);
  ref.current = deps;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;

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

  const handleUtterance = useCallback(async (text: string): Promise<boolean> => {
    const d = ref.current;
    const now = Date.now();
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
        },
        // Same id on every replay -> the family is paged once, not once per retry.
        sendSos: async (e) => {
          await enqueue("sos", e, now);
        },
        raiseSos: () => d.onSos?.(),
        locate: bridge()
          ? async () => {
              const pos = await bridge()?.getLocation();
              return pos ?? null;
            }
          : undefined,
      });

      const out = await runTurn(text, {
        locale: d.locale,
        now,
        reminders: d.reminders,
        tasks: tasksRef.current,
        canRun: runner.canRun,
        runTool: runner.run,
        confirm: d.onConfirm,
        // requestTurn intentionally absent — see the header. C3 flips this on.
      });

      if (!out.handled) return false;
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

  return { handleUtterance, busy, tasks };
}
