"""Provider interface (spec 8.1)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


class LLMError(Exception):
    """A provider failed in a way the router should not retry on another provider."""


class Unavailable(LLMError):
    """Rate limit, quota, timeout or server error: the router falls through to the next provider."""

    def __init__(self, message: str, limits: dict[str, Any] | None = None):
        super().__init__(message)
        self.limits = limits     # what the provider said about the limit that was hit


@dataclass
class Completion:
    data: dict[str, Any]
    provider: str
    model: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    cached_tokens: int | None = None             # prompt tokens served from the provider's cache
    limits: dict[str, Any] | None = None         # provider-reported rate limits with this response


class LLMProvider(Protocol):
    name: str
    model: str

    def complete_json(self, system: str, user: str, schema: dict[str, Any], max_tokens: int) -> Completion: ...
