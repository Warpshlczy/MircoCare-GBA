// native.ts — the ONE seam a native shell plugs into (Capacitor / React Native).
//
// Why this exists (honest platform ceilings of a web page):
//   (a) it cannot hear a wake word while backgrounded/locked,
//   (b) it cannot bring itself to the foreground, and
//   (c) it cannot place cards on the OS home screen.
// A thin native shell CAN do all three. Everything below is a NO-OP on the web —
// the shell injects `window.__AuraNative` and these calls start working.
//
// Capacitor upgrade path:
//   background audio service (custom plugin / @capacitor-community/*) -> startBackgroundWake()
//   Android AppWidget / iOS WidgetKit                                 -> updateHomeWidget()
//   deep link / bring WebView forward                                 -> bringToForeground()

import type { AgentCard, ReminderItem } from "./types";

export interface HomeWidgetPayload {
  updatedAt: number;
  title: string;
  items: { text: string; done: boolean }[];
  topCard?: { kind: string; headline: string };
}

export interface AuraNativeBridge {
  startBackgroundWake(): Promise<boolean>;
  stopBackgroundWake(): Promise<void>;
  updateHomeWidget(p: HomeWidgetPayload): Promise<void>;
  bringToForeground(): Promise<boolean>;
}

export function nativeAvailable(): boolean {
  return typeof window !== "undefined" && ("__AuraNative" in window || capacitorPlugin() !== null);
}

/** The Capacitor-registered `AuraNative` plugin, if the app runs inside the shell. */
function capacitorPlugin(): AuraNativePlugin | null {
  if (typeof window === "undefined") return null;
  const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, AuraNativePlugin> } }).Capacitor;
  return cap?.Plugins?.AuraNative ?? null;
}

/** The raw shape of the plugin methods (Capacitor returns a promise per call). */
interface AuraNativePlugin {
  startBackgroundWake(): Promise<{ started?: boolean }>;
  stopBackgroundWake(): Promise<void>;
  updateHomeWidget(p: HomeWidgetPayload): Promise<void>;
  bringToForeground(): Promise<{ ok?: boolean }>;
}

/**
 * Returns the native bridge, or null on the plain web. Two sources, same shape:
 *   1. `window.__AuraNative` — anything that injects it (a WebView, a test stub);
 *   2. the Capacitor `AuraNative` plugin — the Android shell's own implementation.
 * Callers must null-check.
 */
export function bridge(): AuraNativeBridge | null {
  if (typeof window === "undefined") return null;
  const injected = (window as unknown as { __AuraNative?: AuraNativeBridge }).__AuraNative;
  if (injected) return injected;
  const p = capacitorPlugin();
  if (!p) return null;
  return {
    startBackgroundWake: () => p.startBackgroundWake().then((r) => !!r?.started),
    stopBackgroundWake: () => p.stopBackgroundWake(),
    updateHomeWidget: (payload) => p.updateHomeWidget(payload),
    bringToForeground: () => p.bringToForeground().then((r) => !!r?.ok),
  };
}

/**
 * Builds the payload an OS home-screen widget renders. PURE (tested in
 * src/selfcheck.ts) so the shell and the web agree on one shape.
 */
export function homeWidgetPayload(
  cards: AgentCard[],
  reminders: ReminderItem[],
  now = Date.now()
): HomeWidgetPayload {
  const top = cards[0];
  return {
    updatedAt: now,
    title: "湾区灵犀",
    items: reminders
      .filter((r) => r.status === "pending" || r.status === "taken")
      .slice(0, 4)
      .map((r) => ({ text: r.med?.name ?? r.title, done: r.status === "taken" })),
    topCard: top ? { kind: top.kind, headline: top.data?.headline ?? top.title } : undefined,
  };
}