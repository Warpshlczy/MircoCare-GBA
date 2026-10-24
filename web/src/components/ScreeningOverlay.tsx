"use client";

import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { ensureAudioUnlocked, speak } from "@/lib/audio";
import { recordScreening } from "@/lib/vad";
import { postScreeningSession } from "@/lib/api";
import { track } from "@/lib/analytics";
import type { Locale } from "@/lib/types";

const DURATION_MS = 60_000;

type Phase = "recording" | "saving" | "done" | "failed";

interface Props {
  open: boolean;
  locale: Locale;
  onClose: () => void;
}

/**
 * One-minute voice screening. Records only on-device RMS-derived features via
 * `recordScreening` — no raw audio is stored or uploaded. The derived session is
 * posted to `/screening/sessions` so the personal baseline and caregiver view
 * have a real longitudinal signal.
 */
export function ScreeningOverlay({ open, locale, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>("recording");
  const [remaining, setRemaining] = useState(DURATION_MS / 1000);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    let alive = true;
    let tick: number | null = null;
    setPhase("recording");
    setRemaining(DURATION_MS / 1000);

    void (async () => {
      try {
        await ensureAudioUnlocked();
        await speak(t(locale, "screeningPrompt"), locale);
        if (!alive) return;
        const deadline = Date.now() + DURATION_MS;
        tick = window.setInterval(() => {
          setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
        }, 250);
        const session = await recordScreening(DURATION_MS, undefined, ctrl.signal);
        if (tick !== null) window.clearInterval(tick);
        if (!alive) return;
        setPhase("saving");
        await postScreeningSession(session);
        if (!alive) return;
        setPhase("done");
        track("screening_done", locale);
        void speak(t(locale, "screeningDone"), locale);
      } catch (error) {
        if (tick !== null) window.clearInterval(tick);
        if (!alive) return;
        if ((error as DOMException)?.name === "AbortError") return;
        setPhase("failed");
      }
    })();

    return () => {
      alive = false;
      ctrl.abort();
      if (tick !== null) window.clearInterval(tick);
    };
  }, [open, locale]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="screening-title"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-8 bg-aura-bg p-8 text-center hc:bg-black"
    >
      <h1 id="screening-title" className="text-4xl font-extrabold text-aura-deep hc:text-white">
        {t(locale, "screeningTitle")}
      </h1>

      {phase === "recording" ? (
        <>
          <p aria-live="polite" className="text-3xl font-bold text-aura-deep hc:text-white">
            {t(locale, "screeningRecording")}
          </p>
          <p className="rec-ring px-8 py-4 text-7xl font-black text-aura-accent">
            {remaining}
            <span className="ml-2 text-3xl">{t(locale, "screeningSeconds")}</span>
          </p>
        </>
      ) : null}

      {phase === "saving" ? (
        <p aria-live="polite" className="text-3xl font-bold text-aura-deep hc:text-white">
          {t(locale, "screeningSaving")}
        </p>
      ) : null}

      {phase === "done" ? (
        <p aria-live="polite" className="text-4xl font-extrabold text-aura-accent">
          {t(locale, "screeningDone")}
        </p>
      ) : null}

      {phase === "failed" ? (
        <p aria-live="assertive" className="text-3xl font-bold text-aura-danger">
          {t(locale, "screeningFailed")}
        </p>
      ) : null}

      <button
        onClick={onClose}
        className="rounded-3xl border-4 border-aura-deep bg-white px-8 py-6 text-3xl font-bold text-aura-deep focus:outline-none focus-visible:ring-8 focus-visible:ring-aura-warm hc:border-white hc:bg-black hc:text-white"
      >
        {t(locale, "screeningClose")}
      </button>
    </div>
  );
}
