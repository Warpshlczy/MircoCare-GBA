// speech.ts — 一句话原则：给认知退化长者的"语音预算"。
//
// 这一层只有一个职责：**让朗读短到能被听完**。它不改内容、不改语序，只回答
// 三个问题——这句多长？这句到哪结束？超了怎么办？
//
// ## 为什么"长度"必须是一个显式的、被断言的约束
//
// 1. **一次呼吸**。中文 TTS 约 4–5 字/秒，24 字 ≈ 5–6 秒。轻度认知障碍长者
//    丢的是句首：一段 10 秒的连续语音，听到句尾时前面已经掉了。这不是"听得累"，
//    是工作记忆装不下。所以 24 字是**提示语**的上限，不是平均目标。
//
// 2. **字幕装不下**。2026-10-25 之前 A 的 `.caption` 是 48px / 2 行，375px 屏宽
//    下满打满算只有 13–14 字；现已改为 4 行 / 38px（大字档 5 行 / 48px），
//    34 字的运行时上限可以完整显示。文案侧仍然保持"一句不超一个呼吸"，因为
//    装得下不等于听得完（理由见第 1 条）。
//
// 3. **一次讲一件事**。两个工具都成功时，只报第一件。计划里 `sos` 排第一
//    （`toolrun.ts` 的排序），所以"第一件"按构造就是最要紧的那件事；第二句
//    不是补充，是噪声，而且会把第一句挤到第 2 行以外。
//
// 4. **不重复长者自己的话**。`好，我記低咗：<长者说的整句>` 是最容易失控的一类
//    ——任务文本长度由长者决定，回读整句可以轻易超过一个呼吸。`clip()` 就是为此
//    存在的：回读是"我听到了什么"的确认，四个字足够，八个字封顶。
//
// ## 约定
// - `SPEECH_BUDGET`（24）是**测试断言线**：自己写的提示语不得超过它。
// - `SPEECH_HARD_LIMIT`（34）是**运行时兜底线**：模型返回的自由回答无法在编译期
//   约束，超过它就截到最近的句读。超过 34 字的朗读，长者已经在等它结束了。
// - 紧急文案允许两句（`我仲未接到屋企人。你打 999。`），但字数仍在预算内 ——
//   句数不是问题，**总长度**才是。

/** 一句提示语的上限，单位是"字"（非空白字符数）。 */
export const SPEECH_BUDGET = 24;

/** 运行时兜底：任何朗读超过这个长度就被截到最近句读。 */
export const SPEECH_HARD_LIMIT = 34;

/** 句读。"；"也算句尾 —— 分号两边已经是两件事了。 */
const SENTENCE_END = /[。！？!?；;\n]/;

/**
 * 一句话有多少"字"。
 *
 * 按非空白字符计：中文一字一音，数字/字母按字符算（"999" 念作三个音节附近，
 * 对我们这种精度足够）。空白不计 —— 它不出声。
 */
export function spokenLength(text: string): number {
  return [...(text ?? "")].filter((ch) => !/\s/.test(ch)).length;
}

