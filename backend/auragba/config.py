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
FUSION_VERSION = "latefusion-v3"  # v3: three streams (behaviour added); two-stream path unchanged


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


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Settings:
    """Immutable settings resolved once at import."""

    privacy_mode: str = os.getenv("AURA_PRIVACY_MODE", "extract-and-burn")
    baseline_days: int = _env_int("AURA_BASELINE_DAYS", 14)
    # Trend slope and CUSUM need a longer window than the Z reference; the weekly
    # report speaks about "the last 4 weeks", so that is the default.
    trend_days: int = _env_int("AURA_TREND_DAYS", 28)
    # Calibrated on the 322-subject cohort (scripts/eval_fusion.py weight sweep):
    # 0.2/0.8 fusion AUC 0.717, thresholds 0.409/0.521. Defaults MUST match
    # `.env.example` so a bare `python selfcheck.py` and a `--env-file .env`
    # server produce the same risk bands.
    fusion_w_acoustic: float = _env_float("AURA_FUSION_W_ACOUSTIC", 0.2)
    fusion_w_semantic: float = _env_float("AURA_FUSION_W_SEMANTIC", 0.8)
    # Three-stream initial prior (DEV.md C1). Used only when the behaviour stream
    # exists; weights are renormalised over whichever streams are available. When
    # behaviour is absent the calibrated two-stream values above apply unchanged,
    # so historical results stay reproducible.
    fusion3_w_acoustic: float = _env_float("AURA_FUSION3_W_ACOUSTIC", 0.15)
    fusion3_w_semantic: float = _env_float("AURA_FUSION3_W_SEMANTIC", 0.65)
    fusion3_w_behavior: float = _env_float("AURA_FUSION3_W_BEHAVIOR", 0.20)
    risk_watch: float = _env_float("AURA_RISK_WATCH", 0.409)
    risk_elevated: float = _env_float("AURA_RISK_ELEVATED", 0.521)
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

    # --- Optional LLM orchestration (OpenAI-compatible) ----------------------
    # Disabled by default: the three LLM routes keep returning 501 so the
    # frontend's local card/reminder fallback stays the safe path.
    llm_enabled: bool = _env_bool("AURA_LLM_ENABLED", False)
    llm_base_url: str = os.getenv("AURA_LLM_BASE_URL", "https://api.deepseek.com/v1").rstrip("/")
    llm_api_key: str = os.getenv("AURA_LLM_API_KEY", "")
    llm_model: str = os.getenv("AURA_LLM_MODEL", "deepseek-chat")
    llm_timeout_s: float = _env_float("AURA_LLM_TIMEOUT_S", 15.0)
    # Tool planning must answer fast enough for a spoken turn; the client falls
    # back to a local card/task when this budget is exceeded.
    llm_turn_timeout_s: float = _env_float("AURA_LLM_TURN_TIMEOUT_S", 6.0)
    llm_max_tokens: int = _env_int("AURA_LLM_MAX_TOKENS", 400)
    llm_daily_quota: int = _env_int("AURA_LLM_DAILY_QUOTA", 200)

    # --- Optional real weather (Open-Meteo, no key) -------------------------
    weather_enabled: bool = _env_bool("AURA_WEATHER_ENABLED", True)
    weather_ttl_s: int = _env_int("AURA_WEATHER_TTL_S", 600)

    # --- Notification provider seam (demo: webhook + log) -------------------
    notify_webhook: str = os.getenv("AURA_NOTIFY_WEBHOOK", "")

    # --- Conversation memory at rest (C5) -----------------------------------
    # AES-GCM key material; the server refuses to start without ≥32 characters.
    # Production should supply a KMS-managed secret, not a passphrase.
    encryption_key: str = os.getenv("AURA_ENCRYPTION_KEY", "")
    conversation_ttl_days: int = _env_int("AURA_CONVERSATION_TTL_DAYS", 90)

    @property
    def llm_available(self) -> bool:
        return bool(self.llm_enabled and self.llm_base_url and self.llm_model)

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


def validate_runtime(s: Settings = settings) -> None:
    """Reject unsafe runtime configuration before the service serves traffic.

    Deliberately NOT executed at import time: ``selfcheck.py`` imports the engine
    modules without a server environment, so the import must stay side-effect
    free. ``main.py`` calls this when the app is created, which means
    ``uvicorn auragba.main:app`` still refuses to boot without a strong secret.
    """
    if not s.auth_secret or len(s.auth_secret.encode("utf-8")) < 32:
        raise RuntimeError("AURA_AUTH_SECRET must be set to at least 32 bytes before starting the backend")
    if not s.encryption_key or len(s.encryption_key.encode("utf-8")) < 32:
        raise RuntimeError("AURA_ENCRYPTION_KEY must be set to at least 32 bytes before starting the backend")
    if s.environment == "production" and not s.cookie_secure:
        raise RuntimeError("AURA_COOKIE_SECURE=true is required in production")
    if "*" in s.cors_origins:
        raise RuntimeError("Wildcard CORS is incompatible with credentialed session cookies")


# Sampling rate the acoustic front-end works at (16 kHz mono, telephony-grade).
TARGET_SR = 16_000