"""Weekly family report — six fixed sections, no diagnostic words.

Only data the senior's device already synced is used: conversation turns,
telemetry counters, gait windows, screening sessions/results and reminder
escalations. Behavioural confirmations (``task_confirm_delay_min`` etc.) arrive
with B's ``postBehaviorDaily``; until that exists those numbers are shown as an
explicit "waiting for data" note instead of being guessed.

The report deliberately never names a disease. It answers "what changed, how
much, and what should a family member do next", leaving any medical judgement to
a clinician.

Locale: every family-facing string lives in ``_TEXTS``. zh-HK and zh-MO share
the Traditional-Chinese copy; zh-CN is the Simplified default. The `locale`
field on the report is therefore meaningful — it is not decorative metadata.
"""

from __future__ import annotations

import html
import time
from typing import Any

from ..baseline import compute_baseline
from ..config import settings
from ..contract import Locale, ReportCount, ReportEvidence, ReportSection, WeeklyReport
from ..store import Store

DAY_MS = 86_400_000
WEEK_MS = 7 * DAY_MS

# Words that must never appear in a family-facing report, in either script.
# "诊断/診斷" itself is allowed only inside the mandated disclaimer below, so it
# is not in this list.
DIAGNOSTIC_WORDS = (
    "阿尔兹海默", "阿尔茨海默", "阿茲海默", "阿兹海默",
    "痴呆", "癡呆", "失智", "患病", "确诊", "確診",
)

