"""Linguistic / semantic biomarkers from the speech transcript.

Computes, per connected-speech sample:
  * lexical richness   — Type-Token Ratio (TTR) and moving-average TTR
  * noun-to-verb ratio  — via jieba POS when available, else a lexicon heuristic
  * sentence-length mean/variance
  * filler ratio, mean utterance length

`ponytail:` the fallback tokenizer splits CJK into single characters and the
fallback POS counts a small closed lexicon — coarse but deterministic and
dependency-free. Upgrade: `pip install jieba` (+ `jieba.posseg`) is picked up
automatically and gives real word segmentation + POS tags. Cite TTR ceiling: raw
TTR is length-dependent, so MATTR (windowed) is reported alongside it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

try:  # optional: real Chinese segmentation + POS
    import jieba  # type: ignore
    import jieba.posseg as _posseg  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    jieba = None
    _posseg = None

_LATIN = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?")
_CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")
_SENT_SPLIT = re.compile(r"[。！？!?；;\n\.]+")
# Chinese numerals count as tokens too.
_NUM = re.compile(r"\d+")

_FILLERS = ("嗯", "呃", "啊", "哦", "呀", "那个", "就是", "然后", "呢个", "咁", "即係", "嗰个")

# Compact closed-class lexicon for the no-jieba fallback (closed sets, not a model).
_VERB_LEXICON = frozenset(
    "是 有 去 来 说 看 听 吃 喝 睡 走 跑 做 想 要 会 能 给 拿 买 卖 打 开 关 坐 站 起 学 记 忘 知 叫 问 答 帮 找 等 回 到 出 入 洗 穿 用 玩 笑 哭 病 痛 累 休息 吃药 食藥 唔舒服 感觉 覺得 觉得 记得 提醒 帮手".split()
)
_NOUN_LEXICON = frozenset(
    "人 家 屋 房 门 窗 床 桌 椅 饭 菜 水 茶 药 藥 医生 醫院 医院 钱 车 路 街 市 天气 今日 听日 明日 昨天 早晨 夜晚 身体 身體 头 手 脚 眼 耳 口 心 血 病 朋友 仔 女 孙 孫 时间 時間".split()
)


@dataclass
class LinguisticMetrics:
    tokens: int = 0
    types: int = 0
    ttr: float = 0.0
    mattr: float = 0.0  # moving-average TTR (window 50), length-robust
    noun_count: int = 0
    verb_count: int = 0
    noun_to_verb_ratio: float = 0.0
    sentences: int = 0
    mean_sentence_len: float = 0.0
    sentence_len_variance: float = 0.0
    filler_ratio: float = 0.0
    mean_utterance_len: float = 0.0
    tokenizer: str = "regex"
    metrics: dict[str, float] = field(default_factory=dict)


def tokenize(text: str) -> tuple[list[str], str]:
    """-> (tokens, tokenizer_name). jieba when present, else regex fallback."""
    if not text:
        return [], "regex"
    if jieba is not None:
        return [w for w in jieba.lcut(text) if w.strip()], "jieba"
    tokens = _LATIN.findall(text) + _NUM.findall(text) + _CJK.findall(text)
    return tokens, "regex"


def _mattr(tokens: list[str], window: int = 50) -> float:
    if len(tokens) < window:
        return (len(set(tokens)) / len(tokens)) if tokens else 0.0
    ratios = [
        len(set(tokens[i : i + window])) / window for i in range(len(tokens) - window + 1)
    ]
    return float(sum(ratios) / len(ratios)) if ratios else 0.0


def _pos_counts(tokens: list[str]) -> tuple[int, int]:
    """-> (nouns, verbs). Real POS via jieba.posseg, else closed-lexicon counts."""
    if _posseg is not None:
        nouns = verbs = 0
        for word, flag in _posseg.cut("".join(tokens)):
            if flag.startswith("n"):
                nouns += 1
            elif flag.startswith("v"):
                verbs += 1
        return nouns, verbs
    nouns = sum(1 for t in tokens if t in _NOUN_LEXICON)
    verbs = sum(1 for t in tokens if t in _VERB_LEXICON)
    return nouns, verbs


def analyse_linguistics(text: str) -> LinguisticMetrics:
    """Compute the linguistic biomarker set for one transcript (never raises)."""
    text = (text or "").strip()
    tokens, tokenizer_name = tokenize(text)
    sentences = [s for s in (seg.strip() for seg in _SENT_SPLIT.split(text)) if s]
    sent_lens = [len(tokenize(s)[0]) for s in sentences]
    nouns, verbs = _pos_counts(tokens) if tokens else (0, 0)
    filler_hits = sum(text.count(f) for f in _FILLERS)

    n = len(tokens)
    ttr = (len(set(tokens)) / n) if n else 0.0
    mean_len = float(sum(sent_lens) / len(sent_lens)) if sent_lens else 0.0
    var_len = float(sum((x - mean_len) ** 2 for x in sent_lens) / len(sent_lens)) if sent_lens else 0.0

    metrics = {
        "tokens": float(n),
        "types": float(len(set(tokens))),
        "ttr": ttr,
        "mattr": _mattr(tokens),
        "noun_count": float(nouns),
        "verb_count": float(verbs),
        "noun_to_verb_ratio": (nouns / verbs) if verbs else float(nouns > 0),
        "sentences": float(len(sentences)),
        "mean_sentence_len": mean_len,
        "sentence_len_variance": var_len,
        "filler_ratio": (filler_hits / n) if n else 0.0,
        "mean_utterance_len": float(n / len(sentences)) if sentences else 0.0,
    }
    return LinguisticMetrics(
        tokens=n, types=len(set(tokens)), ttr=ttr, mattr=metrics["mattr"],
        noun_count=nouns, verb_count=verbs, noun_to_verb_ratio=metrics["noun_to_verb_ratio"],
        sentences=len(sentences), mean_sentence_len=mean_len, sentence_len_variance=var_len,
        filler_ratio=metrics["filler_ratio"], mean_utterance_len=metrics["mean_utterance_len"],
        tokenizer=tokenizer_name, metrics=metrics,
    )