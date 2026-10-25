# 忆伴 MemoMate — 三部分开发文档

> 面向「挑战 1 · Agetech：跨境 GBA 部署」的黑客松参赛交付物。
> 本文是**唯一开发文档**：定义新项目名称、系统边界、三名开发者的严格分工、文件级改动点、接口契约、里程碑门禁、验收标准与自检方式。
> 约束来源：[ponytail](https://github.com/DietrichGebert/ponytail)（先理解问题再写最少可工作的代码；能复用就复用；删优于加；非平凡逻辑留可运行断言；刻意简化用 `ponytail:` 标明天花板）。

---

## 0. 文档使用说明

| 角色 | 负责部分 | 一句话职责 | 交付形态 |
|---|---|---|---|
| **A · 端侧体验工程师** | 第一部分 | 数字人这张「脸与嘴」，以及它**主动开口**的全部时机 | Next.js / Capacitor 前端 + Live2D 资源 + 原生语音契约 |
| **B · Agent / 系统能力工程师** | 第二部分 | 把长者一句话变成**手机上真实发生的动作**（卡片、任务、导航、代操作） | 前端工具层 + Android 原生服务与无障碍 Agent |
| **C · 后端与证据工程师** | 第三部分 | 把交互数据变成**可解释的认知风险**，并把赛题五步（证据 / 设计 / 经济 / 监管 / 治理）落成可交付材料 | FastAPI 服务 + 模型 + 报告 + 五步文档章节 |

### 0.1 三条铁律（三人共同遵守）

1. **零 UI 优先**：常驻界面只允许「数字人 + 一颗主按钮 + SOS」。任何新能力必须**语音可唤出**或**覆盖层出现**，不得新增导航栏 / 标签页 / 设置树。
2. **原始数据不出端**（唯一例外需单独同意）：音频原始波形、摄像头帧、传感器原始流默认只在本机算成派生特征。跨端只走 `AgentCard` / 特征 JSON / 粗粒度事件。
3. **失败必须开放**：语音不可用 → 自动展开按钮面板；后端不可用 → 本地卡片兜底；权限被拒 → 降级但**绝不锁死**长者。

### 0.2 文件所有权（避免并行冲突）

| 路径 | 归属 | 其他两人的正确做法 |
|---|---|---|
| `web/src/app/page.tsx` | **A 独占** | B 只通过 A 预埋的 `useAgentBridge()` 接缝接入；C 不碰前端 |
| `web/src/components/Avatar.tsx`、`lib/viseme.ts`、`lib/proactive.ts`、`lib/interview.ts`、`lib/audio.ts`、`lib/speech.ts`、`lib/i18n.ts` | A | B/C 只读 |
| `web/src/lib/tools.ts`、`lib/toolrun.ts`、`lib/geofence.ts`、`lib/activity.ts`、`lib/agent.ts`、`hooks/useAgentBridge.ts` | B | A 只调用其导出，不改内部 |
| `web/src/lib/native.ts`、`web/android/**` | **B** | A 提需求给 B，不改 Java/原生契约实现 |
| `web/src/lib/intent.ts`、`lib/cards.ts`、`lib/db.ts`、`lib/api.ts`、`lib/types.ts` | **B**（契约）/ C（后端对接）协商 | 改类型必须三人同步，先改 `types.ts` 再改实现 |
| `backend/**` | **C** | A/B 只按 `api.ts` 契约提需求 |

> 契约变更流程：**先改 `web/src/lib/types.ts` → 三人 review → C 改 `backend/auragba/contract.py` 对齐 → 各自实现**。禁止先写实现后补类型。

---

## 1. 项目定义与改名

### 1.1 一句话定位

**忆伴（MemoMate）** 是一个**没有菜单、只有一个数字人**的手机助手：它住进长者现有的手机里，每天主动开口唠嗑、陪着做几道小任务、代他记事与办事；所有对话与操作在端侧被折算成**语音声学特征、语言特征与行为特征**，由后端做纵向变化检测，输出**非诊断性**的认知风险分层与家属周报——重点服务阿尔兹海默症（AD）与轻度认知障碍（MCI）的**早期科学筛查**。

对外统一口径（答辩 PPT、报告页脚、App 免责声明三处一致）：

> 本产品是**认知变化的辅助观察工具**，不是医疗器械诊断结论。它不替代医生、护士与家属的判断，只把「变化」提前、量化、说清楚。

### 1.2 赛题五步 → 三部分映射

| 赛题步骤 | 主要产出 | 主责 | 配合 |
|---|---|---|---|
| **Step 1 医学与自然科学证据** | PICO 表、近 5 年文献综述、可衡量临床终点、QALY 疾病负担 | **C** | A（访谈脚本即干预内容）、B（任务卡即依从性测量） |
| **Step 2 系统设计（工程）** | 传感器规格/采样率/协议、模型架构、适老化 UI、灵敏度/特异性目标、FMEA 前 5 项 RPN | **C 统稿** | A（端侧交互与 UI）、B（传感器与原生能力） |
| **Step 3 健康经济学** | Green Book 5 年 NPV、每 QALY 成本、HK/MO 支付意愿阈值、跨境部署模式（含横琴） | **C** | B（跨境数据与运营落地） |
| **Step 4 管理与转化路径** | HK MDACS / 澳门 ISAF / CE MDR / FDA 510(k) 路径、TRL 1–9、IP 策略 | **C** | A（Live2D/唤醒引擎许可）、B（无障碍与系统权限合规） |
| **Step 5 伦理与治理** | PDPO + PDPA 数据治理审计、同意架构、跨境传输、伦理影响评估 | **C 统稿** | A（镜头指示、字幕、失败开放）、B（权限最小化、代操作护栏） |

### 1.3 改名清单（「灵犀」→「忆伴 / 小忆」）

**用户可见名**：中文「忆伴」，英文 `MemoMate`，唤醒词「**小忆 / 阿忆 / 忆伴**」。品牌语：*陪你说话，替你记事，为你守忆。*

| # | 文件 | 现值 | 新值 | 阶段 |
|---|---|---|---|---|
| 1 | [i18n.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/i18n.ts) | `我係靈犀` / `叫聲「靈犀」我就應你` / `我係灵犀` | `我係憶伴`（zh-HK/zh-MO）/ `我是忆伴`（zh-CN）；`叫聲「小憶」我就應你` | M0 |
| 2 | [Avatar.tsx](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/components/Avatar.tsx) | `LABELS` 中 5 处「灵犀助手 / 灵犀正在聆听 / 灵犀正在说话…」 | 「忆伴助手 / 忆伴正在聆听 / 忆伴正在说话…」 | M0 |
| 3 | [useWakeWord.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/hooks/useWakeWord.ts) | `["灵犀","靈犀","lingxi","ling xi","小灵","小靈"]` | `["小忆","小憶","阿忆","阿憶","忆伴","憶伴","memomate","memo mate"]` | M0 |
| 4 | [WakeListenService.java](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/android/app/src/main/java/com/auragba/app/WakeListenService.java) | `NAMES` 同上；通知「灵犀在守护」「叫一声「灵犀」我就应你」；渠道 `aura_wake` | 同步新唤醒词；「忆伴在守护」「叫一声「小忆」我就应你」；渠道 `memomate_wake` | M0 |
| 5 | [native.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/native.ts) | `homeWidgetPayload.title = "湾区灵犀"` | `"忆伴"` | M0 |
| 6 | [capacitor.config.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/capacitor.config.ts) | `appName: "湾区灵犀"`，注释「Android shell for AuraGBA」 | `appName: "忆伴"` | M0 |
| 7 | [package.json](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/package.json) | `"name": "auragba"` | `"name": "memomate"` | M0 |
| 8 | [main.py](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/backend/auragba/main.py) | `title="AuraGBA Screening Engine"`、description 与 `/` 返回的 `name` | `"MemoMate Screening Engine"`、`"忆伴 MemoMate"` | M0 |
| 9 | [AndroidManifest.xml](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/android/app/src/main/AndroidManifest.xml) `strings.xml` | `app_name = 湾区灵犀` | `忆伴` | M0 |
| 10 | [capacitor.config.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/capacitor.config.ts) + `android/` 包名 | `appId / applicationId = com.auragba.app` | `com.memomate.app` | **M2**（步骤见 §1.4） |
| 11 | `backend/auragba/` 包名 | import `auragba.*` | `memomate.*` | **M2**（`git mv` + 全量替换，见 §1.4） |

**明确「不改」并写清理由**（防止有人顺手改出数据事故）：

| 项 | 位置 | 理由 |
|---|---|---|
| `_SALT = "auragba-pseudonym-v1"` | [privacy.py](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/backend/auragba/privacy.py) | 改了会**改变全部假名映射**，历史数据无法回溯到同一设备 → 冻结，仅在版本注释中说明历史来源 |
| `DB_NAME = "auragba"` | [db.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/db.ts) | 用户不可见；改名会用空库覆盖、丢掉已装机的提醒与离线特征 → 冻结 |
| `localStorage["auragba.deviceId"]` | [api.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/api.ts) | 改了等于换设备身份，基线作废 → 冻结 |
| `ENGINE_VERSION = "aura-engine-0.2.0"` 前缀 | [config.py](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/backend/auragba/config.py) | 版本串是审计链的一部分（哈希入链），前缀改名会破坏可追溯性 → 只递增尾号，不改前缀 |

### 1.4 M2 阶段的两处「结构性改名」步骤（B 与 C 协同执行）

**B：Android applicationId**

```bash
# 1) 先改 capacitor.config.ts: appId -> "com.memomate.app"，appName -> "忆伴"
# 2) 移动 Java 包目录（保留文件内容，只改 package 行）
git mv web/android/app/src/main/java/com/auragba/app web/android/app/src/main/java/com/memomate/app
# 3) 全局替换 package 声明
grep -rl "com.auragba.app" web/android | xargs sed -i '' 's/com\.auragba\.app/com.memomate.app/g'
# 4) 同步 + 构建
cd web && npx cap sync android && cd android && ./gradlew clean assembleDebug
```

> 注意：`applicationId` 变化在 Android 上视为**新应用**。demo 阶段无存量用户，直接改；若已有装机用户，必须保留旧 id 并只改显示名。

**C：后端包名**

```bash
git mv backend/auragba backend/memomate
grep -rl "auragba" backend --include=*.py --include=*.txt --include=*.md | \
  xargs sed -i '' 's/auragba/memomate/g'   # 注意：不要动 privacy.py 的 _SALT 字符串
# 启动命令随之变为：uvicorn memomate.main:app --reload --port 8000
```

> `_SALT` 行必须人工复核未被替换；`selfcheck.py` 与 `.env.example` 同步更新。

### 1.5 系统总架构

```
┌──────────────────────── 手机（A + B 负责） ────────────────────────┐
│  Live2D 数字人（A）     语音链路（A）        主动调度（A）           │
│      ▲                     ▲                    │                  │
│      │ viseme/level        │ STT/TTS/唤醒        │ AlarmManager      │
│  ┌───┴─────────────────────┴────────────────────┴───┐              │
│  │        page.tsx 交互主循环（A 独占）              │              │
│  │  converse() → 聆听 → parseIntent → runIntent     │              │
│  └───┬───────────────────────────────┬──────────────┘              │
│      │ useAgentBridge()（B 接缝）      │ api.ts（唯一后端入口）      │
│  ┌───▼──────────────┐          ┌─────▼──────────┐                  │
│  │ tools / toolrun  │          │  IndexedDB     │                  │
│  │ cards / tasks    │          │ outbox 离线队列 │                  │
│  │ geofence/activity│          └─────┬──────────┘                  │
│  └───┬──────────────┘                │                            │
│  ┌───▼───────────────────────────────▼──────────┐                  │
│  │ AuraNative → MemoNative 插件（B）              │                  │
│  │ 前台唤醒 / 无障碍服务 / 悬浮层 / 小组件 / GPS  │                  │
│  └───────────────────────┬──────────────────────┘                  │
└──────────────────────────┼─────────────────────────────────────────┘
                           │ HTTPS（仅派生特征 + 粗粒度事件 + 假名 ID）
┌──────────────────────────▼────── 云端（C 负责） ────────────────────┐
│ /screening/* 双流+行为流 → 融合 → 个人基线(robust Z/CPD) → 风险分层  │
│ /agent/turn（LLM 编排·工具调用）  /reports/weekly（家属周报）  │
│ 存储：特征时序（无原始音频）/ 假名 ID / 审计 hash 链 / 报告快照        │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.6 现状基线（改动前必须先认可的既有能力与技术债）

**已可用**（本轮不重写，只增强）：

| 能力 | 位置 | 现状 |
|---|---|---|
| 数字人 Canvas-2D + 口型 | [Avatar.tsx](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/components/Avatar.tsx) | 眨眼/呼吸/嘴高 = `level`；props 仅 `state`/`level`/`size` |
| 语音 TTS/STT/振幅表 | [audio.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/audio.ts) | 端内 VITS 童声（sherpa-onnx）优先 → 系统 TTS → Web Speech；`BOY_VOICE` 仅用于回退路径；四个语气 preset 随 `speak(text, locale, onViseme?, preset)` 传入（见 §2.3 A3） |
| 前台唤醒词 | [useWakeWord.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/hooks/useWakeWord.ts) | 命中即停识别并回调 |
| 后台上锁唤醒 | [WakeListenService.java](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/android/app/src/main/java/com/auragba/app/WakeListenService.java) | 前台服务 + `SpeechRecognizer` 循环 |
| 四条主动开口 | [page.tsx](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/app/page.tsx) | 唤醒回调 / boot 每日签到 / 回前台 20s 冷却 / 提醒到期 |
| 卡片流 | `CardBoard` + [CardRenderer.tsx](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/components/CardRenderer.tsx) | `data` 结构化 或 `html` 走 `sandbox=""` iframe |
| 跌倒三阶段 / 步态 / VAD | [signal.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/signal.ts) | 纯函数，已自检 |
| 双流筛查全链路 | [screening.py](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/backend/auragba/screening.py) | VAD→eGeMAPS→ASR→NLP→融合→基线→经济→审计 |
| 隐私管线 | [privacy.py](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/backend/auragba/privacy.py) | 提取即焚 / PII 擦除 / 假名 |
| 审计链 | [audit.py](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/backend/auragba/audit.py) | append-only JSONL hash 链 |

**必须在本轮修掉的技术债**（每条都指派了归属与里程碑）：

| # | 债 | 影响 | 归属 | 里程碑 |
|---|---|---|---|---|
| D1 | `updateHomeWidget` 为空实现、`bringToForeground` 直接返回 true | 桌面小组件 / 主动前置不可用 → 主动触达链路断 | B | M2 |
| D2 | 3 个 LLM 端点返回 501 | 无真 Agent：意图只靠关键词，任务卡不会规划 | B（接口）/ C（模型） | M3 |
| D3 | `post_sos` 只记升级意图，不发通知 | SOS 在答辩现场是「假动作」 | B（客户端推送）/ C（服务端） | M3 |
| D4 | `post_conversation_memory` 无加密/TTL/撤回 | 伦理审计必挂 | C | M4 |
| D5 | 融合默认权重 0.5/0.5、阈值 0.45/0.65 与实测量 0.2/0.8、0.409/0.521 不一致 | 现场跑出的分层与报告不符 | C | M1（改默认值，不改代码结构） |
| D6 | 基线为均值/标准差 Z，`_MIN_SAMPLES=5` | 5 个样本的标准差不可信，早期误报 | C | M3 |
| D7 | `store.py` 每设备 JSON + 进程内锁 | 并发写丢数据、无法按时间窗查询 | C | M4 |
| D8 | 能量 VAD 漏弱音、易被电视触发 | 采集质量差 → 特征噪声 | A | M2 |
| D9 | 口型是合成正弦，与真实音素无关 | 「数字人在说话」的沉浸感不足 | A | M2 |
| D10 | 唤醒用 `SpeechRecognizer` 循环，耗电/延迟高 | 长时守护不可用 | B | M4 |
| D11 | `native.ts` 桥接与 SQLite/IndexedDB 无 outbox 重放保障 | 断网即丢特征 | B | M2 |
| D12 | 「服药任务」只有提醒，无确认延迟/超时率的量化 | 丢失 CASAS 证据最强的行为指标 | B + C | M3 |

### 1.7 里程碑与门禁总表

| 里程碑 | 主题 | A 交付 | B 交付 | C 交付 | 门禁（必须全绿才进下一阶段） |
|---|---|---|---|---|---|
| **M0** | 改名 + 基线可跑 | i18n/Avatar/唤醒词改名 | 原生 NAMES、通知文案、`native.ts` title | `main.py` 改名；`memomate` 包名迁移 | `npm run typecheck` / `npm run selfcheck` / `node src/selfcheck.ts` / `python selfcheck.py` 全绿 |
| **M1** | 采集闭环可用 | 每日访谈脚本、静音门控、镜头指示 | 卡片落库、outbox 重放、任务确认埋点 | 阈值校准落盘、`/screening/analyze` 真 WAV 跑通 | 端到端一条语音 → 后端一条 `screening_results` |
| **M2** | 拟真与主动触达 | Live2D 挂载层 + viseme、主动调度器、唤起与无障碍 | 小组件 + 前置 + 定时唤醒、权限矩阵 | 行为流接入（服药/任务/步态） | 装机 demo：锁屏被唤醒 → 数字人主动说话 → 生成卡片；§2.3.1 ⑥ 四条断言全过（默认 Kei 模型走 L1，拔掉清单回 L2） |
| **M3** | Agent 真编排 | 对话状态机、打断/重问 | `/agent/turn` 工具调用、代操作护栏 | Agent 后端 + 周报生成 + SOS 通知 | 5 个工具调用场景脚本化全通过 |
| **M4** | 证据与答辩材料 | 无障碍与伦理 UX 说明页 | 合规权限清单、无障碍声明 | PICO / FMEA / NPV / 监管 / TRL / IP / 审计 / 伦理 | 附录 A–E 全部数字可复现 + §1.8 矩阵每行有验收断言 |

### 1.8 老人需求 → 功能 → 监测通道 → 验收断言（追溯矩阵）

> 这张表回答「功能是否全面、是否合理」。**五行判据**：每一条老人潜在需求都必须落到①一个可被长者感知的功能、②一条端侧可采集的信号、③一个明确归属与④一句可执行的验收断言；**任何一格为空即为缺口**，不写「后续再说」。
> 标注 `【缺】` 的是当前实现为空白、本轮必须补的项（对应 A/B 任务号已写在第四列）。

| 类别 | 老人需求（真实场景） | 功能（长者感知到的是什么） | 端侧信号 → 派生特征 | 归属 | 验收断言 |
|---|---|---|---|---|---|
| **安全** | 跌倒起不来 | 三阶段检测 → 全屏 SOS → 通知家属 | 加速度/陀螺 → 冲击-静止-姿态 → `GaitWindow.fall` | B（既有）+ A（SOS 覆盖层） | 模拟跌落注入 → 8s 内出 SOS 覆盖层且 `post_sos` 有记录 |
| 安全 | 走失 / 离家未归 | 围栏 → 主动询问「你喺边度呀」→ 家属通知 | GPS → `inCircle` + 离家时长 | B | 离家 >60min → `place` 卡 + 家属通知，断网降级为文字 |
| 安全 | 一键求助（不会解锁） | 锁屏小组件 SOS 热区 + （前台时）长按数字人 1s | 点击事件（非语音） | B | 锁屏下点小组件 SOS 热区 → 直接发通知/拨号，不要求先解锁 |
| 安全 | 诈骗电话/短信 | 来电与短信风险提示（**只提示不拦截**） | 通话状态（可选权限）→ 陌生号码频次 | B【缺】 | 未授予权限时功能静默关闭且不反复弹窗 |
| **健康** | 忘记吃药 | 到点提醒 → 语音确认 → 确认延迟入模 | 提醒/确认时间差 → `task_confirm_delay_min` | B + C | 「我食咗药」→ `doneAt` 落库；30min 未确认 → 二次提醒并计 `task_timeout_rate` |
| 健康 | 睡不好、夜间起夜 | 夜间静默 + 次日晨间问候（不问细节） | 屏幕解锁/充电时段 → 夜间觉醒次数、首末活动时间 | B【缺】 | 23:00–06:00 无主动开口（SOS 除外）；次日 08:00 后播报一次晨间问候 |
| 健康 | 吃不下、喝水少 | 餐点主动提及 + 家属周报汇总 | 餐点时段交互次数、饮食类任务完成 | A + C【缺】 | 连续 2 天餐点时段无交互 → 周报标「进食关注」 |
| 健康 | 如厕 / 失禁困扰 | **不采集、不询问**（尊严优先），仅由家属主动上报 | — | 产品边界 | 代码与 UI 中无相关字段：`grep -rn "incontinen\|toilet\|失禁" web/src backend` 只命中 §1.8 本条 |
| 健康 | 疼痛 / 不舒服 | 口语化主诉 → 转成家属周报「不适事件」 | 关键词 + 语音情绪代理（语速/停顿，不做情感判断） | A + C | 说「我个头痛」→ 周报出现一条主诉原文（脱敏后）与时间 |
| 健康 | 重复吃药（刚吃过又吃） | 二次确认时**主动提示**「你 20 分钟前已确认过」 | 任务确认时间戳 → 30min 内重复确认计数 | B | 30min 内再次确认 → 播报提示并单独标记，不静默放过 |
| **认知** | 记不住刚说的事 | 每日 3 分钟访谈（记忆/定向/语言/日常/情绪） | 回答时长、句长、超时、复述 → 语义特征 | A + C | 每日 ≤4 题；拒答即停；三语言文案齐全 |
| 认知 | 分不清日期/地点 | 定向题 + 主动播报「今日系 X 月 X 日」 | 定向题正确率 | A | 定向题答错 → 当日不再追问，只记一次 |
| 认知 | 语言变得断续 | 「慢慢讲，我等你」+ 不打断 | 语速、停顿时长、TTR、Mattr、句长方差 | A + C | 停顿 >3s 不插话；`quality=good` 样本才入基线 |
| 认知 | 做事没条理 | 任务卡拆成 2–3 步，语音勾销 | 完成率、延后次数、步骤跳过 | B | 一卡最多 3 步；勾销延迟 >15min 记为 `defer` |
| 认知 | 反复问同一件事 | **不纠正、不重复解释**，换个说法回应 | 同语义提问计数（端侧相似度，不上传原文） | A + C | 同日同一问题 ≥3 次 → 只计数进周报，绝不提醒长者「你问过了」 |
| 认知 | 找不到东西 | 安抚 + 记一条「遗失事件」；**不承诺代找** | 关键词（唔见 / 边度）计数 | A | 说「我唔见咗锁匙」→ 记一次遗失事件，不给出错误位置 |
| **情绪/社交** | 孤独、没人说话 | 主动唠嗑（每日 ≤3 次，21:00 后静默） | 连续沉默天数、主动交互天数 | A | 连续 2 天无交互 → 触发一次「沉默关怀」，当天不重复 |
| 情绪/社交 | 心里难受、想哭 | 只倾听与陪伴，**不做情绪评分、不下结论** | 语速/停顿（仅作采集质量与趋势，不判定情感） | A | 说「我今日好唔开心」→ 只回应与陪伴，报告里只记「情绪主诉」原话 |
| 情绪/社交 | 被骗后自责、怕被骂 | 不评判、不复述损失金额 | 不采集金额与账号 | A | 任何对话中不出现"你怎么这么傻"类措辞（词表断言） |
| 社交 | 想找人说话（又怕打扰） | 「帮我打畀阿明」→ 二次确认后拨号；未接则提示「留句话」模板 | 通话发起次数（仅计数不录音） | B | 拨号前必须复述姓名确认；拒绝即取消；未接不自动重拨 |
| 社交 | 家属想知道近况 | 每周一条家属周报（非诊断） | 汇总特征与交互统计 | C | 周报含「本周交互 X 天 / 样本 Y 条 / 分层 Z」+ 免责声明 |
| **生活** | 忘了带伞 / 出门 | 天气卡 + 出行提醒 | 位置 + 天气 API | A + C | 说「听日天气」→ 先朗读温度/降雨、整屏弹窗、单个大号关闭键；问「會唔會落雨」先答是/否；断网只回「暂时拿不到实时天气」，不编造数值（§2.4 A6） |
| 生活 | 要覆诊但不会挂号 | 提醒 + 路线卡（**不代付、不代挂号**） | 任务 + 位置 | B | 涉及支付/预约 → 明确拒绝并播报替代建议 |
| 生活 | 不会操作手机 | 无障碍 Agent 白名单代操作 | 节点点击审计 | B | 仅 3 类白名单场景；失败 3 次即停 |
| **数字能力** | 越用越不会用（认知下降早期信号） | 不额外打扰，静默记录 | App 切换频次、操作失败率、首触延迟 | B【缺】 | 每日 1 条 `DigitalSkillDaily`，字段含 `appSwitchCount` / `opFailRate`；权限关闭时为 `null` |
| 数字能力 | 听不清 / 看不见 | 音量感知自适应 + 字号/对比度模式 | 系统音量、字号偏好 | A【缺】 | 音量长期 ≤30% → 自动提高 TTS 音量一级并提示家属 |
| **尊严/边界** | 不想被机器监视 | 分层同意 L1–L4、随时关闭、镜头指示 | 同意状态 | A + C | 关闭麦克风后**所有**语音能力停用且 UI 明确显示；镜头开启时有可见指示 |

---

## 2. 第一部分 · 端侧数字人与主动关怀（开发者 A）

> **修订说明（2026-10-24，A 第二版规划）**：B 已交付 W0–W3（工具层、执行器、原生四件套、`onForeground`、`memomate:sos`），C 已交付 C1–C7（三流融合、周报、SOS 通知、会话加密）。本节据此重排：**删掉了与现状重复或违背 ponytail 的四处设计**（Silero 依赖、npm 引入 PIXI、`visemeFromAnalyser`、`?demo=1` 构型），**补上了联调必须的三处接缝**（接桥、前置原因、SOS 事件），所有偏离原文的地方都写在 §2.8 决策记录里，附理由。
> 判据只有一个：**长者今天拿到手机能不能用、坏掉时会不会被锁死**。不能回答这个问题的工作不排期。

### 2.0 起点快照（规划前已核实）

| 项 | 现状（main@bd164d3） | 对 A 的含义 |
|---|---|---|
| 门禁 | `npm run typecheck` 0 错；`node src/selfcheck.ts` → `selfcheck: OK` | 基线全绿，A 的每一步都不得回退 |
| 改名 | `i18n.ts` / `Avatar.tsx` / `useWakeWord.ts` / `layout.tsx` 仍是「灵犀」 | A0 未做，阻塞 M0 门禁 |
| B 接缝 | `useAgentBridge()` 已建好、**无调用方**；`onForeground()` / `memomate:sos` 已可订阅；`scheduleDaily()` 已真实现 | A 接 3 处即生效（issue #1） |
| C 契约 | `ScreeningSession` 为 `extra="allow"`；`ScreeningResult` 有 `insufficientStreams`、基线有 `sufficient` | A 加可选字段不会 422（issue #3） |
| 已知缺陷（A 自己的） | ① `prefers-reduced-motion` 下 `Avatar` 把时间冻结为 0，**眼睛永远闭着**；② 播报打断时 `speak()` 的 `onend` 会把状态拨回 `idle` 并重新武装唤醒词，与正在进行的聆听抢麦；③ `repeat`/`cancel` 意图（B 新增）在 `page.tsx` 无分支，落到「记成待办」 | 修根因，不打补丁 |

### 2.1 目标与非目标

**目标**

1. 让数字人从「会张嘴的画」变成**有口型、有视线、可打断**的对话主体，且模型层完全可插拔（今天不带模型也不白屏）。
2. 让数字人**自己找长者说话**：定时、按事件、按沉默时长，并且受**打扰预算**约束，不烦人。
3. 把每次主动访谈变成**结构化样本**（问了哪题、答了多久、答了几个字、是否超时、STT 置信度），只上派生量。
4. 在低数字读写能力前提下做到「不看屏幕也能用」，语音整条坏掉时**纯按钮也能走完**。

**非目标**（明确不做）

- 不做 3D / 云渲染 / 多角色；**不往仓库里放任何模型二进制或第三方运行时**。
- 不做通用闲聊大模型（闲聊文本来自 C 的 `/assistant/chat`、`/agent/turn`，A 只负责说与听）。
- 不做情感识别、不在端侧给答案打分（定向题答错也不纠正，见 §2.4 A1）。
- 不读系统音量（Web 拿不到；听力代理依赖 B 的原生接口，列入 M4，见 §2.8 D-7）。

### 2.2 交付物清单

| # | 交付物 | 形态 | 门禁 |
|---|---|---|---|
| A-1 | 数字人组件：L1 Live2D / L2 Canvas-2D（默认）/ L3 静态头像三级降级；单击=重说，长按 1s=聆听 | `components/Avatar.tsx` | M2 |
| A-2 | 口型：文本 → 开口度时间轴 + `onboundary` 逐字校准 | `lib/viseme.ts`、`lib/audio.ts` | M2 |
| A-3 | 主动调度器（提醒 / 沉默关怀 / 每日访谈 / 开屏问候四源 + 打扰预算） | `lib/proactive.ts` + `meta` store 一条记录 | M2 |
| A-4 | 每日认知访谈（5 类 × 3 题，≤4 题 / ≤180s，可拒答） | `lib/interview.ts` | M1 |
| A-5 | 对话状态机：聆听 / 思考 / 说话 / 打断 / 重问 / 超时 | `page.tsx` | M3 |
| A-6 | 适老化：字幕条、三档显示（标准 / 高对比 / 大字）、按压振动、焦点管理 | `page.tsx`、`globals.css` | M2 |
| A-7 | 端侧质量门控：`snrDb()` + `qualityOf()`，样本打 `quality` 标记**仍上传** | `lib/signal.ts`、`lib/vad.ts` | M1 |
| A-8 | 模型挂载层：清单读取 → 运行时脚本注入 → 3s 超时回退 | `lib/live2d.ts`、`public/live2d/` | M2 |
| A-9 | 唤起全通路接入（唤醒词改名、长按、主按钮、widget/闹钟前置原因、锁屏 SOS） | `useWakeWord.ts`、`page.tsx` | M2 |
| A-10 | **接桥**：`useAgentBridge` 进入主循环；`onSos` / `onConfirm` / `recentTurns` | `page.tsx` | M3 |

### 2.3 文件级改动点

| 文件 | 操作 | 说明 |
|---|---|---|
| `components/Avatar.tsx` | 重写 | 对外 `{ state, level, size, label, onTap?, onLongPress? }`。外层是 `<button>`（可交互，所以不是 `role="img"`，见 §2.8 D-6）；内部 L1/L2/L3。L3 用内联字符头像，不新增 PNG |
| `lib/live2d.ts` | 新增 | `parseManifest(json)` 纯函数（自检覆盖）+ `mountLive2D(el, manifest)` 浏览器侧；**唯一**与 Live2D 耦合的文件 |
| `lib/viseme.ts` | 新增 | `visemeFromText(text)` 纯函数：每字固定 4 帧 × 65ms，标点为闭口 |
| `lib/audio.ts` | 增强 | `speak(text, locale, onViseme?, preset)`；`cancelSpeech()`；`listenOnce(locale, timeoutMs)` 返回 `{ text, confidence, durationMs }` |
| `lib/proactive.ts` | 新增 | `planProactive(ctx)` 纯函数 + `dayKey` 复用 `checkin.ts` 的本地日历日判定 |
| `lib/interview.ts` | 新增 | 题库 15 条 + `pickNext` / `shouldStop` / `careCue` 纯函数 |
| `lib/signal.ts` | 增函数 | `snrDb(rmsDb[])`、`qualityOf({ speechRatio, snrDb, durationMs }, minMs)` |
| `lib/vad.ts` | 小改 | `recordScreening()` 在**裁剪前**的帧上算 SNR，结果带 `quality` / `snrDb`；`createVad` 契约不动 |
| `lib/types.ts` | 加可选字段 | `ScreeningSession.quality?` / `snrDb?`（契约流程 §0.2：先改类型，C 已是 `extra="allow"`，issue #3 通知 C 收编） |
| `lib/i18n.ts` | 改名 + 扩充 | 「灵犀」→「忆伴 / 小忆」；新增访谈收尾、重问、跳题、长按提示、唤醒词提示、显示档位、风险分层三档文案等 |
| `lib/checkin.ts` | 删除 | 本地日历日判定并入 `proactive.ts`，`page.tsx` 的 boot 签到改由调度器决定 |
| `hooks/useWakeWord.ts` | 改名 | `WAKE_NAMES` 换新词并导出，供自检断言 |
| `app/page.tsx` | 改造 | 接桥 / 前置原因 / SOS 事件 / 调度器 tick / 访谈循环 / 打断 / 字幕 / 三档显示 / 常用三件事 |
| `app/layout.tsx`、`app/caregiver/page.tsx` | 改名 + 文案 | 标题改名；家属端风险分层显示中文三档，不显示英文枚举 |
| `app/globals.css` | 增样式 | `.lg` 大字档、字幕条、录音指示环 |
| `public/live2d/model.manifest.json`、`README.md`、`vendor/`、`kei/` | 新增 | 清单 + 接入说明；Kei 示例模型与三个运行时（约 2 MB） |

### 2.3.1 数字人模型挂载契约（**已接入 Kei 示例模型**）

> 目标：**运行时与模型都在仓库里，代码照跑、答辩不白屏**；整目录约 2 MB。原始导入的 36 MB 素材（含 13 MB×2 的语音 wav 与第二个模型）**没有提交**——口型由 TTS 驱动，模型自带语音与字幕不同步，只会抢占喇叭。
>
> **协作约定（2026-10-25）**：改动他人所有文件（`page.tsx` / `android/**` / `backend/**` / `types.ts`）前，先在 Issue 或群里告知对应负责人并等确认。当天两次并行推送都靠 merge 收场，靠约定比靠运气稳。`speak()` 同时牵涉 A（文案与调用）与 B（原生桥回调），改这一侧前先互相确认。

**① 为什么不 `npm install pixi.js pixi-live2d-display`**（相对第一版的关键调整）

Cubism Core（`live2dcubismcore.min.js`）是 Live2D 专有许可，**不能进 npm 依赖树、只能以全局脚本加载**；既然必须走脚本注入，PIXI 与插件也一并走脚本注入：零新依赖、零首屏体积，许可证边界（附录 C.4）也随文件一起落在 `public/live2d/vendor/` 这一处。

**② 目录契约（当前提交的真实内容）**

```
web/public/live2d/
├── README.md                      # 说明 + 许可（提交）
├── model.manifest.json            # 清单（提交，model = "kei"）
├── vendor/                        # 运行时（提交，828 KB）
│   ├── live2dcubismcore.min.js    # Cubism Core（专有许可，来自 Live2D 官方 CDN）
│   ├── pixi.min.js                # pixi.js 6.5.10（与插件 0.4.x 配套）
│   └── cubism4.min.js             # pixi-live2d-display 0.4.0 的 Cubism 3/4 包
└── kei/                           # Kei 示例模型（提交，1.2 MB）
    ├── kei_basic_free.model3.json # 入口；动作组已重写为 Idle / TapBody
    ├── kei_basic_free.moc3
    ├── kei_basic_free.physics3.json
    ├── kei_basic_free.cdi3.json
    ├── kei_basic_free.2048/texture_00.png
    └── motions/*.motion3.json     # 01_kei_zh（Idle）/ 01_kei_en（TapBody）
```

> 未提交：`web/public/kei_zh-Hans/`（用户导入的原始包）。里面的 `sounds/` 每条 13 MB，且 `model3.json` 的 `Motions` 组名是空串，直接引用既超体积上限又没有 `Idle`/`TapBody` 组。`kei/` 是从中裁出的最小可跑集合，去掉 `Sound`/`MotionSync` 引用后动作组可正常播放。

**③ 清单字段（当前值）**

```json
{
  "model": "kei",
  "modelPath": "/live2d/kei/kei_basic_free.model3.json",
  "runtime": ["/live2d/vendor/live2dcubismcore.min.js", "/live2d/vendor/pixi.min.js", "/live2d/vendor/cubism4.min.js"],
  "scale": 1.0,
  "anchor": [0.5, 0.55],
  "params": { "mouthOpen": "ParamMouthOpenY", "angleX": "ParamAngleX" },
  "motionGroups": { "idle": "Idle", "tap": "TapBody" }
}
```

- `model: null` 仍是**合法的关闭开关**：只请求这一份清单（同源 200，<1KB），不加载任何脚本或模型。第一版写的「连网络请求都不发」与「运行时读清单」自相矛盾，已更正。
- 清单 404 / 解析失败 / 字段类型不对 → 一律按 `model: null` 处理（`parseManifest` 自检覆盖）。
- 删掉了第一版的 `cubismVersion`（运行时由 `runtime` 决定，重复字段只会不一致）、`eyeLeft/eyeRight/angleY/angleZ/bodyAngleZ`（眨眼与呼吸由模型自带的 `physics`/`Idle` 动作驱动，覆盖它们反而破坏动作）、`stateMotion`（五个状态里四个都映射到 `Idle`，只有「点击 → TapBody」有意义，直接写死）。

**④ 必需模型格式**

| 项 | 要求 |
|---|---|
| 版本 | Cubism **3 / 4 / 5**（`.moc3`）；Cubism 2（`.moc`）不支持。随仓库的 Kei 是 Cubism 5，已在浏览器实测加载 |
| 入口 | `.model3.json`（相对路径引用 moc3 / 纹理 / 动作） |
| 动作 | `Idle`（循环）+ `TapBody`（点击）。官方样例的动作组常为空串，需要改成这两个名字 |
| 参数 | `ParamMouthOpenY`（口型）、`ParamAngleX`（聆听时朝向屏幕中心）；缺失**不报错**，只少动效 |
| 体积 | 模型 + 运行时整目录 ≤ 8 MB（当前 2.0 MB） |
| 许可 | Kei 为 Live2D 官方示例素材：个人与小规模企业可在同意授权协议后商用，中/大规模企业仅限非公开内部试用。来源与许可链接写在 `README.md` |

**⑤ 三级降级（必须实现，答辩前逐级演练）**

| 级 | 触发条件 | 表现 | 记录 |
|---|---|---|---|
| L1 模型（**默认**） | 清单 `model` 非空 **且** 3s 内加载成功 | Live2D；`level` → `ParamMouthOpenY`；单击播 `TapBody` | `track("avatar_mode", {mode:"live2d"})` |
| L2 Canvas-2D | `model` 为空 / 加载失败 / 超时 / WebGL 不可用 | 眨眼、呼吸、嘴高 = `level`；聆听时微微前倾、瞳孔朝中心；空闲约每 10 秒轻点一次头 | `track("avatar_fallback", {mode:"canvas"})`（只在从 L1 掉下来时记） |
| L3 静态头像 | `canvas.getContext("2d")` 返回 null | 内联字符头像 + 状态文字，主按钮与 SOS 照常 | `track("avatar_fallback", {mode:"static"})` |

三级**都包在同一个 `<button>` 里**，所以单击重说 / 长按聆听在任何一级都成立。纯装饰场景（如 SOS 全屏里的小头像）不传 `onTap`/`onLongPress`，组件自动退化为 `role="img"`，不占焦点。

**⑥ 自检断言（进 M2 门禁）**

```bash
cd web
# 1) 运行时与模型都在
for f in vendor/live2dcubismcore.min.js vendor/pixi.min.js vendor/cubism4.min.js kei/kei_basic_free.model3.json; do
  test -f "public/live2d/$f" || { echo "MISSING $f"; exit 1; }
done
# 2) 清单可解析且指向 kei（node src/selfcheck.ts 同时断言 parseManifest 的降级）
node -e 'const m=require("./public/live2d/model.manifest.json");if(m.model!=="kei")throw 1;console.log("PASS: manifest -> kei")'
# 3) 拔掉清单仍能构建（运行时 404 → L2）
mv public/live2d/model.manifest.json /tmp/ && npm run build; mv /tmp/model.manifest.json public/live2d/
# 4) 不得出现任何 pixi / live2d 的 import（只能运行时脚本注入）
! grep -rnE "from ['\"](pixi|pixi-live2d-display)" src && echo "PASS: 无静态依赖"
```

**⑦ 单实例与销毁（2026-10-25 真机回归）**

- `mountLive2D` 全局只允许 **1 个实例**：SOS 覆盖层里的装饰头像保持 L2 Canvas-2D，不再挂第二个 PIXI 应用。
- 根因：PIXI 6 的 `app.destroy(true)` 默认同时销毁 stage 的 `texture` / `baseTexture`，而 `pixi-live2d-display` 通过**全局 TextureCache** 加载贴图——SOS 遮罩卸载时把主页模型的贴图一并销毁，于是「关掉 SOS 回主页模型空白」。现在改为 `app.destroy(true, { children: true, texture: false, baseTexture: false })`，只释放自己的 DOM 节点。
- 验收：打开 SOS → 关闭 → 主页模型仍在；连续进出两次仍正常。

### 2.4 任务分解（可直接认领的步骤）

#### A0 · 基线确认与改名落地（0.5 天，M0）

1. 跑 `npm run typecheck && node src/selfcheck.ts`，基线全绿（已核实）。
2. 改 `i18n.ts`（`我係憶伴` / `我是忆伴`；`叫聲「小憶」我就應你` / `叫一声「小忆」我就应您`）、`Avatar.tsx` 状态标签、`useWakeWord.ts`（`小忆/小憶/阿忆/阿憶/忆伴/憶伴/memomate/memo mate`）、`layout.tsx`、`caregiver/page.tsx`。
3. `native.ts` 的 `homeWidgetPayload` 默认 title 属 B（§1.3 第 5 项），**A 不改**，只在调用处传 `t(locale,"appName")`——这是 B 预留的第 4 个参数。
4. 自检断言：三语言 `greeting` 含新名、全字典不含「灵犀/靈犀」；`WAKE_NAMES` 不含旧词。
5. 验收：`grep -rn "灵犀\|靈犀\|lingxi" web/src` 只允许命中 B 的 `native.ts` 默认值（B0 处理）。

#### A1 · 访谈脚本与对话状态机（1 天，M1/M3）

**题库设计原则**：每题都是**开放式、无对错**的日常话题；不出现「考你」「记不记得」这类测验口吻；答不上来给提示（不是答案），再答不上就跳过并说「唔緊要」。

| 类 | 测什么（只采派生量） | 示例（zh-HK） |
|---|---|---|
| memory | 近期情节回忆 → 回答长度、超时 | 「今朝食咗啲咩早餐呀？」 |
| orientation | 时间/地点定向 → 回答后**温和播报当天日期**，从不纠正 | 「今日係星期幾呀？」 |
| language | 语义流畅度 → 字数 | 「講幾樣街市買得到嘅生果畀我聽吓？」 |
| daily_living | 顺序性 → 字数、时长 | 「沖一杯茶，要點樣做呀？」 |
| mood | 睡眠/情绪自述 → 只记时长，不判情绪 | 「最近瞓得好唔好呀？」 |

**步骤**

1. `InterviewItem` 按 §2.5 定义，15 条全部有 `hk` / `cn` 两种写法（`zh-MO` 复用 `hk`，与 `i18n.ts` 一致）。
2. `pickNext(state, history, now)`：同一天不重复；**7 天内没问过**的优先；上次超时的题排后（降级）；同优先级按题号稳定排序（可复现）。
3. `shouldStop(state, now)`：答满 4 题 / 累计 ≥180s / 出现拒答或疲倦。**拒答一次即结束**（第一版写了「连续 2 次」，与其验收「说唔想讲即结束」矛盾，取尊严优先的那一条）。
4. `careCue(text)`：`refuse`（唔想講/不想说/唔講喇…）/ `tired`（攰/累）/ `sad`（唔開心/難過…）/ `lost`（唔見咗/搵唔到…）；访谈和普通对话共用这一个函数。
5. `page.tsx` 的访谈循环：**一次只问一句** → `listenOnce(8s)` → 超时则复述一次（有 `followUp` 用提示）→ 再超时说「唔緊要，我哋講第二樣」并记 `timedOut` → 下一题；任意回答若 `parseIntent === "sos"`，**立即中止访谈并打开 SOS 覆盖层**（安全优先于采样）。
6. 每题写一条 `track("interview_answer", { item, domain, durationMs, textLen, confidence, timedOut })`——**无原文**；原文走既有的会话记忆通道（C5 已加密 + TTL）。访谈结束写 `track("interview_end", { answered, reason })`，`reason ∈ done | refuse | tired | sad | unavailable | sos | abort`。
7. 打断：访谈中长者按「講嘢」或长按数字人 → 取消当前播报、结束访谈、转入普通聆听。

**验收**

- 长者沉默 8 秒 → 复述一次；再沉默 → 说「唔緊要，我哋講第二樣」跳题。
- 说「唔想講」→ 立即收尾，当天不再主动访谈（`interviewAt` 在**开始时**就写入，失败/拒答都算当天已做）；普通对话里说「唔講喇」同样写入，当天静默。
- 自检：15 题 × 2 种写法齐全、5 类各 3 题；`pickNext` 同日不重复、7 天新鲜度、超时降级；`shouldStop` 四个条件。

#### A2 · 主动调度器（1 天，M2）

**规则（纯函数 `planProactive`，按优先级短路）**

| 序 | 条件 | 结果 | 是否消耗预算 |
|---|---|---|---|
| 1 | 有到期未确认提醒 | `reminder`（**静默时段也执行**；由既有 `ReminderOverlay` 播报，调度器只负责压住其他三源） | 否 |
| 2 | `trigger === "boot"` | `null`（开机只重排闹钟，**不开口**，避免清晨惊吓） | — |
| 3 | 21:00–08:00 | `null` | — |
| 4 | 今日已主动 3 次，或距上次主动 < 90min | `null` | — |
| 5 | 连续 ≥2 天无交互 | `silence`（≥3 天时文案附带「叫我『小憶』或者撳大掣」的唤醒指引） | 是 |
| 6 | 今日未访谈 | `interview` | 是 |
| 7 | `trigger === "open"`（开屏/回前台/通知点击） | `greeting`（20s 冷却由页面侧保留） | 否 |

- 第一版的优先级「访谈 > 沉默关怀」会导致沉默关怀**永远不触发**（连续 2 天无交互 ⇒ 今天必然没访谈 ⇒ 永远先命中访谈），已调换。
- 「唤醒词」是长者主动发起，不属于调度器，也不消耗预算。
- `greeting` 是对「长者自己打开 App」的回应，不算打扰，不消耗预算，但仍受静默时段约束。

**落地**

1. 页面每 60s `tick` 一次，仅在 `idle` 且页面可见时调用；`open`/`alarm` 由 `visibilitychange` 与 `onForeground` 触发。
2. 状态存 `meta` store 一条 `{ id:"proactive", lastSpokeAt, spokenToday, lastInteractionAt, interviewAt }`（访谈题历史另存一条 `{ id:"interview", items }`），**不新增 store、不动 B 的 `db.ts` 版本号**。
3. `onForeground` 原因映射**统一走 B 的 `planForeground(reason, locale)`**（`lib/foreground.ts`，自检覆盖）：`boot` → `silent`；`widget` → `listen`（先说一句「我喺度」，再直接聆听）；`alarm` → `speak`（早晨问候）；`reminder`/`notification` → `refresh`（只重读提醒/卡片状态，不说话）。A 的 `page.tsx` 只执行 `plan.kind`，不再自己写映射分支。
4. 启动时 `bridge()?.scheduleDaily(10, 0)`：每天 10:00 由 B 的精确闹钟把 App 叫起来做访谈（网页计时器后台会被挂起）。
5. 每次主动开口写 `track("proactive", { kind, trigger })`；长者有效应答时 `lastInteractionAt` 更新并写 `track("interaction", { source })`——B 的 `BehaviourDaily.interactionCount` 从这里取（issue #3 第 3 问）。

**验收（自检断言）**：09:00 已说 3 次 → `null`；22:30 有到期提醒 → 仅 `reminder`；22:30 无提醒 → `null`；距上次 60min → `null`；连续 2 天无交互 → `silence` 先于 `interview`；`boot` → `null`。

#### A3 · 数字人模型挂载、Live2D 与口型（1.5 天，M2）

1. `lib/live2d.ts`：`fetch("/live2d/model.manifest.json")` → `parseManifest()` → `model` 为空直接返回 `null` → 否则按 `runtime` 顺序注入 `<script>` → `PIXI.live2d.Live2DModel.from(modelPath)` → 整体 3s 超时，任何异常返回 `null`。
2. L1 下 `level` 在 `beforeModelUpdate` 里写入 `params.mouthOpen`；聆听时 `model.focus()` 朝屏幕中心；单击播 `motionGroups.tap`。
3. 口型：`visemeFromText` 每字 4 帧 × 65ms（0.85 语速下粤语约 260ms/字），帧形为「开-全开-半开-收」，标点为闭口停顿；`speak()` 用 `setInterval(65)` 推进，Web Speech 的 `SpeechSynthesisUtterance.onboundary` 到来时**按 `charIndex×4` 跳帧校准**（平台事件，零依赖）；原生路径（系统 `TextToSpeech` 与神经童声）**都不回调 boundary**：系统引擎不输出 PCM，神经引擎虽有 PCM 但未做音素对齐，因此原生路径仍只做纯时间推进；`frameMs` 按 `0.85 / rate` 拉伸，保证语速变了嘴形不脱节。不支持 boundary 的设备同样退化为纯时间推进（`ponytail:` 注明天花板）。
4. **TTS 三路径（按实际实现勘误）**：`audio.ts#speak(text, locale, onViseme?, preset)` 先问 `bridge()`：
   - **端内神经童声（首选）**：APK 内置 `sherpa-onnx` + VITS 模型（`android/app/src/main/assets/tts/{yue,cmn}`，22.05 kHz 单说话人），`NeuralTts.java` 在 CPU 上推理，`AudioTrack` 直接播放 PCM。粤语用 `vits-cantonese-hf-xiaomaiiwn`（108 MB fp32，上游没有 int8），普通话用 `vits-piper-zh_CN-xiao_ya-medium-int8`（18 MB）。模型与 47 MB 的 `sherpa-onnx-2.0.0.aar` **不入库**（`.gitignore` + 单文件体积限制），首次构建前执行 `web/scripts/fetch-tts.sh`；未执行时 Gradle 解析不到 AAR，属于硬依赖。
   - **童声与语气**：模型本身是成年女声，`NeuralTts` 用重采样把音高与共振峰一起上移（preset `lift` 1.05–1.15），同时把合成语速除以 `lift`，让「更年轻」不等于「更快」。四个 preset（warm / gentle / cheerful / urgent）分别控制 lift、语速与句间停顿；VITS 没有情感 embedding，这是离线条件下能做到的「带语气」。接线：SOS/跌倒 → `urgent`，吃药提醒/筛查 → `gentle`，绑定成功 → `cheerful`，其余 `warm`。
   - **繁→简**：粤语模型 lexicon 里约 7.9k 繁体字只有字头、没有音素（例如「帶」），直接合成会被静默吞掉。`assets/tts/t2s.txt`（由 OpenCC `TSCharacters` 生成，4105 对）在合成前逐字映射，实测「帶我去街市」不再 `OOV`，简繁混排同样安全。音素/词表/FST/t2s 随仓库提交，只有 `model.onnx` 被忽略。
   - **首句不等模型**：`load()` 只创建对象；语言确定后 JS 调 `warmTts(locale)` 预载。首句若模型尚未就绪，最多等 `NEURAL_GRACE_MS=1600ms`，随后由系统 TTS 说这一句，下一句起改用神经童声；神经引擎报错（缺 ABI、OOM、模型损坏）同样回落到系统 TTS，绝不静默。
   - **音频细节**：输出统一 24 kHz PCM16 单声道；逐句合成（≤6 句，长句 34 字按逗号再切），句间插静音；峰值约 0.45 的输出归一到 0.9（增益上限 3×），8 ms 淡入淡出防爆音；`getPlaybackHeadPosition()` 轮询到写完的帧数才释放 `AudioTrack`，否则句尾会被切掉。`AudioTrack` 用 API 21 构造器和三参 `write()`，兼容 `minSdk 22`。
   - **看门狗与回退**：神经路径 `max(12s, 字数×450ms+8s)`，超时 `neural_timeout`；系统 TTS 路径保留 5s 初始化、4s `onStart`、`max(8s, 字数×700ms+6s)` 的 `onDone` 看门狗。所有超时都以 `{ok:false, reason}` resolve；`reason` 取值 `empty_text / no_model / init_failed / init_timeout / lang_missing / speak_error / no_start / engine_error / neural_timeout / stopped / interrupted`。系统 TTS 仍走 `USAGE_MEDIA + CONTENT_TYPE_SPEECH` 与 60% 音量地板（说完还原）。
   - **系统 TTS 细节**：构造与全部 `PluginCall` 回调都 `post` 到主线程（`Handler(Looper.getMainLooper())`），在 Capacitor 插件线程构造会让初始化回调永不回、Promise 挂死；MIUI 引擎对 `zh-HK/zh-TW` 返回 `LANG_NOT_SUPPORTED`，`applyBestLocale()` 粤语请求优先回落 `zh-CN`。
   - **Web Speech 回退**：无原生桥或原生 `ok:false` 时用 `SpeechSynthesisUtterance`，`pitch/rate` 按 preset 取值（warm 1.35/0.9、gentle 1.3/0.84、cheerful 1.45/1.02、urgent 1.28/1.05），候选音色优先 `child/kid/girl/female/…`。
   - **打断**：`cancelSpeech()` 同时 `speechSynthesis.cancel()` 与 `stopSpeak()`；后者会 `neural.stop()` 立即 `pause/flush` `AudioTrack`。`{ok:false, stopped:true}` 表示主动打断，JS **不得**回退重说。
   - **隐私**：模型与推理都在端上，`NeuralTts` 内无任何网络调用（自检断言），TTS 文本不出设备。系统 TTS 仍是回退路径，MIUI `TtsEngineProcessor` 有云端优先的已知风险（`onlyOffline:1500` 超时后回落本地），强制纯离线需换引擎，记录在案（B/C 评估）。
   - **真机自查**：`adb logcat -s AuraTTS` 应出现 `neural model ready dir=tts/yue sr=22050`；`dumpsys media.audio_flinger` 的 `AudioTrack` 行应为 24 kHz、`Underruns 0`；模型加载完成前第一句由系统引擎播出属于预期。
5. L2 Canvas 修复：`reduced-motion` 只关掉位移（呼吸、前倾），**眨眼与嘴照常**（修 §2.0 缺陷①）；聆听时轻微前倾 + 瞳孔朝中心。
6. 单击数字人 = 重说上一句（适老化高频需求）；长按 1s = 取消播报并进入聆听，播报「你想講咩？」；长按期间不触发任何播报（issue #1 第 2 问）。

**验收**：默认（`model:"kei"`）四个 `/live2d/**` 请求均 200、L1 挂载成功；把清单改成 `model:null` 或删掉 vendor 后回落 L2 且无 4xx；§2.3.1 ⑥ 四条断言全过；`reduced-motion` 下无位移但眼睛会眨；口型与语音同步误差 < 150ms（支持 boundary 的设备录屏抽查 3 段）。

#### A4 · 采集质量门控（0.5 天，M1）

1. `snrDb(frames)`：帧 dB 的 P90 − P10（P10 即噪声底，P90 即语音峰段）。风扇/空调这类稳态噪声、以及经过响度压缩的电视声，P90 与 P10 很接近 → SNR 低 → `reject`；这正是能量 VAD 分不出、而 SNR 能分出的那一类。
2. `qualityOf({speechRatio, snrDb, durationMs}, minMs)`：任一项低于下限（0.25 / 15dB / `minMs`）→ `reject`；全部高于「舒适线」（0.4 / 20dB）→ `good`；其余 `fair`。屏幕录音 `minMs=8000`，访谈单题 `3000`。
3. `recordScreening()` 在**裁剪前**的帧上算 SNR（裁剪会删掉噪声底），结果带 `quality` / `snrDb` **照常上传**，由 C 决定是否入基线——前端丢弃会让 C 丢分母（issue #3 约定）。
4. 录屏前已有「请随便讲一分钟」播报；ScreeningOverlay 加录音指示环（家属在场可见，长者不必看）。

**验收（自检断言）**：持续 −30dB 噪声 30s → `reject`；−60dB 底噪上有 −20dB 语音、占比 50%、10s → `good`；时长 5s → `reject`。

#### A5 · 日常唤起与无障碍（1.5 天，M2）

> 判据：长者不用读字、不用记路径、不用精准点击，也能完成「叫出数字人 → 说需求 → 确认 → 收尾」；语音整条坏掉时纯按钮也能走完。

1. **唤起通路（五条，§2.7 ①）**：唤醒词（改名）/ 主按钮 / 长按数字人 1s / widget 点击（`onForeground("widget")` → `planForeground` 的 `listen`）/ 通知与闹钟（`onForeground` → `speak` / `refresh`）。锁屏 widget 的 SOS 热区：订阅 `memomate:sos` → **直接打开 SOS 覆盖层**，不等语音确认；`shouldRaiseSos` 做 10s 防抖（口袋误触不重复通知家属），事件带 `source: "widget"`。
2. **忘记唤醒词兜底**：主按钮下方常驻一行提示「叫我『小憶』，或者撳『講嘢』」；连续 3 天无交互时沉默关怀文案带同样指引（调度器第 5 条）。
3. **无障碍语义**：`main` 单一地标；数字人是 `<button>` + 动态 `aria-label`（「忆伴正在聆听，撳一下再講一次」）；状态行 `aria-live="polite"`；SOS 覆盖层既有 `assertive`；**禁止 `div onClick`**。
4. **焦点顺序** = 数字人 → 主按钮 → SOS → 次要按钮 → 工具面板（第一版把「食药提醒/高对比/语言」放在数字人之前，已下移到主按钮之后，主操作区落在屏幕下半）；工具面板经语音打开时焦点移入，`Esc` 关闭并把焦点还给主按钮。
5. **触控与反馈**：主按钮/SOS ≥120×80px；任何按钮按下 `navigator.vibrate(30)`（页面级一个 `pointerdown` 监听，不逐个加）；关键失败（麦克风被拒、网络断）用语音 + 字幕双通道，不显示错误码。
6. **字幕**：数字人说的每一句同步显示在**数字人正下方**的字幕条（2 行截断、48px，大字档 64px，高对比黑底黄字）。放在脸旁边而不是屏幕最底部：听力差的长者读字幕时视线不用离开数字人，也不会被底部卡片流遮挡。
7. **三档显示**：原「高对比」按钮改为循环「顯示：標準 → 高對比 → 大字」，按钮文字即当前档位；大字档在 `<html>` 上把根字号放大 1.25 倍，所有 rem 尺寸一次到位；选择存本机，重启保留；色觉安全（状态永远配文字）。
8. **语音不可用的纯按钮通路**：STT 不支持或**连续 2 次没听到** → 自动展开工具面板，顶部是「常用三件事」：食药 / 今日安排 / 打畀屋企人（`tel:` 链接到健康卡紧急联系人，平台原生拨号，无新权限）。第一版的「打电话」与「找家人」对长者是同一件事，合并（§2.8 D-5）。
9. **接桥（issue #1）**：`useAgentBridge({ locale, reminders, onCards: pushCards, onSpeak: speakLine, onConfirm: askYesNo, onSos })`；所有语音/文字输入先过 `agent.handleUtterance()`，返回 `false` 才走原 `runIntent`。`askYesNo` = 播报问题 + `listenOnce(8s)` + 是/否词表，**沉默或听不清一律判否**（不误执行）。`recentTurns` 由 B 在桥里攒（A 的 `historyRef` 已存在，B 需要时 A 加一个只读导出）。
10. `repeat` 意图 = 重说上一句；`cancel` 意图 = 「好，唔做住」并回到空闲。

**验收**

- 关掉麦克风权限 → 主按钮仍能进入对话，8 秒内出现「常用三件事」；全程无死路。
- TalkBack 冷启动到「说一句话」≤ 4 次滑动（数字人 → 主按钮即可）；朗读内容含状态与用途。
- widget SOS 热区 → SOS 覆盖层直接打开。
- `grep -rn "div onClick\|span onClick" web/src` 为空。

#### A6 · 语音优先的问答弹窗与自由对话（0.5 天，M3 · 2026-10-25 真机回归）

真机暴露：天气卡只在卡片流里静默出现（不弹窗、不朗读、问「會唔會落雨」也不正面回答）；自由对话回复趋同；任何卡片出现都没有朗读。

1. **天气不进接桥**：`handleSaid` 在 `agent.handleUtterance()` **之前**短路 `weather`。B 的 `runTurn` 对 `LOCAL_CARD_INTENTS` 只推卡不发声，会把天气吞掉；`weather` 已从 `LOCAL_CARD_INTENTS` 移除（现为 `{tasks, medication}`）。
2. **真实数据**：weather 分支先 `POST /agent/cards`（C 的 weather 分支短路不经 LLM，直接读 Open-Meteo）；失败才用本地卡。本地卡**不再编造 27°C**，只诚实说「暂时拿不到实时天气」。
3. **整屏答案层**：新增 `components/CardSheet.tsx`（`role="dialog"` + `aria-modal`），只有一个 ≥96px 高的关闭键（文字 5xl），打开即聚焦关闭键；支持 `html` / `image` / `headline` / `rows` / `checklist`。它同时占用 `blockedRef`，弹窗期间不发起主动唠嗑。
4. **读的就是卡上的字**：`weatherSpoken(card, locale, askedRain)` 按阅读顺序把 `headline` 与各行拼成一句话；问句含「雨/落雨/雪」时**先给是/否**（「係，今日會落雨」/「唔係，今日唔會落雨」），再读温度与其余行。
5. **自由对话不再以 `isQuestion` 为门槛**（老人说「我好悶」「今日有咩做」也算），请求带最近 8 轮 `user`/`assistant` 历史；答案进 `CardSheet` 并朗读；后端失败才落到本地兜底。
6. **兜底不重复**：`agent.ts` 的 `COPY` 每槽改为 3 句随机池，`i18n.ts` 新增 `pickT()`，`noSpeech` / `intentUnknown` 同样随机取句。
7. 其他卡片带 `headline` 时也朗读该行；不再出现「屏幕上多了一张卡但没人解释」。

**验收**

- 说「今日天氣」→ 先听到温度/降雨，整屏弹窗出现，只有一个大号「關閉」；关闭后回到主页且唤醒词重新武装。
- 说「今日會唔會落雨？」→ 第一句就是「係/唔係」，卡片首行有「今日落雨」。
- 连续问 3 个不同问题 → 3 条回复措辞明显不同（C 侧 temperature 0.85 + 保留 assistant 轮次，见 C3）。
- 断网说天气 → 「暂时拿不到实时天气」，不出现任何编造数值。
- 构建门禁：`npm run build`、`node src/selfcheck.ts` 全绿。

### 2.5 第一部分接口契约（对其他两人的接缝）

```ts
// lib/interview.ts
export type InterviewDomain = "memory" | "orientation" | "language" | "daily_living" | "mood";
export interface InterviewItem {
  id: string;                         // "memory-01"
  domain: InterviewDomain;
  prompt: { hk: string; cn: string }; // zh-MO 复用 hk
  followUp?: { hk: string; cn: string }; // 答不上来时的提示（不是答案）
  scoreHint: "recall" | "fluency" | "sequencing" | "orientation" | "self_report";
  sayToday?: boolean;                 // 答完后温和播报当天日期（定向支持，不是纠正）
}
export interface InterviewAnswer { id: string; at: number; durationMs: number; textLen: number; confidence: number; timedOut: boolean }
export interface InterviewState { startedAt: number; answers: InterviewAnswer[]; stop?: "refuse" | "tired" | "sad" }
export type InterviewHistory = Record<string, { at: number; timedOut: boolean }>;  // 存 meta，最近一次
export function pickNext(s: InterviewState, h: InterviewHistory, now: number): InterviewItem | null;
export function shouldStop(s: InterviewState, now: number): boolean;
export function careCue(text: string): "refuse" | "tired" | "sad" | "lost" | null;
export function isYes(text: string): boolean | null;   // null = 不确定，调用方必须当作「否」
export function todayLine(locale: string, now: number): string;
```

```ts
// lib/proactive.ts
export type ProactiveKind = "reminder" | "silence" | "interview" | "greeting";
export type ProactiveTrigger = "tick" | "open" | "alarm" | "boot";
export interface ProactiveCtx {
  now: number; trigger: ProactiveTrigger;
  lastSpokeAt: number | null; spokenToday: number;   // 跨日自动清零，调用方传原值即可
  lastInteractionAt: number | null;                    // 算 silentDays（本地日历日）
  interviewAt: number | null;                          // 与 now 同一天 = 今日已访谈
  hasDueReminder: boolean;
}
export interface ProactiveAction { kind: ProactiveKind; reason: string; silentDays: number }
export function planProactive(c: ProactiveCtx): ProactiveAction | null;
export function recordSpoke(r: ProactiveRecord, now: number): ProactiveRecord;  // 纯函数，更新预算计数
```

```ts
// lib/viseme.ts
export const VISEME_FRAME_MS = 65, FRAMES_PER_CHAR = 4;
export function visemeFromText(text: string): number[]; // 0..1，长度 = 字数 × 4
// 第一版的 visemeFromAnalyser 删除：Web Speech 与 Android TextToSpeech 都不暴露音频流/
// PCM，没有可接的 AnalyserNode；麦克风侧的 RMS 已由 audio.ts#createAmplitudeMeter 提供。
// 口型由 visemeFromText 的时间线驱动，仅 Web Speech 的 onboundary 会做逐字校准。
```

```ts
// lib/types.ts（A 提议，C 已 extra="allow" 可直接收）
export interface ScreeningSession { /* …既有字段… */ quality?: "good" | "fair" | "reject"; snrDb?: number }
```

**A → C 的上送口径（issue #3）**

| 数据 | 通道 | 内容 | 不含 |
|---|---|---|---|
| 访谈逐题 | `POST /telemetry/events`，`name:"interview_answer"` | `item / domain / durationMs / textLen / confidence / timedOut` | 原文、音频 |
| 访谈结束 | 同上，`name:"interview_end"` | `answered / reason` | — |
| 主动开口 / 交互 | 同上，`proactive` / `interaction` | `kind / trigger` / `source` | — |
| 质量门控 | `POST /screening/sessions` 的 `quality` / `snrDb` | 三档 + dB | — |
| 回答原文 | `POST /conversation/turns`（既有，C5 加密 + TTL） | 原话 | — |

**风险分层三档文案（A 的唯一显示口径）**：`low` 一切如常 / `watch` 值得留意 / `elevated` 建议检查（`i18n.ts#riskBandLabel`）。长者端**不显示**任何分层、分数或颜色；家属端只显示中文三档，`sufficient=false` 或 `insufficientStreams=true` 时显示「样本不足，继续观察」。

