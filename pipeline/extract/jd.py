"""Job-description extraction (spec 7.5): structured source fields, then regex, then the LLM.

The job description is untrusted text. It is passed as data in the user message and the
model's output is constrained by a strict JSON schema, so nothing in it can steer the pipeline.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from pipeline.extract import regex
from pipeline.llm.router import Router, cache_key

STAGE = "jd_extraction"

# One prompt and schema for the pipeline and the manual-add Edge Function (single source of truth).
_SHARED = Path(__file__).resolve().parents[2] / "supabase" / "functions" / "_shared" / "jd_extraction.json"
_PROMPT = json.loads(_SHARED.read_text(encoding="utf-8"))
SYSTEM: str = _PROMPT["system"]
SCHEMA: dict[str, Any] = _PROMPT["schema"]

# Lines that are almost never about the job itself (benefits, legal, boilerplate).
_BOILERPLATE = re.compile(
    r"^\s*(wir bieten|was wir bieten|unser angebot|benefits|what we offer|perks|über uns|about us|"
    r"datenschutz|privacy|chancengleichheit|equal opportunit|kontakt|contact|bewerbungsprozess)\b",
    re.I,
)


@dataclass
class Extraction:
    status: str                                  # 'done', 'failed' (retry next run), 'skipped'
    fields: dict[str, Any] = field(default_factory=dict)
    model: str | None = None


def trim(description: str, max_chars: int) -> str:
    """Drop obvious boilerplate sections, collapse whitespace, cap length."""
    out, skipping = [], False
    for line in description.splitlines():
        if _BOILERPLATE.match(line):
            skipping = True
            continue
        # A new heading-like short line ends a skipped section.
        if skipping and line.strip() and len(line.strip()) < 60 and line.strip().endswith(":"):
            skipping = False
        if not skipping:
            out.append(line)
    text = re.sub(r"[ \t]+", " ", "\n".join(out))
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:max_chars]


def valid(data: dict[str, Any]) -> bool:
    return isinstance(data, dict) and set(SCHEMA["required"]) <= set(data) \
        and isinstance(data.get("must_have_skills"), list) and isinstance(data.get("specificity"), dict)


def extract(title: str, description: str | None, router: Router, cfg: dict[str, Any],
            source_contract: str | None = None) -> Extraction:
    """`source_contract` is the contract type the source states (e.g. BA's Vollzeit flag); it beats the LLM."""
    if not description:
        return Extraction("skipped")

    fields: dict[str, Any] = {
        "german_level": regex.german_level(description),
        "required_years": regex.required_years(description),
        "evergreen_language": regex.evergreen(description),
    }
    contract = regex.contract_type(title) or source_contract
    if contract:
        fields["contract_type"] = contract

    text = trim(description, int(cfg.get("max_input_chars", 8000)))
    key = cache_key(STAGE, cfg["prompt_version"], f"{title}\n{text}")
    llm = router.complete_json(STAGE, key, SYSTEM, f"Job title: {title}\n\nPosting:\n{text}", SCHEMA,
                               max_tokens=1500, validate=valid)
    if llm is None:
        return Extraction("failed", fields)

    # Regex wins where it found something (spec 7.5); the LLM fills the rest.
    merged = dict(fields)
    for k in ("german_level", "required_years", "contract_type"):
        if merged.get(k) is None:
            merged[k] = llm.get(k)
    merged["evergreen_language"] = bool(fields["evergreen_language"] or llm.get("evergreen_language"))
    for k in ("must_have_skills", "nice_to_have_skills", "seniority", "english_level", "remote_policy",
              "named_contact", "reference_number", "start_date_text", "salary_text"):
        merged[k] = llm.get(k)
    spec = llm.get("specificity") or {}
    merged["specificity_score"] = sum(bool(spec.get(k)) for k in ("named_team", "concrete_project", "named_manager"))
    merged["must_have_skills"] = _clean_list(merged.get("must_have_skills"))
    merged["nice_to_have_skills"] = _clean_list(merged.get("nice_to_have_skills"))
    return Extraction("done", merged)


def _clean_list(items: Any) -> list[str]:
    seen, out = set(), []
    for s in items or []:
        if isinstance(s, str) and s.strip() and s.strip().lower() not in seen:
            seen.add(s.strip().lower())
            out.append(s.strip()[:60])
    return out[:12]


def dealbreaker(fields: dict[str, Any], profile: dict[str, Any]) -> str | None:
    """Reason to reject after extraction, or None (spec 7.5, last paragraph)."""
    rules = profile.get("dealbreakers", {})
    years = fields.get("required_years")
    if years is not None and years > float(rules.get("max_required_years", 99)):
        return "too_many_years"
    if regex.cefr_above(fields.get("german_level"), rules.get("max_german_level", "C2")):
        return "german_level"
    contract = fields.get("contract_type")
    if contract and contract not in set(profile.get("contract_types", [])):
        return "contract_type"
    return None
