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
  // Explicit memory/appointment commands win over the generic "药" keyword:
  // "记住买药" should save a note, not just show the medication list.
  // Recall MUST precede note: "我记低咗咩" also contains the note keyword "记低".
  { intent: "recall", words: ["我記低咗咩", "我记低咗咩", "記低咗咩", "记低咗咩", "我記咗咩", "我记咗咩", "上次記", "上次记", "有咩記錄", "有咩记录", "notes", "note list"] },
  { intent: "followup", words: ["覆診", "覆诊", "復診", "复诊", "預約", "预约", "appointment", "followup", "follow up"] },
  { intent: "note", words: ["記住", "记住", "記低", "记低", "記一下", "记一下", "幫我記", "帮我记", "remember"] },
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