"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { t } from "@/lib/i18n";
import { listenOnce, speak } from "@/lib/audio";
import { ANSWER_TIMEOUT_MS, isYes } from "@/lib/interview";
import type { Locale, ReminderItem } from "@/lib/types";

interface Props {
  item: ReminderItem;
  locale: Locale;
  escalation: "none" | "retry" | "notify-caregiver";
  onTaken: () => void;
  onSnooze: () => void;
}

/** Full-screen alert for seniors: huge type, one-tap or spoken "食咗" confirm. */
export function ReminderOverlay({ item, locale, escalation, onTaken, onSnooze }: Props) {
  const [listening, setListening] = useState(false);
  const takenRef = useRef<HTMLButtonElement>(null);
  const voiceRef = useRef<HTMLButtonElement>(null);
  const snoozeRef = useRef<HTMLButtonElement>(null);
  const isFollowup = item.kind === "followup";

  useEffect(() => {
    takenRef.current?.focus();
  }, []);

  useEffect(() => {
    const prompt =
      escalation === "notify-caregiver"
        ? t(locale, isFollowup ? "followupEscalation" : "caregiverEscalation")
        : t(locale, isFollowup ? "followupConfirm" : "medConfirm");
    void speak(prompt, locale, undefined, "gentle");
    // haptic alert — Android Chrome only (iOS Safari has no vibrate); optional call is the guard
    navigator.vibrate?.([200, 100, 200]);
  }, [locale, escalation, isFollowup]);

  // focus trap: Tab cycles between the three actions only
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const els = [takenRef.current, voiceRef.current, snoozeRef.current].filter(Boolean) as HTMLButtonElement[];
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    e.preventDefault();
    els[(i + (e.shiftKey ? els.length - 1 : 1)) % els.length]?.focus();
  };

  const confirmTaken = () => {
    navigator.vibrate?.(40); // short haptic tap = "got it"
    onTaken();
  };

  /**
   * "食咗" / "吃了" is a complete answer. The button exists so the senior can
   * choose to speak instead of tapping — no NFC tag, no extra hardware.
   */
  const onVoice = async () => {
    if (listening) return;
    setListening(true);
    try {
      const heard = await listenOnce(locale, ANSWER_TIMEOUT_MS);
      const words = (heard?.text ?? "").trim();
      if (words && (isYes(words) || /(食咗|吃了|食完|吃完|食過|食过|已食|知道|好)/.test(words))) {
        confirmTaken();
        return;
      }
      void speak(t(locale, "noSpeech"), locale, undefined, "gentle");
    } finally {
      setListening(false);
    }
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="reminder-title"
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-8 bg-aura-bg p-8 text-center hc:bg-black"
    >
      <h1 id="reminder-title" className="text-5xl font-extrabold text-aura-deep hc:text-white">
        {t(locale, isFollowup ? "followupTitle" : "reminderTitle")}
      </h1>
      <p className="max-w-[22ch] text-4xl font-bold leading-snug text-aura-deep hc:text-yellow-300">
        {item.med?.name ?? item.title}
      </p>
      <p className="text-3xl text-aura-deep hc:text-white">
        {t(locale, isFollowup ? "followupConfirm" : "medConfirm")}
      </p>

      <div className="flex w-full max-w-md flex-col gap-5">
        <button
          ref={takenRef}
          onClick={confirmTaken}
          className="rounded-3xl bg-aura-accent px-8 py-8 text-4xl font-extrabold text-white shadow-lg focus:outline-none focus-visible:ring-8 focus-visible:ring-aura-warm hc:bg-yellow-300 hc:text-black"
        >
          {t(locale, isFollowup ? "followupDone" : "medTaken")}
        </button>
        <button
          ref={voiceRef}
          onClick={() => void onVoice()}
          aria-label={t(locale, "medConfirm")}
          className="rounded-3xl border-4 border-aura-accent bg-white px-8 py-6 text-3xl font-bold text-aura-deep focus:outline-none focus-visible:ring-8 focus-visible:ring-aura-warm hc:border-yellow-300 hc:bg-black hc:text-yellow-300"
        >
          {listening ? t(locale, "listening") : `🎙 ${t(locale, "talkButton")}`}
        </button>
        <button
          ref={snoozeRef}
          onClick={onSnooze}
          className="rounded-3xl border-4 border-aura-deep bg-white px-8 py-6 text-3xl font-bold text-aura-deep focus:outline-none focus-visible:ring-8 focus-visible:ring-aura-warm hc:border-white hc:bg-black hc:text-white"
        >
          {t(locale, "medSnooze")}
        </button>
      </div>

      <p className="text-2xl text-aura-deep hc:text-white">{t(locale, "medConfirm")}</p>
    </div>
  );
}