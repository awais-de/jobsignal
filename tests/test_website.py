"""Website-based ATS detection, against invented sites."""

import httpx
import pytest

from pipeline.sources.careers import CareersSource
from pipeline.website import _job_portal, careers_url, discover_via_website, fingerprint


@pytest.mark.parametrize("html, hit", [
    ('<a href="https://beispiel.wd3.myworkdayjobs.com/de-DE/Beispiel_Careers">', ("workday", "beispiel.wd3.myworkdayjobs.com|beispiel|Beispiel_Careers")),
    ('<iframe src="https://beispiel-daten.jobs.personio.de/">', ("personio", "beispiel-daten")),
    ('<script src="https://boards.greenhouse.io/embed/job_board/js?for=beispiel">', ("greenhouse", "beispiel")),
    ('<a href="https://careers.smartrecruiters.com/BeispielGroup">', ("smartrecruiters", "BeispielGroup")),
    ('<a href="https://join.com/companies/beispiel">', ("join", "beispiel")),
    ('<a href="https://www.example.org/about">', None),
])
def test_fingerprint(html, hit):
    assert fingerprint(html) == hit


def test_careers_link_and_job_portal():
    home = "https://www.beispiel.de/"
    html = '<a href="/ueber-uns">Über uns</a><a href="/karriere">Karriere</a>'
    assert careers_url(home, html) == "https://www.beispiel.de/karriere"
    # A portal on another ending of the same name counts (beispiel.de -> jobs.beispiel.com)
    assert _job_portal("https://www.beispiel.de/karriere", '<a href="https://jobs.beispiel.com/de">Jobs</a>') == "https://jobs.beispiel.com/"
    assert _job_portal("https://www.beispiel.de/karriere", '<a href="https://jobs.other.com/">x</a>') is None


def test_discovery_via_company_site_to_ats():
    routes = {
        "https://www.beispiel-daten.de/": "<title>Beispiel Daten GmbH</title><a href='/karriere'>Karriere</a>",
        "https://www.beispiel-daten.de/karriere": "<a href='https://beispiel.wd3.myworkdayjobs.com/en-US/Careers'>Jobs</a>",
    }

    def handler(request):
        body = routes.get(str(request.url))
        return httpx.Response(200, text=body) if body else httpx.Response(404)

    hit = discover_via_website("Beispiel Daten GmbH", httpx.Client(transport=httpx.MockTransport(handler)))
    assert (hit.kind, hit.token) == ("workday", "beispiel.wd3.myworkdayjobs.com|beispiel|Careers")


def test_url_prefilter_skips_foreign_and_non_matching_titles():
    src = CareersSource([], {"title_allow": [r"\bdata\b", r"analyst"]}, known_ids=lambda ids: set())
    all_mode = {"filters": "all"}
    assert src._worth_fetching("https://jobs.example.org/de/job/Data-Engineer-Hamburg/123", all_mode)
    assert not src._worth_fetching("https://jobs.example.org/de/job/Elektriker-Hamburg/124", all_mode)
    assert not src._worth_fetching("https://jobs.example.org/en/job/Data-Engineer-Madrid/125", all_mode)
    assert src._worth_fetching("https://jobs.example.org/de/job/Elektriker-Hamburg/124", {"filters": "none"})
    assert src._worth_fetching("https://jobs.example.org/job/98765", all_mode)          # no readable title: fetch
