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