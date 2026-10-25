package com.auragba.app;

import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.os.Build;
import android.os.Process;

import com.getcapacitor.JSObject;

import org.json.JSONObject;

import java.util.Calendar;

/**
 * Collects the usage-stats proxy behind `DigitalSkillDaily` (contract.py:401).
 *
 * Why these three fields and not "screen time": the third fusion stream is meant
 * to say something about *digital fluency* — does he still move between apps, or
 * has he collapsed onto one screen because everything else became too hard. Raw
 * minutes of screen time measures the opposite thing (a person scrolling a single
 * video for three hours looks "highly engaged").
 *
 * HONESTY RULES, all three load-bearing:
 *
 *  1. **PACKAGE_USAGE_STATS is a special permission** the user grants by hand in
 *     Settings. We never prompt for it (a settings maze is a net loss for a
 *     forgetful 78-year-old); a family member enables it once. Without it every
 *     query returns nothing, and we report NO ROW rather than zeros.
 *  2. **`opFailRate` is NOT computed here and is always null.** It would need
 *     accessibility events (a tap that did nothing), which this app deliberately
 *     does not request. A 0 there would be read downstream as "no operation
 *     failed" — the strongest possible claim about something we cannot see.
 *  3. **`firstTouchDelayMs` is only reported when the unlock time is known.**
 *     It is "how long after unlocking did he actually start something", which is
 *     a slowness proxy we can defend. When `CircadianRecorder` saw no unlock
 *     (recorder not running / phone never unlocked) the field stays null.
 */
final class DigitalSkillRecorder {

    private DigitalSkillRecorder() {}

    /**
     * Whether the senior's phone lets us read app usage.
     *
     * Checked with AppOps rather than by querying, because "not granted" and
     * "nothing happened today" both produce an empty result set, and the caller
     * must be able to tell those apart (one omits the row, the other is a real
     * quiet day).
     */
    static boolean hasAccess(Context ctx) {
        try {
            AppOpsManager ops = (AppOpsManager) ctx.getSystemService(Context.APP_OPS_SERVICE);
            if (ops == null) return false;
            int mode;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                mode = ops.unsafeCheckOpNoThrow(
                        AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.getPackageName());
            } else {
                mode = ops.checkOpNoThrow(
                        AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.getPackageName());
            }
            return mode == AppOpsManager.MODE_ALLOWED;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * One day's row, or null when the permission is off or nothing was observed.
     *
     * Never returns a row with both fields null: that is indistinguishable from a
     * measured quiet day in every downstream aggregate.
     */
    static JSObject snapshot(Context ctx, String day) {
        if (!hasAccess(ctx)) return null;
        if (day == null || day.isEmpty()) return null;

        long dayStart = startOfDay(day);
        if (dayStart <= 0L) return null;
        long dayEnd = dayStart + 86_400_000L;

        long firstResumedAt = 0L;
        int switches = 0;
        String lastPackage = null;

        UsageStatsManager usm = (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
        if (usm == null) return null;

        UsageEvents events;
        try {
            events = usm.queryEvents(dayStart, dayEnd);
        } catch (Exception e) {
            // SecurityException when the grant was revoked between the check and
            // the query. Nothing observed is the honest answer.
            return null;
        }
        if (events == null) return null;

        UsageEvents.Event e = new UsageEvents.Event();
        while (events.hasNextEvent()) {
            if (!events.getNextEvent(e)) break;
            if (!isForegroundEvent(e.getEventType())) continue;
            long at = e.getTimeStamp();
            if (at < dayStart || at >= dayEnd) continue;
            if (firstResumedAt == 0L || at < firstResumedAt) firstResumedAt = at;
            String pkg = e.getPackageName();
            if (pkg == null) continue;
            // Count TRANSITIONS between packages, not foreground events: two
            // activities of the same app are one continuous use of that app, and
            // counting them would make a single long session look like fluency.
            if (lastPackage != null && !lastPackage.equals(pkg)) switches++;
            lastPackage = pkg;
        }

        if (firstResumedAt == 0L) return null; // nothing used that day

        // Unlock -> first thing he opened. Unknown unlock means unknown delay.
        Long delay = null;
        long unlockedAt = CircadianRecorder.firstActiveAt(ctx, day);
        if (unlockedAt > 0L && firstResumedAt >= unlockedAt) {
            delay = firstResumedAt - unlockedAt;
        }

        JSObject out = new JSObject();
        out.put("day", day);
        out.put("appSwitchCount", switches);
        // Explicitly null: the field exists in the contract precisely so "not
        // measurable" can travel as null instead of being silently dropped.
        out.put("opFailRate", JSONObject.NULL);
        if (delay != null) out.put("firstTouchDelayMs", delay.longValue());
        else out.put("firstTouchDelayMs", JSONObject.NULL);
        return out;
    }

    /** API 29 renamed MOVE_TO_FOREGROUND; both mean "this became the screen". */
    private static boolean isForegroundEvent(int type) {
        if (type == UsageEvents.Event.MOVE_TO_FOREGROUND) return true; // still emitted, deprecated
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return type == UsageEvents.Event.ACTIVITY_RESUMED;
        }
        return false;
    }

    /** Local midnight for `YYYY-MM-DD`, or 0 when the key is malformed. */
    private static long startOfDay(String day) {
        String[] parts = day.split("-");
        if (parts.length != 3) return 0L;
        try {
            Calendar c = Calendar.getInstance();
            c.set(Calendar.YEAR, Integer.parseInt(parts[0]));
            c.set(Calendar.MONTH, Integer.parseInt(parts[1]) - 1);
            c.set(Calendar.DAY_OF_MONTH, Integer.parseInt(parts[2]));
            c.set(Calendar.HOUR_OF_DAY, 0);
            c.set(Calendar.MINUTE, 0);
            c.set(Calendar.SECOND, 0);
            c.set(Calendar.MILLISECOND, 0);
            return c.getTimeInMillis();
        } catch (NumberFormatException e) {
            return 0L;
        }
    }
}