_TEXTS: dict[str, dict[str, Any]] = {
    "zh-CN": {
        "disclaimers": {
            "observation": (
                "本报告是认知变化的辅助观察，不是医疗器械诊断结论，不能替代医生、护士或家属的判断。"
            ),
            "triage_support": (
                "本报告用于辅助分诊，提示是否需要进一步评估；不是医疗器械诊断结论，最终由医生判断。"
            ),
        },
        "features": {
            "jitter_local": "声音抖动",
            "shimmer_local": "音量稳定性",
            "hnr_db": "嗓音清晰度",
            "f0_cv": "音调起伏",
            "articulation_rate": "吐字速度",
            "speech_rate": "说话速度",
            "pause_ratio": "停顿占比",
            "mean_pause_s": "平均停顿长度",
            "voiced_ratio": "发声时间",
            "f2_hz": "咬字位置",
            "ttr": "用词重复",
            "mattr": "用词多样性",
            "sentence_len_variance": "句子长短变化",
            "filler_ratio": "口头填充词",
            "coherence": "答话相关性",
        },
        "talk": {
            "title": "这一周他说了多少话",
            "summary": "这一周他说了 {count} 轮话。",
            "minutes": "语音筛查共 {minutes} 分钟。",
            "rounds": "对话轮次",
            "roundsValue": "{count} 轮",
            "delta": "{diff:+d} 较上周",
            "minutesLabel": "语音筛查时长",
            "minutesValue": "{minutes} 分钟",
            "checkins": "主动签到",
            "interviews": "完成访谈",
            "timesValue": "{n} 次",
        },
        "change": {
            "title": "变化在哪",
            "noData": "本期还没有可用的语音样本。",
            "noDataNote": "每天聊几句，样本够了才会开始看变化。",
            "insufficient": "样本还不够，继续陪他聊几句。",
            "stable": "和过去两周比，说话方式没有明显变化。",
            "high": "高于",
            "low": "低于",
            "phrase": "{feature}{word}平时（{z:.1f} 个基线单位{extra}）",
            "sustainedExtra": "，而且是持续偏移",
            "note": "依据：每个变化项都可展开查看特征名、Z 值、样本数与时间窗。",
            "qualityNote": "另：{fair} 条 fair 样本已计入，{reject} 次采集质量不合格未计入。",
        },
        "tasks": {
            "title": "做事情况",
            "none": "本期没有提醒超时。",
            "timeouts": "本期有 {count} 次提醒超时，已进入家属通知队列。",
            "connected": " 行为流已接入，本期依从性指标见下表。",
            "reminderTimeouts": "提醒超时",
            "timesValue": "{n} 次",
            "completion": "任务完成率",
            "delay": "平均确认延迟",
            "delayValue": "{value:.0f} 分钟",
            "timeout": "任务超时率",
            "defer": "延后次数",
            "noDueTasks": "本期无到期任务",
            "noDueReminders": "本期无到期提醒",
            "note": "缺失的读数显示为「本期无到期任务 / 无到期提醒」，不按 0 处理。",
        },
        "activity": {
            "title": "活动与安全",
            "none": "本期没有步态记录。",
            "noneNote": "走动时把手机带在身上，才会有活动数据。",
            "summary": "本期记录 {days} 天活动，跌倒 {falls} 次。",
            "steps": "每日步数区间",
            "stepsValue": "{min}–{max} 步",
            "gaitCv": "步态变异",
            "falls": "跌倒",
            "fallsValue": "{n} 次",
            "proxy": "听力/视觉代理",
            "proxyValue": "听力 {hearing} / 视觉 {vision}",
            "proxyNote": "代理指标，非听力学/视力检查；不参与风险分。",
            "note": "外出时长与接近跌倒要等原生定位接入后才有数据。",
        },
        "advice": {
            "title": "建议做什么",
            "summary": "建议：{tier}。",
            "tierLabel": "建议档位",
            "triggerLabel": "触发条件",
            "note": "建议只用于决定「何时安排一次评估」，不代表任何疾病判断；最终由医生决定。",
            "tiers": {
                "elevated": "尽快就医",
                "watch": "本月内做一次认知评估",
                "low": "继续观察",
            },
            "triggers": {
                "elevated": "本期出现 elevated 分层，建议由医生做一次评估",
                "watch": "本期出现 watch 分层或持续偏移",
                "low": "本期分层为 low，且没有持续偏移",
            },
        },
        "privacy": {
            "title": "数据与隐私",
            "summary": "本期语音只在手机上转成特征，原始音频没有上传；对话文字以假名保存，用于生成趋势。",
            "turns": "对话轮次",
            "sessions": "语音筛查",
            "gait": "步态窗口",
            "telemetry": "埋点事件",
            "audio": "上传原始音频",
            "turnsValue": "{n} 条",
            "sessionsValue": "{n} 次",
            "gaitValue": "{n} 条",
            "telemetryValue": "{n} 条",
            "audioValue": "0",
            "note": "撤回：长者可停止使用语音筛查入口，或联系服务方撤回同意；家属共享按接收人撤销。删除档案按 PDPO/PDPA 流程处理。",
        },
        "html": {
            "title": "忆伴 · 家属周报",
            "h1": "忆伴 · 家属周报",
            "meta": "{start} 至 {end} · 共 {n} 段",
            "evidence": "查看依据",
            "insufficient": "（本期数据不足）",
        },
    },
    "zh-HK": {
        "disclaimers": {
            "observation": (
                "本報告是認知變化的輔助觀察，不是醫療器械診斷結論，不能替代醫生、護士或家屬的判斷。"
            ),
            "triage_support": (
                "本報告用於輔助分診，提示是否需要進一步評估；不是醫療器械診斷結論，最終由醫生判斷。"
            ),
        },
        "features": {
            "jitter_local": "聲音抖動",
            "shimmer_local": "音量穩定性",
            "hnr_db": "嗓音清晰度",
            "f0_cv": "音調起伏",
            "articulation_rate": "吐字速度",
            "speech_rate": "說話速度",
            "pause_ratio": "停頓佔比",
            "mean_pause_s": "平均停頓長度",
            "voiced_ratio": "發聲時間",
            "f2_hz": "咬字位置",
            "ttr": "用詞重複",
            "mattr": "用詞多樣性",
            "sentence_len_variance": "句子長短變化",
            "filler_ratio": "口頭填充詞",
            "coherence": "答話相關性",
        },
        "talk": {
            "title": "這一週他講了多少話",
            "summary": "這一週他講了 {count} 輪話。",
            "minutes": "語音篩查共 {minutes} 分鐘。",
            "rounds": "對話輪次",
            "roundsValue": "{count} 輪",
            "delta": "{diff:+d} 較上週",
            "minutesLabel": "語音篩查時長",
            "minutesValue": "{minutes} 分鐘",
            "checkins": "主動簽到",
            "interviews": "完成訪談",
            "timesValue": "{n} 次",
        },
        "change": {
            "title": "變化在哪",
            "noData": "本期還沒有可用的語音樣本。",
            "noDataNote": "每日傾幾句，樣本夠了才會開始看變化。",
            "insufficient": "樣本仍未夠，繼續陪他傾幾句。",
            "stable": "和過去兩週比，說話方式沒有明顯變化。",
            "high": "高於",
            "low": "低於",
            "phrase": "{feature}{word}平時（{z:.1f} 個基線單位{extra}）",
            "sustainedExtra": "，而且是持續偏移",
            "note": "依據：每個變化項都可展開查看特徵名、Z 值、樣本數與時間窗。",
            "qualityNote": "另：{fair} 條 fair 樣本已計入，{reject} 次採集質量不合格未計入。",
        },
        "tasks": {
            "title": "做事情況",
            "none": "本期沒有提醒超時。",
            "timeouts": "本期有 {count} 次提醒超時，已進入家屬通知隊列。",
            "connected": " 行為流已接入，本期依從性指標見下表。",
            "reminderTimeouts": "提醒超時",
            "timesValue": "{n} 次",
            "completion": "任務完成率",
            "delay": "平均確認延遲",
            "delayValue": "{value:.0f} 分鐘",
            "timeout": "任務超時率",
            "defer": "延後次數",
            "noDueTasks": "本期無到期任務",
            "noDueReminders": "本期無到期提醒",
            "note": "缺失的讀數顯示為「本期無到期任務 / 無到期提醒」，不按 0 處理。",
        },
        "activity": {
            "title": "活動與安全",
            "none": "本期沒有步態記錄。",
            "noneNote": "走動時把電話帶在身上，才會有活動數據。",
            "summary": "本期記錄 {days} 天活動，跌倒 {falls} 次。",
            "steps": "每日步數區間",
            "stepsValue": "{min}–{max} 步",
            "gaitCv": "步態變異",
            "falls": "跌倒",
            "fallsValue": "{n} 次",
            "proxy": "聽力/視覺代理",
            "proxyValue": "聽力 {hearing} / 視覺 {vision}",
            "proxyNote": "代理指標，非聽力學/視力檢查；不參與風險分。",
            "note": "外出時長與接近跌倒要等原生定位接入後才有數據。",
        },
        "advice": {
            "title": "建議做什麼",
            "summary": "建議：{tier}。",
            "tierLabel": "建議檔位",
            "triggerLabel": "觸發條件",
            "note": "建議只用於決定「何時安排一次評估」，不代表任何疾病判斷；最終由醫生決定。",
            "tiers": {
                "elevated": "盡快就醫",
                "watch": "本月內做一次認知評估",
                "low": "繼續觀察",
            },
            "triggers": {
                "elevated": "本期出現 elevated 分層，建議由醫生做一次評估",
                "watch": "本期出現 watch 分層或持續偏移",
                "low": "本期分層為 low，且沒有持續偏移",
            },
        },
        "privacy": {
            "title": "數據與隱私",
            "summary": "本期語音只在手機上轉成特徵，原始音頻沒有上傳；對話文字以假名保存，用於生成趨勢。",
            "turns": "對話輪次",
            "sessions": "語音篩查",
            "gait": "步態窗口",
            "telemetry": "埋點事件",
            "audio": "上傳原始音頻",
            "turnsValue": "{n} 條",
            "sessionsValue": "{n} 次",
            "gaitValue": "{n} 條",
            "telemetryValue": "{n} 條",
            "audioValue": "0",
            "note": "撤回：長者可停止使用語音篩查入口，或聯絡服務方撤回同意；家屬共享按接收人撤銷。刪除檔案按 PDPO/PDPA 流程處理。",
        },
        "html": {
            "title": "憶伴 · 家屬週報",
            "h1": "憶伴 · 家屬週報",
            "meta": "{start} 至 {end} · 共 {n} 段",
            "evidence": "查看依據",
            "insufficient": "（本期數據不足）",
        },
    },
}
# zh-MO follows the Hong Kong Traditional copy.
_TEXTS["zh-MO"] = _TEXTS["zh-HK"]


