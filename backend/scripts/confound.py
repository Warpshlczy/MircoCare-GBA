"""Demographic-confound check shared by the training scripts.

The cohort is not matched: education alone separates AD/MCI from controls about
as well as the speech model (single-variable AUC ≈0.65). Any AUC printed without
that context is misleading, so both training scripts run this check and fail
loudly when demographics explain most of the signal.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedKFold


def _frame(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    data = df.copy()
    if "sex_m" not in data and "sex" in data:
        data["sex_m"] = (data["sex"].astype(str).str.upper() == "M").astype(int)
    cols = [c for c in ("age", "education", "sex_m") if c in data.columns]
    return data[cols].astype(float), cols


def baseline_auc(df: pd.DataFrame, y, make_model, n_splits: int = 5) -> dict | None:
    X, cols = _frame(df)
    if len(cols) < 2:
        return None
    mask = X.notna().all(axis=1).to_numpy()
    X = X.loc[mask]
    yy = np.asarray(y)[mask]
    if len(X) < n_splits or len(np.unique(yy)) < 2:
        return None
    oof = np.zeros(len(yy))
    for tr, te in StratifiedKFold(n_splits, shuffle=True, random_state=42).split(X, yy):
        m = make_model()
        m.fit(X.iloc[tr], yy[tr])
        oof[te] = m.predict_proba(X.iloc[te])[:, 1]
    return {"features": cols, "auc": round(float(roc_auc_score(yy, oof)), 3), "n": int(len(yy))}


def report(df: pd.DataFrame, y, make_model, model_auc: float) -> dict | None:
    out = baseline_auc(df, y, make_model)
    if out is None:
        return None
    ratio = out["auc"] / model_auc if model_auc else None
    out["ratio"] = None if ratio is None else round(ratio, 3)
    print(
        f"人口学基线（{'/'.join(out['features'])}，n={out['n']}）AUC={out['auc']:.3f}"
        f"；模型 AUC={model_auc:.3f}"
        + (f"；比值 {ratio:.0%}" if ratio is not None else "")
    )
    if ratio is not None and ratio >= 0.6:
        print("[WARN] 人口学基线已达模型的 60% —— 报告 AUC 时必须声明教育/年龄混淆")
    return out
