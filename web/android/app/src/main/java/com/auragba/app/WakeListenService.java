package com.auragba.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

/**
 * Foreground microphone service that listens for the assistant's name while the
 * app is backgrounded or the phone is locked (req 2). On a hit it brings
 * MainActivity to the front; the web app then greets the senior and starts the
 * conversation (see web/src/app/page.tsx `converse`).
 *
 * On-device only: recognition uses the platform SpeechRecognizer and we only ever
 * compare the result against a fixed name list — no audio leaves the device from
 * this service.
 *
 * ponytail: the platform SpeechRecognizer is a continuous-listen approximation —
 * each session is short-lived and we immediately restart it, which costs battery.
 * A shipping build swaps in an on-device keyword spotter (Porcupine/Snowboy) while
 * keeping this ACTION_START / ACTION_STOP contract unchanged.
 */
public class WakeListenService extends Service {

    public static final String ACTION_START = "com.auragba.app.WAKE_START";
    public static final String ACTION_STOP = "com.auragba.app.WAKE_STOP";

    private static final String TAG = "AuraWake";
    private static final String CHANNEL_ID = "memomate_wake";
    private static final int NOTIF_ID = 4711;
    private static final long RESTART_MS = 400;

    /** The assistant's name in the forms a senior might say it.
     *  MUST stay identical to `WAKE_NAMES` in web/src/hooks/useWakeWord.ts
     *  (docs/dev.md §1.3 items 3 and 4) — a divergence means the foreground and
     *  the background listener disagree about the senior's own assistant. */
    private static final List<String> NAMES =
            Arrays.asList("小忆", "小憶", "阿忆", "阿憶", "忆伴", "憶伴", "memomate", "memo mate");

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable restart = new Runnable() {
        @Override
        public void run() {
            listen();
        }
    };

    private SpeechRecognizer recognizer;
    private Intent intent;
    private boolean running;

    @Override
    public int onStartCommand(Intent cmd, int flags, int startId) {
        if (cmd != null && ACTION_STOP.equals(cmd.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startForegroundWithNotification();
        if (!running) {
            running = true;
            listen();
        }
        return START_STICKY;
    }

    private void listen() {
        if (!running) return;
        if (recognizer == null) {
            if (!SpeechRecognizer.isRecognitionAvailable(this)) {
                Log.w(TAG, "speech recognition unavailable; stopping wake service");
                stopSelf();
                return;
            }
            recognizer = SpeechRecognizer.createSpeechRecognizer(this);
            intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toString());
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5);
            recognizer.setRecognitionListener(listener);
        }
        try {
            recognizer.startListening(intent);
        } catch (Exception e) {
            Log.w(TAG, "startListening failed: " + e.getMessage());
            restartSoon();
        }
    }

    private void restartSoon() {
        if (!running) return;
        handler.removeCallbacks(restart);
        handler.postDelayed(restart, RESTART_MS);
    }

    private final RecognitionListener listener = new RecognitionListener() {
        @Override public void onReadyForSpeech(Bundle params) {}
        @Override public void onBeginningOfSpeech() {}
        @Override public void onRmsChanged(float rmsdB) {}
        @Override public void onBufferReceived(byte[] buffer) {}
        @Override public void onEndOfSpeech() {}
        @Override public void onEvent(int eventType, Bundle params) {}

        // partial results give a faster wake than waiting for the full session
        @Override
        public void onPartialResults(Bundle partial) {
            if (heard(partial)) onWake();
        }

        @Override
        public void onResults(Bundle results) {
            if (heard(results)) onWake();
            else restartSoon();
        }

        @Override
        public void onError(int error) {
            // ERROR_NO_MATCH / ERROR_SPEECH_TIMEOUT are normal in a listen loop.
            restartSoon();
        }
    };

    private boolean heard(Bundle bundle) {
        if (bundle == null) return false;
        ArrayList<String> hits = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (hits == null) return false;
        for (String hit : hits) {
            if (hit == null) continue;
            String norm = hit.replaceAll("\\s+", "").toLowerCase(Locale.ROOT);
            for (String name : NAMES) {
                if (norm.contains(name.toLowerCase(Locale.ROOT))) return true;
            }
        }
        return false;
    }

    private void onWake() {
        running = false;
        handler.removeCallbacks(restart);
        Intent open = new Intent(this, MainActivity.class);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra("aura_wake", true);
        startActivity(open);
        stopSelf();
    }

    private void startForegroundWithNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                nm.createNotificationChannel(new NotificationChannel(
                        CHANNEL_ID, "语音唤醒", NotificationManager.IMPORTANCE_LOW));
            }
        }
        Notification notif = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("忆伴在守护")
                .setContentText("叫一声「小忆」我就应你")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIF_ID, notif);
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacksAndMessages(null);
        if (recognizer != null) {
            recognizer.destroy();
            recognizer = null;
        }
        super.onDestroy();
    }
}