**A 对 B 的需求（W3 已全部交付，A 只消费）**

| 需求 | 接口 | 状态 |
|---|---|---|
| 定时唤醒 | `bridge()?.scheduleDaily(10, 0)` | ✅ B W3 |
| 前置原因 | `onForeground(({reason}) => …)` | ✅ B W3（冷启动补发） |
| 锁屏 SOS | `window` 事件 `memomate:sos` | ✅ B W3 |
| 听力代理 | `MemoNative.getMediaVolume()`（新提） | ⏳ M4，见 §2.8 D-7 |

### 2.6 第一部分自检

```bash
cd web
npm run typecheck
node src/selfcheck.ts   # 新增：改名无残留 / 唤醒词 / 访谈题库与选题停止 / careCue / 打扰预算七条 /
                        #       viseme 长度与闭口 / parseManifest 降级 + kei 清单 / TTS 接线 / snrDb & qualityOf / 风险三档 / 无责备措辞
grep -rn "灵犀\|靈犀\|lingxi" src/ | grep -v "lib/native.ts\|selfcheck.ts" || echo "PASS: 无旧名残留（native.ts 默认值属 B0）"
for f in vendor/live2dcubismcore.min.js vendor/pixi.min.js vendor/cubism4.min.js kei/kei_basic_free.model3.json; do
  test -f "public/live2d/$f" || { echo "MISSING $f"; exit 1; }
done; echo "PASS: 运行时与模型齐备"
! grep -rnE "(div|span) onClick" src --include='*.tsx' && echo "PASS: 无非交互元素点击"
! grep -rnE "from ['\"](pixi|pixi-live2d-display)" src && echo "PASS: 无 Live2D 静态依赖"
```

