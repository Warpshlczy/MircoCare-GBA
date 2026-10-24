"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { speak } from "@/lib/audio";
import { postSos } from "@/lib/api";
import { Avatar } from "./Avatar";
import type { Locale, SosAck, SosEvent } from "@/lib/types";

interface Props {
  open: boolean;
  locale: Locale;
  onClose: () => void;
  /** reason the SOS was opened (fall auto-open vs. button) */
  reason?: SosEvent["reason"];
  /** where the button was reached from — `widget` = lock-screen hot zone */
  source?: SosEvent["source"];
}

/** Mainland China uses 120; Hong Kong and Macao use 999. */
function emergencyNumber(locale: Locale): string {
  return locale === "zh-CN" ? "120" : "999";
}

type Phase = "confirm" | "sending" | "sent" | "failed";

/**
 * One-tap SOS with DOUBLE confirmation: the avatar asks by voice, a countdown
 * runs, and only after the countdown (or an explicit confirm) do we escalate.
 *
 * The UI never claims help was delivered unless the backend accepted the event,
 * and even then it says "recorded" rather than "family notified" because the
 * outbox still needs a real push/SMS provider. On failure it offers a retry and
 * a direct emergency-number dial link.
 */
export function SosOverlay({ open, locale, onClose, reason = "button", source = "app" }: Props) {
  const [seconds, setSeconds] = useState(15);
  const [phase, setPhase] = useState<Phase>("confirm");
  const [ack, setAck] = useState<SosAck | null>(null);
  const escalating = useRef(false);

  const escalate = useCallback(async () => {
    if (escalating.current) return;
    escalating.current = true;
    setPhase("sending");
    const event: SosEvent = {
      id: `sos-${Date.now()}`,
      at: Date.now(),
      locale,
      reason,
      source,
      confirmed: true,
      status: "pending",
    };
    try {
      // 202 body: `notified` lists who the outbox actually reached. Empty means
      // no family is paired, so the senior must never hear "family notified".
      const res = await postSos(event);
      setAck(res);
      setPhase("sent");
      navigator.vibrate?.(600); // long haptic = the request was accepted
      void speak(t(locale, res?.notified?.length ? "sosNotified" : "sosNoFamily"), locale);
    } catch {
      setPhase("failed");
      navigator.vibrate?.([500, 150, 500]);
      void speak(t(locale, "sosFailed"), locale);
    }
  }, [locale, reason, source]);

  const retry = useCallback(() => {
    escalating.current = false;
    void escalate();
  }, [escalate]);

  useEffect(() => {
    if (!open) return;
    escalating.current = false;
    setAck(null);
    setPhase("confirm");
    setSeconds(15);
    navigator.vibrate?.([300, 100, 300]); // recognizable "attention" pattern
    void speak(t(locale, reason === "fall" ? "fallDetected" : "sosConfirmQuestion"), locale);
  }, [open, locale, reason]);

  useEffect(() => {
    if (!open || phase !== "confirm") return;
    if (seconds <= 0) {
      void escalate();
      return;
    }
    const id = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [open, phase, seconds, escalate]);

  if (!open) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="sos-title"
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-6 bg-aura-danger p-8 text-center"
    >
      <Avatar state={phase === "sent" ? "speaking" : "confirming"} size={200} label={t(locale, "appName")} />

      {phase === "confirm" ? (
        <>
          <h1 id="sos-title" className="max-w-[20ch] text-5xl font-extrabold text-white">
            {t(locale, "sosConfirmQuestion")}
          </h1>
          <p aria-live="polite" className="text-7xl font-black text-white">
            {seconds}
          </p>
          <div className="flex w-full max-w-md flex-col gap-5">
            <button
              onClick={() => void escalate()}
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
      ) : null}

      {phase === "sending" ? (
        <>
          <h1 id="sos-title" aria-live="polite" className="text-5xl font-extrabold text-white">
            {t(locale, "sosSending")}
          </h1>
        </>
      ) : null}

      {phase === "sent" ? (
        <>
          <h1 id="sos-title" className="max-w-[22ch] text-4xl font-extrabold text-white">
            {t(locale, ack?.notified?.length ? "sosNotified" : "sosNoFamily")}
          </h1>
          <a
            href={`tel:${emergencyNumber(locale)}`}
            className="rounded-3xl bg-white px-10 py-6 text-4xl font-extrabold text-aura-danger focus:outline-none focus-visible:ring-8 focus-visible:ring-aura-warm"
          >
            {t(locale, "sosCallEmergency")}
          </a>
          <button
            onClick={onClose}
            className="rounded-3xl border-4 border-white px-8 py-6 text-3xl font-bold text-white focus:outline-none focus-visible:ring-8 focus-visible:ring-aura-warm"
          >
            {t(locale, "sosCancel")}
          </button>
        </>
      ) : null}

      {phase === "failed" ? (
        <>
          <h1 id="sos-title" aria-live="assertive" className="max-w-[22ch] text-4xl font-extrabold text-white">
            {t(locale, "sosFailed")}
          </h1>
          <div className="flex w-full max-w-md flex-col gap-5">
            <a
              href={`tel:${emergencyNumber(locale)}`}
              className="rounded-3xl bg-white px-10 py-6 text-4xl font-extrabold text-aura-danger focus:outline-none focus-visible:ring-8 focus-visible:ring-aura-warm"
            >
              {t(locale, "sosCallEmergency")}
            </a>
            <button
              onClick={retry}
              className="rounded-3xl bg-aura-deep px-8 py-6 text-3xl font-extrabold text-white focus:outline-none focus-visible:ring-8 focus-visible:ring-aura-warm"
            >
              {t(locale, "sosRetry")}
            </button>
            <button
              onClick={onClose}
              className="rounded-3xl border-4 border-white px-8 py-6 text-3xl font-bold text-white focus:outline-none focus-visible:ring-8 focus-visible:ring-aura-warm"
            >
              {t(locale, "sosCancel")}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
