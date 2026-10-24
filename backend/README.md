# 忆伴 MemoMate 后端 — MCI/AD 多模态筛查引擎

Python / FastAPI 服务：通过分析长者日常对话语音中的**数字生物标志物**，做轻度认知障碍（MCI）与阿尔茨海默病（AD）的早期筛查，并向家属 / 护理员同步。前端契约见 [docs/dev.md](../docs/dev.md) §4。

> **非诊断设备。** 输出仅用于演示、评估与人工复核，不做任何自动化临床决策。
> 内置模型虽在公开数据集上训练，但**未经临床验证**，效力边界见「已训练模型」一节。

## 快速开始

```bash
cd backend
python3 -m pip install -r requirements.txt        # 核心依赖
# 加载 models/ 下的真实模型所需（不装则自动退回纯 numpy 兜底实现）
python3 -m pip install opensmile faster-whisper jieba lightgbm scikit-learn joblib
uvicorn auragba.main:app --env-file .env --reload --port 8000     # 启动 API
python3 selfcheck.py                              # 可运行断言自检 → selfcheck: OK
```

- 交互式文档：`http://localhost:8000/docs`
- 元信息根路由：`GET /`
- `uvicorn` 要求环境里有 `AURA_AUTH_SECRET` 与 `AURA_ENCRYPTION_KEY`（各 ≥32 字节）；`.env.example` 已带本地开发值，生产必须更换。`selfcheck.py` 是纯引擎自检，会自带一个本地测试密钥，**不需要**这两个变量。
- 本机 Python 3.13；核心依赖为 `fastapi / uvicorn / pydantic / numpy / python-multipart`；
  启用真实模型另需 `opensmile / faster-whisper / jieba / lightgbm / scikit-learn / joblib`。

> **`--env-file .env` 建议带上**：`.env`（同本机例子见 `.env.example`）指向训练好的双流模型、
> 本地 Whisper，以及在 322 人上校准过的融合权重（0.2/0.8）与风险阈值（0.409/0.521）。
> 不带它启动时，融合权重与阈值仍与 `.env` 一致（代码默认值已校准），但**两个已训练模型和本地 Whisper 不会加载**。
> 新环境先执行 `cp .env.example .env`，校准值已写在 example 里。

## 与前端联调

前端 `web/src/lib/api.ts` 通过 `NEXT_PUBLIC_API_BASE` 指向本服务（默认 `http://localhost:8000`）。首次加载会 `POST /auth/register` 建立 HttpOnly `aura_session` Cookie（原生/CLI 可用 `Authorization: Bearer`）；之后请求携带该会话与假名 `X-Device-Id` 头。**身份校验通过后**才会把请求映射到授权设备。CORS 由 `AURA_CORS_ORIGINS` 控制，必须是明确来源（`*` 会被拒绝启动）。

**15 个前端契约端点**

| # | 端点 | 说明 | 状态 |
|---|---|---|---|
| 1 | `POST /gait/windows` | 步态窗口（VAD/传感器派生特征） | 204 |
| 2 | `POST /screening/sessions` | 筛查会话（vector-only 摄入） | 204 |
| 3 | `POST /sos` | 紧急求助 + 家属通知 | **202** + `notified` |
| 4 | `GET /health-card/me` | 长者健康卡 | 200 |
| 5 | `POST /assistant/chat` | 数字人对话编排 | ⚙️ 已实现；未配置 501 |
| 6 | `POST /agent/cards` | Agent 卡片规划 | ⚙️ 已实现；未配置 501 |
| 7 | `POST /agent/turn` | Agent 工具编排 | ⚙️ 真实 LLM；未配置时 mock planner |
| 8 | `POST /telemetry/events` | 批量埋点（服务端二次脱敏） | 204 |
| 9 | `POST /conversation/turns` | 会话记忆归档（AES-GCM 加密；90 天 TTL） | 204 |
| 10 | `POST /medication/plan` | 用药计划生成 | ⚙️ 已实现；未配置 501 |
| 11 | `POST /reminders/escalate` | 提醒超时事件 + 家属 outbox | 204 |
| 12 | `POST /behaviour/daily` | 行为流日汇总（`null` 不补 0；按 day 幂等） | 204 |
| 13 | `POST /task/events` | 任务状态事件（created/completed/deferred/timeout） | 204 |
| 14 | `POST /geofence/events` | 离家/返家越界事件（与 SOS 分开，按 id 幂等） | 204 |
| 15 | `DELETE /conversation/turns/{id}` | 撤回单条会话 + 审计记录 + 基线重算标记 | 204 / 404 |

