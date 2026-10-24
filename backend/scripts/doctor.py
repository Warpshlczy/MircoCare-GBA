"""
MemoMate (忆伴) 环境体检脚本（协作用）

解决一个协作痛点：`backend/models/`、`backend/data/`、`backend/.env` 都不入库
（见 .gitignore:25/32/40），克隆下来的仓库是「有代码无产物」。本机究竟缺什么、
缺的依赖跑起来会不会静默降级、模型文件有没有传全，用这一条命令查清：

    python scripts/doctor.py

检查项：
  1. Core 依赖（起服务必需）
  2. 重依赖（加载真模型必需，缺则走 ponytail 降级路径）
  3. models/ 产物是否到位 + SHA256 前 8 位（与审计链里的模型指纹对齐）
  4. data/ 训练数据集是否到位（仅 scripts/ 训练用，不参与运行时）
  5. .env 是否存在 / 是否用的是校准值

退出码 0 = 可正常起服务；1 = 有阻塞项。
"""
import hashlib
import importlib
import os
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
DATASET_DIR = Path(os.getenv("AURA_DATASET_DIR", BASE / "data" / "Alzheimer-s-disease-datasets-master"))

CORE = ["numpy", "pydantic", "fastapi", "uvicorn", "starlette", "multipart"]
HEAVY = {
    "opensmile": "真 eGeMAPS 特征（缺则声学模型吃错位特征！）",
    "lightgbm": "加载 models/acoustic_lgbm.txt",
    "sklearn": "加载 models/semantic_lr.joblib",
    "joblib": "同上（反序列化）",
    "jieba": "中文分词 / 名动比",
    "faster_whisper": "本地 ASR（缺则语义流缺席）",
    "pandas": "Scripts 训练/评估用",
}
MODELS = ["acoustic_lgbm.txt", "semantic_lr.joblib"]
MODEL_REPORTS = ["acoustic_train_report.json", "semantic_train_report.json", "fusion_eval_report.json"]


def check_core() -> bool:
    print("── Core 依赖（起服务必需）")
    ok = True
    for m in CORE:
        try:
            mod = importlib.import_module(m)
            print(f"  OK   {m:<12} {getattr(mod, '__version__', '')}")
        except Exception:
            print(f"  MISS {m:<12} ← pip install {'python-multipart' if m == 'multipart' else m}")
            ok = False
    return ok


def check_heavy() -> None:
    print("\n── 重依赖（缺则从 ponytail 路径降级，服务仍可起）")
    missing = []
    for m, why in HEAVY.items():
        try:
            mod = importlib.import_module(m)
            print(f"  OK   {m:<16} {getattr(mod, '__version__', '')[:12]:<12} ({why})")
        except Exception:
            missing.append(m)
            print(f"  --   {m:<16} 缺 → {why}")
    if missing:
        print(f"\n  一次性补齐: pip install {' '.join(missing)}")


def _sha8(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:8]


def check_models() -> None:
    print("\n── models/ 产物（不入库，需从合作者处获取，见 README「模型产物共享」）")
    mdir = BASE / "models"
    if not mdir.exists():
        print("  MISS backend/models/ 目录不存在")
        return
    for name in MODELS:
        p = mdir / name
        if p.exists():
            print(f"  OK   {name:<22} {p.stat().st_size/1024:>8.1f} KB   sha256:{_sha8(p)}")
        else:
            print(f"  MISS {name}")
    for name in MODEL_REPORTS:
        p = mdir / name
        if p.exists():
            print(f"  OK   {name:<22} {p.stat().st_size/1024:>8.1f} KB")
    whisper = mdir / "whisper-small"
    print(f"  {'OK  ' if whisper.exists() else 'MISS'} whisper-small/（本地 ASR 权重）")


def check_data() -> None:
    print("\n── data/ 训练数据集（仅训练脚本用）")
    key = DATASET_DIR / ".github" / "workflows" / "egemaps_final.csv"
    labels = DATASET_DIR / ".github" / "workflows" / "2_final_list_train.csv"
    print(f"  数据集根目录: {DATASET_DIR}")
    print(f"  {'OK  ' if key.exists() else 'MISS'} egemaps_final.csv")
    print(f"  {'OK  ' if labels.exists() else 'MISS'} 2_final_list_train.csv")
    if not key.exists():
        print("  → 重训需要它；AURA_DATASET_DIR 可指向别处")


def check_env() -> None:
    print("\n── .env（不入库）")
    env = BASE / ".env"
    example = BASE / ".env.example"
    if not env.exists():
        print("  MISS backend/.env")
        print(f"  → 生成: cp {example.name} .env（example 已含 322 人校准值 0.2/0.8、0.409/0.521）")
        return
    print(f"  OK   backend/.env ({env.stat().st_size} bytes)")
    text = env.read_text(encoding="utf-8", errors="ignore")
    for k, calibrated in (("AURA_FUSION_W_ACOUSTIC", "0.2"), ("AURA_RISK_WATCH", "0.409")):
        line = next((l for l in text.splitlines() if l.startswith(k)), "")
        val = line.split("=", 1)[-1].strip() if "=" in line else ""
        flag = "校准值" if val == calibrated else f"非校准值(非 {calibrated}，可能是默认值)"
        print(f"       {k}={val or '<未设>'}  → {flag}")


def main() -> int:
    print(f"MemoMate doctor  |  interpreter: {sys.executable}\n")
    core_ok = check_core()
    check_heavy()
    check_models()
    check_data()
    check_env()
    print()
    if not core_ok:
        print("结论：Core 依赖缺失，服务无法启动。先 pip install fastapi uvicorn[standard] pydantic numpy python-multipart")
        return 1
    print("结论：Core 依赖齐全，服务可启动（是否跑真模型取决于上面的重依赖与 models/）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
