"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { startGaitMonitor, requestMotionPermission } from "@/lib/motion";
import { put } from "@/lib/db";
import type { GaitMonitorState, GaitWindow } from "@/lib/types";

/** Starts/stops motion monitoring; persists windows offline; exposes last window + permission. */
export function useGaitMonitor() {
  const [running, setRunning] = useState(false);
  const [lastWindow, setLastWindow] = useState<GaitWindow | null>(null);
  const [permission, setPermission] = useState<GaitMonitorState["permission"]>("unknown");
  const stopRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setRunning(false);
  }, []);

  const start = useCallback(async () => {
    if (stopRef.current) return;
    const perm = await requestMotionPermission();
    setPermission(perm);
    if (perm === "unsupported") return;
    stopRef.current = startGaitMonitor((w) => {
      setLastWindow(w);
      void put("gait", w); // offline-first: persist, sync to api.ts later
    });
    setRunning(true);
  }, []);

  useEffect(() => stop, [stop]);

  return { running, lastWindow, permission, start, stop };
}