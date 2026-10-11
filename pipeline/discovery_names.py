"""Company-name helpers shared by discovery and website detection."""

from __future__ import annotations

import re

from pipeline.normalize import normalize_company

# Words that don't identify a company (dropped from slugs and from the name check).
GENERIC = {"deutschland", "germany", "group", "gruppe", "holding", "und", "the", "of", "de", "international",
           "services", "service", "europe", "niederlassung", "zweigniederlassung", "stiftung", "jobs", "bei",
           "at", "career", "careers", "karriere", "board", "stellenangebote", "co", "ag", "gmbh"}
_UMLAUT = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})


def tokens(name: str) -> list[str]:
    return [t for t in normalize_company(name).translate(_UMLAUT).split()
            if t not in GENERIC and re.fullmatch(r"[a-z0-9]+", t)]
