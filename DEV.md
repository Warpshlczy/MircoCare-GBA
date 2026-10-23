# AuraGBA（湾区灵犀）前端开发文档

> 零 UI、语音驱动的长者关怀 **Agent 化手机端软件** · 粤港澳大湾区（香港 / 澳门 / 横琴）
> 纯软件方案，不依赖任何自研硬件。本仓库交付**前端**，后端 / LLM 接口按约定留空（stub）。

---

## 0. 一句话概览

一个装进长者现有手机即可运行的 **零 UI 语音助手**：核心交互是一张自绘数字人面孔 + 粤语／普通话语音 + 震动反馈。它平时**休眠**，只做监听与关键埋点；长者喊一声「灵犀」即**唤醒并开始交互**。最底层是 **Agent**：长者的话被解析成意图，Agent 决定在「桌面」（App 主界面卡片流）上生成什么卡片 —— 任务清单（含吃药）、天气、拍照结果等。卡片**二选一**：前端按结构化数据渲染，或后端 Agent 规划后下发 HTML 渲染。

所有敏感音频／传感器原始数据**不出端**，只上传本地算好的派生特征与粗粒度埋点。

界面遵守**语音优先**：默认只保留必要按钮，其余选项由长者一句「打开按钮」唤出；数字人**每天主动开口**和长者唠嗑，以采集当天实况。同一份代码既产出网页 PWA，也产出 **Android 原生安装包**（Capacitor 壳）。

项目根：`web/`（Next.js 14 App Router 工程）。

---

## 1. 我做了什么（交付物 & 验证结果）

### 1.1 交付物

| 类别 | 内容 |
|---|---|
| 技术栈 | Next.js 14（App Router）+ React 18 + TypeScript `strict` + TailwindCSS v3 |
| 运行形态 | **静态导出**（`output: 'export'` → `out/`）：既是可部署的 PWA，又直接作为 Android 壳的 `webDir` |
| 手机端 | **Android 原生版本**：Capacitor 6 壳 + 自定义 `AuraNative` 插件（见 §9） |
| 生产依赖 | 6 个：`next` / `react` / `react-dom` / `qrcode` / `@capacitor/core` / `@capacitor/android` |
| 源码文件 | 27 个 `.ts/.tsx` + 1 份自检脚本（见 §4 目录结构） |
| 后端接口 | **10 个**函数，位于 `web/src/lib/api.ts`。**7 个已接线到 `backend/`**（`postGaitWindow`/`postScreeningSession`/`postSos`/`getHealthCard`/`postTelemetry`/`postConversationMemory`/`postReminderEscalation`）；**3 个 LLM 接口按要求保持放空抛 `NOT_IMPLEMENTED`**（`assistantChat`/`getAgentCards`/`getMedicationPlan`） |
| 后端服务 | `backend/`（Python / FastAPI）：MCI/AD 多模态筛查引擎，隐私优先、个人基线 Z-score、双流融合、STEMB 经济与 SaMD 审计。见 §8.7 |

### 1.2 如何运行

```bash
cd web
npm install
npm run typecheck   # tsc --noEmit（strict）
npm run selfcheck   # 纯函数断言自检（node 直接跑）
npm run build       # 静态导出到 out/
npm run start       # 用静态服务器托管 out/（npx serve）；开发用 npm run dev

# Android 原生版本（需 JDK 17 + Android SDK，本机不具备 → 见 §9）
npm run cap:sync    # next build && cap sync android
npm run android     # cap open android（打开 Android Studio 构建 APK）
```

> 真机验证需 **HTTPS 或 localhost**：`DeviceMotionEvent`、Web NFC、麦克风、摄像头均要求安全上下文。Android 壳内 WebView 走 `https://` scheme，等价满足。