def _text(locale: str) -> dict[str, Any]:
    return _TEXTS.get(locale, _TEXTS["zh-CN"])


def disclaimer(locale: str = "zh-CN") -> str:
    """Report copy follows the configured claim level (DEV.md C.1 rule 3)."""
    texts = _text(locale)["disclaimers"]
    return texts.get(settings.regulatory_claim_level, texts["observation"])


def _row_at(row: dict[str, Any]) -> int:
    return int(row.get("at") or row.get("startedAt") or row.get("endedAt") or 0)


def _between(rows: list[dict[str, Any]], start: int, end: int) -> list[dict[str, Any]]:
    return [r for r in rows if start <= _row_at(r) < end]


def _day(ms: int) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(ms / 1000))


def _talk_section(
    turns: list[dict[str, Any]],
    prev_turns: list[dict[str, Any]],
    sessions: list[dict[str, Any]],
    checkins: list[dict[str, Any]],
    interviews: list[dict[str, Any]],
    t: dict[str, Any],
) -> ReportSection:
    copy = t["talk"]
    count = len(turns)
    diff = count - len(prev_turns)
    minutes = sum(int(s.get("durationMs") or 0) for s in sessions) // 60_000
    summary = copy["summary"].format(count=count)
    if minutes:
        summary += copy["minutes"].format(minutes=minutes)
    return ReportSection(
        key="talk",
        title=copy["title"],
        summary=summary,
        counts=[
            ReportCount(
                label=copy["rounds"],
                value=copy["roundsValue"].format(count=count),
                delta=copy["delta"].format(diff=diff),
            ),
            ReportCount(label=copy["minutesLabel"], value=copy["minutesValue"].format(minutes=minutes)),
            ReportCount(label=copy["checkins"], value=copy["timesValue"].format(n=len(checkins))),
            ReportCount(label=copy["interviews"], value=copy["timesValue"].format(n=len(interviews))),
        ],
    )


