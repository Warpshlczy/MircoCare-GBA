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
| `web/src/components/Avatar.tsx`、`lib/viseme.ts`、`lib/proactive.ts`、`lib/interview.ts`、`lib/audio.ts`、`lib/i18n.ts` | A | B/C 只读 |
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
| 语音 TTS/STT/振幅表 | [audio.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/audio.ts) | `rate 0.85`；`zh-CN` 用普通话，其余 `zh-HK` |
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
| **M2** | 拟真与主动触达 | Live2D 挂载层 + viseme、主动调度器、唤起与无障碍 | 小组件 + 前置 + 定时唤醒、权限矩阵 | 行为流接入（服药/任务/步态） | 装机 demo：锁屏被唤醒 → 数字人主动说话 → 生成卡片；§2.3.1 ⑤ 四条断言全过（默认 `model: null` 走 Canvas-2D） |
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
| **生活** | 忘了带伞 / 出门 | 天气卡 + 出行提醒 | 位置 + 天气 API | B | 说「听日天气」→ 卡片含温度/降雨；断网回退本地文案 |
| 生活 | 要覆诊但不会挂号 | 提醒 + 路线卡（**不代付、不代挂号**） | 任务 + 位置 | B | 涉及支付/预约 → 明确拒绝并播报替代建议 |
| 生活 | 不会操作手机 | 无障碍 Agent 白名单代操作 | 节点点击审计 | B | 仅 3 类白名单场景；失败 3 次即停 |
| **数字能力** | 越用越不会用（认知下降早期信号） | 不额外打扰，静默记录 | App 切换频次、操作失败率、首触延迟 | B【缺】 | 每日 1 条 `DigitalSkillDaily`，字段含 `appSwitchCount` / `opFailRate`；权限关闭时为 `null` |
| 数字能力 | 听不清 / 看不见 | 音量感知自适应 + 字号/对比度模式 | 系统音量、字号偏好 | A【缺】 | 音量长期 ≤30% → 自动提高 TTS 音量一级并提示家属 |
| **尊严/边界** | 不想被机器监视 | 分层同意 L1–L4、随时关闭、镜头指示 | 同意状态 | A + C | 关闭麦克风后**所有**语音能力停用且 UI 明确显示；镜头开启时有可见指示 |

---

## 2. 第一部分 · 端侧数字人与主动关怀（开发者 A）

### 2.1 目标与非目标

**目标**

1. 让数字人从「会张嘴的画」变成**有口型、有视线、有打断**的对话主体。
2. 让数字人**自己找长者说话**：定时、按事件、按沉默时长，且频率可控不烦人。
3. 把每次主动/被动交互变成**结构化访谈样本**（问了什么、答了多久、答了几句、是否答非所问）。
4. 在低数字读写能力前提下做到「不看屏幕也能用」。

**非目标**（明确不做，避免范围膨胀）

- 不做 3D / 不接云渲染；不做多角色。
- 不做通用闲聊大模型（闲聊由 C 的 `/agent/turn` 提供文本，A 只负责说与听）。
- 不做情感识别（不宣称能识别「难过/生气」；只记录可验证的声学与语言量）。

### 2.2 交付物清单

| # | 交付物 | 形态 |
|---|---|---|
| A-1 | Live2D 数字人组件（**按清单挂载模型**，无模型时用 Canvas-2D 默认替代；保留 `state`/`level` 契约） | `web/src/components/Avatar.tsx` + `lib/viseme.ts` + `web/public/live2d/**` |
| A-2 | 口型驱动：TTS 音频分析 + 文本拼音兜底 | `lib/viseme.ts`、`lib/audio.ts` |
| A-3 | 主动调度器（定时 / 静默 / 事件三源，含打扰预算） | `lib/proactive.ts` + `lib/db.ts` 新 store |
| A-4 | 每日认知访谈脚本（3 分钟，5 类题，可跳过） | `lib/interview.ts` + `i18n.ts` |
| A-5 | 对话状态机（聆听 / 说话 / 打断 / 重问 / 超时） | `page.tsx` 内 `converse` 升级 |
| A-6 | 适老化与无障碍增强（镜头指示、字幕、失败开放、纯按钮通路） | `components/*`、`globals.css` |
| A-7 | 端侧质量门控（VAD 升级 + 信噪比判定 + 丢弃标记） | `lib/vad.ts`、`lib/signal.ts` |
| A-8 | **模型挂载层**：清单读取 → 加载 → 三级降级（详见 §2.3.1） | `components/avatar/MountLive2D.ts`、`public/live2d/model.manifest.json` |
| A-9 | 日常唤起全通路（前台唤醒词、长按数字人、纯按钮兜底） | `hooks/useWakeWord.ts`、`page.tsx`、`globals.css` |

