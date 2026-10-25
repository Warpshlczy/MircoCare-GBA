/**
 * 风险分的**解释层**——把「敏感度 0.863」翻译成照顾员能正确理解的话。
 *
 * ## 为什么这么分层（后期不用返修的关键）
 *
 * 我们目前**没有外部验证数据**（见 D:/GBA-hackathon/DATA-RELIABILITY-AND-USABLE-RESULTS.md）：
 * 现有 sens/spec 来自内部交叉拟合，且与人口学混淆同量级，是**上界**；而 riskIndex
 * 经 Brier 检验**未校准**，不是概率。
 *
 * 因此这里刻意分成三层，只有第 2 层（数据表）会随数据变化，**代码与文案都不用改**：
 *
 *   1. 数学层（本文件上半部）：ppv / npv / lrPlus / wilson —— 解析式，永远不会错、
 *      永远不需要因新数据重写；由 selfcheck 用解析性质断言。
 *   2. 数据层（`OPERATING_POINTS`）：带 provenance 的版本化条目。将来拿到外部验证，
 *      **只新增一条并改 `DEFAULT_OPERATING_POINT` 指向它**，其余代码零改动。
 *      字段里保留 `confounded` / `upperBound` 标记，避免后人误当成熟数据使用。
 *   3. 文案层（本文件下半部）：
 *      - **定性语句不含任何数字** → 任何新数据都推翻不了它，这是"永不返修"的那一层；
 *      - 只有显式配置了目标人群患病率（`prevalence`）才输出数字，且输出的是
 *        **区间**（由 sens/spec 的 Wilson 置信区间传播），不是点估计。
 *
 * ## 使用约定
 * - 不传 `prevalence` → 只出定性提示（出厂默认，最稳）。
 * - 传了 `prevalence` → 额外出一行"约 N 个提示中约有 1 个需要进一步评估"。
 * - 任何情况下都**不得**把 riskIndex 表述为概率（Brier 已证伪）。
 */

import type { Locale } from "./types";

// ---------------------------------------------------------------- 1. 数学层

/** 阳性预测值：PPV = sens·π / (sens·π + (1−spec)·(1−π)) */
export function ppv(sens: number, spec: number, prevalence: number): number {
  const tp = sens * prevalence;
  const fp = (1 - spec) * (1 - prevalence);
  return tp + fp > 0 ? tp / (tp + fp) : 0;
}

/** 阴性预测值 */
export function npv(sens: number, spec: number, prevalence: number): number {
  const fn = (1 - sens) * prevalence;
  const tn = spec * (1 - prevalence);
  return tn + fn > 0 ? tn / (tn + fn) : 0;
}

/** 阳性似然比：与患病率无关，换人群也不变，是最稳的可迁移指标 */
export function lrPlus(sens: number, spec: number): number {
  const fp = 1 - spec;
  return fp > 0 ? sens / fp : Infinity;
}

/** 需要提示多少人才遇到 1 例真阳性（1/PPV），比百分比更好懂 */
export function numberNeededToFlag(sens: number, spec: number, prevalence: number): number {
  const p = ppv(sens, spec, prevalence);
  return p > 0 ? 1 / p : Infinity;
}

/** Wilson 比例置信区间——小样本下比正态近似稳 */
export function wilsonInterval(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - half) / denom), Math.min(1, (centre + half) / denom)];
}

/** PPV 的区间：把 sens/spec 各自的 Wilson 区间传播到 PPV（取最不利/最有利组合） */
export function ppvBand(
  sens: number, nPos: number,
  spec: number, nNeg: number,
  prevalence: number,
): { lo: number; point: number; hi: number } {
  const [sLo, sHi] = wilsonInterval(Math.round(sens * nPos), nPos);
  const [pLo, pHi] = wilsonInterval(Math.round(spec * nNeg), nNeg);
  const point = ppv(sens, spec, prevalence);
  const lo = ppv(sLo, pHi, prevalence); // 最不利：敏感度取下限、特异度取上限(=假阳最少)
  const hi = ppv(sHi, pLo, prevalence);
  return { lo: Math.min(lo, point), point, hi: Math.max(hi, point) };
}

// ---------------------------------------------------------------- 2. 数据层

export interface OperatingPoint {
  id: string;
  /** 这条 operating point 是怎么来的 —— 写给人看，也写给半年后的自己看 */
  source: string;
  /** none | internal-cv | external-validation —— 只有 external 才可用于对外效度声明 */
  provenance: "none" | "internal-cv" | "external-validation";
  /** 是否与人口学混淆同量级（我们的第一版：是） */
  confounded: boolean;
  /** 数值是否应视为上界 */
  upperBound: boolean;
  sens: number;
  spec: number;
  nPos: number;
  nNeg: number;
  threshold: number;
  capturedAt: string;
}

