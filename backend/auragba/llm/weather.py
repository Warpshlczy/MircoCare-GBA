"""Real weather via Open-Meteo (no API key), with a short in-process cache.

If the request fails or weather is disabled, callers get ``None`` and the card
service returns an honest "temporarily unavailable" card instead of inventing a
temperature.
"""

from __future__ import annotations

import time
from typing import Any

from ..config import settings

_LOCATIONS = {
    "zh-HK": ("香港", 22.3193, 114.1694),
    "zh-MO": ("澳門", 22.1987, 113.5439),
    "zh-CN": ("珠海", 22.2710, 113.5767),
}

# WMO weather interpretation codes -> (localized text, icon)
_CONDITIONS: dict[int, tuple[str, str]] = {
    0: ("天晴", "☀️"),
    1: ("大致天晴", "🌤️"),
    2: ("多雲", "⛅"),
    3: ("陰天", "☁️"),
    45: ("有霧", "🌫️"),
    48: ("有霧", "🌫️"),
    51: ("微雨", "🌦️"),
    53: ("細雨", "🌦️"),
    55: ("大雨", "🌧️"),
    61: ("小雨", "🌧️"),
    63: ("中雨", "🌧️"),
    65: ("大雨", "🌧️"),
    71: ("落雪", "❄️"),
    73: ("落雪", "❄️"),
    75: ("大雪", "❄️"),
    80: ("驟雨", "🌦️"),
    81: ("驟雨", "🌧️"),
    82: ("暴雨", "⛈️"),
    95: ("雷暴", "⛈️"),
    96: ("雷暴", "⛈️"),
    99: ("雷暴", "⛈️"),
}

_CACHE: dict[str, tuple[float, dict[str, Any] | None]] = {}

# WMO codes that put water on the ground today (drizzle / rain / showers /
# thunderstorm). Snow is deliberately excluded: "落雨?" is answered "no" then.
_RAIN_CODES = {51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99}


def _condition(code: int, locale: str) -> tuple[str, str]:
    if locale == "zh-CN":
        zh_cn = {
            0: ("晴", "☀️"), 1: ("大致晴", "🌤️"), 2: ("多云", "⛅"), 3: ("阴", "☁️"),
            45: ("有雾", "🌫️"), 48: ("有雾", "🌫️"), 51: ("小雨", "🌦️"), 53: ("细雨", "🌦️"),
            55: ("大雨", "🌧️"), 61: ("小雨", "🌧️"), 63: ("中雨", "🌧️"), 65: ("大雨", "🌧️"),
            71: ("下雪", "❄️"), 73: ("下雪", "❄️"), 75: ("大雪", "❄️"), 80: ("阵雨", "🌦️"),
            81: ("阵雨", "🌧️"), 82: ("暴雨", "⛈️"), 95: ("雷暴", "⛈️"), 96: ("雷暴", "⛈️"),
            99: ("雷暴", "⛈️"),
        }
        return zh_cn.get(code, ("天氣未知", "🌤️"))
    return _CONDITIONS.get(code, ("天氣未知", "🌤️"))


def weather_for_locale(locale: str) -> dict[str, Any] | None:
    if not settings.weather_enabled:
        return None

    now = time.time()
    cached = _CACHE.get(locale)
    if cached:
        ttl = settings.weather_ttl_s if cached[1] else 60  # retry failures sooner
        if now - cached[0] < ttl:
            return cached[1]

    location, lat, lon = _LOCATIONS.get(locale, _LOCATIONS["zh-HK"])
    try:
        import httpx
    except ImportError:
        _CACHE[locale] = (now, None)
        return None
    try:
        with httpx.Client(timeout=5.0) as client:
            response = client.get(
                "https://api.open-meteo.com/v1/forecast",
                params={
                    "latitude": lat,
                    "longitude": lon,
                    "current": "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m",
                    # Today's own code + probability, so "今天会下雨吗?" can be
                    # answered from data instead of guessed from the current sky.
                    "daily": "weather_code,precipitation_probability_max",
                    "forecast_days": 1,
                    "timezone": "Asia/Hong_Kong",
                    "wind_speed_unit": "kmh",
                },
            )
        response.raise_for_status()
        body = response.json()
        current = body["current"]
        code = int(current["weather_code"])
        condition, icon = _condition(code, locale)

        daily = body.get("daily") or {}
        day_codes = daily.get("weather_code") or []
        chances = daily.get("precipitation_probability_max") or []
        today_code = int(day_codes[0]) if day_codes and day_codes[0] is not None else code
        chance = int(chances[0]) if chances and chances[0] is not None else None
        rain_condition, _ = _condition(today_code, locale)
        snapshot = {
            "location": location,
            "temperature_c": float(current["temperature_2m"]),
            "humidity": int(current["relative_humidity_2m"]),
            "wind_kmh": float(current["wind_speed_10m"]),
            "condition": condition,
            "icon": icon,
            # `rain_chance` is a probability; `rain_today` is the verdict the
            # senior hears ("係，今日會落雨" / "唔係").
            "rain_today": bool(today_code in _RAIN_CODES or (chance is not None and chance >= 50)),
            "rain_chance": chance,
            "rain_condition": rain_condition,
        }
        _CACHE[locale] = (now, snapshot)
        return snapshot
    except (httpx.HTTPError, KeyError, TypeError, ValueError):
        # Cache the failure briefly so a dead network does not stall every call.
        _CACHE[locale] = (now, None)
        return None