### 2.3 文件级改动点

| 文件 | 操作 | 说明 |
|---|---|---|
| [Avatar.tsx](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/components/Avatar.tsx) | 重写内部 `draw()` | 对外只保留 `{ state, level, size, onTap? }`；Live2D 加载失败自动回退现 Canvas-2D（**必须有回退**，答辩现场不能白屏） |
| `web/src/lib/viseme.ts` | 新增 | 纯函数：`visemeFromText(text): number[]`（拼音韵母 → 开口度序列）+ `visemeFromAnalyser(analyser): number` |
| [audio.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/audio.ts) | 增强 | `speak()` 增加 `onViseme` 回调：优先接 `AnalyserNode`，取不到则用文本序列按字数定时推进 |
| `web/src/lib/proactive.ts` | 新增 | 纯函数 `planProactive(ctx): ProactiveAction \| null`，输入：上次开口时间、今日已开口次数、连续沉默天数、是否有未确认提醒、时段 |
| `web/src/lib/interview.ts` | 新增 | 纯函数：题库 + 选题策略 + 结束判定（详见 §2.5） |
| [page.tsx](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/app/page.tsx) | 改造 | 把「四条主动开口」收敛为调用 `planProactive()`；新增 `state = "listening" \| "thinking"` 的中间态与打断处理 |
| [i18n.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/i18n.ts) | 扩充 | 新增 ≥30 条：访谈题、追问、鼓励、拒答接受、镜头说明、时间提示 |
| [vad.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/vad.ts) | 替换实现 | 保留 `{ isSpeech, ratio, stop }` 契约，内部换 Silero（`@ricky0123/vad-web`）；加载失败回退能量 VAD |
| [signal.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/signal.ts) | 增函数 | `snrDb(frames)`、`qualityOf(session)` → `good \| fair \| reject` |
| [globals.css](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/app/globals.css) | 增样式 | 字幕条（底部 2 行、48px、高对比）、录音指示环 |
| `web/public/live2d/model.manifest.json` | 新增（**留空占位**） | 模型清单：`modelPath` / `cubismVersion` / 必需参数名 / 动作分组 / `scale` / `anchor`；字段见 §2.3.1。**本轮不放任何模型二进制** |
| `web/public/live2d/README.md` | 新增 | 一页纸说明：放什么文件、什么格式、放哪里、如何自检 |
| `web/src/components/avatar/MountLive2D.ts` | 新增 | 动态 import PIXI + `pixi-live2d-display`，读清单 → 加载 → 失败/超时 3s 回退；唯一与库耦合的文件 |
| `web/src/components/avatar/StaticPortrait.tsx` | 新增 | 第三级兜底：静态头像 + 状态文字（模型与 Canvas 都不可用时） |

### 2.3.1 数字人模型挂载契约（**先留空 · 默认替代**）

> 本节是 A-8 的唯一规格。目标：**仓库里今天不带任何模型二进制**，代码仍能跑、答辩仍不白屏；后续把模型文件按下面格式丢进目录即自动生效，**不需要改一行代码**。

**① 目录契约**

```
web/public/live2d/
├── README.md                      # 说明（提交）
├── model.manifest.json            # 清单（提交，默认 {"model": null}）
└── <模型目录>/                    # 默认不存在；接入模型时创建
    ├── <name>.model3.json         # 必需
    ├── <name>.moc3                # 必需
    ├── textures/*.png             # 必需（2048×2048 或 1024×1024）
    ├── motions/*.motion3.json     # 必需（至少 Idle + TapBody 两组）
    ├── expressions/*.exp3.json    # 可选
    └── physics3.json              # 可选（呼吸/摆动）
```

