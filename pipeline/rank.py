"""Ranking (spec 7.9): must-have skill overlap plus small bonuses. Ghost score and apply
effort join in Phase 7; their terms are 0 until then.

rank_score = w_fit * fit_score + preference_bonus - w_ghost * ghost_score + effort_bonus
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


@dataclass
class SkillIndex:
    """Owner's master skill list: alias -> (canonical, track)."""
    aliases: dict[str, tuple[str, str]]

    @classmethod
    def from_profile(cls, profile: dict[str, Any]) -> "SkillIndex":
        aliases: dict[str, tuple[str, str]] = {}
        for track, skills in (profile.get("skills") or {}).items():
            for canonical, alts in (skills or {}).items():
                for name in [canonical, *(alts or [])]:
                    aliases[_norm(name)] = (canonical, track)
        return cls(aliases)

    def match(self, posting_skill: str) -> tuple[str, str] | None:
        """Exact alias, else an alias appearing as a whole word ('Python 3.11' -> python)."""
        s = _norm(posting_skill)
        if s in self.aliases:
            return self.aliases[s]
        for alias, hit in sorted(self.aliases.items(), key=lambda kv: -len(kv[0])):
            if len(alias) >= 2 and re.search(rf"(?<![\w+#]){re.escape(alias)}(?![\w+#])", s):
                return hit
        return None


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s.lower().strip())


def score(fields: dict[str, Any], remote_policy: str | None, index: SkillIndex,
          profile: dict[str, Any], weights: dict[str, Any]) -> tuple[float, float, dict[str, Any]]:
    """Returns (fit_score, rank_score, rank_details)."""
    must = fields.get("must_have_skills") or []
    nice = fields.get("nice_to_have_skills") or []
    matched, missing, tracks = [], [], {}
    for skill in must:
        hit = index.match(skill)
        if hit:
            matched.append(skill)
            tracks[hit[1]] = tracks.get(hit[1], 0) + 1
        else:
            missing.append(skill)
    nice_matched = [s for s in nice if index.match(s)]

    # Floor on the denominator: 2 of 2 must-haves is weaker evidence than 6 of 7.
    fit = 100.0 * len(matched) / max(len(must), int(weights.get("min_must_haves", 1))) if must else 0.0

    prefs = profile.get("preferences") or {}
    preferred = {_norm(p) for p in prefs.get("skills_bonus", [])}
    pref_hits = {index.match(s)[0] for s in must + nice if index.match(s)} & {
        index.aliases[p][0] for p in preferred if p in index.aliases}
    bonus = min(len(pref_hits) * weights["preferred_skill_bonus"], weights["preferred_skill_bonus_cap"])
    if prefs.get("remote_bonus") and remote_policy in ("remote", "hybrid"):
        bonus += weights["remote_bonus"]
    bonus = min(bonus, weights["preference_bonus_cap"])

    rank = weights["w_fit"] * fit + bonus
    details = {
        "matched": matched,
        "missing": missing,
        "nice_matched": nice_matched,
        "preferred": sorted(pref_hits),
        "bonus": round(bonus, 1),
        "track": max(tracks, key=tracks.get) if tracks else None,
    }
    return round(fit, 1), round(rank, 1), details