### 2.7 日常唤起与无障碍交互规格（A 主责，B 供原生能力）

**① 唤起通路矩阵**

| # | 通路 | 前提 | 触发后发生什么 | 归属 | 状态 |
|---|---|---|---|---|---|
| 1 | 说「小忆 / 阿忆 / 忆伴」 | 麦克风 | 停当前播报 → 「我喺度…」→ 聆听 | A（前台）/ B（锁屏） | M0 |
| 2 | 单击主按钮 | 无 | 打断播报 → 聆听 | A | 已有 + 打断修复 |
| 3 | 长按数字人 1s | 无 | 打断播报 → 「你想講咩？」→ 聆听 | A | M2 |
| 4 | 点击桌面小组件 | 已加小组件 | `onForeground("widget")` → 直接聆听 | B 原生 / A 响应 | M2 |
| 5 | 点击通知 / 到点闹钟 | 通知权限 | `onForeground("alarm"/"notification"/"reminder")` → 调度器决定说什么 | B 原生 / A 响应 | M2 |
| 6 | 开机自启 | `BOOT_COMPLETED` | 只重排闹钟；A 收到 `boot` **保持静默** | B | M2 |
| 7 | 锁屏小组件 SOS 热区 | 已加小组件 | `memomate:sos` → 直接打开 SOS 覆盖层 | B 原生 / A 响应 | M2 |
| 8 | 耳机线控 / 音量键长按 | 系统媒体键 / 无障碍 | 进入聆听 | B | M4（可选） |

