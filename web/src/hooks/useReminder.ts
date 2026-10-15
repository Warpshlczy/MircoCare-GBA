"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { escalationFor } from "@/lib/signal";
import { all, put } from "@/lib/db";
import type { ReminderItem } from "@/lib/types";

const TICK_MS = 1000;

/** Schedules due reminders and drives the 10-min retry / 30-min caregiver escalation machine. */
export function useReminder(initial: ReminderItem[] = []) {
  const [items, setItems] = useState<ReminderItem[]>(initial);
  const [due, setDue] = useState<ReminderItem | null>(null);
  const [escalation, setEscalation] = useState<"none" | "retry" | "notify-caregiver">("none");
  const dueRef = useRef<ReminderItem | null>(null);
  dueRef.current = due;

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
        setEscalation(stage);
        update({ ...active, stage, status: stage === "notify-caregiver" ? "escalated" : "pending" });
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

  return { due, escalation, items, schedule, confirmTaken, snooze, dismiss };
}