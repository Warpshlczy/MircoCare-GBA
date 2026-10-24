package com.auragba.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import java.util.Calendar;

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
 */
final class AlarmScheduler {

    static final String PREFS = "memomate_alarms";
    static final String KEY_HOUR = "daily_hour";
    static final String KEY_MINUTE = "daily_minute";
    static final String KEY_EXACT = "daily_exact";

    private static final int REQUEST_CODE = 8801;

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

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static PendingIntent pendingIntent(Context ctx) {
        Intent i = new Intent(ctx, DailyAlarmReceiver.class).setAction(DailyAlarmReceiver.ACTION_DAILY);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(ctx, REQUEST_CODE, i, flags);
    }
}