> 前 5 条 + 第 7 条是**答辩必须演示**的通路。

**② 无障碍验收基线（TalkBack / VoiceOver 通用）**

| 项 | 硬性要求 | 检查方式 |
|---|---|---|
| 语义角色 | 可交互元素是 `button`/`a`/`input`；数字人是带 `aria-label` 的 `button` | TalkBack 逐元素朗读 |
| 状态播报 | 状态行 `aria-live="polite"`；SOS `assertive` | 开关麦克风 / 触发 SOS 各听一次 |
| 焦点顺序 | 数字人 → 主按钮 → SOS → 次要按钮 → 工具面板 | 键盘 Tab 走一遍 |
| 触控目标 | 主按钮 ≥120×80px；次要按钮 ≥60×60px；间距 ≥16px | `getBoundingClientRect()` |
| 非视觉反馈 | 按下振动 30ms；关键状态有语音 | 静音屏幕外操作一次 |
| 无语音可用 | 纯按钮完成「食药 / 今日安排 / 打畀屋企人」 | 断麦克风权限演练 |
| 动效 | `prefers-reduced-motion` 下零位移，仅嘴部/眨眼 | 系统开关切换 |
| 对比度 | 文字 ≥4.5:1；高对比档 ≥7:1 | 取色器抽 3 处 |

