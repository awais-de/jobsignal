"""Hard filters, code only (spec 7.4). Applied in order; the first failure is recorded."""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

from pipeline.models import Candidate


class HardFilters:
    def __init__(self, profile: dict[str, Any], first_run: bool, now: datetime | None = None):
        titles = profile["titles"]
        self.allow = [re.compile(p, re.IGNORECASE) for p in titles.get("allow", [])]
        self.block = [re.compile(p, re.IGNORECASE) for p in titles.get("block", [])]
        loc = profile["location"]
        self.country = loc.get("country", "DE")
        self.contract_types = set(profile["contract_types"])
        self.freshness = timedelta(hours=profile["freshness_hours"])
        self.exclude_agencies = bool(profile.get("exclude_agencies", False))
        self.first_run = first_run
        self.now = now or datetime.now(timezone.utc)

    def reason(self, c: Candidate) -> str | None:
        raw = c.raw
        if not any(p.search(raw.title) for p in self.allow):
            return "title_not_allowed"
        if any(p.search(raw.title) for p in self.block):
            return "title_blocked"
        if raw.country != self.country:
            return "location"
        if raw.contract_type and raw.contract_type not in self.contract_types:
            return "contract_type"
        if not self._fresh(raw.posted_date):
            return "not_fresh"
        if self.exclude_agencies and raw.poster_type == "agency":
            return "agency"
        return None

    def _fresh(self, posted: date | None) -> bool:
        if posted is None:
            # Without a source date, first_seen_at (= now) would let the whole backlog
            # through on the first run, so those wait for a later run (spec 7.4).
            return not self.first_run
        posted_at = datetime(posted.year, posted.month, posted.day, tzinfo=timezone.utc)
        # A date has day granularity: count the posting as published at the end of that day.
        return self.now - (posted_at + timedelta(days=1)) <= self.freshness

    def apply(self, candidates: list[Candidate]) -> None:
        for c in candidates:
            if c.is_new and c.passed:
                r = self.reason(c)
                if r:
                    c.filter_reasons.append(r)
