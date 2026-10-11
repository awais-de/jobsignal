"""Job pages without JSON-LD (spec 7.1 tier 3, technique 2): identify the job from page text.

The full description is extracted later by the normal jd_extraction stage; this stage only
decides whether the page is a single job ad and reads its title and location.
"""

from __future__ import annotations

from typing import Any

from pipeline.llm.router import Router, cache_key

STAGE = "page_extraction"

SYSTEM = (
    "You read the text of a web page from a company's careers site. Decide whether it is the ad for "
    "one specific job opening (not a job list, not a general 'open application' / Initiativbewerbung page, "
    "not a blog post). If it is, return the job title exactly as written, the city of the workplace, the "
    "country as an ISO 3166-1 alpha-2 code, and the employment type. Use null when the page doesn't say."
)

SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["is_job_posting", "title", "city", "country", "employment_type"],
    "properties": {
        "is_job_posting": {"type": "boolean"},
        "title": {"type": ["string", "null"]},
        "city": {"type": ["string", "null"]},
        "country": {"type": ["string", "null"]},
        "employment_type": {"type": ["string", "null"],
                            "enum": ["FULL_TIME", "PART_TIME", "INTERN", "CONTRACTOR", None]},
    },
}


def make_page_extractor(router: Router, cfg: dict[str, Any]):
    def extract(company: str, url: str, text: str) -> dict[str, Any] | None:
        text = text[: int(cfg.get("max_input_chars", 8000))]
        key = cache_key(STAGE, cfg["prompt_version"], f"{url}\n{text}")
        return router.complete_json(
            STAGE, key, SYSTEM, f"Company: {company}\nURL: {url}\n\nPage text:\n{text}", SCHEMA,
            max_tokens=600, validate=lambda d: isinstance(d, dict) and "is_job_posting" in d,
        )
    return extract
