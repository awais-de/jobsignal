"""Skills database as the source of the owner's skills (owner decision 2026-10-14).

The rows come from the ranking_skills() RPC: skills rated 3+ ("basics" and up), or not rated yet but
taken over from the profile. They become the profile's `skills` structure ({category: {name: aliases}}),
which the ranking already understands; ranking stays yes/no. The stamp (latest skill or rating change)
is part of the profile version, so a skills change makes the re-rank recompute every job.
"""

from __future__ import annotations

from typing import Any


def skills_from_rows(rows: list[dict[str, Any]]) -> tuple[dict[str, dict[str, list[str]]], str | None]:
    skills: dict[str, dict[str, list[str]]] = {}
    stamp = None
    for r in rows:
        cat = r.get("category") or "other"
        name = (r.get("name") or "").strip()
        if not name:
            continue
        aliases = sorted({a.strip().lower() for a in (r.get("aliases") or []) if a and a.strip()} - {name.lower()})
        skills.setdefault(cat, {})[name] = aliases
        stamp = max(stamp, r["stamp"]) if stamp and r.get("stamp") else (r.get("stamp") or stamp)
    return skills, stamp
