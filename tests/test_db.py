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


def test_failing_sources_counts_each_sources_own_last_tries():
    runs = [{"id": f"r{i}"} for i in range(6)]          # newest first
    tries = {  # source -> statuses in the runs it was tried (run index, status)
        "careers:Down": [(0, "failed"), (1, "failed"), (3, "failed")],     # skipped in run 2: still 3 failed tries
        "careers:Flaky": [(0, "failed"), (1, "success"), (2, "failed"), (3, "failed")],
        "careers:New": [(0, "failed"), (1, "failed")],                     # only 2 tries so far
    }

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/pipeline_runs"):
            return httpx.Response(200, json=runs)
        return httpx.Response(200, json=[{"source": s, "status": st, "pipeline_run_id": f"r{i}"}
                                         for s, t in tries.items() for i, st in t])

    client = httpx.Client(base_url="https://db.example/rest/v1", transport=httpx.MockTransport(handler))
    assert Database("https://db.example", "key", client=client).failing_sources("careers:") == {"careers:Down"}
