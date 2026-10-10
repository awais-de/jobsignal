"""Gemini backend (paid-tier fallback; disabled in config until billing is set up).

Verified 2026-10-11 (ai.google.dev): generateContent is current alongside the newer
Interactions API; recommended models for new projects are gemini-3.5-flash-lite and
gemini-3.8-flash. Free-tier terms: only Paid Services may be used for API clients
offered to users in the EEA, hence paid tier only for this project.

`VERIFY` before enabling: the exact generationConfig field for a JSON schema
(responseJsonSchema vs responseSchema). Until then this backend asks for JSON via
responseMimeType and puts the schema in the prompt; the router validates the shape.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from pipeline.llm.base import Completion, LLMError, Unavailable

URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


class GeminiProvider:
    name = "gemini"

    def __init__(self, model: str, api_key: str, client: httpx.Client | None = None):
        self.model = model
        self.client = client or httpx.Client(timeout=60, headers={"x-goog-api-key": api_key})

    def complete_json(self, system: str, user: str, schema: dict[str, Any], max_tokens: int) -> Completion:
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [
                {"text": f"{user}\n\nReturn only JSON matching this JSON Schema:\n{json.dumps(schema)}"}]}],
            "generationConfig": {"responseMimeType": "application/json", "maxOutputTokens": max_tokens,
                                 "temperature": 0},
        }
        try:
            resp = self.client.post(URL.format(model=self.model), json=body)
        except httpx.TimeoutException:
            raise Unavailable("timeout") from None
        except httpx.HTTPError as exc:
            raise Unavailable(type(exc).__name__) from None
        if resp.status_code == 429 or resp.status_code >= 500:
            raise Unavailable(f"http_{resp.status_code}")
        if resp.status_code >= 400:
            raise LLMError(f"http_{resp.status_code}")
        data = resp.json()
        try:
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            parsed = json.loads(text)
        except (KeyError, IndexError, TypeError, json.JSONDecodeError):
            raise LLMError("unparseable_response") from None
        usage = data.get("usageMetadata") or {}
        return Completion(parsed, self.name, self.model,
                          usage.get("promptTokenCount"), usage.get("candidatesTokenCount"))
