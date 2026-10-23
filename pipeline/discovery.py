"""Company discovery (spec 7.2): every employer seen becomes a candidate; its name is tried as an
address on common ATS systems; a hit counts only with at least one job AND the ATS's own company
name matching. Found companies are watched from then on.

Verified live 2026-10-11: probing without the name check produced wrong companies (a Personio
feed listing another firm's jobs, empty Workable accounts for large employers), hence both checks.
"""

from __future__ import annotations

import logging
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

import httpx

from pipeline.discovery_names import tokens
from pipeline.sources.ats import ATS, PROBE_ORDER
from pipeline.website import discover_via_website

log = logging.getLogger("jobsignal")

def slug_variants(name: str) -> list[str]:
    toks = tokens(name)
    if not toks:
        return []
    v = ["-".join(toks), "".join(toks)]
    if len(toks) > 1 and len(toks[0]) >= 5:
        v.append(toks[0])                       # 'postnova' for 'Postnova Analytics GmbH'
    return list(dict.fromkeys(x for x in v if len(x) >= 3))[:3]


def same_company(name: str, ats_name: str) -> bool:
    """Conservative identity check (a wrong company is worse than a missed one): the ATS's own
    name must contain the first distinctive word; two-word names need both words, longer names
    the first word and at least one more."""
    want, have = tokens(name), set(tokens(ats_name))
    if not want or not have or want[0] not in have:
        return False
    hits = sum(t in have for t in want)
    return len(want) == 1 or (hits == 2 if len(want) == 2 else hits >= 2)


@dataclass
class Found:
    ats: str                    # an ATS, or 'jsonld' / 'sitemap' (company's own career site)
    token: str
    jobs: int
    verified_name: str
    careers_url: str | None = None
    via: str = "name"           # 'name' (probing) or 'website' (linked from the company's own site)


def _try(ats: ATS, system: str, slug: str) -> tuple[int, str] | None:
    try:
        return getattr(ats, f"{system}_probe")(slug)
    except (httpx.HTTPError, httpx.InvalidURL, ValueError):
        return None


def probe_company(name: str, ats: ATS, use_website: bool = True) -> Found | None:
    """1. Name probing: for each spelling, ask all systems in parallel; the first verified hit in
    PROBE_ORDER wins. 2. Otherwise the company's website (finds Workday, SuccessFactors, custom sites)."""
    with ThreadPoolExecutor(max_workers=len(PROBE_ORDER)) as pool:
        for slug in slug_variants(name):
            results = dict(zip(PROBE_ORDER, pool.map(lambda s: _try(ats, s, slug), PROBE_ORDER)))
            for system in PROBE_ORDER:
                res = results[system]
                if res and res[0] >= 1 and same_company(name, res[1]):
                    return Found(system, slug, res[0], res[1])
    if not use_website:
        return None
    hit = discover_via_website(name, ats.c)
    if not hit:
        return None
    # Linked from the company's own site: trusted as its system, but it must have jobs.
    if hit.kind in ("jsonld", "sitemap"):
        return Found(hit.kind, hit.token, 1, name, hit.careers_url, "website")
    if hit.kind == "workday":
        n = _workday_count(ats, hit.token)
    else:
        res = _try(ats, hit.kind, hit.token) if hasattr(ats, f"{hit.kind}_probe") else None
        n = res[0] if res else 0
    return Found(hit.kind, hit.token, n, name, hit.careers_url, "website") if n >= 1 else None


def _workday_count(ats: ATS, token: str) -> int:
    host, tenant, site = token.split("|")
    try:
        r = ats.c.post(f"https://{host}/wday/cxs/{tenant}/{site}/jobs",
                       json={"appliedFacets": {}, "limit": 1, "offset": 0, "searchText": ""})
        return int(r.json().get("total") or 0) if r.status_code == 200 else 0
    except (httpx.HTTPError, httpx.InvalidURL, ValueError):
        return 0


# ATS whose jobs are read from JSON-LD job pages (careers.py career_page technique).
_JSONLD_BOARDS = {
    "softgarden": (lambda t: f"https://{t}.softgarden.io/en/vacancies", lambda t: r"/job/\d+/"),
    "join": (lambda t: f"https://join.com/companies/{t}", lambda t: rf"/companies/{re.escape(t)}/\d+"),
    "teamtailor": (lambda t: f"https://{t}.teamtailor.com/jobs", lambda t: r"/jobs/\d+"),
}


def watch_entry(c: dict[str, Any]) -> dict[str, Any]:
    """A discovered company as a careers-source watchlist entry."""
    entry = {"name": c["name"], "filters": c.get("filter_mode") or "all", "company_id": c["id"]}
    ats, token = c["ats"], c["ats_token"]
    if ats in _JSONLD_BOARDS:
        url, pattern = _JSONLD_BOARDS[ats]
        entry.update(technique="career_page", url=url(token), link_pattern=pattern(token))
    elif ats in ("jsonld", "sitemap"):
        entry.update(technique="career_page", url=c["careers_url"], link_pattern=token)
    else:
        entry.update(technique="ats", ats=ats, token=token)
    return entry
