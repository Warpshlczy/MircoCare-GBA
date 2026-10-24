"""Thin OpenAI-compatible chat client.

No SDK dependency: one POST to ``{base_url}/chat/completions`` via httpx. The
client is sync because FastAPI runs sync routes in a threadpool; this keeps the
route code simple and the timeout explicit.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ..config import settings
from .errors import LLMInvalidOutput, LLMNotConfigured, LLMUpstreamError

_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)


class LLMClient:
    def __init__(self) -> None:
        self.base_url = settings.llm_base_url
        self.model = settings.llm_model
        self.timeout = settings.llm_timeout_s
        self.max_tokens = settings.llm_max_tokens
        self._headers = {"Content-Type": "application/json"}
        if settings.llm_api_key:
            self._headers["Authorization"] = f"Bearer {settings.llm_api_key}"

    def _post(self, payload: dict[str, Any], *, timeout: float | None = None) -> Any:
        try:
            import httpx
        except ImportError as exc:
            raise LLMNotConfigured("httpx is not installed") from exc
        try:
            with httpx.Client(timeout=timeout or self.timeout) as client:
                return client.post(
                    f"{self.base_url}/chat/completions",
                    headers=self._headers,
                    json=payload,
                )
        except httpx.HTTPError as exc:
            raise LLMUpstreamError(f"LLM request failed: {exc}") from exc

    def _chat(self, messages: list[dict[str, str]], *, json_mode: bool, max_tokens: int | None = None) -> str:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": max_tokens or self.max_tokens,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}

        response = self._post(payload)
        # Some OpenAI-compatible providers reject response_format. Retry once
        # without it instead of failing the whole route.
        if response.status_code == 400 and json_mode:
            payload.pop("response_format", None)
            response = self._post(payload)

        if response.status_code >= 400:
            raise LLMUpstreamError(f"LLM HTTP {response.status_code}")
        try:
            body = response.json()
            content = body["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise LLMUpstreamError("malformed LLM response envelope") from exc
        if not isinstance(content, str) or not content.strip():
            raise LLMUpstreamError("empty LLM content")
        return content.strip()

    def complete_text(self, messages: list[dict[str, str]], *, max_tokens: int | None = None) -> str:
        return self._chat(messages, json_mode=False, max_tokens=max_tokens)

    def complete_tools(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        timeout: float | None = None,
        max_tokens: int | None = None,
    ) -> dict[str, Any]:
        """-> the assistant message dict (content + optional tool_calls).

        Unlike `_chat`, empty content is legal: a tool-only turn carries its
        action in `tool_calls` and may have no prose.
        """
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": max_tokens or self.max_tokens,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        response = self._post(payload, timeout=timeout)
        if response.status_code >= 400:
            raise LLMUpstreamError(f"LLM HTTP {response.status_code}")
        try:
            message = response.json()["choices"][0]["message"]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise LLMUpstreamError("malformed LLM response envelope") from exc
        if not isinstance(message, dict):
            raise LLMUpstreamError("malformed LLM message")
        return message

    def complete_json(self, messages: list[dict[str, str]]) -> dict[str, Any]:
        content = self._chat(messages, json_mode=True)
        parsed = self._parse_json(content)
        if parsed is not None:
            return parsed

        # One repair round: show the model its invalid output and demand JSON.
        repair = messages + [
            {"role": "assistant", "content": content[:2000]},
            {"role": "user", "content": "你刚才的输出不是合法 JSON。请只输出 JSON 对象，不要解释、不要 markdown。"},
        ]
        content = self._chat(repair, json_mode=True)
        parsed = self._parse_json(content)
        if parsed is None:
            raise LLMInvalidOutput("LLM did not return a valid JSON object")
        return parsed

    @staticmethod
    def _parse_json(content: str) -> dict[str, Any] | None:
        text = _FENCE.sub("", content).strip()
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            # Tolerate a leading/trailing sentence around the object.
            start, end = text.find("{"), text.rfind("}")
            if start < 0 or end <= start:
                return None
            try:
                value = json.loads(text[start : end + 1])
            except json.JSONDecodeError:
                return None
        return value if isinstance(value, dict) else None
