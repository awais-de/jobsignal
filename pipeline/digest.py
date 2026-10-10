"""Plain daily digest (Phase 1: no ranking, no action links)."""

from __future__ import annotations

from datetime import date
from html import escape

from pipeline.models import RawPosting

REMOTE_LABEL = {"remote": "Remote", "hybrid": "Hybrid", "onsite": "On-site"}


def build_digest(shown: list[RawPosting], total: int, day: date) -> tuple[str, str, str]:
    """Returns (subject, text, html). `shown` is already ordered and capped; `total` counts all that passed."""
    hidden = total - len(shown)
    subject = f"jobsignal {day:%d %b}: {total} new job{'s' if total != 1 else ''}"

    if not shown:
        text = "No new postings passed the filters today. That's a normal result."
        html = f"<p>{escape(text)}</p>"
        return subject, text, html

    text_lines, html_items = [], []
    for p in shown:
        meta = _meta(p)
        link = p.apply_url or p.source_url or ""
        text_lines.append(f"- {p.title} | {p.company_name}\n  {' · '.join(meta)}\n  {link}")
        html_items.append(
            f'<li style="margin-bottom:14px"><a href="{escape(link)}" style="font-weight:600">{escape(p.title)}</a>'
            f"<br>{escape(p.company_name)}"
            f'<br><span style="color:#666;font-size:13px">{escape(" · ".join(meta))}</span></li>'
        )
    more = f"\n…and {hidden} more." if hidden else ""
    text = "\n\n".join(text_lines) + more
    html = (
        '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.4">'
        f'<ol style="padding-left:20px">{"".join(html_items)}</ol>'
        + (f"<p>…and {hidden} more.</p>" if hidden else "")
        + "</div>"
    )
    return subject, text, html


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
    return meta