**② 清单字段（`model.manifest.json`，本轮默认值即"留空"）**

```json
{
  "model": null,
  "modelPath": "",
  "cubismVersion": "",
  "scale": 1.0,
  "anchor": [0.5, 0.5],
  "params": {
    "mouthOpen": "ParamMouthOpenY",
    "eyeLeft": "ParamEyeLOpen",
    "eyeRight": "ParamEyeROpen",
    "angleX": "ParamAngleX",
    "angleY": "ParamAngleY",
    "angleZ": "ParamAngleZ",
    "bodyAngleZ": "ParamBodyAngleZ"
  },
  "motionGroups": { "idle": "Idle", "tap": "TapBody" },
  "stateMotion": { "idle": "Idle", "listening": "Idle", "thinking": "Idle", "speaking": "Idle", "confirming": "TapBody" }
}
```

`model: null` 时 **A-8 直接走默认替代**，连网络请求都不发；接入时把 `model` 改成 `"<模型目录>"`、`modelPath` 改成 `"/live2d/<模型目录>/<name>.model3.json"`、`cubismVersion` 填 `"3" | "4" | "5"`，其余字段通常不用动。

**③ 必需模型格式**

| 项 | 要求 |
|---|---|
| 版本 | Live2D Cubism **3 / 4 / 5**（`.moc3` 内核）；Cubism 2（`.moc`）**不支持** |
| 入口 | `.model3.json`（相对路径引用 `moc3` / 纹理 / 动作 / 物理） |
| 纹理 | PNG，单边 ≤ 2048px，**单人模型**（不做多角色切换） |
| 动作 | 至少 `Idle`（循环）与 `TapBody`（点击触发）两组 `.motion3.json` |
| 参数 | `ParamMouthOpenY`、`ParamEyeLOpen`、`ParamEyeROpen`、`ParamAngleX/Y/Z`、`ParamBodyAngleZ`；缺失的参数**不报错**，只是少了对应动效 |
| 体积 | 整目录 ≤ 8 MB（首屏不加载，动态 import + 点击/监听时预取） |
| 许可 | **官方 sample 模型（Hiyori/Haru 等）仅限非商用**，见附录 C.4；商用必须换成自有或已授权模型，并在 `README.md` 写明来源与许可 |

**④ 三级降级顺序（必须实现，答辩前逐级演练）**

| 级 | 触发条件 | 表现 | 记录 |
|---|---|---|---|
| L1 模型 | `model.manifest.json` 的 `model` 非空 **且** 加载成功（≤3s） | Live2D 渲染；`state` → 动作组；`level` → `ParamMouthOpenY` | — |
| L2 Canvas-2D（**默认**） | `model` 为空 / 加载失败 / 超时 3s / WebGL 不可用 | 现 `Avatar.tsx` 的眨眼、呼吸、嘴高 = `level` | `track("avatar_fallback", "canvas")` |
| L3 静态头像 | Canvas `getContext("2d")` 也失败 | 品牌头像 PNG + `aria-live` 状态文字，主按钮与 SOS 照常可用 | `track("avatar_fallback", "static")` |

**⑤ 自检断言（进 M2 门禁）**

```bash
# 1) 默认仓库无模型二进制（"先留空"的硬约束）
test -z "$(find web/public/live2d -name '*.moc3' -o -name '*.model3.json' 2>/dev/null)" && echo "PASS: 模型留空"
# 2) 清单可解析且 model 为 null
node -e 'const m=require("./web/public/live2d/model.manifest.json");if(m.model!==null)throw 1;console.log("PASS: manifest 占位")'
# 3) 拔掉清单文件仍能构建与渲染（走 L2）
mv web/public/live2d/model.manifest.json /tmp/ && (cd web && npm run build) && mv /tmp/model.manifest.json web/public/live2d/
# 4) 静态断言：Avatar 内不得出现顶层 import 'pixi.js'（必须动态 import，避免进首屏包）
! grep -q "^import .*pixi" web/src/components/Avatar.tsx
```

### 2.4 任务分解（可直接认领的步骤）

