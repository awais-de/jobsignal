"""Market demand per skill, week by week (owner request 2026-10-23).

For each week (Monday to Sunday, by first seen), each job family and two source scopes, counts the companies
whose postings mention a skill in the job part of the text (tasks and profile; the company intro, benefits
and boilerplate repeated across one company's postings are cut). Companies count once per skill, so a bulk
poster can't swamp the figures. The vocabulary is `config/skill_vocab.yaml` plus every skill in the
catalogue that no term covers. Rejected postings lose their text after 14 days (slim_old_postings), so the
daily run computes the current and the previous week and older weeks stay as computed.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from html import unescape
from typing import Any
from zoneinfo import ZoneInfo

from pipeline.config import load_config

STABLE_SOURCES = {"ba_api", "arbeitnow"}       # coverage that doesn't grow as career sites are added
MIN_TEXT = 300
TOTAL = "*"
BERLIN = ZoneInfo("Europe/Berlin")      # weeks run Monday to Sunday, German time


@dataclass(frozen=True)
class Term:
    name: str
    pattern: re.Pattern[str]
    skill_id: str | None = None
    generic: bool = False


def key_of(s: str) -> str:
    """Same normalisation as the web app's keyOf (skillmath.ts)."""
    return re.sub(r"\s+", " ", s.lower()).strip()


def vocabulary(catalog: list[dict[str, Any]], config: dict[str, Any] | None = None) -> list[Term]:
    """Config terms (linked to the catalogue skill they cover) plus catalogue skills no term covers."""
    config = config if config is not None else load_config("skill_vocab.yaml")
    by_key: dict[str, dict[str, Any]] = {}
    for s in catalog:
        for k in [s.get("name_key") or key_of(s["name"]), *(s.get("aliases") or [])]:
            by_key.setdefault(key_of(k), s)
    terms, linked = [], set()
    for t in config.get("terms", []):
        keys = [key_of(t["name"]), *(key_of(c) for c in t.get("covers") or [])]
        skill = next((by_key[k] for k in keys if k in by_key), None)
        if skill:
            linked.add(skill["id"])
        terms.append(Term(t["name"], re.compile(t["pattern"], 0 if t.get("case") else re.I),
                          skill["id"] if skill else None, bool(t.get("generic"))))
    for s in catalog:
        if s["id"] in linked:
            continue
        names = sorted({s["name"], *(s.get("aliases") or [])}, key=len, reverse=True)
        names = [n for n in names if len(n.strip()) >= 2]
        if names:
            alt = "|".join(re.escape(n.strip()) for n in names)
            terms.append(Term(s["name"], re.compile(rf"(?<![\w+#])({alt})(?![\w+#])", re.I), s["id"]))
    return terms


# -- the job part of a posting -----------------------------------------------------------------------------
_START = re.compile(
    r"(?im)^\W*(your (tasks|role|responsibilities|mission|profile)|ihre aufgaben|deine aufgaben|aufgaben|"
    r"what you.ll do|what you will do|the role|responsibilities|ihr profil|dein profil|requirements|"
    r"qualifications|qualifikation\w*|anforderungen|what you bring|was (du|sie) mitbring\w*|das bringst du mit|"
    r"das bringen sie mit|who you are|about you|what we.re looking for|you have|we expect|wir erwarten|"
    r"ihre qualifikation\w*|deine qualifikation\w*|must[- ]haves?)\b")
_STOP = re.compile(
    r"(?im)^\W*(we offer|wir bieten|was wir bieten|das bieten wir|unser angebot|benefits|perks|what we offer|"
    r"why (join|us)|warum wir|über uns|about us|kontakt|contact|deine vorteile|ihre vorteile|"
    r"what.s in it for you|our offer|compensation|equal opportunit)")
_SENTENCE = re.compile(r"(?<=[.!?])\s+|\n+")


def plain(html: str) -> str:
    t = re.sub(r"(?i)<br\s*/?>|</(p|li|h\d|div|ul|tr)>", "\n", html or "")
    return re.sub(r"[ \t ]+", " ", unescape(re.sub(r"<[^>]+>", " ", t)))


