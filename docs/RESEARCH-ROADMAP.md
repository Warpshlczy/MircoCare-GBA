# AuraGBA 研究知识汇总与开发路线图

> 本文档回答四个问题：① 接下来开发什么；② 必读哪些论文/数据；③ 哪些方向值得注意；④ 如何在**长时间尺度**上根据老年人行为变化做检测（成熟方案与论文）。
> 与 DEV.md 互补：DEV.md 记录「已交付什么」，本文档记录「下一步往哪走、依据是什么」。

---

## 0.5 当前工程进度（截至 2026-10-16，commit `f8b5b10`）

合作者 `wh-violet667` 已提交 **双流模型训练 + 筛查管线升级**（2026-10-16），工程从「兜底打分层」进入「有真实模型的可用层」。

### 已落地

| 项 | 内容 |
|---|---|
| 训练脚本 | `backend/scripts/`：`train_acoustic_model.py`（eGeMAPS→LightGBM）、`train_semantic_model.py`（语言学特征→LogisticRegression）、`eval_fusion.py`（交叉拟合融合评估+阈值校准） |
| 训练数据 | `lzy1012/Alzheimer-s-disease-datasets`（**中文**语音数据，322–323 人；AD+MCI 归为阳性，阳性占比 66%） |
| 模型指标 | 声学 CV5 AUC 0.604 / LOO 0.653；语义 CV5 0.708 / LOO 0.698；**双流融合（0.2/0.8）AUC 0.717** |
| 阈值校准 | `WATCH=0.409` / `ELEVATED=0.521`（322 人交叉拟合），watch 档敏感度 0.863 / 特异性 0.396（筛查取向：宁可多转介不漏） |
| 版本号 | `ENGINE_VERSION=0.2.0`、`FEATURE_SET_VERSION=egemaps88-v2`、`FUSION_VERSION=latefusion-v2` |
| 特征口径统一 | `audio/features.py` 把 openSMILE 原名归一为 snake_case 规范键，补齐 VAD 节律特征；numpy 兜底与 openSMILE 两条路径产出**同一套摘要键**，不会静默丢指标 |
| 模型溯源 | `screening.py` 在审计记录里写入模型文件指纹（路径 + SHA256 前 8 位 + 是否加载成功）；加载失败标 `LOAD-FAILED`，绝不静默退回兜底 |

### 2026-10-24 工程增量（接入与适老功能）

| 项 | 内容 |
|---|---|
| 鉴权统一 | 契约端点支持 HttpOnly `aura_session` Cookie（原生可 Bearer）；注册按 `(role, device)` 幂等，修复重复注册 500 |
| 复诊提醒 | `ReminderItem.kind="followup"` + 大字号日期表单；复用 10/30 分钟升级与家属 outbox |
| 随手记 | 「记住… / 我记低咗咩」纯本地 IndexedDB `notes`，不上传；TTS 复述最近一条 |
| 语音筛查入口 | 工具面板 60 秒筛查 → `POST /screening/sessions`（仅 RMS/VAD 派生特征） |
| 数据接线 | 步态窗口上传 + 启动重放；健康卡读 `/health-card/me`；家属端展示筛查次数与通知记录 |
| SOS 诚实态 | 发送中 / 已记录 / 失败三态 + 重试 + 急救号码拨号兜底，不再假装已通知 |

### 三个必须补上的缺口（重点）

1. **产物与数据都不在仓库里**：`backend/models/`、`backend/data/`、`backend/.env` 全部被 `.gitignore`（规则在 `.gitignore:25/32/40`），克隆后本地是空的。
   → README 写着「仓库内 `.env` 已配置好」与实际不符，协作时会踩坑。
2. **本机缺的是 FastAPI 服务栈，不是整个 Python 环境**（2026-10-16 复测更正）
   本机有 3 个解释器：`C:\Python314`（3.14.7，numpy 2.5.3 / pandas / pydantic）、`D:\python3.12`（3.12.10，numpy 2.5.1 / pydantic / **scikit-learn 1.9.0 / joblib 1.5.3**）、`AppData\Local\Python`（3.14.6）。
   **三个都缺**：`fastapi / uvicorn / starlette / python-multipart` → 因此 `selfcheck.py` 与 `uvicorn` 目前都起不来。
   真模型另缺：`lightgbm`（加载 acoustic_lgbm.txt）、`opensmile`（**必须**，见问题 3）、`jieba`、`faster-whisper`。
   → 推荐以 **`D:\python3.12`** 作为后端基准解释器（已有 sklearn+joblib，语义流要件半满足），在此基础上建隔离 venv。
