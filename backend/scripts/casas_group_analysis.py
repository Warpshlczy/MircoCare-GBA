"""
CASAS cognitive_assessment 组间分析（PLAN T0-B 第 3 步）

数据: D:/GBA-hackathon/datasets/cognitive_assessment/
  - documents/diagnosis.txt     ID -> 诊断（1=dementia 2=MCI 3-5=年龄对照 7=at-risk 8/9=年轻人）
  - documents/activityscores.txt 活动 1-8 得分 + day-out 准确/排序分
  - data/<ID>.txt               脚本化任务期间的传感器事件流

产出（写报告用）:
  - casas_features.csv          每人特征表（得分 + 事件流派生特征 + 诊断组）
  - casas_group_report.json     组间统计（Mann-Whitney U + Cliff's delta）

用法:
  AURA_CASAS_DIR=D:/GBA-hackathon/datasets/cognitive_assessment \\
    backend/.venv/Scripts/python.exe scripts/casas_group_analysis.py
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pandas as pd

BASE = Path(__file__).resolve().parent.parent
DS = Path(os.getenv("AURA_CASAS_DIR", "D:/GBA-hackathon/datasets/cognitive_assessment"))
OUT = BASE / "data" / "casas_out"  # backend/data/ 已 gitignore，派生数据不入库
OUT.mkdir(parents=True, exist_ok=True)

# 诊断分组：认知阳性 vs 年龄对照（8/9 年轻人、6 其他疾病、10 缺失不进主分析）
GROUPS = {
    "dementia": {1},
    "MCI": {2},
    "CTRL_age": {3, 4, 5},   # 中年 + young-old + old-old
    "at_risk": {7},
}
MAIN_COMPARE = ["dementia", "MCI", "CTRL_age"]


def load_diagnosis() -> pd.Series:
    rows = []
    for line in (DS / "documents" / "diagnosis.txt").read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            rows.append((int(parts[0]), int(parts[1])))
    diag = pd.Series({i: d for i, d in rows}, name="diagnosis")
    inv = {code: name for name, codes in GROUPS.items() for code in codes}
    return diag.map(inv)  # 未映射 -> NaN（年轻人等）


def load_scores() -> pd.DataFrame:
    """activityscores.txt: ID + 活动1-8得分 + 总分 + day-out accuracy + sequencing"""
    rows = []
    for line in (DS / "documents" / "activityscores.txt").read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if not parts or not parts[0].isdigit():
            continue
        vals: list[float | None] = []
        for p in parts[1:]:
            vals.append(np.nan if p == "?" else float(p))
        if len(vals) < 9:
            continue
        rec = {"pid": int(parts[0])}
        for k in range(8):
            rec[f"task{k+1}_score"] = vals[k]
        rec["tasks_sum"] = vals[8]
        if len(vals) > 9:
            rec["dayout_accuracy"] = vals[9]
        if len(vals) > 10:
            rec["dayout_sequencing"] = vals[10]
        rows.append(rec)
    return pd.DataFrame(rows).set_index("pid")


def load_sensor_features() -> pd.DataFrame:
    """data/<ID>.txt -> 会话级派生特征（时长、事件率、移动/开关计数）"""
    rows = []
    for f in sorted((DS / "data").glob("*.txt")):
        pid = int(f.stem)
        events = []
        for line in f.read_text(encoding="utf-8", errors="ignore").splitlines():
            parts = line.split()
            if len(parts) < 3 or ":" not in parts[0]:
                continue
            events.append((parts[0], parts[1], " ".join(parts[2:])))
        if len(events) < 20:
            continue
        t0 = events[0][0]
        t1 = events[-1][0]

        def secs(hhmmss: str) -> float:
            h, m, s = hhmmss.split(":")
            return int(h) * 3600 + int(m) * 60 + float(s)

        dur = max(1.0, secs(t1) - secs(t0))
        sensors = [e[1] for e in events]
        statuses = [e[2] for e in events]
        n = len(events)
        n_motion = sum(1 for s in sensors if s.startswith("M"))
        n_door = sum(1 for s in sensors if s.startswith("D"))
        n_item = sum(1 for s in sensors if s.startswith("I"))
        n_light = sum(1 for s in sensors if s.startswith("L"))
        n_on = sum(1 for st in statuses if st == "ON")
        unique_sensors = len(set(sensors))
        rows.append({
            "pid": pid,
            "session_dur_min": dur / 60.0,
            "n_events": n,
            "events_per_min": n / (dur / 60.0),
            "n_motion_events": n_motion,
            "n_door_events": n_door,
            "n_item_events": n_item,
            "n_light_events": n_light,
            "motion_ratio": n_motion / n,
            "unique_sensors": unique_sensors,
            "sensor_diversity": unique_sensors / n,  # 越低 = 反复触发同一小簇传感器（行为收窄）
            "on_off_balance": n_on / n,
        })
    return pd.DataFrame(rows).set_index("pid")


def cliffs_delta(a: np.ndarray, b: np.ndarray) -> float:
    """|delta|>0.147 小, >0.33 中, >0.474 大"""
    a, b = a[~np.isnan(a)], b[~np.isnan(b)]
    if len(a) == 0 or len(b) == 0:
        return float("nan")
    diff = a[:, None] - b[None, :]
    gt = int((diff > 0).sum())
    lt = int((diff < 0).sum())
    return (gt - lt) / (len(a) * len(b))


def mwu_p(a: np.ndarray, b: np.ndarray) -> float:
    """正态近似 Mann-Whitney U p 值（双侧）"""
    from math import erf, sqrt

    a, b = a[~np.isnan(a)], b[~np.isnan(b)]
    n1, n2 = len(a), len(b)
    if n1 < 3 or n2 < 3:
        return float("nan")
    allv = np.concatenate([a, b])
    ranks = pd.Series(allv).rank().values
    r1 = ranks[:n1].sum()
    u1 = r1 - n1 * (n1 + 1) / 2
    u2 = n1 * n2 - u1
    mu = n1 * n2 / 2
    tie = pd.Series(allv).value_counts().values
    n = n1 + n2
    sigma_sq = n1 * n2 / 12 * ((n + 1) - (tie**3 - tie).sum() / (n * (n - 1)))
    if sigma_sq <= 0:
        return float("nan")
    z = (min(u1, u2) - mu + 0.5) / sqrt(sigma_sq)
    p = 2 * (1 - 0.5 * (1 + erf(abs(z) / sqrt(2))))
    return float(p)


def main() -> None:
    diag = load_diagnosis()
    feats = load_scores().join(load_sensor_features(), how="outer")
    feats = feats.join(diag.rename("group"), how="inner")
    feats.index.name = "pid"
    feats.to_csv(OUT / "casas_features.csv")
    print(f"特征表: {len(feats)} 人 x {feats.shape[1]} 列 -> {OUT / 'casas_features.csv'}")
    print(feats["group"].value_counts().to_string())

    metrics = [c for c in feats.columns if c != "group"]
    report: dict = {"n_by_group": feats["group"].value_counts().to_dict(), "comparisons": {}}
    for g1, g2 in [("dementia", "CTRL_age"), ("MCI", "CTRL_age"), ("dementia", "MCI")]:
        key = f"{g1}_vs_{g2}"
        report["comparisons"][key] = {}
        for m in metrics:
            a = feats.loc[feats.group == g1, m].astype(float).values
            b = feats.loc[feats.group == g2, m].astype(float).values
            d = cliffs_delta(a, b)
            p = mwu_p(a, b)
            report["comparisons"][key][m] = {
                "median_g1": float(np.nanmedian(a)) if len(a) else None,
                "median_g2": float(np.nanmedian(b)) if len(b) else None,
                "cliffs_delta": None if np.isnan(d) else round(float(d), 3),
                "p_approx": None if np.isnan(p) else round(p, 4),
            }
        sig = sorted(
            [(m, v["cliffs_delta"], v["p_approx"]) for m, v in report["comparisons"][key].items()
             if v["p_approx"] is not None and v["p_approx"] < 0.05 and v["cliffs_delta"] is not None],
            key=lambda x: -abs(x[1]),
        )
        report["comparisons"][key]["_significant_sorted_by_effect"] = [
            {"metric": m, "cliffs_delta": d, "p": p} for m, d, p in sig[:10]
        ]
        print(f"\n== {key} ==")
        for m, d, p in sig[:10]:
            print(f"  {m:22s} delta={d:+.3f}  p={p:.4f}")

    (OUT / "casas_group_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\n报告 -> {OUT / 'casas_group_report.json'}")


if __name__ == "__main__":
    main()
