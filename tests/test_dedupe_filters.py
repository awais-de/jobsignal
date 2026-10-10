from datetime import date, datetime, timedelta, timezone

import pytest

from pipeline.dedupe import StoredPosting, apply_dedupe, build_candidates
from pipeline.filters import HardFilters
from pipeline.models import RawPosting

NOW = datetime(2026, 10, 10, 5, 17, tzinfo=timezone.utc)

PROFILE = {
    "titles": {
        "allow": ["data engineer", "data scientist"],
        "block": [r"\bintern(ship)?\b", "werkstudent", r"\bprincipal\b"],
    },
    "location": {"country": "DE"},
    "contract_types": ["full_time"],
    "freshness_hours": 48,
}


def raw(job_id="J1", title="Data Engineer (m/w/d)", company="Beispiel Daten GmbH", city="Berlin",
        country="DE", posted=date(2026, 10, 9), contract="full_time", source="ba_api"):
    return RawPosting(source=source, source_job_id=job_id, company_name=company, title=title,
                      city=city, country=country, posted_date=posted, contract_type=contract)


def stored(id="S1", job_id="OLD", days_ago=1, triage="new", deleted=False, **kw):
    r = raw(job_id=job_id, **kw)
    c = build_candidates([r])[0]
    return StoredPosting(id=id, source=r.source, source_job_id=job_id, dedupe_hash=c.dedupe_hash,
                         first_seen_at=NOW - timedelta(days=days_ago), triage_status=triage,
                         deleted_at=NOW if deleted else None)


def run(raws, stored_rows=(), first_run=False):
    cands = build_candidates(raws)
    apply_dedupe(cands, list(stored_rows), now=NOW)
    HardFilters(PROFILE, first_run=first_run, now=NOW).apply(cands)
    return cands


# -- dedupe -------------------------------------------------------------------
def test_same_id_twice_in_run_kept_once():
    assert len(run([raw(), raw()])) == 1


def test_known_id_is_not_new():
    c = run([raw(job_id="OLD")], [stored(job_id="OLD")])[0]
    assert c.existing_id == "S1" and not c.is_new


def test_same_hash_recent_is_duplicate():
    c = run([raw(job_id="NEW")], [stored(days_ago=3)])[0]
    assert c.filter_reasons == ["duplicate"]


def test_same_hash_old_is_repost():
    c = run([raw(job_id="NEW")], [stored(days_ago=30)])[0]
    assert c.filter_reasons == ["repost"] and c.repost_of == "S1"


@pytest.mark.parametrize("kw", [{"triage": "skipped"}, {"deleted": True}])
def test_dismissed_never_resurfaces(kw):
    c = run([raw(job_id="NEW")], [stored(days_ago=60, **kw)])[0]
    assert c.filter_reasons == ["previously_dismissed"]


def test_same_hash_twice_in_run_second_is_duplicate():
    a, b = run([raw(job_id="A"), raw(job_id="B")])
    assert a.passed and b.filter_reasons == ["duplicate"]


# -- filters ------------------------------------------------------------------
def test_fresh_matching_posting_passes():
    assert run([raw()])[0].passed


@pytest.mark.parametrize("kw, reason", [
    ({"title": "Sales Manager"}, "title_not_allowed"),
    ({"title": "Werkstudent Data Engineer"}, "title_blocked"),
    ({"title": "Data Engineer Internship"}, "title_blocked"),
    ({"country": "AT"}, "location"),
    ({"contract": "part_time"}, "contract_type"),
    ({"posted": date(2026, 10, 5)}, "not_fresh"),
])
def test_rejections(kw, reason):
    assert run([raw(**kw)])[0].filter_reasons == [reason]


def test_intern_does_not_match_international():
    assert run([raw(title="Data Engineer – International Team")])[0].passed


def test_senior_is_not_blocked():
    assert run([raw(title="Senior Data Engineer")])[0].passed


def test_missing_contract_type_passes():
    assert run([raw(contract=None)])[0].passed


def test_freshness_window_edges():
    assert run([raw(posted=date(2026, 10, 8))])[0].passed      # ends 9 Oct 00:00, 29 h ago
    assert not run([raw(posted=date(2026, 10, 7))])[0].passed  # ends 8 Oct 00:00, 53 h ago


def test_undated_posting_held_back_on_first_run_only():
    assert run([raw(posted=None)], first_run=True)[0].filter_reasons == ["not_fresh"]
    assert run([raw(posted=None)], first_run=False)[0].passed
