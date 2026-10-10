"""Entry point for the daily run: `python -m pipeline.run [--dry-run] [--preview FILE]`.

Phase 1 sequence (spec 4.3): record run → fetch (each source isolated) →
dedupe → hard filters → details for survivors → write → digest → ping.

Logging rule (spec 12.1): the logs of a public repo are public, so log counts
and source names only, never profile values, posting contents, digest contents
or email text.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
import traceback
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from pipeline.actions import action_links
from pipeline.config import ConfigError, load_profile, load_sources
from pipeline.db import Database
from pipeline.dedupe import apply_dedupe, build_candidates
from pipeline.deliver import send_email
from pipeline.digest import build_digest
from pipeline.filters import HardFilters
from pipeline.models import Candidate, RawPosting
from pipeline.sources.ba import BundesagenturSource

log = logging.getLogger("jobsignal")

UNRANKED_MAX_ITEMS = 30  # Phase 1 has no ranking; Phase 3 switches to feed.max_items


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pipeline.run")
    parser.add_argument("--dry-run", action="store_true", help="write nothing, send nothing")
    parser.add_argument("--preview", type=Path, help="with --dry-run: write the digest HTML to this file (local use only)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    # httpx logs full request URLs at INFO, which include the private search terms.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    try:
        profile = load_profile()
        sources_cfg = load_sources()
    except ConfigError as exc:
        log.error("%s", exc)
        return 1

    db: Database | None = None
    run_id: str | None = None
    try:
        db = Database.from_env()
        if db is None and not args.dry_run:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY must be set for a real run.")
        run_id = db.start_run(dry_run=False) if db and not args.dry_run else None
        stats, digest = run_pipeline(profile, sources_cfg, db, run_id)
        subject, text, html = digest
        if args.dry_run:
            if args.preview:
                args.preview.write_text(html, encoding="utf-8")
                log.info("dry run: digest preview written")
            log.info("dry run: nothing written, nothing sent")
        else:
            send_email(subject, text, html)
            db.mark_surfaced(stats.pop("_surface_ids"), datetime.now(timezone.utc).date())
            db.finish_run(run_id, "success", stats)
            _ping(suffix="")
        stats.pop("_surface_ids", None)
        log.info("run finished: %s", _fmt(stats))
        return 0
    except Exception as exc:  # noqa: BLE001 - the whole point is to catch everything here
        err = f"{type(exc).__name__}: {exc}"
        log.error("run failed: %s", type(exc).__name__)
        if run_id:
            try:
                db.finish_run(run_id, "failed", {}, error=err[:2000])
            except Exception:  # noqa: BLE001
                pass
        if not args.dry_run:
            _alert(err, traceback.format_exc())
            _ping(suffix="/fail")
        return 1


def run_pipeline(profile: dict[str, Any], sources_cfg: dict[str, Any], db: Database | None,
                 run_id: str | None) -> tuple[dict[str, Any], tuple[str, str, str]]:
    """Reads from db when given; writes only when run_id is given (not a dry run)."""
    now = datetime.now(timezone.utc)
    stats: dict[str, Any] = {}

    # 1. fetch, each source isolated (spec 7.1)
    ba_cfg = sources_cfg.get("ba_api", {})
    ba = BundesagenturSource(ba_cfg)
    raws: list[RawPosting] = []
    source_results: list[dict[str, Any]] = []
    failed_sources: list[str] = []
    for source, fetch in ((ba.name, lambda: ba.fetch(profile["search_terms"])),) if ba_cfg.get("enabled", True) else ():
        t0 = time.monotonic()
        try:
            got = fetch()
            raws.extend(got)
            source_results.append({"source": source, "status": "success" if got else "empty",
                                   "fetched": len(got), "error": None, "ms": _ms(t0)})
        except Exception as exc:  # noqa: BLE001
            failed_sources.append(source)
            source_results.append({"source": source, "status": "failed", "fetched": 0,
                                   "error": type(exc).__name__, "ms": _ms(t0)})
            log.warning("source %s failed: %s", source, type(exc).__name__)

    # 2. dedupe
    candidates = build_candidates(raws)
    stored = db.stored_for(candidates) if db else []
    apply_dedupe(candidates, stored, now=now)

    # 3. hard filters
    first_run = not db.has_successful_run() if db else True
    filters = HardFilters(profile, first_run=first_run, now=now)
    filters.apply(candidates)

    # 4. details (description, agency flags) for survivors only
    passed = [c for c in candidates if c.is_new and c.passed]
    cap = int(ba_cfg.get("max_detail_fetches", 150))
    detail_ok = detail_failed = 0
    for c in passed[:cap]:
        if c.raw.source != ba.name:
            continue
        try:
            ba.fetch_details(c.raw)
            detail_ok += 1
        except (httpx.HTTPError, ValueError):
            detail_failed += 1  # posting stays, with description_missing = true
    if filters.exclude_agencies:
        for c in passed:
            if c.raw.poster_type == "agency":
                c.filter_reasons.append("agency")
        passed = [c for c in passed if c.passed]

    # 5. write
    new = [c for c in candidates if c.is_new]
    known_ids = [c.existing_id for c in candidates if c.existing_id]
    repost_ids = [c.repost_of for c in candidates if c.repost_of]
    surface: list[Candidate] = sorted(passed, key=lambda c: (c.raw.posted_date or now.date(), c.raw.title.lower()),
                                      reverse=True)[:UNRANKED_MAX_ITEMS]
    surface_ids: list[str] = []
    if run_id and db:
        ids = db.insert_postings(new)
        db.touch(known_ids)
        db.record_reposts(repost_ids)
        surface_ids = [ids[c.raw.source_job_id or c.dedupe_hash] for c in surface]
        inserted_by_source = Counter(c.raw.source for c in new)
        updated_by_source = Counter(c.raw.source for c in candidates if c.existing_id)
        for r in source_results:
            db.record_source_run(run_id, r["source"], r["status"], r["fetched"],
                                 inserted_by_source[r["source"]], updated_by_source[r["source"]], r["ms"], r["error"])

    # 6. digest
    secret, app_url = os.environ.get("ACTION_LINK_SECRET"), os.environ.get("APP_URL")
    links = [action_links(i, app_url, secret) for i in surface_ids] if secret and app_url and surface_ids else None
    subject, text, html = build_digest([c.raw for c in surface], len(passed), now.date(), links)
    if failed_sources:
        note = f"Note: these sources failed today and were skipped: {', '.join(failed_sources)}."
        text = f"{note}\n\n{text}"
        html = f"<p><em>{note}</em></p>{html}"

    reasons = Counter(r for c in candidates if c.is_new for r in c.filter_reasons[:1])
    stats.update({
        "first_run": first_run,
        "fetched": len(raws),
        "unique": len(candidates),
        "known": len(known_ids),
        "new": len(new),
        "passed": len(passed),
        "surfaced": len(surface),
        "rejected": dict(reasons),
        "details_ok": detail_ok,
        "details_failed": detail_failed,
        "failed_sources": failed_sources,
        "_surface_ids": surface_ids,
    })
    return stats, (subject, text, html)


def _ping(suffix: str) -> None:
    url = os.environ.get("HEALTHCHECK_URL")
    if not url:
        return
    try:
        httpx.get(url.rstrip("/") + suffix, timeout=10)
    except httpx.HTTPError:
        log.warning("healthcheck ping failed")


def _alert(error: str, tb: str) -> None:
    try:
        send_email("jobsignal: daily run FAILED", f"The daily run failed.\n\n{error}\n\n{tb}")
    except Exception:  # noqa: BLE001
        log.warning("failure alert could not be sent")


def _ms(t0: float) -> int:
    return int((time.monotonic() - t0) * 1000)


def _fmt(stats: dict[str, Any]) -> str:
    return ", ".join(f"{k}={v}" for k, v in stats.items())


if __name__ == "__main__":
    sys.exit(main())
