"""Title families (owner decision 2026-10-12): groups of search terms and title patterns, each in a mode.

- core:    as before: searched, filtered, ranked, in the digest and the main feed.
- explore: searched and ranked the same way, but only shown in the app's Explore tab, and with a
           smaller AI budget per run. For directions the owner is testing (database, software ...).
- off:     not searched, titles don't pass.

A job's family is the first core family whose patterns match its title (else the first explore one);
its lane is that family's mode. Profiles without `families` behave as before: one core family made
of `titles.allow` and `search_terms`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

MODES = ("core", "explore", "off")


@dataclass
class Family:
    key: str
    label: str
    mode: str
    titles: list[re.Pattern] = field(default_factory=list)
    exclude: list[re.Pattern] = field(default_factory=list)
    search_terms: list[str] = field(default_factory=list)

    def matches(self, title: str) -> bool:
        return any(p.search(title) for p in self.titles) and not any(p.search(title) for p in self.exclude)


def _compile(patterns: list[str] | None) -> list[re.Pattern]:
    out = []
    for p in patterns or []:
        try:
            out.append(re.compile(p, re.IGNORECASE))
        except re.error:
            pass   # validate_profile already warned and dropped these
    return out


def load_families(profile: dict[str, Any]) -> list[Family]:
    raw = profile.get("families")
    if not raw:
        return [Family("core", "Target roles", "core", _compile(profile["titles"].get("allow")), [],
                       list(profile.get("search_terms") or []))]
    return [Family(str(f.get("key") or f.get("label") or i), str(f.get("label") or f.get("key") or i),
                   f.get("mode") if f.get("mode") in MODES else "off",
                   _compile(f.get("titles")), _compile(f.get("exclude")), list(f.get("search_terms") or []))
            for i, f in enumerate(raw)]


def classify(title: str, families: list[Family]) -> Family | None:
    """Core families win over explore ones; off families never match."""
    for mode in ("core", "explore"):
        for f in families:
            if f.mode == mode and f.matches(title):
                return f
    return None


def active_search_terms(families: list[Family]) -> list[str]:
    seen: dict[str, None] = {}
    for f in families:
        if f.mode != "off":
            for t in f.search_terms:
                seen.setdefault(t.strip(), None)
    return [t for t in seen if t]


def active_title_patterns(raw_families: list[dict[str, Any]]) -> list[str]:
    seen: dict[str, None] = {}
    for f in raw_families:
        if f.get("mode") in ("core", "explore"):
            for p in f.get("titles") or []:
                seen.setdefault(p, None)
    return list(seen)
