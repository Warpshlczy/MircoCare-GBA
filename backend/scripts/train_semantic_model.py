"""
语义流模型训练脚本（黑客松版）
数据集: Alzheimer-s-disease-datasets（中文）—— 只保留被试 <B> 的发言
特征:   复用 auragba/nlp 的 analyse_linguistics + coherence，
        保证训练与线上推理走**同一套函数**，零分布偏移
任务:   二分类 —— AD/MCI(阳性, 1) vs CTRL(对照, 0)
产出:   backend/models/semantic_lr.joblib -> 设 AURA_SEMANTIC_MODEL 指向它
        backend/models/semantic_train_report.json

用法:
    python scripts/train_semantic_model.py
"""
import json
import os
import re
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, f1_score, roc_auc_score
from sklearn.model_selection import LeaveOneOut, StratifiedKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from confound import report as confound_report

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))  # 让脚本可 import auragba

from auragba.nlp.coherence import coherence  # noqa: E402
from auragba.nlp.metrics import analyse_linguistics  # noqa: E402

# 数据集不入库（.gitignore），默认落在 backend/data/ 下；
# 若放在别处，用 AURA_DATASET_DIR 指过去即可。
DS = Path(os.getenv("AURA_DATASET_DIR", BASE / "data" / "Alzheimer-s-disease-datasets-master"))
TSV_DIR = DS / "tsv_all" / "tsv2"
LABELS_CSV = DS / ".github" / "workflows" / "2_final_list_train.csv"
OUT_DIR = BASE / "models"
OUT_DIR.mkdir(exist_ok=True)
MODEL_OUT = OUT_DIR / "semantic_lr.joblib"
REPORT_OUT = OUT_DIR / "semantic_train_report.json"

# 标注里的特殊符号：&填充词、/重复、//修正、【异常】
_FILLER_MARK = re.compile(r"&")
_REPEAT_MARK = re.compile(r"/(?!/)")
_REPAIR_MARK = re.compile(r"//")
_BRACKET = re.compile(r"【[^】]*】")


def clean(text: str) -> str:
    """去掉标注符号，只留可分析的文本"""
    t = _BRACKET.sub("", text)
    t = _REPAIR_MARK.sub("", t)
    t = _REPEAT_MARK.sub("", t)
    t = _FILLER_MARK.sub("", t)
    return t.strip()


def read_subject_text(tsv_path: Path) -> tuple[str, str, str]:
    """-> (被试去符号文本, 主试去符号文本, 被试原始带标注文本)"""
    try:
        df = pd.read_csv(tsv_path, sep="\t", dtype=str, encoding="utf-8")
    except Exception:
        return "", "", ""
    df = df.dropna(subset=["speaker", "value"])
    subj_raw = "".join(df.loc[df["speaker"] == "<B>", "value"].tolist())
    tester = "".join(df.loc[df["speaker"] == "<A>", "value"].tolist())
    return clean(subj_raw), clean(tester), subj_raw


def build_dataset():
    labels = pd.read_csv(LABELS_CSV)
    rows = []
    for _, r in labels.iterrows():
        tsv = TSV_DIR / f"{r['uuid']}.tsv"
        if not tsv.exists():
            continue
        subject_text, tester_text, raw = read_subject_text(tsv)
        if len(subject_text) < 30:
            continue
        ling = analyse_linguistics(subject_text)
        coh = coherence(tester_text, subject_text)  # 与线上同一函数
        feats = dict(ling.metrics)
        feats["coherence"] = float(coh)
        # 标注派生的强信号特征（只统计被试 <B> 的发言，避免主试污染）
        n_chars = max(1, len(clean(raw)))
        feats["annotated_filler_ratio"] = len(_FILLER_MARK.findall(raw)) / n_chars
        feats["annotated_repeat_ratio"] = len(_REPEAT_MARK.findall(raw)) / n_chars
        feats["annotated_repair_ratio"] = len(_REPAIR_MARK.findall(raw)) / n_chars
        feats["y"] = int(r["label"] in ("AD", "MCI"))
        feats["label"] = r["label"]
        feats["uuid"] = r["uuid"]
        # 人口学只用于混淆审计，不进入语义模型的输入特征
        feats["age"] = r.get("age")
        feats["education"] = r.get("education")
        feats["sex"] = r.get("sex")
        rows.append(feats)
    df = pd.DataFrame(rows)
    for col in FEATURE_COLS:
        if col in df:
            df[col] = df[col].fillna(0.0)
    print(f"可用样本: {len(df)} 人 (AD={sum(df.label=='AD')}, MCI={sum(df.label=='MCI')}, "
          f"CTRL={sum(df.label=='CTRL')})")
    return df


