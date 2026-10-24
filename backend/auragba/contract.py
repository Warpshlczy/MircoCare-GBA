"""Wire contract — the exact JSON shapes exchanged with the frontend.

These mirror `web/src/lib/types.ts` field-for-field (camelCase preserved) so the
FastAPI service is drop-in compatible with `web/src/lib/api.ts`. Models are
permissive (`extra="allow"`) so frontend payloads that add fields never 422.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Locale = Literal["zh-HK", "zh-MO", "zh-CN"]
# Mirrors `Intent` in web/src/lib/types.ts. The six agent-layer intents
# (navigate/call/alarm/message/repeat/cancel) must stay in sync, otherwise
# POST /agent/cards answers 422 before its own 501 fallback can run.
Intent = Literal[
    "weather", "medication", "tasks", "camera", "sos", "help", "tools",
    "followup", "note", "recall",
    "navigate", "call", "alarm", "message", "repeat", "cancel",
    "unknown",
]
CardKind = Literal[
    "task", "med", "weather", "camera", "info",
    # B's agent layer renders these; CardRenderer dispatches on data/html, not
    # kind. Missing values here would make FastAPI's response validation 500.
    "place", "alarm", "agentPlan",
]


class _Base(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)


# --------------------------------------------------------------------------- #
# Domain payloads (frontend -> backend)
# --------------------------------------------------------------------------- #
class GaitWindow(_Base):
    id: str
    startedAt: int
    endedAt: int
    steps: int
    cadence: float
    cv: float
    fall: bool
    fallReason: Literal["impact", "free-fall+impact"] | None = None


class ScreeningSession(_Base):
    """Derived features only — raw audio never leaves the device."""

    id: str
    startedAt: int
    durationMs: int
    speechRatio: float
    trimmedStartMs: int
    trimmedEndMs: int
    features: dict[str, float] = Field(default_factory=dict)
    # A's capture gate (`signal.ts#qualityOf`). `reject` is still uploaded so the
    # family report can say "N captures were unusable", but it never enters the
    # personal baseline; `fair` is kept (quiet rooms are the norm for seniors).
    quality: Literal["good", "fair", "reject"] | None = None
    snrDb: float | None = None


class SosEvent(_Base):
    id: str
    at: int
    locale: Locale
    reason: Literal["voice", "button", "fall"]
    confirmed: bool
    status: Literal["pending", "notified", "resolved"]
    # Which surface triggered it. A lock-screen widget press usually means the
    # senior could not unlock the phone, which is extra context for the family.
    source: Literal["app", "widget", "watch"] = "app"


class GeofenceEvent(_Base):
    """Crossing the home fence. A safety event, not a daily rollup — the time
    point matters, so it is stored per event id (outbox replay is idempotent)."""

    id: str
    at: int
    kind: Literal["exit", "enter"]
    distanceM: float = Field(ge=0)
    minutesAway: float | None = Field(default=None, ge=0)


class RegisterRequest(_Base):
    role: Literal["senior", "family"]


class RegisterResponse(_Base):
    accountId: str
    role: Literal["senior", "family"]
    token: str | None = None


class PairingCodeResponse(_Base):
    code: str
    expiresAt: int


class PairingRedeemRequest(_Base):
    code: str


class FamilyRelation(_Base):
    seniorAccountId: str
    seniorDeviceId: str
    boundAt: int


class EmergencyContact(_Base):
    name: str
    phone: str


class HealthCard(_Base):
    id: str
    name: str
    age: int
    bloodType: str
    allergies: list[str] = Field(default_factory=list)
    chronicConditions: list[str] = Field(default_factory=list)
    medications: list[str] = Field(default_factory=list)
    emergencyContact: EmergencyContact
    updatedAt: int


class TelemetryEvent(_Base):
    id: str
    name: str
    at: int
    locale: Locale
    props: dict[str, str | int | float | bool] | None = None


class ConversationTurn(_Base):
    id: str
    at: int
    role: Literal["user", "assistant"]
    text: str
    locale: Locale


class ReminderEscalation(_Base):
    """A reminder that timed out and reached the caregiver-escalation stage.

    Deliberately carries no medication name or free text: the family outbox only
    needs "this reminder was missed", not the senior's health details.
    """

    id: str
    at: int
    locale: Locale
    kind: Literal["med", "followup"] = "med"
    stage: Literal["notify-caregiver"] = "notify-caregiver"


class MedicationPlanItem(_Base):
    name: str
    dosage: str
    schedule: str


class MedicationPlan(_Base):
    items: list[MedicationPlanItem] = Field(default_factory=list)
    basis: Literal["history", "profile", "utterance", "mixed"] | None = None


class MedicationPlanRequest(_Base):
    locale: Locale
    utterance: str = ""
    history: list[ConversationTurn] = Field(default_factory=list)
    now: int


class CardRow(_Base):
    label: str
    value: str


class CardChecklistItem(_Base):
    id: str
    text: str
    done: bool


class CardData(_Base):
    headline: str | None = None
    icon: str | None = None
    image: str | None = None
    rows: list[CardRow] | None = None
    checklist: list[CardChecklistItem] | None = None


class CardAction(_Base):
    id: str
    label: str
    intent: Intent


class AgentCard(_Base):
    id: str
    kind: CardKind
    title: str
    createdAt: int
    data: CardData | None = None
    html: str | None = None
    actions: list[CardAction] | None = None


class AgentIntentRequest(_Base):
    intent: Intent
    utterance: str
    locale: Locale
    now: int


# --------------------------------------------------------------------------- #
# Agent turn (B ↔ C) — tool-calling contract.
# Mirrors AgentTurnRequest/Response in web/src/lib/types.ts. `tools` accepts both
# the flat `{name, description, schema}` shape and the OpenAI wrapper emitted by
# `openAiTools()` (`{type:"function", function:{name, description, parameters}}`).
# --------------------------------------------------------------------------- #
class AgentTool(_Base):
    name: str | None = None
    description: str = ""
    schema_: dict[str, Any] | None = Field(default=None, alias="schema")
    type: str | None = None
    function: dict[str, Any] | None = None

    def normalized(self) -> tuple[str, str, dict[str, Any]]:
        """-> (name, description, JSON schema) for either accepted shape."""
        if isinstance(self.function, dict):
            return (
                str(self.function.get("name") or ""),
                str(self.function.get("description") or ""),
                dict(self.function.get("parameters") or {}),
            )
        return self.name or "", self.description, dict(self.schema_ or {})


class AgentHistoryTurn(_Base):
    role: Literal["user", "assistant"]
    text: str


class AgentOpenTask(_Base):
    id: str
    text: str
    dueAt: int | None = None


class AgentTurnContext(_Base):
    recentTurns: list[AgentHistoryTurn] = Field(default_factory=list)
    openTasks: list[AgentOpenTask] = Field(default_factory=list)
    riskBand: Literal["low", "watch", "elevated"] | None = None


class AgentTurnRequest(_Base):
    utterance: str
    locale: Locale
    now: int
    context: AgentTurnContext = Field(default_factory=AgentTurnContext)
    tools: list[AgentTool] = Field(default_factory=list)


class ToolCall(_Base):
    name: str
    args: dict[str, Any] = Field(default_factory=dict)


class NeedsConfirm(_Base):
    """Index-based, not name-based: the client confirms `calls[callIndex]`."""

    callIndex: int
    question: str


class AgentTurnResponse(_Base):
    reply: str
    calls: list[ToolCall] = Field(default_factory=list)
    cards: list[AgentCard] = Field(default_factory=list)
    needsConfirm: NeedsConfirm | None = None


# --------------------------------------------------------------------------- #
# Behaviour stream (B -> C). Mirrors BehaviourDaily / CircadianDaily /
# DigitalSkillDaily in web/src/lib/types.ts. `null` means "not measured" and is
# preserved end-to-end — C must never turn it into 0 (a senior without the usage
# permission would otherwise look like "0 app switches = decline").
# --------------------------------------------------------------------------- #
_DAY = r"^\d{4}-\d{2}-\d{2}$"


class BehaviourDaily(_Base):
    id: str
    day: str = Field(pattern=_DAY)
    # null = no reminder was due that day / no gait window that day.
    taskConfirmDelayMin: float | None = Field(default=None, ge=0)
    taskTimeoutRate: float | None = Field(default=None, ge=0, le=1)
    taskCompletionRate: float | None = Field(default=None, ge=0, le=1)
    deferCount: int = Field(default=0, ge=0)
    interactionCount: int = Field(default=0, ge=0)
    gaitCv: float | None = Field(default=None, ge=0)
    # null = gait was not measured that day. Old uploaders send 0 even when
    # `gaitCv` is null, so the validator below normalises that ambiguity.
    fallEvents: int | None = Field(default=None, ge=0)
    # Report-only proxies (A's interview/hearing-vision capture). They are shown
    # in the weekly "activity" section and never enter the behaviour score.
    hearingProxy: float | None = Field(default=None, ge=0)
    visionProxy: float | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def _unmeasured_falls(self) -> "BehaviourDaily":
        # No gait window => "0 falls" is not a reading, it is a missing value.
        if self.gaitCv is None and self.fallEvents == 0:
            self.fallEvents = None
        return self


class CircadianDaily(_Base):
    """Screen/unlock/charging rollup — no runtime permission required."""

    id: str
    day: str = Field(pattern=_DAY)
    firstActiveAt: int
    lastActiveAt: int
    nightWakeCount: int = Field(default=0, ge=0)
    chargingHours: float = Field(default=0.0, ge=0, le=24)


class DigitalSkillDaily(_Base):
    """Usage-stats proxy. Every field is nullable; the whole row is omitted when
    PACKAGE_USAGE_STATS is not granted."""

    id: str
    day: str = Field(pattern=_DAY)
    appSwitchCount: int | None = Field(default=None, ge=0)
    opFailRate: float | None = Field(default=None, ge=0, le=1)
    firstTouchDelayMs: float | None = Field(default=None, ge=0)


class BehaviourDailyEnvelope(_Base):
    """Payload of POST /behaviour/daily — the two optional rows are omitted, not
    filled with nulls, when their permission/source is unavailable."""

    behaviour: BehaviourDaily
    circadian: CircadianDaily | None = None
    digitalSkill: DigitalSkillDaily | None = None


class TaskEvent(_Base):
    """One task state transition from the device.

    Mirrors `TaskEvent` in web/src/lib/types.ts (B confirmed the same field names
    and enums). Deliberately ids/states only — the task text never leaves the
    device.
    """

    id: str
    taskId: str
    state: Literal["created", "completed", "deferred", "timeout"]
    at: int
    source: Literal["voice", "reminder", "followup", "agent"]
    dueAt: int | None = None
    doneAt: int | None = None


class AssistantMessage(_Base):
    role: Literal["system", "user", "assistant"]
    content: str


class AssistantChatRequest(_Base):
    messages: list[AssistantMessage]
    locale: Locale


class AssistantChatResponse(_Base):
    reply: str


# --------------------------------------------------------------------------- #
# Weekly family report (C4) — six fixed sections, no diagnostic words.
# --------------------------------------------------------------------------- #
class ReportCount(_Base):
    label: str
    value: str
    delta: str | None = None  # e.g. "+2 较上周"


class ReportEvidence(_Base):
    """Why a "change" item is on the page — traceable feature / z / samples."""

    feature: str
    z: float
    samples: int
    windowDays: int
    direction: Literal["high", "low", "normal"]
    changepointAt: int | None = None
    sustained: bool = False


class ReportSection(_Base):
    key: Literal["talk", "change", "tasks", "activity", "advice", "privacy"]
    title: str
    summary: str
    counts: list[ReportCount] = Field(default_factory=list)
    evidence: list[ReportEvidence] = Field(default_factory=list)
    available: bool = True
    note: str | None = None


class WeeklyReport(_Base):
    deviceId: str
    locale: Locale
    periodStart: int
    periodEnd: int
    generatedAt: int
    sections: list[ReportSection]
    disclaimer: str
    claimLevel: str = "observation"
    notForDiagnosis: bool = True


# --------------------------------------------------------------------------- #
# Screening engine payloads (backend -> frontend, and internal)
# --------------------------------------------------------------------------- #
class BiomarkerContribution(_Base):
    """One interpretable feature's pull on a stream score (research: results must
    decompose into the families that produced them)."""

    name: str
    value: float
    weight: float
    contribution: float
    direction: Literal["risk", "protective"]


class StreamScore(_Base):
    stream: Literal["acoustic", "semantic", "behavior"]
    score: float  # 0..1, higher = more atypical
    model: str
    contributions: list[BiomarkerContribution] = Field(default_factory=list)


class ChangePoint(_Base):
    """A sustained level shift found by CUSUM — not a one-off spike."""

    feature: str
    at: int | None = None
    direction: Literal["high", "low"]


class MetricZScore(_Base):
    name: str
    value: float
    baselineMean: float
    baselineStd: float
    # Robust centre/scale are what the Z is actually computed against; the classic
    # mean/std above are retained so reviewers can see both.
    baselineMedian: float = 0.0
    baselineScale: float = 0.0
    z: float
    direction: Literal["high", "low", "normal"]
    flag: Literal["normal", "watch", "elevated"]
    trend: float = 0.0  # feature units per week over the trend window
    changepointAt: int | None = None
    sustained: bool = False  # >= 3 same-direction deviations


class BaselineReport(_Base):
    deviceId: str
    windowDays: int
    samples: int
    sufficient: bool
    metrics: list[MetricZScore] = Field(default_factory=list)
    changepoints: list[ChangePoint] = Field(default_factory=list)
    note: str | None = None


class ValuationEffect(_Base):
    qalyGained: float
    costSavedPerPatient: float
    currency: str
    horizonYears: float
    assumptions: dict[str, float] = Field(default_factory=dict)
    disclaimer: str


class AuditRef(_Base):
    seq: int
    hash: str


class ScreeningResult(_Base):
    id: str
    at: int
    locale: Locale
    privacyMode: str
    audioDiscarded: bool
    durationMs: float
    speechRatio: float
    acousticFeatures: dict[str, float]
    acousticSummary: dict[str, float]
    asr: dict[str, Any]
    linguisticMetrics: dict[str, float]
    coherence: float
    acousticStream: StreamScore
    semanticStream: StreamScore | None = None
    behaviorStream: StreamScore | None = None
    riskIndex: float
    riskBand: Literal["low", "watch", "elevated"]
    fusionWeights: dict[str, float]
    insufficientStreams: bool = False
    # Same capture gate A applies on device (`signal.ts#qualityOf`). `reject`
    # results are still returned — the caller must know why a sample should not
    # be trusted — but never enter the personal baseline.
    quality: Literal["good", "fair", "reject"] | None = None
    snrDb: float | None = None
    baseline: BaselineReport | None = None
    changepoints: list[ChangePoint] = Field(default_factory=list)
    economics: ValuationEffect | None = None
    engineVersion: str
    featureSetVersion: str
    notForDiagnosis: bool = True
    audit: AuditRef