#### A0 · 基线确认与改名落地（0.5 天）

1. 跑 `cd web && npm run typecheck && npm run selfcheck`，记录基线全绿。
2. 按 §1.3 第 1–3 项改 `i18n.ts` / `Avatar.tsx` / `useWakeWord.ts`。
3. 在 `web/src/selfcheck.ts` 增加断言：`t("zh-HK","greeting")` 含「憶伴」且**不含**「靈犀」；`WAKE_NAMES` 不含旧词。
4. 验收：`node src/selfcheck.ts` → `selfcheck: OK`；页面语言切换后无「灵犀」残留（`grep -r "灵犀\|靈犀" web/src` 为空）。

#### A1 · 访谈脚本与对话状态机（1 天）

**步骤**

1. 定义 `InterviewItem`（见 §2.5 契约），先落 5 类题各 3 条（共 15 条），全部**可跳过**。
2. 实现 `nextQuestion(state)`：按「上次答不上来的题降级、最近 7 天没问的优先」选题，**同一天不重复**。
3. 实现会话结束条件：答满 4 题 / 累计 180 秒 / 长者连续 2 次说「唔想讲」「不想说」/ 检测到情绪词「攰」「累」→ 温柔收尾。
4. 在 `page.tsx` 用 `converse()` 串起来：**一次只问一句**，每句问完必等回答或 8 秒超时；超时则复述一次，再超时就跳过。
5. 每问一题写一条 `interview` 记录（题目 ID、开始/结束时间、回答文本长度、STT 置信度、是否超时）。

**验收**

- 长者沉默 8 秒 → 数字人复述一次；再沉默 8 秒 → 自动跳到下一题并说「唔緊要，我哋講第二樣」。
- 长者说「唔想讲」→ 立即结束并说收尾语，当天不再主动发起访谈。
- 5 类题在 `zh-HK` / `zh-MO` / `zh-CN` 三语言下都有文案（自检断言之）。

#### A2 · 主动调度器（1 天）

**步骤**

1. `planProactive()` 输入输出见 §2.5；纯函数，无 `window`。
2. **打扰预算**：每天最多 3 次主动开口；两次间隔 ≥ 90 分钟；21:00–08:00 静默（SOS 与未确认服药提醒除外）。
3. 三源优先级：`提醒到期` > `唤醒词` > `每日访谈` > `沉默关怀`（连续 2 天无交互才触发）。
4. `page.tsx` 内用一个 `setInterval(60_000)` 调 `planProactive()`；命中则走现有 `converse()`。
5. 原生侧（与 B 协同）：每日访谈时间点由 B 用 `AlarmManager` 精确唤醒（网页计时器在后台会被挂起）。

**验收**

- 单元断言：给定 09:00、当日已说 3 次 → 返回 `null`；给 22:30 + 有未确认服药 → 仅返回 `reminder`。
- 装机：锁屏 30 分钟后到点，App 被 Alarms 唤起并主动说话（依赖 B 的 M2 交付）。

#### A3 · 数字人模型挂载、Live2D 与口型（2 天）

**步骤**

1. **先做挂载层（A-8，§2.3.1）**：`MountLive2D.ts` 只做四件事——`fetch("/live2d/model.manifest.json")`（404/超时按空处理）→ `model === null` 直接返回 `null` → 否则动态 import PIXI 与模型 → 超时 3s 或抛错返回 `null`。`Avatar.tsx` 依据返回值决定 L1/L2/L3，**渲染路径之外零耦合**。
2. 建 `web/public/live2d/README.md` 与 `model.manifest.json`（`model: null`），**不提交任何模型二进制**；README 写明 §2.3.1 的格式表与「商用需自带授权」。
3. 引入 `pixi.js` + `pixi-live2d-display`（**只在 `MountLive2D.ts` 内动态 import**，不进首屏包）。
4. `state` → 动作：按清单 `stateMotion` 映射取 `motionGroups`；`idle` 播 `Idle` 循环、点击播 `TapBody`、`speaking` 期间暂停随机微动。
5. 口型：`speak()` 时把 TTS 输出接 `AnalyserNode`（若 TTS 无音频流，用 `visemeFromText` 序列按时长推进），0..1 写入清单指定的 `params.mouthOpen`（默认 `ParamMouthOpenY`）。
6. 视线：`listening` 时 `ParamAngleX` 轻微朝屏幕中心；`idle` 每 8–12 秒一次随机微动（`prefers-reduced-motion` 时全部关闭，仅保留嘴部与眨眼）。
7. 点击数字人 = 重说一遍上一句（适老化高频需求）——**L1/L2/L3 三级都必须响应点击**。

