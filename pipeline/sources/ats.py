"""Public job feeds of common applicant-tracking systems (spec 7.1 tier 2), and probing them.

One adapter per ATS, never per company. Each adapter can:
  probe(token)  -> (job count, the company name the ATS itself shows) or None
  jobs(token)   -> list of RawPosting with full descriptions

Verified live 2026-10-11 (formats and identity sources): Personio (XML feed; name from the jobs
page title), Greenhouse (board name), Ashby (page title), Recruitee (company_name on offers),
softgarden (page title; jobs via JSON-LD, see careers.py). Lever and Workable follow their
documented formats and are `VERIFY` until a live company with jobs has been seen.
"""

from __future__ import annotations

import re
from datetime import date, datetime
from html import unescape
from typing import Any, Callable

import httpx

from pipeline.models import RawPosting
from pipeline.sources.arbeitnow import is_germany

SOURCE = "careers"


def _text(html: str | None) -> str:
    s = re.sub(r"<br\s*/?>|</(p|li|h[1-6]|div|tr)>", "\n", unescape(html or ""), flags=re.I)
    s = unescape(re.sub(r"<[^>]+>", " ", s))
    s = re.sub(r"[ \t ]+", " ", s)
    return re.sub(r"\n\s*\n\s*", "\n\n", s).strip()


def _date(value: Any) -> date | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):                       # epoch milliseconds (Lever)
        return datetime.utcfromtimestamp(value / 1000).date()
    s = str(value).replace(" UTC", "+00:00").replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(s[:25]).date()
    except ValueError:
        try:
            return date.fromisoformat(s[:10])
        except ValueError:
            return None


def _title(html: str) -> str:
    m = re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I)
    return unescape(m.group(1)).strip() if m else ""


# Places that are clearly not Germany (for feeds whose locations are bare office names).
_FOREIGN = re.compile(
    r"\b(usa?|united states|united kingdom|uk|england|london|new york|boston|san francisco|austin|chicago|"
    r"toronto|canada|france|paris|spain|madrid|barcelona|netherlands|amsterdam|poland|warsaw|krak[oó]w|"
    r"austria|österreich|wien|vienna|switzerland|schweiz|z(ü|u)rich|basel|geneva|portugal|lisbon|italy|milan|"
    r"india|bangalore|bulgaria|sofia|romania|bucharest|ireland|dublin|sweden|stockholm|denmark|copenhagen|"
    r"czech|prague|belgium|brussels|luxembourg|finland|helsinki|norway|oslo|greece|athens|turkey|istanbul|"
    r"dubai|singapore|australia|sydney|brazil|mexico|south africa)\b", re.I)


def _country(location: str | None, iso: str | None = None, default_de: bool = False) -> str | None:
    """ISO country. With default_de (bare office names from a German company's own feed), an
    office counts as Germany unless it names a foreign place."""
    if iso:
        iso = iso.strip()
        if iso.lower() in ("germany", "deutschland", "de"):
            return "DE"
        return iso.upper() if len(iso) == 2 else None
    if is_germany(location or ""):
        return "DE"
    if default_de and location and not _FOREIGN.search(location):
        return "DE"
    return None


def _contract(text: str | None) -> str | None:
    t = (text or "").lower()
    if re.search(r"working.?student|werkstudent", t):
        return "werkstudent"
    if re.search(r"intern|praktik", t):
        return "internship"
    if re.search(r"part.?time|teilzeit", t):
        return "part_time"
    if re.search(r"full.?time|vollzeit|permanent", t):
        return "full_time"
    return None


def _posting(ats: str, token: str, job_id: Any, company: dict[str, Any], **kw: Any) -> RawPosting:
    city = kw.pop("city", None)
    return RawPosting(source=SOURCE, source_job_id=f"{ats}:{token}:{job_id}", company_name=company["name"],
                      city=city, location_raw=kw.pop("location_raw", None) or city,
                      source_data={"company_watch": company["name"], "technique": f"ats:{ats}"}, **kw)


