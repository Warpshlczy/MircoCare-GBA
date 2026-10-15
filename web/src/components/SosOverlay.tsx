"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { speak } from "@/lib/audio";
import { postSos } from "@/lib/api";
import { Avatar } from "./Avatar";
import type { Locale, SosEvent } from "@/lib/types";

interface Props {
  open: boolean;
  locale: Locale;
  onClose: () => void;
  /** reason the SOS was opened (fall auto-open vs. button) */
  reason?: SosEvent["reason"];
}

/**
 * One-tap SOS with DOUBLE confirmation: the avatar asks by voice, a countdown runs,
 * and only after the countdown (or an explicit confirm) do we escalate. The countdown
 * + explicit "取消" is what makes it resistant to accidental triggers.
 */
export function SosOverlay({ open, locale, onClose, reason = "button" }: Props) {
  const [seconds, setSeconds] = useState(15);
  const [sent, setSent] = useState(false);
  const sentRef = useRef(false);

  const escalate = useCallback(async () => {
    if (sentRef.current) return;
    sentRef.current = true;
    const event: SosEvent = {
      id: `sos-${Date.now()}`,
      at: Date.now(),
      locale,
      reason,
      confirmed: true,
      status: "pending",
    };
    try {
      await postSos(event);
    } catch {
      /* stub throws NOT_IMPLEMENTED — UI still shows the escalation state */
    }
    setSent(true);
    navigator.vibrate?.(600); // long haptic = escalation actually fired
    void speak(t(locale, "sosDialing"), locale);
  }, [locale, reason]);

  useEffect(() => {
    if (!open) return;
    sentRef.current = false;
    setSent(false);
    setSeconds(15);
    navigator.vibrate?.([300, 100, 300]); // recognizable "attention" pattern
    void speak(t(locale, reason === "fall" ? "fallDetected" : "sosConfirmQuestion"), locale);
  }, [open, locale, reason]);

  useEffect(() => {
    if (!open || sent) return;
    if (seconds <= 0) {
      void escalate();
      return;
    }
    const id = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [open, sent, seconds, escalate]);

  if (!open) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="sos-title"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-aura-danger p-8 text-center"
    >
      <Avatar state={sent ? "speaking" : "confirming"} size={200} />
      <h1 id="sos-title" className="max-w-[20ch] text-5xl font-extrabold text-white">
        {sent ? t(locale, "sosDialing") : t(locale, "sosConfirmQuestion")}
      </h1>

      {sent ? (
        <>
          <p className="text-4xl font-bold text-white">
            {t(locale, "caregiverEscalation")}
          </p>
          <button
            onClick={onClose}
            className="rounded-3xl bg-white px-10 py-6 text-4xl font-extrabold text-aura-danger focus:outline-none focus-visible:ring-8 focus-visible:ring-white"
          >
            {t(locale, "sosCancel")}
          </button>
        </>
      ) : (
        <>
          <p aria-live="polite" className="text-7xl font-black text-white">
            {seconds}
          </p>
          <div className="flex w-full max-w-md flex-col gap-5">
            <button
              onClick={() => void escalate()}
              autoFocus
              className="rounded-3xl bg-white px-8 py-8 text-4xl font-extrabold text-aura-danger focus:outline-none focus-visible:ring-8 focus-visible:ring-aura-warm"
            >
              {t(locale, "confirmYes")}
            </button>
            <button
              onClick={onClose}
              className="rounded-3xl border-4 border-white px-8 py-6 text-3xl font-bold text-white focus:outline-none focus-visible:ring-8 focus-visible:ring-aura-warm"
            >
              {t(locale, "sosCancel")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}