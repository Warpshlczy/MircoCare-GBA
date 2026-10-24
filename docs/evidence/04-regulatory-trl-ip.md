# 04 · 监管路径 · TRL · IP · 许可证

> 忆伴 MemoMate · 答辩 Step 4。内容以 `docs/dev.md` 附录 C 为准；「现状」只写代码里真实存在的控制项。

---

## 1. 监管路径（按风险分类，不承诺「一定是最低类」）

| 市场 | 路径 | 本项目预期分类 | 关键动作 | 时限 |
|---|---|---|---|---|
| 香港 | MDACS（MDD 自愿表列） | Class II（若仅「辅助观察」，可论证非 IVD） | 技术文件 + 质量体系 + 本地负责人 | 约 12 周 |
| 澳门 | 第 12/2025 号法律 / ISAF | I 或 IIa（依赖声称） | 备案 + 技术文档 | I/IIa 5 工作日（形式审查）；IIb 70；III 100；有效期 5 年 |
| 欧盟 | MDR 2017/745，SaMD 按 Rule 11 | 通常 **IIa**（临床决策支持信息）；声称「预测/预警疾病」可升 IIb | 公告机构 + ISO 13485 + 临床评价（Annex XIV）+ EUDAMED | NB 审查 6–12 个月 |
| 美国 | FDA 510(k)（21 CFR 892.2080 / 892.2050 邻近参照） | Class II | predicate + 实质等同 + IEC 62304 软件文档 + 可用性证据 | 法定 90 天（实际常 3–6 个月） |

### 分类口径三条硬规则

1. **默认声称是「辅助观察与随访提示」，不写「诊断阿尔兹海默症」**。一旦市场材料出现「诊断 / diagnose」，香港按 Class II→III 论证、欧盟按 Rule 11 升类、美国需 De Novo 或 PMA，成本差一个数量级。
2. 报告用「一切如常 / 值得留意 / 建议检查」，附固定免责句；产品永不输出疾病名称。**已实现**：`ScreeningResult.notForDiagnosis = true`；周报 `DIAGNOSTIC_WORDS` 词表自检（阿尔兹海默/痴呆/患病/确诊等零命中）。
3. **降级声称配置**：`AURA_REGULATORY_CLAIM_LEVEL ∈ {observation, triage_support}`，默认 `observation`；报告免责句由该开关决定。`diagnostic` **被配置校验拒绝**（本版本无监管 clearance，且产品永不输出疾病名称）。**现状：已实现配置 + 报告分支；阈值档位未分档**（沿用校准阈值 0.409/0.521）。

### 路径排序（资源有限时的真实选择）

| 阶段 | 动作 | 理由 |
|---|---|---|
| 0（现在） | 香港 MDACS 表列准备 + 澳门 I/IIa 备案材料 | 香港有采购通道；澳门 5 工作日备案最快拿到「已注册」事实 |
| 1（6–9 个月） | CE MDR IIa（走 NB） | 出海葡语市场时 CE 是最被认可的背书 |
| 2（12 个月+） | FDA 510(k) | 只有在有美国合作方/资金时才做，否则 ROI 最低 |

---

## 2. TRL 1–9 自评（按组件分列）

| TRL | 定义 | 对应组件 | 现状 | 到下一级的 gap |
|---|---|---|---|---|
| 1 | 基本原理 | 语音/语言/行为三流可筛查认知衰退 | ✅ 文献 + 本地实验 | — |
| 2 | 技术概念形成 | PICO 与临床终点 | ✅ `01-pico.md` | 临床顾问签署 |
| 3 | 概念验证（实验室） | 声学 LightGBM / 语义 LR / 行为规则 | ✅ 322 人，融合 AUC 0.717 | 真 WAV 端到端复现 |
| 4 | 实验室环境验证 | 端侧采集 → 后端分析完整链路 | 🟡 合成音频跑通；真机长时采集未验证 | 真机 2 周数据 |
| 5 | 相关环境验证 | 长者真实居家使用（10–20 人） | ❌ | 伦理批件 + 招募 |
| 6 | 相关环境示范 | 香港 1 家长者中心 / 澳门 1 家院舍 | ❌ | 机构 MOU |
| 7 | 运行环境原型示范 | 50–100 人、8 周、含家属报告 | ❌ | 前瞻队列 |
| 8 | 系统完成并鉴定 | ISO 13485 + IEC 62304 + 临床评价 | ❌ | NB 审核 |
| 9 | 实际运行 | 注册后商业部署 | ❌ | 注册证 + 支付方 |

