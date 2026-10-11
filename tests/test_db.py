import json

import httpx

from pipeline.db import Database
from pipeline.models import Candidate, RawPosting


def test_bulk_insert_sends_uniform_rows():
    """Regression (2026-10-11): mixing enriched and plain rows in one POST fails with PGRST102."""
    batches = []

    def handler(request: httpx.Request) -> httpx.Response:
        rows = json.loads(request.content)
        batches.append(rows)
        if len({tuple(sorted(r)) for r in rows}) > 1:
            return httpx.Response(400, json={"code": "PGRST102"})
        return httpx.Response(201, json=[{"id": f"id-{r['source_job_id']}", "source_job_id": r["source_job_id"],
                                          "dedupe_hash": r["dedupe_hash"]} for r in rows])

    client = httpx.Client(base_url="https://db.example/rest/v1", transport=httpx.MockTransport(handler))
    db = Database("https://db.example", "key", client=client)

    def cand(i, enriched):
        c = Candidate(raw=RawPosting(source="ba_api", source_job_id=str(i), company_name="Beispiel", title="Data Engineer"),
                      dedupe_hash=f"h{i}")
        if enriched:
            c.enrichment = {"extraction_status": "done", "rank_score": 50.0}
        else:
            c.filter_reasons = ["title_not_allowed"]
        return c

    ids = db.insert_postings([cand(1, True), cand(2, False), cand(3, True)])
    assert ids == {"1": "id-1", "2": "id-2", "3": "id-3"}
    assert len(batches) == 2