/** 切句，保留句读符号。空句不返回。 */
export function splitSentences(text: string): string[] {
  const src = (text ?? "").trim();
  if (!src) return [];
  const out: string[] = [];
  let buf = "";
  for (const ch of src) {
    buf += ch;
    if (SENTENCE_END.test(ch)) {
      const t = buf.trim();
      if (t) out.push(t);
      buf = "";
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

/** 第一句。这是"只讲一件事"的默认取法。 */
export function firstSentence(text: string): string {
  const parts = splitSentences(text);
  return parts.length > 0 ? parts[0] : "";
}

/** 超预算了吗？返回该句本身（便于断言时打印），没超返回 null。 */
export function overBudget(text: string, budget = SPEECH_BUDGET): { text: string; length: number } | null {
  const length = spokenLength(text);
  return length > budget ? { text, length } : null;
}

/**
 * 截到 `max` 字以内，尽量落在句读上，并把句读换成省略号。
 *
 * 用于**回读长者自己的话**（任务文本、人名）：回读的作用是确认"我听到了哪件事"，
 * 不是复述。截断必须看得见（`…`），否则长者以为这就是全部。
 */
export function clip(text: string, max: number, ellipsis = "…"): string {
  const src = (text ?? "").trim();
  if (max <= 0) return "";
  const chars = [...src];
  if (chars.length <= max) return src;
  // 从句读处截：宁可短一点，也不要半个词。留 1 个位置给省略号。
  const head = chars.slice(0, max);
  // 从后往前找最后一个句读（不用 findLastIndex：tsconfig 的 lib 比它旧）
  let cut = -1;
  for (let i = head.length - 1; i >= 0; i -= 1) {
    if (SENTENCE_END.test(head[i]) || "，、, ".includes(head[i])) {
      cut = i;
      break;
    }
  }
  const kept = cut >= Math.ceil(max / 2) ? head.slice(0, cut + 1) : head;
  const out = kept.join("").replace(/[，、,；;。\s]+$/, "") + ellipsis;
  // 省略号本身也算一个字：兜底再压一次，保证 `spokenLength(out) <= max + 1`
  const oc = [...out];
  return oc.length > max + 1 ? oc.slice(0, max).join("") + ellipsis : out;
}

/**
 * 运行时兜底：把任意一段文本压成"一次能听完的一句"。
 *
 * - 先取第一句（一句之后的内容不进耳朵）；
 * - 仍超 `SPEECH_HARD_LIMIT` 就在最近的句读处截断。
 *
 * 只用于**模型生成**的文本。我们自己写的提示语必须在 `SPEECH_BUDGET` 内，
 * 由 selfcheck 断言，不靠这个函数兜。
 */
export function fitUtterance(text: string, hard = SPEECH_HARD_LIMIT): string {
  const one = firstSentence(text);
  if (spokenLength(one) <= hard) return one;
  // clip 允许省略号占一个字，所以留一格给它，保证返回长度 ≤ hard
  return clip(one, hard - 1);
}

// --------------------------------------------------------------------------- //
// 分句朗读：把一句长话切成几段，链式播放，段间留一个换气
// --------------------------------------------------------------------------- //
//
// 为什么要分：引擎把整句一次合成时，句内的逗号几乎不产生停顿（中文 TTS 的
// 韵律预测对书面标点很不敏感），长者听到的是一条没有换气的长音。分句后每段
// 之间插入 `SEGMENT_GAP_MS` 的静音，停顿就由我们控制，而不是求引擎。
//
// 顺带解决两件工程问题：①部分引擎对超长文本会静默截断（说一半就结束），
// 每段 ≤ `SEGMENT_MAX` 字可以规避；②字幕与语音按段对齐后，A 的 `.caption`
// 不必一次吞下一整段长文。
//
// 一条硬不变量：**分句不丢字、不重复**。`segments.join("")` 必须等于原文
// （忽略空白）。对不识字的长者，少读一个字就是少一件事。

/** 段间静音。约一次换气的一半，够听出"他分开了两句"，又不会让对话卡住。 */
export const SEGMENT_GAP_MS = 250;

/** 一段的目标上限。14 字 ≈ 3 秒，正好是字幕一行的容量。 */
export const SEGMENT_MAX = 14;

/**
 * 最多分几段。超过就把尾巴并入最后一段 —— 8 段独立朗读听起来像在念清单，
 * 而且每段之间的 250ms 会把一句话拖成 5 秒的等待。
 */
export const MAX_SEGMENTS = 5;

/** 可以在这些符号处切开（保留符号本身，它给引擎一个降调/停顿的提示）。 */
const SOFT_BREAK = "，、,：: ";

export interface SegmentOptions {
  maxSegment?: number;
  maxSegments?: number;
}

/** 把一段超长文本硬切成 ≤max 的几块，优先落在软停顿上。 */
function hardSplit(segment: string, max: number): string[] {
  if (spokenLength(segment) <= max) return [segment];

  const chars = [...segment];
  const limit = Math.min(max, chars.length);
  // 从 limit 往前找最近的软停顿，但不能退太多 —— 退过 1/3 就说明这句没有
  // 可用的停顿点，硬切比切出一个 3 字的碎片更自然。
  let cut = -1;
  for (let i = limit - 1; i >= Math.ceil(max / 3); i -= 1) {
    if (SOFT_BREAK.includes(chars[i])) {
      cut = i + 1; // 停顿符留在前一段末尾
      break;
    }
  }
  if (cut <= 0) {
    // 没有任何停顿点：均分，不要切出 "14/14/3" 那种尾巴 —— 最后 3 个字听起来
    // 像卡住了，而长者在等的正是"这句话什么时候说完"。
    const parts = Math.ceil(chars.length / max);
    cut = Math.ceil(chars.length / parts);
  }

  const head = chars.slice(0, cut).join("").trim();
  const tail = chars.slice(cut).join("").trim();
  if (!tail) return head ? [head] : [];
  return head ? [head, ...hardSplit(tail, max)] : hardSplit(tail, max);
}

/**
 * 一句话 → 链式朗读的若干段。
 *
 * 用法（A 的 `audio.ts` 补丁）：逐段 `speak`，每段 `onend` 之后再发下一段，
 * 段之间等 `SEGMENT_GAP_MS`。字幕仍然只显示**整句一次**——分段只喂给引擎。
 */
export function spokenSegments(text: string, opts: SegmentOptions = {}): string[] {
  const max = Math.max(4, Math.floor(opts.maxSegment ?? SEGMENT_MAX));
  const cap = Math.max(1, Math.floor(opts.maxSegments ?? MAX_SEGMENTS));

  const pieces: string[] = [];
  for (const sentence of splitSentences(text)) {
    for (const p of hardSplit(sentence, max)) {
      const trimmed = p.trim();
      if (trimmed) pieces.push(trimmed);
    }
  }

  // 只有标点的碎片（"。"、"，"）单独成段毫无意义：引擎不出声，却要等 250ms。
  // 挂回前一段，长度也会更接近一个呼吸。
  const merged: string[] = [];
  for (const p of pieces) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && /^[。！？!?；;，、,：:…]+$/.test(p)) {
      merged[merged.length - 1] = prev + p;
      continue;
    }
    merged.push(p);
  }

  if (merged.length <= cap) return merged;
  // 段数封顶：尾巴并进最后一段。宁可最后一句长一点，也不要念成清单。
  return [...merged.slice(0, cap - 1), merged.slice(cap - 1).join("")];
}
