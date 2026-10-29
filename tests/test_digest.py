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
    assert "4 more in the timeline" in text and "Timeline (last 30 days): https://app.example.org/#feed" in text
    assert 'href="https://app.example.org/#feed"' in html


def test_empty_digest_links_timeline():
    _, text, html = build_digest([], 0, date(2026, 10, 10), app_url="https://app.example.org")
    assert "No new postings" in text and "Open the timeline" in html


def test_html_is_escaped():
    _, _, html = build_digest([posting(title="<script>x</script>")], 1, date(2026, 10, 10))
    assert "<script>" not in html


# -- outreach reminders ------------------------------------------------------------------
def _app(id, company="Beispiel GmbH", title="Data Engineer"):
    return {"id": id, "job_posting_id": f"J{id}", "applied_at": "2026-10-10T10:00:00Z", "job_postings": {"company_name": company, "title": title}}


def test_reminders_list_unpinged_active_applications():
    from pipeline.digest import outreach_reminders
    apps = [_app("A1"), _app("A2", "Muster AG"), _app("A3", "Closed AG")]
    statuses = [{"application_id": "A1", "status": "applied"}, {"application_id": "A2", "status": "applied"},
                {"application_id": "A3", "status": "rejected"}]
    pings = [{"job_posting_id": "JA2", "status": "sent", "follow_up_due": "2026-10-19", "followed_up_at": None,
              "contacts": {"full_name": "Anna Muster", "company_name": "Muster AG"}}]
    lines = outreach_reminders(apps, statuses, pings, date(2026, 10, 12))
    assert lines == ["Reach out: nobody contacted yet for Beispiel GmbH (Data Engineer)."]


def test_reminders_follow_up_due_today_only_once():
    from pipeline.digest import outreach_reminders
    ping = {"job_posting_id": "JA1", "status": "sent", "follow_up_due": "2026-10-12", "followed_up_at": None,
            "contacts": {"full_name": "Anna Muster", "company_name": "Muster AG"}}
    assert outreach_reminders([_app("A1")], [], [ping], date(2026, 10, 12)) == ["Follow up today: Anna Muster (Muster AG)."]
    done = {**ping, "followed_up_at": "2026-10-12T09:00:00Z"}
    assert outreach_reminders([_app("A1")], [], [done], date(2026, 10, 12)) == []
    replied = {**ping, "status": "replied"}
    assert outreach_reminders([_app("A1")], [], [replied], date(2026, 10, 12)) == []


def test_digest_shows_reminders_even_without_jobs():
    _, text, html = build_digest([], 0, date(2026, 10, 12), app_url="https://app.example",
                                 reminders=["Reach out: nobody contacted yet for Beispiel GmbH (Data Engineer)."])
    assert text.startswith("Reach out:") and "https://app.example/#applications" in text
    assert "Open Applications" in html


def test_explore_jobs_get_their_own_line_not_the_subject_count():
    subject, text, html = build_digest([posting()], 15, date(2026, 10, 13), app_url="https://app.example", explore=15)
    assert "15 new jobs" in subject
    assert "Also 15 new jobs in Explore" in text and "Also 15 new jobs in Explore" in html
    subject, text, _ = build_digest([posting()], 1, date(2026, 10, 13))
    assert "Explore" not in text


def test_app_warnings_come_first_in_the_digest():
    w = [{"level": "red", "area": "GitHub", "text": "The GitHub token expires in 2 day(s)."}]
    _, text, html = build_digest([posting()], 1, date(2026, 10, 14), app_url="https://app.example", warnings=w)
    assert text.startswith("App warnings:\n[RED] GitHub: The GitHub token expires")
    assert "https://app.example/#control" in text and "App warnings" in html
    _, text, _ = build_digest([posting()], 1, date(2026, 10, 14))
    assert "App warnings" not in text


def test_digest_counts_jobs_already_handled_on_the_portal():
    _, text, _ = build_digest([posting()], 1, date(2026, 10, 29), app_url="https://app.example", already_handled=3)
    assert "3 more jobs came in since the last email; you already handled them on the portal." in text
    _, text, _ = build_digest([posting()], 1, date(2026, 10, 29), app_url="https://app.example", already_handled=1)
    assert "1 more job came in since the last email; you already handled it on the portal." in text
