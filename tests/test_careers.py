"""Company watchlist source, against invented sites (spec 13.1: no real company data in fixtures)."""

import json

import httpx

from pipeline.sources.careers import CareersSource

LD = {
    "@context": "https://schema.org", "@type": "JobPosting", "title": "Data Engineer (m/w/d)",
    "datePosted": "2026-10-09T10:00:00+02:00", "employmentType": ["FULL_TIME"],
    "hiringOrganization": {"@type": "Organization", "name": "Beispiel Daten GmbH"},
    "jobLocation": [{"@type": "Place", "address": {"addressLocality": "Köln", "addressCountry": "DE"}}],
    "description": "<p>Pipelines mit <b>Python</b> und dbt.</p>",
}


def job_page(ld=LD):
    return f'<html><script type="application/ld+json">{json.dumps(ld)}</script><body>x</body></html>'


def make(routes, companies, known=frozenset(), extractor=None):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        body = routes.get(str(request.url).split("?")[0])
        if body is None:
            return httpx.Response(404)
        if isinstance(body, httpx.Response):
            return body
        return httpx.Response(200, text=body) if isinstance(body, str) else httpx.Response(200, json=body)

    src = CareersSource(companies, {"request_delay_seconds": 0}, known_ids=lambda ids: set(ids) & set(known),
                        page_extractor=extractor, client=httpx.Client(transport=httpx.MockTransport(handler)))
    return src, seen


COMPANY = {"name": "Beispiel Daten", "technique": "career_page", "url": "https://jobs.example.org/en/vacancies",
           "link_pattern": r"/job/\d+/"}
LIST = '<a href="../job/1/data-engineer?ref=x">A</a><a href="/job/2/analyst">B</a><a href="/about">C</a>'


def test_career_page_jsonld():
    src, _ = make({"https://jobs.example.org/en/vacancies": LIST,
                   "https://jobs.example.org/job/1/data-engineer": job_page(),
                   "https://jobs.example.org/job/2/analyst": job_page({**LD, "title": "Analyst"})}, [COMPANY])
    got = src.fetch_company(COMPANY)
    assert [p.title for p in got] == ["Data Engineer (m/w/d)", "Analyst"]
    p = got[0]
    assert p.source_job_id == "https://jobs.example.org/job/1/data-engineer"   # tracking query dropped
    assert (p.city, p.country, str(p.posted_date), p.contract_type) == ("Köln", "DE", "2026-10-09", "full_time")
    assert p.description == "Pipelines mit Python und dbt." and p.company_name == "Beispiel Daten"
    assert p.source_data["initial_load"] is True


def test_known_pages_are_not_refetched():
    src, seen = make({"https://jobs.example.org/en/vacancies": LIST,
                      "https://jobs.example.org/job/2/analyst": job_page()}, [COMPANY],
                     known={"https://jobs.example.org/job/1/data-engineer"})
    got = src.fetch_company(COMPANY)
    assert got[0].source_data.get("stub") is True
    assert not any("/job/1/" in u for u in seen)
    assert got[1].source_data["initial_load"] is False        # company already known


def test_new_pages_stop_at_the_cap_but_known_links_still_count():
    links = "".join(f'<a href="/job/{i}/x">{i}</a>' for i in range(1, 6))
    routes = {"https://jobs.example.org/en/vacancies": links,
              **{f"https://jobs.example.org/job/{i}/x": job_page() for i in range(1, 6)}}
    src, seen = make(routes, [COMPANY], known={"https://jobs.example.org/job/5/x"})
    src.max_new = 2
    got = src.fetch_company(COMPANY)
    assert sum(1 for u in seen if "/job/" in u) == 2
    assert [p.source_data.get("stub", False) for p in got] == [False, False, True]   # job 5 still listed


def test_new_pages_stop_at_the_time_budget():
    links = "".join(f'<a href="/job/{i}/x">{i}</a>' for i in range(1, 4))
    routes = {"https://jobs.example.org/en/vacancies": links,
              **{f"https://jobs.example.org/job/{i}/x": job_page() for i in range(1, 4)}}
    src, seen = make(routes, [COMPANY])
    src.time_budget = 0
    assert src.fetch_company(COMPANY) == [] and not any("/job/" in u for u in seen)


def test_sitemap_links():
    sitemap = ('<?xml version="1.0"?><urlset><url><loc>https://jobs.example.org/de/job/A/1</loc></url>'
               '<url><loc>https://jobs.example.org/de/about</loc></url></urlset>')
    c = {**COMPANY, "url": "https://jobs.example.org/sitemap.xml", "link_pattern": "/de/job/"}
    src, _ = make({"https://jobs.example.org/sitemap.xml": sitemap,
                   "https://jobs.example.org/de/job/A/1": job_page()}, [c])
    assert [p.source_job_id for p in src.fetch_company(c)] == ["https://jobs.example.org/de/job/A/1"]


def test_page_without_jsonld_uses_llm_fallback():
    calls = []

    def extractor(company, url, text):
        calls.append(url)
        return {"is_job_posting": True, "title": "Sales Manager", "city": "Berlin", "country": "de",
                "employment_type": "FULL_TIME"}

    src, _ = make({"https://jobs.example.org/en/vacancies": '<a href="/job/3/sales">x</a>',
                   "https://jobs.example.org/job/3/sales": "<html><body><h1>Sales Manager</h1>Berlin</body></html>"},
                  [COMPANY], extractor=extractor)
    p = src.fetch_company(COMPANY)[0]
    assert (p.title, p.city, p.country, p.contract_type) == ("Sales Manager", "Berlin", "DE", "full_time")
    assert calls == ["https://jobs.example.org/job/3/sales"]


def test_robots_txt_is_respected():
    src, _ = make({"https://jobs.example.org/robots.txt": "User-agent: *\nDisallow: /en/",
                   "https://jobs.example.org/en/vacancies": LIST}, [COMPANY])
    try:
        src.fetch_company(COMPANY)
        raise AssertionError("expected robots.txt to block")
    except ValueError as exc:
        assert "robots" in str(exc)


def test_cornerstone():
    page = '{"token":"abc","cloud":"https://api.example.org/","cultureID":2,"cultureName":"en-GB"}'
    c = {"name": "Musterfirma", "technique": "cornerstone",
         "url": "https://musterfirma.csod.com/ux/ats/careersite/4/home?c=musterfirma"}
    api = {"data": {"totalCount": 2, "requisitions": [
        {"requisitionId": 7, "displayJobTitle": "Data Engineer (m/f/d)", "postingEffectiveDate": "05/10/2026",
         "locations": [{"city": "Paris", "country": "FR"}, {"city": "Munich", "country": "DE"}],
         "externalDescription": "Teaser"},
        {"requisitionId": 8, "displayJobTitle": "Sales", "postingEffectiveDate": "01/10/2026",
         "locations": [{"city": "Madrid", "country": "ES"}]}]}}
    src, _ = make({"https://musterfirma.csod.com/ux/ats/careersite/4/home": page,
                   "https://api.example.org/rec-job-search/external/jobs": api}, [c])
    got = src.fetch_company(c)
    assert [p.source_job_id for p in got] == ["musterfirma.csod.com:7", "musterfirma.csod.com:8"]
    de = got[0]
    assert (de.city, de.country, str(de.posted_date)) == ("Munich", "DE", "2026-10-05")   # German location wins
    assert de.description is None and de.source_data["teaser"] == "Teaser"
    assert de.apply_url.endswith("/careersite/4/home/requisition/7?c=musterfirma")
    assert got[1].country == "ES"