3. **声学模型要求特征同分布**：模型用真 eGeMAPS 训练，**推理端必须装 openSMILE**，否则喂进去的是 numpy 近似特征，分数会错位（README 已警告）。

### 与路线图的对应关系

这一轮完成的是 **§3.1 第 1 层的「横断面」部分**——把 AD/MCI vs 对照的分类能力从手工权重升级为 trained 模型。**长时间尺度检测（个体基线升级、CPD、变异性轨迹）尚未开始**，仍是 Phase 0–2 的核心任务。反过来说，现在有了可打的「单次风险基线」，纵向检测才有了一个有意义的、跨天可比的即时指标。

> 效力边界请照 README 口径对外：**AUC ≈ 0.72 属弱信号、单一数据集、非临床验证，讲 AUC 与敏感度，不讲 F1**。

---

## 0. 项目定位（先把目标钉死）

AuraGBA 的科学内核不是「一次语音筛查打分」，而是：

> **在数月—数年的时间尺度上，以纯软件方式持续追踪长者的行为基线，检测个体内（within-person）的行为漂移，作为 MCI / 早期 AD 的数字预警。**

这一句话决定了所有技术选型：单次横断面分类（cross-sectional classification）价值有限，**纵向、个体化、无感**才是差异化。现有代码里 `backend/auragba/baseline.py`（14 天个人基线 Z-score）正是这个内核的雏形。

---

## 1. 必读论文清单（按优先级分层）

### 1.1 纵向行为变化检测（核心方法论，必读）

| # | 论文/项目 | 关键内容 | 对我们的意义 |
|---|---|---|---|
| 1 | **ORCATECH 平台**：Kaye et al., *"Intelligent Systems for Assessing Aging Changes"* (ISAAC, JNHA 2011)；以及 *Pervasive Computing Technologies to Continuously Assess AD Progression* (PMC4462097) | 480+ 家庭、最长 8 年连续居家监测；测量步速、活动量、服药依从、电脑使用、睡眠、社交 | **业界最成熟的长时程方案**。证明了个体内分布（individual-specific distributions）可以远小于传统神经心理测验所需样本量地检测 MCI 轨迹 |
| 2 | **Dodge et al.**（ORCATECH 团队）：in-home walking speed / computer use 预测 MCI 转变；CTAD 2019 复现海报 | 用「周级步速变异系数 COV」「个人前 3 个月基线的低分位阈值命中率」作为结局指标；计算机使用指标只需 ~26–38 人即可达到传统认知测验 ~900–1900 人的检验效能 | **方法论模板**：基线期取个人分布 → 定义「低表现阈值」（如个人 10th/40th 分位）→ 用广义混合模型建模「命中低阈值的概率随时间的斜率」。可直接移植到 `baseline.py` |
| 3 | **CART Initiative**（NIH/VA，OHSU+Rush+迈阿密+VA 四站点） | ORCATECH 平台的多站点推广；EVALUATE-AD 试验用居家监测做 AD 药物试验的疗效结局 | 证明方案可复制、正被药企用于临床试验，合规与工程细节值得跟进 |
| 4 | **VIBE 模型**：*Capturing Cognitive Aging in Vivo* (JMIR 2022, e38130) | 提出「个体内变异性的倒 U 曲线」假说：健康→MCI 阶段日常行为**变异性上升**（代偿机制挣扎），MCI→痴呆阶段在复杂任务上变异性反而**下降**（能力塌陷，任务失败/遗漏） | **最重要的理论框架**：不能只盯均值漂移，「变异性先升后降」本身是分阶段的信号。还附了可测指标清单（mobility/sociability/device activity 三大类） |
| 5 | **X-BCD**: *Explainable Sensor-Based Behavioral Change Detection*（2026 预印本，tomesphere） | 无监督 **变化点检测（CPD）+ 例行行为聚类演化追踪 + 医疗微调 LLM 生成自然语言解释**；在真实 MCI 居家数据上验证 | 与我们「Agent 生成卡片/解释」的形态天然契合：检测到的行为重组 → LLM 转译为照顾员可读的描述 |
| 6 | **Sprint et al. 2020**（BCD：Behavioral Change Detection） | 传感器行为变化检测的 drift score 方法学 | CPD 的工程参考基线 |
| 7 | *Spontaneous Speech as a Scalable Digital Biomarker for Monitoring Cognitive Change*（2025，Research Square） | 把 **MDC（Minimal Detectable Change，最小可检测变化）** 框架扩展到语音 ML 预测：自发语音预测对个体内认知变化的敏感度可媲美简短认知测验 | 支撑「每日唠嗑语音 → 纵向认知监测」的科学合法性；MDC 是我们给筛查结果定「多大幅度才算真变化」的标准 |
| 8 | *Employing Deep-Learning Approach for the Early Detection of MCI Transitions*（Sensors 2023, 23(21):8867) | 把活动度量做成时间序列统计 → LSTM 预测 MCI 转变 | 时序建模参考（我们数据量小时慎用深度学习，见 §4） |

