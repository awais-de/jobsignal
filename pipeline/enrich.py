"""Extraction + dealbreakers + ranking for one posting, as job_postings column values."""

from __future__ import annotations

from typing import Any

from pipeline.extract import jd
from pipeline.llm.router import Router
from pipeline.rank import SkillIndex, score

# Extracted fields that map 1:1 to job_postings columns.
_COLUMNS = ("seniority", "required_years", "german_level", "english_level", "must_have_skills",
            "nice_to_have_skills", "start_date_text", "reference_number", "named_contact",
            "specificity_score", "evergreen_language", "contract_type")


class Enricher:
    def __init__(self, profile: dict[str, Any], llm_cfg: dict[str, Any], weights: dict[str, Any], router: Router):
        self.profile = profile
        self.stage_cfg = llm_cfg["stages"][jd.STAGE]
        self.weights = weights
        self.router = router
        self.index = SkillIndex.from_profile(profile)

    def run(self, title: str, description: str | None, *, source_contract: str | None,
            remote_policy: str | None, salary_text: str | None) -> tuple[dict[str, Any], str | None]:
        """Returns (column values, dealbreaker reason or None)."""
        ex = jd.extract(title, description, self.router, self.stage_cfg, source_contract=source_contract)
        cols: dict[str, Any] = {"extraction_status": ex.status}
        if ex.status == "done":
            cols["extraction_model"] = self.router.last_model
        f = ex.fields
        for k in _COLUMNS:
            if k in f and f[k] is not None:
                cols[k] = f[k]
        # Source values win; the LLM only fills gaps.
        if not remote_policy and f.get("remote_policy"):
            cols["remote_policy"] = f["remote_policy"]
        if not salary_text and f.get("salary_text"):
            cols["salary_text"] = f["salary_text"]

        if ex.status == "done":
            fit, rank, details = score(f, cols.get("remote_policy", remote_policy), self.index,
                                       self.profile, self.weights)
            details["ranked_with"] = self.profile.get("_version")
            cols.update(fit_score=fit, rank_score=rank, rank_details=details)
        return cols, (jd.dealbreaker(f, self.profile) if f else None)
