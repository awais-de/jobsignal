"""Deduplication against this run and the database (spec 7.3).

Phase 1 has a single source, so the cross-source canonical-row rule (7.3.2)
is not needed yet. The rules applied here:

1. Same (source, source_job_id) as a stored row: known posting, only touch last_seen_at.
2. Same id twice within this run: keep the first.
3. Same dedupe_hash as a stored row first seen more than REPOST_DAYS ago: a repost.
   Stored, never surfaced, and the stored row's repost_count goes up.
4. Same dedupe_hash as a stored row seen more recently, or as an earlier posting
   in this run: a duplicate (e.g. the same job listed twice). Stored, never surfaced.
5. Same dedupe_hash as a soft-deleted or skipped row: never surfaced again.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from pipeline.models import Candidate, RawPosting
from pipeline.normalize import dedupe_hash

REPOST_DAYS = 14


@dataclass
class StoredPosting:
    id: str
    source: str
    source_job_id: str | None
    dedupe_hash: str
    first_seen_at: datetime
    triage_status: str = "new"
    deleted_at: datetime | None = None


def build_candidates(raws: list[RawPosting]) -> list[Candidate]:
    seen: set[tuple[str, str]] = set()
    out: list[Candidate] = []
    for raw in raws:
        if raw.source_job_id:
            key = (raw.source, raw.source_job_id)
            if key in seen:
                continue
            seen.add(key)
        out.append(Candidate(raw=raw, dedupe_hash=dedupe_hash(raw.company_name, raw.title, raw.city)))
    return out


def apply_dedupe(
    candidates: list[Candidate],
    stored: list[StoredPosting],
    now: datetime | None = None,
) -> None:
    """Mark candidates in place."""
    now = now or datetime.now(timezone.utc)
    by_source_id = {(s.source, s.source_job_id): s for s in stored if s.source_job_id}
    by_hash: dict[str, list[StoredPosting]] = {}
    for s in stored:
        by_hash.setdefault(s.dedupe_hash, []).append(s)

    first_in_run: dict[str, Candidate] = {}
    for c in candidates:
        known = by_source_id.get((c.raw.source, c.raw.source_job_id))
        if known:
            c.existing_id = known.id
            continue

        siblings = by_hash.get(c.dedupe_hash, [])
        if any(s.deleted_at or s.triage_status == "skipped" for s in siblings):
            c.filter_reasons.append("previously_dismissed")
        elif siblings:
            oldest = min(siblings, key=lambda s: s.first_seen_at)
            if now - oldest.first_seen_at > timedelta(days=REPOST_DAYS):
                c.repost_of = oldest.id
                c.filter_reasons.append("repost")
            else:
                c.duplicate_of = oldest.id
                c.filter_reasons.append("duplicate")
        elif c.dedupe_hash in first_in_run:
            c.filter_reasons.append("duplicate")
        else:
            first_in_run[c.dedupe_hash] = c