### 1.2 语音 / 语言模态（粤语·普通话场景）

| # | 论文 | 关键内容 |
|---|---|---|
| 9 | **MOPSA**（Interspeech 2025, CUHK 刘循英组） | Whisper + prompt-expert 混合的零样本说话人自适应；在**粤语 JCCOCC MoCA** 和英语 DementiaBank Pitt 上验证，CER 降 1.47% |
| 10 | **Decoding-while-Adapting**（CUHK, arXiv 2606.16539） | 在线跨话语音文提示自适应，RTF 加速至 9.83×，无需 enrollment |
| 11 | **DementiaBank 协议论文**（Lanzi et al. 2023, *Alzheimer's & Dementia*） | 标准化话语协议（图片描述/故事叙述/程序性/个人叙述）+ Delaware corpus |
| 12 | **非侵入式语音检测综述**（PMC10484224, 2023） | 最实用的数据集/特征/语言全景表，含中文数据分布 |
| 13 | **DePaul 痴呆对话机器人**（arXiv:2502.10896, 2025） | 微调 LLM 实时提取 6 类言语生物标志物（语法改变、语用受损、命名困难、轮次转换紊乱、含糊发音、韵律变化），<1.5s，PWA 前端——**形态与 AuraGBA 几乎同构** |
| 14 | **LLM chatbot 早筛**（IEEE PDGC 2024, Routray et al.） | LLM 对话语言信号早筛，敏感度 85%/特异度 88%（n=500） |

### 1.3 被动感知 / 数字表型平台（架构参考）

| # | 项目/论文 | 关键内容 |
|---|---|---|
| 15 | **TechSANS**（UT Austin，Innovation in Aging 2026 + arXiv:2509.23158） | iOS 被动感知：147 项特征/6 大类；**打字保持时间方差、步行不对称性**与 MCI 显著相关（p<.05）；给出了完整的清洗管线 |
| 16 | **Care-MOVE**（Univ. Bari, Applied Sciences 2026） | 手机传感器+认知评估多模态数据集，LOUO 交叉验证范式 |
| 17 | **Beiwe**（onnela-lab，Harvard）/ **mindLAMP**（BIDMC） | 开源数字表型平台（采集端+后端+分析库 forest），隐私与缓冲上报架构参考 |
| 18 | **RADAR-base**（EU RADAR-CNS） | 最成熟的开源远程监测平台（Kafka 流式后端），工程参考 |

### 1.4 背景与合规

- FDA-NIH **BEST 框架**（Biomarkers, EndpointS and other Tools）：数字生物标志物的验证语境（context of use）定义——决定我们的话术边界（「预警/筛查」而非「诊断」）。
- 工信部《移动互联网应用（APP）适老化通用设计规范》：适老版主组件 ≥60dp、文字 ≥18dp（可调至 30dp）、行距 ≥1.3、对比度 ≥4.5:1、不限时操作、颜色不作唯一信息载体。
- HK PDPO / 澳门 PDPA / PIPL：已有隐私契约（api.ts 头部），存储与跨境传输需持续对齐。

---

## 2. 数据集全景（full access 优先）

