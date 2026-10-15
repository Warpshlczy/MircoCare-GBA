package com.auragba.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * AuraNative — the Android end of the ONE native seam declared in
 * web/src/lib/native.ts. The web app calls it through window.Capacitor.Plugins.
 *
 * startBackgroundWake / stopBackgroundWake drive {@link WakeListenService}, which
 * keeps listening for the assistant's name while the app is backgrounded (req 2).
 * The remaining methods are still stubs and degrade gracefully on the JS side.
 */
@CapacitorPlugin(
        name = "AuraNative",
        permissions = @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "mic")
)
public class AuraNativePlugin extends Plugin {

    private static final String MIC = "mic";

    /**
     * Start the foreground microphone service so the wake name can be heard while
     * the app is backgrounded or the screen is locked. Requests RECORD_AUDIO first.
     */
    @PluginMethod
    public void startBackgroundWake(PluginCall call) {
        if (getPermissionState(MIC) != PermissionState.GRANTED) {
            requestPermissionForAlias(MIC, call, "micPermissionCallback");
            return;
        }
        startWakeService(call);
    }

    @PermissionCallback
    private void micPermissionCallback(PluginCall call) {
        if (getPermissionState(MIC) == PermissionState.GRANTED) {
            startWakeService(call);
        } else {
            call.reject("microphone permission denied");
        }
    }

    private void startWakeService(PluginCall call) {
        Context ctx = getContext();
        Intent svc = new Intent(ctx, WakeListenService.class).setAction(WakeListenService.ACTION_START);
        // startForegroundService: the service calls startForeground() immediately in
        // onStartCommand, so the 5s window is satisfied.
        ContextCompat.startForegroundService(ctx, svc);
        JSObject ret = new JSObject();
        ret.put("started", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void stopBackgroundWake(PluginCall call) {
        getContext().stopService(new Intent(getContext(), WakeListenService.class));
        call.resolve();
    }

    /**
     * Push the latest cards/reminders to the OS home-screen widget.
     *
     * TODO: persist the payload (matches HomeWidgetPayload in web/src/lib/native.ts)
     *       and notify the AppWidgetProvider to re-render.
     */
    @PluginMethod
    public void updateHomeWidget(PluginCall call) {
        call.resolve();
    }

    /** TODO: deep-link / bring the WebView forward (used by the daily check-in). */
    @PluginMethod
    public void bringToForeground(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }
}