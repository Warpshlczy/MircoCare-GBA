// viseme.ts — PURE. Text → mouth-openness timeline (0..1). No DOM.
// Tested in src/selfcheck.ts.
//
// ponytail: Web Speech TTS exposes no audio stream, so lip-sync cannot be driven
// by the real waveform. Chinese is one syllable per character, so each character
// gets the same open→wide→half→close shape (with a little per-character
// variation so it doesn't look mechanical); punctuation is a closed pause. Ceiling:
// it does not shape vowels (no pinyin table) and Latin letters get a full syllable
// each. audio.ts re-syncs the playhead on every `onboundary` event, which is what
// keeps drift under ~150ms on engines that emit boundaries. Upgrade path: native
// TTS that returns PCM → drive `level` from its RMS instead.

/** One frame ≈ a quarter of a character at the 0.85 speaking rate (~260ms/char). */
export const VISEME_FRAME_MS = 65;
export const FRAMES_PER_CHAR = 4;

const SHAPE = [0.45, 1, 0.7, 0.2];
const PAUSE = /[\s，。！？、；：,.!?;:…—「」『』（）()"'“”]/;

export function visemeFromText(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    if (PAUSE.test(ch)) {
      for (let i = 0; i < FRAMES_PER_CHAR; i++) out.push(0);
      continue;
    }
    // 0.75..1.0 peak, stable per character
    const peak = 0.75 + ((ch.codePointAt(0) ?? 0) % 6) * 0.05;
    for (const s of SHAPE) out.push(Math.round(s * peak * 100) / 100);
  }
  return out;
}
