// Browser glue: DeviceMotionEvent (~20Hz) -> GaitWindow (steps/cadence/cv/fall).
//
// ponytail: background & screen-off sampling is a platform ceiling — iOS Safari stops
// DeviceMotion when the screen locks or the tab is backgrounded, and Android throttles
// it. So fall detection only runs while the PWA is foreground/awake. Upgrade path:
// a thin native wrapper (or a BLE wearable) that streams accelerometer data to the app.

import { createFallDetector, detectSteps, gaitVariability } from "./signal";
import type { AccelSample, GaitWindow } from "./types";

export async function requestMotionPermission(): Promise<"granted" | "denied" | "unsupported"> {
  if (typeof window === "undefined" || !("DeviceMotionEvent" in window)) return "unsupported";
  const DM = window.DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
  if (typeof DM.requestPermission === "function") {
    try {
      const res = await DM.requestPermission();
      return res === "granted" ? "granted" : "denied";
    } catch {
      return "denied";
    }
  }
  return "granted"; // non-iOS: permission granted by feature presence
}

export interface GaitCfg {
  windowMs?: number; // aggregation window, default 5000
}

/** Subscribes to DeviceMotionEvent; returns a stop() function. */
export function startGaitMonitor(
  onWindow: (w: GaitWindow) => void,
  cfg: GaitCfg = {}
): () => void {
  const windowMs = cfg.windowMs ?? 5000;
  const detector = createFallDetector();
  let samples: AccelSample[] = [];
  let fall = false;
  let fallReason: GaitWindow["fallReason"];
  let windowStart = Date.now();

  const onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    const r = e.rotationRate ?? { alpha: 0, beta: 0, gamma: 0 };
    const t = Date.now();
    const acc: AccelSample = { t, ax: a.x, ay: a.y, az: a.z };
    samples.push(acc);
    const res = detector.push({
      t,
      ax: a.x,
      ay: a.y,
      az: a.z,
      gx: (r.alpha ?? 0) / 60,
      gy: (r.beta ?? 0) / 60,
      gz: (r.gamma ?? 0) / 60,
    });
    if (res.fall) {
      fall = true;
      fallReason = res.reason;
    }
    if (t - windowStart >= windowMs) {
      const steps = detectSteps(samples);
      const v = gaitVariability(steps);
      onWindow({
        id: `gw-${windowStart}`,
        startedAt: windowStart,
        endedAt: t,
        steps: v.steps,
        cadence: v.cadence,
        cv: v.cv,
        fall,
        fallReason,
      });
      samples = [];
      fall = false;
      fallReason = undefined;
      windowStart = t;
    }
  };

  window.addEventListener("devicemotion", onMotion);
  return () => window.removeEventListener("devicemotion", onMotion);
}