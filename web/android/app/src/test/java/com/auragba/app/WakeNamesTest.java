package com.auragba.app;

import java.util.Arrays;
import java.util.List;

/**
 * The wake-word rule, exercised on a plain JVM — no phone, no Android SDK.
 *
 * `WakeNames` is deliberately free of Android imports precisely so the rule that
 * caused the 2026-10-25 self-wake bug can be checked in CI-less environments.
 * `-encoding UTF-8` is required: these files contain Chinese, and javac defaults
 * to the platform charset (GBK here), which mangles the literals.
 *
 *   javac -encoding UTF-8 -d web/android/app/build/wn \
 *     web/android/app/src/main/java/com/auragba/app/WakeNames.java \
 *     web/android/app/src/test/java/com/auragba/app/WakeNamesTest.java
 *   java -Dfile.encoding=UTF-8 -cp web/android/app/build/wn com.auragba.app.WakeNamesTest
 *   -> WakeNames: 18 checks OK
 *
 * It is a `main`, not a JUnit test, because the gradle build cannot run here
 * (it needs `npx cap sync` to generate capacitor-cordova-android-plugins). If
 * that is ever fixed, convert this to @Test methods — the assertions carry over
 * unchanged.
 *
 * The control case (check 4) is the point: the OLD behaviour — matching against
 * the full name list — still hits the app's own greeting. Without it this file
 * would "pass" even if someone deleted the rule.
 */
public class WakeNamesTest {

    private static int checks = 0;

    private static void ok(boolean cond, String what) {
        checks++;
        if (!cond) throw new AssertionError("FAIL: " + what);
    }

    public static void main(String[] args) {
        List<String> names = Arrays.asList(
                "小忆", "小憶", "阿忆", "阿憶", "忆伴", "憶伴", "memomate", "memo mate");

        // 1. Quiet room: every name is a legitimate wake word.
        ok(WakeNames.activeNames(names, null).size() == 8, "nothing spoken -> all 8 names active");

        // 2. THE BUG: the app says its own name, in traditional script.
        String greeting = "阿婆／阿伯你好，我係憶伴，有事隨時叫我。";
        List<String> during = WakeNames.activeNames(names, greeting);
        ok(!during.contains("忆伴"), "simplified form excluded by folding");
        ok(!during.contains("憶伴"), "the form actually spoken is excluded");
        ok(during.contains("小忆"), "the other names stay live: " + during);

        // 3. The greeting can no longer wake the assistant that is saying it.
        ok(!WakeNames.heard(greeting, during), "own greeting must NOT wake");

        // 4. CONTROL: the old behaviour did wake. Remove the rule and this passes
        //    while check 3 fails — which is what makes check 3 meaningful.
        ok(WakeNames.heard(greeting, names), "control: the full list still matches (the bug)");

        // 5. He can still barge in by name while it talks.
        ok(WakeNames.heard("小忆你停一停", during), "barge-in by name still works");

        // 6. A reply that echoes his own words must not self-wake on them
        //    (toolExec echoes task text: 「好，我記低咗：<his words>」).
        String echo = "好，我記低咗：小忆幫我買藥";
        List<String> echoActive = WakeNames.activeNames(names, echo);
        ok(!WakeNames.heard(echo, echoActive), "echoed words must not wake");
        ok(echoActive.contains("忆伴"), "a name NOT in the line is still active");

        // 7. ASR varies on spacing and case; both must be irrelevant.
        List<String> spaced = WakeNames.activeNames(names, "我 係 憶 伴");
        ok(!spaced.contains("憶伴"), "spaces inside the spoken name are ignored");
        ok(WakeNames.heard("MEMO MATE", names), "case and spaces in ASR output ignored");

        // 8. Degenerate inputs stay total — a wake service must never crash.
        ok(WakeNames.activeNames(names, "").size() == 8, "empty spoken text -> full list");
        ok(WakeNames.activeNames(null, "任何話").isEmpty(), "null list -> empty, never NPE");
        ok(!WakeNames.heard("", names), "empty transcript is not a hit");
        ok(!WakeNames.heard(null, names), "null transcript is not a hit");

        // 9. The real strings from i18n.ts, all three of them.
        for (String line : new String[]{
                "阿婆／阿伯你好，我係憶伴，有事隨時叫我。",
                "阿婆／阿伯，我係憶伴。今日身體點呀？有冇邊度唔舒服？",
                "奶奶／爷爷您好，我是忆伴，有事随时叫我。"}) {
            List<String> active = WakeNames.activeNames(names, line);
            ok(!WakeNames.heard(line, active), "no self-wake on: " + line);
        }

        System.out.println("WakeNames: " + checks + " checks OK");
    }
}