**整体诚实结论**：核心算法 **TRL 3–4**，端侧应用 **TRL 4**，系统级 **TRL 3**。答辩直接放这张表，比自称 TRL 7 可信。

---

## 3. IP 策略（三分类）

| 类别 | 内容 | 处理方式 | 理由 |
|---|---|---|---|
| **可专利（拟申请）** | ①「多流异构信号的时间对齐 + 个人基线漂移校正」方法（三流同一时间窗归一 + 滚动基线 Z）；②「主动访谈调度器」（按沉默天数、应答时长、当日交互次数决定是否发起，含静默时段约束）；③「端侧只上传派生特征 + 盐化假名的两级隐私管线」 | 先做临时申请（provisional），1 年内转正式；优先香港 + PCT | ②③ 是「系统方法」而非纯软件，可专利性更强；① 需先做 FTO 检索 |
| **商业秘密（不申请）** | 融合权重、阈值（0.409/0.521）、特征工程细节、FMEA 风险表、访谈题库措辞与顺序 | 代码私有 + `docs/evidence/` 不进公开仓库；核心常数放后端，不下发端侧 | 公开即失去保护，且最易被抄袭 |
| **开源合规（可用不可占）** | 依赖库本身；参考仓库的**思路**（无障碍 UI 驱动、逐步反馈闭环） | 只借鉴架构思想，不复制代码；复用必须核对 LICENSE | 避免 license 污染与学术不端 |

**FTO 风险提示**：语音认知筛查领域已有专利族（如 Winterlight、Neurotrack 相关）；正式商业化前必须做一次 FTO 检索。差异化点应落在「主动访谈 + 行为流 + 跨境部署」，而不是「语音测认知」本身。

---

## 4. 许可证表

| 依赖 / 资源 | 许可证 | 对闭源商业化的影响 | 行动 |
|---|---|---|---|
| `pixi.js` | MIT | 无 | 保留版权声明 |
| `pixi-live2d-display` | MIT | 无（库本身） | 保留版权声明 |
| **Live2D Cubism 模型（官方 sample）** | Live2D Proprietary / Free Material License | **不可直接商用**；sample 仅限演示 | 演示可用；商用必须自建或购买授权，答辩注明「演示用 sample 模型」 |
| Cubism SDK / Cubism Core | Live2D Proprietary | 有营收门槛与发行条款 | 上线前替换为已授权版本 |
| `@ricky0123/vad-web`（Silero VAD） | MIT（模型 MIT） | 无 | 可直接用 |
| Picovoice Porcupine（若替换唤醒词） | 商用许可（免费额度有限） | 有 | 现阶段继续用 `SpeechRecognizer`，不引入 |
| Next.js / React | MIT | 无 | — |
| Capacitor | MIT | 无 | — |
| FastAPI / LightGBM / scikit-learn / Whisper | MIT / MIT / BSD-3 / MIT | 无 | Whisper 权重另看 model card |
| `cryptography`（AES-GCM） | Apache-2.0 / BSD-3 | 无 | 见 `THIRD_PARTY_NOTICES` |
| 参考仓库 `Core-Mate/OpenGUI`、`orailnoor/private-agent` | 按其仓库 LICENSE 核对 | 仅作架构参考 | **不复制代码**，文档注明来源 |

---

## 5. 与代码的对应（审计时可直接演示）

| 监管要求 | 代码位置 | 现场证明 |
|---|---|---|
| 非诊断声称 | `ScreeningResult.notForDiagnosis` | `GET /screening/analyze` 返回体 |
| 报告禁用诊断词 | `reports/weekly.py#DIAGNOSTIC_WORDS` | `python selfcheck.py` |
| 不荐药 / 不建议剂量 | `llm/safety.py` + `/medication/plan` 只抄不推断 | 对抗用例 |
| 急救短路 | `llm/turn.py` → 强制 `sos` | selfcheck |
| 审计可追溯 | `audit.py` hash 链 + 模型指纹 | `GET /audit/screening` → `integrityOk` |
| 数据最小化 | `privacy.py` extract-and-burn / vector-only | `audioDiscarded: true` |
| 会话撤回 | `DELETE /conversation/turns/{id}` | 204 + 审计 `conversation_revoke` |

**已实现**：`AURA_REGULATORY_CLAIM_LEVEL` 配置 + 报告免责句分支（`diagnostic` 被拒绝）、`anonymity.py#assert_k_anonymity` / `merge_small_bands`。
**尚未实现**：阈值档位随声称切换（仍用校准 0.409/0.521）、ISO 13485/IEC 62304 文档、正式临床评价；答辩不得声称已具备。
