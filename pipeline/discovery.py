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

from pipeline.normalize import normalize_company
from pipeline.sources.ats import ATS, PROBE_ORDER

log = logging.getLogger("jobsignal")

# Words that don't identify a company (dropped from slugs and from the name check).
GENERIC = {"deutschland", "germany", "group", "gruppe", "holding", "und", "the", "of", "de", "international",
           "services", "service", "europe", "niederlassung", "zweigniederlassung", "stiftung", "jobs", "bei",
           "at", "career", "careers", "karriere", "board", "stellenangebote", "co", "ag", "gmbh"}
_UMLAUT = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})


def tokens(name: str) -> list[str]:
    return [t for t in normalize_company(name).translate(_UMLAUT).split()
            if t not in GENERIC and re.fullmatch(r"[a-z0-9]+", t)]


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
    ats: str
    token: str
    jobs: int
    verified_name: str


def _try(ats: ATS, system: str, slug: str) -> tuple[int, str] | None:
    try:
        return getattr(ats, f"{system}_probe")(slug)
    except (httpx.HTTPError, ValueError):
        return None


def probe_company(name: str, ats: ATS) -> Found | None:
    """For each name spelling, ask all systems in parallel (each host gets one request); the first
    verified hit in PROBE_ORDER wins."""
    with ThreadPoolExecutor(max_workers=len(PROBE_ORDER)) as pool:
        for slug in slug_variants(name):
            results = dict(zip(PROBE_ORDER, pool.map(lambda s: _try(ats, s, slug), PROBE_ORDER)))
            for system in PROBE_ORDER:
                res = results[system]
                if res and res[0] >= 1 and same_company(name, res[1]):
                    return Found(system, slug, res[0], res[1])
    return None


def watch_entry(c: dict[str, Any]) -> dict[str, Any]:
    """A discovered company as a careers-source watchlist entry."""
    entry = {"name": c["name"], "filters": c.get("filter_mode") or "all", "company_id": c["id"]}
    if c["ats"] == "softgarden":
        entry.update(technique="career_page", url=f"https://{c['ats_token']}.softgarden.io/en/vacancies",
                     link_pattern=r"/job/\d+/")
    else:
        entry.update(technique="ats", ats=c["ats"], token=c["ats_token"])
    return entry
