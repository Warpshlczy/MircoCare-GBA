"""Typed failures for the optional LLM layer.

Routes map these to HTTP statuses so the frontend can always fall back to its
local card/reminder path:

  LLMNotConfigured  -> 501 (keeps the previous "LLM intentionally blank" contract)
  LLMQuotaExceeded  -> 429
  LLMUpstreamError  -> 503
  LLMInvalidOutput  -> 503
  LLMInvalidInput   -> 400
"""

from __future__ import annotations


class LLMError(Exception):
    """Base class for expected LLM failures."""


class LLMNotConfigured(LLMError):
    pass


class LLMQuotaExceeded(LLMError):
    pass


class LLMUpstreamError(LLMError):
    pass


class LLMInvalidOutput(LLMError):
    pass


class LLMInvalidInput(LLMError):
    pass
