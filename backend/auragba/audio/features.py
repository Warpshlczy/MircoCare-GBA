"""Acoustic feature extraction — eGeMAPS-aligned 88-dim functionals + a compact
clinically-relevant summary (F0, jitter, shimmer, formants F1/F2, articulation
& pause timing).

Two back-ends:
  * `opensmile` installed  -> real eGeMAPS v02 Functionals (88 features).
  * otherwise              -> a documented numpy approximation that fills the SAME
                            88-slot schema (uncomputed slots stay 0.0).

`ponytail:` the numpy path is a genuine but approximate front-end — frame-level
F0 perturbation proxies jitter, frame RMS perturbation proxies shimmer. It is
NOT bit-compatible with openSMILE and must not be mixed across the version stamp.
The schema is versioned (`FEATURE_SET_VERSION`) so drift is detectable.
Upgrade: `pip install opensmile`, then `extract_features` prefers it automatically.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .io import AudioData

try:  # optional: the true eGeMAPS reference implementation
    import opensmile as _opensmile  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    _opensmile = None

FUNCTIONAL_DIM = 88

# Fixed 88-slot schema. Names follow eGeMAPS v02 where we compute the same
# quantity; unknown slots are zero-filled and named `reserved_slot_*`.
FUNCTIONAL_NAMES: tuple[str, ...] = (
    # loudness (9)
    "loudness_sma3_amean", "loudness_sma3_percentile20", "loudness_sma3_percentile50",
    "loudness_sma3_percentile80", "loudness_sma3_pctlrange0-2", "loudness_sma3_meanRisingSlope",
    "loudness_sma3_stddevRisingSlope", "loudness_sma3_meanFallingSlope", "loudness_sma3_stddevFallingSlope",
    # spectral / cepstral (10)
    "spectralFlux_sma3_amean", "spectralFlux_sma3_stddevNorm", "mfcc1_sma3_amean", "mfcc1_sma3_stddevNorm",
    "mfcc2_sma3_amean", "mfcc2_sma3_stddevNorm", "mfcc3_sma3_amean", "mfcc3_sma3_stddevNorm",
    "mfcc4_sma3_amean", "mfcc4_sma3_stddevNorm",
    # F0 (10)
    "F0semitoneFrom27.5Hz_sma3nz_amean", "F0semitoneFrom27.5Hz_sma3nz_stddevNorm",
    "F0semitoneFrom27.5Hz_sma3nz_percentile20", "F0semitoneFrom27.5Hz_sma3nz_percentile50",
    "F0semitoneFrom27.5Hz_sma3nz_percentile80", "F0semitoneFrom27.5Hz_sma3nz_pctlrange0-2",
    "F0semitoneFrom27.5Hz_sma3nz_meanRisingSlope", "F0semitoneFrom27.5Hz_sma3nz_stddevRisingSlope",
    "F0semitoneFrom27.5Hz_sma3nz_meanFallingSlope", "F0semitoneFrom27.5Hz_sma3nz_stddevFallingSlope",
    # voice quality / perturbation (10)
    "jitterLocal_sma3nz_amean", "jitterLocal_sma3nz_stddevLog",
    "shimmerLocaldB_sma3nz_amean", "shimmerLocaldB_sma3nz_stddevLog",
    "HNRdBACF_sma3nz_amean", "HNRdBACF_sma3nz_stddevLog",
    "logRelF0-H1-H2_sma3nz_amean", "logRelF0-H1-H2_sma3nz_stddevLog",
    "logRelF0-H1-A3_sma3nz_amean", "logRelF0-H1-A3_sma3nz_stddevLog",
    # formants F1/F2/F3 (9)
    "F1frequency_sma3nz_amean", "F1frequency_sma3nz_stddevNorm", "F1bandwidth_sma3nz_amean",
    "F1amplitudeLogRelF0_sma3nz_amean", "F2frequency_sma3nz_amean", "F2frequency_sma3nz_stddevNorm",
    "F2bandwidth_sma3nz_amean", "F2amplitudeLogRelF0_sma3nz_amean", "F3frequency_sma3nz_amean",
    # voicing segments (5)
    "VoicedSegmentsPerSec", "MeanVoicedSegmentLengthSec", "StddevVoicedSegmentLengthSec",
    "MeanUnvoicedSegmentLengthSec", "StddevUnvoicedSegmentLengthSec",
    # timing / speech-motor — added for MCI screening (see research: connected-speech markers)
    "articulationRate_syllablesPerSec", "speechRate_syllablesPerSec", "pauseRatio", "meanPauseLengthSec",
    "speechRatio", "voicedRatio", "speechSpanSec", "syllableCount",
    "spectralCentroidHz_mean", "spectralCentroidHz_stddevNorm", "zcr_mean", "zcr_stddevNorm",
    "rmsDb_mean", "rmsDb_stddevNorm", "f0RangeSemitone", "energySlopeMean",
    "formantDispersionHz", "meanPhonationThresholdDb", "longestVoicedRunSec", "pausesPerMinute",
)

# Guarantee exactly 88 slots regardless of future edits above.
if len(FUNCTIONAL_NAMES) < FUNCTIONAL_DIM:
    FUNCTIONAL_NAMES = FUNCTIONAL_NAMES + tuple(
        f"reserved_slot_{i}" for i in range(len(FUNCTIONAL_NAMES), FUNCTIONAL_DIM)
    )
FUNCTIONAL_NAMES = FUNCTIONAL_NAMES[:FUNCTIONAL_DIM]

_F0_MIN, _F0_MAX = 70.0, 400.0
_FRAME_MS, _HOP_MS = 25.0, 10.0


@dataclass
class AcousticFeatures:
    vector: dict[str, float] = field(default_factory=dict)   # 88 named functionals
    summary: dict[str, float] = field(default_factory=dict)  # clinically-relevant biomarkers
    backend: str = "numpy"
    speech_ratio: float = 0.0
    voicing: object | None = None


# --------------------------------------------------------------------------- #
# Signal helpers (numpy only)
# --------------------------------------------------------------------------- #
def _frame(x: np.ndarray, frame_len: int, hop: int) -> np.ndarray:
    if x.size < frame_len:
        return x.reshape(1, -1).astype(np.float64)
    return np.lib.stride_tricks.sliding_window_view(x, frame_len)[::hop].astype(np.float64)


def _hamming(n: int) -> np.ndarray:
    if n == 1:
        return np.ones(1)
    return 0.54 - 0.46 * np.cos(2 * np.pi * np.arange(n) / (n - 1))


def _hz_to_mel(f: np.ndarray | float) -> np.ndarray | float:
    return 2595.0 * np.log10(1.0 + np.asarray(f) / 700.0)


def _mel_to_hz(m: np.ndarray | float) -> np.ndarray | float:
    return 700.0 * (10.0 ** (np.asarray(m) / 2595.0) - 1.0)


def _mel_filterbank(sr: int, n_fft: int, n_mels: int = 24, fmin: float = 20.0) -> np.ndarray:
    fmax = sr / 2.0
    pts = np.floor((n_fft + 1) * _mel_to_hz(np.linspace(_hz_to_mel(fmin), _hz_to_mel(fmax), n_mels + 2)) / sr).astype(int)
    fb = np.zeros((n_mels, n_fft // 2 + 1))
    for i in range(1, n_mels + 1):
        left, center, right = int(pts[i - 1]), int(pts[i]), int(pts[i + 1])
        center = max(center, left + 1)
        right = max(right, center + 1)
        for k in range(left, min(center, fb.shape[1])):
            fb[i - 1, k] = (k - left) / (center - left)
        for k in range(center, min(right, fb.shape[1])):
            fb[i - 1, k] = (right - k) / (right - center)
    return fb


def _std_norm(series: np.ndarray) -> float:
    mean = float(np.mean(series))
    if abs(mean) < 1e-9:
        return 0.0
    return float(np.std(series) / abs(mean))


def _slopes(series: np.ndarray) -> tuple[float, float, float, float]:
    if series.size < 2:
        return 0.0, 0.0, 0.0, 0.0
    d = np.diff(series)
    up, down = d[d > 0], d[d < 0]
    return (
        float(np.mean(up)) if up.size else 0.0,
        float(np.std(up)) if up.size else 0.0,
        float(np.mean(down)) if down.size else 0.0,
        float(np.std(down)) if down.size else 0.0,
    )


def _estimate_f0(frame: np.ndarray, sr: int) -> tuple[float, float]:
    """Autocorrelation pitch estimate -> (f0_hz, periodicity 0..1)."""
    x = frame - np.mean(frame)
    if np.max(np.abs(x)) < 1e-6:
        return 0.0, 0.0
    ac = np.correlate(x, x, mode="full")[x.size - 1 :]
    if ac[0] <= 0:
        return 0.0, 0.0
    ac = ac / ac[0]
    lo, hi = int(sr / _F0_MAX), min(int(sr / _F0_MIN), ac.size - 1)
    if hi <= lo:
        return 0.0, 0.0
    peak = lo + int(np.argmax(ac[lo:hi]))
    strength = float(ac[peak])
    return (sr / peak if strength > 0.25 else 0.0), max(0.0, strength)


def _lpc(frame: np.ndarray, order: int) -> np.ndarray:
    """LPC coefficients via Levinson-Durbin (returns [1, a1..ap])."""
    x = frame * _hamming(frame.size)
    r = np.correlate(x, x, mode="full")[x.size - 1 :]
    if r[0] <= 0:
        return np.zeros(order + 1)
    r = r / r[0]
    a = np.zeros(order + 1)
    a[0] = 1.0
    err = r[0]
    for i in range(1, order + 1):
        acc = r[i] + np.sum(a[1:i] * r[i - 1 : 0 : -1]) if i > 1 else r[i]
        k = -acc / err if abs(err) > 1e-12 else 0.0
        prev = a.copy()
        a[i] = k
        for j in range(1, i):
            a[j] = prev[j] + k * prev[i - j]
        err *= (1.0 - k * k)
        if err <= 1e-12:
            break
    return a


def _formants(a: np.ndarray, sr: int, count: int = 3) -> list[float]:
    if a.size < 3 or np.allclose(a, 0):
        return []
    roots = np.roots(a)
    roots = roots[np.imag(roots) > 1e-6]
    if roots.size == 0:
        return []
    freqs = np.angle(roots) * sr / (2 * np.pi)
    bw = -0.5 * (sr / (2 * np.pi)) * np.log(np.abs(roots) + 1e-12)
    keep = (freqs > 90) & (freqs < 4500) & (bw > 0) & (bw < 500)
    freqs = np.sort(freqs[keep])
    return [float(f) for f in freqs[:count]]


def _analyse_vector(x: np.ndarray, sr: int) -> dict[str, object]:
    """One pass over the signal producing every intermediate we need."""
    frame_len = int(sr * _FRAME_MS / 1000.0)
    hop = max(1, int(sr * _HOP_MS / 1000.0))
    frames = _frame(x, frame_len, hop)
    n_frames = frames.shape[0]
    window = _hamming(frames.shape[1])
    rms = np.sqrt(np.mean(frames**2, axis=1) + 1e-12)
    rms_db = np.clip(20.0 * np.log10(rms), -100.0, 0.0)
    zcr = np.mean(np.abs(np.diff(np.sign(frames), axis=1)) > 0, axis=1).astype(np.float64)

    spec = np.abs(np.fft.rfft(frames * window, axis=1)) + 1e-12
    freqs = np.fft.rfftfreq(frames.shape[1], 1.0 / sr)
    centroid = (spec * freqs).sum(axis=1) / spec.sum(axis=1)
    flux = np.sqrt(np.mean(np.diff(spec, axis=0) ** 2, axis=1)) if n_frames > 1 else np.zeros(1)

    mel = _mel_filterbank(sr, frames.shape[1])  # n_fft = frame length -> matches rfft bins
    melspec = np.log(mel @ spec.T + 1e-8)  # (n_mels, n_frames)
    n_mfcc = 4
    dct = np.cos(np.pi / melspec.shape[0] * (np.arange(melspec.shape[0])[None, :] + 0.5) * np.arange(1, n_mfcc + 1)[:, None])
    mfcc = dct @ melspec  # (n_mfcc, n_frames)

    noise_floor = float(np.percentile(rms_db, 20))
    threshold = max(noise_floor + 8.0, -55.0)
    energy_voiced = rms_db > threshold

    f0 = np.zeros(n_frames)
    periodicity = np.zeros(n_frames)
    f_idx = []
    for i in range(n_frames):
        if energy_voiced[i]:
            value, strength = _estimate_f0(frames[i], sr)
            f0[i], periodicity[i] = value, strength
            if value > 0:
                f_idx.append(i)
    voiced = np.array([i for i in range(n_frames) if f0[i] > 0], dtype=int)

    # formants on voiced frames (decimated for speed)
    formants: list[list[float]] = []
    order = min(22, max(8, sr // 1000 + 4))
    for i in voiced[:: max(1, len(voiced) // 40)] if voiced.size else []:
        fs = _formants(_lpc(frames[i], order), sr)
        if len(fs) >= 2:
            formants.append(fs)

    # syllable nuclei: energy peaks inside voiced regions
    syll = 0
    if len(voiced) > 2:
        v_rms = rms_db[voiced]
        for j in range(1, len(v_rms) - 1):
            if v_rms[j] > v_rms[j - 1] and v_rms[j] >= v_rms[j + 1] and v_rms[j] > threshold + 3:
                syll += 1

    return {
        "n_frames": n_frames, "sr": sr, "hop": hop,
        "rms_db": rms_db, "zcr": zcr, "centroid": centroid, "flux": flux, "mfcc": mfcc,
        "f0": f0[voiced], "periodicity": periodicity[voiced], "voiced": voiced,
        "formants": formants, "threshold": threshold, "syllables": syll,
        "energy_voiced": energy_voiced,
    }


def _build_vector(a: dict[str, object], sr: int) -> tuple[dict[str, float], dict[str, float]]:
    rms_db: np.ndarray = a["rms_db"]           # type: ignore[assignment]
    zcr: np.ndarray = a["zcr"]                 # type: ignore[assignment]
    centroid: np.ndarray = a["centroid"]       # type: ignore[assignment]
    flux: np.ndarray = a["flux"]               # type: ignore[assignment]
    mfcc: np.ndarray = a["mfcc"]               # type: ignore[assignment]
    f0: np.ndarray = a["f0"]                   # type: ignore[assignment]
    voiced: np.ndarray = a["voiced"]           # type: ignore[assignment]
    formants: list[list[float]] = a["formants"]  # type: ignore[assignment]
    n_frames = int(a["n_frames"])              # type: ignore[arg-type]
    hop_s = int(a["hop"]) / sr                 # type: ignore[arg-type]
    threshold = float(a["threshold"])          # type: ignore[arg-type]
    syllables = int(a["syllables"])            # type: ignore[arg-type]

    total_s = n_frames * hop_s
    voiced_s = len(voiced) * hop_s
    f0_semitone = 12.0 * np.log2(f0 / 27.5) if f0.size else np.zeros(0)

    # jitter / shimmer proxies from consecutive voiced frames
    if f0.size > 1:
        jitter = float(np.mean(np.abs(np.diff(f0)) / np.maximum(f0[:-1], 1e-6)))
    else:
        jitter = 0.0
    if voiced.size > 1:
        amp = 10 ** (rms_db[voiced] / 20.0)
        shimmer = float(np.mean(np.abs(np.diff(amp)) / np.maximum(amp[:-1], 1e-9)))
    else:
        shimmer = 0.0
    hnr = 0.0
    if a["periodicity"].size:  # type: ignore[union-attr]
        p = np.clip(np.asarray(a["periodicity"]), 0.0, 0.999)  # type: ignore[arg-type]
        hnr = float(np.mean(10.0 * np.log10(p / (1 - p) + 1e-9)))

    f = {name: 0.0 for name in FUNCTIONAL_NAMES}

    def put(name: str, value: float) -> None:
        if name in f and np.isfinite(value):
            f[name] = float(value)

    # loudness
    put("loudness_sma3_amean", float(np.mean(rms_db)))
    for pct, key in ((20, "loudness_sma3_percentile20"), (50, "loudness_sma3_percentile50"), (80, "loudness_sma3_percentile80")):
        put(key, float(np.percentile(rms_db, pct)))
    put("loudness_sma3_pctlrange0-2", float(np.percentile(rms_db, 80) - np.percentile(rms_db, 20)))
    r_up, rs_up, r_dn, rs_dn = _slopes(rms_db)
    put("loudness_sma3_meanRisingSlope", r_up); put("loudness_sma3_stddevRisingSlope", rs_up)
    put("loudness_sma3_meanFallingSlope", r_dn); put("loudness_sma3_stddevFallingSlope", rs_dn)
    # spectral / cepstral
    put("spectralFlux_sma3_amean", float(np.mean(flux)))
    put("spectralFlux_sma3_stddevNorm", _std_norm(flux))
    for k in range(4):
        put(f"mfcc{k + 1}_sma3_amean", float(np.mean(mfcc[k])))
        put(f"mfcc{k + 1}_sma3_stddevNorm", _std_norm(mfcc[k]))
    # F0
    if f0_semitone.size:
        put("F0semitoneFrom27.5Hz_sma3nz_amean", float(np.mean(f0_semitone)))
        put("F0semitoneFrom27.5Hz_sma3nz_stddevNorm", _std_norm(f0_semitone))
        for pct, key in ((20, "F0semitoneFrom27.5Hz_sma3nz_percentile20"), (50, "F0semitoneFrom27.5Hz_sma3nz_percentile50"), (80, "F0semitoneFrom27.5Hz_sma3nz_percentile80")):
            put(key, float(np.percentile(f0_semitone, pct)))
        f_up, fs_up, f_dn, fs_dn = _slopes(f0_semitone)
        put("F0semitoneFrom27.5Hz_sma3nz_meanRisingSlope", f_up); put("F0semitoneFrom27.5Hz_sma3nz_stddevRisingSlope", fs_up)
        put("F0semitoneFrom27.5Hz_sma3nz_meanFallingSlope", f_dn); put("F0semitoneFrom27.5Hz_sma3nz_stddevFallingSlope", fs_dn)
    # voice quality
    put("jitterLocal_sma3nz_amean", jitter)
    put("shimmerLocaldB_sma3nz_amean", shimmer)
    put("HNRdBACF_sma3nz_amean", hnr)
    # formants
    if formants:
        fr = np.array(formants)
        put("F1frequency_sma3nz_amean", float(np.mean(fr[:, 0])))
        put("F1frequency_sma3nz_stddevNorm", _std_norm(fr[:, 0]))
        put("F2frequency_sma3nz_amean", float(np.mean(fr[:, 1])))
        put("F2frequency_sma3nz_stddevNorm", _std_norm(fr[:, 1]))
        if fr.shape[1] >= 3:
            put("F3frequency_sma3nz_amean", float(np.mean(fr[:, 2])))
    # voicing segments
    segs = _segments(a["energy_voiced"])  # type: ignore[arg-type]
    vsegs = [(s, e) for s, e in segs if e - s > 1]
    if vsegs:
        lens = np.array([(e - s) * hop_s for s, e in vsegs])
        put("VoicedSegmentsPerSec", len(vsegs) / max(total_s, 1e-6))
        put("MeanVoicedSegmentLengthSec", float(np.mean(lens)))
        put("StddevVoicedSegmentLengthSec", float(np.std(lens)))
    gaps = []
    for i in range(1, len(vsegs)):
        gaps.append((vsegs[i][0] - vsegs[i - 1][1]) * hop_s)
    if gaps:
        put("MeanUnvoicedSegmentLengthSec", float(np.mean(gaps)))
        put("StddevUnvoicedSegmentLengthSec", float(np.std(gaps)))
    # timing / speech-motor
    put("articulationRate_syllablesPerSec", syllables / max(voiced_s, 1e-6))
    put("speechRate_syllablesPerSec", syllables / max(total_s, 1e-6))
    silent = int(np.sum(rms_db <= threshold))
    put("pauseRatio", silent / max(n_frames, 1))
    put("meanPauseLengthSec", float(np.mean(gaps)) if gaps else 0.0)
    put("speechRatio", float(len(voiced)) / max(n_frames, 1))
    put("voicedRatio", float(len(voiced)) / max(n_frames, 1))
    put("speechSpanSec", total_s)
    put("syllableCount", float(syllables))
    put("spectralCentroidHz_mean", float(np.mean(centroid)))
    put("spectralCentroidHz_stddevNorm", _std_norm(centroid))
    put("zcr_mean", float(np.mean(zcr)))
    put("zcr_stddevNorm", _std_norm(zcr))
    put("rmsDb_mean", float(np.mean(rms_db)))
    put("rmsDb_stddevNorm", _std_norm(rms_db))
    if f0_semitone.size:
        put("f0RangeSemitone", float(np.percentile(f0_semitone, 80) - np.percentile(f0_semitone, 20)))
    put("energySlopeMean", r_up + r_dn)
    if formants:
        fr = np.array(formants)
        put("formantDispersionHz", float(np.mean(np.abs(fr[:, 1] - fr[:, 0]))) if fr.shape[1] >= 2 else 0.0)
    put("meanPhonationThresholdDb", threshold)
    put("longestVoicedRunSec", max([(e - s) * hop_s for s, e in vsegs], default=0.0))
    put("pausesPerMinute", (len(gaps) / max(total_s, 1e-6)) * 60.0)

    summary = {
        "f0_mean_hz": float(np.mean(f0)) if f0.size else 0.0,
        "f0_std_hz": float(np.std(f0)) if f0.size else 0.0,
        "f0_cv": _std_norm(f0) if f0.size else 0.0,
        "jitter_local": jitter,
        "shimmer_local": shimmer,
        "hnr_db": hnr,
        "f1_hz": float(np.mean([x[0] for x in formants])) if formants else 0.0,
        "f2_hz": float(np.mean([x[1] for x in formants])) if formants else 0.0,
        "f3_hz": float(np.mean([x[2] for x in formants if len(x) >= 3])) if any(len(x) >= 3 for x in formants) else 0.0,
        "articulation_rate": syllables / max(voiced_s, 1e-6),
        "speech_rate": syllables / max(total_s, 1e-6),
        "pause_ratio": silent / max(n_frames, 1),
        "mean_pause_s": float(np.mean(gaps)) if gaps else 0.0,
        "speech_ratio": float(len(voiced)) / max(n_frames, 1),
        "voiced_ratio": float(len(voiced)) / max(n_frames, 1),
        "loudness_db_mean": float(np.mean(rms_db)),
        "loudness_db_std": float(np.std(rms_db)),
        "zcr_mean": float(np.mean(zcr)),
        "spectral_centroid_hz": float(np.mean(centroid)),
        "duration_s": total_s,
    }
    return f, summary


def _segments(mask: np.ndarray) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    start: int | None = None
    for i, on in enumerate(mask):
        if on and start is None:
            start = i
        elif not on and start is not None:
            out.append((start, i)); start = None
    if start is not None:
        out.append((start, len(mask)))
    return out


def _extract_opensmile(audio: AudioData) -> AcousticFeatures:
    smile = _opensmile.Smile(
        feature_set=_opensmile.FeatureSet.eGeMAPSv02,
        feature_level=_opensmile.FeatureLevel.Functionals,
    )
    row = smile.process_signal(audio.samples.astype(np.float32), audio.sample_rate).iloc[0].to_dict()
    vector = {name: float(row.get(name, 0.0)) for name in FUNCTIONAL_NAMES}
    for key, value in row.items():  # keep extra openSMILE columns too
        vector.setdefault(str(key), float(value))
    # 节律 / 发声时长类特征（语速、停顿、voiced 占比）openSMILE 不直接产出，
    # 仍用 numpy VAD 分支计算 —— 这样两个后端的 summary 键完全一致，
    # 下游 baseline.py 的 TRACKED 表与手工权重表才不会静默丢指标。
    try:
        analysis = _analyse_vector(audio.samples.astype(np.float64), audio.sample_rate)
        _, np_summary = _build_vector(analysis, audio.sample_rate)
        voiced_ratio = float(len(analysis["voiced"])) / max(int(analysis["n_frames"]), 1)  # type: ignore[arg-type]
    except Exception:  # pragma: no cover
        np_summary, voiced_ratio = {}, 1.0
    summary = dict(np_summary)

    # 声学质量类用 openSMILE 覆盖（比 numpy 近似更准）
    def g(key: str) -> float:
        return float(row.get(key, 0.0))

    st = g("F0semitoneFrom27.5Hz_sma3nz_amean")
    f0_hz = 27.5 * (2.0 ** (st / 12.0)) if st else 0.0   # 半音 -> Hz
    f0_cv = g("F0semitoneFrom27.5Hz_sma3nz_stddevNorm")
    sh_db = g("shimmerLocaldB_sma3nz_amean")
    summary.update({
        "f0_mean_hz": f0_hz,
        "f0_std_hz": f0_hz * f0_cv,
        "f0_cv": f0_cv,
        "jitter_local": g("jitterLocal_sma3nz_amean"),
        "shimmer_local": 10.0 ** (sh_db / 20.0) if sh_db else 0.0,  # dB -> 比值
        "hnr_db": g("HNRdBACF_sma3nz_amean"),
        "f1_hz": g("F1frequency_sma3nz_amean"),
        "f2_hz": g("F2frequency_sma3nz_amean"),
        "f3_hz": g("F3frequency_sma3nz_amean"),
        "loudness_db_mean": g("loudness_sma3_amean"),
        "speech_ratio": voiced_ratio,
        "voiced_ratio": voiced_ratio,
    })
    return AcousticFeatures(vector=vector, summary=summary, backend="opensmile", speech_ratio=voiced_ratio)


def extract_features(audio: AudioData) -> AcousticFeatures:
    """Extract the 88-dim functional vector + clinical summary. Never raises on
    pathological input (all-silent / too-short clips yield zeros)."""
    if audio.samples.size == 0:
        return AcousticFeatures(vector={n: 0.0 for n in FUNCTIONAL_NAMES}, summary={}, backend="empty")
    if _opensmile is not None:
        try:
            return _extract_opensmile(audio)
        except Exception:  # pragma: no cover - fall through to numpy on any failure
            pass
    try:
        analysis = _analyse_vector(audio.samples.astype(np.float64), audio.sample_rate)
        vector, summary = _build_vector(analysis, audio.sample_rate)
        voiced = analysis["voiced"]
        ratio = float(len(voiced)) / max(int(analysis["n_frames"]), 1)  # type: ignore[arg-type]
        return AcousticFeatures(vector=vector, summary=summary, backend="numpy", speech_ratio=ratio)
    except Exception:
        return AcousticFeatures(vector={n: 0.0 for n in FUNCTIONAL_NAMES}, summary={}, backend="numpy-error")