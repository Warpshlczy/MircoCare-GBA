package com.auragba.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Restores native state after a reboot or an app update.
 *
 * Hard rule (docs/dev.md §2.7 ⑥ / §3.4 B7): re-arm the alarm and refresh the
 * widget, but never launch the UI and never make a sound. A senior turning the
 * phone on at 6am must not be greeted by a talking avatar.
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            AlarmScheduler.rescheduleFromPrefs(ctx);
            AlarmScheduler.rescheduleOnceFromPrefs(ctx);
            HomeWidgetProvider.refresh(ctx);
        }
    }
}
