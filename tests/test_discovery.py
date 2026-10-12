"""Discovery and ATS adapters against invented feeds (spec 13.1: no real company data)."""

import httpx
import pytest

from pipeline.discovery import probe_company, same_company, slug_variants, watch_entry
from pipeline.sources.ats import ATS, feed_jobs

PERSONIO_XML = """<?xml version="1.0"?><workzag-jobs><position><id>42</id><subcompany>Other Firm AG</subcompany>
<office>München</office><name>Data Engineer (m/w/d)</name><employmentType>permanent</employmentType>
<schedule>full-time</schedule><createdAt>2026-10-05T10:00:00+00:00</createdAt>
<jobDescriptions><jobDescription><name>Aufgaben</name><value><![CDATA[<p>Pipelines mit <b>dbt</b></p>]]></value>
</jobDescription></jobDescriptions></position></workzag-jobs>"""


def api(routes):
    def handler(request: httpx.Request) -> httpx.Response:
        body = routes.get(str(request.url).split("?")[0])
        if body is None:
            return httpx.Response(404)
        return httpx.Response(200, text=body) if isinstance(body, str) else httpx.Response(200, json=body)
    return ATS(httpx.Client(transport=httpx.MockTransport(handler)))


def test_slug_variants():
    assert slug_variants("Beispiel Daten GmbH & Co. KG") == ["beispiel-daten", "beispieldaten", "beispiel"]
    assert slug_variants("Müller Technik GmbH") == ["mueller-technik", "muellertechnik", "mueller"]


@pytest.mark.parametrize("name, ats_name, ok", [
    ("Beispiel Daten GmbH", "Jobs bei Beispiel Daten", True),
    ("Beispiel Daten GmbH", "Beispiel Werkzeuge", False),     # two-word names need both words
    ("Beispiel Daten GmbH", "Other Firm AG", False),
    ("Musterwerk", "Musterwerk GmbH", True),
])
def test_same_company(name, ats_name, ok):
    assert same_company(name, ats_name) is ok


def test_probe_needs_jobs_and_matching_name():
    # Personio feed for the slug exists, but the page names another company: rejected.
    wrong = api({"https://beispiel-daten.jobs.personio.de/xml": PERSONIO_XML,
                 "https://beispiel-daten.jobs.personio.de/": "<title>Jobs bei Anderswo GmbH</title>"})
    assert probe_company("Beispiel Daten GmbH", wrong) is None
    right = api({"https://beispiel-daten.jobs.personio.de/xml": PERSONIO_XML,
                 "https://beispiel-daten.jobs.personio.de/": "<title>Jobs bei Beispiel Daten</title>"})
    f = probe_company("Beispiel Daten GmbH", right)
    assert (f.ats, f.token, f.jobs) == ("personio", "beispiel-daten", 1)


def test_empty_board_is_not_a_hit():
    a = api({"https://apply.workable.com/api/v1/widget/accounts/musterwerk": {"name": "Musterwerk", "jobs": []}})
    assert probe_company("Musterwerk", a) is None


def test_personio_feed_uses_watched_name_not_subcompany():
    a = api({"https://beispiel-daten.jobs.personio.de/xml": PERSONIO_XML})
    [p] = feed_jobs(a, "personio", "beispiel-daten", {"name": "Beispiel Daten GmbH"})
    assert p.company_name == "Beispiel Daten GmbH"
    assert (p.title, p.city, p.country, p.contract_type) == ("Data Engineer (m/w/d)", "München", "DE", "full_time")
    assert "dbt" in p.description and str(p.posted_date) == "2026-10-05"
    assert p.source_job_id == "personio:beispiel-daten:42"


