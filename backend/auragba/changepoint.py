"""Minimal CUSUM change-point detection over one feature's longitudinal series.

CUSUM tracks a sustained shift away from a target level:

    S+ = max(0, S+ + (x - mu - k))       # upward drift
    S- = max(0, S- + (mu - x - k))       # downward drift

with slack ``k = 0.5 * sigma`` and an alarm at ``h = 4 * sigma``. ``mu`` and
``sigma`` come from the EARLIEST half of the observed window (the "stable period"
the senior is compared against), so the test works on a short 4-week window
without a separate training split.

The point of this module is the distinction the weekly report needs: a single
outlier is a Z-score event, while a level shift is a *trend* event. Only the
latter should say "something changed" to a family member.

`ponytail:` one feature at a time, single alarm per call, no seasonality and no
multiple-testing correction. Upgrade: ARIMA residuals + FDR control once daily
series are long enough to fit them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np

_K_SIGMA = 0.5
_H_SIGMA = 4.0
_MIN_POINTS = 6  # fewer points cannot separate a level from noise
_MIN_REFERENCE = 3
_EPS = 1e-9


@dataclass(frozen=True)
class ChangePoint:
    """Where the sustained shift first crossed the alarm threshold."""

    direction: str  # "high" | "low"
    index: int  # position in the input series where the alarm fired
    at: int | None = None  # epoch ms of that sample, when timestamps are known


def _scale(values: np.ndarray) -> float:
    """1.4826 * MAD, with the same zero-guard the baseline uses."""
    med = float(np.median(values))
    mad = float(np.median(np.abs(values - med)))
    scale = 1.4826 * mad
    if scale <= _EPS:
        scale = 0.05 * abs(med)
    return scale


def detect(
    values: Sequence[float],
    *,
    at: Sequence[int] | None = None,
    k: float = _K_SIGMA,
    h: float = _H_SIGMA,
    reference_ratio: float = 0.5,
) -> ChangePoint | None:
    """-> the first CUSUM alarm, or None when the series stays stable.

    ``values`` must be in time order. ``at`` is optional epoch-ms timestamps of
    the same length; when absent the returned ``at`` is None.
    """
    series = np.asarray([float(v) for v in values], dtype=float)
    n = series.size
    if n < _MIN_POINTS:
        return None
    if at is not None and len(at) != n:
        at = None

    ref_n = min(n - 1, max(_MIN_REFERENCE, int(round(n * reference_ratio))))
    reference = series[:ref_n]
    mu = float(np.median(reference))
    sigma = _scale(reference)
    if sigma <= _EPS:
        return None  # a constant series has no meaningful drift

    slack = k * sigma
    threshold = h * sigma
    s_high = 0.0
    s_low = 0.0
    for i in range(ref_n, n):
        s_high = max(0.0, s_high + (float(series[i]) - mu - slack))
        s_low = max(0.0, s_low + (mu - float(series[i]) - slack))
        if s_high >= threshold:
            return ChangePoint(direction="high", index=i, at=_at(at, i))
        if s_low >= threshold:
            return ChangePoint(direction="low", index=i, at=_at(at, i))
    return None


def _at(at: Sequence[int] | None, index: int) -> int | None:
    if at is None:
        return None
    return int(at[index])