| 数据集 | 模态 | 语言 | 规模 | 获取方式 | 对 AuraGBA 的用途 |
|---|---|---|---|---|---|
| **DementiaBank**（TalkBank） | 语音+转写 | 英/德/**普通话(Lu: 52 AD)**/**台湾话(16 AD)**/西 | 310 AD + 241 对照 | 免费会员注册 | 中文语音标志物训练/验证 |
| **ADReSS / ADReSSo / ADReSS-M** | 语音（增强） | 英（-M 含希腊语） | ~150/集 | DementiaBank 会员 | 挑战赛基准、方法复现 |
| **NCMMSC2021** | 语音+转写 | **普通话** | 26 AD / 54 MCI / 44 对照 | 竞赛渠道 | 普通话 MCI 基线 |
| **JCCOCC MoCA** | 语音访谈 | **粤语** | 256 段 | 联系 CUHK 团队 | **大湾区核心数据**，MoCA 标签直接对口筛查 |
| **CASAS 系列**（Zenodo） | 智能家居环境传感器 | — | 179 人×24 任务（含诊断）；328 人错误注入集 | **Zenodo 完全开放，免申请** | 行为变化/任务错误检测方法的开发与验证（无需等自有数据） |
| **PREPARE Challenge Acoustic Track**（DrivenData） | 语音 | 英 | 竞赛规模 | DementiaBank 条款下开放 | 声学特征基准 |
| **Delaware corpus** | 视频+语音+转写 | 英 | 20 对照 + 33 MCI | DementiaBank | 话语协议参考 |
| TechSANS / Care-MOVE | 手机被动感知 | — | 21/53 人 | **不开放**（仅能引用特征设计） | 特征清单参考 |

> 缺口：**没有「粤语 + 手机被动行为 + 认知标签」的公开纵向数据集**。这既是风险也是机会——我们的架构（BYOD 手机 + 隐私优先派生特征）正是为填补这个缺口设计的，前期可用 CASAS + DementiaBank 中文子集 + JCCOCC 做方法开发，标签问题通过合作/试点解决。

---

## 3. 长时间尺度行为变化检测：成熟方案与方法论（核心问题）

结论先行：**成熟方案存在，且其方法论可以直接映射到我们的代码**。

### 3.1 已被验证的四层方法论

**第 1 层：个体基线（已有雏形 → 需升级）**
ORCATECH 的关键发现：用**个人自身前 1–3 个月数据建立个体分布**，而非群体常模（group norms）。个人分布 1–3 个月即可稳定（每受试者 ~1000 个数据点）。
→ 我们 `baseline.py` 的 14 天 Z-score 方向正确，但应升级为：**个人分位数分布 + 周粒度滑动窗口**。

**第 2 层：阈值命中 / 漂移检测**
- 个人化低表现阈值（如步速 < 个人 10th 分位、电脑使用 < 个人 40th 分位）的**命中率随时间的斜率**（广义线性混合模型 GLMM）——Dodge et al. 的核心指标。
- **变化点检测（CPD）**：对每条行为维度独立做无监督 CPD，得到「何时变了」；X-BCD 再加「聚类演化追踪」回答「怎么变的」（例行行为持续/漂移/涌现/消失）。
- **MDC 框架**：变化幅度必须超过该指标的最小可检测变化，才排除测量噪声——给「预警」一个统计学门槛，避免误报。

**第 3 层：变异性作为独立信号（VIBE 模型）**
不只看均值漂移：**日间变异性（day-to-day variability）先升后降**是阶段转换的标志。工程含义：每个特征同时维护均值轨迹和变异性轨迹（如周 COV），两条轨迹都要做 CPD。

**第 4 层：可解释转译**
检测结果 → 医疗微调 LLM → 照顾员可读的自然语言描述（X-BCD 范式）。我们的 Agent 卡片引擎天然是输出口：「本周阿婆的步速波动比她自己上个月明显增大」而不是一个 Z-score 数字。

### 3.2 可监测的行为域与对应手机信号（按证据强度排序）

