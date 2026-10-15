"""Stream B — semantic / linguistic classifier.

Same shape as the acoustic stream: an interpretable additive logistic model over
z-scored linguistic biomarkers, returning per-feature contributions. A fitted
scikit-learn model can be dropped in via AURA_SEMANTIC_MODEL (`joblib`).

`ponytail:` illustrative priors again — lower lexical richness, longer/varied
sentences, more fillers and lower coherence raise the score. Not clinically
fitted; not-for-diagnosis. Upgrade: fit on a labelled cohort behind the same
contract.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import numpy as np

from ..contract import BiomarkerContribution, StreamScore

# (name -> (population mean, population std)) — illustrative senior norms.
SEMANTIC_NORMS: dict[str, tuple[float, float]] = {
    "ttr": (0.72, 0.12),
    "mattr": (0.75, 0.10),
    "noun_to_verb_ratio": (1.60, 0.80),
    "sentence_len_variance": (6.0, 4.0),
    "filler_ratio": (0.03, 0.03),
    "mean_sentence_len": (9.0, 3.5),
    "coherence": (0.60, 0.20),
}
_WEIGHTS: dict[str, float] = {
    "ttr": -0.35,
    "mattr": -0.30,
    "noun_to_verb_ratio": -0.15,
    "sentence_len_variance": 0.25,
    "filler_ratio": 0.30,
    "mean_sentence_len": -0.20,
    "coherence": -0.55,
}
_BIAS = -0.20
_MODEL_PATH = os.getenv("AURA_SEMANTIC_MODEL")
_clf = None
_clf_loaded = False


@dataclass
class _Loaded:
    model: object | None = None
    feature_order: list[str] | None = None
    error: str | None = None


def _load_clf() -> _Loaded | None:
    global _clf, _clf_loaded
    if _clf_loaded:
        return _clf
    _clf_loaded = True
    if not _MODEL_PATH:
        return None
    if not os.path.exists(_MODEL_PATH):
        print(f"[auragba][WARN] AURA_SEMANTIC_MODEL={_MODEL_PATH} 不存在，退回手工权重兜底")
        return None
    try:
        import joblib  # type: ignore

        model = joblib.load(_MODEL_PATH)
        order = list(getattr(model, "feature_names_in_", [])) or None
        _clf = _Loaded(model=model, feature_order=order)
    except Exception as exc:
        _clf = _Loaded(error=f"{type(exc).__name__}: {exc}")
        print(f"[auragba][WARN] AURA_SEMANTIC_MODEL={_MODEL_PATH} 加载失败，"
              f"已退回手工权重兜底: {_clf.error}")
    return _clf


def model_fingerprint() -> dict:
    """模型文件指纹，供审计链记录分数来源。"""
    import hashlib

    info = {"path": _MODEL_PATH, "sha256_8": None, "loaded": False, "error": None}
    loaded = _load_clf()
    if _MODEL_PATH and os.path.exists(_MODEL_PATH):
        with open(_MODEL_PATH, "rb") as f:
            info["sha256_8"] = hashlib.sha256(f.read()).hexdigest()[:8]
    if loaded is not None:
        info["loaded"] = loaded.model is not None
        info["error"] = loaded.error
    return info


def _z(value: float, name: str) -> float:
    mean, std = SEMANTIC_NORMS[name]
    return (value - mean) / std if std else 0.0


def score_semantic(metrics: dict[str, float], coherence: float | None = None) -> StreamScore | None:
    """-> StreamScore, or None when there is no transcript to judge."""
    source = dict(metrics)
    if coherence is not None:
        source["coherence"] = coherence
    if not source.get("tokens"):
        return None

    loaded = _load_clf()
    if loaded and loaded.model is not None:
        order = loaded.feature_order or [k for k in SEMANTIC_NORMS]
        row = np.array([[float(source.get(k, 0.0)) for k in order]])
        try:
            proba = loaded.model.predict_proba(row)[0]  # type: ignore[union-attr]
            return StreamScore(
                stream="semantic",
                score=float(np.clip(float(proba[-1]), 0.0, 1.0)),
                model=f"sklearn:{os.path.basename(_MODEL_PATH or '')}",
            )
        except Exception:
            pass

    # 配了模型却没吃上时，把失败写进标签，避免"以为在跑真模型"
    if _MODEL_PATH and (loaded is None or loaded.model is None):
        fallback_label = f"linear-interpretable(LOAD-FAILED:{os.path.basename(_MODEL_PATH)})"
    else:
        fallback_label = "linear-interpretable"

    contributions: list[BiomarkerContribution] = []
    total = _BIAS
    for name, weight in _WEIGHTS.items():
        raw = source.get(name)
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
    return StreamScore(stream="semantic", score=score, model=fallback_label, contributions=contributions)