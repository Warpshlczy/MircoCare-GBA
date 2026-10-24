"""Weekly family report — six fixed sections, no diagnostic words.

Only data the senior's device already synced is used: conversation turns,
telemetry counters, gait windows, screening sessions/results and reminder
escalations. Behavioural confirmations (``task_confirm_delay_min`` etc.) arrive
with B's ``postBehaviorDaily``; until that exists those numbers are shown as an
explicit "waiting for data" note instead of being guessed.

The report deliberately never names a disease. It answers "what changed, how
much, and what should a family member do next", leaving any medical judgement to
a clinician.
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

_DISCLAIMERS = {
    "observation": (
        "本报告是认知变化的辅助观察，不是医疗器械诊断结论，不能替代医生、护士或家属的判断。"
    ),
    "triage_support": (
        "本报告用于辅助分诊，提示是否需要进一步评估；不是医疗器械诊断结论，最终由医生判断。"
    ),
}


def disclaimer() -> str:
    """Report copy follows the configured claim level (DEV.md C.1 rule 3)."""
    return _DISCLAIMERS.get(settings.regulatory_claim_level, _DISCLAIMERS["observation"])

# Words that must never appear in a family-facing report. "诊断" itself is allowed
# only inside the mandated disclaimer above, so it is not in this list.
DIAGNOSTIC_WORDS = ("阿尔兹海默", "阿尔茨海默", "痴呆", "失智", "患病", "确诊")

# Neutral feature names — direction is added from the Z sign at render time.
_PLAIN: dict[str, str] = {
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
}


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
) -> ReportSection:
    count = len(turns)
    diff = count - len(prev_turns)
    minutes = sum(int(s.get("durationMs") or 0) for s in sessions) // 60_000
    summary = f"这一周他说了 {count} 轮话。"
    if minutes:
        summary += f"语音筛查共 {minutes} 分钟。"
    return ReportSection(
        key="talk",
        title="这一周他说了多少话",
        summary=summary,
        counts=[
            ReportCount(label="对话轮次", value=f"{count} 轮", delta=f"{diff:+d} 较上周"),
            ReportCount(label="语音筛查时长", value=f"{minutes} 分钟"),
            ReportCount(label="主动签到", value=f"{len(checkins)} 次"),
        ],
    )


def _change_section(
    device_id: str, store: Store, *, end: int
) -> tuple[ReportSection, bool]:
    """-> (section, any sustained change). Uses the same robust baseline as C2."""
    since = end - max(settings.trend_days, settings.baseline_days) * DAY_MS
    history = [h for h in store.history(device_id, "screening_metrics", since_ms=since) if _row_at(h) < end]
    if not history:
        return (
            ReportSection(
                key="change",
                title="变化在哪",
                summary="本期还没有可用的语音样本。",
                available=False,
                note="每天聊几句，样本够了才会开始看变化。",
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
                title="变化在哪",
                summary="样本还不够，继续陪他聊几句。",
                available=False,
                note=outcome.note,
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
        summary = "和过去两周比，说话方式没有明显变化。"
    else:
        phrases = []
        for r in flagged:
            word = "高于" if r.z > 0 else "低于"
            extra = "，而且是持续偏移" if r.sustained else ""
            phrases.append(f"{_PLAIN.get(r.name, r.name)}{word}平时（{abs(r.z):.1f} 个基线单位{extra}）")
        summary = "；".join(phrases) + "。"

    note = "依据：每个变化项都可展开查看特征名、Z 值、样本数与时间窗。"
    return (
        ReportSection(
            key="change",
            title="变化在哪",
            summary=summary,
            evidence=evidence,
            note=note,
        ),
        any(e.sustained or e.changepointAt for e in evidence),
    )


def _pct(value: Any) -> str:
    return "本期无到期任务" if value is None else f"{round(float(value) * 100)}%"


def _minutes(value: Any) -> str:
    return "本期无到期提醒" if value is None else f"{float(value):.0f} 分钟"


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
    escalations: list[dict[str, Any]], latest: dict[str, Any] | None
) -> ReportSection:
    count = len(escalations)
    summary = "本期没有提醒超时。" if count == 0 else f"本期有 {count} 次提醒超时，已进入家属通知队列。"
    counts = [ReportCount(label="提醒超时", value=f"{count} 次")]
    if latest:
        behaviour = latest.get("behaviour") or {}
        counts += [
            ReportCount(label="任务完成率", value=_pct(behaviour.get("taskCompletionRate"))),
            ReportCount(label="平均确认延迟", value=_minutes(behaviour.get("taskConfirmDelayMin"))),
            ReportCount(label="任务超时率", value=_pct(behaviour.get("taskTimeoutRate"))),
            ReportCount(label="延后次数", value=_count(behaviour.get("deferCount"))),
        ]
        summary += " 行为流已接入，本期依从性指标见下表。"
    return ReportSection(
        key="tasks",
        title="做事情况",
        summary=summary,
        counts=counts,
        note="缺失的读数显示为「本期无到期任务 / 无到期提醒」，不按 0 处理。",
    )


def _activity_section(gait: list[dict[str, Any]], falls: int) -> ReportSection:
    if not gait:
        return ReportSection(
            key="activity",
            title="活动与安全",
            summary="本期没有步态记录。",
            available=False,
            note="走动时把手机带在身上，才会有活动数据。",
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
        title="活动与安全",
        summary=f"本期记录 {len(by_day)} 天活动，跌倒 {falls} 次。",
        counts=[
            ReportCount(label="每日步数区间", value=f"{min(steps)}–{max(steps)} 步"),
            ReportCount(label="步态变异", value=f"{cv_mean:.2f}"),
            ReportCount(label="跌倒", value=f"{falls} 次"),
        ],
        note="外出时长与接近跌倒要等原生定位接入后才有数据。",
    )


def _advice_section(results: list[dict[str, Any]], sustained: bool) -> ReportSection:
    band = str(results[-1].get("riskBand")) if results else "low"
    if band == "elevated":
        tier, trigger = "尽快就医", "本期出现 elevated 分层，建议由医生做一次评估"
    elif band == "watch" or sustained:
        tier, trigger = "本月内做一次认知评估", "本期出现 watch 分层或持续偏移"
    else:
        tier, trigger = "继续观察", "本期分层为 low，且没有持续偏移"
    return ReportSection(
        key="advice",
        title="建议做什么",
        summary=f"建议：{tier}。",
        counts=[
            ReportCount(label="建议档位", value=tier),
            ReportCount(label="触发条件", value=trigger),
        ],
        note="建议只用于决定「何时安排一次评估」，不代表任何疾病判断；最终由医生决定。",
    )


def _privacy_section(
    conversation: int, sessions: int, gait: int, telemetry: int
) -> ReportSection:
    return ReportSection(
        key="privacy",
        title="数据与隐私",
        summary="本期语音只在手机上转成特征，原始音频没有上传；对话文字以假名保存，用于生成趋势。",
        counts=[
            ReportCount(label="对话轮次", value=f"{conversation} 条"),
            ReportCount(label="语音筛查", value=f"{sessions} 次"),
            ReportCount(label="步态窗口", value=f"{gait} 条"),
            ReportCount(label="埋点事件", value=f"{telemetry} 条"),
            ReportCount(label="上传原始音频", value="0"),
        ],
        note="撤回：长者可停止使用语音筛查入口，或联系服务方撤回同意；家属共享按接收人撤销。删除档案按 PDPO/PDPA 流程处理。",
    )


def build_weekly_report(
    device_id: str,
    store: Store,
    *,
    now: int | None = None,
    locale: Locale = "zh-CN",
) -> WeeklyReport:
    """Assemble the six-section report for the last seven days."""
    end = int(now if now is not None else time.time() * 1000)
    start = end - WEEK_MS
    prev_start = start - WEEK_MS

    user_turns = [r for r in store.history(device_id, "conversation") if r.get("role") == "user"]
    turns = _between(user_turns, start, end)
    prev_turns = _between(user_turns, prev_start, start)

    sessions = _between(store.history(device_id, "screening_sessions"), start, end)
    telemetry = _between(store.history(device_id, "telemetry"), start, end)
    checkins = [e for e in telemetry if e.get("name") in ("daily_checkin", "proactive_greeting")]

    change, sustained = _change_section(device_id, store, end=end)

    escalations = _between(store.history(device_id, "reminder_escalations"), start, end)
    behaviour = _latest_behaviour(store, device_id, start, end)
    gait = _between(store.history(device_id, "gait"), start, end)
    fall_rows = _between(store.history(device_id, "gait_falls"), start, end)
    falls = len(fall_rows) or sum(1 for g in gait if g.get("fall"))
    results = _between(store.history(device_id, "screening_results"), start, end)
    conversation = _between(store.history(device_id, "conversation"), start, end)

    sections = [
        _talk_section(turns, prev_turns, sessions, checkins),
        change,
        _tasks_section(escalations, behaviour),
        _activity_section(gait, falls),
        _advice_section(results, sustained),
        _privacy_section(len(conversation), len(sessions), len(gait), len(telemetry)),
    ]
    return WeeklyReport(
        deviceId=device_id,
        locale=locale,
        periodStart=start,
        periodEnd=end,
        generatedAt=end,
        sections=sections,
        disclaimer=disclaimer(),
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
    esc = html.escape
    body = "".join(_section_html(s) for s in report.sections)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>忆伴 · 家属周报</title>
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
  <h1>忆伴 · 家属周报</h1>
  <div class="meta">{esc(_day(report.periodStart))} 至 {esc(_day(report.periodEnd))} · 共 {len(report.sections)} 段</div>
</header>
{body}
<footer>{esc(report.disclaimer)}</footer>
</body>
</html>"""


def _section_html(section: ReportSection) -> str:
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
        evidence = f"<details><summary>查看依据</summary><ul>{items}</ul></details>"
    note = f'<p class="note">{esc(section.note)}</p>' if section.note else ""
    badge = "" if section.available else '<p class="note">（本期数据不足）</p>'
    return (
        f"<section><h2>{esc(section.title)}</h2>"
        f"<p>{esc(section.summary)}</p>{badge}{table}{evidence}{note}</section>"
    )
