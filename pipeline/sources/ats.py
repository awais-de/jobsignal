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
import time
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


PACE_SECONDS = 0.4   # between requests in multi-request feeds (Workday, SmartRecruiters details)


class ATS:
    def __init__(self, client: httpx.Client, pace: float = PACE_SECONDS):
        self.c = client
        self.pace = pace

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


    # -- SmartRecruiters (verified 2026-10-11) ---------------------------------------------
    # List API has no descriptions; details are fetched only for jobs not seen before.
    def smartrecruiters_probe(self, t: str):
        r = self.c.get(f"https://api.smartrecruiters.com/v1/companies/{t}/postings", params={"limit": 1})
        if r.status_code != 200:
            return None
        d = r.json()
        content = d.get("content") or []
        return int(d.get("totalFound") or 0), ((content[0].get("company") or {}).get("name") if content else "")

    def smartrecruiters_jobs(self, t: str, company: dict[str, Any], known=lambda ids: set(),
                             search_terms: list[str] | None = None, title_ok=lambda title: True, **_) -> list[RawPosting]:
        # Large employers list thousands of jobs in Germany: search with the owner's terms (like Workday).
        by_id: dict[str, dict[str, Any]] = {}
        for term in (search_terms or [""]):
            for offset in range(0, 200, 100):
                d = self.c.get(f"https://api.smartrecruiters.com/v1/companies/{t}/postings",
                               params={"country": "de", "q": term, "limit": 100, "offset": offset}).json()
                for i in d.get("content") or []:
                    by_id[i["id"]] = i
                if offset + 100 >= int(d.get("totalFound") or 0):
                    break
        items = [i for i in by_id.values() if title_ok(i.get("name") or "")]
        ids = [f"smartrecruiters:{t}:{i['id']}" for i in items]
        seen = known(ids)
        out = []
        for i, jid in zip(items, ids):
            loc = i.get("location") or {}
            kw = dict(title=i.get("name") or "", city=(loc.get("city") or "").title() or None,
                      country=_country(None, loc.get("country")), location_raw=loc.get("fullLocation"),
                      posted_date=_date(i.get("releasedDate")),
                      contract_type=_contract((i.get("typeOfEmployment") or {}).get("label")),
                      remote_policy="remote" if loc.get("remote") else ("hybrid" if loc.get("hybrid") else None),
                      source_url=f"https://jobs.smartrecruiters.com/{t}/{i['id']}",
                      apply_url=f"https://jobs.smartrecruiters.com/{t}/{i['id']}")
            if jid not in seen:
                time.sleep(self.pace)
                det = self.c.get(f"https://api.smartrecruiters.com/v1/companies/{t}/postings/{i['id']}").json()
                sections = ((det.get("jobAd") or {}).get("sections") or {})
                kw["description"] = "\n\n".join(_text(sec.get("text")) for k, sec in sections.items()
                                                 if k != "companyDescription" and isinstance(sec, dict)) or None
            out.append(_posting("smartrecruiters", t, i["id"], company, **kw))
        return out

    # -- Workday (verified 2026-10-11) --------------------------------------------------------
    # token = "host|tenant|site", e.g. "acme.wd3.myworkdayjobs.com|acme|AcmeCareers". Large employers list
    # thousands of jobs worldwide, so the search uses the owner's search terms and the Germany facet.
    def workday_jobs(self, token: str, company: dict[str, Any], known=lambda ids: set(),
                     search_terms: list[str] | None = None, title_ok=lambda title: True, **_) -> list[RawPosting]:
        host, tenant, site = token.split("|")
        api = f"https://{host}/wday/cxs/{tenant}/{site}"
        found: dict[str, dict[str, Any]] = {}
        for term in (search_terms or [""]):
            body: dict[str, Any] = {"appliedFacets": {}, "limit": 20, "offset": 0, "searchText": term}
            time.sleep(self.pace)
            first = self.c.post(f"{api}/jobs", json=body).json()
            facet = _workday_germany(first.get("facets") or [])
            if facet:
                body["appliedFacets"] = {facet[0]: [facet[1]]}
            for offset in (0, 20):
                d = first if (offset == 0 and not facet) else self.c.post(f"{api}/jobs", json={**body, "offset": offset}).json()
                for jp in d.get("jobPostings") or []:
                    if (facet or is_germany(jp.get("locationsText") or "")) and title_ok(jp.get("title") or ""):
                        found[jp["externalPath"]] = jp
                if len(d.get("jobPostings") or []) < 20:
                    break
        ids = {path: f"workday:{tenant}:{path.rsplit('/', 1)[-1]}" for path in found}
        seen = known(list(ids.values()))
        out = []
        for path, jp in found.items():
            kw = dict(title=jp.get("title") or "", location_raw=jp.get("locationsText"),
                      city=(jp.get("locationsText") or "").split(",")[0].strip() or None, country="DE",
                      source_url=f"https://{host}/{site}{path}", apply_url=f"https://{host}/{site}{path}")
            if ids[path] not in seen:
                time.sleep(self.pace)
                info = (self.c.get(f"{api}{path}").json().get("jobPostingInfo") or {})
                kw.update(description=_text(info.get("jobDescription")) or None, posted_date=_date(info.get("startDate")),
                          contract_type=_contract(info.get("timeType")),
                          country=_country(None, (info.get("country") or {}).get("descriptor")) or "DE",
                          city=(info.get("location") or kw["city"]))
            out.append(_posting("workday", tenant, path.rsplit("/", 1)[-1], company, **kw))
        return out

    # -- JOIN / Teamtailor: probe only (jobs via JSON-LD job pages, see careers.py) --------------
    def join_probe(self, t: str):
        r = self.c.get(f"https://join.com/companies/{t}")
        if r.status_code != 200:
            return None
        n = len(set(re.findall(rf"/companies/{re.escape(t)}/(\d+)", r.text)))
        return n, re.sub(r"^jobs at\s+|\s*\|\s*join$", "", _title(r.text), flags=re.I)

    def teamtailor_probe(self, t: str):
        r = self.c.get(f"https://{t}.teamtailor.com/jobs")
        if r.status_code != 200:
            return None
        n = len(set(re.findall(r"/jobs/(\d+)", r.text)))
        return n, re.sub(r"^jobs list\s*-\s*", "", _title(r.text), flags=re.I)


