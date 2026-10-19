from datetime import date

from pipeline import ghost
from pipeline.digest import _why

TODAY = date(2026, 10, 19)


def keys(signals):
    return {s["key"] for s in signals}


def test_fresh_specific_job_is_apply():
    p = {"source": "careers", "named_contact": "Anna Muster", "reference_number": "R-12", "extraction_status": "done",
         "specificity_score": 2}
    total, bucket, signals = ghost.score(p, {"family_first_seen": "2026-10-17T05:20:00+00:00"}, None, [], TODAY)
    assert bucket == "apply" and total == 0
    assert keys(signals) == {"named_contact", "reference", "own_site_fresh"}


def test_age_uses_first_sighting_of_the_family_not_the_boards_date():
    # Arbeitnow says yesterday, but we first saw the role 75 days ago (another id): that counts.
    p = {"source": "arbeitnow", "posted_date": "2026-10-18"}
    _, _, signals = ghost.score(p, {"family_first_seen": "2026-08-05T05:00:00+00:00"}, None, [], TODAY)
    assert "age_over_60" in keys(signals)
    _, _, signals = ghost.score(p, {"family_first_seen": "2026-10-18T05:00:00+00:00"}, None, [], TODAY)
    assert not keys(signals) & {"age_over_60", "age_31_60"}


def test_ba_first_publication_date_is_trusted():
    p = {"source": "ba_api", "posted_date": "2026-09-01"}
    _, _, signals = ghost.score(p, {"family_first_seen": "2026-10-18T05:00:00+00:00"}, None, [], TODAY)
    assert "age_31_60" in keys(signals)


def test_reposted_evergreen_agency_is_likely_ghost():
    p = {"source": "ba_api", "company_name": "Hays AG", "repost_count": 1, "reappear_count": 1, "evergreen_language": True,
         "extraction_status": "done", "specificity_score": 0}
    ctx = {"family_first_seen": "2026-07-01T05:00:00+00:00", "family_gap_reposts": 1, "family_text_reused": True}
    total, bucket, signals = ghost.score(p, ctx, None, ["hays"], TODAY)
    assert bucket == "skip" and total == 100            # clamped
    assert {"repost", "same_text", "agency", "evergreen", "vague", "age_over_60"} <= keys(signals)
    assert any("listed again 3×" in r for r in ghost.reasons(signals))


def test_company_patterns_and_clones():
    ctx = {"family_first_seen": "2026-10-10T05:00:00+00:00", "family_live_cities": 5, "company_reposting_roles": 4,
           "company_silent_apps": 2}
    total, bucket, signals = ghost.score({"source": "ba_api"}, ctx, None, [], TODAY)
    assert keys(signals) == {"clones", "company_reposts", "company_silent"}
    assert total == 30 and bucket == "verify"


def test_weights_come_from_config():
    total, bucket, _ = ghost.score({"evergreen_language": True}, {}, {"evergreen": 70}, [], TODAY)
    assert total == 70 and bucket == "skip"


def test_digest_shows_the_ghost_bucket_with_reasons():
    lines = _why({"ghost_bucket": "verify", "ghost_reasons": ["open since 01 Aug 2026 (79 days)", "evergreen wording"]})
    assert lines[-1].startswith("⚠ Verify first: open since 01 Aug 2026")
    assert not any("⚠" in line for line in _why({"ghost_bucket": "apply", "ghost_reasons": []}))
