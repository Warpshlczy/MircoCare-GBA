// intent.ts — PURE keyword → intent mapping. No DOM. Tested in src/selfcheck.ts.
//
// ponytail: this is a keyword matcher, NOT NLU. It covers the handful of things
// the senior can ask for today. Ceiling: no paraphrase, no slot extraction.
// Upgrade path: send `utterance` to the backend agent (api.getAgentCards) which
// returns planned cards; this function stays as the offline fallback.

import type { Intent } from "./types";

// Order matters: more specific intents first (sos before help).
const RULES: { intent: Intent; words: string[] }[] = [
  { intent: "sos", words: ["救命", "唔舒服", "不舒服", "嗌人", "求助", "急", "sos"] },
  // Abort and "say that again" must precede everything else: "取消聽日覆診"
  // contains the follow-up keyword, and "再講一次食藥" would otherwise hit med.
  { intent: "cancel", words: ["取消", "唔使", "唔驶", "唔駛", "算了", "算啦", "唔要", "cancel", "never mind"] },
  { intent: "repeat", words: ["再講", "再讲", "講多次", "讲多次", "大聲", "大声", "聽唔清", "听唔清", "repeat", "say again"] },
  // Explicit memory/appointment commands win over the generic "药" keyword:
  // "记住买药" should save a note, not just show the medication list.
  // Recall MUST precede note: "我记低咗咩" also contains the note keyword "记低".
  { intent: "recall", words: ["我記低咗咩", "我记低咗咩", "記低咗咩", "记低咗咩", "我記咗咩", "我记咗咩", "上次記", "上次记", "有咩記錄", "有咩记录", "notes", "note list"] },
  { intent: "followup", words: ["覆診", "覆诊", "復診", "复诊", "預約", "预约", "appointment", "followup", "follow up"] },
  { intent: "note", words: ["記住", "记住", "記低", "记低", "記一下", "记一下", "幫我記", "帮我记", "remember"] },
  // B intents. `call` MUST precede `help`, because "幫我打畀阿明" contains 幫.
  { intent: "alarm", words: ["鬧鐘", "闹钟", "叫醒", "叫我起身", "幾點叫", "几点叫", "較時間", "校时间", "alarm", "wake me"] },
  { intent: "call", words: ["打電話", "打电话", "撥打", "拨打", "致電", "致电", "打畀", "打俾", "打電話畀", "call "] },
  { intent: "message", words: ["發訊息", "发訊息", "發消息", "发消息", "發短訊", "发短信", "發信息", "发信息", "whatsapp", "send message"] },
  { intent: "navigate", words: ["導航", "导航", "點去", "点去", "怎麼去", "怎么去", "帶我去", "带我去", "路線", "路线", "幾遠", "几远", "navigate", "route"] },
  { intent: "weather", words: ["天气", "天氣", "落雨", "雨", "气温", "氣溫", "冻", "熱", "热", "天晴", "weather"] },
  { intent: "medication", words: ["吃药", "食药", "食藥", "药", "藥", "降压", "降壓", "血糖", "med"] },
  { intent: "camera", words: ["拍照", "影相", "相机", "相機", "照相", "camera", "photo"] },
  { intent: "tasks", words: ["任务", "任務", "清单", "清單", "做乜", "要做", "记得", "記低", "list"] },
  { intent: "tools", words: ["按钮", "按鈕", "开关", "開關", "设置", "設定", "选项", "選項", "更多", "倒数", "菜单", "settings", "tools"] },
  { intent: "help", words: ["帮", "幫", "点算", "怎么办", "help"] },
];

export function parseIntent(text: string): Intent {
  const s = (text ?? "").toLowerCase();
  for (const r of RULES) for (const w of r.words) if (s.includes(w.toLowerCase())) return r.intent;
  return "unknown";
}

/**
 * True for utterances that should get a conversational answer instead of a
 * todo card. Kept deliberately narrow: questions and explicit "how do I..." asks.
 */
export function isQuestion(text: string): boolean {
  const s = (text ?? "").trim();
  if (!s) return false;
  if (/[?？]\s*$/.test(s)) return true;
  // Cantonese/Mandarin yes-no questions end in 吗/呢/嘛 even without a mark.
  // Missing this is how 「能听到我说话吗」used to fall into the todo path.
  if (/(吗|嗎|呢|嘛)\s*$/.test(s)) return true;
  return [
    "点算",
    "點算",
    "怎么办",
    "怎麼辦",
    "为什么",
    "為什麼",
    "点解",
    "點解",
    "可唔可以",
    "能不能",
    "可不可以",
    "点样",
    "點樣",
    "怎么样",
    "怎麼樣",
    "怎样",
    "怎樣",
  ].some((w) => s.includes(w));
}