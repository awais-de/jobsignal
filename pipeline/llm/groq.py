"""Groq backend: OpenAI-compatible chat completions with strict JSON-schema output.

Verified 2026-10-11 (console.groq.com/docs/structured-outputs):
- POST https://api.groq.com/openai/v1/chat/completions
- response_format = {type: json_schema, json_schema: {name, strict: true, schema}}
- strict mode supported on openai/gpt-oss-20b, openai/gpt-oss-120b, qwen/qwen3.8-27b;
  every property must be in `required`, objects need additionalProperties: false.
"""

from __future__ import annotations

import json
import time
from typing import Any

import httpx

from pipeline.llm.base import Completion, LLMError, Unavailable

URL = "https://api.groq.com/openai/v1/chat/completions"
MAX_WAIT_SECONDS = 20  # wait out a short rate-limit window instead of falling through


class GroqProvider:
    name = "groq"

    def __init__(self, model: str, api_key: str, client: httpx.Client | None = None,
                 reasoning_effort: str | None = "low"):
        self.model = model
        self.reasoning_effort = reasoning_effort
        self.client = client or httpx.Client(timeout=60, headers={"Authorization": f"Bearer {api_key}"})

    def complete_json(self, system: str, user: str, schema: dict[str, Any], max_tokens: int) -> Completion:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "response_format": {"type": "json_schema",
                                "json_schema": {"name": "result", "strict": True, "schema": schema}},
            "max_completion_tokens": max_tokens,
            "temperature": 0,
        }
        if self.reasoning_effort and self.model.startswith("openai/gpt-oss"):
            body["reasoning_effort"] = self.reasoning_effort

        for attempt in range(2):
            try:
                resp = self.client.post(URL, json=body)
            except httpx.TimeoutException:
                raise Unavailable("timeout") from None
            except httpx.HTTPError as exc:
                raise Unavailable(type(exc).__name__) from None

            if resp.status_code == 429:
                wait = _retry_after(resp)
                if attempt == 0 and wait is not None and wait <= MAX_WAIT_SECONDS:
                    time.sleep(wait + 0.5)
                    continue
                raise Unavailable("rate_limited")
            if resp.status_code >= 500 or resp.status_code in (408, 413):
                raise Unavailable(f"http_{resp.status_code}")
            if resp.status_code >= 400:
                raise LLMError(f"http_{resp.status_code}")

            data = resp.json()
            try:
                content = data["choices"][0]["message"]["content"]
                parsed = json.loads(content)
            except (KeyError, IndexError, TypeError, json.JSONDecodeError):
                raise LLMError("unparseable_response") from None
            usage = data.get("usage") or {}
            return Completion(parsed, self.name, self.model,
                              usage.get("prompt_tokens"), usage.get("completion_tokens"))
        raise Unavailable("rate_limited")


def _retry_after(resp: httpx.Response) -> float | None:
    value = resp.headers.get("retry-after")
    try:
        return float(value) if value is not None else None
    except ValueError:
        return None