def _change_section(
    device_id: str, store: Store, *, end: int, t: dict[str, Any]
) -> tuple[ReportSection, bool]:
    """-> (section, any sustained change). Uses the same robust baseline as C2."""
    copy = t["change"]
    since = end - max(settings.trend_days, settings.baseline_days) * DAY_MS
    history = [h for h in store.history(device_id, "screening_metrics", since_ms=since) if _row_at(h) < end]
    sessions = [
        s for s in store.history(device_id, "screening_sessions", since_ms=since)
        if _row_at(s) < end
    ]
    fair = sum(1 for s in sessions if s.get("quality") == "fair")
    rejected = sum(1 for s in sessions if s.get("quality") == "reject")
    quality_note = (
        copy["qualityNote"].format(fair=fair, reject=rejected) if fair or rejected else ""
    )
    if not history:
        return (
            ReportSection(
                key="change",
                title=copy["title"],
                summary=copy["noData"],
                available=False,
                note=" ".join(part for part in (copy["noDataNote"], quality_note) if part),
            ),
            False,
        )

    prior, today = history[:-1], history[-1].get("metrics", {})
    outcome = compute_baseline(
        [h.get("metrics", {}) for h in prior],
        today,
        at_ms=[_row_at(h) for h in prior],
        z_window_days=settings.baseline_days,
    )
    if not outcome.sufficient:
        return (
            ReportSection(
                key="change",
                title=copy["title"],
                summary=copy["insufficient"],
                available=False,
                note=" ".join(part for part in (outcome.note, quality_note) if part),
            ),
            False,
        )

    flagged = sorted((r for r in outcome.rows if r.flag != "normal"), key=lambda r: -abs(r.z))[:3]
    evidence = [
        ReportEvidence(
            feature=r.name,
            z=round(r.z, 2),
            samples=outcome.samples,
            windowDays=settings.baseline_days,
            direction=r.direction,  # type: ignore[arg-type]
            changepointAt=r.changepoint_at,
            sustained=r.sustained,
        )
        for r in flagged
    ]
    if not flagged:
        summary = copy["stable"]
    else:
        phrases = []
        labels = t["features"]
        for r in flagged:
            word = copy["high"] if r.z > 0 else copy["low"]
            extra = copy["sustainedExtra"] if r.sustained else ""
            phrases.append(
                copy["phrase"].format(
                    feature=labels.get(r.name, r.name),
                    word=word,
                    z=abs(r.z),
                    extra=extra,
                )
            )
        summary = "；".join(phrases) + "。"
    return (
        ReportSection(
            key="change",
            title=copy["title"],
            summary=summary,
            evidence=evidence,
            note=" ".join(part for part in (copy["note"], quality_note) if part),
        ),
        any(e.sustained or e.changepointAt for e in evidence),
    )


