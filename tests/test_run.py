import httpx

from pipeline import run
from pipeline.config import CONFIG_DIR, load_profile

PROFILE = load_profile(env={"PROFILE_YAML": (CONFIG_DIR / "profile.example.yaml").read_text()})
SOURCES = {"ba_api": {"enabled": True, "request_delay_seconds": 0}}


def test_failed_source_does_not_stop_the_run(monkeypatch):
    def boom(self, terms):
        raise httpx.ConnectError("down")

    monkeypatch.setattr(run.BundesagenturSource, "fetch", boom)
    monkeypatch.setattr(run.CareersSource, "fetch_company", lambda self, company: boom(self, None))
    stats, (subject, text, html) = run.run_pipeline(PROFILE, SOURCES, db=None, run_id=None)
    # Every source failed (Arbeitsagentur and the example watchlist company); the run still completes.
    assert stats["failed_sources"] == ["ba_api", "careers#1"]
    assert "0 new jobs" in subject
    assert "ba_api" in text and "No new postings" in text


def test_fast_lane_sends_no_email(monkeypatch):
    monkeypatch.setattr(run.BundesagenturSource, "fetch", lambda self, terms: [])
    monkeypatch.setattr(run.CareersSource, "fetch_company", lambda self, company: [])
    stats, digest = run.run_pipeline(PROFILE, SOURCES, db=None, run_id=None, fast=True)
    assert digest is None and stats["queued"] == 0


def _queued(i, score, triage="new", status="passed"):
    return {"id": f"q{i}", "source": "ba_api", "source_job_id": str(i), "company_name": "Beispiel GmbH",
            "title": f"Data Engineer {i}", "posted_date": "2026-10-28", "triage_status": triage, "filter_status": status,
            "rank_score": score, "rank_details": None, "german_level": "C1", "required_years": None,
            "extraction_status": "done"}


def test_digest_lists_the_fast_lanes_untriaged_jobs_with_the_runs_own():
    from datetime import date
    from pipeline.models import RawPosting
    own = [(RawPosting(source="arbeitnow", source_job_id="o1", company_name="Muster AG", title="BI Developer"),
            {"rank_score": 60.0}, "o1")]
    queue = [_queued(1, 80.0), _queued(2, 40.0), _queued(3, 90.0, triage="applied"), _queued(4, 95.0, status="rejected"),
             _queued(5, 70.0, triage="skipped")]
    items, waiting, handled = run.digest_items(own, queue, {"q1": ("verify", ["reposted"])}, date(2026, 10, 29), cap=2)
    assert [sid for _, _, sid in items] == ["q1", "o1"]          # best first, capped
    assert items[0][1]["ghost_bucket"] == "verify"                # today's ghost check applies to queued jobs too
    assert (waiting, handled) == (2, 2)                           # q1, q2 waiting; q3, q5 already handled
