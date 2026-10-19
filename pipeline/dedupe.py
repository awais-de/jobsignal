"""Deduplication against this run and the database (spec 7.3).

1. Same (source, source_job_id) as a stored row: known posting, only touch last_seen_at.
2. Same id twice within this run: keep the first.
3. Same dedupe_hash from a *different* source (rule 7.3.2): one row is canonical, chosen by
   SOURCE_PREFERENCE. A better source supersedes an untriaged canonical row (applied once the
   new row has passed the filters); a worse one is a duplicate, and gives its description to
   the canonical row if that has none. A superseded row that was already emailed isn't emailed again.
4. Same dedupe_hash from the *same* source: a repost when the stored row was first seen more than
   REPOST_DAYS ago (its repost_count goes up), otherwise a duplicate. Never surfaced.
5. Same dedupe_hash as a soft-deleted or skipped row: never surfaced again.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from pipeline.models import Candidate, RawPosting
from pipeline.normalize import dedupe_hash

REPOST_DAYS = 14

# Lower is better (spec 7.3.2): the owner's own entry, the employer's own site, then sources
# with full descriptions, then partial ones.
SOURCE_PREFERENCE = {"manual": 0, "careers": 1, "ba_api": 3, "arbeitnow": 4, "adzuna": 5, "alert": 6}


def preference(source: str) -> int:
    # alert_stepstone, alert_linkedin, …: alert emails rank last (spec 7.3.2).
    return SOURCE_PREFERENCE.get(source, SOURCE_PREFERENCE["alert"] if source.startswith("alert") else 9)


@dataclass
class StoredPosting:
    id: str
    source: str
    source_job_id: str | None
    dedupe_hash: str
    first_seen_at: datetime
    triage_status: str = "new"
    deleted_at: datetime | None = None
    filter_status: str = "passed"
    surfaced_on: str | None = None
    has_description: bool = True
    has_notes: bool = False


@dataclass
class DedupeActions:
    """Database changes implied by cross-source merging (written by the run)."""
    enrich: list[tuple[str, str]] = field(default_factory=list)          # (stored id, description)
    inherit: list[tuple[Candidate, str]] = field(default_factory=list)   # candidate takes a stored row's description


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


def apply_dedupe(candidates: list[Candidate], stored: list[StoredPosting],
                 now: datetime | None = None) -> DedupeActions:
    """Mark candidates in place; return the database changes that merging implies."""
    now = now or datetime.now(timezone.utc)
    actions = DedupeActions()
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
        same_source = [s for s in siblings if s.source == c.raw.source]
        canonical = [s for s in siblings if s.filter_status == "passed" or s.triage_status == "applied"]

        if any(s.deleted_at or s.triage_status == "skipped" for s in siblings):
            c.filter_reasons.append("previously_dismissed")
            continue
        if same_source:
            oldest = min(same_source, key=lambda s: s.first_seen_at)
            if now - oldest.first_seen_at > timedelta(days=REPOST_DAYS):
                c.repost_of = oldest.id
                c.filter_reasons.append("repost")
            else:
                c.duplicate_of = oldest.id
                c.filter_reasons.append("duplicate")
            continue
        if canonical:
            best = min(canonical, key=lambda s: preference(s.source))
            if (preference(c.raw.source) < preference(best.source)
                    and best.triage_status == "new" and best.source != "manual"
                    and not any(s.has_notes for s in canonical)):      # the owner's notes stay put
                # Better source: this candidate becomes canonical once it passes the filters.
                c.supersedes = [s.id for s in canonical if s.triage_status == "new"]
                if best.surfaced_on:
                    c.raw.source_data["no_digest"] = True          # already emailed once
                if not c.raw.description and best.has_description:
                    actions.inherit.append((c, best.id))
            else:
                c.duplicate_of = best.id
                c.filter_reasons.append("duplicate")
                if c.raw.description and not best.has_description:
                    actions.enrich.append((best.id, c.raw.description))
                continue

        other = first_in_run.get(c.dedupe_hash)
        if other is None:
            first_in_run[c.dedupe_hash] = c
        elif other.raw.source != c.raw.source and preference(c.raw.source) < preference(other.raw.source):
            other.filter_reasons.append("duplicate")
            c.raw.description = c.raw.description or other.raw.description
            first_in_run[c.dedupe_hash] = c
        else:
            c.filter_reasons.append("duplicate")
            other.raw.description = other.raw.description or c.raw.description
    return actions
