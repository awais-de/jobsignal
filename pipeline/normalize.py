"""Normalization and the dedupe hash (spec 7.3)."""

from __future__ import annotations

import hashlib
import re
import unicodedata

# Longest first, so 'gmbh & co. kg' is stripped before 'gmbh'.
LEGAL_FORMS = sorted(
    [
        "gmbh & co. kgaa", "gmbh & co. kg", "gmbh & co kg", "ag & co. kg", "se & co. kg",
        "gmbh", "mbh", "ag", "se", "kg", "kgaa", "ug (haftungsbeschränkt)", "ug", "ohg", "gbr",
        "e.v.", "ev", "e.g.", "eg", "inc.", "inc", "ltd.", "ltd", "llc", "b.v.", "bv", "s.a.", "sa",
        "plc", "corp.", "corp", "co.",
    ],
    key=len,
    reverse=True,
)

# Company-name tails that are about the branch, not the employer.
BRANCH_SUFFIX = re.compile(r"\b(niederlassung|standort|zweigniederlassung|filiale|branch)\b.*$")

GENDER_MARKERS = re.compile(
    r"\(\s*(?:[mwfdxi]\s*[/|,\s]\s*){1,3}[mwfdxi]\s*\)"    # (m/w/d), (w/m/d), (f/m/x), (m|w|d), (m w d)
    r"|\(\s*all genders?\s*\)|\(\s*gn\s*\)|\(\s*d\s*\)"
    r"|\*in(?:nen)?\b|:in(?:nen)?\b|/-?in(?:nen)?\b|_in(?:nen)?\b",
    re.IGNORECASE,
)
REFERENCE_NUMBER = re.compile(
    r"\b(?:ref(?:erenz)?(?:[\s.-]*(?:nr|no|nummer)\b)?|job[- ]?id|kennziffer)\.?\s*[:#]?\s*[\w-]*\d[\w-]*",
    re.IGNORECASE,
)

CITY_ALIASES = {
    "cologne": "köln",
    "munich": "münchen",
    "muenchen": "münchen",
    "koeln": "köln",
    "nuremberg": "nürnberg",
    "nuernberg": "nürnberg",
    "dusseldorf": "düsseldorf",
    "duesseldorf": "düsseldorf",
    "frankfurt": "frankfurt am main",
    "frankfurt/main": "frankfurt am main",
    "frankfurt a.m.": "frankfurt am main",
    "hanover": "hannover",
    "brunswick": "braunschweig",
}


def _collapse(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _strip_punct(text: str) -> str:
    # Keep letters (incl. umlauts), digits and spaces.
    return "".join(ch if ch.isalnum() or ch.isspace() else " " for ch in text)


def normalize_company(name: str) -> str:
    s = unicodedata.normalize("NFC", name).lower()
    s = BRANCH_SUFFIX.sub("", s)
    changed = True
    while changed:
        changed = False
        for form in LEGAL_FORMS:
            pattern = rf"(?:^|[\s,]){re.escape(form)}(?=$|[\s,])"
            new = re.sub(pattern, " ", s)
            if new != s:
                s, changed = new, True
    return _collapse(_strip_punct(s))


def normalize_title(title: str) -> str:
    s = unicodedata.normalize("NFC", title)
    s = GENDER_MARKERS.sub(" ", s)
    s = REFERENCE_NUMBER.sub(" ", s)
    s = s.lower()
    return _collapse(_strip_punct(s))


def normalize_city(city: str | None) -> str:
    if not city:
        return ""
    s = unicodedata.normalize("NFC", city).lower().strip()
    s = re.split(r"\s*[,(]\s*|\s+-\s+", s)[0]       # 'Berlin, Mitte' / 'Berlin (Mitte)' / 'Hamburg - Altona'
    s = _collapse(s)
    return CITY_ALIASES.get(s, s)


def dedupe_hash(company: str, title: str, city: str | None) -> str:
    key = f"{normalize_company(company)}|{normalize_title(title)}|{normalize_city(city)}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()