**验收**

- 默认仓库（`model: null`）首屏无 Live2D 依赖、无 4xx 请求，直接渲染 Canvas-2D。
- 按 §2.3.1 ⑤ 四条断言全过；把任一合规模型按目录丢入后**不改代码**即渲染 L1，删掉立刻回 L2。
- `prefers-reduced-motion` 下无位移动画，仅嘴部与眨眼。
- 口型与语音同步误差 < 150ms（录屏逐帧抽查 3 段）。

#### A4 · 采集质量门控（0.5 天）

1. `vad.ts` 换 Silero，`createVad` 签名不变；加载失败回退能量 VAD 并在 `track("vad_fallback")` 记一次。
2. `qualityOf()` 三项判据：语音占比 ≥ 0.25、SNR ≥ 15dB、时长 ≥ 8s（访谈单题 ≥ 3s）。不合格样本标记 `quality: "reject"`，**仍上传特征但标记**，由 C 决定是否入基线。
3. 每次采集前播报「我而家聽住，你慢慢講」，并在屏幕显示录音指示环（不要求看屏幕，仅为家属在场时可见）。

**验收**

- 播放电视噪声 30 秒 → `quality` 为 `reject`（不得进入基线）。
- 正常对话 → `good`。

#### A5 · 日常唤起与无障碍（1.5 天）

> 规格表见 §2.7，本节只写落地步骤。**判据**：长者不用读文字、不用记路径、不用精准点击，也能完成「叫出数字人 → 说需求 → 确认 → 收尾」全流程；语音链路完全坏掉时，纯按钮也能走完同样流程。

1. **唤起通路（五条，缺一条都不算完成）**：
   - 前台唤醒词（既有 `useWakeWord`，改名「小忆/阿忆/忆伴」）。
   - 后台上锁唤醒（B 的 `WakeListenService`，A 只对接回调）。
   - **长按数字人 1s**（`onPointerDown` 计时）：不依赖麦克风权限，永不失效。
   - **主按钮单击**（≥120×80px）：等同于说一句「小忆」。
   - **锁屏小组件 / 通知点击**（B 的 `HomeWidgetProvider` → `bringToForeground`）。
2. **忘记唤醒词的兜底**：连续 3 天无任何交互 → 主动播报「你叫我一聲『小憶』就得，或者㩒下面個大掣」；同时在主按钮下方常驻一行 24px 提示（不抢焦点）。
3. **无障碍语义**：`main` 单一地标；数字人 `role="img"` + 动态 `aria-label`；状态变化走 `aria-live="polite"`（SOS 用 `assertive`）；所有可点元素必须是 `<button>`/`<a>`，**禁止 `div onClick`**。
4. **焦点与可达**：逻辑焦点顺序 = 数字人 → 主按钮 → SOS → 工具面板；工具面板打开时焦点移入、`Esc`/返回键关闭并归还焦点；主操作区落在屏幕下半 60%（单手拇指可达）。
5. **触控与反馈**：所有触控目标 ≥ 120×80px、间距 ≥ 16px；点击有视觉按下态 + `navigator.vibrate(30)`（不支持则静默）；关键失败（麦克风被拒、网络断）用**声音 + 字幕**双通道说明，不弹错误码。
6. **视觉适配**：高对比模式（既有）扩展为三档「标准 / 高对比 / 大字（字幕 64px）」；色觉安全（不单独用颜色传达状态，永远配文字/图形）；尊重 `prefers-reduced-motion`。
7. **语音不可用的纯按钮通路**：STT 失败两次 → 自动展开「常用四件事」按钮组（吃药 / 打电话 / 今日安排 / 找家人），每个按钮直接触发对应的本地卡片，不要求再说话。
8. 演示开关（仅 dev 构型）：`?demo=1` 时把 STT 替换为预置脚本，用于嘈杂展台。**必须走环境变量，生产不打包。**

