package com.auragba.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The one place that talks to AlarmManager.
 *
 * Why it exists: a web page's timers are suspended once Android backgrounds the
 * WebView, so "每日访谈/提醒" cannot be driven from JS. The alarm fires
 * {@link DailyAlarmReceiver}, which posts a notification; tapping it reopens
 * MainActivity with reason=alarm.
 *
 * Exactness: on API 31+ an app may lack SCHEDULE_EXACT_ALARM. We degrade to an
 * inexact alarm instead of crashing (docs/dev.md §3.6: ±15min is acceptable),
 * and record which mode was used so the demo can explain it if asked.
 *
 * MULTI-SLOT one-shots: each alarm has an opaque `slot` string (the JS side uses
 * the record id). The slot is carried as the PendingIntent's DATA URI, which is
 * what the framework actually compares when matching pending intents — extras
 * are not part of `Intent.filterEquals`. Sharing one request code across slots is
 * therefore correct AND collision-free; an earlier version had a single fixed
 * request code, so the second "叫我九點" replaced the first while the record
 * store still listed both.
 */
final class AlarmScheduler {

    static final String PREFS = "memomate_alarms";
    static final String KEY_HOUR = "daily_hour";
    static final String KEY_MINUTE = "daily_minute";
    static final String KEY_EXACT = "daily_exact";

    /** Registry of live one-shot slots (a StringSet of slot ids). */
    private static final String KEY_ONCE_SLOTS = "once_slots";
    private static final String ONCE_AT = "once_at_";
    private static final String ONCE_LABEL = "once_label_";

    /** Pre-multi-slot keys: migrated on first read so an upgrade keeps its alarm. */
    private static final String LEGACY_ONCE_AT = "once_at";
    private static final String LEGACY_ONCE_LABEL = "once_label";
    /** Slot name used for the alarm that predates slot ids. */
    static final String LEGACY_SLOT = "legacy";

    /** Fallback when the caller sends no slot (older JS, or a one-off call). */
    static final String DEFAULT_SLOT = "default";

    private static final int REQUEST_CODE = 8801;
    private static final int REQUEST_CODE_ONCE = 8804;
    private static final String ONCE_URI_PREFIX = "auragba://alarm/";

    private AlarmScheduler() {}

    /**
     * Schedules (or re-schedules) the daily alarm and remembers the time so
     * {@link BootReceiver} can restore it after a reboot.
     *
     * @return true when an alarm was actually set.
     */
    static boolean scheduleDaily(Context ctx, int hour, int minute) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return false;

        final long at = nextOccurrence(hour, minute);
        final PendingIntent pi = pendingIntent(ctx);

