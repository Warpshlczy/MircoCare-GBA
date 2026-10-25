// Shared domain types for MemoMate. No runtime logic lives here.

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
  /** A's capture gate (signal.ts#qualityOf). `reject` is still uploaded; the
   *  backend keeps it out of the baseline (issue #3). */
  quality?: "good" | "fair" | "reject";
  /** Frame-energy P90 − P10 before trimming, dB. */
  snrDb?: number;
}

export interface SosEvent {
  id: string;
  at: number;
  locale: Locale;
  reason: "voice" | "button" | "fall";
  confirmed: boolean;
  status: "pending" | "notified" | "resolved";
  /**
   * Where the button was physically reached from. `widget` = the lock-screen
   * home widget, which needs no unlock — the caregiver should read that as
   * "he may not have been able to unlock". Optional: the backend model uses
   * `extra="allow"`, so sending it before C adds the field is safe.
   */
  source?: "app" | "widget" | "watch";
}

/**
 * 202 body of POST /sos (backend contract_routes.py:96). `notified` is empty
 * when no family account is bound — the UI must then say "recorded", never
 * "notified", because `delivered` is always false in the MVP.
 */
export interface SosAck {
  id: string;
  notified: string[];
  channel: "outbox";
  delivered: boolean;
}

/**
 * One crossing of the home fence (mirrors `GeofenceEvent` in contract.py:82).
 * Event-shaped, not a daily rollup: the time point IS the signal, so the backend
 * stores one doc per id and a replay overwrites instead of counting twice.
 * Deliberately carries no coordinate — distance from home is all the family
 * needs to act, and a trail of positions is the highest-risk data we could keep.
 *
 * EVERY outing produces ONE `exit` row and ONE `enter` row. That is a deliberate
 * change (issue #2 §2.2, C's `alert` field): the weekly report counts outings,
 * and an outing the family was never paged about is still evidence about how
 * much the person goes out — which is one of the earliest things that changes in
 * Alzheimer's. Suppressing those rows would report "0 outings" for a person who
 * goes to the market every morning.
 */
