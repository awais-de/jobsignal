"""Ghost-job score (spec 7.8; owner decision 2026-10-19): programmatic rules only.

A ghost job is a posting from a real company with no active hiring behind it. The score adds the
points of every signal that fires, clamped to 0-100, and keeps each signal with its reason, so the
app can show why. Buckets: apply (< verify_from), verify, skip ("likely ghost", >= skip_from).
Nothing is hidden on the score yet: the feed shows the bucket and the reasons.

Age only trusts dates a reposting can't reset: our own first sighting of the role (any source, any
id, any city: its family) and the Arbeitsagentur's first publication date. A board's "posted" date
is not trusted (LinkedIn and Arbeitnow reset it on a repost).

Not built yet: the "only on an aggregator, not on the employer's site" signal (+35 in the spec),
which needs the liveness check (spec 7.7).
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

DEFAULTS: dict[str, Any] = {
    "age_31_60": 15, "age_over_60": 30, "repost": 20, "same_text": 10, "agency": 15, "evergreen": 20,
    "vague": 10, "named_contact": -10, "start_date": -5, "reference": -5, "own_site_fresh": -15,
    "clones": 10, "clone_cities": 3, "company_reposts": 10, "company_reposting_roles": 3,
    "company_silent": 10, "verify_from": 30, "skip_from": 60,
}


def _date(v: Any) -> date | None:
    if not v:
        return None
    if isinstance(v, date):
        return v if not isinstance(v, datetime) else v.date()
    return datetime.fromisoformat(str(v).replace("Z", "+00:00")).date() if "T" in str(v) else date.fromisoformat(str(v)[:10])


def score(p: dict[str, Any], ctx: dict[str, Any], weights: dict[str, Any] | None, agencies: list[str],
          today: date) -> tuple[int, str, list[dict[str, Any]]]:
    """(score, bucket, signals) for one posting row and its ghost_context row."""
    w = {**DEFAULTS, **(weights or {})}
    signals: list[dict[str, Any]] = []

    def add(key: str, detail: str) -> None:
        signals.append({"key": key, "points": int(w[key]), "detail": detail})

    trusted = [d for d in (_date(ctx.get("family_first_seen")), _date(ctx.get("family_first_published")),
                           _date(p.get("posted_date")) if p.get("source") == "ba_api" else None) if d]
    first = min(trusted) if trusted else today
    age = (today - first).days
    since = f"open since {first:%d %b %Y} ({age} days)"
    if age > 60:
        add("age_over_60", since)
    elif age > 30:
        add("age_31_60", since)

    reposts = int(p.get("repost_count") or 0) + int(p.get("reappear_count") or 0) + int(ctx.get("family_gap_reposts") or 0)
    if reposts:
        add("repost", f"listed again {reposts}× after disappearing" if reposts > 1 else "listed again after disappearing")
    if ctx.get("family_text_reused"):
        add("same_text", "the same description was posted again later")

    name = (p.get("company_name") or "").lower()
    if p.get("poster_type") == "agency" or any(a in name for a in agencies):
        add("agency", "posted by a staffing agency, not the employer")
    if p.get("evergreen_language"):
        add("evergreen", "evergreen wording (e.g. 'we're always looking', talent pool)")
    if p.get("extraction_status") == "done" and p.get("specificity_score") == 0:
        add("vague", "no named team, project or manager")
    if p.get("named_contact"):
        add("named_contact", "names a contact person")
    if p.get("start_date_text"):
        add("start_date", "gives a concrete start date")
    if p.get("reference_number"):
        add("reference", "has a reference number")
    if p.get("source") == "careers" and age <= 7:
        add("own_site_fresh", "fresh on the employer's own career page")

    cities = int(ctx.get("family_live_cities") or 0)
    if cities >= int(w["clone_cities"]):
        add("clones", f"the same role is listed in {cities} cities at once")
    roles = int(ctx.get("company_reposting_roles") or 0)
    if roles >= int(w["company_reposting_roles"]):
        add("company_reposts", f"this company re-listed {roles} roles in the last 4 months")
    silent = int(ctx.get("company_silent_apps") or 0)
    if silent:
        add("company_silent", f"{silent} of your applications here got no answer for 30+ days")

    total = max(0, min(100, sum(s["points"] for s in signals)))
    bucket = "skip" if total >= int(w["skip_from"]) else "verify" if total >= int(w["verify_from"]) else "apply"
    return total, bucket, signals


def reasons(signals: list[dict[str, Any]]) -> list[str]:
    """The signals that raise the score, biggest first: for the digest and the feed."""
    return [s["detail"] for s in sorted(signals, key=lambda s: -s["points"]) if s["points"] > 0]
