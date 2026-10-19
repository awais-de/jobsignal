import json

import httpx

from pipeline import cv_compile

URL, KEY = "https://x.supabase.co", "k"


def client(log):
    def handler(request: httpx.Request) -> httpx.Response:
        log.append((request.method, request.url.path, dict(request.url.params), request.content))
        if request.method == "GET":
            return httpx.Response(200, json=[{"id": "old1", "pdf_path": "old1.pdf"}, {"id": "old2", "pdf_path": None}])
        return httpx.Response(200, json={})
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_previews_of_the_same_ad_hoc_cv_are_replaced():
    log = []
    c = client(log)
    h = {"apikey": KEY}
    rows = cv_compile.older_previews(c, URL, h, "new", {"created_at": "2026-10-19T10:00:00Z", "cv_draft_id": "d1",
                                                       "job_posting_id": None, "base_cv_id": "b1"})
    params = log[0][2]
    assert params["cv_draft_id"] == "eq.d1" and params["resume_id"] == "is.null"
    assert params["status"] == "in.(compiled,failed)" and params["id"] == "neq.new"
    assert cv_compile.delete_builds(c, URL, KEY, rows) == 2
    storage, rows_delete = log[1], log[2]
    assert storage[0] == "DELETE" and storage[1] == "/storage/v1/object/cv-pdfs"
    assert json.loads(storage[3]) == {"prefixes": ["old1.pdf"]}          # saved or unsaved, only listed paths
    assert rows_delete[0] == "DELETE" and rows_delete[2]["id"] == "in.(old1,old2)"


def test_job_previews_match_job_and_format_only():
    log = []
    cv_compile.older_previews(client(log), URL, {}, "new", {"created_at": "t", "cv_draft_id": None,
                                                         "job_posting_id": "j1", "base_cv_id": "b1"})
    p = log[0][2]
    assert p["job_posting_id"] == "eq.j1" and p["base_cv_id"] == "eq.b1" and p["cv_draft_id"] == "is.null"


def test_nothing_is_deleted_without_a_cv_to_match():
    log = []
    assert cv_compile.older_previews(client(log), URL, {}, "new", {"created_at": "t"}) == [] and not log