export interface GeofenceEvent {
  id: string;
  /**
   * When he crossed the fence. For an `exit` this is the DEPARTURE time, not the
   * moment the family was paged (that can be an hour later): the weekly report
   * buckets by `at`, and a trip that straddles midnight must land on the day he
   * left. The id is derived from it too (`gf-exit-<departure>`), so the silent
   * row and the escalated row are the same row on the server.
   */
  at: number;
  kind: "exit" | "enter";
  /** Rough distance from home at the moment this row was reported. */
  distanceM: number;
  /**
   * Set on `enter` ONLY — how long that outing lasted.
   *
   * EVERY outing now gets a duration, because the matching `exit` is always
   * emitted (silently) at departure. An `exit` still cannot carry it: at
   * departure the trip has not finished, and the escalated copy is written
   * before he is back.
   */
  minutesAway?: number;
  /**
   * Whether this crossing should page the family. `false` = stored for the
   * weekly report, nobody is woken up. Only absences past `awayAlertMs`
   * (60 min) escalate to `true`, and the escalation reuses the same id so the
   * server replaces the row instead of counting a second outing.
   *
   * Missing on payloads written by builds before this field existed; the server
   * defaults those to `true`, which is the old "only long absences exist"
   * behaviour. Never read it back from the outbox — it is write-only.
   */
  alert: boolean;
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
export type CardKind =
  | "task"
  | "med"
  | "weather"
  | "camera"
  | "info"
  // B (agent layer) adds three kinds; CardRenderer renders by `data`/`html`,
  // never by `kind`, so these need no renderer branch — only a card factory.
  | "place" // geofence / whereabouts ("你而家喺街市附近")
  | "alarm" // time-based ("聽日十點覆診")
  | "agentPlan"; // multi-step preview ("我準備做呢三件事")

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
// NOTE: this union is mirrored by `Intent = Literal[...]` in
// backend/auragba/contract.py:15. Adding a value here WITHOUT adding it there
// makes POST /agent/cards answer 422 for that intent (the client then falls
// back locally, so nothing crashes — but it logs an error on every utterance).
export type Intent =
  | "weather"
  | "medication"
  | "tasks"
  | "camera"
  | "sos"
  | "help"
  | "tools"
  | "followup"
  | "note"
  | "recall"
  // B (agent layer) intents — each maps to one tool in lib/tools.ts:
  | "navigate" // locate / navigate_home
  | "call" // call_contact
  | "alarm" // set_alarm
  | "message" // send_message
  | "repeat" // re-say the last sentence (no tool)
  | "cancel" // abort what is on screen (no tool)
  | "unknown";

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

// ---------------------------------------------------------------------------
// B (agent layer) — tasks, offline outbox, behaviour channels, /agent/turn.
// Everything below is a CONTRACT: `web/src/lib/tools.ts` declares the tool
// schemas, `backend/auragba/contract.py` mirrors these shapes. Change here
// first, then tell A and C (§0.2 of docs/dev.md).
// ---------------------------------------------------------------------------

/**
 * A local, on-device task. "Say anything → a task" and "我食咗药" both land
 * here. `doneAt - dueAt` is the confirm delay that feeds the behaviour stream.
 */
export interface Task {
  id: string;
  text: string;
  /** undefined = no deadline ("记住买药") */
  dueAt?: number;
  done: boolean;
  doneAt?: number;
  source: "voice" | "reminder" | "followup" | "agent";
  /** how many times the senior pushed it back — an executive-function signal */
  deferredCount: number;
  createdAt: number;
  /** set when the senior re-confirms within 30min of a previous confirmation */
  duplicateOf?: string;
}

/**
 * One task state transition, uploaded to POST /task/events (mirrors
 * `contract.py:319`). Deliberately minimal: ids and states only, NEVER the task
 * text — the text may carry names or a medication, and this row is the one
 * behavioural record that leaves the device per event rather than per day.
 */
export interface TaskEvent {
  id: string;
  taskId: string;
  state: "created" | "completed" | "deferred" | "timeout";
  at: number;
  /** who caused the transition — `agent` is the only non-human one */
  source: "voice" | "reminder" | "followup" | "agent";
  dueAt?: number;
  doneAt?: number;
}

export type OutboxKind =
  | "gait"
  | "screening"
  | "telemetry"
  | "sos"
  | "reminder"
  | "behaviour"
  | "taskEvent"
  | "conversation"
  /** geofence exit/enter — no backend route yet (issue #2), enqueue only in W4 */
  | "geofence";

/**
 * One entry in the offline replay queue. Replay is at-least-once, so every
 * consumer must de-duplicate by `payload.id` (the backend already does for
 * gait/screening/telemetry).
 */
export interface OutboxItem {
  id: string;
  kind: OutboxKind;
  payload: unknown;
  createdAt: number;
  attempts: number;
  /** epoch ms of the next allowed attempt (exponential backoff) */
  nextAttemptAt: number;
  /** last transport error, for the doctor page; never shown to the senior */
  lastError?: string;
}

/**
 * Daily behaviour rollup — the ONLY input C's behaviour stream accepts.
 * Missing readings are `null`, never 0: a senior without the usage-stats
 * permission must not look like "0 app switches" (that would read as decline).
 */
export interface BehaviourDaily {
  id: string;
  /** local date key "YYYY-MM-DD" */
  day: string;
  /** minutes from reminder dueAt to voice confirmation; null = no reminder due */
  taskConfirmDelayMin: number | null;
  /** 0..1 share of due tasks never confirmed; null = nothing was due */
  taskTimeoutRate: number | null;
  /** 0..1 share of tasks completed; null = no tasks at all */
  taskCompletionRate: number | null;
  deferCount: number;
  interactionCount: number;
  /** coefficient of variation of inter-step intervals; null = no gait window */
  gaitCv: number | null;
  /**
   * Falls counted from gait windows; null = gait was not measured that day.
   * Mirrors the backend (`contract.py` `fallEvents: int | None`): "0 falls" with
   * no window at all is a missing reading, not a zero, and C's validator
   * normalises the ambiguity anyway — we simply send the truth.
   */
  fallEvents: number | null;
  /**
   * Report-only proxies from the interview capture (contract.py:307). 0..1
   * shares, NOT a hearing test or a sight test: C shows them in the weekly
   * activity section with that caveat, and they never enter the risk score.
   */
  hearingProxy?: number | null;
  visionProxy?: number | null;
}

/** Screen/unlock/charging broadcast rollup. No permission required. */
export interface CircadianDaily {
  id: string;
  day: string;
  firstActiveAt: number;
  lastActiveAt: number;
  nightWakeCount: number;
  chargingHours: number;
}

/**
 * Digital-skill proxy. Every field is nullable: when PACKAGE_USAGE_STATS is
 * not granted the whole row is omitted (we never prompt the senior to grant it).
 */
export interface DigitalSkillDaily {
  id: string;
  day: string;
  appSwitchCount: number | null;
  opFailRate: number | null;
  firstTouchDelayMs: number | null;
}

/** One tool invocation the agent wants the device to perform. */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** Request to POST /agent/turn — the tool list is supplied by the client. */
export interface AgentTurnRequest {
  utterance: string;
  locale: Locale;
  now: number;
  context: {
    /** ≤10, oldest first */
    recentTurns: { role: "user" | "assistant"; text: string }[];
    openTasks: { id: string; text: string; dueAt?: number }[];
    riskBand?: "low" | "watch" | "elevated";
  };
  /** the 10 declarations from lib/tools.ts, in OpenAI function-calling shape */
  tools: { name: string; description: string; schema: unknown }[];
}

/** Response from POST /agent/turn. `calls` is capped at 3 by contract. */
export interface AgentTurnResponse {
  reply: string;
  calls: ToolCall[];
  cards: AgentCard[];
  /** present when a `confirm`-risk call needs a spoken yes/no first */
  needsConfirm?: { callIndex: number; question: string };
}