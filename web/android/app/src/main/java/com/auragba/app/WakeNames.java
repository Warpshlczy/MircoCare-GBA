package com.auragba.app;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * Which names count as a wake word RIGHT NOW.
 *
 * Why this exists (2026-10-25, real-device bug): the background listener's name
 * list includes 「忆伴」, and the app's own greeting says 「我係憶伴」. With
 * `wakeOn` defaulting to true the service is live while the app is in the
 * foreground, so it heard the assistant introduce itself, matched its own
 * words as a wake word, and called `stopSelf()` — the wake listener died on the
 * first greeting and stayed dead until the app restarted.
 *
 * The fix is not "mute the mic while speaking" (that would also block the
 * barge-in we want) and not "drop 忆伴 forever" (it is a legitimate name when
 * the room is quiet). It is: **a name the assistant is currently saying out
 * loud cannot be a wake word**. That is exactly the rule the WebView path
 * already applies via `SPEAK_WAKE_NAMES`, and the native path never had it.
 *
 * PURE by design — no Android imports, so the rule can be exercised on a plain
 * JVM without a phone. The reproducible command is in `docs/dev.md` 修复表第 20 行.
 */
final class WakeNames {

    private WakeNames() {}

    /**
     * Simplified/traditional pairs that appear in the name list.
     *
     * Only the characters that actually differ need folding: 忆/憶 differs,
     * 小/阿 do not. This matters because the risk runs BOTH ways — the greeting
     * says 「我係憶伴」, and ASR may hand back 「忆伴」 for the same sound. Folding
     * makes 「忆伴」 and 「憶伴」 one word, so excluding it covers both spellings
     * instead of only the one we happened to write.
     */
    private static final char[][] VARIANTS = {
            {'憶', '忆'},
    };

    /** Whitespace, case and script variant are all irrelevant: ASR varies on all three. */
    static String normalize(String s) {
        String out = s == null ? "" : s.replaceAll("\\s+", "").toLowerCase(Locale.ROOT);
        for (char[] pair : VARIANTS) {
            out = out.replace(pair[0], pair[1]);
        }
        return out;
    }

    /**
     * The names that may wake the assistant while `spokenText` is being read.
     *
     * `spokenText` null/empty (nothing is being said) returns the full list
     * unchanged — the quiet-room case, where every name is legitimate.
     */
    static List<String> activeNames(List<String> all, String spokenText) {
        if (all == null || all.isEmpty()) return Collections.emptyList();
        String spoken = normalize(spokenText);
        if (spoken.isEmpty()) return new ArrayList<>(all);

        List<String> out = new ArrayList<>(all.size());
        for (String name : all) {
            String n = normalize(name);
            // An empty name would otherwise "appear" in every sentence.
            if (n.isEmpty()) continue;
            if (!spoken.contains(n)) out.add(name);
        }
        return out;
    }

    /**
     * Does this transcript contain one of the active names?
     *
     * Kept here rather than in the service so the matching rule is testable: it
     * is the other half of the self-wake bug (a substring match against a list
     * that still contained 忆伴).
     */
    static boolean heard(String transcript, List<String> activeNames) {
        String t = normalize(transcript);
        if (t.isEmpty() || activeNames == null) return false;
        for (String name : activeNames) {
            String n = normalize(name);
            if (!n.isEmpty() && t.contains(n)) return true;
        }
        return false;
    }
}
