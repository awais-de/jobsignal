"""Daily digest email (no ranking until Phase 3)."""

from __future__ import annotations

from datetime import date
from html import escape

from pipeline.models import RawPosting

REMOTE_LABEL = {"remote": "Remote", "hybrid": "Hybrid", "onsite": "On-site"}
# Display names for job_postings.source; keep in sync with web/src/supabase.ts SOURCE_LABELS.
SOURCE_LABELS = {"ba_api": "Arbeitsagentur", "careers": "Company site", "manual": "Added by hand",
                 "sample": "Sample"}
BUTTON = ("display:inline-block;padding:4px 12px;margin-right:8px;border-radius:4px;"
          "text-decoration:none;font-size:13px;font-weight:600;")


def build_digest(shown: list[RawPosting], total: int, day: date,
                 links: list[tuple[str, str] | None] | None = None,
                 app_url: str | None = None,
                 extras: list[dict] | None = None) -> tuple[str, str, str]:
    """Returns (subject, text, html). `shown` is already ordered and capped; `total` counts all that passed.
    `links` holds an (apply_url, skip_url) pair per shown posting, or None when no links can be made.
    `app_url` adds a link to the web app's timeline, which keeps every job for 30 days."""
    links = links or [None] * len(shown)
    extras = extras or [{}] * len(shown)
    hidden = total - len(shown)
    subject = f"jobsignal {day:%d %b}: {total} new job{'s' if total != 1 else ''}"
    app_text = f"\n\nTimeline (last 30 days): {app_url}" if app_url else ""
    app_html = (f'<p style="font-size:13px"><a href="{escape(app_url)}">Open the timeline</a> '
                "for every job from the last 30 days.</p>") if app_url else ""

    if not shown:
        text = "No new postings passed the filters today. That's a normal result." + app_text
        html = f"<p>{escape(text.split(chr(10))[0])}</p>{app_html}"
        return subject, text, html

    text_lines, html_items = [], []
    for p, pair, ex in zip(shown, links, extras):
        meta = _meta(p)
        why = _why(ex)
        link = p.apply_url or p.source_url or ""
        actions_text = f"\n  Apply: {pair[0]}\n  Skip:  {pair[1]}" if pair else ""
        why_text = "".join(f"\n  {line}" for line in why)
        text_lines.append(f"- {p.title} | {p.company_name}\n  {' · '.join(meta)}{why_text}\n  {link}{actions_text}")
        actions_html = (
            f'<br><a href="{escape(pair[0])}" style="{BUTTON}background:#1a7f37;color:#fff">Apply</a>'
            f'<a href="{escape(pair[1])}" style="{BUTTON}background:#eaeef2;color:#24292f">Skip</a>'
            if pair else ""
        )
        html_items.append(
            f'<li style="margin-bottom:16px"><a href="{escape(link)}" style="font-weight:600">{escape(p.title)}</a>'
            f"<br>{escape(p.company_name)}"
            f'<br><span style="color:#666;font-size:13px">{escape(" · ".join(meta))}</span>'
            + "".join(f'<br><span style="font-size:13px">{escape(line)}</span>' for line in why)
            + f"{actions_html}</li>"
        )
    more = f"\n…and {hidden} more{' in the timeline' if app_url else ''}." if hidden else ""
    text = "\n\n".join(text_lines) + more + app_text
    more_html = ""
    if hidden:
        more_html = (f'<p>…and <a href="{escape(app_url)}">{hidden} more in the timeline</a>.</p>'
                     if app_url else f"<p>…and {hidden} more.</p>")
    html = (
        '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.4">'
        f'<ol style="padding-left:20px">{"".join(html_items)}</ol>'
        + more_html + app_html
        + "</div>"
    )
    return subject, text, html


def _why(ex: dict) -> list[str]:
    """'Why it ranked' lines (spec 7.10): skills, then language and experience requirements."""
    lines: list[str] = []
    details = ex.get("rank_details") or {}
    if details:
        matched, missing = details.get("matched") or [], details.get("missing") or []
        total = len(matched) + len(missing)
        if total:
            line = f"✓ {len(matched)}/{total} must-haves"
            if matched:
                line += f": {', '.join(matched[:6])}"
            lines.append(line)
        if missing:
            lines.append(f"✗ missing: {', '.join(missing[:6])}")
    reqs = []
    if ex.get("german_level") and ex["german_level"] != "none":
        reqs.append(f"German {ex['german_level']}")
    elif ex.get("german_level") == "none":
        reqs.append("no German needed")
    if ex.get("required_years") is not None:
        reqs.append(f"{ex['required_years']:g}+ yrs")
    if reqs:
        lines.append(" · ".join(reqs))
    if ex.get("extraction_status") in ("failed", "pending"):
        lines.append("(not analysed yet)")
    return lines


def _meta(p: RawPosting) -> list[str]:
    n_locations = len(p.location_raw.split("; ")) if p.location_raw else 0
    place = p.city or "Germany"
    if n_locations > 1:
        place += f" +{n_locations - 1} location{'s' if n_locations > 2 else ''}"
    meta = [place]
    if p.remote_policy:
        meta.append(REMOTE_LABEL[p.remote_policy])
    if p.posted_date:
        meta.append(f"posted {p.posted_date:%d %b}")
    if p.salary_text:
        meta.append(p.salary_text)
    if p.poster_type == "agency":
        meta.append("agency")
    meta.append(f"via {SOURCE_LABELS.get(p.source, p.source)}")
    return meta