| 行为域 | 证据 | 手机可采集信号（纯软件） | 现有代码触点 |
|---|---|---|---|
| 步速/步态变异性 | ORCATECH 多年队列；TechSANS（步行不对称 p=.04） | DeviceMotionEvent 步频/cv（已有）、步行不对称 | `signal.ts` / `motion.ts` / `postGaitWindow` |
| 自发语音标志物 | DementiaBank 30+ 年文献；MDC 框架验证 | 每日唠嗑语音的派生特征（eGeMAPS、停顿、TTR/填充词比） | `screening.py` / `nlp/metrics.py` / §5.9 每日签到 |
| 打字动态 | TechSANS（按键保持时间方差 p=.03） | 文字输入通道的按键间隔（派生量，不记内容） | 工具面板文字输入（§5.6），需新增特征 |
| 服药依从性 | ORCATECH 电子药盒 | 提醒确认/推迟/超时模式（已有升级状态机） | `useReminder` / `escalationFor` |
| 社交/互动参与 | VIBE；iCONECT 研究 | 与数字人对话的频率、时长、主动发起比、回答长度 | `conversation` store / `postConversationMemory` |
| 日常任务完成质量 | CASAS（任务错误类型：遗漏/替代/无关/低效） | 待办卡完成模式、卡片交互序列 | `CardBoard` / 埋点 `analytics.ts` |
| 睡眠/昼夜节律 | CART | 手机使用时段分布（粗粒度，非内容） | 埋点时间戳聚合 |
| 移动范围 | VIBE mobility 域 | 步数、离家时段（未来 GPS 可选，默认关） | `useGaitMonitor` |

> 红线：所有信号只采**派生特征与粗粒度计数**，不碰内容（不打字内容、不录音出端、不精确轨迹）——与现有隐私契约一致。

### 3.3 统计建模路线图（数据量从小到大）

1. **n=1（单用户，当下可做）**：个人基线 + CPD + MDC 阈值 → 「对自己比」的预警。不需要任何标签数据。
2. **小样本（合作试点，几十人）**：GLMM / 潜轨迹模型（latent trajectory, ORCATECH 图 4 的做法）区分轨迹类型。
3. **中样本（几百人，有标签）**：双流融合分类器升级为时序模型（HMM/状态空间模型 > LSTM——样本少时简单模型更稳；Sensors 2023 的 LSTM 是上限参考而非起步点）。
4. **验证标准**：参照 Dodge et al. 做 reproducibility（同数据重算）与 replicability（新数据重做）双重检验——这是该领域被 FDA 语境接受的前提。

---

## 4. 值得注意的方向（机会与陷阱）

**值得押注：**
1. **「变异性轨迹」是尚未被消费级产品占据的信号**——大多数 App 只做均值趋势；VIBE 的倒 U 假说给了我们分阶段解释能力。
2. **粤语语音标志物**——JCCOCC MoCA + CUHK 的 ASR 自适应工作（MOPSA）证明可行，且几乎没有竞品。ASR 错误与认知信号纠缠是难点，对策是「声学特征与文本特征解耦分析」（双流已有）+ 对 ASR 置信度加权。
3. **CPD + LLM 解释（X-BCD 范式）与我们的 Agent 卡片架构天作之合**——`getAgentCards` 的 501 端点未来就是「行为变化解释卡」的入口。
4. **每日唠嗑是天然的标准化语音任务**——固定开场白（`dailyCheckIn`）等价于 DementiaBank 协议中的固定任务，跨天可比性强，这是最被低估的资产。

**需要警惕：**
5. **不要过早引入深度学习做纵向建模**——几十到几百人的样本量下，GLMM/状态空间模型的可解释性和稳健性远胜 LSTM（Sensors 2023 只是证明可行）。
6. **打字/使用行为特征有数字鸿沟偏差**——TechSANS 自己也承认；必须按基线个人化，不做跨人比较。
7. **背景漂移 vs 病理漂移**：搬家、季节、丧偶、换药都会引起行为变化。X-BCD 用「多维度同时变化才告警」的思路缓解；我们应把「生活事件标注」（照顾员一键标记）列入需求。
8. **合规话术**：我们是「风险趋势提示/转介建议」，永不输出「诊断」（SaMD 审计链 `audit.py` 已为此设计）。

---

## 5. 开发路径（分四阶段）

### Phase 0 — 数据与环境 + 基线强化（1–2 个月，无外部依赖）

