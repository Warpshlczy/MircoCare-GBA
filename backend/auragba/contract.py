"""Wire contract — the exact JSON shapes exchanged with the frontend.

These mirror `web/src/lib/types.ts` field-for-field (camelCase preserved) so the
FastAPI service is drop-in compatible with `web/src/lib/api.ts`. Models are
permissive (`extra="allow"`) so frontend payloads that add fields never 422.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Locale = Literal["zh-HK", "zh-MO", "zh-CN"]
Intent = Literal["weather", "medication", "tasks", "camera", "sos", "help", "tools", "unknown"]
CardKind = Literal["task", "med", "weather", "camera", "info"]


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


class SosEvent(_Base):
    id: str
    at: int
    locale: Locale
    reason: Literal["voice", "button", "fall"]
    confirmed: bool
    status: Literal["pending", "notified", "resolved"]


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


class AssistantMessage(_Base):
    role: Literal["system", "user", "assistant"]
    content: str


class AssistantChatRequest(_Base):
    messages: list[AssistantMessage]
    locale: Locale


class AssistantChatResponse(_Base):
    reply: str


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
    stream: Literal["acoustic", "semantic"]
    score: float  # 0..1, higher = more atypical
    model: str
    contributions: list[BiomarkerContribution] = Field(default_factory=list)


class MetricZScore(_Base):
    name: str
    value: float
    baselineMean: float
    baselineStd: float
    z: float
    direction: Literal["high", "low", "normal"]
    flag: Literal["normal", "watch", "elevated"]


class BaselineReport(_Base):
    deviceId: str
    windowDays: int
    samples: int
    sufficient: bool
    metrics: list[MetricZScore] = Field(default_factory=list)
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
    riskIndex: float
    riskBand: Literal["low", "watch", "elevated"]
    fusionWeights: dict[str, float]
    baseline: BaselineReport | None = None
    economics: ValuationEffect | None = None
    engineVersion: str
    featureSetVersion: str
    notForDiagnosis: bool = True
    audit: AuditRef