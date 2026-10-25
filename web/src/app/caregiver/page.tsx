"use client";

import { useCallback, useEffect, useState } from "react";
import { acknowledgeSos, deleteAccount, getCaregiverOverview, redeemPairingCode, registerFamily, type CaregiverOverview } from "@/lib/api";
import { speak } from "@/lib/audio";
import { wipeLocalData } from "@/lib/db";
import { flushOutboxOnce } from "@/lib/outboxRunner";
import { riskBandLabel } from "@/lib/i18n";
import { explainRisk } from "@/lib/riskExplain";

const formatTime = (value?: number) => value ? new Date(value).toLocaleString("zh-HK") : "—";

export default function CaregiverPage() {
  const [overview, setOverview] = useState<CaregiverOverview | null>(null);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("请创建家属账号，再输入长者端配对码。");
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setOverview(await getCaregiverOverview()); setMessage("数据已更新"); }
    catch (error) { const text = error instanceof Error ? error.message : ""; setMessage(/40[134]/.test(text) ? "请先创建家属账号并输入长者配对码。" : text || "暂时无法读取家属数据"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  async function login() {
    try { await registerFamily(); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "家属登录失败"); }
  }
  async function pair() {
    if (!/^\d{6}$/.test(code)) { setMessage("请输入 6 位配对码"); return; }
    try {
      await redeemPairingCode(code);
      setCode("");
      await speak("绑定成功，之后可以帮助查看长者的健康情况。", "zh-CN", undefined, "cheerful");
      await refresh();
    }
    catch (error) { setMessage(error instanceof Error ? error.message : "配对失败"); }
  }
  async function ack(id: string) {
    if (!overview) return;
    try { await acknowledgeSos(id, overview.seniorDeviceId); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "确认失败"); }
  }
  /**
   * Delete the family account. Order matters (issue #2): drain the outbox first,
   * because once the session cookie is gone every queued payload answers 401 and
   * backs off forever; then wipe this device's stores, then call the API.
   */
  async function removeAccount() {
    if (!window.confirm("删除家属账号？本机缓存与配对会清空，长者端数据不受影响。")) return;
    setLoading(true);
    try {
      await flushOutboxOnce();
      await wipeLocalData();
      await deleteAccount();
      setOverview(null);
      setMessage("账号已删除，可以重新创建。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败");
    } finally {
      setLoading(false);
    }
  }
  // Never show a band from an unusable capture, and never show one when C says
  // the baseline (or a stream) is missing — "一切如常" would be an assertion.
  const latestRisk = overview?.riskTrend.filter((row) => row.quality !== "reject").at(-1);
  const riskInsufficient = latestRisk
    ? overview?.sufficient === false || latestRisk.baselineSufficient === false || latestRisk.insufficientStreams === true
    : false;
  // The backend keeps resolved SOS rows in `alerts` as history; only open ones
  // may be presented as "需要关注" — a resolved alert must not keep its button.
  const openAlerts = overview?.alerts.filter((alert) => alert.status !== "resolved") ?? [];
  // 风险分未经校准（Brier 检验），也未经外部验证 —— 因此默认只展示定性提示。
  // 只有显式配置 NEXT_PUBLIC_AURA_PREVALENCE（目标人群患病率，0–1）时才给数字，
  // 且给的是区间下限推出来的"最多每 N 个提示 1 个确认"，偏保守。
  const prevalenceRaw = Number(process.env.NEXT_PUBLIC_AURA_PREVALENCE ?? "");
  const prevalence = Number.isFinite(prevalenceRaw) && prevalenceRaw > 0 && prevalenceRaw < 1
    ? prevalenceRaw
    : undefined;
  const riskNote = explainRisk("zh-CN", { prevalence });
  // Today's coarse record counts (issue #7). Absence means "not reported" —
  // never render 0, which would read as "he took nothing all day".
  const medToday = overview?.recordsToday?.kinds?.med;
  const medLine = medToday
    ? `服药 ${medToday.count ?? 0} 次${medToday.lastAt ? `，最近 ${new Date(medToday.lastAt).toLocaleTimeString("zh-HK", { hour: "2-digit", minute: "2-digit" })}` : ""}`
    : "暂无上报";
  return <main className="min-h-screen bg-slate-950 p-6 text-white"><div className="mx-auto max-w-5xl space-y-6">
    <header className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-lg text-cyan-300">忆伴 · 家属端</p><h1 className="text-4xl font-extrabold">照顾员面板</h1></div><div className="flex gap-3"><button onClick={() => void refresh()} className="rounded-xl bg-cyan-600 px-5 py-3 text-lg font-bold">{loading ? "更新中…" : "刷新"}</button><button onClick={() => void removeAccount()} className="rounded-xl border border-red-400 px-5 py-3 text-lg font-bold text-red-300">删除账号</button></div></header>
    <section className="rounded-2xl bg-slate-900 p-5"><p aria-live="polite" className="mb-4 text-slate-300">{message}</p><div className="flex flex-wrap gap-3"><button onClick={() => void login()} className="rounded-xl bg-white px-4 py-3 font-bold text-slate-900">创建家属账号</button><input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="6 位配对码" aria-label="6 位配对码" className="rounded-xl px-4 py-3 text-slate-900" /><button onClick={() => void pair()} className="rounded-xl bg-emerald-600 px-4 py-3 font-bold">绑定长者设备</button></div></section>
    {overview && <><section className="grid gap-4 md:grid-cols-3"><article className="rounded-2xl bg-slate-900 p-5"><h2 className="text-xl font-bold">健康卡</h2><p className="mt-3 text-2xl">{overview.healthCard.name ?? "未填写姓名"}</p><p className="text-slate-300">最近更新：{formatTime(overview.healthCard.updatedAt)}</p><p className="mt-3">用药：{overview.healthCard.medications?.join("、") || "未记录"}</p><p className="mt-2 text-cyan-200">今日{medLine}</p></article><article className="rounded-2xl bg-slate-900 p-5"><h2 className="text-xl font-bold">风险趋势</h2><p className="mt-3 text-4xl font-black">{overview.riskTrend.length ? riskBandLabel("zh-CN", latestRisk?.riskBand, !latestRisk || riskInsufficient) : "暂无"}</p><p className="text-slate-300">记录 {overview.riskTrend.length} 条</p><p className="text-slate-300">语音筛查 {overview.screeningSessions?.length ?? 0} 次</p>{riskNote.upperBound ? <p className="mt-3 rounded-xl bg-slate-800 p-3 text-sm leading-relaxed text-slate-300">{riskNote.qualitative}{riskNote.detail ? <> {riskNote.detail}</> : null}{riskNote.hasNumbers ? <> <span className="text-amber-300">（该估计未经外部验证）</span></> : null}</p> : null}</article><article className="rounded-2xl bg-slate-900 p-5"><h2 className="text-xl font-bold">活动趋势</h2><p className="mt-3 text-4xl font-black">{overview.activityTrend.at(-1)?.steps ?? "—"}</p><p className="text-slate-300">最近一次步数</p></article></section><section className="rounded-2xl bg-red-950/60 p-5"><h2 className="text-2xl font-bold">需要关注</h2>{openAlerts.length ? <ul className="mt-3 space-y-2">{openAlerts.slice().reverse().map((alert, index) => <li key={`${alert.id ?? alert.at}-${index}`} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-red-900/60 p-3"><span>{alert.reason === "fall" ? "检测到跌倒" : `SOS：${alert.reason ?? "求助"}`} · {formatTime(alert.at)}</span>{alert.id && <button onClick={() => void ack(alert.id!)} className="rounded-lg bg-white px-3 py-2 font-bold text-red-900">确认已处理</button>}</li>)}</ul> : <p className="mt-3 text-slate-300">目前没有待处理告警。</p>}</section><section className="rounded-2xl bg-slate-900 p-5"><h2 className="text-2xl font-bold">通知记录</h2>{overview.notifications.length ? <ul className="mt-3 space-y-2">{overview.notifications.slice().reverse().map((note, index) => <li key={note.id ?? index} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-800 p-3"><span>{note.kind === "reminder" ? "用药提醒超时" : note.kind === "sos" ? "SOS 求助" : note.kind ?? "通知"} · {formatTime(note.createdAt)}</span><span className="text-slate-400">{note.status === "pending" ? "待发送" : note.status ?? ""}</span></li>)}</ul> : <p className="mt-3 text-slate-300">暂无通知。</p>}</section></>}
  </div></main>;
}
