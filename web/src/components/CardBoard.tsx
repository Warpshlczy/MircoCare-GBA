"use client";

import { CardRenderer } from "./CardRenderer";
import type { AgentCard, Intent } from "@/lib/types";

/** The card stream — the app's own "desktop". Newest card first. */
export function CardBoard({
  cards,
  onAction,
  onCheck,
}: {
  cards: AgentCard[];
  onAction?: (intent: Intent) => void;
  onCheck?: (itemId: string) => void;
}) {
  if (!cards.length) return null;
  return (
    <section aria-label="卡片" className="flex w-full max-w-md flex-col gap-5">
      {cards.map((c) => (
        <CardRenderer key={c.id} card={c} onAction={onAction} onCheck={onCheck} />
      ))}
    </section>
  );
}