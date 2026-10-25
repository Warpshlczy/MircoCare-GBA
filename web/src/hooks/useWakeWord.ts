"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ensureAudioUnlocked, startWakeWord } from "@/lib/audio";
import { track } from "@/lib/analytics";
import type { ActivityState, Locale } from "@/lib/types";

/** Names that wake the assistant. Kept lowercase for matching. Mirrors the
 *  native `WakeListenService.NAMES` (B) — change both together.
 *
 *  The homophones are deliberate: on-device ASR routinely hears 「小忆」as
 *  「小艺／小意／小易」. A wake word that only matches one spelling is a wake
 *  word that silently fails for exactly the speaker who needs it. */
export const WAKE_NAMES = [
  "小忆",
  "小憶",
  "小艺",
  "小藝",
  "小意",
  "小易",
  "晓忆",
  "曉憶",
  "阿忆",
  "阿憶",
  "忆伴",
  "憶伴",
  "memomate",
  "memo mate",
];

/**
 * The subset used while the assistant is SPEAKING (barge-in).
 *
 * 「忆伴」/「憶伴」 are excluded on purpose: the greeting says 「我係憶伴」, so a
 * recognizer that hears its own speaker output would wake itself in a loop.
 */
export const SPEAK_WAKE_NAMES = [
  "小忆",
  "小憶",
  "小艺",
  "小藝",
  "小意",
  "小易",
  "晓忆",
  "曉憶",
  "阿忆",
  "阿憶",
  "memomate",
  "memo mate",
];

/**
 * Sleep/awake lifecycle around the wake name. While `enabled` and sleeping it
 * listens for the wake name; on a hit it speaks a greeting and calls `onWake`.
 * Call `sleep()` to re-arm after an interaction (or when idle again).
 *
 * `sleep(names)` re-arms with a narrower name list — page.tsx uses that while
 * the digital human is speaking, so the senior can interrupt by calling his
 * name again without the speaker waking itself.
 */
export function useWakeWord(locale: Locale, enabled: boolean, onWake: () => void) {
  const [activity, setActivity] = useState<ActivityState>("sleeping");
  const handleRef = useRef<{ stop: () => void } | null>(null);
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;
  const namesRef = useRef<string[]>(WAKE_NAMES);

  const stopListening = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
  }, []);

  const arm = useCallback(
    (names?: string[]) => {
      if (names) namesRef.current = names;
      stopListening();
      handleRef.current = startWakeWord(locale, namesRef.current, () => {
        track("wake_word", locale);
        stopListening();
        setActivity("awake");
        onWakeRef.current();
      });
    },
    [locale, stopListening]
  );

  useEffect(() => {
    if (!enabled) {
      stopListening();
      return;
    }
    void ensureAudioUnlocked().then(() => arm());
    return stopListening;
  }, [enabled, arm, stopListening]);

  const sleep = useCallback(
    (names?: string[]) => {
      setActivity("sleeping");
      if (enabled) arm(names ?? WAKE_NAMES);
    },
    [enabled, arm]
  );

  return { activity, sleep, stopListening };
}