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
    error: str | None = None


def _load_booster() -> _Loaded | None:
    global _booster, _booster_loaded
    if _booster_loaded:
        return _booster
    _booster_loaded = True
    if not _MODEL_PATH:
        return None
    if not os.path.exists(_MODEL_PATH):
        print(f"[auragba][WARN] AURA_ACOUSTIC_MODEL={_MODEL_PATH} 不存在，退回手工权重兜底")
        return None
    last_error = "unknown"
    try:
        import lightgbm as lgb  # type: ignore

        model = lgb.Booster(model_file=_MODEL_PATH)
        _booster = _Loaded(model=model, feature_order=list(model.feature_name()))
        return _booster
    except Exception as exc:
        last_error = f"{type(exc).__name__}: {exc}"
    try:
        import xgboost as xgb  # type: ignore

        model = xgb.Booster()
        model.load_model(_MODEL_PATH)
        _booster = _Loaded(model=model, feature_order=list(model.feature_names or []))
        return _booster
    except Exception as exc:
        last_error = f"{type(exc).__name__}: {exc}"
    # 配置了模型却加载失败：必须留下痕迹，否则会静默退回手工权重而无人察觉
    _booster = _Loaded(error=last_error)
    print(f"[auragba][WARN] AURA_ACOUSTIC_MODEL={_MODEL_PATH} 加载失败，"
          f"已退回手工权重兜底: {last_error}")
    return _booster


def model_fingerprint() -> dict:
    """模型文件指纹，供审计链记录"这个分数是哪个模型打的"。"""
    import hashlib

    info = {"path": _MODEL_PATH, "sha256_8": None, "loaded": False, "error": None}
    loaded = _load_booster()
    if _MODEL_PATH and os.path.exists(_MODEL_PATH):
        with open(_MODEL_PATH, "rb") as f:
            info["sha256_8"] = hashlib.sha256(f.read()).hexdigest()[:8]
    if loaded is not None:
        info["loaded"] = loaded.model is not None
        info["error"] = loaded.error
    return info


def _z(value: float, name: str) -> float:
    mean, std = ACOUSTIC_NORMS[name]
    return (value - mean) / std if std else 0.0


# openSMILE 后端产出的摘要键是 eGeMAPS 原名，numpy 后端是 snake_case。
# 权重表按 snake_case 定义，所以先做一次别名归一，否则装了 openSMILE 之后
# 兜底路径会匹配不到任何特征（分数退化成常数、contributions 为空）。
_SUMMARY_ALIASES: dict[str, str] = {
    "F0semitoneFrom27.5Hz_sma3nz_amean": "f0_mean_hz",
    "F0semitoneFrom27.5Hz_sma3nz_stddevNorm": "f0_cv",
    "jitterLocal_sma3nz_amean": "jitter_local",
    "shimmerLocaldB_sma3nz_amean": "shimmer_local",
    "HNRdBACF_sma3nz_amean": "hnr_db",
    "F1frequency_sma3nz_amean": "f1_hz",
    "F2frequency_sma3nz_amean": "f2_hz",
    "F3frequency_sma3nz_amean": "f3_hz",
    "loudness_sma3_amean": "loudness_db_mean",
    "loudness_sma3_stddevNorm": "loudness_db_std",
    "equivalentSoundLevel_dBp": "loudness_db_mean",
}


def _canonical_summary(summary: dict[str, float]) -> dict[str, float]:
    """把任一后端的摘要键归一到权重表使用的 snake_case 名。"""
    out: dict[str, float] = {}
    for key, value in (summary or {}).items():
        out.setdefault(_SUMMARY_ALIASES.get(key, key), float(value))
    return out


def _booster_contributions(loaded: _Loaded, row: "np.ndarray") -> list[BiomarkerContribution]:
    """真模型也要可解释：用 SHAP(pred_contrib) 作为本次预测的逐项贡献，
    gain 重要性作为该特征的权重（两者都来自同一个 Booster）。"""
    names = loaded.feature_order
    try:
        raw = loaded.model.predict(row, pred_contrib=True)  # shape (1, n_features + 1)
        shap = np.asarray(raw).ravel()[: len(names)]
        gains = np.asarray(loaded.model.feature_importance(importance_type="gain"), dtype=float)
        gain_norm = gains / gains.sum() if gains.sum() else np.zeros_like(gains)
    except Exception:
        return []
    items = []
    for i, name in enumerate(names):
        items.append(BiomarkerContribution(
            name=name,
            value=float(row[0][i]),
            weight=float(gain_norm[i]) if i < len(gain_norm) else 0.0,
            contribution=float(shap[i]),
            direction="risk" if shap[i] > 0 else "protective",
        ))
    # 只报贡献最大的 8 项，避免报告页被 88 维淹没
    items.sort(key=lambda c: -abs(c.contribution))
    return items[:8]


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
                return StreamScore(
                    stream="acoustic",
                    score=float(np.clip(score, 0.0, 1.0)),
                    model=f"lightgbm:{os.path.basename(_MODEL_PATH or '')}",
                    contributions=_booster_contributions(loaded, row),
                )
        except Exception:
            pass
        try:
            import xgboost as xgb  # type: ignore

            pred = loaded.model.predict(xgb.DMatrix(row))  # type: ignore[union-attr]
            return StreamScore(stream="acoustic", score=float(np.clip(float(pred[0]), 0.0, 1.0)), model=f"xgboost:{os.path.basename(_MODEL_PATH or '')}")
        except Exception:
            pass
    # 走到这里说明用的是手工权重兜底；若配置了模型却没加载上，把失败写进标签
    if _MODEL_PATH and (loaded is None or loaded.model is None):
        fallback_label = f"linear-interpretable(LOAD-FAILED:{os.path.basename(_MODEL_PATH)})"
    else:
        fallback_label = "linear-interpretable"

    contributions: list[BiomarkerContribution] = []
    total = _BIAS
    canon = _canonical_summary(summary)
    for name, weight in _WEIGHTS.items():
        raw = canon.get(name)
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
    return StreamScore(stream="acoustic", score=score, model=fallback_label, contributions=contributions)