def test_greenhouse_and_ashby_and_recruitee_feeds():
    a = api({
        "https://boards-api.greenhouse.io/v1/boards/bd/jobs": {"jobs": [{
            "id": 1, "title": "Analytics Engineer", "location": {"name": "Berlin, Germany"},
            "content": "&lt;p&gt;SQL&lt;/p&gt;", "first_published": "2026-10-01T09:00:00-04:00",
            "absolute_url": "https://example.org/1"}]},
        "https://api.ashbyhq.com/posting-api/job-board/bd": {"jobs": [{
            "id": "a", "title": "ML Engineer", "location": "Remote", "isListed": True, "isRemote": True,
            "address": {"postalAddress": {"addressCountry": "Germany", "addressLocality": "Hamburg"}},
            "descriptionPlain": "Python", "publishedAt": "2026-10-02T10:00:00Z", "jobUrl": "https://example.org/a"}]},
        "https://bd.recruitee.com/api/offers/": {"offers": [{
            "id": 9, "title": "BI Developer", "city": "Köln", "country_code": "DE", "description": "<p>Power BI</p>",
            "requirements": "<p>DAX</p>", "created_at": "2026-10-03 08:00:00 UTC", "employment_type_code": "fulltime_permanent",
            "careers_url": "https://example.org/9"}]},
    })
    gh = feed_jobs(a, "greenhouse", "bd", {"name": "BD"})[0]
    assert (gh.country, gh.description, str(gh.posted_date)) == ("DE", "SQL", "2026-10-01")
    ab = feed_jobs(a, "ashby", "bd", {"name": "BD"})[0]
    assert (ab.city, ab.country, ab.remote_policy) == ("Hamburg", "DE", "remote")
    rc = feed_jobs(a, "recruitee", "bd", {"name": "BD"})[0]
    assert (rc.country, rc.contract_type, rc.description) == ("DE", "full_time", "Power BI\n\nDAX")


def test_watch_entry():
    sg = watch_entry({"id": "c1", "name": "BD", "ats": "softgarden", "ats_token": "bd", "filter_mode": "all"})
    assert sg["technique"] == "career_page" and sg["url"] == "https://bd.softgarden.io/en/vacancies"
    pe = watch_entry({"id": "c2", "name": "BD", "ats": "personio", "ats_token": "bd", "filter_mode": None})
    assert (pe["technique"], pe["ats"], pe["token"], pe["filters"], pe["company_id"]) == ("ats", "personio", "bd", "all", "c2")


@pytest.mark.parametrize("office, country", [("Ingelheim", "DE"), ("Boston, US", None), ("Wien", None),
                                             ("München", "DE"), ("Remote", "DE")])
def test_personio_offices_default_to_germany_unless_foreign(office, country):
    a = api({"https://bd.jobs.personio.de/xml": PERSONIO_XML.replace("München", office)})
    assert feed_jobs(a, "personio", "bd", {"name": "BD"})[0].country == country


def test_workday_germany_facet_uses_nested_parameter():
    from pipeline.sources.ats import _workday_germany
    facets = [{"facetParameter": "locationMainGroup", "values": [
        {"facetParameter": "locationHierarchy2", "descriptor": "Location Type", "values": [{"descriptor": "Office", "id": "o"}]},
        {"facetParameter": "locationHierarchy1", "descriptor": "Locations", "values": [
            {"descriptor": "Austria", "id": "at"}, {"descriptor": "Germany", "id": "de"}]}]}]
    assert _workday_germany(facets) == ("locationHierarchy1", "de")
    assert _workday_germany([{"facetParameter": "locations", "values": [{"descriptor": "Germany", "id": "x"}]}]) == ("locations", "x")


def test_smartrecruiters_skips_titles_before_details():
    calls = []

    def handler(request):
        calls.append(str(request.url))
        if request.url.path.endswith("/postings"):
            return httpx.Response(200, json={"totalFound": 2, "content": [
                {"id": "1", "name": "Data Engineer", "location": {"city": "berlin", "country": "de"}, "releasedDate": "2026-10-09T10:00:00Z"},
                {"id": "2", "name": "Elektriker", "location": {"city": "berlin", "country": "de"}}]})
        return httpx.Response(200, json={"jobAd": {"sections": {"jobDescription": {"text": "<p>SQL</p>"}}}})

    a = ATS(httpx.Client(transport=httpx.MockTransport(handler)), pace=0)
    jobs = feed_jobs(a, "smartrecruiters", "bd", {"name": "BD"}, search_terms=["data"],
                     title_ok=lambda t: "Data" in t)
    assert [j.title for j in jobs] == ["Data Engineer"] and jobs[0].description == "SQL" and jobs[0].city == "Berlin"
    assert sum("/postings/" in u for u in calls) == 1                      # one detail request only


def test_overlong_or_odd_company_names_are_not_found_not_a_crash():
    # 2026-10-12: a host label over 63 characters raised UnicodeError (not an httpx.HTTPError) while the
    # address was resolved, and failed the whole run.
    import httpx
    from pipeline.website import find_website

    def resolve(request):
        if any(len(label) > 63 for label in request.url.host.split(".")):
            raise UnicodeError("label empty or too long")       # what the real transport raises
        return httpx.Response(404)

    c = httpx.Client(transport=httpx.MockTransport(resolve))
    long_name = "Gesellschaft für angewandte Datenverarbeitung und Informationstechnologie Süd-West mbH & Co. KG"
    assert find_website(long_name, c) is None
    assert find_website("x" * 70, c) is None
