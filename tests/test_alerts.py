"""StepStone alert parsing. The emails are synthetic, in the layouts of real ones (2026-10-19)."""

from pipeline.dedupe import preference
from pipeline.normalize import normalize_title
from pipeline.sources.alerts import parse_email

J1 = "https://www.stepstone.de/stellenangebote----11111111-inline.html"
J2 = "https://www.stepstone.de/stellenangebote----22222222-inline.html"
J3 = "https://www.stepstone.de/stellenangebote----33333333-inline.html"

DIGEST = f"""Deine neuesten Job-Matches
-------------------------------------------------

Hallo Erika,

wir haben 3 neue Jobs gefunden, die zu deiner Suche nach "data engineer" Positionen in Deutschland passen.

Wie gut passe ich?
Finde ideale Jobs für dich
Lebenslauf hochladen

Neue Job-Matches



Datenbankadministrator PostgreSQL (m/w/d)
{J1}
Beispiel Notarkammer
Berlin
Homeoffice möglich, Vollzeit
65.000 - 75.000 €/Jahr (geschätzt für Vollzeit)

Bewerbungs-Update verfügbar



SQL-Developer / Datenbankentwickler:in (m/...
{J2}
Muster Versicherung Holding AG
Stuttgart
Homeoffice möglich, Teilzeit, Vo...



Softwareentwickler Cobol (m/w/d)
[stepstone-link]
Muster Informatik GmbH & Co. KG
Hannover, Münster und Frankfurt am Main
Vollzeit


Mainframe Developer (w/m/d)
{J3}
"""

SINGLE = f"""Hallo Erika,
hier ist ein Job, der eine gute Option sein könnte, je nachdem, was du als Nächstes anstrebst.
Für dich empfohlen
Data Analyst & Automation Engineer (m/w/d)...
Beispiel Contact GmbH
20457 Hamburg
Feste Anstellung
Homeoffice möglich, Vollzeit
47.000 - 66.000 €/Jahr (geschätzt für Vollzeit)
vor 7 Tagen
Ich\u00a0bin\u00a0interessiert
Top-Fähigkeiten
Bei diesem Job kannst du mit folgenden Fähigkeiten punkten:
Automatisierung - Dashboard - PostgreSQL - Python -
Einleitung
Wir sind ein Kundenservice-Dienstleister mit vielen Daten.
Jobs perfekt auf dich abgestimmt
Dazu einfach deinen Lebenslauf hochladen. So hast du in der nächsten E-Mail bis zu 3 Top-Matches gleich im Blick.
Lebenslauf hochladen
Aufgaben
Du baust Reports und Dashboards und automatisierst Auswertungen mit Python und SQL.
Die vollständige Stellenbeschreibung findest du hier
{J1}
Diesen Job melden
-------------------------------------------------
E-Mail-Einstellungen verwalten
© 2026 Beispiel
"""


def test_digest_cards():
    jobs = parse_email({"id": "e1", "subject": "Wir haben 3 neue Job-Matches für dich gefunden", "body_text": DIGEST})
    # The fourth card is cut off by the email's end (no company): skipped.
    assert [j.company_name for j in jobs] == ["Beispiel Notarkammer", "Muster Versicherung Holding AG", "Muster Informatik GmbH & Co. KG"]
    a, b, c = jobs
    assert a.source == "alert_stepstone" and a.source_job_id == "11111111" and a.source_url == J1
    assert a.title == "Datenbankadministrator PostgreSQL (m/w/d)" and a.city == "Berlin" and a.country == "DE"
    assert a.remote_policy == "hybrid" and a.contract_type == "full_time" and a.salary_text.startswith("65.000")
    assert a.posted_date is None and a.description is None
    # A cut title loses StepStone's "…" and the unclosed "(m/…", so it still matches the full title.
    assert b.title == "SQL-Developer / Datenbankentwickler:in" and b.source_data["title_cut"] is True
    assert normalize_title(b.title) == normalize_title("SQL-Developer / Datenbankentwickler:in (m/w/d)")
    assert b.contract_type == "full_time"                # "Teilzeit, Vo..." also offers full time
    # An unresolved link keeps the card but gives no id or address.
    assert c.source_job_id is None and c.source_url is None
    assert c.city == "Hannover" and c.location_raw == "Hannover; Münster; Frankfurt am Main"


