package com.auragba.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.location.Location;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;

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
 *   voice out          speak / stopSpeak / warmTts               -> NeuralTts, then TextToSpeech
 *
 * `speak` is owned by workflow A (audio.ts#speak asks it first, Web Speech is the
 * fallback); the rest are B's. Keeping both in one plugin is what lets a single
 * WebView seam cover the whole shell.
 *
 * Voice: a bundled VITS model (sherpa-onnx, NeuralTts) speaks first. Android's
 * own TextToSpeech is the fallback for the first line of a cold start (while
 * the model loads) and for builds where the assets are absent. Both stay on the
 * phone — nothing is sent to a cloud synthesiser (PDPO data minimisation).
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
    private static final String TAG = "AuraTTS";

    // --- native TTS (the boy-ish preset arrives from audio.ts#BOY_VOICE) -----
    private TextToSpeech tts;
    private boolean ttsReady;
    private PluginCall pendingSpeak;
    private String pendingUtteranceId;
    private String queuedText;
    private String queuedLocale;
    private float queuedPitch = 1.35f;
    private float queuedRate = 0.9f;
    private boolean utteranceStarted;
    private Runnable initWatchdog;
    private Runnable startWatchdog;
    private Runnable doneWatchdog;
    private Runnable neuralWatchdog;
    private Runnable neuralGrace;
    private boolean focusHeld;
    /** Volume we borrowed from: -1 means "we did not touch STREAM_MUSIC". */
    private int savedVolume = -1;
    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {};
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    /** The bundled neural child voice; null-ish when assets are absent. */
    private NeuralTts neural;
    private String queuedPreset = "warm";

    /**
     * Model load is ~1–3 s on a handset. A line must not wait that long: give it
     * a short grace window, then speak through the system engine and use the
     * neural voice from the next line on. Never silence.
     */
    private static final long NEURAL_GRACE_MS = 1600L;

    @Override
    public void load() {
        ensureNeural();
    }

    /** Lazily created, so an older shell or a bad context never breaks speech. */
    private NeuralTts ensureNeural() {
        if (neural != null) return neural;
        try {
            neural = new NeuralTts(getContext());
        } catch (Throwable e) {
            Log.w(TAG, "neural voice unavailable in this build", e);
        }
        return neural;
    }

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
        // One "already done today" line, pre-formatted by JS (native.ts keeps the
        // icon/time/clip rules pure and tested, so the widget adds no text of its own).
        // The WHOLE object is stored, not just the text: the widget must survive a
        // process death without the WebView, and `at` is what lets the provider
        // hide the row once the day has turned (a stale "已食藥" is a double dose).
        JSObject record = call.getObject("record");
        Long updatedAt = call.getLong("updatedAt", System.currentTimeMillis());

        SharedPreferences prefs =
                getContext().getSharedPreferences(HomeWidgetProvider.PREFS, Context.MODE_PRIVATE);
        prefs.edit()
                .putString(HomeWidgetProvider.KEY_TITLE, title)
                .putString(HomeWidgetProvider.KEY_ITEMS, items == null ? "[]" : items.toString())
                .putString(HomeWidgetProvider.KEY_RECORD, record == null ? "" : record.toString())
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
     *
     * `slot` names which alarm this is, and several may be armed at once — the
     * JS side passes the record id. A missing slot falls back to the legacy
     * single slot instead of failing: an older WebView must keep working.
     */
    @PluginMethod
    public void scheduleOnce(PluginCall call) {
        Long at = call.getLong("at");
        String label = call.getString("label", "");
        String slot = call.getString("slot", AlarmScheduler.DEFAULT_SLOT);
        JSObject ret = new JSObject();
        if (at == null) {
            ret.put("ok", false);
            call.resolve(ret);
            return;
        }
        boolean ok = AlarmScheduler.scheduleOnce(getContext(), at, label, slot);
        ret.put("ok", ok);
        ret.put("slot", AlarmScheduler.DEFAULT_SLOT.equals(slot) ? null : slot);
        ret.put("exact", AlarmScheduler.wasExact(getContext()));
        call.resolve(ret);
    }

    /**
     * Cancels ONE slot. Without a slot this cancels the legacy single alarm only;
     * it never clears every alarm, because a caller that lost its slot id must
     * not be able to silence the doses the senior depends on.
     */
    @PluginMethod
    public void cancelOnce(PluginCall call) {
        String slot = call.getString("slot", AlarmScheduler.DEFAULT_SLOT);
        AlarmScheduler.cancelOnce(getContext(), slot);
        call.resolve();
    }

    /**
     * What the OS actually holds. Not a capability — the reconcile patch.
     *
     * JS writes the alarm record first and arms the OS second, so a process
     * death in between leaves a record with nothing armed, and the senior's
     * "聽日八點" would silently never ring. Reading the scheduler back is the
     * only way the app can notice; see native.ts#reconcileOnceAlarm.
     */
    @PluginMethod
    public void getScheduledAlarms(PluginCall call) {
        JSObject ret = new JSObject();
        // Absent key = nothing armed; the JS mapper normalises absent to null.
        JSObject daily = AlarmScheduler.readDaily(getContext());
        if (daily != null) ret.put("daily", daily);
        // `once` is an ARRAY since multi-slot: several alarms can be armed at
        // once, and a single object here is what made the second alarm invisible
        // to the reconciler while `records` still listed both.
        ret.put("once", AlarmScheduler.readOnceAll(getContext()));
        call.resolve(ret);
    }

    // --- dial / launch (no permission, no clicking on his behalf) -------------

    /**
     * Opens the dialler PREFILLED. It does not place the call: pressing the call
     * button stays the senior's own act, which is why ACTION_DIAL (not
     * ACTION_CALL) is used and CALL_PHONE is not requested.
     */
    @PluginMethod
    public void dial(PluginCall call) {
        String phone = call.getString("phone", "");
        JSObject ret = new JSObject();
        String cleaned = phone == null ? "" : phone.replaceAll("[\\s\\-()]", "");
        if (cleaned.isEmpty()) {
            ret.put("ok", false);
            call.resolve(ret);
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + cleaned));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            ret.put("ok", true);
        } catch (Exception e) {
            ret.put("ok", false);
        }
        call.resolve(ret);
    }

    /**
     * Launches one whitelisted app by intent. Deliberately NOT via the
     * accessibility service: clicking inside another app on the senior's behalf
     * can confirm a payment or dismiss an alert, and this path cannot.
     */
    @PluginMethod
    public void openApp(PluginCall call) {
        String key = call.getString("app", "");
        JSObject ret = new JSObject();
        Intent i = null;
        if ("wechat".equals(key)) {
            i = getContext().getPackageManager().getLaunchIntentForPackage("com.tencent.mm");
        } else if ("phone".equals(key)) {
            i = new Intent(Intent.ACTION_DIAL);
        } else if ("camera".equals(key)) {
            i = new Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA);
        } else if ("settings".equals(key)) {
            i = new Intent(Settings.ACTION_SETTINGS);
        }
        if (i == null) {
            ret.put("ok", false);
            call.resolve(ret);
            return;
        }
        try {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            ret.put("ok", true);
        } catch (Exception e) {
            ret.put("ok", false);
        }
        call.resolve(ret);
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

    /**
     * Whether PACKAGE_USAGE_STATS is granted.
     *
     * Asked, never demanded — the JS layer only checks this to decide whether the
     * `digitalSkill` row can be read at all, and never opens a settings screen on
     * its own. See DigitalSkillRecorder for why an empty query is not an answer.
     */
    @PluginMethod
    public void hasUsageAccess(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ok", DigitalSkillRecorder.hasAccess(getContext()));
        call.resolve(ret);
    }

    /**
     * Opens the system usage-access list so a FAMILY member can grant it.
     *
     * An AppOps permission can never be granted programmatically — this only
     * navigates. Falls back to the app's own settings page when the OEM hides the
     * usage-access screen, so the tap is never a no-op.
     */
    @PluginMethod
    public void openUsageAccessSettings(PluginCall call) {
        JSObject ret = new JSObject();
        boolean opened = false;
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_USAGE_ACCESS_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            opened = true;
        } catch (Exception e) {
            opened = false;
        }
        if (!opened) {
            try {
                Intent i = new Intent(android.provider.Settings.ACTION_SETTINGS);
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
                opened = true;
            } catch (Exception ignored) {
                opened = false;
            }
        }
        ret.put("ok", opened);
        call.resolve(ret);
    }

    /**
     * One day's usage-stats row, or EMPTY when the permission is off or nothing
     * was observed — the JS side then omits the row instead of sending zeros.
     */
    @PluginMethod
    public void getDigitalSkill(PluginCall call) {
        String day = call.getString("day", CircadianRecorder.dayKey(System.currentTimeMillis()));
        JSObject snap = DigitalSkillRecorder.snapshot(getContext(), day);
        call.resolve(snap == null ? new JSObject() : snap);
    }

    // --- native TTS (boy timbre; no cloud, no text leaves the phone) --------

    /**
     * Speaks one line with Android's own TextToSpeech engine. The call resolves
     * when the utterance finishes, so the WebView's lip-sync promise and the
     * "speaking" state end together. A barge-in resolves `stopped`, NOT a
     * failure — JS must not retry it through Web Speech.
     *
     * All engine work is posted to the main thread: TextToSpeech delivers its
     * init/progress callbacks on the looper of the creating thread, so creating
     * it from a plugin worker thread can leave the JS promise pending forever.
     * That was the "真机冇聲" bug — the WebView stayed in `speaking` and every
     * later call was starved.
     *
     * `pitch` / `rate` come from audio.ts#BOY_VOICE so the native and browser
     * paths sound like the same character. There is no real child voice in
     * Android TTS; pitch is the honest approximation.
     */
    @PluginMethod
    public void speak(PluginCall call) {
        mainHandler.post(() -> handleSpeak(call));
    }

    /**
     * Warms the neural voice at app start, for the locale the UI is in, so the
     * first line the senior hears is already the good voice. No-op on the web.
     */
    @PluginMethod
    public void warmTts(PluginCall call) {
        String locale = call.getString("locale", "zh-HK");
        NeuralTts n = ensureNeural();
        if (n != null) n.prepare(locale);
        call.resolve();
    }

    private void handleSpeak(PluginCall call) {
        String text = call.getString("text", "");
        if (text == null || text.trim().isEmpty()) {
            resolveSpeak(call, false, false, "empty_text");
            return;
        }
        queuedText = text;
        queuedLocale = call.getString("locale", "zh-HK");
        Double pitch = call.getDouble("pitch", 1.35);
        Double rate = call.getDouble("rate", 0.9);
        queuedPitch = clamp(pitch == null ? 1.35f : pitch.floatValue(), 0.5f, 2.0f);
        queuedRate = clamp(rate == null ? 0.9f : rate.floatValue(), 0.5f, 2.0f);
        queuedPreset = call.getString("preset", "warm");
        Log.i(TAG, "speak " + text.length() + " chars locale=" + queuedLocale
                + " preset=" + queuedPreset + " thread=" + Thread.currentThread().getName());

        // New speech wins: stop whatever is playing and tell the previous JS
        // caller it was interrupted (not failed).
        if (pendingSpeak != null) {
            resolveSpeak(pendingSpeak, false, true, "interrupted");
            pendingSpeak = null;
        }
        if (neural != null) neural.stop();
        cancelWatchdogs();
        requestAudioFocus();

        // 1) the neural child voice, when the model for this locale is loaded
        NeuralTts n = ensureNeural();
        if (n != null && n.isReadyFor(queuedLocale)) {
            speakNeural(call);
            return;
        }
        // 2) still loading: a short grace, then the system engine for THIS line
        if (n != null && !n.isFailed()) {
            n.prepare(queuedLocale);
            pendingSpeak = call;
            armNeuralGrace(call);
            return;
        }
        // 3) no neural assets in this build: the old path, unchanged
        speakWithSystem(call);
    }

    private void armNeuralGrace(PluginCall call) {
        neuralGrace = () -> {
            if (pendingSpeak != call) return;
            if (neural != null && neural.isReadyFor(queuedLocale)) {
                pendingSpeak = null;
                speakNeural(call);
                return;
            }
            Log.i(TAG, "neural not ready within " + NEURAL_GRACE_MS + "ms; system engine speaks this line");
            pendingSpeak = null;
            speakWithSystem(call);
        };
        mainHandler.postDelayed(neuralGrace, NEURAL_GRACE_MS);
    }

    private void speakNeural(PluginCall call) {
        pendingSpeak = call;
        cancelWatchdogs();
        armNeuralWatchdog(call);
        neural.speak(queuedLocale, queuedText, queuedPreset, (ok, reason) -> mainHandler.post(() -> {
            if (pendingSpeak != call) return; // interrupted or stopped already
            cancelNeuralWatchdog();
            if (ok) {
                pendingSpeak = null;
                abandonFocus();
                resolveSpeak(call, true, false, null);
                return;
            }
            if ("stopped".equals(reason)) {
                pendingSpeak = null;
                abandonFocus();
                resolveSpeak(call, false, true, "stopped");
                return;
            }
            // The neural engine refused (missing lib, bad model, OOM): say the
            // same line through the system engine rather than go silent.
            Log.w(TAG, "neural failed (" + reason + "), falling back to system TTS");
            pendingSpeak = null;
            speakWithSystem(call);
        }));
    }

    /**
     * Hard ceiling for one neural line. If the generator wedges, resolve as a
     * failure so the UI leaves "speaking" (a stuck state locks the senior out).
     */
    private void armNeuralWatchdog(PluginCall call) {
        cancelNeuralWatchdog();
        long budget = Math.min(40_000L, Math.max(12_000L, queuedText.length() * 450L + 8_000L));
        neuralWatchdog = () -> {
            if (pendingSpeak != call) return;
            Log.w(TAG, "neural engine exceeded " + budget + "ms");
            if (neural != null) neural.stop();
            pendingSpeak = null;
            abandonFocus();
            resolveSpeak(call, false, false, "neural_timeout");
        };
        mainHandler.postDelayed(neuralWatchdog, budget);
    }

    private void cancelNeuralWatchdog() {
        if (neuralWatchdog != null) mainHandler.removeCallbacks(neuralWatchdog);
        neuralWatchdog = null;
    }

    /** Steps 3+ of the old path: Android TextToSpeech. */
    private void speakWithSystem(PluginCall call) {
        pendingSpeak = call;
        if (tts == null) {
            initTts();
            return;
        }
        if (!ttsReady) {
            armInitWatchdog();
            return;
        }
        speakQueued(call);
    }

    @PluginMethod
    public void stopSpeak(PluginCall call) {
        mainHandler.post(() -> {
            if (neural != null) neural.stop();
            if (tts != null) tts.stop();
            cancelWatchdogs();
            abandonFocus();
            PluginCall pending = pendingSpeak;
            pendingSpeak = null;
            pendingUtteranceId = null;
            if (pending != null) resolveSpeak(pending, false, true, "stopped");
            call.resolve();
        });
    }

    private void initTts() {
        Log.i(TAG, "creating TextToSpeech (system default engine)");
        armInitWatchdog();
        try {
            tts = new TextToSpeech(getContext(), this::onTtsInit);
        } catch (Throwable e) {
            Log.e(TAG, "TextToSpeech constructor failed", e);
            tts = null;
            failPending("init_failed");
        }
    }

    private void armInitWatchdog() {
        if (initWatchdog != null) return;
        initWatchdog = () -> {
            if (ttsReady || pendingSpeak == null) return;
            Log.w(TAG, "init watchdog: engine never reported readiness");
            shutdownTts();
            failPending("init_timeout");
        };
        mainHandler.postDelayed(initWatchdog, 5000L);
    }

    private void onTtsInit(int status) {
        Log.i(TAG, "onTtsInit status=" + status);
        if (status != TextToSpeech.SUCCESS) {
            shutdownTts();
            failPending("init_failed");
            return;
        }
        ttsReady = true;
        cancelInitWatchdog();
        try {
            tts.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
            Log.i(TAG, "engines=" + tts.getEngines() + " voice=" + tts.getVoice());
        } catch (Throwable e) {
            Log.w(TAG, "audio attributes / engine introspection failed", e);
        }
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String utteranceId) {
                mainHandler.post(() -> {
                    Log.i(TAG, "onStart " + utteranceId);
                    utteranceStarted = true;
                    cancelStartWatchdog();
                    armDoneWatchdog(utteranceId);
                });
            }

            @Override
            public void onDone(String utteranceId) {
                Log.i(TAG, "onDone " + utteranceId);
                completeUtterance(utteranceId, true);
            }

            @Override
            public void onError(String utteranceId) {
                Log.e(TAG, "onError " + utteranceId);
                completeUtterance(utteranceId, false);
            }

            @Override
            public void onError(String utteranceId, int errorCode) {
                Log.e(TAG, "onError " + utteranceId + " code=" + errorCode);
                completeUtterance(utteranceId, false);
            }
        });
        if (pendingSpeak != null) {
            PluginCall call = pendingSpeak;
            pendingSpeak = null;
            if (queuedText != null) speakQueued(call);
            else resolveSpeak(call, false, false, "empty_text");
        }
    }

    private void speakQueued(PluginCall call) {
        if (queuedText == null) {
            resolveSpeak(call, false, false, "empty_text");
            return;
        }
        Locale locale = Locale.forLanguageTag(
                (queuedLocale == null ? "zh-HK" : queuedLocale).replace('_', '-'));
        int availability = applyBestLocale(locale);
        Log.i(TAG, "language=" + tts.getLanguage() + " availability=" + availability);
        if (availability == TextToSpeech.LANG_MISSING_DATA
                || availability == TextToSpeech.LANG_NOT_SUPPORTED) {
            resolveSpeak(call, false, false, "lang_missing");
            return;
        }
        tts.setPitch(queuedPitch);
        tts.setSpeechRate(queuedRate);

        String utteranceId = TTS_UTTERANCE_PREFIX + UUID.randomUUID();
        pendingSpeak = call;
        pendingUtteranceId = utteranceId;
        utteranceStarted = false;
        requestAudioFocus();
        int status = tts.speak(queuedText, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
        Log.i(TAG, "tts.speak status=" + status);
        if (status == TextToSpeech.ERROR) {
            pendingSpeak = null;
            pendingUtteranceId = null;
            abandonFocus();
            resolveSpeak(call, false, false, "speak_error");
            return;
        }
        // Some ROMs accept speak() and then emit no callback at all; without
        // this the JS promise (and the mouth animation) would wait forever.
        armStartWatchdog();
    }

    private void armStartWatchdog() {
        cancelStartWatchdog();
        startWatchdog = () -> {
            if (utteranceStarted || pendingSpeak == null) return;
            Log.w(TAG, "no onStart within 4s: engine accepted the text but never played");
            if (tts != null) tts.stop();
            failedUtterance("no_start");
        };
        mainHandler.postDelayed(startWatchdog, 4000L);
    }

    private void armDoneWatchdog(String utteranceId) {
        cancelDoneWatchdog();
        long budget = Math.min(35_000L, Math.max(8_000L, queuedText.length() * 700L + 6_000L));
        doneWatchdog = () -> {
            if (pendingUtteranceId == null) return;
            Log.w(TAG, "onDone missing after " + budget + "ms; resolving so the UI can move on");
            completeUtterance(utteranceId, true);
        };
        mainHandler.postDelayed(doneWatchdog, budget);
    }

    private void failedUtterance(String reason) {
        PluginCall call = pendingSpeak;
        pendingSpeak = null;
        pendingUtteranceId = null;
        cancelWatchdogs();
        abandonFocus();
        if (call != null) resolveSpeak(call, false, false, reason);
    }

    private void completeUtterance(String utteranceId, boolean ok) {
        mainHandler.post(() -> {
            if (utteranceId == null || !utteranceId.equals(pendingUtteranceId)) return;
            pendingUtteranceId = null;
            cancelWatchdogs();
            abandonFocus();
            PluginCall call = pendingSpeak;
            pendingSpeak = null;
            if (call != null) {
                resolveSpeak(call, ok, false, ok ? null : "engine_error");
            }
        });
    }

    private void failPending(String reason) {
        PluginCall call = pendingSpeak;
        pendingSpeak = null;
        pendingUtteranceId = null;
        cancelWatchdogs();
        abandonFocus();
        if (call != null) resolveSpeak(call, false, false, reason);
    }

    private void cancelInitWatchdog() {
        if (initWatchdog != null) mainHandler.removeCallbacks(initWatchdog);
        initWatchdog = null;
    }

    private void cancelStartWatchdog() {
        if (startWatchdog != null) mainHandler.removeCallbacks(startWatchdog);
        startWatchdog = null;
    }

    private void cancelDoneWatchdog() {
        if (doneWatchdog != null) mainHandler.removeCallbacks(doneWatchdog);
        doneWatchdog = null;
    }

    private void cancelNeuralGrace() {
        if (neuralGrace != null) mainHandler.removeCallbacks(neuralGrace);
        neuralGrace = null;
    }

    private void cancelWatchdogs() {
        cancelInitWatchdog();
        cancelStartWatchdog();
        cancelDoneWatchdog();
        cancelNeuralWatchdog();
        cancelNeuralGrace();
    }

    private void shutdownTts() {
        ttsReady = false;
        cancelWatchdogs();
        if (tts != null) {
            try {
                tts.shutdown();
            } catch (Throwable ignored) {
                /* engine already gone */
            }
            tts = null;
        }
    }

    /**
     * Transient focus so an incoming call/notification duck does not swallow the
     * line, plus a floor on media volume. A handset left at 10/30 is about
     * -29 dB at the port (measured with `dumpsys media.audio_flinger`), which
     * an elderly ear reads as "the doll is mute"; a muted handset is
     * indistinguishable from a broken engine. We raise, remember, and put the
     * senior's own level back when the line ends.
     */
    private void requestAudioFocus() {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        int result = am.requestAudioFocus(
                focusListener, AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
        focusHeld = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        int vol = am.getStreamVolume(AudioManager.STREAM_MUSIC);
        int floor = max > 0 ? Math.max(1, Math.round(max * 0.6f)) : 0;
        if (vol < floor) {
            if (savedVolume < 0) savedVolume = vol;
            try {
                am.setStreamVolume(AudioManager.STREAM_MUSIC, floor, 0);
                Log.i(TAG, "media volume " + vol + " -> " + floor + "/" + max + " for speech");
            } catch (Throwable e) {
                Log.w(TAG, "could not raise media volume", e);
            }
        }
        Log.i(TAG, "audio focus granted=" + focusHeld + " volume=" + vol + "/" + max);
    }

    /** Idempotent: only acts when requestAudioFocus() actually moved the slider. */
    private void restoreVolume() {
        if (savedVolume < 0) return;
        int prev = savedVolume;
        savedVolume = -1;
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am == null) return;
        try {
            am.setStreamVolume(AudioManager.STREAM_MUSIC, prev, 0);
            Log.i(TAG, "media volume restored to " + prev);
        } catch (Throwable e) {
            Log.w(TAG, "could not restore media volume", e);
        }
    }

    private void abandonFocus() {
        if (!focusHeld) return;
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        if (am != null) am.abandonAudioFocus(focusListener);
        focusHeld = false;
    }

    private void resolveSpeak(PluginCall call, boolean ok, boolean stopped, String reason) {
        JSObject ret = new JSObject();
        ret.put("ok", ok);
        if (stopped) ret.put("stopped", true);
        if (reason != null) ret.put("reason", reason);
        Log.i(TAG, "resolve ok=" + ok + " stopped=" + stopped + " reason=" + reason);
        // "interrupted" is immediately followed by the next line: keep the
        // borrowed level so the slider does not flicker between sentences.
        if (!"interrupted".equals(reason)) restoreVolume();
        call.resolve(ret);
    }

    /**
     * The handset decides which Chinese its TTS engine ships with. Xiaomi's
     * MIUI engine reports LANG_NOT_SUPPORTED for zh-HK and zh-TW but speaks
     * zh-CN happily, so a Cantonese request used to end in total silence.
     * Always finish on a voice that exists: exact locale first, then Mandarin,
     * then the other Chinese variant.
     */
    private int applyBestLocale(Locale requested) {
        int availability = tts.setLanguage(requested);
        Log.i(TAG, "setLanguage(" + requested + ")=" + availability);
        if (isLocaleUsable(availability)) return availability;
        if (!"zh".equals(requested.getLanguage())) return availability;

        Locale[] candidates = isCantonese(queuedLocale)
                ? new Locale[] { Locale.SIMPLIFIED_CHINESE, Locale.TRADITIONAL_CHINESE }
                : new Locale[] { Locale.TRADITIONAL_CHINESE, Locale.SIMPLIFIED_CHINESE };
        for (Locale candidate : candidates) {
            int next = tts.setLanguage(candidate);
            Log.i(TAG, "fallback setLanguage(" + candidate + ")=" + next);
            if (isLocaleUsable(next)) return next;
        }
        return availability;
    }

    private static boolean isLocaleUsable(int availability) {
        return availability != TextToSpeech.LANG_MISSING_DATA
                && availability != TextToSpeech.LANG_NOT_SUPPORTED;
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
        if (tts != null) tts.stop();
        cancelWatchdogs();
        abandonFocus();
        shutdownTts();
        if (neural != null) {
            neural.release();
            neural = null;
        }
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
