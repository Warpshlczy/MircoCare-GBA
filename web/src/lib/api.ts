// api.ts — authenticated backend endpoints for the AuraGBA apps.

import type {
  GaitWindow, ScreeningSession, SosEvent, HealthCard, Locale, AgentCard,
  AgentIntentRequest, TelemetryEvent, ConversationTurn, MedicationPlan,
  MedicationPlanRequest, ReminderKind,
} from "./types";

export interface AssistantMessage { role: "system" | "user" | "assistant"; content: string; }
export interface AssistantChatRequest { messages: AssistantMessage[]; locale: Locale; }
export interface AssistantChatResponse { reply: string; }

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000").replace(/\/+$/, "");
const TIMEOUT_MS = 4000;

function deviceId(): string {
  if (typeof window === "undefined") return "ssr";
  const key = "auragba.deviceId";
  let id = window.localStorage.getItem(key);
  if (!id) {
    id = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `dev-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(key, id);
  }
  return id;
}

export type AccountRole = "senior" | "family";
export interface Session { accountId: string; role: AccountRole; }

async function register(role: AccountRole): Promise<Session> {
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Device-Id": deviceId() },
    body: JSON.stringify({ role }),
    credentials: "include",
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ /auth/register`);
  return (await res.json()) as Session;
}

/** Reads the current HttpOnly session (or null when there is none). */
export async function getSession(): Promise<Session | null> {
  if (typeof window === "undefined") return null;
  try {
    const res = await fetch(`${API_BASE}/auth/me`, {
      headers: { "X-Device-Id": deviceId() },
      credentials: "include",
    });
    if (!res.ok) return null;
    return (await res.json()) as Session;
  } catch {
    return null;
  }
}

let seniorSession: Promise<void> | null = null;

/**
 * Ensures the senior app has a session. Called once at boot, NOT from every
 * request: the caregiver page must be able to load with a family cookie (or no
 * cookie at all) without being silently re-registered as a senior.
 *
 * The backend registration is idempotent per (role, device), so reopening the
 * app reuses the same account instead of failing on a unique constraint.
 */
export function ensureSeniorSession(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (!seniorSession) {
    seniorSession = (async () => {
      const current = await getSession();
      if (current?.role === "senior") return;
      await register("senior");
    })();
    void seniorSession.catch(() => {
      seniorSession = null; // allow a retry on the next boot / gesture
    });
  }
  return seniorSession;
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
      credentials: "include",
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

export async function registerFamily(): Promise<Session> { return register("family"); }
export async function registerSenior(): Promise<Session> { return register("senior"); }
export async function createPairingCode(): Promise<{ code: string; expiresAt: number }> {
  return request("/auth/pairing-code", { method: "POST" });
}
export async function redeemPairingCode(code: string): Promise<{ seniorAccountId: string; seniorDeviceId: string; boundAt: number }> {
  return request("/auth/pair", { method: "POST", body: JSON.stringify({ code }) });
}

export interface CaregiverOverview {
  seniorDeviceId: string;
  healthCard: Partial<HealthCard> & { updatedAt?: number };
  riskTrend: { at: number; riskIndex?: number; riskBand?: string }[];
  screeningSessions?: { id?: string; at?: number; durationMs?: number; speechRatio?: number }[];
  activityTrend: { endedAt?: number; steps?: number; cadence?: number; fall?: boolean }[];
  alerts: { id?: string; at?: number; reason?: string; status?: string }[];
  notifications: { id?: string; kind?: string; status?: string; createdAt?: number }[];
}
export async function getCaregiverOverview(): Promise<CaregiverOverview> {
  return request("/caregiver/overview", { method: "GET" });
}
export async function acknowledgeSos(sosId: string, seniorDeviceId: string): Promise<void> {
  await request(`/caregiver/sos/${encodeURIComponent(sosId)}/ack?senior_device_id=${encodeURIComponent(seniorDeviceId)}`, { method: "POST" });
}

export async function postGaitWindow(w: GaitWindow): Promise<void> {
  await request<void>("/gait/windows", { method: "POST", body: JSON.stringify(w) });
}
export async function postScreeningSession(s: ScreeningSession): Promise<void> {
  await request<void>("/screening/sessions", { method: "POST", body: JSON.stringify(s) });
}
export async function postSos(e: SosEvent): Promise<void> {
  await request<void>("/sos", { method: "POST", body: JSON.stringify(e) });
}
export async function getHealthCard(): Promise<HealthCard> {
  return request("/health-card/me", { method: "GET" });
}
export async function assistantChat(_req: AssistantChatRequest): Promise<AssistantChatResponse> {
  throw new Error("NOT_IMPLEMENTED: /assistant/chat");
}
export async function getAgentCards(_req: AgentIntentRequest): Promise<AgentCard[]> {
  throw new Error("NOT_IMPLEMENTED: /agent/cards");
}
export async function postTelemetry(events: TelemetryEvent[]): Promise<void> {
  await request<void>("/telemetry/events", { method: "POST", body: JSON.stringify(events) });
}
export async function postConversationMemory(turn: ConversationTurn): Promise<void> {
  await request<void>("/conversation/turns", { method: "POST", body: JSON.stringify(turn) });
}
/** Coarse reminder-timeout event: no medication name or free text crosses the boundary. */
export interface ReminderEscalation {
  id: string;
  at: number;
  locale: Locale;
  kind: ReminderKind;
  stage: "notify-caregiver";
}
export async function postReminderEscalation(e: ReminderEscalation): Promise<void> {
  await request<void>("/reminders/escalate", { method: "POST", body: JSON.stringify(e) });
}
export async function getMedicationPlan(_req: MedicationPlanRequest): Promise<MedicationPlan> {
  throw new Error("NOT_IMPLEMENTED: /medication/plan");
}
