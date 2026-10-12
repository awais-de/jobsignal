"""Router: cache → providers in configured order, falling through on Unavailable (spec 8.1, 8.4).

Every call is recorded for llm_usage; results are cached by stage + prompt version + content.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Any, Callable

from pipeline.llm.base import Completion, LLMError, LLMProvider, Unavailable
from pipeline.llm.gemini import GeminiProvider
from pipeline.llm.groq import GroqProvider

log = logging.getLogger("jobsignal")


def cache_key(stage: str, prompt_version: str, content: str) -> str:
    return hashlib.sha256(f"{stage}|{prompt_version}|{content}".encode()).hexdigest()


class Router:
    def __init__(self, providers: list[LLMProvider], max_calls: int,
                 cache_get: Callable[[str], dict | None] | None = None):
        self.providers = providers
        self.max_calls = max_calls
        self.calls = 0
        self.cache_get = cache_get
        self.usage: list[dict[str, Any]] = []        # rows for llm_usage
        self.new_cache: dict[str, dict[str, Any]] = {}  # rows for llm_cache
        self.last_model: str | None = None              # provider:model of the last result, or 'cache'

    @property
    def exhausted(self) -> bool:
        return self.calls >= self.max_calls or not self.providers

    def complete_json(self, stage: str, key: str, system: str, user: str, schema: dict[str, Any],
                      max_tokens: int, validate: Callable[[dict], bool]) -> dict[str, Any] | None:
        """Returns the parsed result, or None when every provider failed (caller retries next run)."""
        self.last_model = "cache"
        if key in self.new_cache:
            return self.new_cache[key]
        if self.cache_get:
            cached = self.cache_get(key)
            if cached is not None:
                return cached
        self.last_model = None

        for provider in list(self.providers):
            if self.calls >= self.max_calls:
                return None
            self.calls += 1
            try:
                result = provider.complete_json(system, user, schema, max_tokens)
                if not validate(result.data):
                    raise LLMError("schema_mismatch")
            except Unavailable as exc:
                self._record(stage, provider, None, error=str(exc), limits=exc.limits)
                # A rate-limited provider stays rate-limited for this run: stop asking it.
                if str(exc) == "rate_limited":
                    self.providers.remove(provider)
                continue
            except NotImplementedError:
                continue
            except LLMError as exc:
                self._record(stage, provider, None, error=str(exc))
                continue
            self._record(stage, provider, result)
            self.new_cache[key] = result.data
            self.last_model = f"{provider.name}:{provider.model}"
            return result.data
        return None

    def _record(self, stage: str, provider: LLMProvider, result: Completion | None, error: str | None = None,
                limits: dict[str, Any] | None = None) -> None:
        # Every row has the same keys (PostgREST bulk inserts need that).
        self.usage.append({
            "stage": stage, "provider": provider.name, "model": provider.model,
            "input_tokens": result.input_tokens if result else None,
            "output_tokens": result.output_tokens if result else None,
            "cached_tokens": result.cached_tokens if result else None,
            "limits": (result.limits if result else limits) or None,
            "success": result is not None, "error": error,
        })


def build_router(cfg: dict[str, Any], stage: str, cache_get: Callable[[str], dict | None] | None = None,
                 env: dict[str, str] | None = None) -> Router:
    """Providers for a stage from llm.yaml; a provider without its API key is skipped."""
    env = os.environ if env is None else env
    stage_cfg = cfg["stages"][stage]
    providers: list[LLMProvider] = []
    for entry in stage_cfg["providers"]:
        backend = cfg["providers"][entry["provider"]]
        if not backend.get("enabled", False):
            continue
        key = env.get(backend["api_key_env"])
        if not key:
            continue
        if entry["provider"] == "groq":
            providers.append(GroqProvider(entry["model"], key))
        elif entry["provider"] == "gemini":
            providers.append(GeminiProvider(entry["model"], key))
    if not providers:
        log.warning("no LLM provider available for stage %s", stage)
    return Router(providers, max_calls=int(stage_cfg.get("max_calls_per_run", 60)), cache_get=cache_get)


def canonical_json(data: Any) -> str:
    return json.dumps(data, sort_keys=True, ensure_ascii=False)
