"""Arbeitnow job board API (spec 7.1 tier 4). Free, no key, full descriptions.

Verified 2026-10-11: GET https://www.arbeitnow.com/api/job-board-api?page=N, 325 jobs per page,
newest first, updated hourly. Terms (from the API response): free public API, "please do not
abuse", link back appreciated (the digest names the source and links the posting).
Coverage is Europe-wide with free-text locations, so Germany is recognised from the text.
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from html import unescape
from typing import Any

import httpx

from pipeline.models import RawPosting

URL = "https://www.arbeitnow.com/api/job-board-api"
UA = "jobsignal/0.1 (personal job search; +https://github.com/awais-de/jobsignal)"

# Germany from free-text locations: country names, the 16 states, and larger cities.
_DE = re.compile(
    r"\b(germany|deutschland|bavaria|bayern|baden[- ]w(ü|ue)rttemberg|berlin|brandenburg|bremen|hamburg|hessen|"
    r"hesse|niedersachsen|lower saxony|mecklenburg|nordrhein[- ]westfalen|north rhine[- ]westphalia|nrw|"
    r"rheinland[- ]pfalz|rhineland[- ]palatinate|saarland|sachsen|saxony|th(ü|ue)ringen|thuringia|"
    r"schleswig[- ]holstein|m(ü|ue)nchen|munich|k(ö|oe)ln|cologne|frankfurt|stuttgart|d(ü|ue)sseldorf|"
    r"dortmund|essen|leipzig|dresden|hannover|hanover|n(ü|ue)rnberg|nuremberg|duisburg|bochum|wuppertal|"
    r"bielefeld|bonn|m(ü|ue)nster|mannheim|karlsruhe|augsburg|wiesbaden|mainz|aachen|kiel|freiburg|"
    r"heidelberg|darmstadt|regensburg|ingolstadt|w(ü|ue)rzburg|erlangen|ulm|potsdam|rostock|"
    r"magdeburg|erfurt|jena|ilmenau|halle|chemnitz|saarbr(ü|ue)cken|osnabr(ü|ue)ck|oldenburg|braunschweig|"
    r"brunswick|g(ö|oe)ttingen|kassel|paderborn|wolfsburg|heilbronn|pforzheim|ludwigshafen|koblenz|trier|"
    r"l(ü|ue)beck|gelsenkirchen|krefeld|m(ö|oe)nchengladbach|leverkusen|offenbach|f(ü|ue)rth|eschborn)\b",
    re.I,
)


def is_germany(location: str) -> bool:
    return bool(_DE.search(location or ""))


def contract_type(job_types: list[str]) -> str | None:
    t = " ".join(job_types).lower()
    if re.search(r"werkstudent|working student", t):
        return "werkstudent"
    if re.search(r"intern|praktikum", t):
        return "internship"
    if re.search(r"part[ -]?time|teilzeit", t) and not re.search(r"full[ -]?time|vollzeit", t):
        return "part_time"
    if re.search(r"full[ -]?time|vollzeit", t):
        return "full_time"
    return None


def _text(html: str) -> str:
    s = re.sub(r"<br\s*/?>|</(p|li|h[1-6]|div)>", "\n", html or "", flags=re.I)
    s = unescape(re.sub(r"<[^>]+>", " ", s))
    s = re.sub(r"[ \t ]+", " ", s)
    return re.sub(r"\n\s*\n\s*", "\n\n", s).strip()


class ArbeitnowSource:
    name = "arbeitnow"

    def __init__(self, settings: dict[str, Any], client: httpx.Client | None = None):
        self.max_pages = int(settings.get("max_pages", 5))
        self.days = int(settings.get("published_within_days", 2))
        self.delay = float(settings.get("request_delay_seconds", 1.0))
        self.client = client or httpx.Client(headers={"User-Agent": UA, "Accept": "application/json"}, timeout=30)

    def fetch(self, now: datetime | None = None) -> list[RawPosting]:
        cutoff = (now or datetime.now(timezone.utc)).timestamp() - self.days * 86400
        out: list[RawPosting] = []
        for page in range(1, self.max_pages + 1):
            if page > 1:
                time.sleep(self.delay)
            r = self.client.get(URL, params={"page": page})
            r.raise_for_status()
            data = r.json()
            jobs = data.get("data") or []
            for j in jobs:
                if (j.get("created_at") or 0) >= cutoff:
                    out.append(self._posting(j))
            # Newest first: stop once a page reaches jobs older than the window.
            if not jobs or (jobs[-1].get("created_at") or 0) < cutoff or not (data.get("links") or {}).get("next"):
                break
        return out

    @staticmethod
    def _posting(j: dict[str, Any]) -> RawPosting:
        loc = (j.get("location") or "").strip()
        de = is_germany(loc)
        city = loc.split(",")[0].strip() or None
        return RawPosting(
            source="arbeitnow", source_job_id=j["slug"], company_name=j.get("company_name") or "",
            title=(j.get("title") or "").strip(), source_url=j.get("url"), apply_url=j.get("url"),
            location_raw=loc or None, city=city if city and city.lower() != "remote" else None,
            # No clear German location means "not in Germany" (Europe-wide board; spec 7.4 location filter).
            country="DE" if de else None,
            remote_policy="remote" if j.get("remote") else None,
            description=_text(j.get("description") or "") or None,
            posted_date=datetime.fromtimestamp(j["created_at"], timezone.utc).date() if j.get("created_at") else None,
            contract_type=contract_type(j.get("job_types") or []),
            source_data={"tags": j.get("tags"), "job_types": j.get("job_types")},
        )
