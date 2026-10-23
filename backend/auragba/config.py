"""Runtime configuration + provenance stamps.

Stdlib-only (dataclass over env vars) so importing the engine never pulls a
settings dependency. `ponytail:` reading env at import time is fine for a
single-process service; upgrade to a reloadable settings object if hot-reload
is ever needed.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# Provenance stamps — every screening result and audit record carries these so
# historical data can be re-scored reproducibly (see audit.py).
ENGINE_VERSION = "aura-engine-0.2.0"
# v2: 装了 openSMILE 后走真 eGeMAPS（v1 是 numpy 近似），summary 键在两个后端下已统一
FEATURE_SET_VERSION = "egemaps88-v2"
NLP_SET_VERSION = "nlp-metrics-v1"
FUSION_VERSION = "latefusion-v2"  # 权重与阈值已在 322 人上交叉拟合校准(0.2/0.8)


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except (TypeError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    """Immutable settings resolved once at import."""

    privacy_mode: str = os.getenv("AURA_PRIVACY_MODE", "extract-and-burn")
    baseline_days: int = _env_int("AURA_BASELINE_DAYS", 14)
    fusion_w_acoustic: float = _env_float("AURA_FUSION_W_ACOUSTIC", 0.5)
    fusion_w_semantic: float = _env_float("AURA_FUSION_W_SEMANTIC", 0.5)
    risk_watch: float = _env_float("AURA_RISK_WATCH", 0.45)
    risk_elevated: float = _env_float("AURA_RISK_ELEVATED", 0.65)
    data_dir: Path = field(
        default_factory=lambda: Path(
            os.getenv("AURA_DATA_DIR", str(Path(__file__).resolve().parents[1] / ".data"))
        )
    )
    cors_origins: tuple[str, ...] = field(
        default_factory=lambda: tuple(
            o.strip() for o in os.getenv(
                "AURA_CORS_ORIGINS", "http://localhost:3000,http://localhost:8000"
            ).split(",") if o.strip()
        )
    )
    auth_secret: str = os.getenv("AURA_AUTH_SECRET", "")
    environment: str = os.getenv("AURA_ENV", "development")
    cookie_secure: bool = os.getenv("AURA_COOKIE_SECURE", "false").lower() == "true"

    @property
    def burn_audio(self) -> bool:
        """True when raw audio must be zeroed immediately after feature extraction."""
        return self.privacy_mode == "extract-and-burn"

    def risk_band(self, risk: float) -> str:
        if risk >= self.risk_elevated:
            return "elevated"
        if risk >= self.risk_watch:
            return "watch"
        return "low"


settings = Settings()
if not settings.auth_secret or len(settings.auth_secret.encode("utf-8")) < 32:
    raise RuntimeError("AURA_AUTH_SECRET must be set to at least 32 bytes before starting the backend")
if settings.environment == "production" and not settings.cookie_secure:
    raise RuntimeError("AURA_COOKIE_SECURE=true is required in production")
if "*" in settings.cors_origins:
    raise RuntimeError("Wildcard CORS is incompatible with credentialed session cookies")

# Sampling rate the acoustic front-end works at (16 kHz mono, telephony-grade).
TARGET_SR = 16_000