> `/sos`、`/reminders/escalate`、`/reports/weekly/send` 统一走 `notify.dispatch`：先写家属 outbox，再打印「已通知家属 N 人」；配置 `AURA_NOTIFY_WEBHOOK` 时额外推一条粗粒度通知。demo 不声称“已送达”。

> `/agent/turn` 配置模型后走 OpenAI-compatible tool calling（`AURA_LLM_TURN_TIMEOUT_S=6`）；未配置模型时回退固定 `create_task` 回显，B 仍可 `dryRun()` 联调。急救短路、未注册工具丢弃、参数校验、`confirm` 复述、3 次上限在两条路径上都生效；上游失败/超时返回 503，额度用尽返回 429，前端据此回退本地卡片。
>
> 三个 LLM 端点默认关闭（`AURA_LLM_ENABLED=false`）。未配置返回 501，上游失败/非法 JSON/超时返回 503，额度用尽返回 429；单次调用预算 6s；前端会回退本地卡片/提醒。天气由 Open-Meteo 提供，无需 Key。

**附加洞察端点**（非前端必需）

| 端点 | 说明 |
|---|---|
| `POST /screening/analyze` | multipart 上传 WAV/FLAC，跑完整筛查链路 |
| `GET /baseline/me` | 个人 14 天基线 Z-score 报告 |
| `GET /economics/me` | STEMB：QALY 获得值 / 每患者节约成本 |
| `GET /audit/screening` | SaMD 审计日志（校验 hash 链完整性） |
| `GET /health` | 引擎版本 / 特征集版本 / 运行状态 |
| `GET /reports/weekly/me` · `.html` | 长者本人 7 天周报（固定 6 段，可展开证据链） |
| `POST /reports/weekly/send` | 周报进入家属通知 outbox（202；demo 不真发） |
| `GET /caregiver/reports/weekly` · `.html` | 家属按配对关系读取长者周报 |

## 模型产物共享（协作必读）

`models/`、`data/`、`.env` **都不入库**（`.gitignore:25/32/40`），克隆下来的仓库只有代码。因此合作者之间按下面流程传递产物。

### A. 打包方（有训练产物的人）

```bash
cd backend
# 只打小体积产物；whisper-small 另打（约 460MB）
zip -r auragba-models.zip models/ -x "models/whisper-small/*"
zip -r auragba-whisper.zip models/whisper-small
cp .env.example .env            # example 已含 322 人校准值，直接用
python scripts/doctor.py        # 自检：确认待分享产物齐全
```

把 zip 放到网盘 / Release附件（**不要直接 commit**：`whisper-small/model.bin` 单文件 483MB，超过 GitHub 100MB 硬限制）。

### B. 接收方

```bash
cd backend
python -m venv .venv && ./.venv/Scripts/python.exe -m pip install -r requirements.txt
./.venv/Scripts/python.exe -m pip install opensmile faster-whisper jieba lightgbm scikit-learn joblib
# 解开 zip 到 backend/models/，然后
cp .env.example .env
./.venv/Scripts/python.exe scripts/doctor.py        # 应显示两个模型 OK + sha256
./.venv/Scripts/python.exe selfcheck.py             # selfcheck: OK
uvicorn auragba.main:app --env-file .env --reload --port 8000
```

> **不确定本机缺什么时先跑 `python scripts/doctor.py`**：它会逐项列出 Core 依赖、重依赖、
> `models/` 产物（含 SHA256 前 8 位，与审计链里的模型指纹对齐）、`data/` 数据集与 `.env` 是否用了校准值。

### C. 校验一致性（防止「以为在跑真模型其实在跑兜底」）

两边跑 `doctor.py` 后比对 `acoustic_lgbm.txt` 的 `sha256:` 前 8 位——该值与
`screening.py` 写入审计记录的 `models.acousticFile.sha256_8` 同源，历史分数因此可追溯。

---

## 环境变量

见 [.env.example](.env.example)（模板）。**`AURA_AUTH_SECRET` 必填**（≥32 字节，未设置时服务拒绝启动）；其余变量未设置时用 `config.py` 的默认值。

> `.env.example` 里已经写入**校准值**（融合 0.2/0.8、阈值 0.409/0.521）与一个本地开发用 `AURA_AUTH_SECRET`，`cp .env.example .env` 即复现附录中的行为；
> `config.py` 的**代码默认值已与校准值一致**（docs/dev.md §4 C0），所以不设变量直接跑也不会掉回未校准配置。

