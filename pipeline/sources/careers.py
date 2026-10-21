"""Company watchlist (spec 7.1 tiers 2-3, 7.2): generic techniques only, no per-site scrapers.

Techniques (set per company in the private profile under `watchlist`):

- career_page: the careers page (or its sitemap.xml) → job links matching `link_pattern` →
  schema.org JobPosting JSON-LD on each job page; pages without JSON-LD fall back to LLM
  extraction from the page text (spec 7.1 tier 3, technique 2).
- cornerstone: Cornerstone OnDemand career sites, via the public job-search API the career
  site itself uses (token embedded in the page). One adapter for every company on csod.com.

Only job pages not seen before are fetched; known ones are just marked as still listed.
robots.txt is respected and requests are paced.
"""

from __future__ import annotations

import json
import logging
import re
import time
from datetime import date, datetime
from html import unescape
from typing import Any, Callable
from urllib.parse import unquote, urljoin, urlparse, urlunparse
from urllib.robotparser import RobotFileParser

import httpx

from pipeline.models import RawPosting
from pipeline.sources.arbeitnow import is_germany
from pipeline.sources.ats import _FOREIGN, ATS, feed_jobs

log = logging.getLogger("jobsignal")

SOURCE = "careers"
BIG_PORTAL = 500   # job links on one careers site from which German-place filtering applies
UA = "Mozilla/5.0 (compatible; jobsignal/0.1; personal job search; +https://github.com/awais-de/jobsignal)"
COUNTRY_ISO = {"germany": "DE", "deutschland": "DE", "de": "DE", "austria": "AT", "österreich": "AT",
               "switzerland": "CH", "schweiz": "CH", "united kingdom": "GB", "uk": "GB", "gb": "GB",
               "united states": "US", "usa": "US", "us": "US", "france": "FR", "fr": "FR"}
# Per-company filter mode (profile watchlist `filters:`):
#   all   - the owner's normal filters (title list, block list, location, dealbreakers)
#   watch - every title except the block list; location and dealbreakers apply (default)
#   none  - no filters at all: every job, every day
FILTER_MODES = ("all", "watch", "none")
EMPLOYMENT = {"FULL_TIME": "full_time", "PART_TIME": "part_time", "INTERN": "internship",
              "CONTRACTOR": "freelance"}


