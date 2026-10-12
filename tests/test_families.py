from datetime import date, datetime, timezone

from pipeline.config import validate_profile
from pipeline.dedupe import build_candidates
from pipeline.families import classify, load_families
from pipeline.filters import HardFilters
from pipeline.models import RawPosting
from pipeline.rank import SkillIndex, keyword_overlap

NOW = datetime(2026, 10, 12, 5, 17, tzinfo=timezone.utc)


def profile(**kw):
    p = {
        "search_terms": ["legacy"], "titles": {"allow": ["legacy"], "block": [r"\bintern\b"]},
        "location": {"country": "DE"}, "contract_types": ["full_time"], "dealbreakers": {}, "feed": {},
        "freshness_hours": 48,
        "families": [
            {"key": "core_data", "label": "Core data", "mode": "core",
             "titles": [r"\bdata\b.*\bengineer", r"\banalytics engineer"], "exclude": [r"\bsap\b"],
             "search_terms": ["data engineer", "analytics engineer"]},
            {"key": "database", "label": "Database", "mode": "explore",
             "titles": ["datenbank", r"\bdba\b", "database"], "search_terms": ["Datenbank Spezialist"]},
            {"key": "sap", "label": "SAP data", "mode": "off", "titles": [r"\bsap\b"], "search_terms": ["SAP BW"]},
        ],
    }
    p.update(kw)
    return validate_profile(p, "test")


def test_core_wins_over_explore_and_off_never_matches():
    fams = load_families(profile())
    assert classify("Data Engineer – Database Platform", fams).key == "core_data"
    assert classify("Datenbank Spezialist (m/w/d)", fams).key == "database"
    assert classify("SAP BW Consultant", fams) is None
    assert classify("SAP Data Engineer", fams) is None          # excluded from core, SAP family is off


def test_profile_union_replaces_legacy_terms_and_titles():
    p = profile()
    assert p["search_terms"] == ["data engineer", "analytics engineer", "Datenbank Spezialist"]
    assert "datenbank" in p["titles"]["allow"] and r"\bsap\b" not in p["titles"]["allow"]


def test_profile_without_families_is_one_core_family():
    p = profile(families=None)
    fams = load_families(p)
    assert [(f.key, f.mode) for f in fams] == [("core", "core")]
    assert p["search_terms"] == ["legacy"]


def _cand(title, source="ba_api", **kw):
    raw = RawPosting(source=source, source_job_id="1", company_name="Beispiel GmbH", title=title, country="DE",
                     posted_date=date(2026, 10, 11), contract_type="full_time", **kw)
    return build_candidates([raw])[0]


def test_filters_set_family_and_lane():
    f = HardFilters(profile(), first_run=False, now=NOW)
    c = _cand("Datenbank Spezialist (m/w/d)")
    assert f.reason(c) is None and (c.title_family, c.lane) == ("database", "explore")
    c = _cand("Analytics Engineer")
    assert f.reason(c) is None and (c.title_family, c.lane) == ("core_data", "core")
    assert f.reason(_cand("Vertriebsprofi")) == "title_not_allowed"


def test_watched_company_job_outside_families_is_core():
    f = HardFilters(profile(), first_run=False, now=NOW)
    c = _cand("Office Manager", source="careers", source_data={"filter_mode": "watch"})
    assert f.reason(c) is None and c.lane == "core" and c.title_family is None


def test_keyword_overlap_counts_distinct_skills():
    idx = SkillIndex.from_profile({"skills": {"data": {"python": ["py"], "sql": ["t-sql"], "power bi": []}}})
    assert keyword_overlap("We use Python, T-SQL and more SQL. PowerBI is nice.", idx) == 2
    assert keyword_overlap(None, idx) == 0