export const OPERATING_POINTS: Record<string, OperatingPoint> = {
  // 2026-10-25：内部 5 折交叉拟合（声学+人口学），见 results/ppv_calibration.json
  // ⚠️ 与人口学混淆同量级（匹配子集 AUC 0.639 vs 人口学单变量 0.647），是上界。
  "internal-oof-2026-10-25": {
    id: "internal-oof-2026-10-25",
    source: "内部交叉拟合（中文 AD 语音数据集，声学+人口学，5 折 OOF）",
    provenance: "internal-cv",
    confounded: true,
    upperBound: true,
    sens: 0.877,
    spec: 0.297,
    nPos: 212,
    nNeg: 111,
    threshold: 0.409,
    capturedAt: "2026-10-25",
  },
};

export const DEFAULT_OPERATING_POINT = "internal-oof-2026-10-25";

// ---------------------------------------------------------------- 3. 文案层

const COPY: Record<Locale, {
  qualitative: string;
  withPpv: (n: number, prevalencePct: number) => string;
  lrNote: (lr: number) => string;
}> = {
  "zh-CN": {
    // 不含任何数字 —— 任何新数据都推翻不了
    qualitative:
      "这是风险趋势提示，不是诊断。多数提示并不代表已经出现认知问题，需要专业人员评估才能确定。",
    withPpv: (n, p) =>
      `按当前数据估计：在患病率约 ${p}% 的人群中，大约每 ${n} 个提示里有 1 个最终被确认；其余需要进一步观察。这是偏乐观的估计，尚未经外部验证。`,
    lrNote: (lr) => `阳性提示把风险提高了约 ${lr.toFixed(1)} 倍（与人群患病率无关）。`,
  },
  "zh-HK": {
    qualitative:
      "呢個係風險趨勢提示，唔係診斷。多數提示唔代表已經有認知問題，要專業人員評估先可以確定。",
    withPpv: (n, p) =>
      `按現有數據估計：喺患病率約 ${p}% 嘅人群入面，大約每 ${n} 個提示有 1 個最後被確認；其餘要繼續觀察。呢個係偏樂觀嘅估計，仲未做外部驗證。`,
    lrNote: (lr) => `陽性提示將風險提高咗約 ${lr.toFixed(1)} 倍（同人群患病率無關）。`,
  },
  "zh-MO": {
    qualitative:
      "呢個係風險趨勢提示，唔係診斷。多數提示唔代表已經有認知問題，要專業人員評估先可以確定。",
    withPpv: (n, p) =>
      `按現有數據估計：喺患病率約 ${p}% 嘅人群入面，大約每 ${n} 個提示有 1 個最後被確認；其餘要繼續觀察。呢個係偏樂觀嘅估計，仲未做外部驗證。`,
    lrNote: (lr) => `陽性提示將風險提高咗約 ${lr.toFixed(1)} 倍（同人群患病率無關）。`,
  },
};

export interface RiskExplain {
  /** 定性提示——永远安全、永远不需要改 */
  qualitative: string;
  /** 带数字的说明；未配置 prevalence 时为 undefined */
  detail?: string;
  /** 是否输出了数字（供 UI 决定是否显示"未经外部验证"角标） */
  hasNumbers: boolean;
  /** 该数字是否只是上界 */
  upperBound: boolean;
}

/**
 * 生成照顾员可读的风险解释。
 *
 * @param prevalence 目标人群患病率（0–1）。**不传就只出定性文案** —— 这是出厂默认，
 *   保证在任何数据状态下都不会显示一个会被后续推翻的数字。
 */
export function explainRisk(
  locale: Locale,
  opts: { prevalence?: number; pointId?: string; showLr?: boolean } = {},
): RiskExplain {
  const dict = COPY[locale] ?? COPY["zh-CN"];
  const point = OPERATING_POINTS[opts.pointId ?? DEFAULT_OPERATING_POINT];
  if (!point) {
    return { qualitative: dict.qualitative, hasNumbers: false, upperBound: true };
  }

  if (opts.prevalence === undefined || !(opts.prevalence > 0 && opts.prevalence < 1)) {
    return { qualitative: dict.qualitative, hasNumbers: false, upperBound: point.upperBound };
  }

  const band = ppvBand(point.sens, point.nPos, point.spec, point.nNeg, opts.prevalence);
  // 用区间上界取"最少需要提示多少人"，即用更保守的 PPV(hi)？不：PPV 越高，N 越小。
  // 保守 = 用较低的 PPV(lo) 算更大的 N，避免夸大准确性。
  const nConservative = Math.max(1, Math.round(1 / Math.max(band.lo, 1e-6)));
  const pct = Math.round(opts.prevalence * 100);

  const parts = [dict.withPpv(nConservative, pct)];
  if (opts.showLr) parts.push(dict.lrNote(lrPlus(point.sens, point.spec)));

  return {
    qualitative: dict.qualitative,
    detail: parts.join(" "),
    hasNumbers: true,
    upperBound: point.upperBound,
  };
}
