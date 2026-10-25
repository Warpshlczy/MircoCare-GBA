// api.ts — authenticated backend endpoints for the MemoMate apps.

import type {
  GaitWindow, ScreeningSession, SosEvent, SosAck, HealthCard, Locale, AgentCard,
  AgentIntentRequest, AgentTurnRequest, AgentTurnResponse, TelemetryEvent,
  ConversationTurn, MedicationPlan, MedicationPlanRequest, ReminderKind,
  BehaviourDaily, CircadianDaily, DigitalSkillDaily, TaskEvent, GeofenceEvent, Contact,
  HealthCardUpdate, RecordKind,
} from "./types";

export interface AssistantMessage { role: "system" | "user" | "assistant"; content: string; }
export interface AssistantChatRequest { messages: AssistantMessage[]; locale: Locale; }
export interface AssistantChatResponse { reply: string; }

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000").replace(/\/+$/, "");
const TIMEOUT_MS = 4000;
/** LLM calls are slower; the backend falls back to 501/502 if it cannot answer. */
const LLM_TIMEOUT_MS = 15000;
/** /health is a liveness probe: if it is slow, the backend is not ready for us. */
const PROBE_TIMEOUT_MS = 2500;

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Id": deviceId() },
      body: JSON.stringify({ role }),
      credentials: "include",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ /auth/register`);
    return (await res.json()) as Session;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads the current HttpOnly session (or null when there is none). */
export async function getSession(): Promise<Session | null> {
  if (typeof window === "undefined") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/auth/me`, {
      headers: { "X-Device-Id": deviceId() },
      credentials: "include",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as Session;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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

/** Backend-local Whisper transcription (the Android WebView has no Web Speech). */
export interface TranscribedUtterance {
  text: string;
  confidence: number;
  engine: string;
  available: boolean;
  durationMs: number;
}

/** WAV clip -> text. Audio is decoded in memory server-side and never stored. */
export async function transcribeAudio(blob: Blob, locale: Locale, timeoutMs = 30_000): Promise<TranscribedUtterance> {
  const form = new FormData();
  form.append("file", blob, "utterance.wav");
  form.append("locale", locale);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/asr/transcribe`, {
      method: "POST",
      headers: { "X-Device-Id": deviceId() }, // no Content-Type: the browser sets the multipart boundary
      body: form,
      credentials: "include",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ /asr/transcribe`);
    return (await res.json()) as TranscribedUtterance;
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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

export async function registerFamily(): Promise<Session> {
  const session = await register("family");
  seniorSession = null; // a family cookie replaced any senior session in this tab
  return session;
}
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
  riskTrend: {
    at: number;
    riskIndex?: number;
    riskBand?: string;
    insufficientStreams?: boolean;
    baselineSufficient?: boolean;
    quality?: "good" | "fair" | "reject";
    usedInBaseline?: boolean;
  }[];
  /** C's baseline-level flag; `null` means "unknown", never "sufficient". */
  sufficient?: boolean | null;
  /**
   * Interaction drop over uploaded (closed) days. `null` when fewer than 3
   * baseline days exist — see C's reply in issue #2 §4 for the exact rules:
   * `today` is the latest CLOSED day, `baselineMedian` excludes it, and
   * `deltaPct` is `null` when the median is 0.
   *
   * Phrase it with `care.ts#caregiverLineFromTrend()`; the BACKEND decides
   * whether it dropped, this client only says it.
   */
  interactionTrend?: {
    today: number;
    baselineMedian: number;
    deltaPct: number | null;
    decreased: boolean;
    samples: number;
  } | null;
  screeningSessions?: { id?: string; at?: number; durationMs?: number; speechRatio?: number }[];
  /**
   * Today's COARSE record counts reported by the senior device (issue #7).
   * Only `{day, kind, count, lastAt}` — never a medication name or a note.
   * A missing kind means "not reported", never zero.
   */
  recordsToday?: {
    day?: string;
    kinds?: Partial<
      Record<"med" | "alarm" | "measure" | "card", { count?: number; lastAt?: number }>
    >;
  };
  activityTrend: { endedAt?: number; steps?: number; cadence?: number; fall?: boolean }[];
  alerts: { id?: string; at?: number; reason?: string; status?: string }[];
  notifications: { id?: string; kind?: string; status?: string; createdAt?: number }[];
}
export async function getCaregiverOverview(): Promise<CaregiverOverview> {
  return request("/caregiver/overview", { method: "GET" });
}
/**
 * Replaces the callable contact list for the bound senior (family session only).
 *
 * Whole-table replace, not a patch: the caregiver screen owns the list, and a
 * merge endpoint would let two tabs silently disagree about who is callable.
 * Returns the normalised rows (phones without spaces/parentheses).
 */