**③ 与 §1.8 的对应**：`A【缺】` 两行中，视觉适配由 A5 第 6–7 条覆盖；听力代理需 B 的原生音量接口（D-7，M4）；餐点关注由 C 的周报从 `interaction` 事件计算。认知类各行：访谈（A1）、定向题不纠正（A1）、停顿不插话（`listenOnce` 8s 不打断）、反复提问**只计数**（`track("repeat_question")`，从不提醒长者「你问过了」）、找不到东西只安抚 + 计数（`careCue === "lost"`）、情绪主诉只陪伴（`careCue === "sad"`）、无责备措辞（自检词表断言）。

### 2.8 决策记录（相对第一版的偏离，均按 ponytail「能删就删、能复用就复用」裁决）

| # | 第一版 | 本版 | 理由 |
|---|---|---|---|
| D-1 | `vad.ts` 换 Silero（`@ricky0123/vad-web`） | **不引入**；新增 `snrDb()` + `qualityOf()` | 质量门控要拦的是「电视/风扇这类持续声」，Silero 只回答「是不是人声」——**电视里也是人声**，拦不住。而电视节目经过响度压缩、风扇空调是稳态噪声，二者的帧能量动态范围都窄，SNR（P90−P10）正好区分。省掉一个依赖 + ~2MB ONNX/wasm。天花板（离麦克风很近、动态大的电视对白仍可能过门）用 `ponytail:` 标在 `signal.ts`，升级路径：Silero 判人声 × SNR 判清晰度，二者相乘 |
| D-2 | npm 引入 `pixi.js` + `pixi-live2d-display`，动态 import | **运行时脚本注入**，清单 `runtime` 字段 | Cubism Core 本就只能脚本加载；统一后零依赖、零首屏体积，许可证边界集中在 `public/live2d/vendor/` |
| D-3 | `visemeFromAnalyser(a)` | 删除 | Web Speech 与 Android `TextToSpeech` 都不给音频流（后者连 `onboundary` 也没有），没有可接的 AnalyserNode；Web 路径改用 `onboundary` 逐字校准，原生路径按时间线推进 |
| D-4 | `?demo=1` 预置脚本替换 STT | 删除 | 工具面板已有文字输入，走同一条 `runIntent`；嘈杂展台直接打字，不需要第二套构型 |
| D-5 | 「常用四件事」：吃药 / 打电话 / 今日安排 / 找家人 | 「常用三件事」：食药 / 今日安排 / 打畀屋企人 | 「打电话」和「找家人」对长者是同一个动作；`tel:` 链接是平台原生拨号，无需 B 的 `CALL_PHONE` 权限 |
| D-6 | 数字人 `role="img"` 且可点击 | 外层 `<button>` | 可点击的 `img` 违反本节自己的「禁止非交互元素挂点击」，读屏也不会告诉长者「可以点」 |
| D-7 | 「音量 ≤30% → 自动调高 TTS 一级」 | 推迟 M4，需 B 提供 `getMediaVolume()` | Web 读不到系统音量，`SpeechSynthesisUtterance.volume` 默认已是最大值 1.0；Android `TextToSpeech` 也没有音量 API（走 STREAM_MUSIC），「调高一级」两端都不存在，仍需 B 的原生 `AudioManager` 读数 |
| D-8 | 访谈「连续 2 次拒答才停」 | 拒答一次即停 | 与同节验收矛盾；尊严优先 |
| D-9 | 调度优先级 访谈 > 沉默关怀 | 沉默关怀 > 访谈 | 原顺序下沉默关怀永不触发（见 A2） |
| D-10 | `StaticPortrait.tsx`、`components/avatar/MountLive2D.ts` 两个新文件 | 并入 `Avatar.tsx` / `lib/live2d.ts` | 最少文件；L3 只是几行 JSX |
| D-11 | `checkin.ts` 每日签到 | 删除，并入调度器 | 两套「今天是否第一次」判定会互相打架 |
| D-12 | 清单 `model:null` 时「连网络请求都不发」 | 只发一次清单请求 | 不读清单无法知道它是 null；要零请求只能构建期内联，而那会破坏「拔掉清单仍能构建」 |
| D-13 | 接云端童声 TTS 插件（如 Azure/火山 neural child voice） | **不接**；原生 `TextToSpeech` + `pitch 1.35` / `rate 0.9`，Web Speech 同参数回退 | 童声只在云端有真模型，一次合成就要把长者对话文本（含姓名、用药、情绪）送出端，直接违反 PDPO 数据最小化；而系统 TTS 零延迟、离线可用、免费。代价是「像小孩」只是音高近似而非真童声——不宣称是真人童声，只在文档与答辩里明说。若未来拿到**端侧**童声模型（ONNX/TFLite）再替换，接口仍是 `AuraNative.speak` |

---

## 3. 第二部分 · Agent 编排与手机能力接管（开发者 B）

### 3.1 目标与非目标

**目标**

1. 把「长者一句话」变成**可执行的动作集合**：建任务卡、设提醒、导航、打电话、读消息、代点屏幕。
2. 建立 **Agent 工具层**：每个工具都有 JSON Schema、权限声明、风险等级、可回滚性。
3. 补齐原生能力：桌面小组件、自动前置、精确定时、GPS 地理围栏、无障碍自动化。
4. 建立**安全护栏**：任何不可逆操作必须二次语音确认；任何代操作都留可审计轨迹。

**非目标**

- ❌ 不做「全自动代付 / 代转账 / 代发消息给陌生人」——风险不可控，明确写入产品边界。
- ❌ 不申请 `QUERY_ALL_PACKAGES`、不申请短信读取（除非演示必须且经评审）；权限清单见 §3.6。
- ❌ 不做 iOS 无障碍自动化（平台不开放），iOS 仅保语音 + 卡片 + 通知。

### 3.2 交付物清单

| # | 交付物 | 形态 |
|---|---|---|
| B-1 | Agent 工具注册表 + 执行器（含 dry-run） | `lib/tools.ts`、`lib/toolrun.ts` |
| B-2 | 对话→工具调用编排（前端 + 后端 `/agent/turn` 客户端） | `lib/agent.ts`、`api.ts` |
| B-3 | 任务卡系统（可勾选、可延后、可语音勾销） | `lib/cards.ts` + `db.ts` 新 store `tasks` |
| B-4 | 位置能力：GPS + 地理围栏 + 地图卡 | `lib/geofence.ts`、`lib/tools.ts#locate` |
| B-5 | 原生补齐：小组件 / 前置 / 定时 / 电池优化白名单引导 | `MemoNativePlugin.java`、`HomeWidgetProvider.java` |
| B-6 | 无障碍 Agent（受限范围） | `AutoPilotService.java`、`AutoPilotRunner.java` |
| B-7 | 离线 outbox（特征与事件重放） | `lib/outbox.ts`、`db.ts` |
| B-8 | 安全护栏与审计（本地 `agent_audit` store） | `lib/toolrun.ts` |
| B-9 | 唤起与生命周期原生面（小组件 SOS、开机重排、锁屏前置） | `HomeWidgetProvider.java`、`MainActivity.java`、`BootReceiver.java` |
| B-10 | 低频被动通道（昼夜节律 / 数字能力，仅计数） | `lib/rhythm.ts`、`lib/digitalSkill.ts`、`BehaviourDaily` 扩展 |

### 3.3 文件级改动点

| 文件 | 操作 | 说明 |
|---|---|---|
| `web/src/lib/tools.ts` | 新增 | 工具声明：`name / description / schema / risk / permissions / run()` |
| `web/src/lib/toolrun.ts` | 新增 | 执行器：参数校验 → 风险确认 → 执行 → 结果 → 审计写库 |
| `web/src/lib/agent.ts` | 新增 | `runTurn(utterance, ctx)`：本地意图 → 后端 `/agent/turn` → 工具调用计划 → 执行。`LOCAL_CARD_INTENTS` 只含 `{tasks, medication}`——**天气不在其中**（本地卡无实时数据，A 走自己的弹窗/朗读路径，见 §2.4 A6）。离线兜底文案每槽 3 句随机池 |
| `web/src/lib/geofence.ts` | 新增 | 纯函数：`inCircle`、`shouldAlert(prev, cur, fence)`（去抖 + 最小停留 60s） |
| `web/src/lib/outbox.ts` | 新增 | 指数退避重放：`enqueue` / `drain`（上限 500 条、7 天过期） |
| [intent.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/intent.ts) | 扩充 | 保留关键词兜底；新增 `navigate / call / alarm / message / repeat / cancel` |
| [cards.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/cards.ts) | 扩充 | `taskCard()`、`placeCard()`、`alarmCard()`、`agentPlanCard()`（展示「我准备做这 3 件事」） |
| [native.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/native.ts) | 扩充 | 新增 8 个方法（见 §3.5）；另有 A 侧已落地的 `speak` / `stopSpeak` / `warmTts`（原生 TTS，见 §2.3 A3） |
| [api.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/api.ts) | 接线 | `getAgentCards` / `assistantChat` / `getMedicationPlan` 接真后端；新增 `postAgentTurn`、`postTaskEvent`、`postBehaviorDaily` |
| `AuraNativePlugin.java` | 重命名 + 补实现 | → `MemoNativePlugin.java`；`updateHomeWidget`、`bringToForeground`、`scheduleDaily`、`getLocation`、`openAccessibilitySettings`；保留 A 的 `speak` / `stopSpeak`（`TextToSpeech`，`UtteranceProgressListener` 持有 `PluginCall`） |
| `HomeWidgetProvider.java` | 新增 | `AppWidgetProvider`：读 `SharedPreferences` → 渲染提醒清单 |
| `res/layout/widget_home.xml`、`res/xml/widget_info.xml` | 新增 | 2×2 小组件：数字人头像 + 今日待办 3 条 |
| `AutoPilotService.java` | 新增 | `AccessibilityService`：接收指令 → 找节点 → 执行 → 回传 |
| `AndroidManifest.xml` | 修改 | 注册 service、widget receiver、`accessibility_service_config.xml`；`<queries>` 声明 `TTS_SERVICE`（Android 11+ 包可见性，否则 TTS 引擎不可见） |

### 3.4 任务分解（可直接认领的步骤）

#### B0 · 改名 + 原生基线（0.5 天）

1. 按 §1.3 第 4、5、9 项改 Java 与 `native.ts`。
2. `npx cap sync android` 后 `./gradlew assembleDebug` 必须成功（M0 门禁）。
3. 装机验证：后台唤醒词改成「小忆」后能前置主界面。

#### B1 · 工具注册表与执行器（1.5 天）

**步骤**

1. 定义 12 个工具（见 §3.5 表），每个都写 `risk: "safe" | "confirm" | "forbidden"`。
2. `toolrun` 固定五步：**校验 → 风险确认 → 执行 → 记录 → 播报结果**。任何一步失败都要给出**长者能听懂的一句话**（不是 error code）。
3. `dryRun` 模式：只返回「我将要做什么」，用于答辩演示与测试。
4. 所有执行写 `agent_audit`（时间、工具名、参数摘要、结果、是否确认），本地保留 30 天。

**验收**

- 说「帮我记住听日十点去覆诊」→ 生成 `task` 卡 + `alarm` 工具调用（`safe`）；说「帮我打电话畀阿明」→ 必须先问「系咪打畀陳小明？」（`confirm`）。
- 说「帮我转账」→ 明确拒绝并说「呢個我做唔到，要你自己或者屋企人做」（`forbidden`）。

#### B2 · 任务卡与服药依从（1 天）

1. `tasks` store：`{ id, text, dueAt?, done, doneAt?, source, deferredCount }`。
2. 语音勾销：「我食咗药」→ 命中最近一条未完成 `med` 任务 → `doneAt` 记录 → 算**确认延迟**（提醒到期到确认的分钟数）。
3. 新增行为指标（供 C 使用）：`task_confirm_delay_min`、`task_timeout_rate`、`task_defer_count`、`task_completion_rate`。
4. 每日 23:55 汇总一条 `postBehaviorDaily()`。

**验收**

- CASAS 可比性：`task2`（服药分装/服药确认）的日粒度指标必须存在且可导出为 CSV（C 用它做组间对照说明）。

#### B3 · 位置与地图（1 天）

1. `getLocation()`：`@capacitor/geolocation` 或原 `LocationManager`，精度要求 `BALANCED`，超时 8s，失败返回 `null`（不抛）。
2. 地理围栏（**不申请后台定位**，仅在 App 前台与主动提醒时取点）：家 → 500m 圆；离家 > 60 分钟且非计划 → 生成 `place` 卡并通知家属。
3. 地图卡**不用第三方地图 SDK**（合规与包体考虑）：用静态图 URL 或纯文本地址 + 距离 + 方向。

**验收**

- 断网时地图卡降级为「你而家喺 XX 附近，离家 1.2 公里」。
- 定位权限被拒 → 明确播报一次，之后不再反复请求（尊重拒绝）。

#### B4 · 原生补齐：小组件 / 前置 / 定时（1.5 天）

1. `updateHomeWidget`：写 `SharedPreferences("memomate_widget")` → `AppWidgetManager.updateAppWidget`。
2. `bringToForeground(reason)`：`Intent` 带 `reason`，`MainActivity` 用 `onNewIntent` 转成 JS 事件 `native:foreground`。
3. `scheduleDaily(hour, minute)`：`AlarmManager.setExactAndAllowWhileIdle` + `BOOT_COMPLETED` 重排。
4. 首次进入引导页（**一次性**）：电池优化白名单 + 自启动说明（各厂商差异，只需一句「如果唔响，去设置容许后台运行」）。

**验收**

- 锁屏 → 到点 → 通知出现 → 点击 → App 前置并主动开口。
- 重启手机 → 定时仍生效（`BOOT_COMPLETED` 验证）。

#### B5 · 无障碍 Agent（2 天，风险最高，做减法）

> 参考成熟实现：`Core-Mate/OpenGUI`（截图理解 UI + tap/swipe/type，要求 Android 11/API 30+、无障碍服务、悬浮窗、电池豁免）、`orailnoor/private-agent`（UI 树 + 坐标兜底 + 逐步反馈闭环，Android 8.0+，建议 API 30+）。

**步骤**

1. `accessibility_service_config.xml`：`canRetrieveWindowContent=true`、`canPerformGestures=true`、`notificationTimeout=100`；**不声明** `flagRequestFilterKeyEvents`（不监听按键）。
2. `AutoPilotRunner` 固定循环：`getRootInActiveWindow()` 取节点树 → 找 `text/contentDescription` 命中 → 命中不了再用坐标（由节点 `bounds` 中心计算，**不截图上传**）→ 执行 `ACTION_CLICK` → 等 800ms → 校验结果（页面标题/节点变化）。
3. **只允许白名单场景**（写死在代码里，不可由后端扩展）：
   - 打开指定 App（微信 / 电话 / 相机 / 设置）
   - 在已打开的 App 内滚动到某个文本并点击一次
   - 返回 / 回桌面
4. 每个动作前在悬浮层显示「我准备点呢度」+ 3 秒可取消；不可逆动作（发送、删除、支付）**一律禁止**。
5. 失败 3 次即停止并播报「我搵唔到，你自己试下」。

**验收**

- 目标 App 版本变更导致找不到节点 → 3 次后安全退出，不误点。
- 审计日志能还原「点了哪个节点、什么文本、什么 bounds」。

#### B6 · 离线 outbox 与重放（0.5 天）

1. `enqueue(kind, payload)` 写 `outbox`；`drain()` 按 `kind` 批量发送，成功删除，失败退避（1s/5s/30s/5min，最多 7 天）。
2. 前端所有 `post*` 调用改为「先 enqueue → 立即尝试 drain」。
3. 上限 500 条，超限丢最旧并记 `outbox_drop`。

**验收**

- 飞行模式采集 10 分钟 → 恢复网络 → 后端收到全部（顺序不保证，去重按 `id`）。

#### B7 · 唤起通路与生命周期（1 天，对应 §2.7 ①）

1. `HomeWidgetProvider`：2×2 组件内**第二个热区是 SOS 按钮**（`PendingIntent` 直接进 `MainActivity` 并带 `action=sos`），**不要求解锁即可触发**（`setShowWhenLocked`）。
2. `BootReceiver`：监听 `BOOT_COMPLETED` / `MY_PACKAGE_REPLACED`，只**重排闹钟与小组件**，不自动拉起界面、不自动发声。
3. `bringToForeground(reason)` 支持 `widget | alarm | reminder | notification | boot` 五种 reason，JS 侧据此决定播报内容。
4. 长按数字人 1s 由 A 在 Web 实现（`onPointerDown` 计时满 1s 触发 + 视觉进度环），B 不参与；但**长按期间必须阻止 `speak()` 打断**，两者共用 A 的状态机。
5. 耳机媒体键（可选，M4）：`MediaSession` 回调 → 发 `native:mediakey` 事件。

**验收**

- 锁屏 → 点小组件 SOS 热区 → 8 秒内 `post_sos` 有记录（模拟）。
- 重启 → 不弹界面、不发声，但当日闹钟仍在 `AlarmManager` 中。

#### B8 · 低频被动通道（1 天，对应附录 A.1 中 B 负责的两项【缺】）

