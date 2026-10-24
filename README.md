# AuraGBA（湾区灵犀）

> 零 UI、语音驱动的长者关怀 **Agent 化手机端软件** · 粤港澳大湾区（香港 / 澳门 / 横琴）
> 纯软件方案，不依赖自研硬件。同一份代码同时产出 **网页 PWA** 与 **Android 原生安装包**（Capacitor 壳）。

---

## 这是什么

一个装进长者现有手机即可运行的语音助手：核心交互是一张自绘数字人面孔 + 粤语／普通话语音 + 震动反馈。App 平时**休眠**，只做监听与关键埋点；长者喊一声「灵犀」即唤醒并开始交互。

最底层是 **Agent**：长者的话被解析成意图，Agent 决定在「桌面」（主界面卡片流）上生成什么卡片 —— 任务清单（含吃药）、天气、拍照结果等。一张卡片二选一：前端按结构化数据渲染，或由后端 Agent 下发 HTML 渲染。

**所有敏感音频／传感器原始数据不出端**，只上传本地算好的派生特征与粗粒度埋点。

一句话定位（研究内核）：

> 在数月—数年的时间尺度上，以纯软件方式持续追踪长者行为基线，检测**个体内**的行为漂移，作为 MCI / 早期 AD 的数字预警。

---

## 目前已实现

| 能力 | 现状 |
|---|---|
| 语音入口 | 前台唤醒词、主动问候、每日签到、回到前台续聊；Android 壳内已实现后台唤醒前台服务 |
| 用药与复诊 | 吃药提醒 + 10/30 分钟升级；复诊提醒表单（`kind: followup`）；升级事件写入家属 outbox |
| 记忆辅助 | 「记住…」保存到本机 IndexedDB；「我记低咗咩」读回最近一条；**笔记不上传** |
| 健康与安全 | 1 分钟语音筛查（仅上报派生特征）、前台跌倒检测、SOS 三态（发送中/已记录/失败）+ 急救拨号兜底 |
| 健康卡与家属端 | 后端健康卡 + 二维码；家属配对、风险/活动趋势、筛查次数、SOS 确认、通知记录 |
| Agent 卡片 | 后端 Agent 可选（OpenAI-compatible）；未配置时回退本地卡片工厂 / 原话成待办卡；天气走 Open-Meteo 实时数据 |

---

## 仓库结构

| 目录 | 内容 |
|---|---|
| `web/` | 前端工程（Next.js 14 App Router + React 18 + TS strict + Tailwind），静态导出到 `out/`，同时作为 Android 壳的 `webDir` |
| `backend/` | 后端服务（Python / FastAPI）：MCI/AD 多模态筛查引擎、隐私管线、个人基线、审计与经济学模块 |
| `docs/RESEARCH-ROADMAP.md` | 研究路线图：必读论文、数据集、纵向检测方法论 |
| `docs/dev.md` | 三部分开发文档（A/B/C 分工、文件级改动点、契约、验收与自检） |
| `backend/README.md` | 后端专属说明（快速开始、模型产物共享流程、环境变量、目录结构） |

---

## 快速开始

### 前端

```bash
cd web
npm install
npm run dev         # 开发
npm run typecheck   # tsc --noEmit（strict）
npm run selfcheck   # 纯函数断言自检 → selfcheck: OK
npm run build       # 静态导出到 out/
npm run start       # 用静态服务器托管 out/
```

### 后端

```bash
cd backend
python -m pip install -r requirements.txt
cp .env.example .env          # 校准值已写好，建议带上 --env-file 启动
uvicorn auragba.main:app --env-file .env --reload --port 8000
python selfcheck.py           # 纯断言自检 → selfcheck: OK
```

> `uvicorn` 与 `selfcheck.py` 都要求环境里有 `AURA_AUTH_SECRET`（≥32 字节，`.env.example` 已带本地开发值）。`uvicorn` 用 `--env-file .env` 读取；直接跑 `selfcheck.py` 前请先把该变量导出到当前 shell。CORS 不接受 `*`，需写明确的来源列表。
>
> LLM 编排默认关闭（`AURA_LLM_ENABLED=false`），三个 LLM 端点保持 501 → 前端本地兜底。需要真实 Agent 时配置 `AURA_LLM_BASE_URL` / `AURA_LLM_API_KEY` / `AURA_LLM_MODEL`；天气使用 Open-Meteo，无需 Key。

- 交互式文档：`http://localhost:8000/docs`
- 前端通过 `NEXT_PUBLIC_API_BASE`（默认 `http://localhost:8000`）指向后端。首次加载会通过 `POST /auth/register` 建立 HttpOnly 会话；之后请求自动携带该 Cookie 与假名 `X-Device-Id` 头（原生/CLI 客户端可改用 `Authorization: Bearer`）。

### Android 壳（需 JDK 17 + Android SDK）

```bash
cd web
npm run cap:sync     # next build && cap sync android
npm run android      # cap open android（Android Studio 构建 APK）
# 或命令行：cd android && ./gradlew assembleDebug
```

