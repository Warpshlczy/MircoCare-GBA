"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ensureAudioUnlocked, startWakeWord } from "@/lib/audio";
import { track } from "@/lib/analytics";
import type { ActivityState, Locale } from "@/lib/types";

/** Names that wake the assistant. Kept lowercase for matching. Mirrors the
 *  native `WakeListenService.NAMES` (B) — change both together. */
export const WAKE_NAMES = ["小忆", "小憶", "阿忆", "阿憶", "忆伴", "憶伴", "memomate", "memo mate"];

/**
 * Sleep/awake lifecycle around the wake name. While `enabled` and sleeping it
 * listens for the wake name; on a hit it speaks a greeting and calls `onWake`.
 * Call `sleep()` to re-arm after an interaction (or when idle again).
 */
export function useWakeWord(locale: Locale, enabled: boolean, onWake: () => void) {
  const [activity, setActivity] = useState<ActivityState>("sleeping");
  const handleRef = useRef<{ stop: () => void } | null>(null);
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;

  const stopListening = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
  }, []);

  const arm = useCallback(() => {
    stopListening();
    handleRef.current = startWakeWord(locale, WAKE_NAMES, () => {
      track("wake_word", locale);
      stopListening();
      setActivity("awake");
      onWakeRef.current();
    });
  }, [locale, stopListening]);

  useEffect(() => {
    if (!enabled) {
      stopListening();
      return;
    }
    void ensureAudioUnlocked().then(arm);
    return stopListening;
  }, [enabled, arm, stopListening]);

  const sleep = useCallback(() => {
    setActivity("sleeping");
    if (enabled) arm();
  }, [enabled, arm]);

  return { activity, sleep, stopListening };
}