| 变量 | 说明 | 默认值 |
|---|---|---|
| `AURA_AUTH_SECRET` | HMAC 会话签名密钥，**必填**（≥32 字节） | 无（缺失即拒绝启动） |
| `AURA_ENCRYPTION_KEY` | 会话文字 AES-GCM 密钥，**必填**（≥32 字节） | 无（缺失即拒绝启动） |
| `AURA_CONVERSATION_TTL_DAYS` | 会话记忆保留天数（`scripts/purge.py`） | 90 |
| `AURA_REGULATORY_CLAIM_LEVEL` | 声称档位：`observation` / `triage_support`（`diagnostic` 被拒绝） | `observation` |
| `AURA_COOKIE_SECURE` | 生产 HTTPS 会话 Cookie；`AURA_ENV=production` 时强制为 `true` | `false` |
| `AURA_ACOUSTIC_MODEL` | 声学流模型路径（`./models/acoustic_lgbm.txt`） | 空 → 手工权重兜底 |
| `AURA_SEMANTIC_MODEL` | 语义流模型路径（`./models/semantic_lr.joblib`） | 空 → 手工权重兜底 |
| `AURA_WHISPER_MODEL` | Whisper 模型名或本地目录（`./models/whisper-small`） | `tiny` |
| `AURA_PRIVACY_MODE` | `extract-and-burn` / `vector-only` | `extract-and-burn` |
| `AURA_BASELINE_DAYS` | 个人基线窗口（天，robust Z） | 14 |
| `AURA_TREND_DAYS` | 趋势斜率与 CUSUM 的回看窗口（天） | 28 |
| `AURA_NOTIFY_WEBHOOK` | demo 通知 webhook（留空 = 只写 outbox + 日志） | 空 |
| `AURA_FUSION_W_ACOUSTIC` / `AURA_FUSION_W_SEMANTIC` | 两流融合权重（行为流缺失时使用，自动归一） | 0.2 / 0.8 |
| `AURA_FUSION3_W_ACOUSTIC` / `_SEMANTIC` / `_BEHAVIOR` | 三流初始先验（行为流存在时使用，自动归一） | 0.15 / 0.65 / 0.20 |
| `AURA_RISK_WATCH` / `AURA_RISK_ELEVATED` | 风险分档切点 | 0.409 / 0.521 |
| `AURA_DATA_DIR` | 假名存储 / 审计日志目录 | `./.data` |
| `AURA_CORS_ORIGINS` | 允许的 CORS 源（逗号分隔，禁止 `*`） | `http://localhost:3000,http://localhost:8000` |
| `AURA_LLM_ENABLED` | 是否启用三个 LLM 端点 | `false` |
| `AURA_LLM_BASE_URL` | OpenAI-compatible 基址 | `https://api.deepseek.com/v1` |
| `AURA_LLM_API_KEY` | 模型 API Key（本地 Ollama 可留空） | 空 |
| `AURA_LLM_MODEL` | 模型名 | `deepseek-chat` |
| `AURA_LLM_TIMEOUT_S` | 单次 LLM 超时（秒） | 6 |
| `AURA_LLM_TURN_TIMEOUT_S` | `/agent/turn` 工具规划超时（秒） | 6 |
| `AURA_LLM_MAX_TOKENS` | 单次最大输出 token | 400 |
| `AURA_LLM_DAILY_QUOTA` | 每设备每日调用上限（0 = 不限） | 200 |
| `AURA_WEATHER_ENABLED` | 是否使用 Open-Meteo 实时天气 | `true` |
| `AURA_WEATHER_TTL_S` | 天气缓存秒数 | 600 |

`.env` 与 `config.py` 默认值现在**都是校准值**（融合 0.2/0.8、阈值 0.409/0.521），
无论是否带 `--env-file .env` 启动，同一输入都会得到同一 `riskBand`。校准来源见「已训练模型」一节。

## 目录结构

