package com.auragba.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;

/**
 * Fires once a day (see {@link AlarmScheduler}) and does exactly two things:
 * re-arm tomorrow, then post a high-priority notification. Tapping it opens
 * MainActivity with reason=alarm so the assistant greets the senior proactively.
 *
 * Deliberately does NOT start the activity by itself: background activity
 * launches are restricted on Android 10+ and a surprise full-screen takeover is
 * exactly the "清晨惊吓" docs/dev.md §2.7 ⑥ warns about.
 */
public class DailyAlarmReceiver extends BroadcastReceiver {

    static final String ACTION_DAILY = "com.auragba.app.DAILY_ALARM";
    private static final String CHANNEL_ID = "memomate_alarm";
    private static final int NOTIF_ID = 8802;
    private static final int CONTENT_REQUEST = 8803;

    @Override
    public void onReceive(Context ctx, Intent intent) {
        // Re-arm first: if anything below throws, tomorrow still works.
        AlarmScheduler.rescheduleFromPrefs(ctx);
        postNotification(ctx);
    }

    private void postNotification(Context ctx) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel =
                    new NotificationChannel(CHANNEL_ID, ctx.getString(R.string.notif_channel_daily),
                            NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription(ctx.getString(R.string.notif_channel_daily_desc));
            nm.createNotificationChannel(channel);
        }

        Intent open = new Intent(ctx, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                .putExtra(MainActivity.EXTRA_REASON, "alarm");

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent content = PendingIntent.getActivity(ctx, CONTENT_REQUEST, open, flags);

        Notification n = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(ctx.getString(R.string.app_name))
                .setContentText(ctx.getString(R.string.notif_daily_body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setAutoCancel(true)
                .setContentIntent(content)
                .build();

        try {
            nm.notify(NOTIF_ID, n);
        } catch (SecurityException ignored) {
            // POST_NOTIFICATIONS revoked — the alarm still re-armed above.
        }
    }
}
