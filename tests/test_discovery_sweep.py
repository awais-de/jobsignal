"""Parallel company probing (owner request 2026-10-21): every company gets one result, counted once."""

from types import SimpleNamespace

import pipeline.run as run


class FakeDb:
    def __init__(self):
        self.updates = {}

    def update_company(self, cid, fields):
        self.updates[cid] = fields


def test_probe_companies_in_parallel(monkeypatch):
    def fake_probe(name, api):
        if name.startswith("hit"):
            return SimpleNamespace(ats="personio", token=name, verified_name=name, careers_url=None, via="name")
        if name == "boom":
            raise RuntimeError("odd company")
        return None
    monkeypatch.setattr(run, "probe_company", fake_probe)
    comps = [{"id": f"c{i}", "name": n} for i, n in enumerate(["hit-a", "miss", "hit-b", "boom", "miss2"] * 4)]
    db = FakeDb()
    counts = run._probe_companies(db, comps, {"retry_not_found_days": 30}, seconds=60, workers=4)
    assert counts["found_via_name"] == 8 and counts["not_found"] == 12 and counts["errors"] == 4
    assert len(db.updates) == 20
    assert db.updates["c0"]["discovery_status"] == "found" and db.updates["c0"]["watch"] is True
    assert db.updates["c1"]["discovery_status"] == "not_found" and "next_check_at" in db.updates["c1"]


def test_time_budget_leaves_the_rest_for_later(monkeypatch):
    monkeypatch.setattr(run, "probe_company", lambda name, api: None)
    db = FakeDb()
    counts = run._probe_companies(db, [{"id": "x", "name": "a"}], {}, seconds=-1, workers=2)
    assert counts["left_for_later"] == 1 and not db.updates


def test_a_failing_write_does_not_stop_the_sweep(monkeypatch):
    monkeypatch.setattr(run, "probe_company", lambda name, api: None)
    monkeypatch.setattr(run.time, "sleep", lambda s: None)

    class Flaky(FakeDb):
        def update_company(self, cid, fields):
            if cid == "bad":
                raise TimeoutError("read timed out")
            super().update_company(cid, fields)

    db = Flaky()
    counts = run._probe_companies(db, [{"id": "bad", "name": "a"}, {"id": "ok", "name": "b"}], {}, seconds=60, workers=2)
    assert counts["write_errors"] == 1 and counts["not_found"] == 1 and "ok" in db.updates
