// Shared domain types for AuraGBA. No runtime logic lives here.

export type Locale = "zh-HK" | "zh-MO" | "zh-CN";

/** Opaque random pseudonymous id. NEVER a real device identifier (no IDFA/AAID/IMEI/MAC). */
export type DeviceId = string;

export type AssistantState = "idle" | "listening" | "thinking" | "speaking" | "confirming";

export interface MedItem {
  id: string;
  name: string;
  dosage: string;
  /** "碰一碰打卡" NFC tag text written onto the box/tag. */
  nfcTag?: string;
}

export type ReminderKind = "med" | "followup";
export type ReminderStatus = "pending" | "taken" | "missed" | "escalated";

export interface ReminderItem {
  id: string;
  kind: ReminderKind;
  med?: MedItem;
  title: string;
  dueAt: number; // epoch ms
  status: ReminderStatus;
  /** escalation stage already applied, so the state machine is idempotent. */
  stage: "none" | "retry" | "notify-caregiver";
  createdAt: number;
}

/** A private, on-device memory note ("remember the keys are in the drawer"). */
export interface Note {
  id: string;
  at: number;
  text: string;
  locale: Locale;
}

export interface AccelSample {
  t: number; // epoch ms
  ax: number;
  ay: number;
  az: number;
}

export interface GaitWindow {
  id: string;
  startedAt: number;
  endedAt: number;
  steps: number;
  cadence: number; // steps/min
  cv: number; // coefficient of variation of inter-step intervals
  fall: boolean;
  fallReason?: "impact" | "free-fall+impact";
}

/** Derived features only. Raw audio never leaves the device. */
export interface ScreeningSession {
  id: string;
  startedAt: number;
  durationMs: number;
  speechRatio: number;
  trimmedStartMs: number;
  trimmedEndMs: number;
  /** placeholder acoustic features, filled by backend later */
  features: Record<string, number>;
}

export interface SosEvent {
  id: string;
  at: number;
  locale: Locale;
  reason: "voice" | "button" | "fall";
  confirmed: boolean;
  status: "pending" | "notified" | "resolved";
}

export interface HealthCard {
  id: string;
  name: string;
  age: number;
  bloodType: string;
  allergies: string[];
  chronicConditions: string[];
  medications: string[];
  emergencyContact: { name: string; phone: string };
  updatedAt: number;
}

export interface GaitMonitorState {
  running: boolean;
  lastWindow: GaitWindow | null;
  permission: "granted" | "denied" | "unknown" | "unsupported";
}

// ---------------------------------------------------------------------------
// Voice wake word. The assistant hibernates ("sleeping") until the senior calls
// the wake name, then becomes "awake" and interacts, then sleeps again.
// ---------------------------------------------------------------------------
export type ActivityState = "sleeping" | "awake";

// ---------------------------------------------------------------------------
// Agent-driven cards. The app is a generic card RENDERER; the "brain" is an
// agent (local heuristics today, backend LLM later) that decides what to show.
// A card is EITHER frontend-rendered structured data (`data`) OR backend-rendered
// HTML (`html`) — mutually exclusive.
// ---------------------------------------------------------------------------
export type CardKind = "task" | "med" | "weather" | "camera" | "info";

export interface CardRow {
  label: string;
  value: string;
}
export interface CardChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

/** Structured payload the FRONTEND renders. No HTML, no scripts. */
export interface CardData {
  headline?: string; // one huge value, e.g. "27°C 天晴"
  icon?: string; // single glyph/emoji
  image?: string; // data URL (camera capture)
  rows?: CardRow[];
  checklist?: CardChecklistItem[];
}

export interface CardAction {
  id: string;
  label: string;
  intent: Intent;
}

export interface AgentCard {
  id: string;
  kind: CardKind;
  title: string;
  createdAt: number;
  /** frontend-rendered structured data — mutually exclusive with `html` */
  data?: CardData;
  /**
   * backend-agent-rendered HTML. Rendered inside a SCRIPT-DISABLED sandboxed
   * iframe (see CardRenderer). Only one of `data` | `html` is set.
   */
  html?: string;
  actions?: CardAction[];
}

/** What the agent is asked to plan cards for. */
export interface AgentIntentRequest {
  intent: Intent;
  utterance: string;
  locale: Locale;
  now: number;
}

// ---------------------------------------------------------------------------
// Intent parsing (pure, testable) + privacy-first telemetry
// ---------------------------------------------------------------------------
export type Intent = "weather" | "medication" | "tasks" | "camera" | "sos" | "help" | "tools" | "followup" | "note" | "recall" | "unknown";

export interface TelemetryEvent {
  id: string;
  name: string;
  at: number;
  locale: Locale;
  /** coarse, non-identifying props only — never free text, audio or PII */
  props?: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// Conversation memory + medication generation. Turns are kept locally so the
// backend agent can derive reminders from what the senior actually said.
// ---------------------------------------------------------------------------
export interface ConversationTurn {
  id: string;
  at: number;
  role: "user" | "assistant";
  text: string;
  locale: Locale;
}

export interface MedicationPlan {
  items: { name: string; dosage: string; schedule: string }[];
  /** where the plan came from, for the UI / audit */
  basis?: "history" | "profile" | "utterance" | "mixed";
}

/** What the backend is asked to derive a medication plan from. */
export interface MedicationPlanRequest {
  locale: Locale;
  /** the senior's own words, when they asked by voice/text (may be empty) */
  utterance: string;
  /** recent local conversation memory — lets the agent learn from what was said */
  history: ConversationTurn[];
  now: number;
}