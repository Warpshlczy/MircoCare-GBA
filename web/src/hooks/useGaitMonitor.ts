"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { startGaitMonitor, requestMotionPermission } from "@/lib/motion";
import { all, del, put } from "@/lib/db";
import { postGaitWindow } from "@/lib/api";
import type { GaitMonitorState, GaitWindow } from "@/lib/types";

/** In-flight guard so a live window and the boot replay never upload twice. */
const uploading = new Set<string>();

async function uploadWindow(w: GaitWindow): Promise<void> {
  if (uploading.has(w.id)) return;
  uploading.add(w.id);
  try {
    await postGaitWindow(w);
    await del("gait", w.id); // uploaded: drop the local copy
  } catch {
    /* offline / not authenticated yet — keep it for the next flush */
  } finally {
    uploading.delete(w.id);
  }
}

/** Replays persisted gait windows that have not reached the backend yet. */
export async function flushGaitUploads(): Promise<void> {
  const rows = await all<GaitWindow>("gait").catch(() => []);
  await Promise.all(rows.map(uploadWindow));
}

/** Starts/stops motion monitoring; persists + uploads windows; exposes last window + permission. */
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
      // Offline-first: persist, then try to upload and delete on success.
      void put("gait", w).then(() => uploadWindow(w));
    });
    setRunning(true);
  }, []);

  useEffect(() => stop, [stop]);

  return { running, lastWindow, permission, start, stop };
}