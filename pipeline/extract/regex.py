"""Regex extractors (spec 7.5.2). Cheap, deterministic, German and English."""

from __future__ import annotations

import re

CEFR_ORDER = ["A1", "A2", "B1", "B2", "C1", "C2"]

# German level: explicit CEFR next to "Deutsch"/"German", then common phrases.
GERMAN_CEFR = re.compile(
    r"(?:deutsch(?:kenntnisse|e sprachkenntnisse)?|german(?: language)?(?: skills| proficiency)?)"
    r"[^.\n,;]{0,40}?\b([ABC][12])\b"
    # Level written directly before the word ('C1-Deutschkenntnisse', 'B2 German'), so that
    # 'Englisch C2, Deutsch B2' doesn't attribute C2 to German.
    r"|\b([ABC][12])[\s-]*(?:deutsch|german)",
    re.IGNORECASE,
)
GERMAN_PHRASES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"deutsch\w*\s+(?:auf\s+)?muttersprach|muttersprachlich\w*\s+deutsch|deutsch als muttersprache|"
                r"native(?:-level)? german|german (?:native|mother tongue)", re.I), "C2"),
    (re.compile(r"verhandlungssicher\w*\s+deutsch|deutsch\w*[^.\n]{0,30}verhandlungssicher|"
                r"flie(?:ß|ss)end\w*\s+deutsch|deutsch\w*[^.\n]{0,30}flie(?:ß|ss)end|"
                r"fluent (?:in )?german|german[^.\n]{0,20}fluent|business[- ]fluent german|"
                r"sehr gute deutsch|excellent (?:command of )?german", re.I), "C1"),
    (re.compile(r"(?<!sehr )gute deutsch|good (?:command of )?german|deutsch\w*[^.\n]{0,15}\bgut\b", re.I), "B2"),
    (re.compile(r"grundkenntnisse\w*\s+(?:in\s+)?deutsch|basic german|deutsch\w*[^.\n]{0,20}grundkenntnisse", re.I), "A2"),
]
GERMAN_NOT_REQUIRED = re.compile(
    r"german (?:is )?(?:not required|a plus|nice to have|beneficial|optional)|no german (?:required|needed)|"
    r"deutsch\w* (?:von )?vorteil|deutschkenntnisse sind (?:ein )?plus|deutsch (?:ist )?keine voraussetzung",
    re.I,
)

# Years of experience: only in an experience context, so "50 Jahre Firmengeschichte" doesn't count.
_EXP = r"(?:berufserfahrung|erfahrung|experience|work experience|professional experience)"
YEARS_PATTERNS = [
    re.compile(rf"(\d{{1,2}})\s*(?:-|–|bis|to)\s*(\d{{1,2}})\+?\s*(?:jahre?n?|years?)[^.\n]{{0,40}}?{_EXP}", re.I),
    re.compile(rf"(?:mindestens|min\.|at least|minimum(?: of)?)\s*(\d{{1,2}})\+?\s*(?:jahre?n?|years?)", re.I),
    re.compile(rf"(\d{{1,2}})\+?\s*(?:jahre?n?|years?)[^.\n]{{0,40}}?{_EXP}", re.I),
    re.compile(rf"{_EXP}[^.\n]{{0,30}}?(\d{{1,2}})\+?\s*(?:jahre?n?|years?)", re.I),
]

CONTRACT_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"werkstudent|working student", re.I), "werkstudent"),
    (re.compile(r"\bpraktikum\b|\binternship\b|\bintern\b", re.I), "internship"),
    (re.compile(r"abschlussarbeit|masterarbeit|bachelorarbeit|\bthesis\b", re.I), "thesis"),
    (re.compile(r"\bteilzeit\b|\bpart[- ]time\b", re.I), "part_time"),
    (re.compile(r"\bvollzeit\b|\bfull[- ]time\b", re.I), "full_time"),
]

EVERGREEN = re.compile(
    r"initiativbewerbung|talent ?pool|always looking for|immer auf der suche|laufend gesucht|"
    r"for future (?:opportunities|positions)|für zukünftige (?:positionen|stellen)",
    re.I,
)


def german_level(text: str) -> str | None:
    """Highest level the text asks for, 'none' if German is explicitly optional, else None."""
    found: list[str] = []
    for m in GERMAN_CEFR.finditer(text):
        found.append((m.group(1) or m.group(2)).upper())
    for pattern, level in GERMAN_PHRASES:
        if pattern.search(text):
            found.append(level)
    if found:
        return max(found, key=CEFR_ORDER.index)
    if GERMAN_NOT_REQUIRED.search(text):
        return "none"
    return None


def required_years(text: str) -> float | None:
    """Smallest stated requirement (lower bound of a range), ignoring implausible values."""
    values: list[float] = []
    for pattern in YEARS_PATTERNS:
        for m in pattern.finditer(text):
            v = float(m.group(1))
            if 0 < v <= 15:
                values.append(v)
    return min(values) if values else None


def contract_type(title: str) -> str | None:
    """From the title only. Bodies say things like 'Teilzeit möglich' or 'Praktikanten betreuen'
    in full-time ads, so the body is left to the LLM, which reads the context."""
    for pattern, kind in CONTRACT_PATTERNS:
        if pattern.search(title):
            return kind
    return None


def evergreen(text: str) -> bool:
    return bool(EVERGREEN.search(text))


def cefr_above(level: str | None, ceiling: str) -> bool:
    return level in CEFR_ORDER and CEFR_ORDER.index(level) > CEFR_ORDER.index(ceiling)
