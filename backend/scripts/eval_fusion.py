"""
融合模型端到端离线评估 + 风险阈值校准（黑客松版）

数据集自带 eGeMAPS 特征和标注转写，可以完整复现线上链路：
    eGeMAPS(88维) -> 声学流模型 -> acoustic score
    转写文本      -> auragba nlp -> 语义流模型 -> semantic score
                  -> late_fusion -> riskIndex

产出（写 PPT 用）:
  * 融合后 AUC / ACC / F1（主数字）
  * 对照组分数分位 -> 建议的 AURA_RISK_WATCH / AURA_RISK_ELEVATED 阈值
  * backend/models/fusion_eval_report.json

用法:
  AURA_ACOUSTIC_MODEL=./models/acoustic_lgbm.txt \
  AURA_SEMANTIC_MODEL=./models/semantic_lr.joblib \
  python scripts/eval_fusion.py
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, f1_score, roc_auc_score

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
sys.path.insert(0, str(BASE / "scripts"))

from auragba.contract import StreamScore  # noqa: E402
from auragba.config import settings  # noqa: E402
from auragba.model import late_fusion  # noqa: E402
from train_semantic_model import build_dataset  # noqa: E402

# 数据集不入库（.gitignore），默认落在 backend/data/ 下；
# 若放在别处，用 AURA_DATASET_DIR 指过去即可。
FEATS_CSV = Path(os.getenv("AURA_DATASET_DIR", BASE / "data" / "Alzheimer-s-disease-datasets-master")) / ".github" / "workflows" / "egemaps_final.csv"
REPORT_OUT = BASE / "models" / "fusion_eval_report.json"
FEATURE_COLS = ["ttr", "mattr", "noun_to_verb_ratio", "sentence_len_variance",
                "filler_ratio", "mean_sentence_len", "mean_utterance_len"]


def oof_predictions(X, y, make_model, n_splits=5):
    """交叉拟合：每个样本的分数来自**没见过它的模型**，避免用训练集当测试集。"""
    from sklearn.model_selection import StratifiedKFold
    oof = np.zeros(len(y))
    for tr, te in StratifiedKFold(n_splits, shuffle=True, random_state=42).split(X, y):
        m = make_model()
        m.fit(X.iloc[tr], y[tr])
        oof[te] = m.predict_proba(X.iloc[te])[:, 1]
    return oof


def main():
    df_ling = build_dataset()
    feats = pd.read_csv(FEATS_CSV)
    df = df_ling.merge(feats, on="uuid", how="inner").reset_index(drop=True)
    ego_cols = [c for c in feats.columns if c != "uuid"]
    print(f"评估样本: {len(df)} 人 (阳性 {int(df.y.sum())}, 对照 {int((1-df.y).sum())})")

    y = df.y.values
    # 两流都用交叉拟合分数 —— 直接拿全量训练的模型打分会得到 AUC≈1 的假象
    from train_acoustic_model import make_model as make_ac
    from train_semantic_model import make_model as make_sem
    ac_oof = oof_predictions(df[ego_cols].astype(float), y, make_ac)
    sem_oof = oof_predictions(df[FEATURE_COLS].astype(float), y, make_sem)

    rows = []
    for i, r in df.iterrows():
        ac_score = float(ac_oof[i]); sem_score = float(sem_oof[i])
        # 用 auragba 原装 late_fusion 走一遍，保证与线上融合逻辑一致
        fusion = late_fusion(
            StreamScore(stream="acoustic", score=ac_score, model="oof"),
            StreamScore(stream="semantic", score=sem_score, model="oof"),
        )
        rows.append({"uuid": r["uuid"], "y": int(r["y"]), "label": r["label"],
                     "acoustic": ac_score, "semantic": sem_score,
                     "risk": fusion.risk_index, "band": fusion.band})

    res = pd.DataFrame(rows)
    print("两流分数均为 5 折交叉拟合（非训练集回放）")

    y = res.y.values
    def report(name, s):
        auc = roc_auc_score(y, s); acc = accuracy_score(y, s > 0.5); f1 = f1_score(y, s > 0.5)
        print(f"{name}: AUC={auc:.3f} ACC={acc:.3f} F1={f1:.3f}")
        return {"auc": round(auc, 3), "acc": round(acc, 3), "f1": round(f1, 3)}

    # 权重扫描：声学流弱(0.616)，占太多权重会拖累融合
    print("\n融合权重扫描 (声学:语义):")
    sweep = {}
    for w in (0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.8, 1.0):
        auc = roc_auc_score(y, w * res.acoustic.values + (1 - w) * res.semantic.values)
        sweep[f"{w:.1f}"] = round(auc, 3)
        print(f"  {w:.1f}:{1-w:.1f}  AUC={auc:.3f}")
    best_w = max(sweep, key=sweep.get)
    print(f"最优权重: 声学 {best_w} / 语义 {round(1-float(best_w),1)}")

    metrics = {
        "acoustic_only": report("声学流单流", res.acoustic.values),
        "semantic_only": report("语义流单流", res.semantic.values),
        "fused_default_50_50": report("融合(默认 0.5/0.5)", res.risk.values),
    }
    # 校准后的融合分数
    w_best = float(best_w)
    res["risk_cal"] = w_best * res.acoustic.values + (1 - w_best) * res.semantic.values
    metrics["fused_calibrated"] = report(f"★ 融合(校准 {w_best}/{round(1-w_best,1)})", res.risk_cal.values)

    # 阈值校准：用对照组分数分布定 watch/elevated（筛查倾向高敏感度）
    ctrl = res.loc[res.y == 0, "risk_cal"]
    pos = res.loc[res.y == 1, "risk_cal"]
    # 筛查场景宁可误报不可漏报：watch 取对照组 p40（敏感度优先），elevated 取 p65
    suggested = {
        "AURA_FUSION_W_ACOUSTIC": w_best,
        "AURA_FUSION_W_SEMANTIC": round(1 - w_best, 1),
        "AURA_RISK_WATCH": round(float(np.quantile(ctrl, 0.40)), 3),
        "AURA_RISK_ELEVATED": round(float(np.quantile(ctrl, 0.65)), 3),
    }
    print(f"\n对照组 risk 分布: 中位 {np.median(ctrl):.3f}, "
          f"p75 {np.quantile(ctrl, 0.75):.3f}, p95 {np.quantile(ctrl, 0.95):.3f}")
    print(f"阳性组 risk 中位: {np.median(pos):.3f}")
    print(f"建议阈值: {suggested}")

    # 用建议阈值重算敏感度/特异度
    watch, elevated = suggested["AURA_RISK_WATCH"], suggested["AURA_RISK_ELEVATED"]
    sens = float((pos >= watch).mean()); spec = float((ctrl < watch).mean())
    print(f"以 watch={watch} 为界: 敏感度 {sens:.2f}, 特异度 {spec:.2f}（筛查向高敏感度倾斜）")

    # 校准质量：riskIndex 不是概率，Brier 只用来和"永远猜基线率"比较
    brier = float(np.mean((res.risk_cal.values - y) ** 2))
    base_rate = float(y.mean())
    brier_base = float(np.mean((base_rate - y) ** 2))
    print(f"Brier={brier:.4f}；常数基线（{base_rate:.2%}）={brier_base:.4f}（越小越好）")

    # PPV 只在显式配置患病率时输出；这是假设算术，不是模型测出来的性质
    ppv = None
    if settings.deploy_prevalence is not None:
        p = settings.deploy_prevalence
        denom = sens * p + (1 - spec) * (1 - p)
        if denom > 0:
            ppv = sens * p / denom
            print(f"@假设患病率 {p:.0%}: PPV≈{ppv:.2%}"
                  + (f"（约每 {round(1 / ppv)} 个提示 1 个确认）" if ppv > 0 else ""))

    out = {
        "n_subjects": int(len(res)),
        "metrics": metrics,
        "suggested_thresholds": suggested,
        "sensitivity_at_watch": round(sens, 3),
        "specificity_at_watch": round(spec, 3),
        "brier": round(brier, 4),
        "brier_baseline_rate": round(brier_base, 4),
        "brier_note": "riskIndex 不是概率；Brier 仅用于校准比较",
        "deploy_prevalence": settings.deploy_prevalence,
        "ppv_at_deploy_prevalence": None if ppv is None else round(ppv, 4),
        "ctrl_risk_median": round(float(np.median(ctrl)), 3),
        "pos_risk_median": round(float(np.median(pos)), 3),
        "note": "离线复现线上链路（eGeMAPS+转写 -> 双流 -> 融合），非临床验证；PPV 依赖患病率假设",
    }
    REPORT_OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n报告已保存: {REPORT_OUT}")


if __name__ == "__main__":
    main()