```text
backend/
├── requirements.txt   .env.example   .env   selfcheck.py
├── scripts/                 # 训练与评估（离线运行，非服务依赖）
│   ├── train_acoustic_model.py    # eGeMAPS 特征 -> LightGBM
│   ├── train_semantic_model.py    # 语言学特征 -> LogisticRegression
│   ├── eval_fusion.py             # 端到端融合评估 + 阈值校准
│   ├── purge.py                   # 会话记忆 TTL 清理（cron / Task Scheduler 每日跑）
│   └── doctor.py                  # 环境/产物体检（协作排障第一步）
├── models/                  # 训练产物（.env 指向它们；*_report.json 为评估指标）
│   ├── acoustic_lgbm.txt          semantic_lr.joblib
│   └── whisper-small/             # 本地 ASR 权重（离线可用）
├── data/                    # 训练数据集（**gitignored**，仅 scripts/ 使用，不参与运行时）
│   └── Alzheimer-s-disease-datasets-master/
└── auragba/
    ├── config.py            # 版本号 / 阈值 / 环境设置
    ├── contract.py          # Pydantic v2 契约（字段名镜像前端 camelCase）
    ├── privacy.py           # 假名化 / 会话鉴权依赖 / PII 擦除 / 提取即焚
    ├── auth.py              # HMAC 会话、角色校验、长者-家属配对
    ├── auth_store.py        # SQLite：账号、配对码、失败锁定、家属关系
    ├── notifications.py     # 家属 notification_outbox（推送 provider 的接缝）
    ├── notify.py            # 通知分发：outbox + 「已通知家属 N 人」日志 + 可选 webhook
    ├── crypto.py            # AES-GCM：会话文字静态加密（AAD 绑定 device+turn）
    ├── anonymity.py         # k≥20 聚合导出闸门 + 相邻层合并
    ├── store.py             # SQLite（WAL）：派生特征/事件按设备+类型+时间索引
    ├── audit.py             # SaMD 审计：append-only JSONL hash 链 + verify()
    ├── baseline.py          # 个人 14 天基线 Z-score（normal/watch/elevated）
    ├── economics.py         # STEMB：QALY / 每患者节约成本估算
    ├── screening.py         # 全链路编排
    ├── main.py              # FastAPI 工厂 + CORS + 路由装配
    ├── audio/  io.py · vad.py · features.py      # WAV 解码 / 能量 VAD / eGeMAPS 88 维
    ├── nlp/    asr.py · metrics.py · coherence.py # ASR / TTR·名动比·句长方差 / 语义连贯度
    ├── model/  acoustic.py · semantic.py · behavior.py · fusion.py # 三流分类（行为规则流 / 模型指纹 / SHAP）+ 晚期融合
    ├── llm/    client.py · prompts.py · safety.py · weather.py · usage.py · service.py
    ├── reports/ weekly.py                      # 家属周报（6 段 + HTML 渲染）
    └── api/    contract_routes.py · insight_routes.py · auth_routes.py · caregiver_routes.py · report_routes.py
```

## 四项目标理念的落地位置

1. **非侵入式数字生物标志物** — `audio/features.py`（F0、Jitter、Shimmer、F1/F2、发音/停顿比）+ `nlp/`（TTR、名动比、语义连贯度）。
2. **隐私保护管线** — `privacy.py`：`extract-and-burn`（特征提取后清零解码用的可变缓冲；**best-effort，原始上传字节不可变且不落盘**）、`vector-only` 摄入、PII 擦除、加盐 SHA256 假名化。
3. **个人基线动态追踪** — `baseline.py`：与长者专属 14 天历史基线做 Z-score 对比，而非总体固定阈值。
4. **STEMB 与 SaMD** — `economics.py`（QALY / 成本）+ `audit.py`（防篡改审计链）；
   每条筛查记录还会写入**模型来源指纹**（`screening.py`：模型文件路径、SHA256 前 8 位、是否加载成功），
   使历史分数在换模型后仍可追溯「是哪个模型文件打的」。

## 依赖与降级（重要）

引擎有两条运行路径，按「已装依赖 + 环境变量」自动切换：

| 环节 | 真模型路径（`.env` 默认） | 纯 numpy 兜底 |
|---|---|---|
| 声学特征 | openSMILE 真 eGeMAPS（88 维 + 附加列） | 自相关基频、Levinson-Durbin LPC 共振峰、Mel 滤波器组 + DCT 求 MFCC |
| 声学打分 | LightGBM booster + SHAP 逐项贡献 | 手工权重可解释 logistic |
| ASR | 本地 Whisper（`models/whisper-small`） | 无转写 → 语义流缺席 |
| 语义打分 | LogisticRegression（`semantic_lr.joblib`） | 手工权重可解释 logistic |
| 行为打分 | B 的 `POST /behaviour/daily` 日汇总 + 规则权重（个人 median/MAD） | 无日汇总 → 行为流缺席，两流融合照常 |
| 中文 NLP | jieba 分词 / 词性 | 正则分词 |
| 语义连贯度 | sentence-transformers 句向量 | Jaccard 相似度 |