1. `lib/rhythm.ts`：监听 `ACTION_SCREEN_ON` / `ACTION_USER_PRESENT` / 充电广播（均为系统广播，**无需运行时权限**）→ 每日汇总 `{ firstActiveAt, lastActiveAt, nightWakeCount, chargingHours }`。
2. `lib/digitalSkill.ts`：仅在前台服务内计数 `appSwitchCount`（`UsageStatsManager` 需 `PACKAGE_USAGE_STATS`，**默认关闭**，在 §3.6 权限表登记为可选）、`opFailRate`、`firstTouchDelayMs`。
3. 两个新通道作为**独立类型**随同一次 `postBehaviorDaily` 上传：`{ behaviour: BehaviourDaily, circadian?: CircadianDaily, digitalSkill?: DigitalSkillDaily }`；缺哪项就整项省略，C 侧一律按 `null` 处理（不向前兼容旧字段，也不填补 0）。
4. A 侧的 `HearingProxyDaily` / 视觉偏好不改原生，直接读 `window.matchMedia` 与系统音量事件（Web 可得的子集），失败则整条跳过。

**验收**

- 关权限 / 关服务 → 两类指标为 `null`，`postBehaviorDaily` 仍成功（不阻塞其它字段）。
- 连续 3 天数据 → C 能算出「夜间觉醒次数」与「App 切换频次」的 7 日均值。

### 3.5 工具契约（B 对 C 与 A 的接口）

| 工具 | 风险 | 权限 | 入参 | 出参 | 说明 |
|---|---|---|---|---|---|
| `create_task` | safe | 无 | `{text, dueAt?}` | `{taskId}` | 说啥记啥 |
| `complete_task` | safe | 无 | `{taskId \| query}` | `{taskId, delayMin}` | 语音勾销 |
| `defer_task` | safe | 无 | `{taskId \| query, minutes?}` | `{taskId, dueAt}` | 推迟提醒 |
| `set_alarm` | safe | `SCHEDULE_EXACT_ALARM` | `{at, label}` | `{alarmId}` | 本地闹钟 |
| `call_contact` | **confirm** | `CALL_PHONE` | `{name}` | `{number}` | 必须先复述姓名 |
| `send_message` | **confirm** | 无（走系统分享） | `{name, text}` | `{ok}` | 只允许预设模板句 |
| `locate` | safe | `ACCESS_FINE_LOCATION` | `{}` | `{lat,lng,accuracy}` | 前台取点 |
| `navigate_home` | safe | 无 | `{}` | `{distanceM}` | 文本 + 静态图 |
| `plan_route` | safe | 无 | `{destination?}` | `{card}` | 出行路线：给步骤卡 + 建「去 X」任务；离线本地规划器也能触发（见 §3.5 说明） |
| `open_app` | confirm | 无障碍 | `{app}` | `{ok}` | 白名单 App |
| `ui_tap_text` | confirm | 无障碍 | `{text}` | `{ok, bounds}` | 当前页面内点一次 |
| `sos` | safe（最高优先） | 无 | `{reason}` | `{}` | 立即升级 |

> **离线规划器（勘误）**：`toolrun.ts#planLocal` 在没有模型/后端时也能把明确的出行请求变成真实动作：`帶我去街市` → `plan_route`、`點返屋企` → `navigate_home`、`我喺邊` → `locate`。它刻意**不**猜天气/App/联系人——猜错的代价（开错应用、打错电话）比不行动高。模型给出的计划优先；模型只回话不调工具时，本地计划仍然执行，避免「说了规划却没有下文」。

```ts
// lib/tools.ts
export interface ToolDecl<I = unknown, O = unknown> {
  name: string;
  description: string;                 // 给 LLM 的英文描述
  schema: Record<string, unknown>;     // JSON Schema
  risk: "safe" | "confirm" | "forbidden";
  permissions: string[];
  run(args: I, ctx: ToolCtx): Promise<O>;
}
```

```ts
// 后端 /agent/turn 契约（C 实现，B 调用）
interface AgentTurnRequest {
  utterance: string;
  locale: Locale;
  now: number;
  context: {
    recentTurns: { role: "user" | "assistant"; text: string }[]; // ≤10
    openTasks: { id: string; text: string; dueAt?: number }[];
    riskBand?: "low" | "watch" | "elevated";
  };
  tools: { name: string; description: string; schema: unknown }[]; // B 提供
}
interface AgentTurnResponse {
  reply: string;
  calls: { name: string; args: Record<string, unknown> }[];  // 0..3 个
  cards: AgentCard[];
  needsConfirm?: { callIndex: number; question: string };
}
```

### 3.6 权限矩阵（答辩必答）

| 权限 | 何时申请 | 拒绝后的降级 | 合规说明 |
|---|---|---|---|
| `RECORD_AUDIO` | 首次唤醒开关 | 纯按钮模式（fail-open） | 采集前有可听提示音 + 屏幕指示环 |
| `CAMERA` | 首次用「影相」 | 卡片提示「相机唔可用」 | 仅按压式单帧，**不后台开启** |
| `POST_NOTIFICATIONS` | 首次启动 | 仅前台提醒 | Android 13+ 需运行时 |
| `ACCESS_FINE_LOCATION` | 首次用定位 | 手输地址 | **不申请后台定位** |
| `SCHEDULE_EXACT_ALARM` | 首次设定时 | 允许窗口内近似（±15min） | Android 12+ 需用户授权 |
| `CALL_PHONE` | 首次打电话 | 跳系统拨号盘（不直接拨） | 更安全，优先此路径 |
| `BIND_ACCESSIBILITY_SERVICE` | 用户在设置中手动开启 | 所有自动化禁用，仅语音+卡片 | **必须**在开启前解释用途；不可编程开启 |
| `BATTERY_OPTIMIZATION` 豁免 | 引导页（一次性） | 主动提醒可能延迟 | 仅请求，不强制 |
| `PACKAGE_USAGE_STATS`（可选） | **默认不申请**；仅家属在设置内显式开启后 | 数字能力指标为 `null` | 需用户去系统设置手动授予；不做引导弹窗 |
| `USE_FULL_SCREEN_INTENT` | 首次 SOS | 退化为普通通知 | 仅用于跌倒/主动 SOS 的锁屏全屏提醒 |
| 系统广播（屏幕/充电/开机） | 无需申请 | — | 清单静态注册，**不采集内容，仅时间戳** |

### 3.7 第二部分自检

```bash
cd web
npm run typecheck
node src/selfcheck.ts        # 新增：工具 schema 校验、风险分级、geofence 去抖、outbox 退避、意图扩展用例
cd android && ./gradlew assembleDebug
```

新增自检断言清单（写进 `selfcheck.ts`）：

1. 每个 `ToolDecl` 的 `name` 唯一，`risk` 合法，`schema` 有 `type: "object"`。
2. `"帮我转账"` → 命中 `forbidden`，不产生任何 `calls`。
3. `"打电话畀阿明"` → `needsConfirm` 为真。
4. `geofence.shouldAlert`：进出抖动 5 秒内不重复告警。
5. `outbox`：500 条上限淘汰最旧；7 天过期清理。
6. B7：`bringToForeground(reason)` 对 `widget|alarm|reminder|notification|boot` 五种 reason 都有非空播报文案（i18n 三语言）。
7. B8：`CircadianDaily` / `DigitalSkillDaily` 构造时缺字段必须为 `null`（不得用 0 填补），且 `postBehaviorDaily` 在两者全 `null` 时仍返回成功。

---

## 4. 第三部分 · 后端筛查、证据与合规经济（开发者 C）

### 4.1 目标与非目标

**目标**

1. 把三条数据流（语音声学 / 语言 / 行为）合成**可解释**的认知风险分层，并对个体做**纵向变化**检测。
2. 生成**家属可读**的周报（不含诊断词、不含原始音频、含"何时该看医生"的可执行建议）。
3. 交付赛题五步的全部书面材料与可复现数字：PICO、QALY、灵敏度/特异性目标、FMEA、NPV、每 QALY 成本、监管路径、TRL、IP、PDPO/PDPA 审计、伦理影响评估。

**非目标**

- ❌ 不做诊断、不给药物建议、不输出「你患了阿尔兹海默症」。
- ❌ 不做人脸/表情识别（避免生物特征合规风险）。
- ❌ 不做实时连续上传音频（仅在访谈/主动交互的**句末**上传派生特征）。

### 4.2 交付物清单

| # | 交付物 | 形态 |
|---|---|---|
| C-1 | 三流融合与阈值校准（声学 0.2 / 语义 0.8；watch 0.409 / elevated 0.521） | `config.py` 默认值修正 + `.env.example` |
| C-2 | 行为流（服药/任务/步态/交互频率） | `model/behavior.py`、`screening.py` |
| C-3 | 个人基线升级（robust Z + 最小样本 + 趋势斜率） | `baseline.py` |
| C-4 | 变化点检测（CPD）与趋缓告警 | `changepoint.py` |
| C-5 | LLM Agent `/agent/turn` + `/assistant/chat` + `/medication/plan` | `api/contract_routes.py`、`llm/prompts.py` |
| C-6 | 家属周报（PDF/HTML + 推送） | `reports/weekly.py`、`api/report_routes.py` |
| C-7 | SOS 真实通知链路 | `api/contract_routes.py#post_sos`、`notify.py` |
| C-8 | 会话记忆治理（加密 + TTL + 撤回） | `privacy.py`、`store.py` |
| C-9 | 赛题五步材料（内容已写在本文档附录 A–E，实施时按 C7 拆分子文件） | 本文档附录 + `docs/evidence/*.md` |
| C-10 | 存储升级（SQLite，保持四方法接口） | `store.py` |

### 4.3 文件级改动点

| 文件 | 操作 | 说明 |
|---|---|---|
| [config.py](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/backend/auragba/config.py) | 改默认 | `fusion_w_acoustic=0.2`、`fusion_w_semantic=0.8`、`risk_watch=0.409`、`risk_elevated=0.521`（与实测报告一致，D5） |
| `model/behavior.py` | 新增 | 行为特征 → 分数（规则 + 小样本校准），输出 `contributions` |
| [model/fusion.py](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/backend/auragba/model/fusion.py) | 扩展 | 支持三流：`late_fusion([acoustic, semantic, behavior], weights)`；缺流时权重重归一（**不编造分数**，沿用现有语义） |
| [baseline.py](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/backend/auragba/baseline.py) | 升级 | `_MIN_SAMPLES=10`；中位数 + MAD（`1.4826*MAD`，下限保护）；周窗均值；趋势斜率 |
| `changepoint.py` | 新增 | 简化 CUSUM：`S+ = max(0, S+ + (x - μ - k))`，`k=0.5σ`、`h=4σ` |
| [screening.py](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/backend/auragba/screening.py) | 扩展 | 接入 behavior 流与 CPD；结果新增 `behaviorStream`、`changepoints`、`quality` |
| `model/acoustic.py` / `semantic.py` | 保持 | 已训练产物路径不变；仅补 `contributions` 的稳定排序 |
| `api/contract_routes.py` | 修改 | 3 个 LLM 端点真实现（替换 501），与契约路由同文件 |
| `llm/prompts.py` | 新增 | 系统提示：**不诊断、不荐药、异常引导 SOS**；输出严格 JSON schema |
| `reports/weekly.py` | 新增 | 周报生成：趋势、依从性、交互次数、建议（含「建议预约认知评估」的阈值条件） |
| `api/report_routes.py` | 新增 | `GET /reports/weekly/me`、`POST /reports/weekly/send` |
| `notify.py` | 新增 | SMS/推送抽象（demo 用 webhook + 日志；生产接 Twilio/FCM） |
| [contract_routes.py](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/backend/auragba/api/contract_routes.py) | 修改 | `post_sos` 真发通知；`post_conversation_memory` 加 TTL/加密 |
| [store.py](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/backend/auragba/store.py) | 重写内部 | SQLite WAL；保持 `record/history/get_doc/set_doc` 四方法签名不变 |

### 4.4 任务分解

#### C0 · 口径修正与基线自检（0.5 天）

1. 按 D5 改 `config.py` 默认权重与阈值，同步 `.env.example`。
2. 跑 `python selfcheck.py`；新增断言：`settings.fusion_w_acoustic == 0.2`、`risk_watch == 0.409`。
3. 在 `docs/REPORT-2026-10-23-实测结果.md` 追加一段「代码默认值已与实测对齐」。

**验收**：同样输入在改前/改后分别输出的 `riskBand` 与报告一致（记录 3 个样例）。

#### C1 · 行为流与三流融合（2 天）

**步骤**

1. 定义行为特征（来自 B 的 `postBehaviorDaily`）：

| 特征 | 方向 | 来源 | 依据 |
|---|---|---|---|
| `task_confirm_delay_min` | + | 提醒→确认延迟 | CASAS task2（服药）dementia vs CTRL `Cliff's δ=0.817` |
| `task_timeout_rate` | + | 超时未确认比例 | 同上 |
| `task_completion_rate` | − | 完成率 | CASAS `tasks_sum`（MCI vs CTRL δ=0.424） |
| `defer_count` | + | 反复延后 | 执行功能下降 |
| `night_wake_count`（可选，缺则 `null`） | + | 夜间交互 / `CircadianDaily` | 昼夜节律紊乱 |
| `app_switch_count`（可选，缺则 `null`） | + | 前台应用切换频次 | 数字能力下降的早期代理指标 |
| `op_fail_rate`（可选，缺则 `null`） | + | 操作失败率 | 同上；缺失不进模型，不填补 |
| `interaction_count` | − | 日交互次数 | 社交退缩 |
| `gait_cv` | + | 步态变异系数 | 已有 `gaitVariability` |
| `fall_events` | + | 跌倒次数 | 已有三阶段检测 |

2. `behavior.score` 用**规则加权**（每项先做个体基线 Z，再线性加权），**不训练新模型**（样本不足，避免过拟合）。全部贡献进 `contributions`。
3. 三流融合：`risk = 0.15*acoustic + 0.65*semantic + 0.20*behavior`（**初始先验**，用现有 322 人数据的声学/语义两流回算后，在 `docs/evidence/fusion-sweep.md` 记录扫描结果，最终值以扫描为准）。
4. 缺流处理：任一流缺失 → 权重重归一；仅剩一流时**降级为 `low`** 并在结果里标 `insufficientStreams: true`（不得凭单流给 elevated）。

**验收**

- selfcheck：三流齐全时权重和为 1；缺 behavior 时 risk 与两流结果一致（回归保护）。
- 同一批历史数据回算，AUC 不低于两流基线 0.717 的 0.98 倍（避免行为流拖累）。

#### C2 · 基线与变化点（1.5 天）

1. `_MIN_SAMPLES=10`；用中位数 + `1.4826*MAD`（MAD 为 0 时用 `0.05*|median|` 兜底，防除零）。
2. 每个特征输出 `z`、`trend`（最近 4 周斜率）、`changepointAt`。
3. CUSUM 命中 → `changepoints: [{feature, at, direction}]`，写入结果。
4. 周报里把「单次异常」与「持续偏移（≥3 次同向）」分开表述。

**验收**

- 注入一段「前 8 周稳定、后 4 周单调恶化」的合成序列 → CUSUM 在转折后 2 周内报警。
- `_MIN_SAMPLES` 未满足时 `sufficient=false`，前端卡片显示「样本不足，继续陪你聊」而不是风险色。

#### C3 · LLM Agent 三端点（2 天）

**步骤**

1. `POST /agent/turn`：严格 JSON 输出（`reply / calls / cards / needsConfirm`）；用 B 提供的工具 schema 做 function calling。
2. 安全提示硬约束（system prompt + 后置校验双保险）：
   - 不得输出疾病诊断、药物剂量建议；
   - 出现「胸痛/呼吸困难/跌倒不起/流血」→ `calls: [{name:"sos"}]` 且 `reply` 只说「我而家帮你叫人」；
   - `calls` 里出现未注册工具 → 全部丢弃并返回 `reply` 要求重说。
3. `POST /assistant/chat`：无工具的纯对话（闲聊 + 安慰 + 引导做访谈）。
   - **保留 assistant 轮次**：`chat_messages` 按 `user`/`assistant` 原序回放（末 10 条，每条 scrub 后截 300 字）；只发 user 会让模型把每句都当新问题，回复收敛成同一句。
   - `temperature 0.85`（`complete_text` 可传参，默认仍 0.2）：同一问题连问三次必须给出不同措辞。
   - system prompt 明确「每次换说法、不复述、可先回应情绪」；**不编造实时天气**，问天气就说「我帮你看天气卡」。
4. `POST /medication/plan`：从 `history` + `utterance` 抽 `{name, dosage, schedule}`；**只抄不推断**，抽不到就返回空并让前端回退。
5. 超时 6s → 返回 503，前端走本地兜底（不阻塞长者）。
6. **weather 卡首行就是答案**（2026-10-25）：`weather.py` 用 Open-Meteo `daily.weather_code` + `precipitation_probability_max` 算出 `rain_today` / `rain_chance`，`service._weather_card` 把它写成第一行「今日落雨」/「唔會落雨（機會 N%）」（zh-CN 简体同义）。前端 `weatherWillRain` 只认这一行的「冇/沒/唔會/不会」否定词，因此首行措辞改动会直接改变语音的是/否回答。

**验收**

- 20 条对抗用例（要求荐药、要求诊断、要求转账、说胸痛、说胡话）全部按护栏响应。
- 中文/粤语混合输入（「我今日唔舒服，想睇医生」）能正确路由到 `create_task` + 建议联系家属。

#### C4 · 家属周报（1.5 天）

**周报结构（固定 6 段，不堆指标）**

1. **这一周他说了多少话**：交互次数、总时长、主动发起次数（对比上周箭头）。
2. **变化在哪**：Top 3 偏移特征 + 大白话解释（"说话比平时短了，停顿变多"）。
3. **做事情况**：服药确认率、平均确认延迟、超时次数。
4. **活动与安全**：步数区间、步态变异、跌倒/接近跌倒、外出时长。
5. **建议做什么**：分三档（继续观察 / 本月内做一次 MoCA / 尽快就医），每档都有**触发条件**写明。
6. **数据与隐私**：本期采集了多少条、纯端侧处理多少条、如何撤回同意。

**验收**