export async function postCaregiverContacts(
  contacts: Contact[],
  seniorDeviceId?: string
): Promise<Contact[]> {
  const q = seniorDeviceId ? `?senior_device_id=${encodeURIComponent(seniorDeviceId)}` : "";
  return request<Contact[]>(`/caregiver/contacts${q}`, {
    method: "POST",
    body: JSON.stringify({ contacts }),
  });
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
/**
 * 202 — the escalation is queued, not delivered. Callers MUST branch on
 * `notified.length`: empty means no family account is bound yet, so the senior
 * may only be told "已记录", never "已通知家属".
 */
export async function postSos(e: SosEvent): Promise<SosAck> {
  return request<SosAck>("/sos", { method: "POST", body: JSON.stringify(e) });
}
export async function getHealthCard(): Promise<HealthCard> {
  return request("/health-card/me", { method: "GET" });
}

// ---------------------------------------------------------------------------
// Family-side health card administration (C, issue #2/#3 governance batch).
// All five are session-authenticated through `request()`; the 204s below are
// handled by its `res.status === 204` branch (api.ts:146) — no body to parse.
// The UI for these belongs to the caregiver page; this file is only the pipe.
// ---------------------------------------------------------------------------
export async function updateHealthCard(patch: HealthCardUpdate): Promise<HealthCard> {
  return request<HealthCard>("/caregiver/health-card", { method: "PUT", body: JSON.stringify(patch) });
}
export async function deleteHealthCard(): Promise<void> {
  await request<void>("/caregiver/health-card", { method: "DELETE" });
}
/** Drops one senior binding. 404 = already revoked; the caller treats both as done. */
export async function revokePairing(seniorDeviceId: string): Promise<void> {
  await request<void>(`/caregiver/pairing/${encodeURIComponent(seniorDeviceId)}`, { method: "DELETE" });
}
/**
 * Erases the account, its pairings and (for a senior) the device store — 204.
 * Local cleanup (which of the 10 IndexedDB stores to drop) is the caller's
 * decision; `localStorage["auragba.deviceId"]` must SURVIVE (dev.md:82:
 * changing it means a new device identity and a voided baseline).
 */
export async function deleteAccount(): Promise<void> {
  await request<void>("/auth/me", { method: "DELETE" });
}
/**
 * Weekly report PDF. Deliberately NOT `request()`: that helper JSON.parses the
 * body, which would explode on binary. Blob so the caller can either download
 * it or hand it to a viewer.
 */
export async function fetchWeeklyPdf(scope: "senior" | "caregiver"): Promise<Blob> {
  const path = weeklyPdfPath(scope);
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers: { "X-Device-Id": deviceId() },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${path}`);
  return res.blob();
}
/** Path choice as a pure function — selfcheck asserts the mapping in Node. */
export function weeklyPdfPath(scope: "senior" | "caregiver"): string {
  return scope === "senior" ? "/reports/weekly/me.pdf" : "/caregiver/reports/weekly.pdf";
}
export async function assistantChat(req: AssistantChatRequest): Promise<AssistantChatResponse> {
  return request<AssistantChatResponse>(
    "/assistant/chat",
    { method: "POST", body: JSON.stringify(req) },
    LLM_TIMEOUT_MS
  );
}
export async function getAgentCards(req: AgentIntentRequest): Promise<AgentCard[]> {
  return request<AgentCard[]>(
    "/agent/cards",
    { method: "POST", body: JSON.stringify(req) },
    LLM_TIMEOUT_MS
  );
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
export async function getMedicationPlan(req: MedicationPlanRequest): Promise<MedicationPlan> {
  return request<MedicationPlan>(
    "/medication/plan",
    { method: "POST", body: JSON.stringify(req) },
    LLM_TIMEOUT_MS
  );
}

// ---------------------------------------------------------------------------
// Service probe. `/health` needs no session — checked here so the agent bridge
// can answer "is the backend really planning, or is it echoing?" (see
// agent.ts#isLlmReady for why 200 alone proves nothing).
// ---------------------------------------------------------------------------
export interface HealthResponse {
  status: string;
  engineVersion?: string;
  featureSetVersion?: string;
  privacyMode?: string;
  /** "enabled" | "disabled-fallback" — the ONLY honest signal that a real planner is behind /agent/turn */
  llmIntegration?: string;
  /**
   * Target-population prevalence for PPV math (`AURA_DEPLOY_PREVALENCE`).
   * `null`/absent = unconfigured: riskExplain then emits qualitative notes
   * only and NEVER a PPV number (issue #3 §4). Non-null values are a modelling
   * assumption and must be labelled as such in the UI.
   */
  deployPrevalence?: number | null;
  weather?: string;
  notForDiagnosis?: boolean;
}

export async function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/health", { method: "GET" }, PROBE_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Agent turn + behaviour stream (B ↔ C, issue #2).
// The planner may call a model, so it gets the LLM timeout; the two ingest
// endpoints are plain 204 writes.
// ---------------------------------------------------------------------------

/**
 * One agent turn. The tool declarations travel with every request (the backend
 * holds no copy), which is what makes "the client cannot downgrade a tool's
 * risk" enforceable server-side.
 *
 * Throws on 422 (bad intent/enum), 429 (quota) and 5xx — callers must treat any
 * throw as "no answer" and fall back, never as "nothing to do".
 */
export async function postAgentTurn(req: AgentTurnRequest): Promise<AgentTurnResponse> {
  return request<AgentTurnResponse>(
    "/agent/turn",
    { method: "POST", body: JSON.stringify(req) },
    LLM_TIMEOUT_MS
  );
}

/** Daily rollup. 204. `circadian` / `digitalSkill` are OMITTED (not nulled) until W4. */
export async function postBehaviourDaily(body: {
  behaviour: BehaviourDaily;
  circadian?: CircadianDaily;
  digitalSkill?: DigitalSkillDaily;
}): Promise<void> {
  await request<void>("/behaviour/daily", { method: "POST", body: JSON.stringify(body) });
}

/** One task transition. 204, keyed by `event.id` server-side (safe to replay). */
export async function postTaskEvent(event: TaskEvent): Promise<void> {
  await request<void>("/task/events", { method: "POST", body: JSON.stringify(event) });
}

/**
 * Coarse daily record aggregate (issue #7, C's `POST /records/summary`).
 *
 * Four fields, no health text: the readable records (药名/备注/转写) never leave
 * the phone. Keyed server-side by (device, day, kind), so an outbox replay
 * replaces the aggregate instead of doubling it.
 */
export interface RecordSummaryBody {
  day: string;
  kind: RecordKind;
  count: number;
  lastAt?: number;
}

export async function postRecordSummary(body: RecordSummaryBody): Promise<void> {
  await request<void>("/records/summary", { method: "POST", body: JSON.stringify(body) });
}

/**
 * One fence crossing. 204, idempotent per `event.id`. The backend dispatches it
 * with `kind="geofence"`, i.e. the same channel as SOS but a different queue —
 * a visit to the market must never sit in the family's emergency list.
 */
export async function postGeofenceEvent(event: GeofenceEvent): Promise<void> {
  await request<void>("/geofence/events", { method: "POST", body: JSON.stringify(event) });
}