**P0-0 · 先让⌈真模型⌋能跑起来（本轮新增，最高优先级）**
- [x] 以 `D:\python3.12` 为基准**已建隔离 venv**：`backend/.venv`（gitignore 已覆盖），装 core：`fastapi 0.143.3 / uvicorn 0.54.0 / pydantic 2.14.1 / numpy 2.5.4 / python-multipart / pandas`
- [x] **`selfcheck.py` 通过（`selfcheck: OK`）**；API 实测启动：`GET /health` 返回 `aura-engine-0.2.0 / egemaps88-v2`，`/baseline/me`、`/health-card/me` 正常
- [ ] 待合作者通过 **Git LFS / 网盘**共享 `models/`（见 README「模型产物共享」），到位后补装：`opensmile lightgbm jieba faster-whisper sklearn joblib`
- [ ] 新增了 `backend/scripts/doctor.py`：一条命令体检 Core 依赖 / 重依赖 / models（含 SHA256 指纹）/ data / .env 是否校准值——协作排障第一步
- [ ] `.env.example` 已改为**出厂即校准值**（0.2/0.8、0.409/0.521），`cp .env.example .env` 即复现 README 所述行为（原 README 声称「仓库内有 .env」但被 .gitignore 屏蔽，已修正）
- [ ] 下载 `lzy1012/Alzheimer-s-disease-datasets` 到 `backend/data/`（或 `AURA_DATASET_DIR` 指向外部目录），**不入库**
- [ ] ~~复现训练~~ **暂缓**：因选择「合作者共享 models/」路径，本机不重训。收到 zip 后用 `doctor.py` 比对 SHA256 前 8 位确认版本一致
- [x] **解决 .env 分发问题**：`.env.example` 已出厂携带校准值；README 新增「模型产物共享」章节（打包/接收/一致性校验三步）；新增 `scripts/doctor.py` 做接收方体检。models/ 的传输方式约定为**网盘 / Release 附件**（`whisper-small/model.bin` 483MB 超 GitHub 100MB 硬限制，不支持直接 commit）
- [ ] 跑通 `selfcheck.py` 与 `POST /screening/analyze`，确认两条特征后端（numpy / openSMILE）都 OK

**P0-1 · 纵向能力（原 Phase 0 内容）**
- [ ] 申请 **DementiaBank 会员**（免费，学生需导师联名）→ 拿 Lu（普通话）+ Pitt + ADReSSo；联系 CUHK 获取 **JCCOCC MoCA**（粤语）
- [ ] `baseline.py` 升级：14 天 Z-score → **个人分位数分布（1–3 个月基线窗）+ 周滑动窗口**；同步输出均值轨迹与 COV 轨迹
- [ ] 新增 `backend/auragba/changepoint.py`：对每条行为维度做 CPD（ruptures 库，PELT/BinSeg），产出 drift score + 置信度
- [ ] MDC 工具：为每个特征定义最小可检测变化（先验值取自文献，语音类参照 Research Square 2025）
- [ ] 下载 **CASAS** Zenodo 数据集，用其验证 CPD 管线（在真实标签上调参）

### Phase 1 — 特征扩展（2–3 个月，与 Phase 0 并行）
- [ ] 文字输入通道采集**按键时间动态**（派生量：保持时间/间隔的均值与方差，绝不存内容）——TechSANS 证据最强的手机信号之一
- [ ] 服药依从性模式特征化：确认延迟分布、超时率、升级触发率（`useReminder` 已有原始事件）
- [ ] 会话参与度特征：每日对话轮次、主动发起比、回答长度趋势（`conversation` store 聚合）
- [ ] 每日唠嗑固定任务化：把 `dailyCheckIn` 的回答结构化为可跨天比较的指标（停顿比、TTR、填充词比——`nlp/metrics.py` 已实现）

### Phase 2 — 纵向检测引擎（2–3 个月）

> 关键衔接：双流融合产出的 **`riskIndex`（0–1）现在是一个每天/每次筛查都有的即时指标** —— 它的角色等同于 ORCATECH 的「周度步速」。把「riskIndex 的个人分布 + 轨迹」作为主序，其余行为域作为辅证，是这一步最省力的落地方式。

