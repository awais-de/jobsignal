from datetime import datetime, timezone

import httpx
import pytest

from pipeline.sources.arbeitnow import ArbeitnowSource, contract_type, is_germany

NOW = datetime(2026, 10, 11, 12, 0, tzinfo=timezone.utc)
T = int(NOW.timestamp())


def job(slug, created, location="Berlin", types=("Full Time",), remote=False):
    return {"slug": slug, "company_name": "Beispiel Daten GmbH", "title": "Data Engineer (m/w/d)",
            "description": "<p>Python &amp; <b>dbt</b></p>", "url": f"https://board.example/jobs/{slug}",
            "location": location, "remote": remote, "job_types": list(types), "tags": [], "created_at": created}


@pytest.mark.parametrize("loc, de", [("Berlin", True), ("Munich, Bavaria", True), ("Köln", True),
                                     ("Remote, Germany", True), ("London", False), ("Zürich, Switzerland", False),
                                     ("", False), ("Remote", False)])
def test_is_germany(loc, de):
    assert is_germany(loc) is de


@pytest.mark.parametrize("types, kind", [(["Full Time", "Permanent"], "full_time"), (["Part time"], "part_time"),
                                         (["Werkstudent"], "werkstudent"), (["Internship"], "internship"),
                                         (["Experienced"], None)])
def test_contract_type(types, kind):
    assert contract_type(types) == kind


def test_fetch_stops_at_window_and_maps_fields():
    pages = {1: [job("a", T - 3600), job("b", T - 86400, location="Paris")],
             2: [job("c", T - 3 * 86400)]}
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params["page"])
        calls.append(page)
        return httpx.Response(200, json={"data": pages.get(page, []), "links": {"next": "x" if page < 3 else None}})

    src = ArbeitnowSource({"request_delay_seconds": 0}, client=httpx.Client(transport=httpx.MockTransport(handler)))
    got = src.fetch(NOW)
    assert [p.source_job_id for p in got] == ["a", "b"] and calls == [1, 2]   # page 2 is past the window
    a = got[0]
    assert (a.country, a.city, a.contract_type, a.description) == ("DE", "Berlin", "full_time", "Python & dbt")
    assert got[1].country is None                                               # Paris: not Germany