> 真机验证需 **HTTPS 或 localhost**（麦克风、摄像头、`DeviceMotionEvent`、Web NFC 均要求安全上下文）。

---

## 架构要点

```
长者语音 → STT → parseIntent() → Agent 卡片 → 卡片流
                                  ↓(后端不可用)
                              本地卡片工厂 / 原话成待办卡（离线兜底）
```

- **纯函数层**：`signal.ts` / `intent.ts` / `cards.ts` / `notes.ts` / `datetime.ts` / `native.ts` / `checkin.ts` —— 不触碰 `window`，可被 node 直接断言。
- **浏览器胶水层**：`audio.ts` / `vad.ts` / `motion.ts` / `nfc.ts` / `camera.ts`。
- **后端唯一入口**：`web/src/lib/api.ts`（10 个契约函数全部接线；3 个 LLM 端点默认关闭，未配置/失败时返回 501/503 → 前端自动兜底）。
- **原生接缝**：`lib/native.ts` + Capacitor `AuraNative` 插件（后台唤醒已实现；桌面小组件、自动前置仍为桩）。

### 后端四大理念的落地位置

| 理念 | 位置 |
|---|---|
| 非侵入式双模态生物标志物 | `audio/features.py` + `nlp/` |
| 隐私管线（提取即焚 / vector-only / PII 擦除） | `privacy.py` |
| 个人基线动态追踪（14 天 Z-score） | `baseline.py` |
| STEMB 经济学 + SaMD 审计 | `economics.py` + `audit.py` |

---

## 隐私与合规

- 原始音频 / 原始传感器流**不得出端**；只上传 VAD 裁剪后的派生特征与粗粒度、无自由文本的埋点。
- 随手记（`notes` store）与提醒数据**只保存在本机 IndexedDB**，不上传后端；埋点只记录粗粒度计数。
- 仅使用假名 `DeviceId`，禁用 IDFA / AAID / IMEI / MAC。
- LLM 端点默认关闭；启用时只发送 PII 擦除后的最近对话文本，不发送音频、设备标识或健康卡。使用第三方模型前需完成数据出境与同意评估。
- Web 会话使用 HttpOnly `aura_session` Cookie；原生/CLI 可用 `Authorization: Bearer`。身份校验通过后才解析 `X-Device-Id`。
- 埋点缓冲在本地 IndexedDB，批量上报；上报失败保留缓冲，不丢。
- 对齐 HK PDPO、澳门个人数据保护法（PDPA）、PIPL。

---

## 已知天花板（诚实说明）

| 能力 | 网页 PWA | 需要什么 |
|---|---|---|
| 前台唤醒词 | ✅ | 一次手势授权麦克风 |
| 后台 / 锁屏唤醒词 | ⚠️ 浏览器会挂起 JS | ✅ 原生前台服务已实现（`WakeListenService`） |
| 自动跳到前台 | ❌ 网页禁止自我前置 | 原生 deep link / 通知 |
| 系统桌面小组件 | ❌ 网页不能写系统桌面 | 原生 AppWidget |
| 后台 / 息屏传感器采样 | ⚠️ 锁屏即停采 | 原生壳 / BLE 穿戴 |
| 准时提醒（吃药 / 复诊） | ⚠️ App 关闭时不会到点弹窗；下次打开补提醒 | 原生定时通知 |
| 震动、Web NFC | ⚠️ 仅 Android Chrome | 原生 |

所有「有已知天花板的简化」在源码中以 `ponytail:` 注释标注（共 15 处），每处都写明天花板与升级路径。

---

## 模型产物（协作必读）

`backend/models/`、`backend/data/`、`backend/.env` **都不入库**（`.gitignore` 已排除）。克隆后本地为空，需要通过 zip 传递产物 —— 流程见 [backend/README.md](backend/README.md#模型产物共享协作必读)。

模型效力边界：双流融合 AUC ≈ 0.72，属**弱信号、单一数据集、非临床验证**。对外只讲 AUC 与敏感度，不讲 F1。

> **非诊断设备。** 输出仅用于演示、评估与人工复核，不做任何自动化临床决策。

---

## 后续方向

1. 为 LLM 端点配置生产模型与数据出境同意（代码已实现，默认关闭；未配置时 501 回退本地卡片）。
2. 为 `notification_outbox` 接入真实推送 / 短信 / 语音外呼 provider（目前仅记录投递意图）。
3. 在装有 JDK 17 + Android SDK 的机器上产出并装机验证 APK。
4. 补齐 `updateHomeWidget` / `bringToForeground` 两个原生桩，并加原生定时通知。
5. 用 Silero（`onnxruntime-web`）替换能量 VAD，契约 `{speech, ratio}` 不变。
6. 用 `pixi-live2d-display` 替换 Canvas 数字人，仅需 `state` / `level` 两个 prop。
7. 纵向检测：个体基线升级、CPD、行为变异性轨迹（见 `docs/RESEARCH-ROADMAP.md`）。

---

_文档随代码演进。`docs/dev.md` 记录「已交付什么、怎么分工」，`docs/RESEARCH-ROADMAP.md` 记录「下一步往哪走、依据是什么」。_