def _pct(value: Any, t: dict[str, Any]) -> str:
    return t["tasks"]["noDueTasks"] if value is None else f"{round(float(value) * 100)}%"


def _minutes(value: Any, t: dict[str, Any]) -> str:
    if value is None:
        return t["tasks"]["noDueReminders"]
    return t["tasks"]["delayValue"].format(value=float(value))


def _count(value: Any) -> str:
    return "—" if value is None else f"{int(value)} 次"


def _latest_behaviour(store: Store, device_id: str, start: int, end: int) -> dict[str, Any] | None:
    """Most recent stored rollup inside the report week (today first)."""
    for offset in range(8):
        stamp = end - offset * DAY_MS
        if stamp < start:
            break
        document = store.get_doc(device_id, f"behaviour:{_day(stamp)}")
        if document:
            return document
    return None


def _tasks_section(
    escalations: list[dict[str, Any]], latest: dict[str, Any] | None, t: dict[str, Any]
) -> ReportSection:
    copy = t["tasks"]
    count = len(escalations)
    summary = copy["none"] if count == 0 else copy["timeouts"].format(count=count)
    counts = [ReportCount(label=copy["reminderTimeouts"], value=copy["timesValue"].format(n=count))]
    if latest:
        behaviour = latest.get("behaviour") or {}
        counts += [
            ReportCount(label=copy["completion"], value=_pct(behaviour.get("taskCompletionRate"), t)),
            ReportCount(label=copy["delay"], value=_minutes(behaviour.get("taskConfirmDelayMin"), t)),
            ReportCount(label=copy["timeout"], value=_pct(behaviour.get("taskTimeoutRate"), t)),
            ReportCount(label=copy["defer"], value=_count(behaviour.get("deferCount"))),
        ]
        summary += copy["connected"]
    return ReportSection(
        key="tasks",
        title=copy["title"],
        summary=summary,
        counts=counts,
        note=copy["note"],
    )


def _activity_section(
    gait: list[dict[str, Any]],
    falls: int,
    latest: dict[str, Any] | None,
    t: dict[str, Any],
) -> ReportSection:
    copy = t["activity"]
    behaviour = (latest or {}).get("behaviour") or {}
    hearing = behaviour.get("hearingProxy")
    vision = behaviour.get("visionProxy")
    has_proxy = hearing is not None or vision is not None
    proxy_counts = []
    proxy_note = ""
    if has_proxy:
        proxy_counts.append(
            ReportCount(
                label=copy["proxy"],
                value=copy["proxyValue"].format(
                    hearing="—" if hearing is None else f"{float(hearing):.2f}",
                    vision="—" if vision is None else f"{float(vision):.2f}",
                ),
            )
        )
        proxy_note = copy["proxyNote"]
    if not gait:
        return ReportSection(
            key="activity",
            title=copy["title"],
            summary=copy["none"],
            available=False,
            counts=proxy_counts,
            note=" ".join(part for part in (copy["noneNote"], proxy_note) if part),
        )
    by_day: dict[str, int] = {}
    cvs: list[float] = []
    for window in gait:
        day = _day(_row_at(window))
        by_day[day] = by_day.get(day, 0) + int(window.get("steps") or 0)
        if window.get("cv") is not None:
            cvs.append(float(window["cv"]))
    steps = list(by_day.values())
    cv_mean = sum(cvs) / len(cvs) if cvs else 0.0
    return ReportSection(
        key="activity",
        title=copy["title"],
        summary=copy["summary"].format(days=len(by_day), falls=falls),
        counts=[
            ReportCount(
                label=copy["steps"],
                value=copy["stepsValue"].format(min=min(steps), max=max(steps)),
            ),
            ReportCount(label=copy["gaitCv"], value=f"{cv_mean:.2f}"),
            ReportCount(label=copy["falls"], value=copy["fallsValue"].format(n=falls)),
        ] + proxy_counts,
        note=" ".join(part for part in (copy["note"], proxy_note) if part),
    )


