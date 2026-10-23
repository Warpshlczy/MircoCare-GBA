"use client";

import { useCallback, useEffect, useState } from "react";
import { acknowledgeSos, getCaregiverOverview, redeemPairingCode, registerFamily, type CaregiverOverview } from "@/lib/api";
import { speak } from "@/lib/audio";

const formatTime = (value?: number) => value ? new Date(value).toLocaleString("zh-HK") : "—";

export default function CaregiverPage() {
  const [overview, setOverview] = useState<CaregiverOverview | null>(null);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("请创建家属账号，再输入长者端配对码。");
  const [loading, setLoading] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setOverview(await getCaregiverOverview()); setMessage("数据已更新"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "暂时无法读取家属数据"); }
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
      await speak("绑定成功，之后可以帮助查看长者的健康情况。", "zh-CN");
      await refresh();
    }
    catch (error) { setMessage(error instanceof Error ? error.message : "配对失败"); }
  }
  async function ack(id: string) {
    if (!overview) return;
    try { await acknowledgeSos(id, overview.seniorDeviceId); await refresh(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "确认失败"); }
  }
  return <main className="min-h-screen bg-slate-950 p-6 text-white"><div className="mx-auto max-w-5xl space-y-6">
    <header className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-lg text-cyan-300">湾区灵犀 · 家属端</p><h1 className="text-4xl font-extrabold">照顾员面板</h1></div><button onClick={() => void refresh()} className="rounded-xl bg-cyan-600 px-5 py-3 text-lg font-bold">{loading ? "更新中…" : "刷新"}</button></header>
    <section className="rounded-2xl bg-slate-900 p-5"><p aria-live="polite" className="mb-4 text-slate-300">{message}</p><div className="flex flex-wrap gap-3"><button onClick={() => void login()} className="rounded-xl bg-white px-4 py-3 font-bold text-slate-900">创建家属账号</button><input value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="6 位配对码" aria-label="6 位配对码" className="rounded-xl px-4 py-3 text-slate-900" /><button onClick={() => void pair()} className="rounded-xl bg-emerald-600 px-4 py-3 font-bold">绑定长者设备</button></div></section>
    {overview && <><section className="grid gap-4 md:grid-cols-3"><article className="rounded-2xl bg-slate-900 p-5"><h2 className="text-xl font-bold">健康卡</h2><p className="mt-3 text-2xl">{overview.healthCard.name ?? "未填写姓名"}</p><p className="text-slate-300">最近更新：{formatTime(overview.healthCard.updatedAt)}</p><p className="mt-3">用药：{overview.healthCard.medications?.join("、") || "未记录"}</p></article><article className="rounded-2xl bg-slate-900 p-5"><h2 className="text-xl font-bold">风险趋势</h2><p className="mt-3 text-4xl font-black">{overview.riskTrend.at(-1)?.riskBand ?? "暂无"}</p><p className="text-slate-300">记录 {overview.riskTrend.length} 条</p><p className="text-slate-300">语音筛查 {overview.screeningSessions?.length ?? 0} 次</p></article><article className="rounded-2xl bg-slate-900 p-5"><h2 className="text-xl font-bold">活动趋势</h2><p className="mt-3 text-4xl font-black">{overview.activityTrend.at(-1)?.steps ?? "—"}</p><p className="text-slate-300">最近一次步数</p></article></section><section className="rounded-2xl bg-red-950/60 p-5"><h2 className="text-2xl font-bold">需要关注</h2>{overview.alerts.length ? <ul className="mt-3 space-y-2">{overview.alerts.slice().reverse().map((alert, index) => <li key={`${alert.id ?? alert.at}-${index}`} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-red-900/60 p-3"><span>{alert.reason === "fall" ? "检测到跌倒" : `SOS：${alert.reason ?? "求助"}`} · {formatTime(alert.at)}</span>{alert.id && <button onClick={() => void ack(alert.id!)} className="rounded-lg bg-white px-3 py-2 font-bold text-red-900">确认已处理</button>}</li>)}</ul> : <p className="mt-3 text-slate-300">目前没有待处理告警。</p>}</section></>}
  </div></main>;
}
