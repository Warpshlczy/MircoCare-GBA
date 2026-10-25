package com.auragba.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.Build;

import java.util.Calendar;
import java.util.LinkedHashSet;
import java.util.Set;

/**
 * Collects the screen/unlock/charging signals behind `CircadianDaily`
 * (contract.py:316) — none of which needs a runtime permission.
 *
 * Why native: `ACTION_SCREEN_ON` / `ACTION_SCREEN_OFF` are protected broadcasts
 * that can ONLY be received by a dynamically registered receiver, and a WebView
 * stops running the moment the screen goes off. A JS timer would therefore
 * measure exactly the opposite of what we want (nothing at night).
 *
 * Honesty rules:
 *  - A day with no event has NO record. `getCircadian` returns null rather than
 *    zeros, because `firstActiveAt: 0` would read as "active at 1970".
 *  - Counters live per day key in SharedPreferences and are pruned to the last
 *    two days: yesterday is what the upload needs, and unbounded keys in prefs
 *    are how apps rot.
 *  - Registering twice is a no-op; the receiver is a singleton.
 */
final class CircadianRecorder {

    private static final String PREFS = "memomate_circadian";

    /** Night window used for `nightWakeCount`: awake between 22:00 and 06:00. */
    private static final int NIGHT_FROM_HOUR = 22;
    private static final int NIGHT_TO_HOUR = 6;

    private static BroadcastReceiver receiver;
    private static long chargingSince = 0L;

    private CircadianRecorder() {}

    static synchronized void start(Context ctx) {
        if (receiver != null) return;
        final Context app = ctx.getApplicationContext();

        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent intent) {
                if (intent == null || intent.getAction() == null) return;
                handle(app, intent);
            }
        };

        IntentFilter f = new IntentFilter();
        f.addAction(Intent.ACTION_SCREEN_ON);
        f.addAction(Intent.ACTION_SCREEN_OFF);
        f.addAction(Intent.ACTION_USER_PRESENT);
        f.addAction(Intent.ACTION_POWER_CONNECTED);
        f.addAction(Intent.ACTION_POWER_DISCONNECTED);

        // API 33+ requires an explicit export flag; these are protected system
        // broadcasts, so NOT_EXPORTED is correct and keeps the receiver private.
        // Using the platform API (not ContextCompat) so the build does not depend
        // on an androidx.core version that happens to have the 4-arg overload.
        if (Build.VERSION.SDK_INT >= 33) {
            app.registerReceiver(receiver, f, Context.RECEIVER_NOT_EXPORTED);
        } else {
            app.registerReceiver(receiver, f);
        }
    }

    /**
     * Snapshot for one day, or null when nothing was observed.
     *
     * A charging-only day (phone on the charger, screen never on) also returns
     * null: `CircadianDaily` requires `firstActiveAt`/`lastActiveAt`, and filling
     * them with 0 would mean "active at 1970". We lose the charging hours for
     * that day rather than send a row that is not true — the row is optional in
     * C's envelope, a wrong timestamp is not.
     */
    static CircadianSnapshot read(Context ctx, String day) {
        SharedPreferences p = prefs(ctx);
        long first = p.getLong(key(day, "first"), 0L);
        long last = p.getLong(key(day, "last"), 0L);
        if (first == 0L && last == 0L) return null;
        return new CircadianSnapshot(
                day,
                first == 0L ? last : first,
                last == 0L ? first : last,
                p.getInt(key(day, "night"), 0),
                p.getLong(key(day, "chargeMs"), 0L) / 3_600_000.0);
    }

    // ----------------------------------------------------------------------- //

    /**
     * First screen-unlock of `day`, or 0 when nothing was observed.
     *
     * Package-private for {@link DigitalSkillRecorder}: "how long after waking
     * the phone did he actually do something" needs the unlock stamp, and
     * duplicating this prefs layout in a second class is how the two recorders
     * would drift apart. 0 means "unknown", never "midnight".
     */
    static long firstActiveAt(Context ctx, String day) {
        return prefs(ctx).getLong(key(day, "first"), 0L);
    }

    private static void handle(Context ctx, Intent intent) {
        String action = intent.getAction();
        long now = System.currentTimeMillis();
        String day = dayKey(now);
        SharedPreferences p = prefs(ctx);
        SharedPreferences.Editor e = p.edit();

        boolean active = Intent.ACTION_SCREEN_ON.equals(action)
                || Intent.ACTION_USER_PRESENT.equals(action);

        if (active) {
            if (p.getLong(key(day, "first"), 0L) == 0L) e.putLong(key(day, "first"), now);
            e.putLong(key(day, "last"), now);
            if (isNight(now)) {
                e.putInt(key(day, "night"), p.getInt(key(day, "night"), 0) + 1);
            }
        }

        if (Intent.ACTION_POWER_CONNECTED.equals(action)) {
            chargingSince = now;
        } else if (Intent.ACTION_POWER_DISCONNECTED.equals(action)) {
            if (chargingSince > 0L) {
                long add = Math.max(0L, now - chargingSince);
                e.putLong(key(day, "chargeMs"), p.getLong(key(day, "chargeMs"), 0L) + add);
                chargingSince = 0L;
            }
        }

        rememberDay(p, e, day);
        e.apply();
    }

    /** Keeps only the two most recent day keys so prefs cannot grow forever. */
    private static void rememberDay(SharedPreferences p, SharedPreferences.Editor e, String day) {
        String csv = p.getString("days", "");
        Set<String> days = new LinkedHashSet<>();
        if (!csv.isEmpty()) {
            for (String s : csv.split(",")) if (!s.isEmpty()) days.add(s);
        }
        if (days.contains(day)) return;
        days.add(day);
        while (days.size() > 2) {
            String oldest = days.iterator().next();
            days.remove(oldest);
            for (String suffix : new String[] {"first", "last", "night", "chargeMs"}) {
                e.remove(key(oldest, suffix));
            }
        }
        e.putString("days", String.join(",", days));
    }

    private static boolean isNight(long at) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(at);
        int h = c.get(Calendar.HOUR_OF_DAY);
        return h >= NIGHT_FROM_HOUR || h < NIGHT_TO_HOUR;
    }

    static String dayKey(long at) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(at);
        return String.format(
                "%04d-%02d-%02d",
                c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));
    }

    private static String key(String day, String suffix) {
        return "d" + day + "_" + suffix;
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Plain data holder — avoids a JSON dependency in a broadcast receiver. */
    static final class CircadianSnapshot {
        final String day;
        final long firstActiveAt;
        final long lastActiveAt;
        final int nightWakeCount;
        final double chargingHours;

        CircadianSnapshot(String day, long first, long last, int night, double chargeHours) {
            this.day = day;
            this.firstActiveAt = first;
            this.lastActiveAt = last;
            this.nightWakeCount = night;
            this.chargingHours = Math.min(24.0, Math.max(0.0, chargeHours));
        }
    }
}