def _advice_section(
    results: list[dict[str, Any]], sustained: bool, t: dict[str, Any]
) -> ReportSection:
    copy = t["advice"]
    band = str(results[-1].get("riskBand")) if results else "low"
    if band == "elevated":
        tier, trigger = copy["tiers"]["elevated"], copy["triggers"]["elevated"]
    elif band == "watch" or sustained:
        tier, trigger = copy["tiers"]["watch"], copy["triggers"]["watch"]
    else:
        tier, trigger = copy["tiers"]["low"], copy["triggers"]["low"]
    return ReportSection(
        key="advice",
        title=copy["title"],
        summary=copy["summary"].format(tier=tier),
        counts=[
            ReportCount(label=copy["tierLabel"], value=tier),
            ReportCount(label=copy["triggerLabel"], value=trigger),
        ],
        note=copy["note"],
    )


def _privacy_section(
    conversation: int, sessions: int, gait: int, telemetry: int, t: dict[str, Any]
) -> ReportSection:
    copy = t["privacy"]
    return ReportSection(
        key="privacy",
        title=copy["title"],
        summary=copy["summary"],
        counts=[
            ReportCount(label=copy["turns"], value=copy["turnsValue"].format(n=conversation)),
            ReportCount(label=copy["sessions"], value=copy["sessionsValue"].format(n=sessions)),
            ReportCount(label=copy["gait"], value=copy["gaitValue"].format(n=gait)),
            ReportCount(label=copy["telemetry"], value=copy["telemetryValue"].format(n=telemetry)),
            ReportCount(label=copy["audio"], value=copy["audioValue"]),
        ],
        note=copy["note"],
    )


def build_weekly_report(
    device_id: str,
    store: Store,
    *,
    now: int | None = None,
    locale: Locale = "zh-CN",
) -> WeeklyReport:
    """Assemble the six-section report for the last seven days."""
    t = _text(locale)
    end = int(now if now is not None else time.time() * 1000)
    start = end - WEEK_MS
    prev_start = start - WEEK_MS

    user_turns = [r for r in store.history(device_id, "conversation") if r.get("role") == "user"]
    turns = _between(user_turns, start, end)
    prev_turns = _between(user_turns, prev_start, start)

    sessions = _between(store.history(device_id, "screening_sessions"), start, end)
    telemetry = _between(store.history(device_id, "telemetry"), start, end)
    checkins = [e for e in telemetry if e.get("name") in ("daily_checkin", "proactive_greeting")]

    change, sustained = _change_section(device_id, store, end=end, t=t)

    escalations = _between(store.history(device_id, "reminder_escalations"), start, end)
    behaviour = _latest_behaviour(store, device_id, start, end)
    gait = _between(store.history(device_id, "gait"), start, end)
    fall_rows = _between(store.history(device_id, "gait_falls"), start, end)
    falls = len(fall_rows) or sum(1 for g in gait if g.get("fall"))
    results = _between(store.history(device_id, "screening_results"), start, end)
    conversation = _between(store.history(device_id, "conversation"), start, end)
    # Structured interview completions arrive as telemetry (`interview_end`).
    # Answer-level props stay in telemetry; only the completion count is shown.
    interviews = [e for e in telemetry if e.get("name") == "interview_end"]

    sections = [
        _talk_section(turns, prev_turns, sessions, checkins, interviews, t),
        change,
        _tasks_section(escalations, behaviour, t),
        _activity_section(gait, falls, behaviour, t),
        _advice_section(results, sustained, t),
        _privacy_section(len(conversation), len(sessions), len(gait), len(telemetry), t),
    ]
    return WeeklyReport(
        deviceId=device_id,
        locale=locale,
        periodStart=start,
        periodEnd=end,
        generatedAt=end,
        sections=sections,
        disclaimer=disclaimer(locale),
        claimLevel=settings.regulatory_claim_level,
    )