**验收**

- 关掉麦克风权限 → 主按钮仍能进入对话，且 8 秒内出现「常用四件事」按钮组；全程无死路。
- TalkBack 开启 → 从冷启动到「说一句话」不超过 4 次滑动，朗读内容包含当前状态与按钮用途。
- 连续 3 天无交互 → 冷启动时首次播报含「小忆」唤醒词与按钮指引。
- `grep -rn "onClick" web/src --include=*.tsx` 中不存在挂在非交互元素上的处理器（人工复核白名单）。

### 2.5 第一部分接口契约（对其他两人的接缝）

```ts
// lib/interview.ts
export type InterviewDomain = "memory" | "orientation" | "language" | "daily_living" | "mood";
export interface InterviewItem {
  id: string;                 // "memory-01"
  domain: InterviewDomain;
  prompt: Record<Locale, string>;
  followUp?: Record<Locale, string>;  // 答不上来时的提示（不是答案）
  maxSeconds: number;         // 默认 30
  scoreHint?: "recall" | "fluency" | "sequencing";
}
export interface InterviewState {
  askedToday: string[];
  answers: { id: string; at: number; durationMs: number; textLen: number; timedOut: boolean }[];
  startedAt: number;
}
export function pickNext(s: InterviewState, now: number): InterviewItem | null;
export function shouldStop(s: InterviewState, now: number): boolean;
```

```ts
// lib/proactive.ts
export type ProactiveKind = "reminder" | "interview" | "silence" | "greeting";
export interface ProactiveCtx {
  now: number;
  lastSpokeAt: number;
  spokenToday: number;          // 0..3
  silentDays: number;
  hasDueReminder: boolean;
  interviewDoneToday: boolean;
}
export interface ProactiveAction { kind: ProactiveKind; reason: string; }
export function planProactive(c: ProactiveCtx): ProactiveAction | null;
```

```ts
// lib/viseme.ts
export function visemeFromText(text: string, locale: Locale): number[]; // 0..1，每 60–90ms 一帧
export function visemeFromAnalyser(a: AnalyserNode): number;            // 0..1
```

**A 对 B 的需求（写进 B 的 M2 任务）**

| 需求 | 接口 | 说明 |
|---|---|---|
| 定时唤醒 | `MemoNative.scheduleDaily(hour: number, minute: number)` | `AlarmManager` 精确闹钟 + 开机重排 |
| 到点前置 | `MemoNative.bringToForeground(reason: string)` | 点击通知或闹钟触发，WebView 前置并带 `reason` 参数 |
| 原生 TTS 可选 | `MemoNative.speak(text, locale)` | 仅在 Web Speech 不可用时启用 |

### 2.6 第一部分自检

```bash
cd web
npm run typecheck
node src/selfcheck.ts          # 新增：访谈选题/停止条件/打扰预算/viseme 长度/改名无残留/清单降级判定
grep -rn "灵犀\|靈犀\|lingxi" src/ || echo "PASS: 无旧名残留"
# 模型留空与降级（§2.3.1 ⑤ 四条）
test -z "$(find public/live2d -name '*.moc3' -o -name '*.model3.json' 2>/dev/null)" && echo "PASS: 模型留空"
# 无障碍：不允许非交互元素挂点击
! grep -rn "div onClick" src --include=*.tsx && echo "PASS: 无 div onClick"
```

### 2.7 日常唤起与无障碍交互规格（A 主责，B 供原生能力）

**① 唤起通路矩阵（「日常唤起」的全集）**