def _workday_germany(facets: list[dict[str, Any]]) -> tuple[str, str] | None:
    """(facet parameter, value id) of the 'Germany' location value. Values can sit inside nested
    facet groups (e.g. locationMainGroup > locationHierarchy1); the parameter to send is the one of
    the nearest enclosing facet, not the outer group (verified 2026-10-11: the outer one gives HTTP 400)."""
    stack = [(f, f.get("facetParameter")) for f in facets]
    while stack:
        node, param = stack.pop()
        if node.get("id") and re.fullmatch(r"(germany|deutschland)", (node.get("descriptor") or "").strip(), re.I):
            return param, node["id"]
        for child in node.get("values") or []:
            stack.append((child, child.get("facetParameter") or node.get("facetParameter") or param))
    return None


# Probe order: most common in German job ads first; the first verified hit wins.
PROBE_ORDER = ["personio", "softgarden", "greenhouse", "recruitee", "join", "smartrecruiters", "ashby",
               "teamtailor", "lever", "workable"]


def feed_jobs(ats_api: ATS, ats: str, token: str, company: dict[str, Any], **kw: Any) -> list[RawPosting]:
    """kw: known (ids -> already stored), search_terms and title_ok (Workday, SmartRecruiters:
    titles that can't pass the owner's filters are skipped before their details are fetched)."""
    fetch: Callable[..., list[RawPosting]] = getattr(ats_api, f"{ats}_jobs")
    if ats in ("smartrecruiters", "workday"):
        return fetch(token, company, **kw)
    return fetch(token, company)
