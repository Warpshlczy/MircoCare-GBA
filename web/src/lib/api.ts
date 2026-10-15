// api.ts — backend endpoints (AuraGBA screening engine). LLM endpoints stay blank.
//
// PRIVACY CONTRACT (binding):
//   Raw audio and raw sensor streams MUST NOT leave the device. Only VAD-trimmed
//   derived features and anonymized payloads cross this boundary.
//   Regulators: HK PDPO, 澳门个人数据保护法 (Macao PDPA), 个人信息保护法 (PIPL).
//   Payloads tagged with a pseudonymous DeviceId only — never a real device id.
//
// Wiring: the six non-LLM routes below hit the FastAPI backend (see ../../backend).
// Point the app at it with NEXT_PUBLIC_API_BASE (default http://localhost:8000).
// The three LLM routes — assistantChat / getAgentCards / getMedicationPlan — are
// intentionally left blank (the backend also answers 501), so the app keeps its
// instant local fallback: an unreachable/absent agent never blocks the senior.

import type {
  GaitWindow,
  ScreeningSession,
  SosEvent,
  HealthCard,
  Locale,
  AgentCard,
  AgentIntentRequest,
  TelemetryEvent,
  ConversationTurn,
  MedicationPlan,
  MedicationPlanRequest,
} from "./types";

export interface AssistantMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AssistantChatRequest {
  messages: AssistantMessage[];
  locale: Locale;
}

export interface AssistantChatResponse {
  reply: string;
}

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000").replace(/\/+$/, "");
// Short by design: these calls are fire-and-forget (analytics flush, memory
// write), so a slow/absent backend must never stall the interaction.
const TIMEOUT_MS = 4000;

/** Stable pseudonymous device id kept in localStorage. NEVER a real device id. */
function deviceId(): string {
  if (typeof window === "undefined") return "ssr";
  const KEY = "auragba.deviceId";
  let id = window.localStorage.getItem(KEY);
  if (!id) {
    id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(KEY, id);
  }
  return id;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": deviceId(),
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${path}`);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** POST /gait/windows — derived gait features only. */
export async function postGaitWindow(w: GaitWindow): Promise<void> {
  await request<void>("/gait/windows", { method: "POST", body: JSON.stringify(w) });
}

/** POST /screening/sessions — VAD-trimmed derived features only (no raw audio). */
export async function postScreeningSession(s: ScreeningSession): Promise<void> {
  await request<void>("/screening/sessions", { method: "POST", body: JSON.stringify(s) });
}

/** POST /sos — escalate to family / community carer. */
export async function postSos(e: SosEvent): Promise<void> {
  await request<void>("/sos", { method: "POST", body: JSON.stringify(e) });
}

/** GET /health-card/me — cross-border medication/health card. */
export async function getHealthCard(): Promise<HealthCard> {
  return request<HealthCard>("/health-card/me", { method: "GET" });
}

/**
 * POST /assistant/chat — LLM reply. Blank by design (backend answers 501):
 * the project keeps all LLM/paid-API integration unimplemented.
 */
export async function assistantChat(_req: AssistantChatRequest): Promise<AssistantChatResponse> {
  throw new Error("NOT_IMPLEMENTED: /assistant/chat");
}

/**
 * POST /agent/cards — the backend AGENT plans cards for a recognized intent.
 * Blank by design: the frontend treats any error as "no agent" and falls back to
 * localCardsFor() so the app still works offline.
 */
export async function getAgentCards(_req: AgentIntentRequest): Promise<AgentCard[]> {
  throw new Error("NOT_IMPLEMENTED: /agent/cards");
}

/** POST /telemetry/events — batched COARSE events only. No free text / audio / PII. */
export async function postTelemetry(events: TelemetryEvent[]): Promise<void> {
  await request<void>("/telemetry/events", { method: "POST", body: JSON.stringify(events) });
}

/**
 * POST /conversation/turns — persist one conversation turn so the agent can learn
 * the senior's habits and derive reminders later. Text only; the app keeps the
 * same turn locally in the `conversation` IndexedDB store first, so a failed POST
 * never loses memory.
 */
export async function postConversationMemory(turn: ConversationTurn): Promise<void> {
  await request<void>("/conversation/turns", { method: "POST", body: JSON.stringify(turn) });
}

/**
 * POST /medication/plan — derive a medication plan from `history`, the senior's
 * profile, and/or the `utterance`. Blank by design (backend answers 501); the app
 * falls back to the local reminder when this throws.
 */
export async function getMedicationPlan(_req: MedicationPlanRequest): Promise<MedicationPlan> {
  throw new Error("NOT_IMPLEMENTED: /medication/plan");
}