"""
三流融合（acoustic + semantic + behavior）的权重 / 阈值敏感性扫描

## 为什么这个脚本不能像两流那样"重新校准"

`scripts/eval_fusion.py` 能扫 AUC，是因为数据集自带 eGeMAPS 和标注转写，两条流
都有**监督标签**可以算 OOF 分数。行为流没有：`model/behavior.py` 用的是手写规则权
重，仓库里没有任何行为流的标注样本。没有标签就不能扫 AUC —— 造一批合成行为分数
去"校准"，只会得到一条看起来精确、实际无法追溯的阈值。

所以本脚本只回答一个能回答、而且必须回答的问题：

    行为流上线后，三流加权平均会把多少人换掉风险档？

这个数字就是交付物。它决定 C 能不能继续用 0.409 / 0.521（这两个值是在
两流 0.2/0.8 上扫出来的）。

## 三种数据来源

    --selftest            内置 fixture，仅验证脚本自身逻辑（输出带 FIXTURE 横幅，
                          数字绝不可写进报告）
    --scores scores.csv   自带列 uuid,y,acoustic,semantic 的分数表
    默认                  本机有数据集时用 eval_fusion 的 OOF 链路现算

数据集不入库（.gitignore），拿不到就显式报错，不偷偷换成合成数据。

用法:
    backend/.venv/Scripts/python.exe scripts/fusion3_scan.py --selftest
    backend/.venv/Scripts/python.exe scripts/fusion3_scan.py --scores models/fusion_scores.csv
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

BASE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BASE))
sys.path.insert(0, str(BASE / "scripts"))

from auragba.config import settings  # noqa: E402

OUT = BASE / "models" / "fusion3_scan.json"

# 行为流先验取值。不是测量值：`behavior.py` 在个人历史不足 3 天时会回落到示意性先验，
# 所以这三个值代表"一个新用户刚上线时的行为分数大概落在哪"。
BEHAVIOR_PRIORS = (0.30, 0.50, 0.70)
# 行为流权重扫描。0.20 是 C 写的 initial prior，上下各留两档看趋势。
WEIGHT_GRID = (0.10, 0.15, 0.20, 0.25, 0.30, 0.35)
# 两流内部的声学:语义比例（0.15:0.65 = 3:13），扫描时保持不变。
_TWO_STREAM_RATIO = settings.fusion3_w_acoustic / (settings.fusion3_w_acoustic + settings.fusion3_w_semantic)


def band_of(risk: np.ndarray) -> np.ndarray:
    """与 config.risk_band 同口径，但可批量。"""
    out = np.full(risk.shape, "low", dtype=object)
    out[risk >= settings.risk_watch] = "watch"
    out[risk >= settings.risk_elevated] = "elevated"
    return out


def three_stream_weights(w_behavior: float) -> tuple[float, float, float]:
    """按 3:13 的比例压缩另两条流，给行为流腾出 w_behavior。"""
    rest = 1.0 - w_behavior
    return (_TWO_STREAM_RATIO * rest, (1.0 - _TWO_STREAM_RATIO) * rest, w_behavior)


def combined(ac: np.ndarray, sem: np.ndarray, beh: np.ndarray, w_behavior: float) -> np.ndarray:
    wa, ws, wb = three_stream_weights(w_behavior)
    return np.clip(wa * ac + ws * sem + wb * beh, 0.0, 1.0)


def auc(y: np.ndarray, score: np.ndarray) -> float:
    """Mann-Whitney U 形式的 AUC，避免为一行指标拉进 sklearn。"""
    pos, neg = score[y == 1], score[y == 0]
    if len(pos) == 0 or len(neg) == 0:
        return float("nan")
    order = np.argsort(np.concatenate([pos, neg]), kind="mergesort")
    ranks = np.empty(len(order), dtype=float)
    ranks[order] = np.arange(1, len(order) + 1)
    # 平局取平均秩，否则分数离散时 AUC 会偏
    allv = np.concatenate([pos, neg])
    for v in np.unique(allv):
        idx = np.where(allv == v)[0]
        if len(idx) > 1:
            ranks[idx] = ranks[idx].mean()
    r_pos = ranks[: len(pos)].sum()
    return float((r_pos - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def quantile(x: np.ndarray, q: float) -> float:
    return float(np.quantile(x, q))


def calibrate(y: np.ndarray, score: np.ndarray) -> dict:
    """
    阈值沿用 eval_fusion 的口径：对照组 p40 / p65。
    筛查场景宁可误报不可漏报，所以 watch 卡在对照组的 p40 而不是 p50。
    """
    ctrl, pos = score[y == 0], score[y == 1]
    watch, elevated = quantile(ctrl, 0.40), quantile(ctrl, 0.65)
    return {
        "watch": round(watch, 3),
        "elevated": round(elevated, 3),
        "sensitivity_at_watch": round(float((pos >= watch).mean()), 3),
        "specificity_at_watch": round(float((ctrl < watch).mean()), 3),
        "ctrl_median": round(float(np.median(ctrl)), 3),
        "pos_median": round(float(np.median(pos)), 3),
    }


def migrate_rate(base_band: np.ndarray, new_band: np.ndarray) -> float:
    return round(float((base_band != new_band).mean()), 4)


def scan(y: np.ndarray, ac: np.ndarray, sem: np.ndarray) -> dict:
    base = np.clip(settings.fusion_w_acoustic * ac + settings.fusion_w_semantic * sem, 0.0, 1.0)
    base_band = band_of(base)

    rows = []
    for wb in WEIGHT_GRID:
        for b in BEHAVIOR_PRIORS:
            beh = np.full(len(y), b, dtype=float)
            risk = combined(ac, sem, beh, wb)
            cal = calibrate(y, risk)
            rows.append(
                {
                    "w_behavior": wb,
                    "behavior_prior": b,
                    "auc": round(auc(y, risk), 3),
                    "band_migration": migrate_rate(base_band, band_of(risk)),
                    **cal,
                }
            )
    return {"baseline": calibrate(y, base), "baseline_band_counts": _counts(base_band), "rows": rows}


def _counts(band: np.ndarray) -> dict:
    return {k: int((band == k).sum()) for k in ("low", "watch", "elevated")}


def recommend(result: dict, max_migration: float = 0.05) -> dict:
    """
    选一个"行为流真的起作用、但不至于让现有阈值失效"的权重。
    先看先验 0.50（新用户的常态），找一个迁移率 <= max_migration 的最小权重。
    都超标就诚实地说：现有阈值不能保留。
    """
    at_prior = [r for r in result["rows"] if r["behavior_prior"] == 0.50]
    ok = [r for r in at_prior if r["band_migration"] <= max_migration]
    if ok:
        best = min(ok, key=lambda r: r["w_behavior"])
        return {
            "w_behavior": best["w_behavior"],
            "reason": f"在行为先验 0.50 下换档率 {best['band_migration']:.1%} <= {max_migration:.0%}",
            "watch": best["watch"],
            "elevated": best["elevated"],
            "band_migration": best["band_migration"],
        }
    worst = min(at_prior, key=lambda r: r["band_migration"])
    return {
        "w_behavior": worst["w_behavior"],
        "reason": (
            f"没有一档能把换档率压到 {max_migration:.0%} 以下；最小的是 "
            f"{worst['band_migration']:.1%}（w={worst['w_behavior']}）。"
            "现有 0.409/0.521 不能直接沿用，必须改用本表重新校准的值。"
        ),
        "watch": worst["watch"],
        "elevated": worst["elevated"],
        "band_migration": worst["band_migration"],
    }


def print_table(result: dict, title: str) -> None:
    print(f"\n{title}")
    print("  当前两流基线:", result["baseline"], "档位分布:", result["baseline_band_counts"])
    print()
    print("  w_beh  行为先验   AUC    换档率   watch  elevated  敏感度  特异度")
    for r in result["rows"]:
        print(
            f"  {r['w_behavior']:.2f}   {r['behavior_prior']:.2f}      "
            f"{r['auc']:.3f}  {r['band_migration']:.1%}   "
            f"{r['watch']:.3f}  {r['elevated']:.3f}     "
            f"{r['sensitivity_at_watch']:.2f}    {r['specificity_at_watch']:.2f}"
        )


# --------------------------------------------------------------------------- #
# 数据来源
# --------------------------------------------------------------------------- #


def load_scores_csv(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    import pandas as pd

    df = pd.read_csv(path)
    missing = {"y", "acoustic", "semantic"} - set(df.columns)
    if missing:
        raise SystemExit(f"{path} 缺少列: {sorted(missing)}")
    return df.y.values.astype(int), df.acoustic.values.astype(float), df.semantic.values.astype(float)


def load_from_dataset() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """与 eval_fusion 完全相同的 OOF 链路；数据集不在本机就明确报错。"""
    from eval_fusion import FEATS_CSV, FEATURE_COLS, oof_predictions

    if not FEATS_CSV.exists():
        raise SystemExit(
            "数据集不在本机（backend/data/ 已 gitignore）。\n"
            f"  期望路径: {FEATS_CSV}\n"
            "  改用 --scores（导出的分数表）或 --selftest（只验证脚本逻辑）。"
        )
    import pandas as pd
    from train_acoustic_model import make_model as make_ac
    from train_semantic_model import build_dataset
    from train_semantic_model import make_model as make_sem

    df_ling = build_dataset()
    feats = pd.read_csv(FEATS_CSV)
    df = df_ling.merge(feats, on="uuid", how="inner").reset_index(drop=True)
    ego_cols = [c for c in feats.columns if c != "uuid"]
    y = df.y.values.astype(int)
    ac = oof_predictions(df[ego_cols].astype(float), y, make_ac)
    sem = oof_predictions(df[FEATURE_COLS].astype(float), y, make_sem)
    return y, np.asarray(ac, dtype=float), np.asarray(sem, dtype=float)


def selftest_scores() -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    只用来证明脚本能跑：两簇可分的假分数，没有任何临床含义。
    输出会被打上 FIXTURE 横幅。
    """
    rng = np.random.default_rng(20261025)
    n = 80
    y = np.concatenate([np.zeros(n // 2, int), np.ones(n // 2, int)])
    ac = np.clip(np.where(y == 1, rng.normal(0.62, 0.14, n), rng.normal(0.44, 0.14, n)), 0, 1)
    sem = np.clip(np.where(y == 1, rng.normal(0.68, 0.12, n), rng.normal(0.40, 0.12, n)), 0, 1)
    return y, ac, sem


def main() -> None:
    ap = argparse.ArgumentParser(description="三流融合权重/阈值敏感性扫描")
    ap.add_argument("--scores", type=Path, help="CSV: uuid,y,acoustic,semantic")
    ap.add_argument("--selftest", action="store_true", help="用内置 fixture 验证脚本逻辑")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()

    if args.selftest:
        y, ac, sem = selftest_scores()
        title = "=" * 78 + "\nFIXTURE 数据 —— 以下所有数字只证明脚本能跑，不可写进报告\n" + "=" * 78
    elif args.scores:
        y, ac, sem = load_scores_csv(args.scores)
        title = f"数据来源: {args.scores}（{len(y)} 人，阳性 {int(y.sum())}）"
    else:
        y, ac, sem = load_from_dataset()
        title = f"数据来源: 数据集 OOF 链路（{len(y)} 人，阳性 {int(y.sum())}）"
        # 存一份分数表：OOF 要重新训练两个模型，跑一次几分钟，不该为改一次权重重来。
        dump = BASE / "models" / "fusion_scores.csv"
        dump.parent.mkdir(parents=True, exist_ok=True)
        lines = ["y,acoustic,semantic"]
        lines += [f"{int(yy)},{aa:.6f},{ss:.6f}" for yy, aa, ss in zip(y, ac, sem)]
        dump.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"分数表已导出（下次可直接 --scores）: {dump}")

    print(title)
    result = scan(y, ac, sem)
    print_table(result, "三流扫描（行为流按先验常数取值）")

    rec = recommend(result)
    print("\n建议:")
    print(f"  AURA_FUSION3_W_BEHAVIOR={rec['w_behavior']}")
    print(f"  AURA_RISK_WATCH={rec['watch']}")
    print(f"  AURA_RISK_ELEVATED={rec['elevated']}")
    print(f"  依据: {rec['reason']}")

    print(
        "\n注意：行为流分数在真实数据里因人而异，本扫描固定为常数只为了隔离"
        "「权重/阈值」这一个变量。若行为流对个体有区分度，换档率会高于此表。"
    )

    payload = {
        "fixture": bool(args.selftest),
        "n": int(len(y)),
        "positives": int(y.sum()),
        "two_stream_weights": [settings.fusion_w_acoustic, settings.fusion_w_semantic],
        "three_stream_prior": [
            settings.fusion3_w_acoustic,
            settings.fusion3_w_semantic,
            settings.fusion3_w_behavior,
        ],
        "current_thresholds": [settings.risk_watch, settings.risk_elevated],
        "baseline": result["baseline"],
        "baseline_band_counts": result["baseline_band_counts"],
        "rows": result["rows"],
        "recommendation": rec,
        "note": "行为流无标注数据，本表是敏感性分析而非重新训练；FIXTURE 结果不可引用",
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n已写入: {args.out}")


if __name__ == "__main__":
    main()