| # | 通路 | 前提 | 触发后发生什么 | 归属 | 里程碑 |
|---|---|---|---|---|---|
| 1 | 说唤醒词「小忆 / 阿忆 / 忆伴」 | 麦克风权限 | 停止当前 TTS → `state=listening` → 播报「我喺度」 | A（前台）/ B（锁屏） | M0 / M2 |
| 2 | 单击主按钮 | 无 | 同上（等价于通路 1） | A | **已有** |
| 3 | 长按数字人 1s | 无 | `state=listening`，并播报「你想講咩？」 | A | M2 |
| 4 | 点击桌面小组件 | 已加小组件 | `bringToForeground("widget")` → 自动进入 listening | B | M2 |
| 5 | 点击通知 / 到点闹钟 | 通知权限 | 前置 → 按 `reason` 播报（提醒 / 访谈 / 晨间问候） | B | M2 |
| 6 | 开机自启 | B 的 `BOOT_COMPLETED` | 只重排闹钟，**不主动开口**（避免清晨惊吓） | B | M2 |
| 7 | 耳机线控 / 蓝牙键 | 系统媒体键 | 播放中 → 暂停；空闲 → 进入 listening | B | M4（可选） |
| 8 | 硬件音量键长按 | 无障碍服务（可选） | 进入 listening | B | M4（可选，权限敏感） |

> 前 5 条是**答辩必须演示**的通路；6–8 列为可选，未实现不影响门禁，但必须在答辩时说明取舍理由。

**② 无障碍验收基线（TalkBack / VoiceOver 通用）**

| 项 | 硬性要求 | 检查方式 |
|---|---|---|
| 语义角色 | 每个可交互元素是 `button`/`a`/`input`；数字人 `role="img"` + `aria-label` | TalkBack 逐元素朗读 |
| 状态播报 | `aria-live="polite"` 播报状态切换；SOS 用 `assertive` | 开关麦克风/触发 SOS 各听一次 |
| 焦点顺序 | 数字人 → 主按钮 → SOS → 工具面板，无跳过、无陷阱 | 键盘 Tab 走一遍 |
| 触控目标 | ≥ 120×80px，间距 ≥ 16px | 量 `getBoundingClientRect()` |
| 非视觉反馈 | 关键状态有振动或提示音 | 静音屏幕外操作一次 |
| 无语音可用 | 纯按钮完成「提醒/通话/今日安排/找家人」四件事 | 断麦克风权限演练 |
| 动效 | `prefers-reduced-motion` 下零位移，仅嘴部/眨眼 | 系统开关切换 |
| 对比度 | 文字 ≥ 4.5:1；高对比档 ≥ 7:1 | 取色器抽 3 处 |

**③ 与 §1.8 的对应关系**：`A【缺】` 两行（听力/视力适配、餐点关注）由本节 ② 与 A5 覆盖；`B【缺】` 三行（诈骗提示、夜间觉醒、数字能力指标）由 B 的 B7/B8 与 M3–M4 补齐，A 不实现。晨间问候与夜间静默属 B7 的 `reason` 播报，不由 A 单独排程。

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
| `web/src/lib/agent.ts` | 新增 | `runTurn(utterance, ctx)`：本地意图 → 后端 `/agent/turn` → 工具调用计划 → 执行 |
| `web/src/lib/geofence.ts` | 新增 | 纯函数：`inCircle`、`shouldAlert(prev, cur, fence)`（去抖 + 最小停留 60s） |
| `web/src/lib/outbox.ts` | 新增 | 指数退避重放：`enqueue` / `drain`（上限 500 条、7 天过期） |
| [intent.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/intent.ts) | 扩充 | 保留关键词兜底；新增 `navigate / call / alarm / message / repeat / cancel` |
| [cards.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/cards.ts) | 扩充 | `taskCard()`、`placeCard()`、`alarmCard()`、`agentPlanCard()`（展示「我准备做这 3 件事」） |
| [native.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/native.ts) | 扩充 | 新增 8 个方法（见 §3.5） |
| [api.ts](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/web/src/lib/api.ts) | 接线 | `getAgentCards` / `assistantChat` / `getMedicationPlan` 接真后端；新增 `postAgentTurn`、`postTaskEvent`、`postBehaviorDaily` |
| `AuraNativePlugin.java` | 重命名 + 补实现 | → `MemoNativePlugin.java`；`updateHomeWidget`、`bringToForeground`、`scheduleDaily`、`getLocation`、`openAccessibilitySettings` |
| `HomeWidgetProvider.java` | 新增 | `AppWidgetProvider`：读 `SharedPreferences` → 渲染提醒清单 |
| `res/layout/widget_home.xml`、`res/xml/widget_info.xml` | 新增 | 2×2 小组件：数字人头像 + 今日待办 3 条 |
| `AutoPilotService.java` | 新增 | `AccessibilityService`：接收指令 → 找节点 → 执行 → 回传 |
| `AndroidManifest.xml` | 修改 | 注册 service、widget receiver、`accessibility_service_config.xml` |