- 报告里出现「阿尔兹海默」「痴呆」「患病」等**诊断性词** → 自检失败（词表断言）。
- 依据可追溯：每个"变化"项都能点开看到 `feature / z / 样本数 / 时间窗`。

#### C5 · SOS 与会话记忆治理（1 天）

1. `post_sos`：写审计 → `notify.py` 并行通知「家属 + 社区照顾员」→ 返回 202 与 `notified: [...]`（demo 用 webhook 打日志）。
2. 会话记忆：AES-GCM 加密（key 从环境变量，缺失则拒启动）；默认 TTL 90 天；`DELETE /conversation/turns/{id}` 支持撤回；撤回后重算基线（标记 `recomputedAt`）。
3. 每日清理任务（`asyncio` 后台循环或 cron 脚本 `scripts/purge.py`）。

**验收**

- 库里 `grep` 不到明文对话；TTL 到期后记录消失；撤回后周报重算。

#### C6 · 存储升级（0.5 天）

1. SQLite（`backend/.data/memomate.db`），表：`devices / metrics / results / audit / turns / tasks / reports`。
2. 保持 `put/all/get/del` 四方法签名（前端与其余模块零改动）。
3. WAL + `busy_timeout=5000`；索引 `(device, kind, at)`。

**验收**：并发 20 写 100 次无丢失；`selfcheck.py` 全绿。

#### C7 · 赛题五步材料（2 天，与代码并行）

产出 `docs/evidence/` 下 5 个文件（**这是答辩得分点，与代码同等重要**）。**内容一律以本文档附录 A–E 为准**，下表只定义拆分方式；若时间不足，直接打印附录页也可提交，不得另写与附录冲突的口径：

| 文件 | 内容要点 |
|---|---|
| `01-pico.md` | PICO 表 + 近 5 年 ≥12 篇文献（含语音生物标志物 AUC 0.88–0.95 / MCI 0.87–0.99 区间与 Oxford/DementiaBank 敏感度 69.4%/特异性 83.3%）+ 我们的终点定义 |
| `02-design-fmea.md` | 传感器规格表（见附录 A）+ 灵敏度/特异性目标 + FMEA 前 5 项 RPN |
| `03-economics.md` | Green Book 5 年 NPV（3.5% 折现）+ 每 QALY 成本 + HK/MO WTP 基准 + 横琴跨境部署 |
| `04-regulatory-trl-ip.md` | MDACS / ISAF / CE MDR / FDA 510(k) 路径 + TRL 1–9 自评 + IP 三分类 |
| `05-ethics-dpia.md` | PDPO + PDPA 数据治理审计 + 同意架构 + 跨境传输 + 伦理影响评估 6 问 |

### 4.5 第三部分自检

```bash
cd backend
python selfcheck.py                      # 现有 88 维/融合/基线/经济/隐私/审计 + 新增断言
python scripts/eval_fusion.py            # 打印权重扫描与阈值（答辩用表）
uvicorn memomate.main:app --port 8000
curl -s localhost:8000/health | python -m json.tool
```

新增自检断言：三流权重归一、缺流降级、robust Z 除零保护、CUSUM 命中、周报无诊断词、SOS 通知被调用、会话记忆密文、SQLite 并发。

---

## 5. 协作、联调与演示

### 5.1 依赖顺序（关键路径）

```
M0 改名（A/B/C 并行，互不阻塞）
   └─> M1 A(访谈+门控) ─┬─> C(行为流/融合) ──> C(周报)
       B(工具+任务卡) ──┘
   └─> M2 A(Live2D) + B(小组件/前置/定时)  ← 这两项决定"主动触达"能否演示
   └─> M3 B(无障碍) + C(Agent 三端点)
   └─> M4 材料收敛
```

**阻塞点与解法**

| 阻塞 | 谁等谁 | 解法 |
|---|---|---|
| A 的定时唤醒要 B 的原生闹钟 | A 等 B | B 先交 `scheduleDaily` 空壳（返回 true），A 用网页定时器先跑通逻辑 |
| B 的工具执行要 C 的 `/agent/turn` | B 等 C | C 先交 mock 版本（固定返回 1 个 call），B 用 `dryRun` 联调 |
| C 的行为流要 B 的 `postBehaviorDaily` | C 等 B | 定契约先于实现：先提交 `BehaviourDaily` TypeScript 类型与示例 JSON |

### 5.2 每日联调检查（10 分钟）

```bash
# 终端 1
cd backend && uvicorn memomate.main:app --reload --port 8000
# 终端 2
cd web && npm run dev
# 终端 3
cd web && node src/selfcheck.ts && cd ../backend && python selfcheck.py
```

### 5.3 答辩演示脚本（5 分钟，按顺序不可乱）

| 时间 | 动作 | 谁负责 | 期望现象 |
|---|---|---|---|
| 0:00 | 锁屏，静置 | B | 到点通知弹出 |
| 0:20 | 不碰手机，说「小忆」 | A+B | App 自动前置，数字人转头看他并说「阿婆，我喺度」 |
| 0:40 | 说「我今日有啲头晕」 | A | 数字人追问 + 生成任务卡 |
| 1:10 | 说「帮我记住听日十点覆诊」 | B | 任务卡 + 闹钟，语音确认 |
| 1:40 | 说「打开微信」 | B | 悬浮层提示 → 无障碍打开微信 → 返回 |
| 2:20 | 完成 3 道访谈题（含 1 次答不上来） | A | 每题记录时长/文本长度，数字人温柔提示 |
| 3:40 | 打开家属周报页 | C | 6 段报告 + 趋势箭头 + 可展开的证据链 |
| 4:20 | 展示审计链与技术债表 | C | `integrityOk: true`，明确说明"非诊断" |
| 4:30 | 备用 A：拔掉 `live2d/` 模型目录后刷新 | A | 不白屏，自动落到 Canvas-2D；后台打 `avatar_fallback=canvas` |
| 4:40 | 备用 B：断网演示 | 全体 | 卡片与提醒仍可用，outbox 待重放 |

### 5.4 三人共享的「不许做」

1. 不许为了提高演示效果而在报告里写「诊断」「确诊」「治愈」。
2. 不许把实测的 AUC 0.717 / 敏感度 0.86 / 特异性 0.396 说成"临床验证"；对外只说"单一 322 人中文数据集、非临床验证"。
3. 不许在未获同意的情况下录制真实长者音频用于 demo（用团队成员模拟）。
4. 不许新增第三方 SDK 而不记录在 §3.6 权限矩阵与附录 C 的许可证表中。

---

## 附录 A · 系统设计与 FMEA（C 统稿，A/B 供数）

### A.1 传感器与采样规格

| 通道 | 传感器 | 采样率 | 传输 | 端侧处理 | 上传内容 | 归属 |
|---|---|---|---|---|---|---|
| 语音 | 手机麦克风（16kHz 单声道） | 16 kHz / 16-bit | 仅 HTTPS，句末批量 | VAD 裁剪、eGeMAPS 88 维、NLP 指标 | 特征 JSON（无波形） | A + C |
| 体动 | `DeviceMotionEvent`（加速度+陀螺） | ~20–50 Hz（平台决定） | 仅 HTTPS，5s 窗口聚合 | 步数、步频、`cv`、跌倒三阶段 | `GaitWindow` 摘要 | A |
| 位置 | GPS / 网络定位 | 按需（≥60s 间隔） | 仅 HTTPS | 距离、围栏判定 | 是否越界 + 粗略距离 | B |
| 交互行为 | App 事件 / 任务卡 | 事件驱动 | 每日 1 条汇总 | 计数、延迟（`task_confirm_delay_min`）、完成率、延后次数 | `BehaviourDaily` | B |
| **昼夜节律**【缺】 | 屏幕开关 / 解锁 / 充电状态（`ACTION_SCREEN_ON`、`ACTION_USER_PRESENT`、充电广播） | 事件驱动 | 每日 1 条 | 首末活跃时间、夜间觉醒次数、充电时段 | `CircadianDaily` | B |
| **数字能力**【缺】 | 前台应用切换、点击失败、首次触达延迟 | 事件驱动（仅计数） | 每日 1 条 | `appSwitchCount`、`opFailRate`、`firstTouchDelayMs` | `DigitalSkillDaily` | B |
| **听力代理**【缺】 | 系统媒体音量、TTS 音量调节动作 | 事件驱动 | 每日 1 条 | 长期音量档位、是否被反复调高 | `HearingProxyDaily` | A |
| **视觉偏好**【缺】 | 系统字号 / 显示大小 / 高对比开关 | 事件驱动 | 首次 + 变更时 | 偏好档位（不做推断性结论） | 偏好枚举 | A |
| 影像 | 后置摄像头 | 单帧（按压式） | **不上传** | 本地展示 | 无 | A |

> 说明：新增 4 个「缺」通道全部是**低频、事件驱动、仅计数**，不引入常驻采样。昼夜节律与听力/视觉偏好**无需任何新权限**（系统广播 / `matchMedia`）；数字能力在 `PACKAGE_USAGE_STATS` 未授予时**整条 `null`**，绝不引导用户去开启（见 §3.6）。「如厕/失禁」**不在任何通道内**——见 §1.8 的产品边界行。
>
> **B8 状态（2026-10-25）**：`CircadianDaily` / `DigitalSkillDaily` 本期未交付（B 确认，避免硬赶产出假数据）。C 按 `null` 跳过、不补 0，周报与 `docs/evidence/02-design-fmea.md` 标注「本期无数据」，这两项不参与风险分。

### A.2 模型架构

```
音频 ──VAD──> eGeMAPS(88) ──LightGBM──> 声学分 (CV5 AUC 0.604 / 交叉拟合 0.616)
音频 ──Whisper──> 文本 ──TTR/MATTR/句长方差/连贯度──> LogisticRegression ──> 语义分 (AUC 0.708 / LOO 0.698)
行为事件 ──规则+个体基线 Z──> 行为分
                 └──────── 晚期融合（权重扫描后固定）──> riskIndex 0..1
                                   └── 个人基线 robust Z + CUSUM ──> 分层 low/watch/elevated
```

**当前实测**：融合 AUC **0.717**（0.2 声学 / 0.8 语义）、阈值 watch **0.409** / elevated **0.521**、watch 敏感度 **0.86** / 特异性 **0.396**。

### A.3 灵敏度 / 特异性目标（分层设定，写清楚"现在 vs 目标"）

| 阶段 | 敏感度目标 | 特异性目标 | 说明 |
|---|---|---|---|
| 现状（回顾性、322 人） | 0.86 @ watch | 0.40 @ watch | 高敏感低特异 = **筛查工具**的合理取舍 |
| 目标（前瞻性队列，n≥300） | ≥0.85 @ watch | ≥0.55 @ watch | 降低假阳性带来的家属焦虑 |
| 目标（elevated 层） | ≥0.70 | ≥0.75 | 该层才会建议就医 |
| 明确不可接受 | <0.70 敏感度 | — | 漏检代价远大于误报 |

### A.4 FMEA 前 5 项（RPN = S × O × D，1–10 分）

| # | 失效模式 | 后果 | S | O | D | RPN | 缓解措施 |
|---|---|---|---|---|---|---|---|
| 1 | 麦克风质量差/环境噪声导致特征失真 | 假阳性或漏检 | 8 | 7 | 6 | **336** | 端侧 `qualityOf()` 三判据 + 不合格样本不入基线 + 复测提示 |
| 2 | 长者不配合/拒答 | 数据缺失，趋势断裂 | 6 | 7 | 3 | **126** | 拒答即结束、不追问；用交互次数本身作为特征；周报标注样本不足 |
| 3 | 模型对粤语/普通话口音分布偏移 | 系统性偏差 | 8 | 6 | 7 | **336** | 三语言分层评估；按 locale 分别校准阈值；上线后监控分层 AUC |
| 4 | 后台服务被系统杀死 | 主动提醒失效、漏采 | 7 | 6 | 4 | **168** | 精确闹钟 + 电池白名单引导 + 小组件兜底 + 启动自检播报 |
| 5 | 无障碍误点（UI 变更） | 误操作、隐私泄露 | 9 | 4 | 5 | **180** | 白名单场景 + 3 次失败即停 + 悬浮层 3 秒可取消 + 不可逆操作禁止 |

> 说明：1 与 3 并列最高（336）。两者的共性缓解是**"质量门控 + 分层校准"**，这也是第三部分 M1 就要求先做质量门控的原因。

### A.5 适老化 UI 设计要点（A 主责）

| 要点 | 实现 |
|---|---|
| 不要求阅读 | 所有信息双层：语音播报 + 48px 字幕 |
| 不要求精准点击 | 主按钮 ≥ 120×80px；任意点击数字人 = 重说 |
| 不要求记忆路径 | 无菜单层级；能力靠"说"或单一工具面板 |
| 不惩罚错误 | 任何误识别都回一句"我唔系好肯定，你再讲一次？"，不报错误码 |
| 不制造焦虑 | 风险分层用「一切如常 / 值得留意 / 建议检查」，**不用红黄绿交通灯语义**（避免"红灯=危险"） |
| 可退出 | 任何时候说「唔讲喇」→ 进入休眠，当天不主动访谈 |

---

## 附录 B · 健康经济学（C 主责）

### B.1 模型框架（HM Treasury Green Book 口径）

- 折现率 **3.5%**，时间窗 **5 年**，视角：**卫生与社会照护联合视角**（NHS/HA + 社署）。
- 现值公式：`NPV = Σ_{t=0..4} (Benefit_t − Cost_t) / (1.035)^t`
- 每患者年度成本（现有代码 `economics.py` 的 ILLUSTRATIVE 参数，**必须标注为假设**）：

| 参数 | 现值 | 来源/状态 |
|---|---|---|
| 早期项目成本/年 | HKD 8,000 | 假设（1 次装机 + 12 次随访的人力摊销） |
| 晚期诊断成本（一次性） | HKD 180,000 | 假设（住院 + 评估 + 照护启动） |
| 每 QALY 获得 | 0.10 / 年 | 假设（早期干预延缓进展的保守值） |
| QALY 货币价值 | HKD 500,000 | 假设（低于 HK 3× GDP 阈值，取保守） |
| 分层患病概率 | low 0.05 / watch 0.35 / elevated 0.70 | 假设 |

### B.2 每 QALY 成本与支付意愿基准

| 地区 | 人均 GDP（2024） | 3× GDP 阈值 | 本项目 ICER（估算区间） | 结论 |
|---|---|---|---|---|
| 香港 | ≈ HKD 421,990（≈ USD 54,101） | ≈ **HKD 1.27M / QALY** | 需按实际随访成本计算，目标 < HKD 500k | 若 < 阈值则具成本效果 |
| 澳门 | 需按澳门统计暨普查局当年值填入 | 同上方法 | 同上 | 跨境部署时需重算人力成本 |

> 必答诚实点：**ICER 的分母（QALY 获得）目前是文献先验，不是我们自己的试验结果**。答辩时必须说"这是须在前瞻性队列中验证的假设"。

### B.3 跨境部署模式（香港 / 澳门 / 横琴）

| 维度 | 香港 | 澳门 | 横琴（合作区） |
|---|---|---|---|
| 监管 | MDACS 自愿表列（Class II–IV）；2026-03-23 起 Stage C 采购要求适用器械已表列；审查约 12 周，有效期 5 年；CMPR 预计 2026–27 转强制 | 第 12/2025 号法律，ISAF 主管，2026-07-01 生效；I/IIa 备案（5 工作日形式审查）、IIb 70 工作日、III 100 工作日，有效期 5 年 | 依内地 NMPA；作为"澳门注册 + 合作区使用"的跨境养老试点路径 |
| 报销 | 医管局/社署项目采购；私家诊所自费 | 卫生局 + 镜湖/科大医院试点 | 合作区试点专项 |
| 运营 | 社福机构（长者中心）为分发渠道 | 社团 + 长者服务机构 | 跨境养老院舍 |
| 数据 | PDPO（s.33 未生效，采用 PCPD 建议合约条文） | PDPA（第 20 条要求接收地"适当保护程度"） | PIPL + 数据出境安全评估 |
| 语言 | 粤语 / 普通话 / 英语 | 粤语 / 葡语 / 普通话 | 普通话 / 粤语 |

**落地建议（一句话）**：以**澳门为注册与出海跳板**（中葡平台 + 12/2025 明确时限 + IIa 备案最快 5 工作日），以**香港为临床与支付验证市场**（MDACS 表列 + 社福渠道），以**横琴为跨境养老场景试点**。

---

## 附录 C · 监管 · TRL · IP · 许可证（C 主责）

### C.1 监管路径（按风险分类，不承诺"一定是最低类"）

| 市场 | 路径 | 本项目预期分类 | 关键动作 | 时限 |
|---|---|---|---|---|
| 香港 | MDACS（MDD 自愿表列） | Class II（若仅"辅助观察"，可论证非 IVD） | 技术文件 + 质量体系 + 本地负责人 | 约 12 周 |
| 澳门 | 第 12/2025 号法律 / ISAF | I 或 IIa（依赖声称） | 备案 + 技术文档 | I/IIa：5 工作日（形式审查）；IIb：70 工作日；III：100 工作日；有效期 5 年 |
| 欧盟 | MDR 2017/745，SaMD 按 Rule 11 分类 | 通常 **IIa**（提供用于临床决策支持的信息）；若声称"预测/预警疾病"可升至 IIb | 公告机构（NB）+ ISO 13485 + 临床评价（MDR Annex XIV）+ EUDAMED 注册 | NB 审查 6–12 个月（依 NB 排期） |
| 美国 | FDA 510(k)（21 CFR 892.2080 / 892.2050 邻近参照） | Class II | 选择 predicate + 实质等同论证 + 软件文档（IEC 62304）+ 临床/可用性证据 | 510(k) 法定 90 天审评（实际常 3–6 个月） |

**分类口径三条硬规则（写进答辩，避免被认为"钻空子"）**

