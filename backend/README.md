# AuraGBA 后端（湾区灵犀）— MCI/AD 多模态筛查引擎

Python / FastAPI 服务：通过分析长者日常对话语音中的**数字生物标志物**，做轻度认知障碍（MCI）与阿尔茨海默病（AD）的早期筛查，并向家属 / 护理员同步。前端契约见仓库根目录 [DEV.md](../DEV.md) §8。

> **非诊断设备。** 输出仅用于演示、评估与人工复核，不做任何自动化临床决策。

## 快速开始

```bash
cd backend
python3 -m pip install -r requirements.txt        # 核心依赖
uvicorn auragba.main:app --reload --port 8000     # 启动 API
python3 selfcheck.py                              # 可运行断言自检 → selfcheck: OK
```

- 交互式文档：`http://localhost:8000/docs`
- 元信息根路由：`GET /`
- 本机 Python 3.13；核心依赖为 `fastapi / uvicorn / pydantic / numpy / python-multipart`。

## 与前端联调

前端 `web/src/lib/api.ts` 通过 `NEXT_PUBLIC_API_BASE` 指向本服务（默认 `http://localhost:8000`），所有请求携带假名 `X-Device-Id` 头，无需 Cookie。CORS 由 `AURA_CORS_ORIGINS` 控制。

**9 个前端契约端点**

| # | 端点 | 说明 | 状态 |
|---|---|---|---|
| 1 | `POST /gait/windows` | 步态窗口（VAD/传感器派生特征） | 204 |
| 2 | `POST /screening/sessions` | 筛查会话（vector-only 摄入） | 204 |
| 3 | `POST /sos` | 紧急求助事件 | 204 |
| 4 | `GET /health-card/me` | 长者健康卡 | 200 |
| 5 | `POST /assistant/chat` | 数字人对话编排 | **501（LLM 放空）** |
| 6 | `POST /agent/cards` | Agent 卡片规划 | **501（LLM 放空）** |
| 7 | `POST /telemetry/events` | 批量埋点（服务端二次脱敏） | 204 |
| 8 | `POST /conversation/turns` | 会话记忆归档（按假名设备） | 204 |
| 9 | `POST /medication/plan` | 用药计划生成 | **501（LLM 放空）** |

返回 **501** 的 3 个 LLM 端点与前端 3 个抛 `NOT_IMPLEMENTED` 的函数一一对应，前端会自动回退到本地卡片工厂 / 本地提醒，联调不报错。

**附加洞察端点**（非前端必需）

| 端点 | 说明 |
|---|---|
| `POST /screening/analyze` | multipart 上传 WAV/FLAC，跑完整筛查链路 |
| `GET /baseline/me` | 个人 14 天基线 Z-score 报告 |
| `GET /economics/me` | STEMB：QALY 获得值 / 每患者节约成本 |
| `GET /audit/screening` | SaMD 审计日志（校验 hash 链完整性） |
| `GET /health` | 引擎版本 / 特征集版本 / 运行状态 |

## 环境变量

见 [.env.example](.env.example)：`AURA_PRIVACY_MODE`、`AURA_BASELINE_DAYS`、`AURA_FUSION_W_ACOUSTIC`、`AURA_FUSION_W_SEMANTIC`、`AURA_RISK_WATCH`、`AURA_RISK_ELEVATED`、`AURA_DATA_DIR`、`AURA_CORS_ORIGINS`。均为可选，未设置时用默认值。

## 目录结构

```text
backend/
├── requirements.txt   .env.example   selfcheck.py
└── auragba/
    ├── config.py            # 版本号 / 阈值 / 环境设置
    ├── contract.py          # Pydantic v2 契约（字段名镜像前端 camelCase）
    ├── privacy.py           # 假名化 / PII 擦除 / 提取即焚（bytearray 归零）
    ├── store.py             # 按假名 DeviceId 的每设备 JSON 存储
    ├── audit.py             # SaMD 审计：append-only JSONL hash 链 + verify()
    ├── baseline.py          # 个人 14 天基线 Z-score（normal/watch/elevated）
    ├── economics.py         # STEMB：QALY / 每患者节约成本估算
    ├── screening.py         # 全链路编排
    ├── main.py              # FastAPI 工厂 + CORS + 路由装配
    ├── audio/  io.py · vad.py · features.py      # WAV 解码 / 能量 VAD / eGeMAPS 88 维
    ├── nlp/    asr.py · metrics.py · coherence.py # ASR / TTR·名动比·句长方差 / 语义连贯度
    ├── model/  acoustic.py · semantic.py · fusion.py # 双流分类 + 晚期融合
    └── api/    contract_routes.py · insight_routes.py
```

## 四项目标理念的落地位置

1. **非侵入式数字生物标志物** — `audio/features.py`（F0、Jitter、Shimmer、F1/F2、发音/停顿比）+ `nlp/`（TTR、名动比、语义连贯度）。
2. **隐私保护管线** — `privacy.py`：`extract-and-burn`（特征提取后原始音频归零）、`vector-only` 摄入、PII 擦除、加盐 SHA256 假名化。
3. **个人基线动态追踪** — `baseline.py`：与长者专属 14 天历史基线做 Z-score 对比，而非总体固定阈值。
4. **STEMB 与 SaMD** — `economics.py`（QALY / 成本）+ `audit.py`（防篡改审计链）。

## 依赖与降级（重要）

本机**未安装** `librosa` / `soundfile` / `opensmile` / `scikit-learn` / `lightgbm` / `xgboost` / `sentence-transformers` / `jieba`，因此音频与 NLP 均以**纯 numpy 优雅降级**实现：自相关基频、Levinson-Durbin LPC 共振峰、Mel 滤波器组 + DCT 求 MFCC、正则分词、Jaccard 连贯度、可解释 logistic 打分。每个回退点用 `ponytail:` 注释标明天花板与升级路径 —— 安装对应依赖后自动切换到正式实现（openSMILE eGeMAPS / Whisper / LightGBM / sentence-transformers）。

`asr.transcribe_via_remote_api` **故意抛 `NotImplementedError`**（LLM/ASR 远程 API 按要求放空）。

## 自检覆盖

`selfcheck.py` 断言覆盖：eGeMAPS 88 槽位固定、特征有限性、WAV 往返、能量 VAD、NLP 指标、语义连贯度、双流打分、融合权重归一、基线不足/异常标记、健康经济估算、隐私擦除与内存归零、审计链防篡改、以及全链路端到端编排。