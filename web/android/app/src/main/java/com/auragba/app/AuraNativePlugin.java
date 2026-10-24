package com.auragba.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.Location;
import android.location.LocationManager;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import java.util.Locale;
import java.util.UUID;

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
 *   voice out          speak / stopSpeak                        -> TextToSpeech
 *
 * `speak` is owned by workflow A (audio.ts#speak asks it first, Web Speech is the
 * fallback); the rest are B's. Keeping both in one plugin is what lets a single
 * WebView seam cover the whole shell.
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
    private static final String TTS_UTTERANCE_PREFIX = "aura-tts-";

    // --- native TTS (the boy-ish preset arrives from audio.ts#BOY_VOICE) -----
    private TextToSpeech tts;
    private boolean ttsReady;
    private PluginCall pendingSpeak;
    private String pendingUtteranceId;
    private String queuedText;
    private String queuedLocale;
    private float queuedPitch = 1.35f;
    private float queuedRate = 0.9f;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

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

    /**
     * One-shot alarm. `at` is epoch ms computed on the JS side (the model only
     * reports a clock time; see toolExec.ts#alarmAtFrom for why).
     */
    @PluginMethod
    public void scheduleOnce(PluginCall call) {
        Long at = call.getLong("at");
        String label = call.getString("label", "");
        JSObject ret = new JSObject();
        if (at == null) {
            ret.put("ok", false);
            call.resolve(ret);
            return;
        }
        boolean ok = AlarmScheduler.scheduleOnce(getContext(), at, label);
        ret.put("ok", ok);
        ret.put("exact", AlarmScheduler.wasExact(getContext()));
        call.resolve(ret);
    }

    @PluginMethod
    public void cancelOnce(PluginCall call) {
        AlarmScheduler.cancelOnce(getContext());
        call.resolve();
    }

    // --- circadian rollup (screen/unlock/charging; no permission) --------------

    /** Registers the dynamic receiver. Safe to call on every app start. */
    @PluginMethod
    public void circadianStart(PluginCall call) {
        CircadianRecorder.start(getContext());
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /**
     * One day's screen/unlock/charging rollup, or EMPTY when nothing was
     * observed — the JS side then omits the row instead of sending zeros.
     */
    @PluginMethod
    public void getCircadian(PluginCall call) {
        String day = call.getString("day", CircadianRecorder.dayKey(System.currentTimeMillis()));
        CircadianRecorder.CircadianSnapshot snap = CircadianRecorder.read(getContext(), day);
        JSObject ret = new JSObject();
        if (snap == null) {
            call.resolve(ret);
            return;
        }
        ret.put("day", snap.day);
        ret.put("firstActiveAt", snap.firstActiveAt);
        ret.put("lastActiveAt", snap.lastActiveAt);
        ret.put("nightWakeCount", snap.nightWakeCount);
        ret.put("chargingHours", snap.chargingHours);
        call.resolve(ret);
    }

    // --- native TTS (boy timbre; no cloud, no text leaves the phone) --------

    /**
     * Speaks one line with Android's own TextToSpeech engine. The call resolves
     * when the utterance finishes, so the WebView's lip-sync promise and the
     * "speaking" state end together. A barge-in resolves `stopped`, NOT a
     * failure — JS must not retry it through Web Speech.
     *
     * `pitch` / `rate` come from audio.ts#BOY_VOICE so the native and browser
     * paths sound like the same character. There is no real child voice in
     * Android TTS; pitch is the honest approximation.
     */
    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty()) {
            resolveSpeak(call, false, false);
            return;
        }
        queuedText = text;
        queuedLocale = call.getString("locale", "zh-HK");
        Double pitch = call.getDouble("pitch", 1.35);
        Double rate = call.getDouble("rate", 0.9);
        queuedPitch = clamp(pitch == null ? 1.35f : pitch.floatValue(), 0.5f, 2.0f);
        queuedRate = clamp(rate == null ? 0.9f : rate.floatValue(), 0.5f, 2.0f);

        // New speech wins: tell the previous JS caller it was interrupted.
        if (pendingSpeak != null) {
            resolveSpeak(pendingSpeak, false, true);
            pendingSpeak = null;
        }
        if (tts == null) {
            pendingSpeak = call;
            tts = new TextToSpeech(getContext(), this::onTtsInit);
            return;
        }
        if (!ttsReady) {
            pendingSpeak = call;
            return;
        }
        speakQueued(call);
    }

    @PluginMethod
    public void stopSpeak(PluginCall call) {
        if (tts != null) tts.stop();
        PluginCall pending = pendingSpeak;
        pendingSpeak = null;
        pendingUtteranceId = null;
        if (pending != null) resolveSpeak(pending, false, true);
        call.resolve();
    }

    private void onTtsInit(int status) {
        if (status != TextToSpeech.SUCCESS) {
            if (pendingSpeak != null) {
                resolveSpeak(pendingSpeak, false, false);
                pendingSpeak = null;
            }
            if (tts != null) {
                tts.shutdown();
                tts = null;
            }
            ttsReady = false;
            return;
        }
        ttsReady = true;
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String utteranceId) {
                // Mouth timing is driven by the WebView (viseme.ts); nothing to do.
            }

            @Override
            public void onDone(String utteranceId) {
                completeUtterance(utteranceId, true);
            }

            @Override
            public void onError(String utteranceId) {
                completeUtterance(utteranceId, false);
            }

            @Override
            public void onError(String utteranceId, int errorCode) {
                completeUtterance(utteranceId, false);
            }
        });
        if (pendingSpeak != null) {
            PluginCall call = pendingSpeak;
            pendingSpeak = null;
            if (queuedText != null) speakQueued(call);
            else resolveSpeak(call, false, false);
        }
    }

    private void speakQueued(PluginCall call) {
        if (queuedText == null) {
            resolveSpeak(call, false, false);
            return;
        }
        Locale locale = Locale.forLanguageTag(
                (queuedLocale == null ? "zh-HK" : queuedLocale).replace('_', '-'));
        int availability = tts.setLanguage(locale);
        if (availability == TextToSpeech.LANG_MISSING_DATA
                || availability == TextToSpeech.LANG_NOT_SUPPORTED) {
            // Cantonese is not universal on Android. Prefer the other Chinese
            // variant to silence, but the returned timbre is still pitch-shifted.
            Locale chinese = isCantonese(queuedLocale)
                    ? Locale.TRADITIONAL_CHINESE : Locale.SIMPLIFIED_CHINESE;
            availability = tts.setLanguage(chinese);
        }
        if (availability == TextToSpeech.LANG_MISSING_DATA
                || availability == TextToSpeech.LANG_NOT_SUPPORTED) {
            resolveSpeak(call, false, false);
            return;
        }
        tts.setPitch(queuedPitch);
        tts.setSpeechRate(queuedRate);

        String utteranceId = TTS_UTTERANCE_PREFIX + UUID.randomUUID();
        pendingSpeak = call;
        pendingUtteranceId = utteranceId;
        int status = tts.speak(queuedText, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
        if (status == TextToSpeech.ERROR) {
            pendingSpeak = null;
            pendingUtteranceId = null;
            resolveSpeak(call, false, false);
        }
    }

    private void completeUtterance(String utteranceId, boolean ok) {
        mainHandler.post(() -> {
            if (utteranceId == null || !utteranceId.equals(pendingUtteranceId)) return;
            pendingUtteranceId = null;
            PluginCall call = pendingSpeak;
            pendingSpeak = null;
            if (call != null) resolveSpeak(call, ok, false);
        });
    }

    private void resolveSpeak(PluginCall call, boolean ok, boolean stopped) {
        JSObject ret = new JSObject();
        ret.put("ok", ok);
        if (stopped) ret.put("stopped", true);
        call.resolve(ret);
    }

    private static boolean isCantonese(String locale) {
        if (locale == null) return false;
        String l = locale.toLowerCase(Locale.ROOT);
        return l.contains("hk") || l.contains("mo") || l.contains("yue");
    }

    private static float clamp(float value, float min, float max) {
        return Math.max(min, Math.min(max, value));
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
        }
        ttsReady = false;
        super.handleOnDestroy();
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