# 只用 auragba.nlp.metrics.analyse_linguistics 线上也能产出的一等公民特征：
#   - 不含 coherence（训练用主试全量文本 vs 线上只传单条 question，口径不一致）
#   - 不含 annotated_*（线上无人工标注，永远为 0，会引入偏移）
FEATURE_COLS = ["ttr", "mattr", "noun_to_verb_ratio", "sentence_len_variance",
                "filler_ratio", "mean_sentence_len", "mean_utterance_len"]


def make_model():
    return Pipeline([
        ("scaler", StandardScaler()),
        ("lr", LogisticRegression(C=1.0, max_iter=2000, class_weight="balanced")),
    ])


def evaluate(X, y):
    t0 = time.time()
    loo_pred = np.zeros(len(y))
    for tr, te in LeaveOneOut().split(X):
        m = make_model()
        m.fit(X.iloc[tr], y[tr])
        loo_pred[te] = m.predict_proba(X.iloc[te])[:, 1]
    aucs = []
    for tr, te in StratifiedKFold(5, shuffle=True, random_state=42).split(X, y):
        m = make_model()
        m.fit(X.iloc[tr], y[tr])
        aucs.append(roc_auc_score(y[te], m.predict_proba(X.iloc[te])[:, 1]))
    res = {
        "loo_auc": round(roc_auc_score(y, loo_pred), 3),
        "loo_acc": round(accuracy_score(y, loo_pred > 0.5), 3),
        "loo_f1": round(f1_score(y, loo_pred > 0.5), 3),
        "cv5_auc_mean": round(float(np.mean(aucs)), 3),
        "cv5_auc_std": round(float(np.std(aucs)), 3),
    }
    print(f"LOO:   AUC={res['loo_auc']} ACC={res['loo_acc']} F1={res['loo_f1']}")
    print(f"5fold: AUC={res['cv5_auc_mean']} +/- {res['cv5_auc_std']}  ({time.time()-t0:.0f}s)")
    return res


def main():
    df = build_dataset()
    X, y = df[FEATURE_COLS].astype(float), df["y"].values
    metrics = evaluate(X, y)
    confound = confound_report(df, y, make_model, metrics["cv5_auc_mean"])

    final = make_model()
    final.fit(X, y)  # DataFrame 入参 -> 自动记录 feature_names_in_
    import joblib
    joblib.dump(final, str(MODEL_OUT))

    coefs = pd.Series(final.named_steps["lr"].coef_[0], index=FEATURE_COLS)
    print("\n特征权重（正=推高风险）:")
    for k, v in coefs.sort_values().items():
        print(f"  {v:+.3f}  {k}")

    # 对照组分数分布 -> 供阈值校准参考
    ctrl_scores = final.predict_proba(X[y == 0])[:, 1]
    pos_scores = final.predict_proba(X[y == 1])[:, 1]
    thresholds = {q: round(float(np.quantile(ctrl_scores, q)), 3)
                  for q in (0.5, 0.75, 0.9, 0.95)}

    report = {
        "dataset": "lzy1012/Alzheimer-s-disease-datasets (Chinese, annotated transcripts)",
        "task": "AD|MCI vs CTRL, linguistic stream only",
        "n_subjects": int(len(df)), "features": FEATURE_COLS,
        "metrics": metrics,
        "demographic_baseline": confound,
        "coefficients": {k: round(float(v), 3) for k, v in coefs.items()},
        "ctrl_score_quantiles": thresholds,
        "pos_score_median": round(float(np.median(pos_scores)), 3),
        "model_file": str(MODEL_OUT),
        "note": "训练与推理共用 auragba.nlp 函数，无分布偏移；coherence 需线上也用同一降级实现",
    }
    REPORT_OUT.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n模型已保存: {MODEL_OUT}\n评估报告: {REPORT_OUT}")

    # 冒烟：模拟 auragba/model/semantic.py 的加载路径
    loaded = joblib.load(str(MODEL_OUT))
    order = list(loaded.feature_names_in_)
    src = {"ttr": 0.55, "mattr": 0.6, "noun_to_verb_ratio": 1.2,
           "sentence_len_variance": 9.0, "filler_ratio": 0.08,
           "mean_sentence_len": 7.0, "mean_utterance_len": 8.0, "coherence": 0.25,
           "annotated_filler_ratio": 0.05, "annotated_repeat_ratio": 0.03,
           "annotated_repair_ratio": 0.01, "tokens": 120.0}
    row = [[float(src.get(k, 0.0)) for k in order]]
    print(f"冒烟 OK: 特征数={len(order)}, 预测概率={loaded.predict_proba(row)[0][-1]:.3f}")


if __name__ == "__main__":
    main()
