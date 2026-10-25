"""Stream C — behaviour / task-adherence classifier.

Turns B's daily rollup (`POST /behaviour/daily`) into a 0..1 "atypicality" score
using hand-set rule weights, never a trained model: there is not enough labelled
behaviour data yet, and an opaque score here would not survive review.

Every feature is first z-scored against THIS senior's own history (median + MAD,
floored by a per-feature minimum scale). With fewer than three prior days the
feature falls back to an illustrative senior prior — the same honesty rule the
acoustic and semantic streams use, and the model label says which path ran.

`null` readings are skipped, never treated as 0: a senior who was never asked a
question that day must not look "perfectly compliant".

`ponytail:` linear rules over ten features, no interactions and no learning.
Upgrade: fit a small calibrated model once labelled outcomes exist, keeping the
same `StreamScore` contract.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from ..contract import BiomarkerContribution, StreamScore
from ..store import Store
from ..timeutil import day_key

DAY_MS = 86_400_000
_BIAS = -0.30
_MIN_PERSONAL_SAMPLES = 3


@dataclass(frozen=True)
class _Feature:
    key: str
    weight: float  # signed: + raises risk, - is protective
    norm_median: float  # illustrative prior used before personal history exists
    min_scale: float  # floor so a near-constant history cannot divide by ~0


# Order matters only for readability of the contributions list.
_FEATURES: tuple[_Feature, ...] = (
    _Feature("task_confirm_delay_min", +0.30, 2.0, 2.0),
    _Feature("task_timeout_rate", +0.30, 0.05, 0.05),
    _Feature("task_completion_rate", -0.25, 0.90, 0.05),
    _Feature("defer_count", +0.15, 0.3, 0.5),
    _Feature("interaction_count", -0.20, 6.0, 2.0),
    _Feature("gait_cv", +0.15, 0.05, 0.02),
    _Feature("fall_events", +0.40, 0.0, 1.0),
    _Feature("night_wake_count", +0.10, 0.5, 1.0),
    _Feature("app_switch_count", +0.08, 20.0, 5.0),
    _Feature("op_fail_rate", +0.12, 0.05, 0.03),
)


def _day(ms: int) -> str:
    return day_key(ms)


def neutral_score() -> float:
    """Score when every feature sits at its illustrative prior median.

    Used by the fusion layer to transfer the calibrated two-stream thresholds
    onto the three-stream scale without labelled behaviour data.
    """
    return 1.0 / (1.0 + math.exp(-_BIAS))


def flatten(envelope: dict[str, Any]) -> dict[str, float | None]:
    """One stored envelope -> the flat feature bag the scorer accepts."""
    behaviour = envelope.get("behaviour") or {}
    circadian = envelope.get("circadian") or {}
    digital = envelope.get("digitalSkill") or {}
    return {
        "task_confirm_delay_min": behaviour.get("taskConfirmDelayMin"),
        "task_timeout_rate": behaviour.get("taskTimeoutRate"),
        "task_completion_rate": behaviour.get("taskCompletionRate"),
        "defer_count": behaviour.get("deferCount"),
        "interaction_count": behaviour.get("interactionCount"),
        "gait_cv": behaviour.get("gaitCv"),
        "fall_events": behaviour.get("fallEvents"),
        "night_wake_count": circadian.get("nightWakeCount") if circadian else None,
        "app_switch_count": digital.get("appSwitchCount") if digital else None,
        "op_fail_rate": digital.get("opFailRate") if digital else None,
    }


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def _centre_and_scale(feature: _Feature, history: list[dict[str, float | None]]) -> tuple[float, float, bool]:
    values = sorted(float(h[feature.key]) for h in history if _is_number(h.get(feature.key)))
    if len(values) < _MIN_PERSONAL_SAMPLES:
        return feature.norm_median, feature.min_scale, False
    median = values[len(values) // 2] if len(values) % 2 else (values[len(values) // 2 - 1] + values[len(values) // 2]) / 2
    deviations = sorted(abs(value - median) for value in values)
    mid = len(deviations) // 2
    mad = deviations[mid] if len(deviations) % 2 else (deviations[mid - 1] + deviations[mid]) / 2
    return median, max(1.4826 * mad, feature.min_scale), True


def score_behavior(
    today: dict[str, float | None],
    history: list[dict[str, float | None]] | None = None,
) -> StreamScore | None:
    """-> StreamScore over whatever readings exist today, or None when nothing
    measurable was reported (no rollup / every field null)."""
    history = history or []
    usable = [feature for feature in _FEATURES if _is_number(today.get(feature.key))]
    if not usable:
        return None

    contributions: list[BiomarkerContribution] = []
    total = _BIAS
    personal = False
    for feature in usable:
        centre, scale, used_history = _centre_and_scale(feature, history)
        personal = personal or used_history
        value = float(today[feature.key])  # type: ignore[arg-type]
        z = (value - centre) / scale
        contribution = feature.weight * z
        total += contribution
        contributions.append(
            BiomarkerContribution(
                name=feature.key,
                value=value,
                weight=feature.weight,
                contribution=contribution,
                direction="risk" if contribution > 0 else "protective",
            )
        )

    contributions.sort(key=lambda item: -abs(item.contribution))
    score = 1.0 / (1.0 + math.exp(-max(-60.0, min(60.0, total))))
    return StreamScore(
        stream="behavior",
        score=score,
        model="rules-personal" if personal else "rules-illustrative",
        contributions=contributions[:8],
    )


def load_stream(
    store: Store, device_id: str, *, now_ms: int, days: int = 14
) -> StreamScore | None:
    """Read the latest stored daily rollup plus its history and score it.

    The newest available day is treated as "today" because the client writes the
    rollup at end of day; a screening run earlier in the day legitimately sees
    yesterday as the latest row.
    """
    envelopes: list[dict[str, Any]] = []
    for offset in range(max(1, days)):
        document = store.get_doc(device_id, f"behaviour:{_day(now_ms - offset * DAY_MS)}")
        if document:
            envelopes.append(document)
    if not envelopes:
        return None
    envelopes.reverse()  # oldest -> newest
    return score_behavior(flatten(envelopes[-1]), [flatten(item) for item in envelopes[:-1]])
