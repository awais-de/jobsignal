from datetime import date

import httpx

from pipeline.sources.ba import BundesagenturSource, apply_detail, parse_search_item

# Shape copied from the live v6 response (2026-10-10), with invented values.
ITEM = {
    "stellenangebotsart": "ARBEIT",
    "stellenangebotsTitel": "Data Engineer (m/w/d)",
    "arbeitszeitVollzeit": True,
    "verguetungsangabe": "JAHRESGEHALT",
    "gehaltsspanneVon": 60000.0,
    "gehaltsspanneBis": 72000.0,
    "homeofficemoeglich": True,
    "homeofficetyp": "NACH_VEREINBARUNG",
    "stellenlokationen": [
        {"adresse": {"plz": "1010", "ort": "Wien", "land": "OESTERREICH"}},
        {"adresse": {"plz": "50667", "ort": "Köln", "region": "NORDRHEIN-WESTFALEN", "land": "DEUTSCHLAND"}},
    ],
    "datumErsteVeroeffentlichung": "2026-10-09",
    "firma": "Beispiel Daten GmbH",
    "referenznummer": "10000-0000000001-S",
}


def test_parse_search_item():
    p = parse_search_item(ITEM)
    assert p.source_job_id == "10000-0000000001-S"
    assert p.city == "Köln" and p.country == "DE"           # first German location wins
    assert p.remote_policy == "hybrid"
    assert p.posted_date == date(2026, 10, 9)
    assert p.contract_type == "full_time"
    assert p.salary_text == "60,000–72,000 EUR/year"
    assert p.source_url.endswith("/jobdetail/10000-0000000001-S")


def test_parse_skips_incomplete_items():
    assert parse_search_item({"stellenangebotsTitel": "x"}) is None


def test_foreign_only_location_keeps_country():
    item = {**ITEM, "stellenlokationen": [{"adresse": {"ort": "Zürich", "land": "SCHWEIZ"}}]}
    assert parse_search_item(item).country == "CH"


def test_detail_marks_agency():
    p = parse_search_item(ITEM)
    apply_detail(p, {"stellenangebotsBeschreibung": "Text", "istArbeitnehmerUeberlassung": True})
    assert p.description == "Text" and p.poster_type == "agency"


def test_fetch_paginates_and_stops():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(dict(request.url.params))
        page = int(request.url.params["page"])
        items = [{**ITEM, "referenznummer": f"R{page}-{i}"} for i in range(2 if page == 1 else 1)]
        return httpx.Response(200, json={"ergebnisliste": items, "maxErgebnisse": 3})

    src = BundesagenturSource({"page_size": 2, "request_delay_seconds": 0},
                              client=httpx.Client(transport=httpx.MockTransport(handler)))
    got = src.fetch(["data engineer"])
    assert len(got) == 3 and len(calls) == 2
    assert calls[0]["arbeitszeit"] == "vz" and calls[0]["angebotsart"] == "1"
