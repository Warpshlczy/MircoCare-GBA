"use client";

import { useEffect, useRef, useState } from "react";
import { captureFrame, openCamera, type CameraHandle } from "@/lib/camera";
import { t } from "@/lib/i18n";
import type { Locale } from "@/lib/types";

interface Props {
  open: boolean;
  locale: Locale;
  onCapture: (dataUrl: string) => void;
  onClose: () => void;
}

/** Full-screen camera with one giant shutter button. Elderly-first: no settings. */
export function CameraOverlay({ open, locale, onCapture, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const handleRef = useRef<CameraHandle | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const video = videoRef.current;
    if (!video) return;
    openCamera(video)
      .then((h) => {
        if (alive) handleRef.current = h;
        else h.stop();
      })
      .catch(() => setError(true));
    return () => {
      alive = false;
      handleRef.current?.stop();
      handleRef.current = null;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-label={t(locale, "cameraTitle")} className="fixed inset-0 z-50 bg-black">
      {error ? (
        <div className="flex h-full flex-col items-center justify-center gap-6 p-8 text-center">
          <p className="text-3xl font-bold text-white">{t(locale, "cameraUnavailable")}</p>
          <button
            onClick={onClose}
            className="rounded-3xl bg-white px-10 py-6 text-4xl font-extrabold text-black"
          >
            {t(locale, "cameraClose")}
          </button>
        </div>
      ) : (
        <>
          <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
          <button
            onClick={() => {
              const v = videoRef.current;
              if (v) onCapture(captureFrame(v));
            }}
            aria-label={t(locale, "cameraShutter")}
            className="absolute bottom-10 left-1/2 h-28 w-28 -translate-x-1/2 rounded-full border-8 border-white bg-aura-warm"
          />
          <button
            onClick={onClose}
            className="elderly-tap absolute right-6 top-6 inline-flex items-center justify-center rounded-2xl bg-white/90 px-5 py-3 text-2xl font-bold text-black"
          >
            {t(locale, "cameraClose")}
          </button>
        </>
      )}
    </div>
  );
}