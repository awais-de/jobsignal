"""Daily digest email (no ranking until Phase 3)."""

from __future__ import annotations

from datetime import date
from html import escape

from pipeline.models import RawPosting

REMOTE_LABEL = {"remote": "Remote", "hybrid": "Hybrid", "onsite": "On-site"}
# Display names for job_postings.source; keep in sync with web/src/supabase.ts SOURCE_LABELS.
SOURCE_LABELS = {"ba_api": "Arbeitsagentur", "careers": "Company site", "arbeitnow": "Arbeitnow", "manual": "Added by hand",
                 "sample": "Sample"}
BUTTON = ("display:inline-block;padding:4px 12px;margin-right:8px;border-radius:4px;"
          "text-decoration:none;font-size:13px;font-weight:600;")


CLOSED = {"rejected", "withdrawn", "offer_declined", "offer_accepted", "no_response", "drafted"}


def outreach_reminders(apps: list[dict], statuses: list[dict], pings: list[dict], today: date,
                       cap: int = 5) -> list[str]:
    """Digest lines: recent applications nobody was pinged about, and pings whose follow-up is due."""
    status = {s["application_id"]: s["status"] for s in statuses}
    pinged = {p["job_posting_id"] for p in pings}          # a ping before applying counts too
    open_apps = [a for a in apps if status.get(a["id"], "applied") not in CLOSED and a["job_posting_id"] not in pinged]
    due = [p for p in pings if p["status"] == "sent" and not p.get("followed_up_at")
           and p.get("follow_up_due") and p["follow_up_due"] <= today.isoformat()]
    lines = []
    if open_apps:
        names = [f'{a["job_postings"]["company_name"]} ({a["job_postings"]["title"]})' for a in open_apps[:cap]]
        more = f" and {len(open_apps) - cap} more" if len(open_apps) > cap else ""
        lines.append(f"Reach out: nobody contacted yet for {', '.join(names)}{more}.")
    if due:
        names = [f'{(p.get("contacts") or {}).get("full_name", "a contact")} ({(p.get("contacts") or {}).get("company_name") or "?"})'
                 for p in due[:cap]]
        more = f" and {len(due) - cap} more" if len(due) > cap else ""
        lines.append(f"Follow up today: {', '.join(names)}{more}.")
    return lines


def build_digest(shown: list[RawPosting], total: int, day: date,
                 links: list[tuple[str, str] | None] | None = None,
                 app_url: str | None = None,
                 extras: list[dict] | None = None,
                 reminders: list[str] | None = None, explore: int = 0,
                 warnings: list[dict[str, str]] | None = None) -> tuple[str, str, str]:
    """Returns (subject, text, html). `shown` is already ordered and capped; `total` counts all that passed.
    `reminders` are outreach lines (see outreach_reminders), shown above the jobs.
    `total` counts core jobs only; `explore` is the number of new Explore-lane jobs (app only), mentioned
    in a line of their own so the subject matches the feed's timeline.
    `warnings` are the control panel's (red/amber), shown first.
    `links` holds an (apply_url, skip_url) pair per shown posting, or None when no links can be made.
    `app_url` adds a link to the web app's timeline, which keeps every job for 30 days."""
    links = links or [None] * len(shown)
    extras = extras or [{}] * len(shown)
    hidden = total - len(shown)
    subject = f"jobsignal {day:%d %b}: {total} new job{'s' if total != 1 else ''}"
    app_text = f"\n\nTimeline (last 30 days): {app_url}" if app_url else ""
    app_html = (f'<p style="font-size:13px"><a href="{escape(app_url)}">Open the timeline</a> '
                "for every job from the last 30 days.</p>") if app_url else ""
    if explore:
        line = f"Also {explore} new job{'s' if explore != 1 else ''} in Explore (directions you're testing, shown in the app only)."
        app_text += f"\n{line}"
        app_html += f'<p style="font-size:13px">{escape(line)}</p>'

    reminders = reminders or []
    warnings = warnings or []
    control_link = f"{app_url.rstrip('/')}/#control" if app_url else None
    warn_text = "".join(f"[{w['level'].upper()}] {w['area']}: {w['text']}\n" for w in warnings)
    if warn_text:
        warn_text = "App warnings:\n" + warn_text + (f"Control panel: {control_link}\n" if control_link else "") + "\n"
    warn_html = ""
    if warnings:
        warn_html = ('<div style="border:1px solid #cf222e;border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:14px">'
                     '<div style="font-weight:600;margin-bottom:4px">App warnings</div>'
                     + "".join(f'<div><span style="color:{"#cf222e" if w["level"] == "red" else "#9a6700"};font-weight:600">'
                               f'{escape(w["level"].upper())}</span> {escape(w["area"])}: {escape(w["text"])}</div>' for w in warnings)
                     + (f'<div><a href="{escape(control_link)}">Open the control panel</a></div>' if control_link else "")
                     + "</div>")
    apps_link = f"{app_url.rstrip('/')}/#applications" if app_url else None
    rem_text = "".join(f"{r}\n" for r in reminders) + (f"Applications: {apps_link}\n" if reminders and apps_link else "")
    rem_text = f"{rem_text}\n" if rem_text else ""
    rem_html = ""
    if reminders:
        rem_html = ('<div style="background:#fff8c5;border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:14px">'
                    + "".join(f"<div>{escape(r)}</div>" for r in reminders)
                    + (f'<div><a href="{escape(apps_link)}">Open Applications</a></div>' if apps_link else "")
                    + "</div>")

    if not shown:
        text = warn_text + rem_text + "No new postings passed the filters today. That's a normal result." + app_text
        html = f"{warn_html}{rem_html}<p>No new postings passed the filters today. That's a normal result.</p>{app_html}"
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
    text = warn_text + rem_text + "\n\n".join(text_lines) + more + app_text
    more_html = ""
    if hidden:
        more_html = (f'<p>…and <a href="{escape(app_url)}">{hidden} more in the timeline</a>.</p>'
                     if app_url else f"<p>…and {hidden} more.</p>")
    html = (
        '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.4">'
        + warn_html + rem_html
        + f'<ol style="padding-left:20px">{"".join(html_items)}</ol>'
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
