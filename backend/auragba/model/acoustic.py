"""Stream A — acoustic classifier.

Prefers a fitted LightGBM/XGBoost model when one is supplied (AURA_ACOUSTIC_MODEL);
otherwise falls back to an **interpretable additive logistic model** over
z-scored acoustic biomarkers. Each feature's pull on the score is returned so the
result decomposes into the features that produced it (a design requirement from
the research: interpretable by construction, never a black box).

`ponytail:` the fallback weights and reference norms are ILLUSTRATIVE priors
drawn from the connected-speech literature (eGeMAPS perturbation/rate/pause
markers), NOT clinically fitted parameters. The engine is explicitly
not-for-diagnosis. Upgrade: fit weights on a labelled cohort (DementiaBank /
ADReSS) and load them via the env path — the contract does not change.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

import numpy as np

from ..contract import BiomarkerContribution, StreamScore

# (name -> (population mean, population std)) — illustrative senior norms.
ACOUSTIC_NORMS: dict[str, tuple[float, float]] = {
    "jitter_local": (0.010, 0.006),
    "shimmer_local": (0.055, 0.025),
    "hnr_db": (12.0, 6.0),
    "f0_cv": (0.14, 0.06),
    "articulation_rate": (5.2, 1.2),
    "speech_rate": (3.6, 1.0),
    "pause_ratio": (0.35, 0.15),
    "mean_pause_s": (0.45, 0.25),
    "voiced_ratio": (0.55, 0.15),
    "f2_hz": (1500.0, 250.0),
}
# Signed importance: + pushes the risk index up, - is protective.
_WEIGHTS: dict[str, float] = {
    "jitter_local": 0.35,
    "shimmer_local": 0.30,
    "hnr_db": -0.25,
    "f0_cv": -0.20,
    "articulation_rate": -0.40,
    "speech_rate": -0.35,
    "pause_ratio": 0.45,
    "mean_pause_s": 0.25,
    "voiced_ratio": -0.25,
    "f2_hz": -0.15,
}
_BIAS = -0.20
_MODEL_PATH = os.getenv("AURA_ACOUSTIC_MODEL")
_booster = None
_booster_loaded = False


@dataclass
class _Loaded:
    model: object | None = None
    feature_order: list[str] = field(default_factory=list)


def _load_booster() -> _Loaded | None:
    global _booster, _booster_loaded
    if _booster_loaded:
        return _booster
    _booster_loaded = True
    if not _MODEL_PATH or not os.path.exists(_MODEL_PATH):
        return None
    try:
        import lightgbm as lgb  # type: ignore

        model = lgb.Booster(model_file=_MODEL_PATH)
        order = list(model.feature_name())
        _booster = _Loaded(model=model, feature_order=order)
    except Exception:
        try:
            import xgboost as xgb  # type: ignore

            model = xgb.Booster()
            model.load_model(_MODEL_PATH)
            _booster = _Loaded(model=model, feature_order=list(model.feature_names or []))
        except Exception:
            _booster = None
    return _booster


def _z(value: float, name: str) -> float:
    mean, std = ACOUSTIC_NORMS[name]
    return (value - mean) / std if std else 0.0


def score_acoustic(summary: dict[str, float], vector: dict[str, float] | None = None) -> StreamScore:
    """-> StreamScore in [0, 1], 1 = maximally atypical acoustics."""
    loaded = _load_booster()
    if loaded and loaded.model is not None and loaded.feature_order:
        source = {**(vector or {}), **summary}
        row = np.array([[float(source.get(k, 0.0)) for k in loaded.feature_order]])
        try:
            import lightgbm as lgb  # type: ignore

            if isinstance(loaded.model, lgb.Booster):  # type: ignore[attr-defined]
                score = float(loaded.model.predict(row, num_iteration=loaded.model.best_iteration)[0])
                return StreamScore(stream="acoustic", score=float(np.clip(score, 0.0, 1.0)), model=f"lightgbm:{os.path.basename(_MODEL_PATH or '')}")
        except Exception:
            pass
        try:
            import xgboost as xgb  # type: ignore

            pred = loaded.model.predict(xgb.DMatrix(row))  # type: ignore[union-attr]
            return StreamScore(stream="acoustic", score=float(np.clip(float(pred[0]), 0.0, 1.0)), model=f"xgboost:{os.path.basename(_MODEL_PATH or '')}")
        except Exception:
            pass

    contributions: list[BiomarkerContribution] = []
    total = _BIAS
    for name, weight in _WEIGHTS.items():
        raw = summary.get(name)
        if raw is None:
            continue
        z = _z(float(raw), name)
        contribution = weight * z
        total += contribution
        contributions.append(
            BiomarkerContribution(
                name=name,
                value=float(raw),
                weight=weight,
                contribution=contribution,
                direction="risk" if contribution > 0 else "protective",
            )
        )
    score = float(1.0 / (1.0 + np.exp(-total)))
    return StreamScore(stream="acoustic", score=score, model="linear-interpretable", contributions=contributions)