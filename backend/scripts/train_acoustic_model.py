"""
声学流模型训练脚本（黑客松版）
数据集: Alzheimer-s-disease-datasets（中文, openSMILE eGeMAPS 特征 + 诊断标签）
任务:   二分类 —— AD/MCI(高风险, 1) vs CTRL(健康对照, 0)
产出:   backend/models/acoustic_lgbm.txt  -> 设 AURA_ACOUSTIC_MODEL 指向它
        backend/models/acoustic_train_report.json -> 评估指标（写 PPT 用）

用法:
    python scripts/train_acoustic_model.py
"""
import json
import os
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, f1_score, roc_auc_score
from sklearn.model_selection import LeaveOneOut, StratifiedKFold

BASE = Path(__file__).resolve().parent.parent
# 数据集不入库（.gitignore），默认落在 backend/data/ 下；
# 若放在别处，用 AURA_DATASET_DIR 指过去即可。
DATA_DIR = Path(os.getenv("AURA_DATASET_DIR", BASE / "data" / "Alzheimer-s-disease-datasets-master")) / ".github" / "workflows"
OUT_DIR = BASE / "models"
OUT_DIR.mkdir(exist_ok=True)

LABELS_CSV = DATA_DIR / "2_final_list_train.csv"
FEATS_CSV = DATA_DIR / "egemaps_final.csv"
MODEL_OUT = OUT_DIR / "acoustic_lgbm.txt"
REPORT_OUT = OUT_DIR / "acoustic_train_report.json"


def load_dataset():
    labels = pd.read_csv(LABELS_CSV)
    feats = pd.read_csv(FEATS_CSV)
    df = labels.merge(feats, on="uuid", how="inner")
    # 筛查场景: AD 和 MCI 都算"需要转介"的阳性
    df["y"] = (df["label"].isin(["AD", "MCI"])).astype(int)
    feature_cols = [c for c in feats.columns if c != "uuid"]
    X = df[feature_cols].astype(float)
    y = df["y"].values
    print(f"样本: {len(df)} 人 (AD={sum(df.label=='AD')}, MCI={sum(df.label=='MCI')}, "
          f"CTRL={sum(df.label=='CTRL')}), 特征 {len(feature_cols)} 维")
    print(f"年龄范围 {df.age.min()}~{df.age.max()}, 女性占比 {sum(df.sex=='F')/len(df):.0%}")
    return df, X, y, feature_cols


def make_model(seed=42):
    # 小样本防过拟合: 浅树 + 强正则 + 行/列采样
    return lgb.LGBMClassifier(
        n_estimators=200, num_leaves=7, max_depth=3, learning_rate=0.05,
        min_child_samples=15, subsample=0.8, colsample_bytree=0.6,
        reg_alpha=1.0, reg_lambda=1.0, random_state=seed,
    )


def evaluate(X, y):
    """留一法 + 重复5折 双口径评估"""
    t0 = time.time()
    # LOO
    loo_pred = np.zeros(len(y))
    for tr, te in LeaveOneOut().split(X):
        m = make_model()
        m.fit(X.iloc[tr], y[tr])
        loo_pred[te] = m.predict_proba(X.iloc[te])[:, 1]
    loo_auc = roc_auc_score(y, loo_pred)
    loo_acc = accuracy_score(y, loo_pred > 0.5)
    loo_f1 = f1_score(y, loo_pred > 0.5)
    # 重复 5 折（更稳的方差估计）
    skf_aucs = []
    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    for tr, te in skf.split(X, y):
        m = make_model()
        m.fit(X.iloc[tr], y[tr])
        skf_aucs.append(roc_auc_score(y[te], m.predict_proba(X.iloc[te])[:, 1]))
    print(f"LOO:  AUC={loo_auc:.3f} ACC={loo_acc:.3f} F1={loo_f1:.3f}")
    print(f"5fold: AUC={np.mean(skf_aucs):.3f} +/- {np.std(skf_aucs):.3f}  "
          f"(耗时 {time.time()-t0:.0f}s)")
    return {"loo_auc": round(loo_auc, 3), "loo_acc": round(loo_acc, 3),
            "loo_f1": round(loo_f1, 3),
            "cv5_auc_mean": round(float(np.mean(skf_aucs)), 3),
            "cv5_auc_std": round(float(np.std(skf_aucs)), 3)}


def main():
    df, X, y, feature_cols = load_dataset()
    metrics = evaluate(X, y)

    # 全量训练最终模型并落盘（Booster 格式, auragba/model/acoustic.py 直接加载）
    final = make_model()
    final.fit(X, y)
    final.booster_.save_model(str(MODEL_OUT))

    imp = pd.Series(final.booster_.feature_importance(importance_type="gain"),
                    index=feature_cols).sort_values(ascending=False)
    top15 = [{"feature": k, "gain": round(float(v), 1)} for k, v in imp.head(15).items()]
    print("\nTop-10 重要特征:")
    for i, (k, v) in enumerate(imp.head(10).items(), 1):
        print(f"  {i:2d}. {k}  (gain {v:.0f})")

    report = {
        "dataset": "lzy1012/Alzheimer-s-disease-datasets (Chinese, eGeMAPS)",
        "task": "AD|MCI vs CTRL binary screening",
        "n_subjects": int(len(df)),
        "n_features": len(feature_cols),
        "class_balance": {"positive_AD_MCI": int(y.sum()), "negative_CTRL": int((1 - y).sum())},
        "metrics": metrics,
        "top15_features": top15,
        "model_file": str(MODEL_OUT),
        "note": "推理端必须安装 opensmile，保证线上特征与训练特征同分布",
    }
    REPORT_OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n模型已保存: {MODEL_OUT}")
    print(f"评估报告: {REPORT_OUT}")

    # 冒烟测试: 模拟 auragba/model/acoustic.py 的加载路径
    booster = lgb.Booster(model_file=str(MODEL_OUT))
    order = list(booster.feature_name())
    source = {c: float(X.iloc[0][c]) for c in feature_cols}
    row = np.array([[source.get(k, 0.0) for k in order]])
    prob = float(booster.predict(row)[0])
    print(f"冒烟测试 OK: 特征数={len(order)}, 首样本预测概率={prob:.3f} (真实标签={y[0]})")


if __name__ == "__main__":
    main()
