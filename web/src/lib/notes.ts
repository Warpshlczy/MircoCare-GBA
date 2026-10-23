// notes.ts — PURE local memory notes ("remember the keys are in the drawer").
// Notes never leave the device: no upload, no free text in telemetry.
// Tested in src/selfcheck.ts.

import { t } from "./i18n.ts";
import { formatWhen } from "./datetime.ts";
import type { AgentCard, Locale, Note } from "./types";

// A remember verb can appear with traditional/simplified/mixed wording, so we
// remove the verb and then a leading polite prefix ("帮我/幫我/请/請...").
const REMEMBER_WORDS = ["記住", "记住", "記低", "记低", "記一下", "记一下", "remember"];
const POLITE_PREFIX = /^(帮我|幫我|请|請|唔该|唔該|同我)\s*/;

/** Strips "记住/帮我记低..." and returns the actual thing to remember. */
export function noteTextFromUtterance(utterance: string): string {
  const original = (utterance ?? "").trim();
  let text = original;
  for (const word of REMEMBER_WORDS) {
    const at = text.toLowerCase().indexOf(word.toLowerCase());
    if (at >= 0) {
      text = `${text.slice(0, at)}${text.slice(at + word.length)}`;
      break;
    }
  }
  text = text.replace(POLITE_PREFIX, "").replace(/^[：:，,\s。.]+/, "").trim();
  return text || original;
}

export function noteFromUtterance(utterance: string, locale: Locale, now: number): Note {
  return {
    id: `note-${now}`,
    at: now,
    text: noteTextFromUtterance(utterance),
    locale,
  };
}

/** Most recent note, or null. Does not mutate the input. */
export function latestNote(notes: Note[]): Note | null {
  if (!notes.length) return null;
  return notes.slice().sort((a, b) => a.at - b.at)[notes.length - 1] ?? null;
}

export function noteCard(note: Note, locale: Locale, now: number): AgentCard {
  return {
    id: `note-card-${note.id}`,
    kind: "info",
    title: t(locale, "noteSavedTitle"),
    createdAt: now,
    data: {
      icon: "📝",
      headline: note.text,
      rows: [{ label: t(locale, "noteTime"), value: formatWhen(note.at, locale) }],
    },
  };
}

export function recallCard(note: Note, locale: Locale, now: number): AgentCard {
  return {
    id: `note-recall-${note.id}`,
    kind: "info",
    title: t(locale, "noteRecallTitle"),
    createdAt: now,
    data: {
      icon: "📝",
      headline: note.text,
      rows: [{ label: t(locale, "noteTime"), value: formatWhen(note.at, locale) }],
    },
  };
}
