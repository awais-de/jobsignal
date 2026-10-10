"""Placeholder for a self-hosted open model (spec 8.6).

Not implemented on purpose. Building it requires the owner's confirmation that the
compute provider's usage policy allows hosting a model; no code may connect to it before then.
"""

from __future__ import annotations

from typing import Any

from pipeline.llm.base import Completion


class LocalProvider:
    name = "local"
    model = "unconfigured"

    def complete_json(self, system: str, user: str, schema: dict[str, Any], max_tokens: int) -> Completion:
        raise NotImplementedError("local backend is a placeholder (spec 8.6)")
