"""Shared data types."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any


@dataclass
class RawPosting:
    """One posting as a source returned it (spec 7.1)."""

    source: str
    source_job_id: str | None
    company_name: str
    title: str
    source_url: str | None = None
    apply_url: str | None = None
    location_raw: str | None = None
    city: str | None = None
    country: str | None = None           # ISO code, e.g. 'DE'
    remote_policy: str | None = None     # 'onsite','hybrid','remote', None
    description: str | None = None
    posted_date: date | None = None
    contract_type: str | None = None     # when the source states it
    poster_type: str | None = None       # 'employer','agency', None
    salary_text: str | None = None
    source_data: dict[str, Any] = field(default_factory=dict)


@dataclass
class Candidate:
    """A posting in this run, after normalization and dedupe."""

    raw: RawPosting
    dedupe_hash: str
    existing_id: str | None = None       # set when (source, source_job_id) is already stored
    repost_of: str | None = None         # canonical row id when this is a repost
    duplicate_of: str | None = None      # canonical row id when the same job is already stored
    filter_reasons: list[str] = field(default_factory=list)
    # Stored rows from weaker sources this one replaces once it passes the filters (spec 7.3.2).
    supersedes: list[str] = field(default_factory=list)
    # Extraction and ranking columns (spec 7.5, 7.9), written with the row.
    enrichment: dict[str, Any] = field(default_factory=dict)

    @property
    def is_new(self) -> bool:
        return self.existing_id is None

    @property
    def passed(self) -> bool:
        return not self.filter_reasons
