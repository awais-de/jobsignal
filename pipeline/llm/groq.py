"""Groq backend: OpenAI-compatible chat completions with strict JSON-schema output.

Verified 2026-10-11 (console.groq.com/docs/structured-outputs):
- POST https://api.groq.com/openai/v1/chat/completions
- response_format = {type: json_schema, json_schema: {name, strict: true, schema}}
- strict mode supported on openai/gpt-oss-20b, openai/gpt-oss-120b, qwen/qwen3.8-27b;
  every property must be in `required`, objects need additionalProperties: false.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

import httpx

from pipeline.llm.base import Completion, LLMError, Unavailable

URL = "https://api.groq.com/openai/v1/chat/completions"
# Free-tier token-per-minute limits allow ~4 job descriptions a minute, so a pause of up
# to a minute is normal and worth waiting out; longer waits (daily quota) fall through.
MAX_WAIT_SECONDS = 65


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

        for attempt in range(3):
            try:
                resp = self.client.post(URL, json=body)
            except httpx.TimeoutException:
                raise Unavailable("timeout") from None
            except httpx.HTTPError as exc:
                raise Unavailable(type(exc).__name__) from None

            if resp.status_code == 429:
                wait = _retry_after(resp)
                if attempt < 2 and wait is not None and wait <= MAX_WAIT_SECONDS:
                    time.sleep(wait + 0.5)
                    continue
                raise Unavailable("rate_limited", limits={**_limits(resp), **_limit_hit(resp)})
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
                              usage.get("prompt_tokens"), usage.get("completion_tokens"),
                              cached_tokens=(usage.get("prompt_tokens_details") or {}).get("cached_tokens"),
                              limits=_limits(resp) or None)
        raise Unavailable("rate_limited")


def _limits(resp: httpx.Response) -> dict[str, str]:
    """Groq's x-ratelimit-* headers (requests per day, tokens per minute: limit, remaining, reset)."""
    return {k.lower(): v for k, v in resp.headers.items() if k.lower().startswith("x-ratelimit-")}


_HIT = re.compile(r"on (tokens|requests) per (minute|day) \((\w+)\): Limit (\d+), Used (\d+)", re.I)


def _limit_hit(resp: httpx.Response) -> dict[str, object]:
    """Which limit a 429 hit, from Groq's error message ('... tokens per day (TPD): Limit 200000, Used ...')."""
    try:
        message = resp.json()["error"]["message"]
    except (ValueError, KeyError, TypeError):
        return {}
    m = _HIT.search(message or "")
    return {"hit": m.group(3).upper(), "hit_limit": int(m.group(4)), "hit_used": int(m.group(5))} if m else {}


def _retry_after(resp: httpx.Response) -> float | None:
    value = resp.headers.get("retry-after")
    try:
        return float(value) if value is not None else None
    except ValueError:
        return None