缺少任一依赖或模型路径为空时，引擎**优雅降级**到纯 numpy 实现，服务照常启动。
每个回退点用 `ponytail:` 注释标明天花板与升级路径 —— 装齐依赖即自动切换到正式实现。

两条路径的**特征摘要键已统一**：`audio/features.py` 把 openSMILE 的 eGeMAPS 原名归一为
snake_case 规范键，并补上 openSMILE 不直接产出的 VAD 节律特征（语速、停顿、voiced 占比）。
因此下游 `baseline.py` 的 `TRACKED` 表与手工权重表在两种后端下行为一致，不会静默丢指标。

> **装了 openSMILE 才与训练数据同分布**：声学模型是用真 eGeMAPS 训练的，
> 拿 numpy 近似特征喂它会错位。语义流则相反——不装 Whisper 就彻底没有转写输入。
>
> **不会静默退回**：模型路径已设但加载失败时会打印 `[auragba][WARN]`，
> 并把 `LOAD-FAILED` 写进分数标签与审计指纹，避免「以为在跑真模型其实在跑兜底」。

`asr.transcribe_via_remote_api` **故意抛 `NotImplementedError`**（远程 ASR 仍未接入）。  
LLM 编排是独立模块 `llm/`：默认关闭，启用后调用 OpenAI-compatible 接口；包含急救词短路、禁止诊断/荐药、药名来源校验、JSON 校验与一次修复、按设备日额度。

## 已训练模型（非临床验证）

`models/` 下的双流模型在中文阿尔茨海默语音数据集 `lzy1012/Alzheimer-s-disease-datasets`
（322–323 名被试，AD 与 MCI 均归为阳性）上训练，指标见同目录 `*_report.json`：

| 流 | 模型 | 特征 | CV5 AUC | LOO AUC |
|---|---|---|---|---|
| 声学 | LightGBM（`acoustic_lgbm.txt`） | eGeMAPS 88 维 | 0.604 | 0.653 |
| 语义 | LogisticRegression（`semantic_lr.joblib`） | TTR / MATTR / 名动比 / 句长方差 / filler 比 | 0.708 | 0.698 |
| **融合**（0.2/0.8 校准） | — | 双流 late fusion | **AUC 0.717** | — |

`scripts/eval_fusion.py` 在 322 人上交叉拟合校准出 `.env` 里的四个数字：
融合权重 0.2/0.8、`WATCH=0.409`、`ELEVATED=0.521`。watch 档敏感度 0.863、特异性 0.396——
**筛查取向**：宁可多提示转介，也不漏掉疑似个案。

复现训练：

```bash
python scripts/train_acoustic_model.py     # -> models/acoustic_lgbm.txt + 训练报告
python scripts/train_semantic_model.py     # -> models/semantic_lr.joblib + 训练报告
python scripts/eval_fusion.py              # -> models/fusion_eval_report.json
```

数据集默认读取 `backend/data/Alzheimer-s-disease-datasets-master/`；它**不入库**（`.gitignore`），
放在别处时用 `AURA_DATASET_DIR` 指过去：

```bash
AURA_DATASET_DIR=/path/to/Alzheimer-s-disease-datasets-master python scripts/train_acoustic_model.py
```

> **效力边界（对外讲述务必诚实）**：单一数据集、样本 322 人、阳性占比 66%，
> AUC ≈ 0.72 属弱信号；融合后 F1 与「全预测阳性」的基率基线相当，
> 因此应讲 **AUC 与敏感度**，不要讲 F1。该评估是离线复现线上链路，**不是临床验证**。

## 自检覆盖

`selfcheck.py` 断言覆盖：特征有限性、WAV 往返、能量 VAD、NLP 指标、语义连贯度、双流打分、融合权重归一、基线不足/异常标记、健康经济估算、隐私擦除与内存归零、审计链防篡改、以及全链路端到端编排。

引擎现在兼容两种特征后端，因此相关断言按后端分支校验：

- `backend` 为 `numpy` 或 `opensmile` 均通过；特征数断言为 **≥ 88**（openSMILE 会附带额外列）；
- 两个后端都必须产出同一套规范摘要键，且 `speech_ratio` 是真实 VAD 比值而非硬编码；
- 可解释贡献分解只在兜底路径（`linear-interpretable`）断言；真模型路径改验 booster 标签。