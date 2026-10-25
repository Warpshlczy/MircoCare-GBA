"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { escalationFor } from "@/lib/signal";
import { all, put } from "@/lib/db";
import type { ReminderItem } from "@/lib/types";

const TICK_MS = 1000;

export interface ReminderOptions {
  /** Called once when a reminder crosses into the caregiver-escalation stage. */
  onEscalate?: (item: ReminderItem) => void;
}

/** Schedules due reminders and drives the 10-min retry / 30-min caregiver escalation machine. */
export function useReminder(initial: ReminderItem[] = [], options: ReminderOptions = {}) {
  const [items, setItems] = useState<ReminderItem[]>(initial);
  const [due, setDue] = useState<ReminderItem | null>(null);
  const [escalation, setEscalation] = useState<"none" | "retry" | "notify-caregiver">("none");
  const dueRef = useRef<ReminderItem | null>(null);
  dueRef.current = due;
  const onEscalateRef = useRef(options.onEscalate);
  onEscalateRef.current = options.onEscalate;

  // hydrate from IndexedDB (offline-first)
  useEffect(() => {
    let alive = true;
    all<ReminderItem>("reminders").then((rows) => {
      if (alive && rows.length) setItems(rows);
    });
    return () => {
      alive = false;
    };
  }, []);

  const schedule = useCallback((item: ReminderItem) => {
    setItems((prev) => [...prev.filter((r) => r.id !== item.id), item]);
    void put("reminders", item);
  }, []);

  const update = useCallback((item: ReminderItem) => {
    setItems((prev) => prev.map((r) => (r.id === item.id ? item : r)));
    void put("reminders", item);
  }, []);

  // tick: surface the earliest pending reminder, run the escalation machine
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const active = dueRef.current;
      if (!active) {
        const next = items
          .filter((r) => r.status === "pending" && r.dueAt <= now)
          .sort((a, b) => a.dueAt - b.dueAt)[0];
        if (next) {
          setDue(next);
          setEscalation("none");
        }
        return;
      }
      const stage = escalationFor(now - active.dueAt);
      if (stage !== active.stage) {
        const status: ReminderItem["status"] = stage === "notify-caregiver" ? "escalated" : "pending";
        const next: ReminderItem = { ...active, stage, status };
        // Keep the live `due` object in sync with the persisted item; otherwise
        // `active.stage` stays stale and this branch re-fires every tick.
        dueRef.current = next;
        setDue(next);
        setEscalation(stage);
        update(next);
        if (stage === "notify-caregiver") onEscalateRef.current?.(next);
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [items, update]);

  const clear = useCallback(() => {
    setDue(null);
    setEscalation("none");
  }, []);

  const confirmTaken = useCallback(() => {
    const active = dueRef.current;
    if (!active) return;
    update({ ...active, status: "taken" });
    clear();
  }, [update, clear]);

  /**
   * Tick one reminder without waiting for it to be due. Used when the senior
   * says "食咗" or taps the item on a card, so the schedule is cleared even if
   * the reminder never reached the full-screen prompt.
   */
  const takeById = useCallback((id: string): boolean => {
    const active = dueRef.current;
    if (active?.id === id) {
      update({ ...active, status: "taken" });
      clear();
      return true;
    }
    const target = items.find((r) => r.id === id && r.status !== "taken");
    if (!target) return false;
    update({ ...target, status: "taken" });
    return true;
  }, [items, update, clear]);

  /** "我食咗藥": clear the live med prompt, or the latest pending med reminder. */
  const takeMedication = useCallback((name?: string) => {
    const active = dueRef.current;
    if (active && active.kind === "med") {
      update({ ...active, status: "taken" });
      clear();
      return;
    }
    const pending = items
      .filter((r) => r.kind === "med" && r.status === "pending")
      .sort((a, b) => b.dueAt - a.dueAt);
    const named = name
      ? pending.find((r) => (r.med?.name ?? r.title).includes(name))
      : undefined;
    const target = named ?? pending[0];
    if (target) update({ ...target, status: "taken" });
  }, [items, update, clear]);

  const snooze = useCallback(() => {
    const active = dueRef.current;
    if (!active) return;
    update({ ...active, dueAt: Date.now() + 5 * 60 * 1000, stage: "none", status: "pending" });
    clear();
  }, [update, clear]);

  const dismiss = useCallback(() => {
    const active = dueRef.current;
    if (!active) return;
    update({ ...active, status: "missed" });
    clear();
  }, [update, clear]);

  return { due, escalation, items, schedule, confirmTaken, takeById, takeMedication, snooze, dismiss };
}