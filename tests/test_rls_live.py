"""Live check that the public (publishable) key can read or call nothing (spec 6.0).

Runs in CI with SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY; skipped locally without them.
"""

import os

import httpx
import pytest

URL = os.environ.get("SUPABASE_URL")
KEY = os.environ.get("SUPABASE_PUBLISHABLE_KEY")

pytestmark = pytest.mark.skipif(not (URL and KEY), reason="needs SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY")

TABLES = ["job_postings", "pipeline_runs", "source_runs", "applications", "application_events",
          "used_action_tokens", "app_owner", "application_status"]
# Real arguments, so a 404 can't come from a signature mismatch instead of missing permission.
ZERO = "00000000-0000-0000-0000-000000000000"
RPCS = {
    "touch_postings": {"ids": [ZERO]},
    "record_reposts": {"ids": [ZERO]},
    "triage_posting": {"p_posting_id": ZERO, "p_action": "skip", "p_reason": "other"},
    "is_owner": {},
}


@pytest.fixture(scope="module")
def anon():
    return httpx.Client(base_url=f"{URL.rstrip('/')}/rest/v1", headers={"apikey": KEY}, timeout=20)


def test_schema_exposes_nothing_to_anon(anon):
    # PostgREST's OpenAPI root lists only what the calling role may access.
    resp = anon.get("/", headers={"Accept": "application/openapi+json"})
    if resp.status_code in (401, 403):
        return
    paths = set(resp.json().get("paths", {})) - {"/"}
    assert paths == set(), f"anon can see: {sorted(paths)}"


@pytest.mark.parametrize("table", TABLES)
def test_tables_unreadable(anon, table):
    resp = anon.get(f"/{table}", params={"select": "*", "limit": 1})
    assert resp.status_code in (401, 403, 404) or resp.json() == []


@pytest.mark.parametrize("table", TABLES)
def test_tables_unwritable(anon, table):
    resp = anon.post(f"/{table}", json={})
    assert resp.status_code in (401, 403, 404)


@pytest.mark.parametrize("fn", RPCS)
def test_rpcs_not_callable(anon, fn):
    resp = anon.post(f"/rpc/{fn}", json=RPCS[fn])
    assert resp.status_code in (401, 403), f"{fn}: HTTP {resp.status_code}"
