package com.auragba.app;

import android.content.Context;
import android.content.res.AssetManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.util.Log;

import com.k2fsa.sherpa.onnx.GeneratedAudio;
import com.k2fsa.sherpa.onnx.OfflineTts;
import com.k2fsa.sherpa.onnx.OfflineTtsConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * NeuralTts — the on-box child voice. NOTHING leaves the handset: the VITS model
 * is bundled in the APK and sherpa-onnx runs it on the CPU of the phone.
 *
 * Why a neural model at all: Android's TextToSpeech is a formant synthesiser on
 * most ROMs. Pitch-shifting it (the old BOY_VOICE) makes it squeak, not sound
 * young. A real VITS model gives natural prosody; we then lift the pitch and
 * formants together by resampling (see {@link Preset#lift}) so the timbre reads
 * as a small boy rather than an adult woman.
 *
 * "带语气" (tone) is implemented as presets, because an offline VITS has no
 * emotion embedding and no cloud call is allowed (PDPO). A preset controls
 *   speed  — slower for reassurance, quicker for urgency
 *   lift   — higher = smaller/younger; also shortens the utterance
 *   pause  — silence between sentences (a sigh beat vs a brisk hand-off)
 * and the synthetic speed is divided by the lift so the two cancel out: the
 * voice gets younger WITHOUT getting faster than the preset asked for.
 *
 * Threading: all engine and AudioTrack work happens on ONE background thread.
 * The plugin posts calls here and receives the listener on that thread; it is
 * responsible for hopping back to the main looper.
 *
 * Failure is never fatal: if the model or the native library is missing this
 * reports failed, and AuraNativePlugin falls back to the system engine.
 */
public final class NeuralTts {

    public interface Listener {
        /** ok = played to the end; reason "stopped" is a barge-in, not a failure. */
        void onDone(boolean ok, String reason);
    }

    /** Tone presets — tuned, not guessed: see docs/dev.md "voice". */
    public enum Preset {
        /** everyday talk, a touch bright */
        WARM(1.10f, 0.98f, 220),
        /** reassurance, medication, bedtime: slower and lower */
        GENTLE(1.07f, 0.90f, 340),
        /** greetings and good news: brighter and brisker */
        CHEERFUL(1.15f, 1.03f, 180),
        /** SOS / fall: firm and fast, still young */
        URGENT(1.05f, 1.10f, 90);

        final float lift;
        /** speed relative to the model's own pace, AFTER the resample cancels out */
        final float speed;
        final int pauseMs;

        Preset(float lift, float speed, int pauseMs) {
            this.lift = lift;
            this.speed = speed;
            this.pauseMs = pauseMs;
        }

        static Preset of(String name) {
            if (name != null) {
                for (Preset p : values()) {
                    if (p.name().equalsIgnoreCase(name)) return p;
                }
            }
            return WARM;
        }
    }

    private static final String TAG = "AuraTTS";
    private static final int OUT_RATE = 24_000;
    private static final int CHUNK = 4096;
    /** A hard ceiling so a runaway generation cannot hold the floor forever. */
    private static final int MAX_SENTENCES = 6;
    private static final int LONG_SENTENCE = 34;

    private final Context ctx;
    /** Traditional -> simplified pairs; the Cantonese lexicon is simplified. */
    private final java.util.Map<Character, Character> t2s = new java.util.HashMap<>();
    private final ExecutorService io = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "aura-neural-tts");
        t.setPriority(Thread.NORM_PRIORITY - 1);
        return t;
    });

    // --- engine (io thread only) ---------------------------------------------
    private OfflineTts tts;
    private String loadedDir;

    // --- state readable from any thread --------------------------------------
    private volatile boolean ready;
    private volatile boolean failed;
    private volatile boolean preparing;
    private volatile boolean stopRequested;
    private volatile AudioTrack liveTrack;

    public NeuralTts(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        loadT2s();
    }

    /**
     * The Cantonese model's lexicon lists ~7.9k traditional characters WITHOUT
     * phones (so they are silently dropped from the audio) and 549 of those do
     * have a simplified twin with phones. Converting traditional -> simplified
     * first is what stops "帶我去街市" from losing 帶. Simplified text is a
     * no-op through this map.
     */
    private void loadT2s() {
        try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(
                ctx.getAssets().open("tts/t2s.txt"), java.nio.charset.StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) {
                String[] p = line.trim().split("\\s+");
                if (p.length == 2 && p[0].length() == 1 && p[1].length() == 1) {
                    t2s.put(p[0].charAt(0), p[1].charAt(0));
                }
            }
            Log.i(TAG, "t2s pairs=" + t2s.size());
        } catch (Throwable e) {
            Log.w(TAG, "no t2s map; traditional characters may be dropped", e);
        }
    }

    private String simplify(String text) {
        if (t2s.isEmpty() || text == null) return text;
        StringBuilder b = new StringBuilder(text.length());
        for (int i = 0; i < text.length(); i++) {
            Character s = t2s.get(text.charAt(i));
            b.append(s == null ? text.charAt(i) : s.charValue());
        }
        return b.toString();
    }

    public boolean isReady() {
        return ready;
    }

    public boolean isFailed() {
        return failed;
    }

    /** True when `locale` needs the same model that is already loaded. */
    public boolean isReadyFor(String locale) {
        return ready && dir(locale).equals(loadedDir);
    }

    /**
     * Loads the model for `locale` in the background. Idempotent and safe to
     * call on every utterance; a second call while loading is ignored.
     */
    public void prepare(String locale) {
        if (failed || ready && dir(locale).equals(loadedDir)) return;
        if (preparing) return;
        preparing = true;
        io.execute(() -> {
            try {
                ensure(locale);
            } finally {
                preparing = false;
            }
        });
    }

    /** Barge-in: silence now, and let the generator unwind. */
    public void stop() {
        stopRequested = true;
        AudioTrack t = liveTrack;
        if (t != null) {
            try {
                t.pause();
                t.flush();
            } catch (Throwable ignored) {
                /* already released */
            }
        }
    }

    public void release() {
        stop();
        io.execute(() -> {
            releaseTts();
            ready = false;
        });
        io.shutdown();
    }

    /**
     * Speaks `text` with one preset. `listener` runs on the io thread.
     * Resolves exactly once, including when stopped or failed.
     */
    public void speak(String locale, String rawText, String presetName, Listener listener) {
        stopRequested = true; // cancel anything the previous call left behind
        List<String> sentences = sentences(clean(simplify(rawText)));
        if (sentences.isEmpty()) {
            listener.onDone(false, "empty_text");
            return;
        }
        Preset preset = Preset.of(presetName);
        io.execute(() -> {
            if (!ensure(locale)) {
                listener.onDone(false, failed ? "no_model" : "not_ready");
                return;
            }
            stopRequested = false;
            AudioTrack track = null;
            try {
                track = newTrack();
                liveTrack = track;
                track.play();
                long frames = 0;
                for (int i = 0; i < sentences.size(); i++) {
                    if (stopRequested) break;
                    GeneratedAudio audio = tts.generate(sentences.get(i), 0, synthSpeed(preset));
                    if (audio == null || audio.getSamples() == null || audio.getSamples().length == 0) {
                        continue;
                    }
                    if (i > 0) frames += writeSilence(track, preset.pauseMs);
                    long wrote = writeResampled(track, audio.getSamples(), audio.getSampleRate(), preset);
                    if (wrote < 0) break; // stopped mid-sentence
                    frames += wrote;
                }
                if (!stopRequested) drain(track, frames);
                finishTrack(track);
                liveTrack = null;
                if (stopRequested) listener.onDone(false, "stopped");
                else listener.onDone(true, null);
            } catch (Throwable e) {
                Log.e(TAG, "neural speech failed", e);
                liveTrack = null;
                finishTrack(track);
                // A missing native symbol is permanent; a one-off failure is not.
                if (e instanceof UnsatisfiedLinkError || e instanceof NoClassDefFoundError) {
                    failed = true;
                    ready = false;
                }
                listener.onDone(false, stopRequested ? "stopped" : "engine_error");
            }
        });
    }

    // --- model ---------------------------------------------------------------

    private static String dir(String locale) {
        return isCantonese(locale) ? "tts/yue" : "tts/cmn";
    }

    private static boolean isCantonese(String locale) {
        if (locale == null) return true;
        String l = locale.toLowerCase();
        return l.contains("hk") || l.contains("mo") || l.contains("yue") || l.contains("cant");
    }

    /** io thread. Returns true when a model for `locale` is usable. */
    private boolean ensure(String locale) {
        String want = dir(locale);
        if (ready && want.equals(loadedDir)) return true;
        AssetManager am = ctx.getAssets();
        // Fall back to the other Chinese voice rather than going silent; the
        // plugin's system engine is the last resort after this.
        for (String candidate : new String[] {want, want.equals("tts/yue") ? "tts/cmn" : "tts/yue"}) {
            if (!has(am, candidate + "/model.onnx")) continue;
            try {
                releaseTts();
                tts = build(am, candidate);
                loadedDir = candidate;
                ready = true;
                Log.i(TAG, "neural model ready dir=" + candidate
                        + " sr=" + tts.sampleRate() + " speakers=" + tts.numSpeakers());
                return true;
            } catch (Throwable e) {
                Log.e(TAG, "cannot load " + candidate, e);
                releaseTts();
            }
        }
        failed = true;
        ready = false;
        Log.w(TAG, "no bundled neural voice for locale=" + locale);
        return false;
    }

    private OfflineTts build(AssetManager am, String d) {
        OfflineTtsVitsModelConfig vits = new OfflineTtsVitsModelConfig(
                d + "/model.onnx",
                has(am, d + "/lexicon.txt") ? d + "/lexicon.txt" : "",
                d + "/tokens.txt",
                has(am, d + "/espeak-ng-data") ? d + "/espeak-ng-data" : "",
                "",
                0.667f,
                0.8f,
                1.0f);
        // sherpa-onnx 2.0.0 added Matcha / Kokoro / ZipVoice / Kitten / Pocket /
        // Supertonic configs as non-null Kotlin constructor parameters. Passing
        // nulls threw "Parameter specified as non-null is null: parameter matcha"
        // and the bundled child voice never loaded at all (silently fell back to
        // the system engine). The no-arg constructor fills every engine config
        // with its own default; set only the VITS fields we actually use.
        OfflineTtsModelConfig model = new OfflineTtsModelConfig();
        model.setVits(vits);
        model.setNumThreads(2);
        model.setDebug(false);
        model.setProvider("cpu");
        OfflineTtsConfig cfg = new OfflineTtsConfig(model, ruleFsts(am, d), "", 1, 0.12f);
        OfflineTts engine = new OfflineTts(am, cfg);
        if (engine.sampleRate() <= 0) throw new IllegalStateException("model has no sample rate");
        return engine;
    }

    /** Only the FSTs that are actually in the APK, in normalisation order. */
    private static String ruleFsts(AssetManager am, String d) {
        StringBuilder sb = new StringBuilder();
        for (String name : new String[] {"phone.fst", "date.fst", "number.fst", "rule.fst"}) {
            if (!has(am, d + "/" + name)) continue;
            if (sb.length() > 0) sb.append(',');
            sb.append(d).append('/').append(name);
        }
        return sb.toString();
    }

    private static boolean has(AssetManager am, String path) {
        try {
            am.open(path).close();
            return true;
        } catch (Throwable e) {
            return false;
        }
    }

    private void releaseTts() {
        ready = false;
        if (tts != null) {
            try {
                tts.release();
            } catch (Throwable ignored) {
                /* already gone */
            }
            tts = null;
        }
        loadedDir = null;
    }

    // --- playback ------------------------------------------------------------

    private static AudioTrack newTrack() {
        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
        AudioFormat format = new AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(OUT_RATE)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build();
        int buf = Math.max(AudioTrack.getMinBufferSize(OUT_RATE,
                AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT), OUT_RATE / 2);
        AudioTrack t = new AudioTrack(attrs, format, buf, AudioTrack.MODE_STREAM,
                AudioManager.AUDIO_SESSION_ID_GENERATE);
        t.setVolume(1.0f);
        return t;
    }

    /**
     * Resamples one sentence to {@link #OUT_RATE} and writes it.
     * step = modelRate * lift / OUT_RATE raises pitch AND formants; the caller
     * already divided the synthesis speed by `lift` so the duration is kept.
     * Returns the frames written, or -1 when a barge-in cut it short.
     */
    private long writeResampled(AudioTrack track, float[] src, int srcRate, Preset p) {
        double step = srcRate * (double) p.lift / OUT_RATE;
        int fade = Math.max(1, Math.round(srcRate * 0.008f)); // 8 ms, kills clicks
        float[] shaped = new float[src.length];
        float peak = 0f;
        for (int i = 0; i < src.length; i++) {
            float v = src[i];
            if (v > peak) peak = v;
            else if (-v > peak) peak = -v;
            shaped[i] = v;
        }
        // This voice peaks around 0.45, which at an elderly ear's usual volume
        // reads as "too soft"; normalise up, and only pull down a hot model.
        float gain = peak > 0.01f ? Math.min(3f, 0.9f / peak) : 1f;
        for (int i = 0; i < src.length; i++) {
            float env = 1f;
            if (i < fade) env = (float) i / fade;
            int tail = src.length - i;
            if (tail < fade) env = Math.min(env, (float) tail / fade);
            shaped[i] *= gain * env;
        }

        short[] out = new short[CHUNK];
        int oi = 0;
        long frames = 0;
        double pos = 0;
        while (pos < src.length - 1) {
            int i = (int) pos;
            float f = (float) (pos - i);
            float v = shaped[i] + (shaped[i + 1] - shaped[i]) * f;
            out[oi++] = (short) Math.max(Short.MIN_VALUE,
                    Math.min(Short.MAX_VALUE, Math.round(v * 32767f)));
            if (oi == CHUNK) {
                write(track, out, oi);
                frames += oi;
                oi = 0;
                if (stopRequested) return -1;
            }
            pos += step;
        }
        if (oi > 0) {
            write(track, out, oi);
            frames += oi;
        }
        return frames;
    }

    private long writeSilence(AudioTrack track, int ms) {
        int frames = OUT_RATE * Math.max(0, ms) / 1000;
        short[] zeros = new short[Math.min(CHUNK, Math.max(1, frames))];
        long left = frames;
        long written = 0;
        while (left > 0 && !stopRequested) {
            int n = (int) Math.min(zeros.length, left);
            write(track, zeros, n);
            left -= n;
            written += n;
        }
        return written;
    }

    private static void write(AudioTrack track, short[] buf, int n) {
        int off = 0;
        while (off < n) {
            int w = track.write(buf, off, n - off); // blocking (API 21 safe)
            if (w <= 0) return; // the track was released under us
            off += w;
        }
    }

    /**
     * Waits until the mixer has actually played what we wrote. Without this the
     * last syllables are cut off by release() — the "讲嘢讲一半就停" symptom.
     */
    private void drain(AudioTrack track, long frames) {
        long deadline = System.currentTimeMillis() + 20_000L;
        while (!stopRequested && System.currentTimeMillis() < deadline) {
            long head = track.getPlaybackHeadPosition() & 0xFFFFFFFFL;
            if (head >= frames) break;
            try {
                Thread.sleep(20L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    private static void finishTrack(AudioTrack track) {
        if (track == null) return;
        try {
            track.pause();
        } catch (Throwable ignored) {
            /* not playing */
        }
        try {
            track.flush();
            track.stop();
        } catch (Throwable ignored) {
            /* already stopped */
        }
        try {
            track.release();
        } catch (Throwable ignored) {
            /* already released */
        }
    }

    // --- text ----------------------------------------------------------------

    /** Model speed that survives the resample: duration ends at preset.speed. */
    private static float synthSpeed(Preset p) {
        return p.speed / p.lift;
    }

    /** Strips what the phoneme inventory cannot say, and localises units. */
    static String clean(String raw) {
        if (raw == null) return "";
        String s = raw
                .replace("℃", "度")
                .replace("°C", "度")
                .replace("°c", "度")
                .replace("°", "度")
                .replace("%", "巴仙");
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isWhitespace(c)) {
                b.append(' ');
            } else if (Character.isLetterOrDigit(c)
                    || (c >= 0x3400 && c <= 0x9FFF) // CJK ideographs (API 21 safe)
                    || "，。！？、；：,.!?~…—#（）()《》\"'“”‘’".indexOf(c) >= 0) {
                b.append(c);
            }
            // everything else (emoji, arrows, markup) is dropped
        }
        return b.toString().replaceAll("\\s+", " ").trim();
    }

    /** Strong punctuation first; over-long sentences get a comma break. */
    static List<String> sentences(String text) {
        List<String> out = new ArrayList<>();
        if (text.isEmpty()) return out;
        StringBuilder cur = new StringBuilder();
        for (int i = 0; i < text.length() && out.size() < MAX_SENTENCES; i++) {
            char c = text.charAt(i);
            cur.append(c);
            if ("。！？!?；;".indexOf(c) >= 0) {
                add(out, cur.toString());
                cur.setLength(0);
            }
        }
        add(out, cur.toString());
        return out.size() > MAX_SENTENCES ? out.subList(0, MAX_SENTENCES) : out;
    }

    private static void add(List<String> out, String raw) {
        String s = raw.trim();
        if (s.isEmpty()) return;
        while (s.length() > LONG_SENTENCE) {
            int cut = -1;
            for (int i = Math.min(LONG_SENTENCE, s.length()) - 1; i > 0; i--) {
                if ("，,、".indexOf(s.charAt(i)) >= 0) {
                    cut = i + 1;
                    break;
                }
            }
            if (cut <= 0) cut = LONG_SENTENCE;
            String head = s.substring(0, cut).trim();
            if (!head.isEmpty()) out.add(head);
            s = s.substring(cut).trim();
        }
        if (!s.isEmpty()) out.add(s);
    }
}
