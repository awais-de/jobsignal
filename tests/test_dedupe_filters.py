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


# -- watched companies: per-company filter modes (owner decisions 2026-10-11) ---------
def watched(title, mode, country="DE", posted=date(2026, 9, 1)):
    r = raw(title=title, country=country, posted=posted, source="careers")
    r.source_data["filter_mode"] = mode
    return r


@pytest.mark.parametrize("title, mode, country, reason", [
    ("Sales Manager", "all", "DE", "title_not_allowed"),          # 'all': normal title list
    ("Data Engineer", "all", "DE", None),
    ("Sales Manager", "watch", "DE", None),                       # 'watch': no allow-list...
    ("Werkstudent Data", "watch", "DE", "title_blocked"),         # ...but the block list applies
    ("Data Engineer", "watch", "AT", "location"),
    ("Werkstudent Marketing", "none", "AT", None),                # 'none': no filters at all
])
def test_watchlist_filter_modes(title, mode, country, reason):
    c = run([watched(title, mode, country)])[0]
    assert (c.filter_reasons[0] if c.filter_reasons else None) == reason


def test_watched_jobs_skip_freshness():
    assert run([watched("Data Engineer", "all", posted=date(2026, 8, 1))])[0].passed


# -- cross-source merging (spec 7.3.2) ----------------------------------------------
def stored_from(source, id="S1", days_ago=1, triage="new", surfaced=None, has_desc=True, filter_status="passed"):
    s = stored(id=id, days_ago=days_ago, triage=triage)
    s.source, s.surfaced_on, s.has_description, s.filter_status = source, surfaced, has_desc, filter_status
    return s


def test_better_source_supersedes_untriaged_weaker_row():
    c = run([raw(job_id="NEW", source="careers")], [stored_from("ba_api")])[0]
    assert c.passed and c.supersedes == ["S1"]
    assert "no_digest" not in c.raw.source_data


def test_superseding_an_emailed_row_is_not_emailed_again():
    c = run([raw(job_id="NEW", source="careers")], [stored_from("ba_api", surfaced="2026-10-09")])[0]
    assert c.raw.source_data.get("no_digest") is True


def test_weaker_source_is_duplicate_and_donates_description():
    cands = build_candidates([raw(job_id="NEW", source="arbeitnow")])
    cands[0].raw.description = "Full text"
    actions = apply_dedupe(cands, [stored_from("careers", has_desc=False)], now=NOW)
    assert cands[0].filter_reasons == ["duplicate"]
    assert actions.enrich == [("S1", "Full text")]


def test_better_source_without_description_inherits():
    cands = build_candidates([raw(job_id="NEW", source="careers")])
    actions = apply_dedupe(cands, [stored_from("ba_api", has_desc=True)], now=NOW)
    assert actions.inherit == [(cands[0], "S1")]


@pytest.mark.parametrize("kw", [{"triage": "applied"}, {"filter_status": "passed", "triage": "applied"}])
def test_triaged_rows_are_never_replaced(kw):
    c = run([raw(job_id="NEW", source="careers")], [stored_from("ba_api", **kw)])[0]
    assert c.filter_reasons == ["duplicate"] and c.supersedes == []


def test_manual_entry_always_wins():
    c = run([raw(job_id="NEW", source="careers")], [stored_from("manual", triage="applied")])[0]
    assert c.filter_reasons == ["duplicate"]


def test_rejected_sibling_is_not_canonical():
    # e.g. the Arbeitsagentur copy failed the title list, the company-site copy (watch mode) may pass
    c = run([raw(job_id="NEW", source="careers")], [stored_from("ba_api", filter_status="rejected")])[0]
    assert c.passed and c.supersedes == []


def test_in_run_better_source_wins():
    weak, strong = raw(job_id="A", source="arbeitnow"), raw(job_id="B", source="careers")
    weak.description = "text from aggregator"
    a, b = run([weak, strong])
    assert a.filter_reasons == ["duplicate"] and b.passed and b.raw.description == "text from aggregator"