class ATS:
    def __init__(self, client: httpx.Client):
        self.c = client

    # -- Personio ---------------------------------------------------------------------
    def personio_probe(self, t: str):
        r = self.c.get(f"https://{t}.jobs.personio.de/xml")
        if r.status_code != 200 or "<workzag-jobs" not in r.text[:500]:
            return None
        n = r.text.count("<position>")
        page = self.c.get(f"https://{t}.jobs.personio.de/")
        name = re.sub(r"^(jobs (bei|at)|karriere bei|stellenangebote bei)\s+", "", _title(page.text), flags=re.I)
        return n, name

    def personio_jobs(self, t: str, company: dict[str, Any]) -> list[RawPosting]:
        x = self.c.get(f"https://{t}.jobs.personio.de/xml").text
        out = []
        for pos in re.findall(r"<position>(.*?)</position>", x, re.S):
            get = lambda tag: (re.search(rf"<{tag}>(.*?)</{tag}>", pos, re.S) or [None, None])[1]  # noqa: E731
            jid = get("id")
            office = unescape(get("office") or "")
            desc = "\n\n".join(_text(v) for v in re.findall(r"<value>(.*?)</value>", pos, re.S))
            desc = re.sub(r"<!\[CDATA\[|\]\]>", "", desc)
            out.append(_posting("personio", t, jid, company, title=unescape(get("name") or ""),
                                city=office.split(",")[0].strip() or None, country=_country(office, default_de=True),
                                location_raw=office or None, description=desc or None, posted_date=_date(get("createdAt")),
                                contract_type=_contract(f"{get('employmentType')} {get('schedule')}"),
                                source_url=f"https://{t}.jobs.personio.de/job/{jid}",
                                apply_url=f"https://{t}.jobs.personio.de/job/{jid}"))
        return out

    # -- Greenhouse -------------------------------------------------------------------
    def greenhouse_probe(self, t: str):
        r = self.c.get(f"https://boards-api.greenhouse.io/v1/boards/{t}")
        if r.status_code != 200:
            return None
        jobs = self.c.get(f"https://boards-api.greenhouse.io/v1/boards/{t}/jobs").json().get("jobs", [])
        return len(jobs), r.json().get("name") or ""

    def greenhouse_jobs(self, t: str, company: dict[str, Any]) -> list[RawPosting]:
        jobs = self.c.get(f"https://boards-api.greenhouse.io/v1/boards/{t}/jobs", params={"content": "true"}).json()
        out = []
        for j in jobs.get("jobs", []):
            loc = (j.get("location") or {}).get("name") or ""
            out.append(_posting("greenhouse", t, j["id"], company, title=j.get("title") or "",
                                city=loc.split(",")[0].strip() or None, country=_country(loc), location_raw=loc or None,
                                description=_text(j.get("content")) or None,
                                posted_date=_date(j.get("first_published") or j.get("updated_at")),
                                source_url=j.get("absolute_url"), apply_url=j.get("absolute_url")))
        return out

    # -- Ashby ------------------------------------------------------------------------
    def ashby_probe(self, t: str):
        r = self.c.get(f"https://api.ashbyhq.com/posting-api/job-board/{t}")
        if r.status_code != 200:
            return None
        name = re.sub(r"\s+jobs$", "", _title(self.c.get(f"https://jobs.ashbyhq.com/{t}").text), flags=re.I)
        return len(r.json().get("jobs", [])), name

    def ashby_jobs(self, t: str, company: dict[str, Any]) -> list[RawPosting]:
        out = []
        for j in self.c.get(f"https://api.ashbyhq.com/posting-api/job-board/{t}").json().get("jobs", []):
            if j.get("isListed") is False:
                continue
            addr = ((j.get("address") or {}).get("postalAddress") or {})
            out.append(_posting("ashby", t, j["id"], company, title=j.get("title") or "",
                                city=addr.get("addressLocality") or (j.get("location") or "").split(",")[0] or None,
                                country=_country(j.get("location"), addr.get("addressCountry")),
                                location_raw=j.get("location"), description=j.get("descriptionPlain") or _text(j.get("descriptionHtml")) or None,
                                posted_date=_date(j.get("publishedAt")), contract_type=_contract(j.get("employmentType")),
                                remote_policy="remote" if j.get("isRemote") else None,
                                source_url=j.get("jobUrl"), apply_url=j.get("applyUrl") or j.get("jobUrl")))
        return out

    # -- Recruitee --------------------------------------------------------------------
    def recruitee_probe(self, t: str):
        r = self.c.get(f"https://{t}.recruitee.com/api/offers/")
        if r.status_code != 200:
            return None
        offers = r.json().get("offers", [])
        return len(offers), (offers[0].get("company_name") if offers else "")

    def recruitee_jobs(self, t: str, company: dict[str, Any]) -> list[RawPosting]:
        out = []
        for o in self.c.get(f"https://{t}.recruitee.com/api/offers/").json().get("offers", []):
            desc = "\n\n".join(x for x in (_text(o.get("description")), _text(o.get("requirements"))) if x)
            out.append(_posting("recruitee", t, o["id"], company, title=o.get("title") or "",
                                city=o.get("city"), country=_country(o.get("city"), o.get("country_code")),
                                description=desc or None, posted_date=_date(o.get("created_at")),
                                contract_type=_contract(o.get("employment_type_code")),
                                remote_policy="remote" if o.get("remote") else ("hybrid" if o.get("hybrid") else None),
                                source_url=o.get("careers_url"), apply_url=o.get("careers_apply_url") or o.get("careers_url")))
        return out

    # -- Lever (VERIFY) -----------------------------------------------------------------
    def lever_probe(self, t: str):
        r = self.c.get(f"https://api.lever.co/v0/postings/{t}", params={"mode": "json"})
        if r.status_code != 200 or not isinstance(r.json(), list):
            return None
        name = re.sub(r"\s*[-–|].*$", "", _title(self.c.get(f"https://jobs.lever.co/{t}").text))
        return len(r.json()), name

    def lever_jobs(self, t: str, company: dict[str, Any]) -> list[RawPosting]:
        out = []
        for j in self.c.get(f"https://api.lever.co/v0/postings/{t}", params={"mode": "json"}).json():
            cat = j.get("categories") or {}
            loc = cat.get("location") or ""
            desc = "\n\n".join(x for x in [j.get("descriptionPlain") or ""] +
                               [f"{l.get('text')}\n{_text(l.get('content'))}" for l in j.get("lists") or []] +
                               [j.get("additionalPlain") or ""] if x)
            out.append(_posting("lever", t, j["id"], company, title=j.get("text") or "",
                                city=loc.split(",")[0].strip() or None, country=_country(loc, j.get("country")),
                                location_raw=loc or None, description=desc or None, posted_date=_date(j.get("createdAt")),
                                contract_type=_contract(cat.get("commitment")),
                                source_url=j.get("hostedUrl"), apply_url=j.get("applyUrl") or j.get("hostedUrl")))
        return out

    # -- Workable (VERIFY) ----------------------------------------------------------------
    def workable_probe(self, t: str):
        r = self.c.get(f"https://apply.workable.com/api/v1/widget/accounts/{t}")
        if r.status_code != 200:
            return None
        d = r.json()
        return len(d.get("jobs", [])), d.get("name") or ""

    def workable_jobs(self, t: str, company: dict[str, Any]) -> list[RawPosting]:
        d = self.c.get(f"https://apply.workable.com/api/v1/widget/accounts/{t}", params={"details": "true"}).json()
        out = []
        for j in d.get("jobs", []):
            loc = ", ".join(x for x in (j.get("city"), j.get("state"), j.get("country")) if x)
            out.append(_posting("workable", t, j.get("shortcode") or j.get("id"), company, title=j.get("title") or "",
                                city=j.get("city"), country=_country(loc, j.get("country")), location_raw=loc or None,
                                description=_text(j.get("description")) or None,
                                posted_date=_date(j.get("published_on") or j.get("created_at")),
                                contract_type=_contract(j.get("employment_type")),
                                remote_policy="remote" if j.get("telecommuting") else None,
                                source_url=j.get("url") or j.get("shortlink"), apply_url=j.get("url") or j.get("shortlink")))
        return out

    # -- softgarden: probe only (jobs come from JSON-LD via careers.py) -----------------------
    def softgarden_probe(self, t: str):
        r = self.c.get(f"https://{t}.softgarden.io/en/vacancies")
        if r.status_code != 200 or "softgarden" not in r.text[:30000]:
            return None
        n = len(set(re.findall(r"/job/(\d+)/", r.text)))
        return n, re.sub(r"^.*\|\s*", "", _title(r.text))


# Probe order: most common in German job ads first; the first verified hit wins.
PROBE_ORDER = ["personio", "softgarden", "greenhouse", "recruitee", "ashby", "lever", "workable"]


def feed_jobs(ats_api: ATS, ats: str, token: str, company: dict[str, Any]) -> list[RawPosting]:
    fetch: Callable[[str, dict[str, Any]], list[RawPosting]] = getattr(ats_api, f"{ats}_jobs")
    return fetch(token, company)