class CareersSource:
    name = SOURCE

    def __init__(self, companies: list[dict[str, Any]], settings: dict[str, Any],
                 known_ids: Callable[[list[str]], set[str]],
                 page_extractor: Callable[[str, str, str], dict[str, Any] | None] | None = None,
                 client: httpx.Client | None = None):
        """`known_ids(ids)` returns the ids already stored; `page_extractor(company, url, text)`
        returns {title, city, country, employment_type} from page text, or None."""
        self.companies = companies
        self.delay = float(settings.get("request_delay_seconds", 1.0))
        self.max_new = int(settings.get("max_new_pages_per_company", 120))
        # A huge portal on its first load (2026-10-21: 9,000 links, AI-read pages, ~11 min) stops at this budget;
        # the next runs carry on where it stopped.
        self.time_budget = float(settings.get("company_time_budget_seconds", 300))
        self.search_terms: list[str] = list(settings.get("search_terms") or [])   # Workday search
        self.title_allow = [re.compile(p, re.I) for p in settings.get("title_allow") or []]
        self.known_ids = known_ids
        self.page_extractor = page_extractor
        self.client = client or httpx.Client(headers={"User-Agent": UA}, timeout=30, follow_redirects=True)
        self._robots: dict[str, RobotFileParser | None] = {}
        self.results: list[dict[str, Any]] = []   # per-company status for source_runs

    # -- public -----------------------------------------------------------------------
    def fetch_company(self, company: dict[str, Any]) -> list[RawPosting]:
        technique = company.get("technique", "career_page")
        if technique == "cornerstone":
            out = self._cornerstone(company)
        elif technique == "career_page":
            out = self._career_page(company)
        elif technique == "ats":
            out = self._ats(company)
        else:
            raise ValueError(f"unknown technique {technique}")
        mode = company.get("filters", "watch")
        if mode not in FILTER_MODES:
            raise ValueError(f"unknown filters mode {mode}")
        for posting in out:
            posting.source_data["filter_mode"] = mode
            if company.get("company_id"):
                posting.source_data["company_id"] = company["company_id"]
        return out

    # -- ats (discovered companies; spec 7.2) ----------------------------------------------
    def _ats(self, company: dict[str, Any]) -> list[RawPosting]:
        all_mode = company.get("filters", "watch") == "all" and self.title_allow
        jobs = feed_jobs(ATS(self.client), company["ats"], company["token"], company,
                         known=self.known_ids, search_terms=self.search_terms,
                         title_ok=(lambda t: any(p.search(t) for p in self.title_allow)) if all_mode else (lambda t: True))
        ids = [p.source_job_id for p in jobs]
        initial = not self.known_ids(ids) if ids else False
        for p in jobs:
            p.source_data["initial_load"] = initial
        return jobs

    # -- career_page ----------------------------------------------------------------------
    def _career_page(self, company: dict[str, Any]) -> list[RawPosting]:
        url = company["url"]
        # A page without a pattern (e.g. a JSON-LD career page) uses the common job-link paths.
        pattern = re.compile(company.get("link_pattern") or r"/(jobs?|stellen[a-z-]*|karriere|careers?|vacanc[a-z]*|positions?|job-offers?)/")
        text = self._get(url).text
        if text.lstrip().startswith("<?xml") or "<urlset" in text[:500]:
            links = [unescape(u) for u in re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", text)]
        else:
            links = [urljoin(url, unescape(h)) for h in re.findall(r'href=["\']([^"\'#]+)["\']', text)]
        links = sorted({_canonical(u) for u in links if pattern.search(u)})

        links = [u for u in links if self._worth_fetching(u, company)]
        known = self.known_ids(links) if links else set()
        initial = not known
        # Big international portals name the place in the job URL (2026-10-21: 9,000 links, 420 in Germany).
        # When enough of them name a German place, new links naming none are skipped; known ones still count.
        if len(links) >= BIG_PORTAL:
            german = {u for u in links if is_germany(_url_words(u))}
            if len(german) >= max(10, len(links) // 50):
                links = [u for u in links if u in known or u in german]
        out: list[RawPosting] = []
        fetched = 0
        deadline = time.monotonic() + self.time_budget
        for link in links:
            if link in known:
                out.append(_stub(link, company))      # still listed: only last_seen_at is updated
                continue
            if fetched >= self.max_new or time.monotonic() > deadline:
                continue                              # keep adding stubs for the known links that follow
            fetched += 1
            try:
                posting = self._job_page(link, company)
            except (httpx.HTTPError, ValueError) as exc:
                log.warning("careers: a job page failed (%s)", type(exc).__name__)
                continue
            if posting:
                posting.source_data["initial_load"] = initial
                out.append(posting)
        return out

    def _worth_fetching(self, url: str, company: dict[str, Any]) -> bool:
        """Large portals list thousands of jobs worldwide: skip URLs that name a foreign place, and for
        companies on the normal filters, URLs whose readable title words can't match the title list."""
        words = _url_words(url)
        if _FOREIGN.search(words):
            return False
        if company.get("filters", "watch") == "all" and self.title_allow and len(re.findall(r"[A-Za-zÄÖÜäöüß]{3,}", words)) >= 2:
            return any(p.search(words) for p in self.title_allow)
        return True

    def _job_page(self, url: str, company: dict[str, Any]) -> RawPosting | None:
        html = self._get(url).text
        ld = _job_posting_ld(html)
        if ld:
            return _from_ld(ld, url, company)
        if not self.page_extractor:
            return None
        text = _html_to_text(html)[:8000]
        info = self.page_extractor(company["name"], url, text)
        if not info or not info.get("is_job_posting") or not info.get("title"):
            return None
        return RawPosting(
            source=SOURCE, source_job_id=url, company_name=company["name"], title=info["title"],
            source_url=url, apply_url=url, city=info.get("city"),
            country=(info.get("country") or "").upper() or None, location_raw=info.get("city"),
            description=text, contract_type=EMPLOYMENT.get((info.get("employment_type") or "").upper()),
            source_data={"company_watch": company["name"], "technique": "page_llm"},
        )

    # -- cornerstone ----------------------------------------------------------------------
    def _cornerstone(self, company: dict[str, Any]) -> list[RawPosting]:
        url = company["url"]
        page = self._get(url).text
        token = re.search(r'"token"\s*:\s*"([^"]+)"', page)
        api = re.search(r'"cloud"\s*:\s*"([^"]+)"', page)
        site = re.search(r"/careersite/(\d+)", url)
        if not (token and api and site):
            raise ValueError("cornerstone page without token/api/site id")
        culture_id = int((re.search(r'"cultureID"\s*:\s*(\d+)', page) or [None, 1])[1])
        culture = (re.search(r'"cultureName"\s*:\s*"([^"]+)"', page) or [None, "en-US"])[1]
        host = urlparse(url).netloc
        tenant = host.split(".")[0]

        reqs: list[dict[str, Any]] = []
        for page_no in range(1, 11):
            time.sleep(self.delay)
            r = self.client.post(api.group(1).rstrip("/") + "/rec-job-search/external/jobs",
                                 headers={"Authorization": f"Bearer {token.group(1)}", "Origin": f"https://{host}"},
                                 json={"careerSiteId": int(site.group(1)), "careerSitePageId": int(site.group(1)),
                                       "pageNumber": page_no, "pageSize": 50, "cultureId": culture_id,
                                       "searchText": "", "cultureName": culture, "states": [], "countryCodes": [],
                                       "cities": [], "placeID": "", "radius": None, "postingsWithinDays": None,
                                       "customFieldCheckboxKeys": [], "customFieldDropdowns": [],
                                       "customFieldRadios": []})
            r.raise_for_status()
            data = r.json().get("data") or {}
            batch = data.get("requisitions") or []
            reqs.extend(batch)
            if len(batch) < 50 or len(reqs) >= int(data.get("totalCount") or 0):
                break

        ids = [f"{host}:{q['requisitionId']}" for q in reqs]
        initial = not self.known_ids(ids) if ids else False
        out = []
        for q, jid in zip(reqs, ids):
            locs = q.get("locations") or []
            de = [l for l in locs if (l.get("country") or "").upper() == "DE"]
            primary = (de or locs or [{}])[0]
            out.append(RawPosting(
                source=SOURCE, source_job_id=jid, company_name=company["name"], title=q.get("displayJobTitle") or "",
                source_url=f"https://{host}/ux/ats/careersite/{site.group(1)}/home/requisition/{q['requisitionId']}?c={tenant}",
                apply_url=f"https://{host}/ux/ats/careersite/{site.group(1)}/home/requisition/{q['requisitionId']}?c={tenant}",
                city=primary.get("city"), country="DE" if de else (primary.get("country") or None),
                location_raw="; ".join(l.get("city") or "" for l in locs if l.get("city")) or None,
                posted_date=_dmy(q.get("postingEffectiveDate")),
                # The search API only returns a ~125-character teaser; no full description.
                description=None,
                source_data={"company_watch": company["name"], "technique": "cornerstone",
                             "teaser": q.get("externalDescription"), "initial_load": initial},
            ))
        return out

    # -- http ---------------------------------------------------------------------------
    def _get(self, url: str) -> httpx.Response:
        if not self._allowed(url):
            raise ValueError("disallowed by robots.txt")
        time.sleep(self.delay)
        r = self.client.get(url)
        r.raise_for_status()
        return r

    def _allowed(self, url: str) -> bool:
        p = urlparse(url)
        base = f"{p.scheme}://{p.netloc}"
        if base not in self._robots:
            rp: RobotFileParser | None = RobotFileParser()
            try:
                r = self.client.get(base + "/robots.txt")
                if r.status_code >= 400:
                    rp = None                    # no robots.txt: everything allowed
                else:
                    rp.parse(r.text.splitlines())
            except httpx.HTTPError:
                rp = None
            self._robots[base] = rp
        rp = self._robots[base]
        return rp is None or rp.can_fetch(UA, url)


# -- helpers ----------------------------------------------------------------------------
def _url_words(url: str) -> str:
    """The readable words of a URL path ('M%C3%BCnchen' → 'München')."""
    return re.sub(r"[-_/%0-9()]+", " ", unquote(unescape(urlparse(url).path))).strip()


def _canonical(url: str) -> str:
    """Drop tracking query parameters and fragments; keep the path (it identifies the job)."""
    p = urlparse(url)
    return urlunparse((p.scheme, p.netloc, p.path, "", "", ""))


def _stub(url: str, company: dict[str, Any]) -> RawPosting:
    return RawPosting(source=SOURCE, source_job_id=url, company_name=company["name"], title="(known)",
                      source_data={"stub": True})


def _job_posting_ld(html: str) -> dict[str, Any] | None:
    for block in re.findall(r'<script[^>]+application/ld\+json[^>]*>(.*?)</script>', html, re.S | re.I):
        try:
            data = json.loads(block.strip())
        except json.JSONDecodeError:
            continue
        items = data if isinstance(data, list) else [data] + (data.get("@graph", []) if isinstance(data, dict) else [])
        for it in items:
            t = it.get("@type") if isinstance(it, dict) else None
            if t == "JobPosting" or (isinstance(t, list) and "JobPosting" in t):
                return it
    return None


def _from_ld(ld: dict[str, Any], url: str, company: dict[str, Any]) -> RawPosting:
    org = ld.get("hiringOrganization")
    org_name = org.get("name") if isinstance(org, dict) else org
    locs = ld.get("jobLocation") or []
    locs = locs if isinstance(locs, list) else [locs]
    addrs = [(l.get("address") or {}) if isinstance(l, dict) else {} for l in locs]
    addrs = [a if isinstance(a, dict) else {} for a in addrs]
    countries = [_iso(a.get("addressCountry")) for a in addrs]
    de = [a for a, c in zip(addrs, countries) if c == "DE"]
    primary = (de or addrs or [{}])[0]
    remote = "remote" if str(ld.get("jobLocationType", "")).upper() == "TELECOMMUTE" else None
    et = ld.get("employmentType")
    et = et[0] if isinstance(et, list) and et else et
    return RawPosting(
        source=SOURCE, source_job_id=url, company_name=company["name"] or org_name or "",
        title=unescape(str(ld.get("title") or "")).strip(), source_url=url, apply_url=url,
        city=primary.get("addressLocality"), country="DE" if de else (countries[0] if countries else None),
        location_raw="; ".join(a.get("addressLocality") for a in addrs if a.get("addressLocality")) or None,
        remote_policy=remote, description=_html_to_text(str(ld.get("description") or "")) or None,
        posted_date=_iso_date(ld.get("datePosted")), contract_type=EMPLOYMENT.get(str(et or "").upper()),
        source_data={"company_watch": company["name"], "technique": "jsonld", "hiring_org": org_name,
                     "valid_through": ld.get("validThrough")},
    )


def _iso(country: Any) -> str | None:
    if isinstance(country, dict):
        country = country.get("name")
    if not country:
        return None
    s = str(country).strip()
    return COUNTRY_ISO.get(s.lower(), s.upper() if len(s) == 2 else None)


def _iso_date(value: Any) -> date | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")[:25]).date() if value else None
    except ValueError:
        try:
            return date.fromisoformat(str(value)[:10])
        except ValueError:
            return None


def _dmy(value: Any) -> date | None:
    m = re.match(r"(\d{1,2})/(\d{1,2})/(\d{4})", str(value or ""))
    return date(int(m[3]), int(m[2]), int(m[1])) if m else None


def _html_to_text(html: str) -> str:
    s = re.sub(r"<(script|style|noscript|svg|nav|footer|header)[\s\S]*?</\1>", " ", html, flags=re.I)
    s = re.sub(r"<br\s*/?>|</(p|li|h[1-6]|div|tr)>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", " ", s)
    s = unescape(s)
    s = re.sub(r"[ \t ]+", " ", s)
    return re.sub(r"\n\s*\n\s*", "\n\n", s).strip()
