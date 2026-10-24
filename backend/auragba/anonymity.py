"""k-anonymity gate for any cross-border aggregate export (DPIA D.3).

The project never exports row-level personal data across regions; only aggregate
statistics may move, and each published group must contain at least `k` people
(default 20) so that no individual can be re-identified.

`assert_k_anonymity` is the gate: it raises when the total or any band is too
small. `merge_small_bands` is the remediation described in the DPIA: a band with
fewer than k people is folded into an adjacent band before publication.

`ponytail:` band-level counts only; no differential privacy noise. Upgrade:
add Laplace/Gaussian noise per published cell once the export endpoint exists.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

_BANDS = ("low", "watch", "elevated")


def _counts(rows: list[dict[str, Any]], band_key: str) -> Counter:
    return Counter(str(row.get(band_key) or "unknown") for row in rows)


def assert_k_anonymity(rows: list[dict[str, Any]], *, k: int = 20, band_key: str = "band") -> None:
    """Raise unless total rows and every non-empty band reach `k`."""
    if len(rows) < k:
        raise ValueError(f"refusing to export: {len(rows)} rows < k={k}")
    counts = _counts(rows, band_key)
    small = {band: count for band, count in counts.items() if 0 < count < k}
    if small:
        raise ValueError(f"refusing to export: bands below k={k}: {small}")


def merge_small_bands(
    rows: list[dict[str, Any]], *, k: int = 20, band_key: str = "band"
) -> list[dict[str, Any]]:
    """Fold each band below k into an adjacent band, then re-check the gate."""
    merged = [dict(row) for row in rows]
    if len(merged) < k:
        raise ValueError(f"refusing to export: {len(merged)} rows < k={k}")

    counts = _counts(merged, band_key)
    for index, band in enumerate(_BANDS):
        if not 0 < counts.get(band, 0) < k:
            continue
        neighbours = []
        if index > 0:
            neighbours.append(_BANDS[index - 1])
        if index + 1 < len(_BANDS):
            neighbours.append(_BANDS[index + 1])
        target = max(neighbours, key=lambda name: counts.get(name, 0), default=None)
        if target is None or counts.get(target, 0) == 0:
            raise ValueError(f"cannot merge band {band!r}: no adjacent band has members")
        for row in merged:
            if str(row.get(band_key) or "unknown") == band:
                row[band_key] = target
        counts[target] += counts[band]
        counts[band] = 0

    assert_k_anonymity(merged, k=k, band_key=band_key)
    return merged
