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
