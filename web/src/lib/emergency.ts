// emergency.ts — the ONE emergency lexicon. PURE: no DOM, no fetch.
//
// Why this file exists: emergency detection used to live in two disjoint word
// lists — `intent.ts` (7 trigger words: 救命/唔舒服/求助…, A's overlay path)
// and backend `llm/safety.py#_EMERGENCY` (~30 symptom markers: 跌倒/心口痛/起
// 唔到身…), the latter only reachable through `/agent/turn`, which the device
// only calls when `/health` reports a real planner. With the LLM off or its key
// missing, 「我跌咗喺度起唔到身」 matched NEITHER list, fell through the whole
// cascade and was filed as a todo by the offline fallback — an emergency
// became a chore row. This module is the device-side superset; `agent.ts`
// consults it at STEP 0 of `runTurn`, offline, before the refusal gate, the
// local planner and the backend. An emergency never waits for a model.
//
// Drift rule (selfcheck.ts): this list MUST remain a superset of
// `llm/safety.py#_EMERGENCY`. C adds a marker there → the gate goes red here
// until the same word lands in this file. That direction is load-bearing:
// the device must catch everything the backend catches, because the device
// may be the only judge when the network is gone.

/**
 * Symptom + trigger markers, unified. Matched after lowercasing and
 * punctuation-stripping (same normalization as `safety.py#normalize`), as
 * plain substring tests on the whole utterance.
 *
 * A hit is fail-safe BY DESIGN: a false positive opens the SOS overlay and
 * pages the family once; a false negative files a fall under the sofa as a
 * chore. The SosOverlay still shows a screen he can read, and the family can
 * call back — those are cheap. The reverse is not.
 */
export const EMERGENCY_MARKERS: readonly string[] = [
  // — from backend llm/safety.py `_EMERGENCY` (C owns that list; keep in sync)
  "胸痛", "心口痛", "透唔到氣", "透唔到气", "呼吸困難", "呼吸困难", "抖唔到氣",
  // — spoken variants of the symptom phrases (substring matching cannot bridge
  //   an inserted word: 「心口好痛」 does not contain 「心口痛」)
  "心口好痛", "心口很痛", "胸口痛", "胸口好痛",
  "半邊身無力", "半边身无力", "半身不遂", "講唔到話", "讲不到话", "口齒不清",
  "暈低", "晕倒", "意識不清", "意识不清", "昏迷", "流血不止", "起唔到身",
  "跌倒", "跌低", "跌親", "跌亲", "仆低", "仆親", "仆亲", "摔親", "摔亲", "起不了身",
  "跌親起唔到", "跌倒起不来", "自殺", "自杀", "想死", "中風", "中风",
  "stroke", "fall down", "fell down", "fallen", "can't breathe", "chest pain", "unconscious",
  // — device-side trigger words the backend list lacks (呼救动词/名词)
  "救命", "救命呀", "救救我", "救我", "sos", "叫救護車", "叫救护车", "救護車", "救护车",
  "唔舒服", "不舒服", "嗌人", "求助",
];

/**
 * Deliberately ABSENT: the bare 「急」.
 *
 * 「急住去廁所」「唔使急」 must not page the family, and a one-character
 * keyword cannot tell them apart. 「急」 stays in `intent.ts`'s sos rule,
 * where A's `runIntent` path opens the SOS overlay with its countdown and a
 * visible cancel — a grace the auto-escalation below does not have.
 */

/** Same shape as `safety.py#normalize`: lowercase, punctuation stripped. */
const _PUNCT = /[\s，,。．.、;；:：!！?？"'"“”‘’()（）\-—_/]+/g;

function normalizeEmergency(text: string): string {
  return (text ?? "").toLowerCase().replace(_PUNCT, "");
}

/**
 * The matched marker (goes into the `sos` call's `reason`, so the family and
 * the audit row see WHAT tripped), or null when this is not an emergency.
 */
export function emergencyHit(text: string): string | null {
  const haystack = normalizeEmergency(text);
  if (!haystack) return null;
  for (const marker of EMERGENCY_MARKERS) {
    if (haystack.includes(normalizeEmergency(marker))) return marker;
  }
  return null;
}

/** 999 in HK/MO, 120 on the mainland — mirrors SosOverlay.tsx / toolExec.ts. */
export function emergencyNumber(locale: string): string {
  return locale === "zh-CN" ? "120" : "999";
}
