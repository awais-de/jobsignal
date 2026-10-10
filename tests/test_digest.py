from datetime import date

from pipeline.digest import build_digest
from pipeline.models import RawPosting


def posting(**kw):
    base = dict(source="ba_api", source_job_id="1", company_name="Beispiel Daten GmbH",
                title="Data Engineer", city="Köln", posted_date=date(2026, 10, 9),
                source_url="https://example.org/job/1")
    return RawPosting(**{**base, **kw})


def test_empty_digest_says_so():
    subject, text, _ = build_digest([], 0, date(2026, 10, 10))
    assert "0 new jobs" in subject and "No new postings" in text


def test_items_and_overflow():
    subject, text, html = build_digest([posting()], 3, date(2026, 10, 10))
    assert "3 new jobs" in subject
    assert "Data Engineer | Beispiel Daten GmbH" in text and "2 more" in text
    assert 'href="https://example.org/job/1"' in html


def test_multi_location_and_agency_marker():
    _, text, _ = build_digest([posting(location_raw="Köln; Berlin; Hamburg", poster_type="agency")], 1, date(2026, 10, 10))
    assert "Köln +2 locations" in text and "agency" in text


def test_source_is_named():
    _, text, _ = build_digest([posting()], 1, date(2026, 10, 10))
    assert "via Arbeitsagentur" in text


def test_overflow_and_timeline_link():
    subject, text, html = build_digest([posting()], 5, date(2026, 10, 10), app_url="https://app.example.org")
    assert "4 more in the timeline" in text and "Timeline (last 30 days): https://app.example.org" in text
    assert 'href="https://app.example.org"' in html


def test_empty_digest_links_timeline():
    _, text, html = build_digest([], 0, date(2026, 10, 10), app_url="https://app.example.org")
    assert "No new postings" in text and "Open the timeline" in html


def test_html_is_escaped():
    _, _, html = build_digest([posting(title="<script>x</script>")], 1, date(2026, 10, 10))
    assert "<script>" not in html