def boilerplate(rows: list[dict[str, Any]]) -> set[tuple[str, str]]:
    """(company, sentence) pairs repeated in at least half (and 3+) of a company's postings."""
    by_company: dict[str, list[str]] = defaultdict(list)
    for r in rows:
        by_company[r["company_key"]].append(r["_plain"])
    out = set()
    for comp, texts in by_company.items():
        if len(texts) < 3:
            continue
        n = Counter(s.strip() for t in texts for s in set(_SENTENCE.split(t)) if len(s.strip()) > 40)
        out |= {(comp, s) for s, c in n.items() if c >= 3 and c >= len(texts) / 2}
    return out


def job_part(text: str, company: str, boiler: set[tuple[str, str]]) -> str:
    t = "\n".join(s for s in _SENTENCE.split(text) if (company, s.strip()) not in boiler)
    m = _START.search(t)
    if not m:
        return t
    end = _STOP.search(t, m.end())
    return t[m.start(): end.start() if end else None]


# -- counting -----------------------------------------------------------------------------------------------
def monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def compute(postings: list[dict[str, Any]], terms: list[Term], week_start: date) -> list[dict[str, Any]]:
    """Rows for one week: per scope × family (and family 'all') × skill, plus the '*' totals rows.
    `postings`: id, company_key, title, description, title_family, source."""
    rows = [p for p in postings if p.get("title_family") and p.get("description") and len(p["description"]) > MIN_TEXT]
    for p in rows:
        p["_plain"] = plain(p["description"])
    boiler = boilerplate(rows)
    for p in rows:
        text = (p.get("title") or "") + "\n" + job_part(p["_plain"], p["company_key"], boiler)
        p["_hits"] = {t.name for t in terms if t.pattern.search(text)}
    meta = {t.name: t for t in terms}
    out = []
    for scope in ("all", "stable"):
        pop = rows if scope == "all" else [p for p in rows if p.get("source") in STABLE_SOURCES]
        groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for p in pop:
            groups[p["title_family"]].append(p)
            groups["all"].append(p)
        for family, ps in groups.items():
            out.append(_row(week_start, scope, family, TOTAL, None, False,
                            len({p["company_key"] for p in ps}), len(ps)))
            companies: dict[str, set[str]] = defaultdict(set)
            posts: Counter[str] = Counter()
            for p in ps:
                for h in p["_hits"]:
                    companies[h].add(p["company_key"])
                    posts[h] += 1
            for name, comps in companies.items():
                t = meta[name]
                out.append(_row(week_start, scope, family, name, t.skill_id, t.generic, len(comps), posts[name]))
    return out


def _row(week: date, scope: str, family: str, skill: str, skill_id: str | None, generic: bool,
         companies: int, postings: int) -> dict[str, Any]:
    return {"week_start": week.isoformat(), "scope": scope, "family": family, "skill": skill, "skill_id": skill_id,
            "generic": generic, "companies": companies, "postings": postings}


def weeks_to_compute(today: date, back: int = 1) -> list[date]:
    """The current week and `back` weeks before it (the daily run uses 1: texts of rejected postings last
    14 days, so the previous week is still complete until its first postings turn 14 days old)."""
    return [monday(today) - timedelta(weeks=i) for i in range(back, -1, -1)]


def run(db: Any, today: date, back: int = 1, config: dict[str, Any] | None = None) -> dict[str, int]:
    """Compute and store the weeks; returns {week: rows written}."""
    terms = vocabulary(db.skill_catalog(), config)
    written = {}
    for week in weeks_to_compute(today, back):
        start = datetime(week.year, week.month, week.day, tzinfo=BERLIN)
        end = datetime.combine(week + timedelta(days=7), datetime.min.time(), tzinfo=BERLIN)
        postings = db.postings_for_demand(start, end)
        rows = compute(postings, terms, week)
        db.replace_skill_demand(week, rows)
        written[week.isoformat()] = len(rows)
    return written
