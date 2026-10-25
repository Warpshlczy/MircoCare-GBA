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
// 2. **字幕装不下**。A 的 `.caption` 是 48px / `-webkit-line-clamp: 2`；375px 屏
//    宽下每行 6–7 个汉字 → 满打满算 13–14 字。任何超过 14 字的朗读行，长者
//    "听到的"和"看到的"不是同一句话；而且 clamp 会补省略号，**看起来像说完了**。
//    文案侧能做的是：一句不超一个呼吸，把字号/行数问题留给 A（issue #1 §2.2）。
//    也就是说，本文件不解决截断，它只保证我们不再**亲手**制造一条注定被截的句子。
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

// ---------------------------------------------------------------------------
// Segmentation for playback (issue #6 · T2)
//
// `speak()` used to synthesize the whole line in one go. A 24-character line is
// 5–6 seconds of continuous audio; by the time the senior hears the end, the
// beginning is gone. Splitting at punctuation gives the engine (and the ear) a
// breath, WITHOUT changing a single character of the content — `join("")` is
// the original text. This is a playback concern, not a content one: the caption
// still shows the whole line once.
// ---------------------------------------------------------------------------

/** Silence between two synthesized segments (ms). */
export const SEGMENT_GAP_MS = 250;
/** One segment ≈ one caption line, so a segment can be heard in one breath. */
export const SEGMENT_MAX = 14;
/** More than this and it sounds like a shopping list, not speech. */
export const MAX_SEGMENTS = 5;

const SOFT_BREAK = "，、：,:, ";

/** Split one over-long sentence at a soft break, or evenly when it has none. */
function softSplit(sentence: string, max: number): string[] {
  const chars = [...sentence];
  if (chars.length <= max) return [sentence];
  let cut = -1;
  for (let i = Math.min(max, chars.length - 1); i >= Math.ceil(max / 3); i -= 1) {
    if (SOFT_BREAK.includes(chars[i])) {
      cut = i;
      break;
    }
  }
  if (cut === -1) {
    // No usable pause: even slices. (14/14/3 leaves a 3-character stump that
    // sounds like the engine stalled; 11/11/11 does not.)
    const parts = Math.ceil(chars.length / max);
    const size = Math.ceil(chars.length / parts);
    const out: string[] = [];
    for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
    return out;
  }
  return [chars.slice(0, cut + 1).join(""), ...softSplit(chars.slice(cut + 1).join(""), max)];
}

/**
 * A line → the segments to synthesize, in order. PURE.
 *
 * Invariant: `segments.join("")` equals the input ignoring whitespace. Missing a
 * character is missing a fact for someone who cannot read the caption.
 */
export function spokenSegments(text: string): string[] {
  const pieces: string[] = [];
  for (const sentence of splitSentences(text)) pieces.push(...softSplit(sentence, SEGMENT_MAX));

  // A fragment of nothing but punctuation makes the engine silent for 250 ms.
  const merged: string[] = [];
  for (const piece of pieces) {
    const meaningful = piece.replace(/[。！？!?；;，、：:,\s]/g, "");
    if (!meaningful && merged.length > 0) merged[merged.length - 1] += piece;
    else if (meaningful || merged.length === 0) merged.push(piece);
  }

  if (merged.length <= MAX_SEGMENTS) return merged;
  const head = merged.slice(0, MAX_SEGMENTS - 1);
  head.push(merged.slice(MAX_SEGMENTS - 1).join(""));
  return head;
}
