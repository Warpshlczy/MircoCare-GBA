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
// W2 scope: refusal rules + the local card fallback that page.tsx already does.
// Backend turns are NOT wired yet — `requestTurn` stays undefined until C ships
// POST /agent/turn (issue #2), so any non-local utterance returns false and A's
// original path runs unchanged. No mock data is fabricated here.

import { useCallback, useEffect, useRef, useState } from "react";
import { runTurn } from "@/lib/agent";
import { listTasks } from "@/lib/taskStore";
import type { AgentCard, Locale, ReminderItem, Task } from "@/lib/types";

export interface AgentBridgeDeps {
  locale: Locale;
  reminders: ReminderItem[];
  /** A's card board entry point. */
  onCards: (cards: AgentCard[]) => void;
  /** A's speak(); used for refusal lines and (later) tool confirmations. */
  onSpeak?: (text: string) => void;
  /** A's spoken yes/no; resolves false when the senior declines or stays silent. */
  onConfirm?: (question: string) => Promise<boolean>;
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
    setBusy(true);
    try {
      const out = await runTurn(text, {
        locale: d.locale,
        now: Date.now(),
        reminders: d.reminders,
        tasks: tasksRef.current,
        // requestTurn / runTool land in W3, once C's route and B's native
        // shell exist. Until then runTurn returns handled=false for anything
        // it cannot answer locally.
        confirm: d.onConfirm,
      });

      if (!out.handled) return false;
      if (out.reply && d.onSpeak) d.onSpeak(out.reply);
      if (out.cards.length > 0) d.onCards(out.cards);
      return true;
    } finally {
      setBusy(false);
    }
  }, []);

  return { handleUtterance, busy, tasks };
}