def test_single_job_with_description_and_full_title_from_subject():
    jobs = parse_email({"id": "e2", "subject": "Du passt perfekt: Data Analyst & Automation Engineer (m/w/d) | 100 % remote",
                        "body_text": SINGLE})
    assert len(jobs) == 1
    j = jobs[0]
    assert j.title == "Data Analyst & Automation Engineer (m/w/d) | 100 % remote"
    assert "title_cut" not in j.source_data and j.source_data["alert_kind"] == "single"
    assert j.company_name == "Beispiel Contact GmbH" and j.city == "Hamburg"          # postcode dropped
    assert j.remote_policy == "remote" and j.contract_type == "full_time" and j.source_data["age_text"] == "vor 7 Tagen"
    assert j.source_job_id == "11111111"
    assert "Kundenservice-Dienstleister" in j.description and "automatisierst Auswertungen" in j.description
    assert "Lebenslauf" not in j.description and "vollständige Stellenbeschreibung" not in j.description
    assert "stepstone.de" not in j.description


def test_single_job_without_title_in_subject_keeps_the_card_title():
    jobs = parse_email({"id": "e3", "subject": "Beliebter Job - schließ dich über 40 Bewerbern an",
                        "body_text": SINGLE.replace("Für dich empfohlen", "Beliebter Job")})
    assert jobs[0].title == "Data Analyst & Automation Engineer (m/w/d)" and jobs[0].source_data["title_cut"] is True


def test_not_an_alert_layout_gives_nothing():
    assert parse_email({"id": "e4", "subject": "Willkommen bei Stepstone", "body_text": "Hallo Erika,\nwillkommen!"}) == []


def test_alerts_rank_last_among_sources():
    assert preference("alert_stepstone") == preference("alert") > preference("arbeitnow")


def test_single_job_without_a_marker_line():
    body = """Hallo Erika,
dieser Job hat nicht viele Bewerber - warum nicht du?
Werkstudent Data Analyst & Automation Engi...
Beispiel Contact GmbH
Hamburg
Studentenjobs, Werkstudent
Homeoffice möglich, Teilzeit
vor 6 Tagen | 3 Bewerber*innen
Sei eine*r der ersten Bewerber*innen
Ich bin interessiert
Top-Fähigkeiten
Wir suchen dich für unser Datenteam.
Die vollständige Stellenbeschreibung findest du hier
https://www.stepstone.de/stellenangebote----44444444-inline.html
"""
    j = parse_email({"id": "e5", "subject": "Wenig Bewerber bisher - deine Chance, um herauszustechen", "body_text": body})[0]
    assert j.title == "Werkstudent Data Analyst & Automation Engi" and j.source_data["title_cut"] is True
    assert j.company_name == "Beispiel Contact GmbH" and j.contract_type == "part_time" and j.source_job_id == "44444444"
    assert j.source_data["age_text"] == "vor 6 Tagen" and j.description == "Wir suchen dich für unser Datenteam."


def test_jobs_abroad_get_their_country():
    from pipeline.sources.alerts import _country
    assert _country("London EC4V 3BJ") == "GB" and _country("Oldham OL1 4EQ") == "GB"
    assert _country("Ho-Chi-Minh-Stadt") == "VN" and _country("Wien") == "AT" and _country("Zürich") == "CH"
    assert _country("Frankfurt am Main (60311)") == "DE" and _country("Berlin") == "DE" and _country("bundesweit") == "DE"
    assert _country("Remote") == "DE" and _country("Siegburg bei Köln/Bonn") == "DE"
    assert _country("Bad Homburg") == "DE"                      # 'homburg', not a foreign city