        boolean exact = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
            exact = false; // permission revoked by the user — degrade, never crash
        }

        try {
            if (exact) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                } else {
                    am.setExact(AlarmManager.RTC_WAKEUP, at, pi);
                }
            } else {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                } else {
                    am.set(AlarmManager.RTC_WAKEUP, at, pi);
                }
            }
        } catch (SecurityException e) {
            // Some OEMs throw even after the check above.
            return false;
        }

        prefs(ctx).edit()
                .putInt(KEY_HOUR, hour)
                .putInt(KEY_MINUTE, minute)
                .putBoolean(KEY_EXACT, exact)
                .apply();
        return true;
    }

    static void cancel(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(pendingIntent(ctx));
        prefs(ctx).edit().remove(KEY_HOUR).remove(KEY_MINUTE).remove(KEY_EXACT).apply();
    }

    /**
     * One-shot alarm ("聽日八點叫我") in the slot named by `slot`. The epoch is
     * computed on the JS side because the model must never do that arithmetic;
     * here we only refuse the impossible (a time already past) and arm it.
     *
     * Arming the same slot twice is idempotent: same request code, same data
     * URI, FLAG_UPDATE_CURRENT rewrites the extras. That is what lets the cold
     * start reconciler re-arm blindly without creating duplicates.
     *
     * @return true when an alarm was actually set.
     */
    static boolean scheduleOnce(Context ctx, long atMs, String label, String slot) {
        if (atMs <= System.currentTimeMillis()) return false; // past time: refuse, never fire instantly
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return false;

        final String key = normalizeSlot(slot);
        final PendingIntent pi = oncePendingIntent(ctx, key, label);
        boolean exact = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) {
            exact = false; // same degradation as the daily alarm: ±15min beats a crash
        }
        try {
            if (exact) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi);
                } else {
                    am.setExact(AlarmManager.RTC_WAKEUP, atMs, pi);
                }
            } else {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi);
                } else {
                    am.set(AlarmManager.RTC_WAKEUP, atMs, pi);
                }
            }
        } catch (SecurityException e) {
            return false;
        }

        // Written ONLY after set() succeeded: these prefs ARE the read-back
        // (`getScheduledAlarms`), so a row here for an alarm the OS refused would
        // make the app claim an alarm that will never ring.
        SharedPreferences.Editor e = prefs(ctx).edit()
                .putLong(ONCE_AT + key, atMs)
                .putString(ONCE_LABEL + key, label == null ? "" : label);
        Set<String> slots = slots(ctx);
        if (slots.add(key)) e.putStringSet(KEY_ONCE_SLOTS, slots);
        e.apply();
        return true;
    }

    /**
     * Cancels ONE slot. An empty/unknown slot is a no-op rather than "cancel
     * everything": a caller that lost its slot id must not be able to silence
     * every alarm the senior is relying on.
     */
    static void cancelOnce(Context ctx, String slot) {
        final String key = normalizeSlot(slot);
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am != null) {
            am.cancel(oncePendingIntent(ctx, key, prefs(ctx).getString(ONCE_LABEL + key, "")));
        }
        Set<String> slots = slots(ctx);
        SharedPreferences.Editor e = prefs(ctx).edit()
                .remove(ONCE_AT + key)
                .remove(ONCE_LABEL + key);
        if (slots.remove(key)) e.putStringSet(KEY_ONCE_SLOTS, slots);
        e.apply();
    }

    /**
     * Re-arms every saved slot after a reboot, dropping the ones already past.
     *
     * A one-shot missed while the phone was off is dropped rather than rung at
     * boot: waking someone at 3pm for an 8am pill is worse than silence, and the
     * record store still shows the missed dose on screen.
     */
    static void rescheduleOnceFromPrefs(Context ctx) {
        migrateLegacyOnce(ctx);
        SharedPreferences p = prefs(ctx);
        long now = System.currentTimeMillis();
        List<String> keys = new ArrayList<>(slots(ctx));
        for (String key : keys) {
            long at = p.getLong(ONCE_AT + key, 0L);
            if (at <= now) {
                cancelOnce(ctx, key);
                continue;
            }
            scheduleOnce(ctx, at, p.getString(ONCE_LABEL + key, ""), key);
        }
    }

    /** Called by the receiver after it fires, so a stale slot is never re-armed. */
    static void clearOnce(Context ctx, String slot) {
        cancelOnce(ctx, slot);
    }

    /** Re-arms the saved daily alarm. No-op when nothing was ever scheduled. */
    static void rescheduleFromPrefs(Context ctx) {
        SharedPreferences p = prefs(ctx);
        if (!p.contains(KEY_HOUR)) return;
        scheduleDaily(ctx, p.getInt(KEY_HOUR, 8), p.getInt(KEY_MINUTE, 0));
    }

    /** Today at hour:minute when still in the future, otherwise tomorrow. */
    static long nextOccurrence(int hour, int minute) {
        Calendar c = Calendar.getInstance();
        c.set(Calendar.HOUR_OF_DAY, hour);
        c.set(Calendar.MINUTE, minute);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        if (c.getTimeInMillis() <= System.currentTimeMillis()) {
            c.add(Calendar.DAY_OF_YEAR, 1);
        }
        return c.getTimeInMillis();
    }

    static boolean wasExact(Context ctx) {
        return prefs(ctx).getBoolean(KEY_EXACT, false);
    }

    /**
     * Read-back for the JS reconcile pass, or null when nothing is armed.
     *
     * These read the same prefs {@link #rescheduleFromPrefs} uses, so they report
     * what this process believes the OS holds. A PendingIntent cannot be queried
     * for its trigger time on any API level, so the prefs ARE the record — which
     * is exactly why they must be written only after a successful set() call.
     */
    static JSObject readDaily(Context ctx) {
        SharedPreferences p = prefs(ctx);
        if (!p.contains(KEY_HOUR)) return null;
        JSObject o = new JSObject();
        o.put("hour", p.getInt(KEY_HOUR, 8));
        o.put("minute", p.getInt(KEY_MINUTE, 0));
        o.put("exact", p.getBoolean(KEY_EXACT, false));
        return o;
    }

    /**
     * Every armed one-shot, soonest first — the multi-slot read-back.
     *
     * These read the same prefs {@link #rescheduleOnceFromPrefs} uses, so they
     * report what this process believes the OS holds. A PendingIntent cannot be
     * queried for its trigger time on any API level, so the prefs ARE the record
     * — which is exactly why they are written only after a successful set().
     */
    static JSArray readOnceAll(Context ctx) {
        migrateLegacyOnce(ctx);
        SharedPreferences p = prefs(ctx);
        List<JSObject> rows = new ArrayList<>();
        for (String key : slots(ctx)) {
            long at = p.getLong(ONCE_AT + key, 0L);
            if (at <= 0L) continue;
            JSObject o = new JSObject();
            o.put("at", at);
            o.put("label", p.getString(ONCE_LABEL + key, ""));
            o.put("slot", key);
            rows.add(o);
        }
        // Soonest first: the JS reconciler matches by trigger time, and a stable
        // order keeps its diff readable in logs.
        Collections.sort(rows, (a, b) -> {
            long x = a.optLong("at", 0L);
            long y = b.optLong("at", 0L);
            return Long.compare(x, y);
        });
        JSArray out = new JSArray();
        for (JSObject o : rows) out.put(o);
        return out;
    }

    /**
     * Folds the pre-slot keys into a slot so an upgrade does not silently drop an
     * alarm the senior is relying on. Runs at most once: it removes the old keys.
     */
    private static void migrateLegacyOnce(Context ctx) {
        SharedPreferences p = prefs(ctx);
        if (!p.contains(LEGACY_ONCE_AT)) return;
        long at = p.getLong(LEGACY_ONCE_AT, 0L);
        String label = p.getString(LEGACY_ONCE_LABEL, "");
        SharedPreferences.Editor e = p.edit().remove(LEGACY_ONCE_AT).remove(LEGACY_ONCE_LABEL);
        if (at > System.currentTimeMillis()) {
            e.putLong(ONCE_AT + LEGACY_SLOT, at).putString(ONCE_LABEL + LEGACY_SLOT, label == null ? "" : label);
            Set<String> s = slots(ctx);
            s.add(LEGACY_SLOT);
            e.putStringSet(KEY_ONCE_SLOTS, s);
        }
        e.apply();
    }

    /** A copy of the slot registry: the set returned by getStringSet must not be mutated. */
    private static Set<String> slots(Context ctx) {
        Set<String> stored = prefs(ctx).getStringSet(KEY_ONCE_SLOTS, null);
        return stored == null ? new HashSet<>() : new HashSet<>(stored);
    }

    /** Empty or blank means "the caller had no slot" — never crash, never key on "". */
    private static String normalizeSlot(String slot) {
        if (slot == null) return DEFAULT_SLOT;
        String trimmed = slot.trim();
        return trimmed.isEmpty() ? DEFAULT_SLOT : trimmed;
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static PendingIntent pendingIntent(Context ctx) {
        Intent i = new Intent(ctx, DailyAlarmReceiver.class).setAction(DailyAlarmReceiver.ACTION_DAILY);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(ctx, REQUEST_CODE, i, flags);
    }

    /**
     * Label AND slot travel in the intent: the receiver must show what the alarm
     * is FOR, and it cannot ask JS anything at 8am with the WebView possibly
     * dead. The slot is also the intent's DATA, which is what makes two alarms
     * with the same request code distinct pending intents (`filterEquals`
     * compares data, not extras).
     */
    private static PendingIntent oncePendingIntent(Context ctx, String slot, String label) {
        Intent i = new Intent(ctx, OnceAlarmReceiver.class)
                .setAction(OnceAlarmReceiver.ACTION_ONCE)
                .setData(Uri.parse(ONCE_URI_PREFIX + Uri.encode(slot)))
                .putExtra(OnceAlarmReceiver.EXTRA_LABEL, label == null ? "" : label)
                .putExtra(OnceAlarmReceiver.EXTRA_SLOT, slot);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(ctx, REQUEST_CODE_ONCE, i, flags);
    }
}
