"""Job-alert emails as a source (spec 7.1 tier 5): StepStone's job agent, parsed from the stored email text.

The inbox bridge stores the emails (category job_alert) with StepStone's login links already replaced by
plain job addresses (supabase/functions/_shared/inbox/stepstone.ts). Two layouts, verified on real emails
on 2026-10-19:

- Digest ("Wir haben 10 neue Job-Matches für dich gefunden"): up to 10 cards of
  title / link / company / location / details (work model, contract, salary). Titles are often cut ("…").
- Single job ("Du passt perfekt: <title>", "Beliebter Job …", "Wenig Bewerber bisher …"): one card
  (title / company / location / details / "Ich bin interessiert" / link), then most of the description,
  up to "Die vollständige Stellenbeschreibung findest du hier". The subject often has the full title.

An alert's job counts as new on the day the email arrives: StepStone's "vor 7 Tagen" is kept in
source_data (age_text), not used as the posting date, so the freshness filter doesn't drop its picks.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from pipeline.models import RawPosting

NAME = "alert_stepstone"
JOB_URL = re.compile(r"^https://www\.stepstone\.de/stellenangebote-[^\s]*?-(\d{6,})-inline\.html$")
UNRESOLVED = "[stepstone-link]"
SUBJECT_TITLE = re.compile(
    r"^(?:Du passt perfekt|Du bist gefragt|Du wirst gesucht|Du bist Traumkandidat\*?in|Top-Job für dich|Neuer Job)\s*:\s*(.+)$", re.I)
SINGLE_MARKERS = ("Für dich empfohlen", "Beliebter Job", "Top-Job")
INTERESTED = "Ich bin interessiert"
DESC_END = ("Die vollständige Stellenbeschreibung findest du hier", "Diesen Job melden", "E-Mail-Einstellungen verwalten")
NOISE = re.compile(r"^(Bewerbungs-Update verfügbar|Neue Job-Matches|Wie gut passe ich\?|Finde ideale Jobs für dich|Lebenslauf hochladen"
                   r"|Jobs perfekt auf dich abgestimmt|Dazu einfach deinen Lebenslauf hochladen.*|Top-Fähigkeiten"
                   r"|Bei diesem Job kannst du mit folgenden Fähigkeiten punkten:|-{5,})$")
DETAIL = re.compile(r"(vollzeit|teilzeit|homeoffice|remote|feste anstellung|befristet|praktikum|werkstudent|minijob|freiberuf"
                    r"|€|mitarbeiter$|^vor \d+ (tag|tagen|woche|wochen|stunde|stunden)\b|^läuft bald ab$|^neu$)", re.I)
TRUNCATED = re.compile(r"\s*(\.\.\.|…)$")


def _is_link(line: str) -> bool:
    return line == UNRESOLVED or bool(JOB_URL.match(line))


def _clean_title(title: str) -> tuple[str, bool]:
    """A card title without StepStone's '…' and an unclosed '(m/…' fragment; (title, was cut)."""
    cut = bool(TRUNCATED.search(title))
    t = TRUNCATED.sub("", title).strip()
    if cut:
        t = re.sub(r"\s*\([^)]*$", "", t)                  # "(m/..." → gone
        t = re.sub(r"\s*[-–/&|,:]\s*$", "", t)
    return t, cut


def _details(lines: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    text = " ".join(lines).lower()
    if "remote" in text and "homeoffice möglich" not in text:
        out["remote_policy"] = "remote"
    elif "homeoffice" in text:
        out["remote_policy"] = "hybrid"
    full = "vollzeit" in text or re.search(r"\bvo\.\.\.", text)
    if full:
        out["contract_type"] = "full_time"
    elif "teilzeit" in text:
        out["contract_type"] = "part_time"
    for line in lines:
        if "€" in line:
            out["salary_text"] = line
        m = re.match(r"^(vor \d+ \w+|läuft bald ab|neu)\b", line, re.I)
        if m:
            out["age_text"] = m.group(1)
    return out


def _location(line: str) -> tuple[str | None, str | None]:
    """'Hannover, Münster und Frankfurt am Main' → ('Hannover', 'Hannover; Münster; Frankfurt am Main')."""
    parts = [re.sub(r"^\d{5}\s+", "", p).strip() for p in re.split(r",\s*|\s+und\s+|\s+oder\s+", TRUNCATED.sub("", line))
             if p.strip() and p.strip() not in ("...", "…")]
    return (parts[0] if parts else None), ("; ".join(parts) or None)


def _posting(title: str, cut: bool, link: str, company: str, location: str, details: list[str],
             email: dict[str, Any], kind: str, description: str | None = None) -> RawPosting:
    city, location_raw = _location(location)
    d = _details(details)
    m = JOB_URL.match(link)
    return RawPosting(
        source=NAME,
        source_job_id=m.group(1) if m else None,
        company_name=company,
        title=title,
        source_url=link if m else None,
        apply_url=link if m else None,
        location_raw=location_raw,
        city=city,
        country="DE",
        remote_policy="remote" if re.search(r"\bremote\b", title, re.I) and "hybrid" not in title.lower() else d.get("remote_policy"),
        posted_date=None,
        contract_type=d.get("contract_type"),
        salary_text=d.get("salary_text"),
        description=description,
        source_data={k: v for k, v in {"email_id": email.get("id"), "alert_kind": kind, "title_cut": cut or None,
                                       "age_text": d.get("age_text")}.items() if v},
    )


def parse_email(email: dict[str, Any]) -> list[RawPosting]:
    """Postings in one stored StepStone alert email (fields: id, subject, body_text)."""
    # StepStone uses non-breaking spaces ("Ich\xa0bin\xa0interessiert").
    text = (email.get("body_text") or "").replace("\u00a0", " ").replace("\u202f", " ")
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in text.splitlines()]
    lines = [ln for ln in lines if ln and not NOISE.match(ln)]
    if INTERESTED in lines:
        return _single(lines, email)
    return _digest(lines, email)


def _digest(lines: list[str], email: dict[str, Any]) -> list[RawPosting]:
    out: list[RawPosting] = []
    starts = [i for i in range(len(lines) - 1) if _is_link(lines[i + 1]) and not _is_link(lines[i])]
    for n, i in enumerate(starts):
        end = starts[n + 1] if n + 1 < len(starts) else len(lines)
        block = lines[i:end]
        # title, link, company, location, details…; a card cut off by the email's end has no company.
        if len(block) < 4 or _is_link(block[2]) or DETAIL.search(block[2]):
            continue
        title, cut = _clean_title(block[0])
        details = [ln for ln in block[4:] if DETAIL.search(ln)]
        out.append(_posting(title, cut, block[1], block[2], block[3], details, email, "digest"))
    return out


def _single(lines: list[str], email: dict[str, Any]) -> list[RawPosting]:
    k = lines.index(INTERESTED)
    marker = max((i for i in range(k) if lines[i] in SINGLE_MARKERS), default=None)
    if marker is None:
        # No marker ("Wenig Bewerber bisher"): the card starts after the greeting and one intro sentence.
        hello = next((i for i in range(k) if lines[i].startswith(("Hallo ", "Hi "))), None)
        marker = hello + 1 if hello is not None else None
    if marker is None or k - marker < 4:
        return []
    card = lines[marker + 1:k]
    # The button's own link isn't always the job's: take the first job address after the card
    # (it's repeated under "Die vollständige Stellenbeschreibung findest du hier").
    link = next((ln for ln in lines[k + 1:] if JOB_URL.match(ln)), UNRESOLVED)
    card_title, cut = _clean_title(card[0])
    # The full title: from the subject ("Du passt perfekt: …"), else "Wir suchen dich als / <title>" in the text.
    sm = SUBJECT_TITLE.match(email.get("subject") or "")
    full = sm.group(1).strip() if sm else None
    if not full and "Wir suchen dich als" in lines:
        j = lines.index("Wir suchen dich als")
        full = lines[j + 1] if j + 1 < len(lines) else None
    title = full if full and (not cut or full.lower().startswith(card_title.lower()[:20])) else card_title
    cut = cut and title == card_title
    end = next((i for i in range(k + 1, len(lines)) if lines[i].startswith(DESC_END)), len(lines))
    description = "\n".join(ln for ln in lines[k + 1:end] if not _is_link(ln)) or None
    details = [ln for ln in card[3:] if DETAIL.search(ln)]
    return [_posting(title, cut, link, card[1], card[2], details, email, "single", description)]


class StepstoneAlerts:
    """Reads unparsed StepStone alerts; the run marks them parsed after its write (mark_parsed)."""
    name = NAME

    def __init__(self, db: Any, since: datetime):
        self.db = db
        self.since = since
        self.emails: list[dict[str, Any]] = []

    def fetch(self) -> list[RawPosting]:
        self.emails = self.db.unparsed_alerts("%stepstone%", self.since)
        out: list[RawPosting] = []
        for e in self.emails:
            got = parse_email(e)
            e["_parsed"] = len(got)
            out.extend(got)
        return out

    def mark_parsed(self) -> None:
        self.db.mark_alerts_parsed({e["id"]: e.get("_parsed", 0) for e in self.emails})