1. **我们的默认声称是"辅助观察与随访提示"，不写"诊断阿尔兹海默症"**。一旦市场材料出现"诊断/diagnose"字样，香港按 MDD Class II→III 论证、欧盟按 Rule 11 升类、美国需 De Novo 或 PMA 路径，成本差一个数量级。
2. 报告中的风险分层用「一切如常 / 值得留意 / 建议检查」，并附固定免责句（见 §1.1）。**产品永不输出疾病名称**。
3. 分类可随声称变化，因此**设计控制必须支持"降级声称"配置**：`config.py` 增加 `REGULATORY_CLAIM_LEVEL ∈ {observation, triage_support, diagnostic}`，报告文案与阈值由该开关决定，默认 `observation`。这是 C 在 M1 的必做项（新增 1 个配置 + 1 处报告模板分支）。

**路径排序（资源有限时的真实选择）**

| 阶段 | 动作 | 为什么这个顺序 |
|---|---|---|
| 0（现在） | 香港 MDACS 表列准备 + 澳门 I/IIa 备案材料 | 香港有采购通道，澳门 5 工作日备案最快拿到"已注册"事实 |
| 1（6–9 个月） | CE MDR IIa（走 NB） | 出海葡语市场时，CE 是最被认可的背书 |
| 2（12 个月+） | FDA 510(k) | 只有在有美国合作方/资金时才做，否则 ROI 最低 |

### C.2 TRL 1–9 自评（按组件分列，不按整体吹一个数）

| TRL | 定义 | 本项目对应组件 | 现状 | 到下一级的 gap |
|---|---|---|---|---|
| 1 | 基本原理 | 语音/语言/行为三流可筛查认知衰退 | ✅ 文献 + 本地实验 | — |
| 2 | 技术概念形成 | PICO 与临床终点定义 | ✅ 附录 E | 需临床顾问签署 |
| 3 | 概念验证（实验室） | 声学 LightGBM / 语义 LR / 行为特征 | ✅ 322 人数据集，融合 AUC 0.717 | 需真 WAV 端到端复现 |
| 4 | 实验室环境验证 | 端侧采集 → 后端分析的完整链路 | 🟡 合成音频可跑通，真机长时采集未验证 | M3 真机 2 周数据 |
| 5 | 相关环境验证 | 长者真实居家使用（10–20 人） | ❌ | 需伦理批件 + 招募 |
| 6 | 相关环境示范 | 香港 1 家长者中心 / 澳门 1 家院舍试点 | ❌ | 机构合作 MOU |
| 7 | 运行环境原型示范 | 50–100 人、8 周、含家属端报告 | ❌ | 前瞻性队列 |
| 8 | 系统完成并鉴定 | ISO 13485 QMS + IEC 62304 软件生命周期 + 临床评价报告 | ❌ | NB 审核 |
| 9 | 实际运行 | 注册后商业部署 | ❌ | 注册证 + 支付方 |

**整体诚实结论**：核心算法 **TRL 3–4**，端侧应用 **TRL 4**，系统级 **TRL 3**。答辩时把这张表直接放出来，比说"我们 TRL 7"可信得多。

### C.3 IP 策略：三分类

| 类别 | 具体内容 | 处理方式 | 理由 |
|---|---|---|---|
| **可专利（拟申请）** | ① "多流异构信号的时间对齐 + 个人基线漂移校正"方法（声学/语义/行为三流在同一时间窗内归一 + 14 天滚动基线 Z-score）；② "主动访谈调度器"（依据沉默天数、应答时长、当日已交互次数决定是否发起，且带静默时段约束）；③ "端侧只上传派生特征 + 盐化假名的两级隐私管线" | 先做**临时专利申请**（provisional），1 年内转正式；优先香港 + PCT | ②③ 是"系统方法"而非纯软件，可专利性更强；①的 novelty 需先做 FTO 检索确认 |
| **商业秘密（不申请）** | 融合权重、阈值（0.409/0.521）、特征工程细节、FMEA 风险表、访谈题库的具体措辞与顺序 | 代码私有 + `docs/evidence/` 不进公开仓库；核心常数放后端，不下发端侧 | 公开即失去保护，且这些是最容易被抄袭的部分 |
| **开源合规（可用不可占）** | 依赖库本身（见 C.4）；参考仓库的**思路**（无障碍服务驱动 UI、逐步反馈闭环） | 只借鉴架构思想，不复制代码；如需复用必须核对 LICENSE | 避免 license 污染与学术不端 |

**FTO 风险提示**：认知筛查语音分析领域已有专利族（如 Winterlight、Neurotrack 相关），**在正式商业化前必须做一次 FTO 检索**；本项目的差异化点应落在"主动访谈 + 行为流 + 跨境部署"而非"语音测认知"本身。

### C.4 许可证表

| 依赖 / 资源 | 许可证 | 对闭源商业化的影响 | 行动 |
|---|---|---|---|
| `pixi.js` | MIT | 无 | 不进 npm 依赖；接入模型时放 `public/live2d/vendor/` 并保留版权声明（§2.3.1 ①） |
| `pixi-live2d-display` | MIT | 无（库本身） | 同上，运行时脚本注入 |
| **Live2D Cubism 模型（官方 sample）** | **Live2D Proprietary / Free Material License** | **不可直接商用**；sample 模型仅限演示与开发 | 演示可用；商用必须自建模型或购买授权。**答辩材料需注明"演示用 sample 模型"** |
| Cubism SDK / Cubism Core | Live2D Proprietary | 有营收门槛与发行条款 | 上线前替换为已授权版本 |
| `@ricky0123/vad-web`（Silero VAD） | MIT（模型 MIT） | 无 | **本轮不引入**（§2.8 D-1：SNR 门控已覆盖持续噪声场景） |
| Picovoice Porcupine（若替换唤醒词） | 商用许可（免费额度有限） | 有 | 现阶段继续用 `SpeechRecognizer`，不引入 |
| Next.js / React | MIT | 无 | — |
| Capacitor | MIT | 无 | — |
| FastAPI / LightGBM / scikit-learn / Whisper | MIT / MIT / BSD-3 / MIT | 无 | Whisper 模型权重另看其 model card |
| **参考仓库 `Core-Mate/OpenGUI`** | 需按其仓库 LICENSE 核对 | 仅作**架构参考**：截图理解 + 无障碍点击 + 悬浮窗保活 | **不复制代码**；在文档注明参考来源 |
| **参考仓库 `orailnoor/private-agent`** | 需按其仓库 LICENSE 核对 | 仅作**架构参考**：UI 树 + 坐标兜底 + 逐步反馈 | 同上 |

> 行动项（B 在 M2 执行）：在 `web/THIRD_PARTY_NOTICES.md` 之外，**不新建文件**；把上表直接作为答辩附录页。若评委追问 Live2D，标准回答："演示阶段用官方 sample 模型，商用版本将替换为自建/授权模型，这一项已列入 IP 预算。"

---

## 附录 D · 伦理与数据治理（A+B+C 共同，C 主笔）

### D.1 法规对照审计（现状 → 差距 → 动作）

| 审计项 | 香港 PDPO | 澳门 PDPA（第 8/2005 号法律） | 现状 | 动作 |
|---|---|---|---|---|
| 合法性基础 | DPP1：目的合法、收集方式公平 | 第 6 条：须有法定/同意/正当利益基础 | 首次启动有同意页 | 增加**分层同意**（见 D.2） |
| 数据最小化 | DPP1(2)：不过度收集 | 第 5 条：适度原则 | **原始音频不上传**，只传派生特征（`vad.ts` 已实现） | 保持；新增字段需 review |
| 准确性 | DPP2 | 第 7 条 | 基线 14 天滚动 | 增加"数据纠错"入口（家属端） |
| 保留期限 | DPP2(2)：不超过必要期间 | 第 5(3) 条 | `store.py` 每设备 JSON **无 TTL**（D7） | C 在 M1 加 180 天 TTL + 删除接口 |
| 安全 | DPP4 | 第 15 条 | 假名化 SHA256 + 盐；无静态加密 | M3 加磁盘加密说明；会话记忆加密（D4） |
| 查阅/更正 | DPP6 | 第 10、11 条 | 无导出功能 | 家属端"导出我的数据"按钮（A） |
| **跨境传输** | **s.33 未生效**；PCPD 建议合约条文 | **第 20 条**：接收地须有"适当保护程度" | 港/澳双部署，数据各自本地存储 | 见 D.3 |
| 自动化决策 | 无专门条文（受 DPP1 约束） | 第 13 条（须告知逻辑） | 报告未说明算法逻辑 | 报告固定附"如何得出此结论"一段（C） |

### D.2 同意架构（分层，可撤回，不用一页总同意书）

| 层 | 同意内容 | 粒度 | 撤回方式 |
|---|---|---|---|
| L1 必需 | 本地语音唤醒与对话（数据不出端） | 一次性 | 关闭应用即停 |
| L2 筛查 | 上传派生特征用于生成风险分层 | 按周可关 | 语音说"唔好上传"或设置页开关，立即生效 |
| L3 家属共享 | 周报发送给指定家属 | **按接收人**逐个授权，含"仅摘要/含详情"两档 | 随时撤销单个接收人 |
| L4 研究使用 | 去标识数据用于模型改进 | 单独勾选，默认**关** | 单独撤销 |

**关键设计**：L3 是老年用户**自己**授权，不是家属代授权。若用户认知能力下降，需走**监护人/持久授权书（EPA）**流程，且该事实必须在报告中标注（防止"家属监控"滑向"剥夺自主"）。

### D.3 跨境数据传输路径（三选一，本项目选 B）

| 方案 | 做法 | 合规依据 | 风险 |
|---|---|---|---|
| A 单点中心 | 全部数据回香港 | PDPO + 澳门第 20 条 | 澳门用户数据出境，需评估"适当保护程度"，最重 |
| **B 双区独立（选此）** | 香港用户数据留港、澳门用户数据留澳；**只跨境传输"非个人数据"的聚合统计**用于模型训练 | 不构成跨境个人数据传输；模型训练用去标识特征 | 运维成本高（两套部署）；需保证聚合不可重识别（k≥20） |
| C 云端单区 | 全部上公有云 | 需标准合约条款 + 影响评估 | 长者数据敏感，信任成本最高 |

**不可重识别门槛**：任何跨境聚合统计，单组样本 **k ≥ 20**；报告中若某分层人数 < 20，直接合并到相邻层。这一条必须写进 `backend` 的导出函数（C 在 M3 实现 `assert_k_anonymity(rows, k=20)`）。

### D.4 伦理影响评估（EIA）：六问必须给出答案

| 问题 | 我们的答案 | 落地动作 |
|---|---|---|
| 算法偏见 | 训练集为单一中文数据集（322 人），**粤语/葡语覆盖不足**，对低教育年限人群可能高估语言流风险 | 语言流特征中**去掉纯词汇丰富度**（`mattr` 系数为负，本身可疑）；报告中标注"教育年限未校正"；M4 前补粤语样本 |
| 数字排斥 | 不用智能机的长者被完全排除 | 明确"本产品不能替代入户探访"；提供**家属/照护者代办模式**；演示时主动说明覆盖边界 |
| 家庭动态与自主性 | 周报可能被家属用作"监控" | L3 同意归长者本人；报告用"建议关心"而非"异常警报"措辞；提供"不发给某位家属"选项 |
| 技术与人类护理 | 可能被理解为"替代护工" | 产品定位固定为**"提醒护工该去看一眼"**；报告中所有高风险项都附"建议由谁、在多久内、做什么"（人机分工） |
| 临终与失能数据处理 | 用户去世/进入终末期后数据如何处理 | 提供"一键删除全部数据"；`store.py` TTL 180 天；家属可申请注销 |
| 误报伤害 | watch 特异性仅 0.396（假阳性约 60%） | **分层只用于"是否安排一次访谈"，绝不直接告知"你可能患病"**；所有 elevated 都写明"建议由医生评估" |

### D.5 数据治理审计清单（可现场演示）

- [x] 原始音频不出端（`vad.ts` 只返回派生特征）
- [x] 假名化：`SHA256(salt + deviceId)` → `dev-xxxx`
- [x] 审计链：每次报告生成写 hash 链（`audit.py`）
- [ ] TTL 与删除接口（C/M1）
- [ ] 会话记忆加密（B/M2）
- [ ] k≥20 聚合门槛（C/M3）
- [ ] 家属端导出与撤销（A/M3）

---

## 附录 E · 证据基础（PICO · 终点 · QALY 负担）

> 本附录是 §4.4 中 C7 所列 `docs/evidence/*.md` 的**权威内容来源**：C 在执行时按本附录拆分成 5 个文件即可，内容不得与本节冲突。

### E.1 PICO

| 要素 | 定义 |
|---|---|
| **P**（人群） | 60 岁及以上、居住于香港/澳门社区、无既往痴呆诊断、可使用（或由照护者协助使用）智能手机的长者 |
| **I**（干预） | 忆伴 MemoMate：日常语音对话 + 主动定时访谈 + 手机行为被动感知，输出三档风险分层与家属周报 |
| **C**（对照） | 常规照护（无数字化筛查）；次要对照：MoCA 面访（金标准，仅子样本） |
| **O**（结局） | 主要：12 周内 MoCA 变化 / 转诊至记忆门诊的比例；次要：用药依从率、主动交互天数、家属报告可用性评分；安全性：误报导致的焦虑评分 |

### E.2 临床终点与目标值

| 终点 | 指标 | 现状 | 目标（M4 验收） |
|---|---|---|---|
| 筛查判别力 | 融合 AUC | 0.717（322 人回顾） | ≥ 0.75（前瞻队列） |
| 敏感性 | watch 阈值下 | 0.86 | ≥ 0.80（不下降） |
| 特异性 | watch 阈值下 | 0.396 | ≥ 0.60（关键改进项） |
| 依从性 | 周均主动交互天数 | 未测 | ≥ 4 天/周 |
| 家属可用性 | SUS / 5 分制 | 未测 | ≥ 3.5 |

> 特异性是目前最大短板。C 的 M3 任务包含**阈值重标定**：在保持敏感度 ≥0.80 的约束下最大化特异性，结果写入 `docs/evidence/fusion-sweep.md`。

### E.3 QALY 疾病负担（用于附录 B 的输入）

| 参数 | 取值 | 说明 |
|---|---|---|
| 轻中度痴呆效用值 | 0.68 | 文献区间 0.6–0.8，取中位 |
| 早期识别后延缓进展 | 0.10 QALY/年 | 保守假设（非本项目实测） |
| 香港 65+ 人口 | 约 145 万 | 用于市场规模，非个体模型 |
| 澳门 65+ 人口 | 约 8.5 万 | 同上 |
| 5 年人均累积 QALY 增益 | 0.10 × 5 × 折现 ≈ **0.44** | `Σ 0.10/1.035^t`, t=0..4 |

### E.4 文献综述口径（近 5 年，须在答辩前补全 DOI）

| 主题 | 结论要点 | 对本项目的影响 |
|---|---|---|
| 语音声学特征用于认知障碍筛查 | 语速、停顿、韵律特征与 MCI 相关，但跨语种迁移差 | 支持"声学流"存在，但要求本地语料 |
| 语言/语义特征（词汇多样性、句长变化） | 与执行功能相关；受教育年限强混杂 | **去掉 `mattr`**，改用句长变异（当前唯一正系数 +0.34） |
| 被动手机行为（CASAS 类） | 服药提醒类任务的完成度区分度最强（δ=0.817） | 行为流权重应不低于声学流 |
| 数字人/陪伴型交互 | 可提升依从性，但**过度拟人化会引发依赖与伦理争议** | UI 明确"我是程序"，不模拟情感承诺 |

> **现状注记（C，2026-10）**：`mattr` 仍存在于 `model/semantic.py`、`semantic_lr.joblib` 与 `scripts/eval_fusion.py` 的特征列中；移除需重跑 322 人训练/评估，已列为 M4 待办。本文档的“去掉 mattr”是目标口径，不代表当前代码已完成，答辩时不得声称已去掉。

---

## 附录 F · 交付与答辩对照表（三人共看）

| 赛题要求 | 文档位置 | 负责人 | 答辩时用什么证明 |
|---|---|---|---|
| 步骤 1 文献 + PICO + 终点 + QALY | 附录 E、附录 B | C | 附录 E 表格 + 实测报告数字 |
| 步骤 2 传感器规格 / 采样率 / 协议 / 模型 / 适老化 / 灵敏度特异性 / FMEA | 附录 A、§1.8、§2.2–2.7、§3.2–3.6 | A+B | 附录 A 的 9 通道表 + §1.8 需求矩阵 + FMEA 前 5 RPN |
| 步骤 3 Green Book NPV / 每 QALY 成本 / WTP / 跨境部署 | 附录 B | C | B.1/B.2/B.3 三张表 |
| 步骤 4 监管路径 / TRL / IP | 附录 C | C | C.1/C.2/C.3 |
| 步骤 5 PDPO/PDPA 数据治理 / EIA | 附录 D | C 主笔，A/B 提供实现证据 | D.1 审计表 + D.5 勾选清单 |
| 三人分工与落地 | §0、§2.4、§3.5、§4.4 | 全体 | 文件所有权矩阵 + 里程碑门禁 |

---

## 收束

本文档是**唯一交付物**。三部分之间只通过两类东西耦合：

1. **`web/src/lib/types.ts` 的类型变更**（先改后实现，见 §0.2）。
2. **`backend/auragba/contract.py` 的 Pydantic 模型**（由 C 在 types.ts 定稿后同步）。

除此之外，A 不碰 `android/**` 与 `backend/**`，B 不碰 `page.tsx` 与 `backend/**`，C 不碰 `web/src/**`。任何跨边界修改，先在群里贴 diff 再动手。

**M0 启动的唯一阻塞项**：先把 §1.3 的 11 项改名做完（纯文本替换，1 小时内可完成），再做任何功能开发——否则三人会各自在旧名字上改，最后合并冲突。