"""Bundesagentur für Arbeit Jobsuche API (spec 7.1, tier 1).

Verified against the live API on 2026-10-10:
- Search is v6: GET {BASE}/pc/v6/jobs (v4 search returns 403).
- Details are v4: GET {BASE}/pc/v4/jobdetails/{base64(referenznummer)} (v6 and v3 return 403).
- Auth: static public header X-API-Key: jobboerse-jobsuche. No rate-limit headers.
- Search params used: was, angebotsart=1 (Arbeit), arbeitszeit=vz (Vollzeit),
  veroeffentlichtseit (days, 0-100), page (from 1), size.
- veroeffentlichtseit matches the latest publication; datumErsteVeroeffentlichung
  is the first one, so it is used as posted_date (a re-published job is not fresh).
"""

from __future__ import annotations

import base64
import logging
import time
from datetime import date
from typing import Any

import httpx

from pipeline.models import RawPosting

log = logging.getLogger("jobsignal")

BASE = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service"
SEARCH_URL = f"{BASE}/pc/v6/jobs"
DETAIL_URL = f"{BASE}/pc/v4/jobdetails/{{code}}"
PUBLIC_URL = "https://www.arbeitsagentur.de/jobsuche/jobdetail/{refnr}"
HEADERS = {
    "X-API-Key": "jobboerse-jobsuche",
    "User-Agent": "jobsignal/0.1 (personal job search; github.com/awais-de/jobsignal)",
    "Accept": "application/json",
}
LAND_TO_ISO = {"DEUTSCHLAND": "DE", "OESTERREICH": "AT", "SCHWEIZ": "CH"}


class BundesagenturSource:
    name = "ba_api"

    def __init__(self, settings: dict[str, Any], client: httpx.Client | None = None):
        self.days = int(settings.get("published_within_days", 2))
        self.page_size = int(settings.get("page_size", 100))
        self.max_pages = int(settings.get("max_pages_per_term", 5))
        self.delay = float(settings.get("request_delay_seconds", 0.5))
        self.client = client or httpx.Client(headers=HEADERS, timeout=30)

    # -- search ---------------------------------------------------------------
    def fetch(self, terms: list[str]) -> list[RawPosting]:
        out: list[RawPosting] = []
        for term in terms:
            for page in range(1, self.max_pages + 1):
                data = self._get(SEARCH_URL, params={
                    "was": term,
                    "angebotsart": 1,
                    "arbeitszeit": "vz",
                    "veroeffentlichtseit": self.days,
                    "page": page,
                    "size": self.page_size,
                })
                items = data.get("ergebnisliste") or []
                out.extend(p for p in (parse_search_item(i) for i in items) if p)
                if len(items) < self.page_size or page * self.page_size >= int(data.get("maxErgebnisse", 0)):
                    break
        return out

    # -- details --------------------------------------------------------------
    def fetch_details(self, posting: RawPosting) -> None:
        """Fill description and agency flags in place. Raises on HTTP errors."""
        code = base64.b64encode(posting.source_job_id.encode()).decode()
        data = self._get(DETAIL_URL.format(code=code))
        apply_detail(posting, data)

    def _get(self, url: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        for attempt in range(4):
            if self.delay:
                time.sleep(self.delay)
            resp = self.client.get(url, params=params)
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(2 ** attempt * 2)
                continue
            resp.raise_for_status()
            return resp.json()
        raise RuntimeError("unreachable")


def parse_search_item(item: dict[str, Any]) -> RawPosting | None:
    refnr = item.get("referenznummer")
    title = item.get("stellenangebotsTitel") or item.get("hauptberuf")
    company = item.get("firma")
    if not (refnr and title and company):
        return None

    locations = item.get("stellenlokationen") or []
    addresses = [loc.get("adresse") or {} for loc in locations]
    german = [a for a in addresses if a.get("land") == "DEUTSCHLAND"]
    primary = next((a for a in german + addresses if a.get("ort")), (german or addresses or [{}])[0])
    location_raw = "; ".join(a["ort"] for a in addresses if a.get("ort")) or None

    return RawPosting(
        source="ba_api",
        source_job_id=refnr,
        company_name=company,
        title=title,
        source_url=PUBLIC_URL.format(refnr=refnr),
        location_raw=location_raw,
        city=primary.get("ort"),
        country="DE" if german else LAND_TO_ISO.get(primary.get("land", ""), primary.get("land")),
        remote_policy=_remote_policy(item),
        posted_date=_parse_date(item.get("datumErsteVeroeffentlichung")),
        contract_type="full_time" if item.get("arbeitszeitVollzeit") else None,
        salary_text=_salary(item),
        source_data={
            k: item[k]
            for k in ("hauptberuf", "eintrittszeitraum", "vertragsdauer", "homeofficetyp",
                      "homeofficeprozent", "aenderungsdatum", "veroeffentlichungszeitraum",
                      "arbeitgeberKundennummerHash")
            if k in item
        },
    )


def apply_detail(posting: RawPosting, data: dict[str, Any]) -> None:
    posting.description = data.get("stellenangebotsBeschreibung") or posting.description
    if data.get("istArbeitnehmerUeberlassung") or data.get("istPrivateArbeitsvermittlung"):
        posting.poster_type = "agency"
    else:
        posting.poster_type = "employer"
    for k in ("istArbeitnehmerUeberlassung", "istPrivateArbeitsvermittlung", "allianzpartnerName", "allianzpartnerUrl", "externeUrl"):
        if k in data:
            posting.source_data[k] = data[k]
    if data.get("externeUrl"):
        posting.apply_url = data["externeUrl"]


def _remote_policy(item: dict[str, Any]) -> str | None:
    if item.get("homeofficeprozent") == 100:
        return "remote"
    if item.get("homeofficemoeglich") is True:
        return "hybrid"
    if item.get("homeofficemoeglich") is False:
        return "onsite"
    return None


def _salary(item: dict[str, Any]) -> str | None:
    lo, hi = item.get("gehaltsspanneVon"), item.get("gehaltsspanneBis")
    if not (lo or hi):
        return None
    unit = {"JAHRESGEHALT": "/year", "MONATSGEHALT": "/month", "STUNDENLOHN": "/hour"}.get(item.get("verguetungsangabe", ""), "")
    fmt = lambda v: f"{v:,.0f}"
    amount = f"{fmt(lo)}–{fmt(hi)}" if lo and hi else fmt(lo or hi)
    return f"{amount} EUR{unit}"


def _parse_date(value: str | None) -> date | None:
    try:
        return date.fromisoformat(value[:10]) if value else None
    except ValueError:
        return None
