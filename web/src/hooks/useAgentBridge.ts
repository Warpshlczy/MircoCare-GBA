"use client";

// useAgentBridge.ts — B's ONLY seam into A's page.tsx (docs/dev.md §0.2).
//
// A owns page.tsx and never imports lib/agent.ts directly. A calls
// `handleUtterance(text)` in place of its old `runIntent(text)`:
//
//     if (!(await agent.handleUtterance(text))) void runIntent(text);
//
// Returning `false` means "not mine, keep your existing path" — so wiring this
// in is a no-op until W2 starts handling more intents. That keeps W0 at
// zero behaviour change (A can merge it without a demo regression).
//
// W0 scope: local card fallback only (weather / tasks / medication), exactly
// what page.tsx already does. W2 swaps the body for `agent.runTurn()`.

import { useCallback, useRef, useState } from "react";
import { localCardsFor } from "@/lib/cards";
import { parseIntent } from "@/lib/intent";
import type { AgentCard, Locale, ReminderItem } from "@/lib/types";

export interface AgentBridgeDeps {
  locale: Locale;
  reminders: ReminderItem[];
  /** A's card board entry point. */
  onCards: (cards: AgentCard[]) => void;
  /** A's speak(); used from W2 for the agent's reply and confirm questions. */
  onSpeak?: (text: string) => void;
  /** A's spoken yes/no; resolves false when the senior declines or stays silent. */
  onConfirm?: (question: string) => Promise<boolean>;
}

export interface AgentBridge {
  /** `true` = handled here; `false` = A should run its own intent path. */
  handleUtterance: (text: string) => Promise<boolean>;
  /** True while a tool call or a backend turn is in flight (drives A's state). */
  busy: boolean;
}

/** Intents the W0 bridge can satisfy locally, using the existing card factory. */
const LOCAL_CARD_INTENTS = new Set(["weather", "tasks", "medication"]);

export function useAgentBridge(deps: AgentBridgeDeps): AgentBridge {
  const [busy, setBusy] = useState(false);
  // Keep the latest deps in a ref so `handleUtterance` stays referentially stable
  // (page.tsx may put it in a dependency array).
  const ref = useRef(deps);
  ref.current = deps;

  const handleUtterance = useCallback(async (text: string): Promise<boolean> => {
    const d = ref.current;
    const intent = parseIntent(text);
    if (!LOCAL_CARD_INTENTS.has(intent)) return false;

    setBusy(true);
    try {
      const cards = localCardsFor(intent, d.locale, {
        reminders: d.reminders,
        now: Date.now(),
      });
      if (cards.length === 0) return false;
      d.onCards(cards);
      return true;
    } finally {
      setBusy(false);
    }
  }, []);

  return { handleUtterance, busy };
}