### 1.3 已通过的验证（本次实测）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | `rc=0`（strict 无错） |
| 纯函数自检 | `npm run selfcheck` | `selfcheck: OK`（幅度/跌倒三阶段/步态/VAD/升级边界/双语字典/**意图（含 `tools`）/卡片工厂/待办卡/每日签到/桌面小组件 payload**） |
| 静态导出构建 | `npm run build` | `✓ Compiled successfully`，路由 `/` **22.4 kB / 110 kB** First Load JS，产物在 `out/` |
| Android 工程 | `npx cap add android` | `[success] android platform added!`（`web/android/` 生成，含 `AuraNative` 插件 + 所需权限） |
| 浏览器冒烟 | Headless 浏览器 | 默认**只见「食药提醒 / 高对比 / 语言切换」三颗小按钮 + 「说话 / 求助」大按钮**；点语言切换键 → 整页在粤语↔普通话之间翻转（食藥提醒↔吃药提醒、講嘢↔说话）；说「打开按钮」→ 工具面板（健康卡/相机/唤醒/文字输入）展开；控制台零错误 |

> 说明：本机**无 JDK / Android SDK**（`java -version` 报「Unable to locate a Java Runtime」），因此**未在本机产出 APK**；Android 工程已完整脚手架化，构建步骤见 §9。这是环境限制，不是代码缺陷。

### 1.4 调研过程（先调研再动手，按用户要求）

- **GitHub 检索**：定位到跌倒检测、长者关怀与 VAD 参考实现 —— `parhamyassini/fall-detection-system`、`AmanDesai10/CareBridge`、`guansss/pixi-live2d-display`、`nico-martin/vad-recorder`、`tanyagray/browser-vad`、`Anjalirai62/Elderly-care-app`。
- **xerj 本地检索**：将 4 个参考仓库浅克隆到 `.research/` 并用 `xerj autoindex` 建索引（约 27 个 `ax-*` 索引），再经 MCP 工具检索关键实现：
  - `browser-vad`：Silero + `onnxruntime-web` 的 EventTarget API（`speech_start` / `speech_stop` / `speech_data`）。
  - `pixi-live2d-display`：模型事件与 `internalModel.update(dt, elapsed)` 驱动接口。
  - `CareBridge`：`FallDetectionService`（Kotlin）的 `accThreshold=10 / gyroThreshold=10` 幅度差阈值逻辑。
- **采纳的决策**：跌倒检测**扩写** CareBridge 的纯阈值法，补上「自由落体 → 冲击 → 冲击后静止」三阶段（纯阈值法会被任何一次硬碰撞误触发）；VAD 先用能量阈值但保留与 Silero 完全一致的 `{speech, ratio}` 契约，便于无痛替换；数字人先用 Canvas-2D 自绘，仅暴露 `state`/`level` 两个 prop 作为 Live2D 的替换点。

---

## 2. 设计哲学如何落地

| 原则 | 落地方式 |
|---|---|
| **零 UI / 低认知负荷** | 没有菜单、标签栏、汉堡按钮。默认**只有「食药提醒 / 高对比」两颗小按钮 + 「说话 / 求助」两颗超大主按钮**，其余选项**收进语音可唤出的工具面板**（§5.6）；信息以**卡片流**呈现。状态用数字人的脸 + 一行大字 + `aria-live` 播报。 |
| **全系统接管 & 适老化** | 正文 `font-size: 1.5rem`(24px) 起步、按钮 2–4rem；全局大号焦点环；`hc` 高对比模式（黑底白字）；粤语／普通话 TTS（语速 0.85）；PWA 可安装到主屏（系统桌面小组件见 §7）。 |
| **Agent 驱动** | App 本身只是**通用卡片渲染器**；「该显示什么」由 Agent 决策（当前是本地启发式，未来是后端 LLM）。见 §5。 |
| **边缘计算 & BYOD 传感** | 用手机自带 `DeviceMotionEvent`（约 20Hz）做步频与跌倒判定；VAD、静音裁剪、特征提取**全部在浏览器内完成**。 |
| **隐私优先** | `api.ts` 顶部写明绑定式隐私契约：原始音频／传感器流**不得出端**；仅上传匿名化派生特征与**粗粒度、无自由文本**的埋点；仅用假名 `DeviceId`（禁用 IDFA/AAID/IMEI/MAC）；对齐 HK PDPO、澳门个人数据保护法、PIPL。 |

---

## 3. 无障碍（Accessibility）要点

- 正文最小 24px，主行动按钮 ≥ 36px 字重 800，触控目标 ≥ 44px。
- 所有交互控件有语义与状态：SOS / 提醒 / 相机用 `role="alertdialog"|"dialog"` + `aria-modal` + `aria-labelledby`，提醒层内做**焦点陷阱**（Tab 只在 2 个按钮间循环）；语言、唤醒、高对比开关用 `aria-pressed`；状态文字用 `aria-live="polite"`。
- 数字人 `<canvas>` 带 `role="img"` + 随状态变化的 `aria-label`（如「灵犀正在聆听」）。
- 卡片 `article` 带 `aria-label`；后端 HTML 卡片用 `title` 标注 iframe。
- 全局大号焦点环：见 [globals.css](file:///Users/mac/Documents/hackthon/web/src/app/globals.css#L31-L42)。
- `prefers-reduced-motion` 全量降级；打印样式支持健康卡直接打印。
- **语音优先但不锁死**：默认隐藏次要控件（需求 1），但语音不可用/被拒时**自动展开工具面板**（fail-open）并提供文字输入；「说话 / 求助」始终可点；**SOS 永不隐藏**（安全底线）。

---

## 4. 目录结构

```
web/
├── public/
│   ├── manifest.webmanifest      # PWA 元数据（standalone、portrait、主题色）
│   └── sw.js                     # 手写 Service Worker（见 §6）
├── src/
│   ├── app/
│   │   ├── layout.tsx            # 根布局 + SW 注册脚本（内联，避免额外依赖）
│   │   ├── page.tsx             # 主视图：数字人 + 主按钮 + 卡片流 + 各覆盖层 + 唤醒
│   │   └── globals.css           # 24px 基准字号、高对比、焦点环、reduced-motion
│   ├── components/
│   │   ├── Avatar.tsx            # Canvas-2D 数字人（眨眼/呼吸/口型）
│   │   ├── CardRenderer.tsx      # ★ 单卡渲染：结构化 JSON 或沙箱 HTML
│   │   ├── CardBoard.tsx         # ★ 卡片流（App 自己的「桌面」）
│   │   ├── CameraOverlay.tsx     # ★ 全屏相机 + 一颗大快门
│   │   ├── ReminderOverlay.tsx   # 全屏食药提醒 + NFC 碰一碰 + 焦点陷阱
│   │   ├── SosOverlay.tsx        # 一键 SOS + 15s 倒计时 + 双重确认
│   │   └── HealthCardSheet.tsx   # 跨境健康卡底部弹层 + 二维码 + 可打印
│   ├── hooks/
│   │   ├── useWakeWord.ts        # ★ 休眠/活跃 生命周期 + 唤醒词监听
│   │   ├── useReminder.ts        # 提醒调度 + 10min/30min 升级状态机
│   │   └── useGaitMonitor.ts     # 步态/跌倒监控生命周期 + 权限 + 离线持久化
│   ├── lib/
│   │   ├── signal.ts             # ★ 纯数学核心（唯一「传感器/VAD」被测模块）
│   │   ├── intent.ts             # ★ 纯函数：文本 → 意图（keyword，可测）
│   │   ├── cards.ts              # ★ 纯函数：本地卡片工厂 + 原话成待办卡（后端不可用时的兜底）
│   │   ├── checkin.ts            # ★ 纯函数：每日主动唠嗑是否需要触发（本地日历日）
│   │   ├── native.ts             # ★ 原生壳桥接（window.__AuraNative 或 Capacitor AuraNative 插件）+ 桌面小组件 payload（纯函数）
│   │   ├── analytics.ts          # ★ 隐私优先埋点：本地缓冲 + 批量上报
│   │   ├── camera.ts             # ★ getUserMedia 摄像头（getUserMedia → 帧）
│   │   ├── types.ts              # 共享领域类型（无运行时逻辑）
│   │   ├── api.ts                # ★ 后端 + LLM + Agent + 埋点接口（6 个已接线，3 个 LLM 保持放空）
│   │   ├── i18n.ts               # 手写双语字典（zh-HK/zh-MO/zh-CN）
│   │   ├── audio.ts              # TTS / STT / 唤醒词 / 振幅表
│   │   ├── vad.ts                # 浏览器胶水：AnalyserNode → 能量 VAD
│   │   ├── motion.ts             # 浏览器胶水：DeviceMotionEvent → GaitWindow
│   │   ├── nfc.ts                # Web NFC 扫描/写入 + 手动兜底开关
│   │   └── db.ts                 # IndexedDB 离线优先封装（~30 行，无库；v3 含 conversation store）
│   └── selfcheck.ts              # 纯函数断言自检（node 直接运行）
├── capacitor.config.ts           # ★ Android 壳配置（webDir=out）
├── android/                      # ★ Capacitor 生成的 Android 原生工程（含 AuraNative 插件）
├── tailwind.config.ts            # aura 配色 + hc 变体 + 24px 基准字号
├── tsconfig.json                 # strict；allowImportingTsExtensions 供 selfcheck
└── next.config.mjs / postcss.config.mjs / package.json
```

（★ = 本轮新增/改造。**分层原则**：`signal.ts`/`intent.ts`/`cards.ts`/`native.ts` 是**纯函数层**（不触碰 `window`），可被 `node` 直接断言；`audio/vad/motion/nfc/camera` 是**浏览器胶水层**；`api.ts` 是**后端唯一入口**。）

---

## 5. 核心机制

### 5.1 Agent 卡片引擎（本轮重点）

App = **通用卡片渲染器**。「显示什么」由意图 + Agent 决定：

1. 长者说话 → Web Speech STT 得到文本。
2. `parseIntent(text)`（纯函数）把文本映射为意图：`weather | medication | tasks | camera | sos | tools | help | unknown`。
3. `runIntent()` 优先调用后端 Agent `api.getAgentCards({intent, utterance, locale, now})`；**抛错即视为「没有 Agent」**，回退到本地 `localCardsFor()`（或 `todoCardFromUtterance()`，见 §5.10）—— 因此**离线也能用**。
4. 得到的 `AgentCard[]` 进入 `CardBoard` 卡片流（最多保留 6 张，最新在前）。

**一张卡片二选一**（`AgentCard` 类型强制）：

| 模式 | 字段 | 谁渲染 | 安全处理 |
|---|---|---|---|
| 结构化 | `data`（headline / rows / checklist / image） | **前端** | 纯数据，无注入面 |
| HTML | `html` | **后端 Agent** | 放进 `sandbox=""` 的 iframe：**脚本、表单、跳转全禁用** |

> 安全边界：后端 Agent 下发的 HTML 是**不可信内容**，因此 `sandbox=""` 是关键防线 —— 它拿不到脚本权限、拿不到同源权限，无法触碰 App 的 IndexedDB / 麦克风 / 传感器。

拍照的卡片走结构化 `data.image`（data URL），无需 HTML。

### 5.2 语音唤醒 + 休眠/活跃（本轮重点）

- `useWakeWord(locale, enabled, onWake)` 管理 `ActivityState = sleeping | awake`。
- **休眠**：`startWakeWord()` 持续识别，命中唤醒词（「灵犀 / 靈犀 / lingxi / 小灵」）即 `track("wake_word")` → 唤醒 → 触发交互。浏览器静音后会结束识别，代码**自动重启**（有 300ms 退避；遇到错误则放弃，避免重启风暴）。
- **活跃**：唤醒后自动跑一次完整交互（聆听 → 识别意图 → 说话 → 出卡片）；交互结束后 `wake.sleep()` 重新进入休眠监听。
- 交互识别前会 `wake.stopListening()` 释放麦克风，避免两个识别器抢麦。
- 「开语音唤醒」开关**默认开启**（隐藏于工具面板），可随时关闭；浏览器麦克风权限需**一次用户手势**授权，首次授权后即持续监听。

### 5.3 摄像头

`camera.ts` 用 `getUserMedia({video:{facingMode:"environment"}})` 开后置摄像头；`captureFrame()` 用 canvas 抓帧、降采样成 JPEG data URL → 生成一张 `camera` 卡片。`CameraOverlay` 只有一颗大快门 + 一个退出键（适老化，无设置项）。无相机/被拒时显示降级文案（不崩）。

### 5.4 隐私优先埋点（关键数据）

`analytics.ts` 的 `track(name, locale, props)` 只记录**事件名 + 时间 + 语言 + 粗粒度 props**；**绝不含自由文本、音频、传感器流、健康数值或任何 PII**。事件缓冲进 IndexedDB 的 `events` store，`flush()` 批量上报；上报失败（stub/离线）则**保留缓冲**。已埋点：`app_open`、`wake_word`、`intent`、`intent_unknown`、`card_shown`（含 `mode: agent|local`）、`med_taken`、`sos_trigger`、`gait_fall`、`camera_capture`。

### 5.5 其余三大模块（沿用上一轮）

- **食药管家**：`useReminder` + `escalationFor()`（**10 分钟温和重试 / 30 分钟推送照顾员**，`stage` 保证幂等）；NFC「碰一碰」打卡，`NFC_SUPPORTED` 为假时**强制**大按钮兜底。
- **无硬件守护**：`DeviceMotionEvent` → 步数/步频/步态变异 `cv`；跌倒用「自由落体 → 冲击 → 冲击后静止」三阶段；1 分钟语音筛查只产出派生特征。
- **跨境 SOS + 健康卡**：15s 倒计时双重确认；最小必要信息二维码 + 可打印。

### 5.6 语音优先的 UI 收敛（本次需求 1）

默认界面**只保留两件事**：`食药提醒`、`高对比`（外加「说话 / 求助」两颗主按钮 —— 前者是语音入口，后者是安全底线，均属**故意的例外**，见 `page.tsx` 内注释）。语言、健康卡、相机、唤醒开关、文字输入等**全部收进「工具面板」，默认 `showTools=false`**。

- **展开方式**：长者说「打开按钮 / 开关 / 设置 / 选项…」→ `parseIntent` 命中 `tools` → `setShowTools(true)` + 语音确认（`toolsOpened`）。
- **失败开放（fail-open）**：`sttSupported()` 为假、或 STT 启动失败、或麦克风被拒时，**自动展开工具面板**并播报 `voiceUnavailable` —— 语音不可用时**绝不让长者被锁死**（无障碍硬要求）。
- **文字通道**：工具面板内 `typeHere / send` 表单，满足需求 3 的「语音或文字输入」。
- **可见语言切换（本次新增）**：顶部小按钮行固定保留一颗**语言切换键**（`langOther`），一按即在**普通话 ↔ 粤语**间翻转整页文案（TTS 语言也随之切换）。按钮文字**始终显示「要切过去的那种语言」**（当前粤语时显示「普通話」，当前普通话时显示「粤语」），避免长者误读。工具面板里**不再重复**放语言按钮。

### 5.7 喊名字才应答 + 唤醒默认开启 + 有效语音门控（需求 2）

- 唤醒词**默认实时开启**（`wakeOn` 初值 `true`），`useWakeWord` 在休眠态持续识别**助手的名字**「灵犀 / 靈犀 / lingxi / 小灵 / 灵西」。
- **必须喊名字才应答（本次强化）**：听到名字后**不再直接进入聆听**，而是先**主动问一句**再接收语音 —— 命中唤醒词 → `converse(t(locale,"wakeGreeting"))`（「阿婆／阿伯，我喺度。今日身體點呀？有冇邊度唔舒服？」）→ 说完即进入聆听。对应需求「听到名字后主动询问老人情况」。
- **有效语音门控**：交互识别时 `onTalk` 同时挂一个振幅表，只有**同时满足**「最终文本长度 ≥ 2」且「振幅峰值 ≥ 0.08」才当作有效话语；否则播报 `noSpeech` 重新等待。这样**环境噪声 / 咳嗽 / 电视声**不会被误当成指令。（若无麦克风权限拿不到振幅表，则退化为仅按文本长度判断，不会误杀。）

### 5.8 用药计划由「对话记忆 + 画像 + 本次话语」生成（本次需求 3）

- **会话记忆**：每一句长者话语先落本地 IndexedDB 新 store `conversation`（`ConversationTurn[]`），再尝试 `postConversationMemory()` 上报；上报失败**不丢**（本地为准）。
- **生成**：命中 `medication` 意图时，调用 `getMedicationPlan({ locale, utterance, history, now })`，由后端 LLM 依据历史对话 + 画像 + 本次话语产出 `MedicationPlan`；前端为每个 item **调度一条提醒**并渲染任务卡。后端不可用则回退现有本地提醒逻辑。
- 药名、剂量来自后端；`schedule`（如「早上」）目前并入标题展示（`ponytail:` 已注明时间槽解析属后端职责）。

### 5.9 数字人每天主动「唠嗑」评估（本次需求 4）

- 纯函数 [checkin.ts](file:///Users/mac/Documents/hackthon/web/src/lib/checkin.ts)：`shouldCheckIn(lastAt, now)` 按**本地日历日**判断（不是 24h 计时 —— 长者的「早晨」才是触发点）。
- 启动时读 `meta/checkin` 的 `lastAt`：若跨天 → 记 `track("daily_checkin")`、写入 `lastAt`、**主动播报** `dailyCheckIn`（「早晨呀，今日精神點？有冇邊度唔舒服？」）并**接着进入聆听**，用长者的回答采集当日实况。
- `ponytail:` 天花板：网页无法后台定时，只能在**下次打开 App**时触发；跨过它需要原生壳的 OS 级每日通知（§9）。

### 5.10 任意话语 → 调 API → 卡片 / 待办 / 后端 HTML（本次需求 6）

`runIntent(intent, utterance)` 对**任何**已识别话语都会：

1. 先试后端 Agent `getAgentCards({intent, utterance, locale, now})` —— 后端可以返回**结构化 `data`**（前端渲染）**或 `html`**（后端渲染，塞进 `sandbox=""` iframe，脚本禁用）。
2. 后端不可用（当前 stub 必抛错）→ 回退本地 `localCardsFor()`；若本地也产不出卡（如意图 `unknown`）且话语非空 → **`todoCardFromUtterance()` 把长者的原话直接变成一条待办卡**（「说什么就记什么」）。
3. 卡片进入 `CardBoard` 卡片流（最多 6 张）。

> 诚实边界：网页端的本地回退是**关键词匹配 + 原话成卡**，不是真 NLU。**「说得越多越聪明」这件事属于后端 LLM 交付物**（§8.2 / §8.6），前端只负责把话语、意图、会话历史**如实投递**并渲染返回结果。

### 5.11 打开即语音对话 + 回到前台续聊（本次需求 3）

四条「主动开口」的路径都收敛到同一个原语 `converse(line)`（说一句 → 开始聆听），并用 `stateRef` 做**空闲守卫**，防止两个触发同时说话：

| 触发 | 播报内容 | 说明 |
|---|---|---|
| **打开 App** | 当天首次：`dailyCheckIn`；之后：`openGreeting` | boot 后 1500ms（等 `ensureAudioUnlocked`）自动开口，**默认就开始语音对话** |
| **回到前台** | `openGreeting` | 监听 `visibilitychange`，从后台回来（如解锁手机）时续聊；**20 秒冷却**避免频繁切页反复打扰 |
| **喊出名字**（需求 2） | `wakeGreeting` | 见 §5.7 |
| **每日签到**（需求 4） | `dailyCheckIn` | 见 §5.9 |

> 后台/锁屏时网页听不到名字（平台天花板，§7），因此「锁屏听到名字 → 主动询问」由 **Android 原生前台服务**接管：见 §9。

---

## 6. 刻意的简化（ponytail 清单）与升级路径

按 `.trae/ponytail.md` 要求，所有「有已知天花板的简化」都以 `ponytail:` 注释标注（源码中共 **15** 处，含 1 处 Java）。摘要：

| # | 位置 | 简化内容 | 天花板 | 升级路径 |
|---|---|---|---|---|
| 1 | [sw.js](file:///Users/mac/Documents/hackthon/web/public/sw.js#L1-L7) | 手写 SW：静态 cache-first、导航 network-first | 无 precache 版本管理 / 后台同步 | 换 workbox |
| 2 | [globals.css](file:///Users/mac/Documents/hackthon/web/src/app/globals.css#L31-L42) | 焦点环覆盖 `:focus` 而非仅 `:focus-visible` + `!important` | 视觉上始终显示焦点环 | 无需升级：对长者/开关访问用户是**期望行为** |
| 3 | [audio.ts](file:///Users/mac/Documents/hackthon/web/src/lib/audio.ts#L93-L98) | 口型 = 实时**振幅**，非音素 viseme | 嘴只会张合，不塑形 | Live2D + 真实 viseme 时间轴 |
| 4 | [page.tsx](file:///Users/mac/Documents/hackthon/web/src/app/page.tsx#L119-L120) | TTS 口型用**合成正弦** | 与真实音素无关 | 把 TTS 输出接 analyser 或 Live2D 口型轨 |
| 5 | [audio.ts](file:///Users/mac/Documents/hackthon/web/src/lib/audio.ts#L150-L158) | 网页端唤醒词**仅前台**监听 | 网页后台/锁屏听不到 | **已落地**：原生壳 `WakeListenService` 前台服务接管（§9.4） |
| 6 | [intent.ts](file:///Users/mac/Documents/hackthon/web/src/lib/intent.ts#L1-L6) | 关键词匹配，**非 NLU** | 无同义改写 / 无槽位抽取 | 交给后端 Agent，本函数降级为离线兜底 |
| 7 | [cards.ts](file:///Users/mac/Documents/hackthon/web/src/lib/cards.ts#L24-L26) | 天气为**演示值** | 非真实天气 | 后端 Agent 返回真实天气卡 |
| 8 | [camera.ts](file:///Users/mac/Documents/hackthon/web/src/lib/camera.ts#L1-L4) | 浏览器 getUserMedia 路径 | 相机能力受浏览器限制 | 原生壳换更优相机插件，函数签名不变 |
| 9 | [vad.ts](file:///Users/mac/Documents/hackthon/web/src/lib/vad.ts#L1-L7) | **能量阈值** VAD | 漏弱/低音语音，易被环境噪声触发 | 换 Silero（`onnxruntime-web`），契约 `{speech, ratio}` 不变 |
| 10 | [motion.ts](file:///Users/mac/Documents/hackthon/web/src/lib/motion.ts#L1-L6) | 仅前台/亮屏采样 | 锁屏/后台即停采 | 原生壳 / BLE 穿戴持续供数 |
| 11 | [Avatar.tsx](file:///Users/mac/Documents/hackthon/web/src/components/Avatar.tsx#L6-L10) | Canvas-2D 代替 Live2D | 拟真度有限 | 替换 `draw()` 为 `pixi-live2d-display`，仅需 `state`/`level` |
| 12 | [HealthCardSheet.tsx](file:///Users/mac/Documents/hackthon/web/src/components/HealthCardSheet.tsx#L15-L17) | 引入 `qrcode` 依赖 | 多一个依赖 | 可接受：手写 RS 纠错 + 掩码不划算 |
| 13 | [checkin.ts](file:///Users/mac/Documents/hackthon/web/src/lib/checkin.ts#L6-L10) | 每日唠嗑用**本地日历日**触发，且只在**下次打开 App** 时判定 | 关着的 App 不会主动叫人 | 原生壳 OS 级每日通知（§9） |
| 14 | [page.tsx](file:///Users/mac/Documents/hackthon/web/src/app/page.tsx#L68-L70) | 用药计划的 `schedule`（如「早上」）不解析成真实 due time | 提醒在创建时即触发 | 后端返回显式 `dueAt`，或由 Agent 解析时间槽 |
| 15 | [WakeListenService.java](file:///Users/mac/Documents/hackthon/web/android/app/src/main/java/com/auragba/app/WakeListenService.java) | 后台唤醒用**平台 `SpeechRecognizer` 短会话循环**近似常驻监听 | 耗电偏高、唤醒延迟略大 | 换端上关键字唤醒（Porcupine/Snowboy），`ACTION_START/STOP` 契约不变 |

> 「有效语音门控」的阈值（`VOICE_PEAK_MIN = 0.08`、最短 2 字）是**真实硬件标定**，不是可以偷懒的地方；不同手机的麦克风增益不同，上线前需用目标机型校准（`page.tsx` 顶部常量）。

> 非平凡纯函数（`signal.ts` / `intent.ts` / `cards.ts` / `native.ts` / `checkin.ts`）都配有可在 `node` 直接运行的断言自检 `src/selfcheck.ts`。

---

## 7. 已知平台天花板（诚实说明，勿夸大能力）

Web PWA **无法真正「接管」锁屏 / 桌面 / 前台**；以下是**浏览器平台限制**，不是实现缺陷：

| 需求 | 网页（PWA） | 需要什么 |
|---|---|---|
| **后台/锁屏唤醒词** | ❌ 后台会挂起 JS + 掐麦克风 | **已落地**：原生前台服务（§9.4） |
| **自动跳到前台** | ❌ 浏览器禁止网页自我前置 | 原生 App / 通知点击 |
| **系统桌面小组件** | ❌ 网页不能写系统桌面 | 原生 AppWidget / WidgetKit |
| **App 内卡片流**（本轮已实现） | ✅ | — |
| **前台唤醒词**（本轮已实现） | ✅ 需 App 前台 + 亮屏 + 一次手势授权 | — |
| **摄像头**（本轮已实现） | ✅ 需 HTTPS/localhost + 授权 | — |
| 后台/息屏传感器采样 | ⚠️ 锁屏即停采 | 原生壳 / BLE 穿戴 |
| 震动 `navigator.vibrate` | ⚠️ 仅 Android Chrome | 原生 |
| Web NFC 碰一碰 | ⚠️ 仅 Android Chrome | 原生 NFC |

> 结论：本轮交付的是「**纯软件、零硬件、可立即体验的完整演示 + 可扩展骨架**」。「后台唤醒 / 自动前置 / 系统桌面小组件」三件事已**预留**成一条接缝（§8.4），并**已落地为 Capacitor Android 壳**（§9）。其中**后台唤醒已实现**（`startBackgroundWake`/`stopBackgroundWake` + `WakeListenService`，§9.4）；仅剩 `updateHomeWidget`/`bringToForeground` 待补齐。

---

## 8. 需要后端实现什么（交付契约）

所有后端交互集中在 [api.ts](file:///Users/mac/Documents/hackthon/web/src/lib/api.ts)。前端已冻结类型，后端**只需实现下列契约函数**并遵守隐私契约。

> **实现状态（后端已交付）**：`backend/`（FastAPI）已实现全部契约端点。其中 **7 个接入真实后端逻辑并返回 204/200**（`#1–#4`、`#7`、`#8`、`#10`），**3 个 LLM 编排端点按约定返回 HTTP 501**（`#5 assistantChat`、`#6 getAgentCards`、`#9 getMedicationPlan`），以此触发前端的本地兜底路径（本地卡片工厂 / 本地提醒）。前端 `api.ts` 仅在 7 个非 LLM 函数体接线；3 个 LLM 函数体保持抛 `NOT_IMPLEMENTED`。详见 §8.7。

**绑定式隐私契约**（`api.ts` 头部注释已写明）：原始音频 / 原始传感器流**不得出端**；只上传 VAD 裁剪后的派生特征与粗粒度埋点；仅携带假名 `DeviceId`；对齐 HK PDPO、澳门个人数据保护法（PDPA）、PIPL。

### 8.1 接口清单

| # | 函数 | HTTP（建议） | 请求体类型 | 响应 | 后端状态 |
|---|---|---|---|---|---|
| 1 | `postGaitWindow(w)` | `POST /gait/windows` | `GaitWindow` | `void` | ✅ 已实现（204） |
| 2 | `postScreeningSession(s)` | `POST /screening/sessions` | `ScreeningSession` | `void` | ✅ 已实现（204，vector-only 摄入） |
| 3 | `postSos(e)` | `POST /sos` | `SosEvent` | `void` | ✅ 已实现（204） |
| 4 | `getHealthCard()` | `GET /health-card/me` | — | `HealthCard` | ✅ 已实现（200） |
| 5 | `assistantChat(req)` | `POST /assistant/chat` | `AssistantChatRequest` | `{ reply }` | ⏸ **501（LLM 放空）** |
| 6 | **`getAgentCards(req)`** | `POST /agent/cards` | `AgentIntentRequest` | **`AgentCard[]`** | ⏸ **501（LLM 放空）** |
| 7 | **`postTelemetry(events)`** | `POST /telemetry/events` | `TelemetryEvent[]` | `void` | ✅ 已实现（204，服务端二次脱敏） |
| 8 | **`postConversationMemory(turn)`** | `POST /conversation/turns` | `ConversationTurn` | `void` | ✅ 已实现（204，按假名归档） |
| 9 | **`getMedicationPlan(req)`** | `POST /medication/plan` | `MedicationPlanRequest` | **`MedicationPlan`** | ⏸ **501（LLM 放空）** |
| 10 | **`postReminderEscalation(e)`** | `POST /reminders/escalate` | `ReminderEscalation` | `void` | ✅ 已实现（204，记录超时事件 + 家属 outbox） |

> #8 / #9 是本次新增（需求 3、6）。前端会**先落本地再上报**，因此 #8 偶发失败不丢记忆；#9 失败则回退本地提醒。返回 501 的 3 个 LLM 端点与前端 `NOT_IMPLEMENTED` 一一对应，联调时前端按既定策略自动兜底，不报错。

### 8.2 Agent 卡片契约（本轮新增，重点）

```ts
type Intent = "weather" | "medication" | "tasks" | "camera" | "sos" | "help" | "tools" | "unknown";

interface AgentIntentRequest {
  intent: Intent;
  utterance: string;   // 长者原话（后端可做 NLU；注意：这是文本，非音频）
  locale: Locale;      // zh-HK | zh-MO | zh-CN
  now: number;
}

type CardKind = "task" | "med" | "weather" | "camera" | "info";

interface AgentCard {
  id: string;
  kind: CardKind;
  title: string;
  createdAt: number;
  // 二选一：
  data?: CardData;     // 前端渲染（结构化，安全）
  html?: string;       // 后端渲染（放入 sandbox="" iframe，脚本禁用）
  actions?: { id: string; label: string; intent: Intent }[];
}

interface CardData {
  headline?: string;   // 一个超大值，如 "27°C 天晴"
  icon?: string;       // 单个 emoji/字形
  image?: string;      // data URL
  rows?: { label: string; value: string }[];
  checklist?: { id: string; text: string; done: boolean }[];
}
```

**后端职责建议**：
- 用 LLM 把 `utterance` 解析成结构化意图 / 槽位，再规划要展示的卡片。
- 天气、日程、用药等真实数据源接入后，返回真实 `data`；需要复杂排版时返回 `html`（务必是**静态展示型**内容，前端会禁用脚本）。
- 任何失败都应返回错误（前端自动回退本地卡片），不要返回空壳卡片。

### 8.3 埋点契约

```ts
interface TelemetryEvent {
  id: string; name: string; at: number; locale: Locale;
  props?: Record<string, string | number | boolean>; // 仅粗粒度
}
```
后端 `/telemetry/events` 需接受批量数组；前端保证**不含自由文本 / 音频 / PII**，后端也应再做一次校验与脱敏。

### 8.4 原生壳接缝（让「后台唤醒 / 自动前置 / 系统桌面小组件」落地）

`lib/native.ts` 是**唯一接缝**。`bridge()` 有两种来源、**同一形状**：(1) `window.__AuraNative`（任何注入者，如测试桩）；(2) Capacitor 的 **`AuraNative` 插件**（Android 壳自带，见 §9）。网页环境下 `bridge()` 返回 `null`，App 不报错。接口：

```ts
interface AuraNativeBridge {
  startBackgroundWake(): Promise<boolean>;      // 后台音频服务听唤醒词
  stopBackgroundWake(): Promise<void>;
  updateHomeWidget(p: HomeWidgetPayload): Promise<void>; // 写系统桌面小组件
  bringToForeground(): Promise<boolean>;        // deep link / 前置 WebView
}

interface HomeWidgetPayload {   // homeWidgetPayload() 纯函数已实现并自检
  updatedAt: number;
  title: string;
  items: { text: string; done: boolean }[];
  topCard?: { kind: string; headline: string };
}
```

前端已在卡片/提醒变化时调用 `bridge()?.updateHomeWidget(...)`（网页端为空操作）。Android 壳里 `AuraNativePlugin.java` 的 4 个方法中，**`startBackgroundWake`/`stopBackgroundWake` 已实现**（驱动 `WakeListenService` 前台服务）；`updateHomeWidget`/`bringToForeground` 仍为桩，**补齐即可**再解锁「自动前置 / 系统桌面小组件」（§9）。前端在启动（`wakeOn` 为真）与唤醒开关切换时已分别调用 `startBackgroundWake()`/`stopBackgroundWake()`。

### 8.5 后端需负责的非功能性事项

1. **鉴权与设备绑定**：下发/校验假名 `DeviceId`，绝不下发或存储真实设备标识。
2. **SOS 真实升级链路**：`POST /sos` 需并联通知**家人 + 社区照顾员**，跨境场景考虑三地紧急号码。
3. **LLM 编排**：`/assistant/chat` 与 `/agent/cards` 内应内置健康安全边界（不诊断、不荐药，异常引导 SOS）。
4. **派生特征入库与趋势**：`cv`、步频、筛查特征的长期趋势是「跌倒前预警」的数据基础。
5. **合规**：存储与跨境传输满足 HK PDPO / 澳门 PDPA / PIPL；最小化 + 加密 + 可撤回同意。
6. **健康卡同步**：`GET /health-card/me` 支持家属/诊所更新与版本号。
7. **建议补齐**：`POST /reminders`（提醒同步）、离线队列回传（IndexedDB 已存，暂无 flush 触发点，可按需在 `analytics.flush()` 模式上扩展）。

### 8.6 会话记忆 & 用药计划契约（本次新增）

```ts
interface ConversationTurn {
  id: string; at: number;
  role: "user" | "assistant";
  text: string;          // 文本，非音频
  locale: Locale;
}

interface MedicationPlanRequest {
  locale: Locale;
  utterance: string;              // 本次话语，可能为空
  history: ConversationTurn[];    // 最近 ≤20 轮本地记忆
  now: number;
}

interface MedicationPlan {
  items: { name: string; dosage: string; schedule: string }[];
  basis?: "history" | "profile" | "utterance" | "mixed";  // 供审计：依据来源
}
```

**后端职责建议**：
- `/conversation/turns`：按假名 `DeviceId` 归档，长期用于学习长者习惯 / 生成提醒；不得存储音频。
- `/medication/plan`：结合 `history` + 长者档案 + `utterance`（LLM 抽取药名 / 剂量 / 时间）产出计划；`schedule` 目前由前端并入标题展示，后端若同时给出显式 `dueAt` 可让提醒落在正确时刻（见 §6 #14）。
- 健康安全边界：**不诊断、不荐药**；异常一律引导 SOS。

### 8.7 后端交付（`backend/`，Python / FastAPI）

与前端同仓、独立运行。**启动方式**：

```bash
cd backend
python3 -m pip install -r requirements.txt   # 核心：fastapi / uvicorn / pydantic / numpy / python-multipart
uvicorn auragba.main:app --reload --port 8000
python3 selfcheck.py                          # 可运行断言自检 → selfcheck: OK
```

前端通过 `NEXT_PUBLIC_API_BASE`（默认 `http://localhost:8000`）指向本服务；所有请求携带假名 `X-Device-Id` 头。目录结构：

```text
backend/
├── requirements.txt            # 核心依赖（重依赖以注释形式给出，见下）
├── .env.example / .env         # 模型路径 / 隐私模式 / 基线段长 / 融合权重 / 风险阈值 / CORS
├── selfcheck.py                # 纯断言自检（双后端特征槽位 / VAD / NLP / 融合 / 基线 / 审计 / 全链路）
├── scripts/                    # 训练与评估（离线）：train_acoustic / train_semantic / eval_fusion
├── models/                     # 训练产物：acoustic_lgbm.txt、semantic_lr.joblib、whisper-small/
└── auragba/
    ├── config.py               # ENGINE_VERSION / FEATURE_SET_VERSION / 阈值与设置
    ├── contract.py             # Pydantic v2 契约（字段名严格镜像前端 camelCase）
    ├── privacy.py              # 假名化 / PII 擦除 / 提取即焚（bytearray 归零）/ 输入摘要
    ├── store.py                # 按假名 DeviceId 的每设备 JSON 存储（线程锁）
    ├── audit.py                # SaMD 审计日志：append-only JSONL hash 链 + verify() 防篡改
    ├── baseline.py             # 个人 14 天基线 Z-score（方向敏感 normal/watch/elevated）
    ├── economics.py            # STEMB：QALY 获得值 / 每患者节约成本估算
    ├── screening.py            # 全链路编排（load→VAD→特征→ASR→NLP→连贯度→双流→融合→基线→经济→审计→purge）
    ├── main.py                 # FastAPI 工厂 + CORS + 路由装配
    ├── audio/
    │   ├── io.py               # WAV（手写 8/16/24/32-bit PCM 解码）+ 线性重采样到 16k
    │   ├── vad.py              # 能量 VAD（`{speech, ratio, segments}`，契约对齐前端 lib/signal.ts）
    │   └── features.py         # eGeMAPS 88 维 + F1/F2/F3、Jitter、Shimmer（openSMILE 优先，否则纯 numpy 近似）
    ├── nlp/
    │   ├── asr.py              # Whisper（本地/faster-whisper）优先；远程 API 故意 NotImplementedError
    │   ├── metrics.py          # TTR / MATTR / 名动比 / 句长均值与方差 / 填充词比
    │   └── coherence.py        # 数字人提问 ↔ 长者回答的语义连贯度（sentence-transformers 优先）
    ├── model/
    │   ├── acoustic.py         # 流 A：LightGBM/XGBoost 优先，否则可解释 logistic（真模型用 SHAP、兜底用手工权重，均含逐特征贡献度）
    │   ├── semantic.py         # 流 B：文本分类器（sklearn 优先，否则 logistic）
    │   └── fusion.py           # 晚期融合：加权归一化得到 0.0–1.0 综合风险指数
    └── api/
        ├── contract_routes.py  # 上表前端契约端点
        └── insight_routes.py   # 附加：/screening/analyze、/baseline/me、/economics/me、/audit/screening、/health
```

**四项核心理念的落地位置**：非侵入式双模态生物标志物 → `audio/features.py` + `nlp/`；隐私管线 → `privacy.py`（`extract-and-burn` / `vector-only` / PII 擦除 / 假名化）；个人基线动态追踪 → `baseline.py`；STEMB 与 SaMD → `economics.py` + `audit.py`。

**依赖与降级**：本机 **未安装** `librosa` / `soundfile` / `opensmile` / `scikit-learn` / `lightgbm` / `xgboost` / `sentence-transformers` / `jieba`，因此全部走**纯 numpy 优雅降级**实现；每个回退点用 `ponytail:` 注释标明天花板与升级路径，装上对应依赖即自动切换到正式实现。**LLM / ASR 远程 API 按要求放空**（`asr.transcribe_via_remote_api` 抛 `NotImplementedError`，3 个编排端点返回 501）。

**验证结果**：`python3 selfcheck.py` → `selfcheck: OK`；9 个契约端点 HTTP 实测通过（6 个 204/200、3 个 501）；浏览器级联调确认 PWA 发出 `POST /telemetry/events` 并成功落库、服务端二次擦除 `props`、无 CORS / 控制台错误；前端 `typecheck` 与 `build` 均通过。

---

## 9. Android 原生版本

需求 5 通过 **Capacitor 6 包裹现有静态导出**实现（**不重写**为 React Native —— 复用同一套代码，零重复）。已生成/改动：

```
web/
├── capacitor.config.ts            # appId=com.auragba.app，webDir=out，androidScheme=https
└── android/                       # npx cap add android 生成的原生工程
    └── app/src/main/
        ├── AndroidManifest.xml    # RECORD_AUDIO / CAMERA / VIBRATE / FOREGROUND_SERVICE(_MICROPHONE) / POST_NOTIFICATIONS + <service> WakeListenService
        └── java/com/auragba/app/
            ├── MainActivity.java      # onCreate 里 registerPlugin(AuraNativePlugin.class)
            ├── AuraNativePlugin.java  # ★ 4 个桥接方法（唤醒两个已实现，其余为桩）
            └── WakeListenService.java # ★ 后台唤醒前台服务（听「灵犀」→ 前置主界面）
```

### 9.1 为什么是「套壳」而不是「重写」

App 的全部能力（Agent 卡片引擎、语音、传感器、隐私契约）都在 `web/src` 里且**纯前端**；静态导出后就是一个 `out/` 目录。Capacitor 用系统 WebView 加载它，因此：**同一份代码 = 网页 PWA + Android App**，后端接口契约完全一致。

### 9.2 本机为何没产出 APK

`java -version` → *Unable to locate a Java Runtime*；`sdkmanager` 不存在；`~/Library/Android` 无 SDK。**本机无 JDK 与 Android SDK**，无法编译。这是环境限制，不是代码缺陷。

### 9.3 构建 APK 的步骤（在装有工具链的机器上）

```bash
# 前置：JDK 17 + Android SDK（含 platform-tools / build-tools）
cd web
npm install
npm run cap:sync          # = next build（导出到 out/）+ cap sync android（拷进原生工程）
npm run android           # 打开 Android Studio，Build > Build APK(s)
# 或纯命令行：
cd android && ./gradlew assembleDebug    # 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

### 9.4 原生能力清单（需求 2：后台唤醒已实现）

1. ✅ **`startBackgroundWake` / `stopBackgroundWake`（已实现）** —— `AuraNativePlugin` 先申请 `RECORD_AUDIO`（`@CapacitorPlugin` 权限别名 `mic` + `@PermissionCallback`），再以 `START_STICKY` 启动前台服务 [`WakeListenService`](file:///Users/mac/Documents/hackthon/web/android/app/src/main/java/com/auragba/app/WakeListenService.java)：常驻通知（渠道 `aura_wake`、`FOREGROUND_SERVICE_TYPE_MICROPHONE`）+ `SpeechRecognizer` 识别循环（`onPartialResults`/`onResults` 命中名字列表「灵犀 / 靈犀 / lingxi / 小灵 / 灵西」即 `startActivity(MainActivity)` 前置）。**这一步真正跨过「锁屏听不到唤醒词」的天花板**；回到前台后由 §5.11 的 `visibilitychange` 续聊，或由前景唤醒逻辑走 `wakeGreeting`。前端已在启动及唤醒开关切换时调用它。
2. ⏳ `updateHomeWidget` —— 把 `HomeWidgetPayload` 落到 `SharedPreferences` 并 `AppWidgetManager` 通知 AppWidgetProvider 重绘。
3. ⏳ `bringToForeground` —— deep link / 通知点击把 WebView 前置；配合原生**每日通知**触发 §5.9 的唠嗑。
4. ⏳ 原生 `SpeechRecognizer` / TTS 可选替换 WebView 的 Web Speech，提升中文识别率（注意：前台服务已用原生 `SpeechRecognizer`，可与之统一）。

> **本机限制**：无 JDK / Android SDK，上述 Java 代码**未在本机编译验证**；需在装有工具链的机器上按 §9.3 构建（`./gradlew assembleDebug`）后装机测试权限申请与前台服务生命周期。

---

## 10. 建议的下一步

### 10.1 家属端 MVP（已接入）

本轮新增了一个不依赖第三方消息服务的安全闭环：

1. `POST /auth/register` 创建最小长者或家属账号；长者账号只保存设备假名，家属账号不要求真实姓名或手机号。
2. 长者端通过 `POST /auth/pairing-code` 生成 10 分钟有效的 6 位配对码；家属端通过 `POST /auth/pair` 兑换并建立授权关系。
3. 业务接口必须携带已签名的会话：Web 端使用 `POST /auth/register` 下发的 HttpOnly `aura_session` Cookie（`GET /auth/me` 可复用已有会话），原生/CLI 客户端可用 `Authorization: Bearer <token>`。`X-Device-Id` 只用于把当前请求映射到已授权的设备，不能单独读写数据。
4. 家属端位于 `/caregiver`，通过 `GET /caregiver/overview` 查看健康卡、风险/活动趋势、SOS/跌倒告警，并可确认 SOS。
5. SOS 会写入 `notification_outbox`，形成可重试的投递意图并展示在家属面板。当前没有伪装成已发送的短信、电话或 IM；生产环境应由 provider worker 消费该 outbox。

6. 配对凭据由 SQLite 事务存储：只保存 HMAC 哈希，成功后原子消费。家属账号累计失败 10 次锁定 15 分钟，之后每个 10 次失败窗口依次锁定 30、60 分钟；达到 40 次后停止数字配对，必须走人工/二维码备用流程。错误消息不区分“码不存在”还是“码错误”。
7. Web 会话使用 HttpOnly、SameSite Cookie；前端不再把会话凭据写入 `localStorage`。生产环境必须设置 `AURA_COOKIE_SECURE=true` 并使用 HTTPS。

### 10.2 部署安全清单

- 必须设置至少 32 字节随机的 `AURA_AUTH_SECRET`；未设置时后端拒绝启动，不存在可伪造的默认密钥。
- 生产环境必须设置 `AURA_ENV=production`、`AURA_COOKIE_SECURE=true` 和明确的 `AURA_CORS_ORIGINS`；禁止通配符 CORS。
- 授权、账号、配对码和失败锁定状态使用 `auth.sqlite3` 的事务/WAL 存储；部署多 worker 时将该数据库放在可靠的本地持久卷，并按 SQLite 并发/备份策略运维，规模扩大后迁移 PostgreSQL。
- 长者注册必须提供设备绑定头；缺失设备绑定不会进入共享匿名数据桶。
- 达到 40 次配对失败后，产品必须引导重新生成二维码或人工协助，不得继续重试数字码。

1. 在装有 JDK 17 + Android SDK 的机器上跑 §9.3，产出可安装 APK。
2. 装机验证 §9.4 的后台唤醒前台服务（权限申请、锁屏唤醒→前置），再补齐剩余的 `updateHomeWidget`/`bringToForeground`。
3. 接入 `Wake Lock` / `Fullscreen`，尽量延长前台守护时长。
4. 用 Silero（`onnxruntime-web`）替换能量 VAD，契约不变。
5. 用 `pixi-live2d-display` 替换 Canvas 数字人，仅需 `state`/`level` 两个 prop。
6. 后端按 §8（尤其 `/agent/cards`、`/medication/plan`）实现接口后，前端仅改 `api.ts` 函数体。

---

_文档随代码演进；`.trae/ponytail.md` 为约束来源，`web/src/lib/api.ts` 为后端唯一契约入口。_