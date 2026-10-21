import httpx

from pipeline.sources.ba import BundesagenturSource


def test_fetch_employers_asks_by_exact_employer_and_reports_totals():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(dict(request.url.params))
        if request.url.params.get("arbeitgeber") == "Beispiel AG":
            return httpx.Response(200, json={"maxErgebnisse": 1, "ergebnisliste": [
                {"referenznummer": "10000-1", "titel": "Data Engineer (m/w/d)", "stellenangebotsTitel": "Data Engineer (m/w/d)",
                 "firma": "Beispiel AG", "arbeitsort": {"ort": "Berlin", "land": "Deutschland"}}]})
        return httpx.Response(200, json={"maxErgebnisse": 0, "ergebnisliste": []})

    src = BundesagenturSource({"request_delay_seconds": 0}, client=httpx.Client(transport=httpx.MockTransport(handler)))
    got, totals = src.fetch_employers(["Beispiel AG", "Muster GmbH"], 1)
    assert totals == {"Beispiel AG": 1, "Muster GmbH": 0}
    assert [p.source_job_id for p in got] == ["10000-1"] and got[0].source == "ba_api"
    assert seen[0]["arbeitgeber"] == "Beispiel AG" and seen[0]["veroeffentlichtseit"] == "1"