- [ ] GLMM / 潜轨迹模型：多维度「阈值命中率斜率」融合为**纵向风险趋势**（复用 `model/fusion.py` 的晚期融合骨架，换时序内核）
- [ ] 把 `baseline.py` 的 TRACKED 表扩展：除单特征 Z-score 外，**新增 `riskIndex` 自身的个人分位/变异性轨迹**（VIBE 的「变异性先升后降」假说在此处落地）
- [ ] 在已有 14 天基线的语义之外，增加**feature drift 检测**：openSMILE/numpy 后端切换、模型换版（`FEATURE_SET_VERSION` 已版本化）时冻结历史轨迹，防伪漂移
- [ ] 多维一致性规则：≥2 个独立行为域同时漂移才触发预警（防生活事件误报）
- [ ] 「生活事件标注」入口：照顾员/家属端标记搬家、换药、丧亲等事件，检测窗口自动调整基线
- [ ] 接入 X-BCD 式解释层：CPD 结果 + 聚类演化 → LLM 生成照顾员可读卡片（接通 `getAgentCards` 501 端点）

### Phase 3 — LLM 与外部验证（3 个月+）

- [ ] **外部验证（新增，紧迫）**：现模型只在单一 322 人中文数据集上评估，缺泛化证据。用 **DementiaBank 中文 Lu corpus / NCMMSC2021 / JCCOCC MoCA（粤语）** 做 **cross-corpus 外部验证**，报告 AUC 掉幅——这是把「演示系统」抬到「研究原型」的最低门槛
- [ ] **重标定（随之而来）**：外部验证后阈值（0.409/0.521）大概率需要重算；`eval_fusion.py` 的校准流程要支持多数据集联合/分语言（`zh-CN` / `zh-HK` 两套阈值）
- [ ] 声学流的提升空间：它是拖后腿的一流（AUC 0.60 vs 语义 0.71）。考量换更大模型/更多 gadget 任务；并评估 **MOPSA 式说话人自适应**在 Whisper + 语义流上的增益（见 §1.2）
- [ ] 接通 3 个 LLM 端点（assistantChat / getAgentCards / getMedicationPlan），内置健康安全边界（不诊断、不荐药）
- [ ] ASR 粤/普自适应：Whisper + prompt 自适应（MOPSA 思路，端上先跑置信度加权）
- [ ] 试点研究设计：参照 Dodge et al. 的 reproducibility/replicability 框架，与社区/养老机构合作招募，**基线期 ≥3 个月**
- [ ] SaMD 合规路径评估：`audit.py` 的 hash 链 + `screening.py` 的模型指纹已就位，补充 MDC 验证报告与版本化特征集（`FEATURE_SET_VERSION` 已有钩子）

### 里程碑判定标准（更新）

- **P0-0 完成**（本周–下周） = 本地 `selfcheck.py` 通过 + 复现 AUC 0.717 + `.env` 可生成/可传递
- Phase 0 完成 = CASAS 数据上 CPD 管线能重现「认知组 vs 对照组」的可分性
- Phase 2 完成 = 合成漂移数据上预警误报率 < 阈值，且输出为自然语言卡片
- Phase 3 完成 = **跨语料外部验证 AUC 保留度 ≥ 80% 原值**（最低可接受门槛）
- 科学目标 = 在自有试点数据上达到 MDC 框架下「语音指标对个体内变化的敏感度 ≥ 简短认知测验」（文献已证明可达）

---

## 6. 立即可做的三件事（已按 10-16 进度重排）

1. **今晚/明天**：搭好 Python 隔离环境 + 拉 `lzy1012/Alzheimer-s-disease-datasets` 到 `backend/data/`，跑通三个脚本复出 AUC 0.717；把校准值落到可共享的 `.env` 里（顺手修掉「README 说有 .env 但 .gitignore 屏蔽了」这个协作坑）。
2. **本周内**：发邮件申请 DementiaBank 会员（说明用于 ADReSS/中文子集，学生需导师联名）；同时下载 CASAS Zenodo 数据集（无需申请）——这两件事互不阻塞，可并行。
3. **持续**：把每日唠嗑的固定问题集固化下来（`checkin.ts`），这是未来最有价值的纵向数据资产——跨天可比的标准化自发语音。

---

_本文档基于 2026-10 的文献与数据集检索整理；数据集可用性会变，启动各 Phase 前请复核获取条款。_
