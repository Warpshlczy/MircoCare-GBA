package com.auragba.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.Location;
import android.location.LocationManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
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
 * Eight methods, grouped by the platform ceiling they lift:
 *   mic while locked   startBackgroundWake / stopBackgroundWake -> WakeListenService
 *   home screen        updateHomeWidget                         -> HomeWidgetProvider
 *   come to front      bringToForeground(reason)                -> MainActivity intent
 *   OS timer           scheduleDaily / cancelDaily              -> AlarmScheduler
 *   coarse position    getLocation                              -> LocationManager
 *   permissions        openAccessibilitySettings                -> Settings
 *
 * Plus `consumePendingReason()`, which is not a capability but a delivery
 * patch: `onCreate` can run before the WebView has a listener, so the launch
 * reason is buffered and drained here (see MainActivity.deliver).
 *
 * Everything degrades: a denied permission resolves to null/false rather than
 * rejecting, because a rejection would surface as a crash path in the senior's
 * conversation.
 */
@CapacitorPlugin(
        name = "AuraNative",
        permissions = {
                @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "mic"),
                @Permission(
                        strings = {
                                Manifest.permission.ACCESS_FINE_LOCATION,
                                Manifest.permission.ACCESS_COARSE_LOCATION
                        },
                        alias = "location"
                )
        }
)
public class AuraNativePlugin extends Plugin {

    private static final String MIC = "mic";
    private static final String LOCATION = "location";

    // --- wake word while backgrounded/locked ---------------------------------

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

    // --- home-screen widget --------------------------------------------------

    /**
     * Caches the payload (matches HomeWidgetPayload in web/src/lib/native.ts) and
     * re-renders every placed widget instance.
     *
     * Capacitor flattens a single JS argument into the call's options, so the JS
     * call `updateHomeWidget(payload)` arrives as top-level keys here.
     */
    @PluginMethod
    public void updateHomeWidget(PluginCall call) {
        String title = call.getString("title", "");
        JSArray items = call.getArray("items", new JSArray());
        Long updatedAt = call.getLong("updatedAt", System.currentTimeMillis());

        SharedPreferences prefs =
                getContext().getSharedPreferences(HomeWidgetProvider.PREFS, Context.MODE_PRIVATE);
        prefs.edit()
                .putString(HomeWidgetProvider.KEY_TITLE, title)
                .putString(HomeWidgetProvider.KEY_ITEMS, items == null ? "[]" : items.toString())
                .putLong(HomeWidgetProvider.KEY_UPDATED,
                        updatedAt == null ? System.currentTimeMillis() : updatedAt)
                .apply();

        HomeWidgetProvider.refresh(getContext());
        call.resolve();
    }

    // --- bring the WebView forward ------------------------------------------

    /**
     * Brings MainActivity to the front, carrying WHY (widget | alarm | reminder |
     * notification | boot). MainActivity turns that reason into the
     * `memomate:foreground` window event.
     */
    @PluginMethod
    public void bringToForeground(PluginCall call) {
        String reason = call.getString("reason", "notification");
        Intent intent = new Intent(getContext(), MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                .putExtra(MainActivity.EXTRA_REASON, reason);
        try {
            getContext().startActivity(intent);
        } catch (Exception e) {
            call.reject("cannot bring to foreground: " + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    // --- daily OS timer ------------------------------------------------------

    @PluginMethod
    public void scheduleDaily(PluginCall call) {
        Integer hour = call.getInt("hour", 8);
        Integer minute = call.getInt("minute", 0);
        int h = hour == null ? 8 : hour;
        int m = minute == null ? 0 : minute;
        if (h < 0 || h > 23 || m < 0 || m > 59) {
            call.reject("hour/minute out of range");
            return;
        }

        boolean scheduled = AlarmScheduler.scheduleDaily(getContext(), h, m);
        if (!scheduled) {
            call.reject("alarm could not be scheduled");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        // false = the OS refused exact alarms and we fell back to a window (±15min)
        ret.put("exact", AlarmScheduler.wasExact(getContext()));
        call.resolve(ret);
    }

    @PluginMethod
    public void cancelDaily(PluginCall call) {
        AlarmScheduler.cancel(getContext());
        call.resolve();
    }

    // --- coarse position (foreground only) -----------------------------------

    /** Last known fix, foreground only. Resolves EMPTY when denied or unknown. */
    @PluginMethod
    public void getLocation(PluginCall call) {
        if (getPermissionState(LOCATION) != PermissionState.GRANTED) {
            requestPermissionForAlias(LOCATION, call, "locationPermissionCallback");
            return;
        }
        resolveLocation(call);
    }

    @PermissionCallback
    private void locationPermissionCallback(PluginCall call) {
        if (getPermissionState(LOCATION) == PermissionState.GRANTED) {
            resolveLocation(call);
        } else {
            call.resolve(); // denied is a normal outcome -> JS maps {} to null
        }
    }

    private void resolveLocation(PluginCall call) {
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) {
            call.resolve();
            return;
        }

        Location best = null;
        String[] providers = {LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER};
        for (String provider : providers) {
            try {
                if (!lm.isProviderEnabled(provider)) continue;
                Location candidate = lm.getLastKnownLocation(provider);
                if (candidate != null && (best == null || candidate.getTime() > best.getTime())) {
                    best = candidate;
                }
            } catch (SecurityException ignored) {
                // permission revoked between the check and the call
            }
        }

        if (best == null) {
            call.resolve(); // no fix yet -> null on the JS side, never a fake 0,0
            return;
        }

        JSObject ret = new JSObject();
        ret.put("lat", best.getLatitude());
        ret.put("lng", best.getLongitude());
        ret.put("accuracy", best.getAccuracy());
        ret.put("at", best.getTime());
        call.resolve(ret);
    }

    // --- accessibility (W4: AutoPilot) ---------------------------------------

    /**
     * Opens the system accessibility list. The user must enable the service there:
     * an AccessibilityService can NEVER be switched on programmatically, so there
     * is no "enable" method on purpose.
     */
    @PluginMethod
    public void openAccessibilitySettings(PluginCall call) {
        try {
            getContext().startActivity(
                    new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            call.reject("cannot open accessibility settings: " + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    // --- launch-reason delivery patch ---------------------------------------

    /** Drains the reason buffered before the WebView had a listener. */
    @PluginMethod
    public void consumePendingReason(PluginCall call) {
        JSObject pending = MainActivity.consumePending(getContext());
        if (pending == null) {
            call.resolve();
            return;
        }
        call.resolve(pending);
    }
}
