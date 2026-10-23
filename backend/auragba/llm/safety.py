"""Safety gates shared by all LLM routes.

Rules:
* Emergency language short-circuits the model entirely and points to SOS.
* Outputs must not contain diagnosis / prescribing advice.
* Medication names are only accepted when they appear in the input text.
* Chat replies are length-capped and filtered before they reach TTS.
"""

from __future__ import annotations

import re

from ..contract import AgentCard, CardAction, CardData

# Cantonese / Mandarin / English emergency markers. Deliberately conservative:
# a false positive only shows the SOS card, which is safe.
_EMERGENCY = (
    "胸痛", "心口痛", "透唔到氣", "透唔到气", "呼吸困難", "呼吸困难", "抖唔到氣",
    "半邊身無力", "半边身无力", "半身不遂", "講唔到話", "讲不到话", "口齒不清",
    "暈低", "晕倒", "意識不清", "意识不清", "昏迷", "流血不止", "起唔到身",
    "跌倒", "跌低", "跌親", "仆低", "仆親", "仆亲", "摔親", "摔亲", "起不了身",
    "跌親起唔到", "跌倒起不来", "自殺", "自杀", "想死", "中風", "中风",
    "stroke", "fall down", "fell down", "fallen", "can't breathe", "chest pain", "unconscious",
)

_FORBIDDEN_ADVICE = re.compile(
    r"(診斷|诊断|確診|确诊|你患有|建議服用|建议服用|加大劑量|加大剂量|"
    r"停藥|停药|換藥|换药|應該食|应该吃|唔使食|不用吃)"
)

_PUNCT = re.compile(r"[\s，,。．.、;；:：!！?？\"'“”‘’()（）\-—_/]+")


def normalize(text: str) -> str:
    return _PUNCT.sub("", (text or "").lower())


def is_emergency(text: str) -> bool:
    haystack = normalize(text)
    return any(normalize(marker) in haystack for marker in _EMERGENCY)


def contains_forbidden_advice(text: str) -> bool:
    return bool(_FORBIDDEN_ADVICE.search(text or ""))


def name_mentioned(name: str, source: str) -> bool:
    """True when a medication name actually occurs in what the user said."""
    needle = normalize(name)
    return bool(needle) and needle in normalize(source)


def emergency_reply(locale: str) -> str:
    if locale == "zh-CN":
        return "请马上按「求助」按钮，我帮您叫人。如果情况危急，请直接拨打 120。"
    return "請你即刻撳「求助」掣，我幫你叫人。如果情況危急，請直接打 999。"


def emergency_card(locale: str) -> AgentCard:
    if locale == "zh-CN":
        title, headline, label = "需要立刻求助", "请按「求助」按钮", "求助"
    else:
        title, headline, label = "需要即刻求助", "請撳「求助」掣", "求助"
    return AgentCard(
        id="llm-emergency",
        kind="info",
        title=title,
        createdAt=0,
        data=CardData(icon="🆘", headline=headline),
        actions=[CardAction(id="sos", label=label, intent="sos")],
    )


def safe_chat_reply(locale: str) -> str:
    if locale == "zh-CN":
        return "这个我不敢乱说，建议您问医生；如果身体不舒服，请按「求助」。"
    return "呢個我唔敢亂講，建議你問醫生；如果身體唔舒服，請撳「求助」。"


def filter_chat_reply(text: str, locale: str) -> str:
    """Cap length and replace unsafe medical advice with a safe sentence."""
    clean = (text or "").strip()
    if not clean:
        return safe_chat_reply(locale)
    if contains_forbidden_advice(clean):
        return safe_chat_reply(locale)
    if len(clean) > 180:
        cut = clean[:180]
        for mark in ("。", "！", "？", "，", ".", "!", "?"):
            at = cut.rfind(mark)
            if at >= 40:
                return cut[: at + 1]
        return cut + "…"
    return clean
