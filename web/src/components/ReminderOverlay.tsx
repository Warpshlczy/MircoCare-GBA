"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { t } from "@/lib/i18n";
import { speak } from "@/lib/audio";
import { scanTag, NFC_SUPPORTED } from "@/lib/nfc";
import type { Locale, ReminderItem } from "@/lib/types";

interface Props {
  item: ReminderItem;
  locale: Locale;
  escalation: "none" | "retry" | "notify-caregiver";
  onTaken: () => void;
  onSnooze: () => void;
}

/** Full-screen alert for seniors: huge type, 2 buttons, voice prompt, NFC "tap the box" confirm. */
export function ReminderOverlay({ item, locale, escalation, onTaken, onSnooze }: Props) {
  const [scanning, setScanning] = useState(false);
  const takenRef = useRef<HTMLButtonElement>(null);
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
    void speak(prompt, locale);
    // haptic alert — Android Chrome only (iOS Safari has no vibrate); optional call is the guard
    navigator.vibrate?.([200, 100, 200]);
  }, [locale, escalation, isFollowup]);

  // focus trap: Tab cycles between the two actions only
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const els = [takenRef.current, snoozeRef.current].filter(Boolean) as HTMLButtonElement[];
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    e.preventDefault();
    els[(i + (e.shiftKey ? els.length - 1 : 1)) % els.length]?.focus();
  };

  const onTap = async () => {
    setScanning(true);
    const text = await scanTag();
    setScanning(false);
    if (text !== null) onTaken();
  };

  const confirmTaken = () => {
    navigator.vibrate?.(40); // short haptic tap = "got it"
    onTaken();
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
          ref={snoozeRef}
          onClick={onSnooze}
          className="rounded-3xl border-4 border-aura-deep bg-white px-8 py-6 text-3xl font-bold text-aura-deep focus:outline-none focus-visible:ring-8 focus-visible:ring-aura-warm hc:border-white hc:bg-black hc:text-white"
        >
          {t(locale, "medSnooze")}
        </button>
      </div>

      {/* 适老化：NFC 提示同时是按钮，触控目标需 >=44x44px（规范最低值） */}
      {isFollowup ? null : NFC_SUPPORTED ? (
        <button
          onClick={onTap}
          className="elderly-tap inline-flex items-center justify-center rounded-2xl px-5 py-3 text-2xl font-bold underline text-aura-deep hc:text-white"
        >
          {scanning ? t(locale, "nfcScanning") : t(locale, "nfcTapHint")}
        </button>
      ) : (
        <p className="text-2xl text-aura-deep hc:text-white">{t(locale, "nfcUnavailable")}</p>
      )}
    </div>
  );
}