### 3.4 任务分解（可直接认领的步骤）

#### B0 · 改名 + 原生基线（0.5 天）

1. 按 §1.3 第 4、5、9 项改 Java 与 `native.ts`。
2. `npx cap sync android` 后 `./gradlew assembleDebug` 必须成功（M0 门禁）。
3. 装机验证：后台唤醒词改成「小忆」后能前置主界面。

#### B1 · 工具注册表与执行器（1.5 天）

**步骤**

1. 定义 10 个工具（见 §3.5 表），每个都写 `risk: "safe" | "confirm" | "forbidden"`。
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
| `set_alarm` | safe | `SCHEDULE_EXACT_ALARM` | `{at, label}` | `{alarmId}` | 本地闹钟 |
| `call_contact` | **confirm** | `CALL_PHONE` | `{name}` | `{number}` | 必须先复述姓名 |
| `send_message` | **confirm** | 无（走系统分享） | `{name, text}` | `{ok}` | 只允许预设模板句 |
| `locate` | safe | `ACCESS_FINE_LOCATION` | `{}` | `{lat,lng,accuracy}` | 前台取点 |
| `navigate_home` | safe | 无 | `{}` | `{distanceM}` | 文本 + 静态图 |
| `open_app` | confirm | 无障碍 | `{app}` | `{ok}` | 白名单 App |
| `ui_tap_text` | confirm | 无障碍 | `{text}` | `{ok, bounds}` | 当前页面内点一次 |
| `sos` | safe（最高优先） | 无 | `{reason}` | `{}` | 立即升级 |

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
| C-5 | LLM Agent `/agent/turn` + `/assistant/chat` + `/medication/plan` | `api/agent_routes.py`、`nlp/prompts.py` |
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
| `api/agent_routes.py` | 新增 | 3 个 LLM 端点真实现（替换 501） |
| `nlp/prompts.py` | 新增 | 系统提示：**不诊断、不荐药、异常引导 SOS**；输出严格 JSON schema |
| `reports/weekly.py` | 新增 | 周报生成：趋势、依从性、交互次数、建议（含「建议预约认知评估」的阈值条件） |
| `api/report_routes.py` | 新增 | `GET /reports/weekly/me`、`POST /reports/weekly/send` |
| `notify.py` | 新增 | SMS/推送抽象（demo 用 webhook + 日志；生产接 Twilio/FCM） |
| [contract_routes.py](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/backend/auragba/api/contract_routes.py) | 修改 | `post_sos` 真发通知；`post_conversation_memory` 加 TTL/加密 |
| [store.py](https://github.com/Warpshlczy/MircoCare-GBA/blob/main/backend/auragba/store.py) | 重写内部 | SQLite WAL；保持 `put/all/get/del` 四方法签名不变 |

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
4. `POST /medication/plan`：从 `history` + `utterance` 抽 `{name, dosage, schedule}`；**只抄不推断**，抽不到就返回空并让前端回退。
5. 超时 6s → 返回 503，前端走本地兜底（不阻塞长者）。

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
| `pixi.js` | MIT | 无 | 保留版权声明 |
| `pixi-live2d-display` | MIT | 无（库本身） | 保留版权声明 |
| **Live2D Cubism 模型（官方 sample）** | **Live2D Proprietary / Free Material License** | **不可直接商用**；sample 模型仅限演示与开发 | 演示可用；商用必须自建模型或购买授权。**答辩材料需注明"演示用 sample 模型"** |
| Cubism SDK / Cubism Core | Live2D Proprietary | 有营收门槛与发行条款 | 上线前替换为已授权版本 |
| `@ricky0123/vad-web`（Silero VAD） | MIT（模型 MIT） | 无 | 可直接用 |
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