def report_summary(report: WeeklyReport) -> dict[str, Any]:
    """Coarse outbox payload — no health details, no counts, no free text."""
    return {
        "periodStart": report.periodStart,
        "periodEnd": report.periodEnd,
        "sections": len(report.sections),
    }


def render_html(report: WeeklyReport) -> str:
    """Self-contained HTML (no external assets) for the caregiver demo."""
    t = _text(report.locale)
    copy = t["html"]
    esc = html.escape
    lang = "zh-CN" if report.locale == "zh-CN" else "zh-HK"
    body = "".join(_section_html(s, t) for s in report.sections)
    meta = copy["meta"].format(
        start=_day(report.periodStart), end=_day(report.periodEnd), n=len(report.sections)
    )
    return f"""<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(copy["title"])}</title>
<style>
  body {{ margin: 0 auto; max-width: 760px; padding: 24px; font: 18px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: #10212b; background: #f7fafc; }}
  header {{ border-bottom: 3px solid #0e7490; padding-bottom: 12px; margin-bottom: 20px; }}
  h1 {{ font-size: 26px; margin: 0 0 6px; }}
  .meta {{ color: #4b5b66; font-size: 15px; }}
  section {{ background: #fff; border-radius: 12px; padding: 16px 20px; margin: 14px 0; box-shadow: 0 1px 3px rgba(16,33,43,.12); }}
  h2 {{ font-size: 20px; margin: 0 0 8px; color: #0e7490; }}
  table {{ width: 100%; border-collapse: collapse; margin-top: 10px; }}
  th, td {{ text-align: left; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; font-size: 16px; }}
  th {{ color: #4b5b66; font-weight: 600; width: 40%; }}
  .note {{ color: #4b5b66; font-size: 15px; }}
  details {{ margin-top: 10px; font-size: 15px; }}
  footer {{ margin-top: 18px; color: #4b5b66; font-size: 14px; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background: #0f1720; color: #e6edf2; }}
    section {{ background: #16222c; box-shadow: none; }}
    th, .note, .meta, footer {{ color: #a9b8c4; }}
    th, td {{ border-color: #263543; }}
  }}
</style>
</head>
<body>
<header>
  <h1>{esc(copy["h1"])}</h1>
  <div class="meta">{esc(meta)}</div>
</header>
{body}
<footer>{esc(report.disclaimer)}</footer>
</body>
</html>"""


def _section_html(section: ReportSection, t: dict[str, Any]) -> str:
    copy = t["html"]
    esc = html.escape
    rows = "".join(
        f"<tr><th>{esc(c.label)}</th><td>{esc(c.value)}"
        + (f"<br><small>{esc(c.delta)}</small>" if c.delta else "")
        + "</td></tr>"
        for c in section.counts
    )
    table = f"<table>{rows}</table>" if rows else ""
    evidence = ""
    if section.evidence:
        items = "".join(
            f"<li>{esc(e.feature)}：Z = {e.z:.2f}，方向 {esc(e.direction)}，"
            f"样本 {e.samples} 条 / 窗口 {e.windowDays} 天"
            + ("，持续偏移" if e.sustained else "")
            + "</li>"
            for e in section.evidence
        )
        evidence = f"<details><summary>{esc(copy['evidence'])}</summary><ul>{items}</ul></details>"
    note = f'<p class="note">{esc(section.note)}</p>' if section.note else ""
    badge = "" if section.available else f'<p class="note">{esc(copy["insufficient"])}</p>'
    return (
        f"<section><h2>{esc(section.title)}</h2>"
        f"<p>{esc(section.summary)}</p>{badge}{table}{evidence}{note}</section>"
    )
