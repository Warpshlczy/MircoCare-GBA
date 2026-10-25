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
 * Fires once for a one-shot alarm ("聽日八點叫我") and does NOT re-arm.
 *
 * Two rules it follows, both from the daily alarm's lessons:
 *  - It never launches the activity. Android 10+ restricts background activity
 *    starts, and a full-screen takeover is the "清晨惊吓" docs/dev.md §2.7 ⑥ warns
 *    about; the notification tap carries reason=alarm instead.
 *  - The label travels in the intent. At 8am the WebView may not be alive, so
 *    the receiver cannot ask JS what this alarm was for.
 */
public class OnceAlarmReceiver extends BroadcastReceiver {

    static final String ACTION_ONCE = "com.auragba.app.ONCE_ALARM";
    static final String EXTRA_LABEL = "label";
    /** Which alarm fired — the slot must be retired, and the others must not be. */
    static final String EXTRA_SLOT = "slot";

    private static final String CHANNEL_ID = "memomate_alarm";
    private static final int NOTIF_ID = 8805;
    private static final int CONTENT_REQUEST = 8806;

    @Override
    public void onReceive(Context ctx, Intent intent) {
        // Retire ONLY the slot that fired; a reboot must not replay it, and the
        // senior's other alarms must survive this one.
        String slot = intent == null ? null : intent.getStringExtra(EXTRA_SLOT);
        String key = slot == null || slot.isEmpty() ? AlarmScheduler.DEFAULT_SLOT : slot;
        AlarmScheduler.clearOnce(ctx, key);
        String label = intent == null ? "" : intent.getStringExtra(EXTRA_LABEL);
        postNotification(ctx, label == null ? "" : label.trim(), key);
    }

    private void postNotification(Context ctx, String label, String slot) {
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

        // The label is the point: "食藥" tells him what to do without unlocking.
        String body = label.isEmpty() ? ctx.getString(R.string.notif_daily_body) : label;

        Notification n = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(ctx.getString(R.string.app_name))
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setAutoCancel(true)
                .setContentIntent(content)
                .build();

        try {
            // One notification id PER SLOT: with several alarms armed, a fixed id
            // would make the second firing silently replace the first one's
            // notification, and the senior would never see that he missed a dose.
            nm.notify(NOTIF_ID + Math.abs(slot.hashCode() % 1000), n);
        } catch (SecurityException ignored) {
            // POST_NOTIFICATIONS revoked — nothing else to do here.
        }
    }
}
