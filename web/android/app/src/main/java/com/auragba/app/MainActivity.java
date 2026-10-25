package com.auragba.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;

/**
 * The WebView host. Two jobs beyond Capacitor's defaults:
 *
 * 1. Tell JS *why* it was brought forward. Without `onNewIntent` the intent is
 *    silently dropped when the activity already exists (`launchMode=singleTask`),
 *    so `bringToForeground("alarm")` would degrade into "some greeting or other".
 * 2. Keep that reason in SharedPreferences as well, because `onCreate` can fire
 *    before the WebView has attached a listener. The plugin's
 *    `consumePendingReason()` drains it on startup.
 *
 * Declared `showWhenLocked` in the manifest so the widget's SOS hot zone works
 * without unlocking.
 */
public class MainActivity extends BridgeActivity {

    /** Extra carrying one of: widget | alarm | reminder | notification | boot. */
    public static final String EXTRA_REASON = "reason";
    /**
     * Extra naming a screen to open on arrival. A CLOSED set on purpose: this
     * activity is `showWhenLocked`, so an intent extra that could name any route
     * would let whoever taps the widget drive a locked phone. Unknown values are
     * dropped by {@link #safeOpen(String)} on both the Java and the JS side.
     */
    public static final String EXTRA_OPEN = "open";
    /** Action set by the widget's SOS hot zone. */
    public static final String ACTION_SOS = "com.auragba.app.SOS";

    static final String EVENT_FOREGROUND = "memomate:foreground";
    static final String EVENT_SOS = "memomate:sos";

    private static final String PREFS = "memomate_pending";
    private static final String KEY_REASON = "pending_reason";
    private static final String KEY_AT = "pending_at";
    private static final String KEY_SOS = "pending_sos";
    private static final String KEY_OPEN = "pending_open";

    /** The only deep links the widget may request. Mirrors native.ts. */
    private static String safeOpen(String open) {
        return "record".equals(open) ? open : null;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom plugins BEFORE super.onCreate().
        registerPlugin(AuraNativePlugin.class);
        super.onCreate(savedInstanceState);
        deliver(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent); // so getIntent() reflects the newest reason
        deliver(intent);
    }

    private void deliver(Intent intent) {
        if (intent == null) return;

        final boolean sos = ACTION_SOS.equals(intent.getAction());
        String reason = intent.getStringExtra(EXTRA_REASON);
        if (reason == null && !sos) return; // a plain launcher tap: nothing to say
        if (reason == null) reason = "widget";
        final String open = safeOpen(intent.getStringExtra(EXTRA_OPEN));
        final long at = System.currentTimeMillis();

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        prefs.edit()
                .putString(KEY_REASON, reason)
                .putLong(KEY_AT, at)
                .putBoolean(KEY_SOS, sos)
                .putString(KEY_OPEN, open)
                .apply();

        if (getBridge() == null) return; // WebView not ready; consumePendingReason() will deliver it

        JSObject data = new JSObject();
        data.put("reason", reason);
        data.put("at", at);
        if (open != null) data.put("open", open);
        getBridge().triggerWindowJSEvent(EVENT_FOREGROUND, data.toString());

        if (sos) {
            JSObject s = new JSObject();
            s.put("at", at);
            getBridge().triggerWindowJSEvent(EVENT_SOS, s.toString());
        }
    }

    /**
     * Drains the reason captured before the WebView had a listener.
     * Returns null when there is nothing pending (the first plain launch).
     */
    static JSObject consumePending(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String reason = prefs.getString(KEY_REASON, null);
        if (reason == null) return null;

        JSObject out = new JSObject();
        out.put("reason", reason);
        out.put("at", prefs.getLong(KEY_AT, 0L));
        out.put("sos", prefs.getBoolean(KEY_SOS, false));
        String open = safeOpen(prefs.getString(KEY_OPEN, null));
        if (open != null) out.put("open", open);
        prefs.edit().clear().apply();
        return out;
    }
}
