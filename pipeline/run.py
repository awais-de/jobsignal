"""Entry point for the daily run: `python -m pipeline.run [--dry-run] [--preview FILE]`.

Phase 1 sequence (spec 4.3): record run → fetch (each source isolated) →
dedupe → hard filters → details for survivors → write → digest → ping.

Logging rule (spec 12.1): the logs of a public repo are public, so log counts
and source names only, never profile values, posting contents, digest contents
or email text.
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import os
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from typing import Any

import httpx

from pipeline.actions import action_links
from pipeline.config import ConfigError, load_config, load_profile, load_sources, validate_profile
from pipeline import cv_compile, ghost
from pipeline.enrich import Enricher
from pipeline.rank import keyword_overlap, score
from pipeline.skills_db import skills_from_rows
from pipeline.extract.jd import STAGE
from pipeline.llm.router import build_router
from pipeline.db import Database
from pipeline.dedupe import apply_dedupe, build_candidates
from pipeline.deliver import send_email
from pipeline.digest import build_digest, outreach_reminders
from pipeline.filters import HardFilters
from pipeline.models import Candidate, RawPosting
from pipeline.discovery import probe_company, watch_entry
from pipeline.normalize import dedupe_hash, normalize_company
from pipeline.sources.ats import ATS
from pipeline.extract.page import STAGE as PAGE_STAGE, make_page_extractor
from pipeline.sources.arbeitnow import ArbeitnowSource
from pipeline.sources.alerts import StepstoneAlerts
from pipeline.sources.ba import BundesagenturSource
from pipeline.sources.careers import CareersSource

log = logging.getLogger("jobsignal")



def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pipeline.run")
    parser.add_argument("--dry-run", action="store_true", help="write nothing, send nothing")
    parser.add_argument("--preview", type=Path, help="with --dry-run: write the digest HTML to this file (local use only)")
    parser.add_argument("--backlog-only", action="store_true",
                        help="only extract and rank stored postings that are still pending; no fetch, no email")
    parser.add_argument("--fast", action="store_true",
                        help="the fast lane: quick sources and group-A career sites, an instant email with what's new")
    parser.add_argument("--discovery-sweep", action="store_true",
                        help="one-off: check every relevant company (groups A and B) for a readable career site")
    parser.add_argument("--rerank-only", action="store_true",
                        help="only re-rank stored jobs after a profile change; no fetch, no email")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    # httpx logs full request URLs at INFO, which include the private search terms.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    try:
        sources_cfg = load_sources()
        profile = _load_profile(Database.from_env())
    except ConfigError as exc:
        log.error("%s", exc)
        return 1

    if args.discovery_sweep:
        return discovery_sweep()
    if args.rerank_only:
        db = Database.from_env()
        if db is None:
            log.error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set.")
            return 1
        enricher = _enricher(profile, db)
        now = datetime.now(timezone.utc)
        log.info("refiltered: %d, reranked: %d", _refilter(db, profile, sources_cfg, now),
                 _rerank(db, enricher, profile, now))
        ghosts = _optional("ghost", lambda: _ghost(db, sources_cfg, now))
        if isinstance(ghosts, dict):
            log.info("ghost buckets: %s", dict(Counter(b for b, _ in ghosts.values())))
        return 0
    if args.backlog_only:
        return backlog_only(profile, write=not args.dry_run)

    db: Database | None = None
    run_id: str | None = None
    try:
        db = Database.from_env()
        if db is None and not args.dry_run:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY must be set for a real run.")
        # Several scheduled starts (Supabase's cron on time, GitHub's crons as a late fallback): only the
        # first that gets to run does the work. Manual runs (Run now) always proceed.
        scheduled = os.environ.get("GITHUB_EVENT_NAME") == "schedule" or os.environ.get("SCHEDULED_RUN") == "true"
        if db and not args.dry_run and scheduled and not args.fast:
            start_of_day = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
            if db.has_successful_run_since(start_of_day):
                log.info("today's run already succeeded; nothing to do")
                _ping(suffix="")
                return 0
        # The fast lane and the daily run never write at the same time: a fast run skips while the daily
        # run is going; the daily run waits (up to 10 min) for a fast run to finish.
        if db and not args.dry_run and args.fast and db.run_in_progress("daily", 90):
            log.info("the daily run is going; the fast lane skips this round")
            return 0
        if db and not args.dry_run and not args.fast:
            for _ in range(20):
                if not db.run_in_progress("fast", 20):
                    break
                time.sleep(30)
        run_id = db.start_run(dry_run=False, kind="fast" if args.fast else "daily") if db and not args.dry_run else None
        stats, digest = run_pipeline(profile, sources_cfg, db, run_id, fast=args.fast)
        subject, text, html = digest
        if args.dry_run:
            if args.preview:
                args.preview.write_text(html, encoding="utf-8")
                log.info("dry run: digest preview written")
            log.info("dry run: nothing written, nothing sent")
        elif args.fast:
            ids = stats.pop("_surface_ids")
            if ids:
                send_email(subject, text, html)
                db.mark_notified(ids)
            db.finish_run(run_id, "success", stats)
        else:
            send_email(subject, text, html)
            db.mark_surfaced(stats.pop("_surface_ids"), datetime.now(timezone.utc).date())
            db.finish_run(run_id, "success", stats)
            _ping(suffix="")
        stats.pop("_surface_ids", None)
        log.info("run finished: %s", _fmt(stats))
        return 0
    except Exception as exc:  # noqa: BLE001 - the whole point is to catch everything here
        # The private run record keeps where it failed (the public log only the exception's name).
        frames = traceback.extract_tb(exc.__traceback__)
        where = " < ".join(f"{f.name}:{f.lineno}" for f in reversed(frames[-4:]))
        err = f"{type(exc).__name__}: {exc} [at {where}]"
        log.error("run failed: %s", type(exc).__name__)
        if run_id:
            try:
                db.finish_run(run_id, "failed", {}, error=err[:2000])
            except Exception:  # noqa: BLE001
                pass
        # The fast lane retries in 30 minutes: no alert email or failed ping for it (it would flood the inbox).
        if not args.dry_run and not args.fast:
            _alert(err, traceback.format_exc())
            _ping(suffix="/fail")
        return 1


def run_pipeline(profile: dict[str, Any], sources_cfg: dict[str, Any], db: Database | None,
                 run_id: str | None, fast: bool = False) -> tuple[dict[str, Any], tuple[str, str, str]]:
    """Reads from db when given; writes only when run_id is given (not a dry run).

    `fast` (the fast lane, every 30 min; owner request 2026-10-21): only the quick sources (Arbeitsagentur
    published today, Arbeitnow, StepStone alerts, group-A career sites), no backlog or housekeeping, and an
    instant email with what's new instead of the digest (none when nothing is)."""
    now = datetime.now(timezone.utc)
    stats: dict[str, Any] = {}
    t_phase = time.monotonic()

    # 1. fetch, each source isolated (spec 7.1)
    ba_cfg = sources_cfg.get("ba_api", {})
    if fast:
        fast_cfg = sources_cfg.get("fast_lane", {})
        ba_cfg = {**ba_cfg, "published_within_days": int(fast_cfg.get("ba_published_within_days", 1)),
                  "max_pages_per_term": int(fast_cfg.get("ba_max_pages_per_term", 2)),
                  "max_detail_fetches": int(fast_cfg.get("max_detail_fetches", 40))}
    ba = BundesagenturSource(ba_cfg)
    raws: list[RawPosting] = []
    source_results: list[dict[str, Any]] = []
    failed_sources: list[str] = []
    fetchers: list[tuple[str, str, Any]] = []        # (source key for DB, label for public logs, fetch)
    if ba_cfg.get("enabled", True):
        fetchers.append((ba.name, ba.name, lambda: ba.fetch(profile["search_terms"])))
    # Arbeitsagentur employer watch: group-A companies whose career site can't be read (owner request 2026-10-21).
    employer_watch: dict[str, Any] = {}
    if db and ba_cfg.get("enabled", True) and sources_cfg.get("ba_employer_watch", {}).get("enabled", True):
        watch_rows = _optional("ba employer list", lambda: db.ba_watch_companies(all_unreadable=not fast))
        if isinstance(watch_rows, list) and watch_rows:
            def employers() -> list[RawPosting]:
                got, totals = ba.fetch_employers([r["name"] for r in watch_rows], 1 if fast else 2)
                employer_watch["totals"] = totals
                return got
            fetchers.append(("ba_api:employers", "ba_api:employers", employers))
            employer_watch["rows"] = watch_rows
    an_cfg = sources_cfg.get("arbeitnow", {})
    if an_cfg.get("enabled", False):
        arbeitnow = ArbeitnowSource(an_cfg)
        fetchers.append((arbeitnow.name, arbeitnow.name, lambda: arbeitnow.fetch(now)))
    # Company watchlist (private profile): one isolated source per company.
    llm_cfg = load_config("llm.yaml")
    page_router = build_router(llm_cfg, PAGE_STAGE, cache_get=db.cache_get if db else None)
    # Watchlist = the owner's list (private profile) + companies found by discovery (spec 7.2).
    watchlist = list(profile.get("watchlist") or [])
    disc_cfg = sources_cfg.get("discovery", {})
    if db and disc_cfg.get("enabled"):
        named = {w["name"].lower() for w in watchlist}
        # By relevance group (owner decision 2026-10-21): A (and new, not yet grouped) daily, B weekly (each on
        # its own weekday), C and agencies never; a career page added by hand is read daily.
        weekday = now.weekday()
        due = lambda c: (c.get("manually_edited") or c.get("tier") in (None, "A")  # noqa: E731
                         or (not fast and c.get("tier") == "B" and int(hashlib.md5(c["id"].encode()).hexdigest(), 16) % 7 == weekday))
        watchlist += [watch_entry(c) for c in db.watched_companies() if c["name"].lower() not in named and due(c)]
    careers_cfg = dict(sources_cfg.get("careers", {}))
    if fast:
        for k in ("max_new_pages_per_company", "company_time_budget_seconds"):
            if k in sources_cfg.get("fast_lane", {}):
                careers_cfg[k] = sources_cfg["fast_lane"][k]
    careers = CareersSource(
        watchlist, {**careers_cfg, "search_terms": profile["search_terms"],
                    "title_allow": profile["titles"].get("allow", [])},
        known_ids=(lambda ids: db.known_ids("careers", ids)) if db else (lambda ids: set()),
        page_extractor=make_page_extractor(page_router, llm_cfg["stages"][PAGE_STAGE]),
    )
    # Job-alert emails (spec 7.1 tier 5): StepStone's job agent, parsed from the stored emails.
    alerts = StepstoneAlerts(db, now - timedelta(days=14)) if db and sources_cfg.get("alerts", {}).get("stepstone", True) else None
    if alerts:
        fetchers.append((alerts.name, alerts.name, alerts.fetch))
    # The fast lane skips a career site whose last 3 tries failed (2026-10-21: a site down for hours cost
    # ~60 s of timeouts every half hour); the daily run still tries it, and a success there brings it back.
    failing = _optional("failing sources", lambda: db.failing_sources("careers:")) if db and fast else None
    if isinstance(failing, set) and failing:
        before = len(watchlist)
        watchlist = [c for c in watchlist if f"careers:{c['name']}" not in failing]
        stats["skipped_failing"] = before - len(watchlist)
        log.info("fast lane: %d career site(s) skipped after 3 failed runs", before - len(watchlist))
    for i, company in enumerate(watchlist, 1):
        # Company names are private: the public log only says 'careers#N'.
        fetchers.append((f"careers:{company['name']}", f"careers#{i}", lambda c=company: careers.fetch_company(c)))

    def run_fetch(item: tuple[str, str, Any]) -> tuple[list[RawPosting], dict[str, Any], str | None]:
        source, label, fetch = item
        t0 = time.monotonic()
        try:
            got = fetch()
            return got, {"source": source, "status": "success" if got else "empty", "fetched": len(got),
                         "error": None, "ms": _ms(t0)}, None
        except Exception as exc:  # noqa: BLE001
            log.warning("source %s failed: %s", label, type(exc).__name__)
            return [], {"source": source, "status": "failed", "fetched": 0, "error": type(exc).__name__, "ms": _ms(t0)}, label

    # Sources are many and slow (career sites ~4 s each): fetched 8 at a time, the big feeds started first so
    # they run alongside the career sites. Results keep the fetchers' order, so the run is deterministic.
    with ThreadPoolExecutor(max_workers=int(sources_cfg.get("careers", {}).get("parallel", 8))) as pool:
        results = list(pool.map(run_fetch, fetchers))
    for (_, label, _), (got, result, failed) in zip(fetchers, results):
        raws.extend(got)
        source_results.append(result)
        if failed:
            failed_sources.append(failed)
        if result["ms"] > 60_000:
            log.info("slow source %s: %.0f s", label, result["ms"] / 1000)

    # Alert emails don't say who posts: recruiters from the agency list are marked (ghost signal, badge).
    agencies = [x.lower() for x in (sources_cfg.get("discovery") or {}).get("agencies", [])]
    for r in raws:
        if r.source.startswith("alert") and r.poster_type is None and any(x in r.company_name.lower() for x in agencies):
            r.poster_type = "agency"

    _phase("fetch", t_phase); t_phase = time.monotonic()
    # 2. dedupe (hand-added postings first get their real hash, so a job applied to by hand
    #    isn't surfaced again when a source lists it)
    if run_id and db:
        for r in db.manual_postings_without_hash():
            db.update_posting(r["id"], {"dedupe_hash": dedupe_hash(r["company_name"], r["title"], r["city"])})
    candidates = build_candidates(raws)
    stored = db.stored_for(candidates) if db else []
    merge = apply_dedupe(candidates, stored, now=now)
    # A better source without a description takes the weaker stored copy's (spec 7.3.2).
    if merge.inherit and db:
        texts = db.descriptions([sid for _, sid in merge.inherit])
        for c, sid in merge.inherit:
            c.raw.description = c.raw.description or texts.get(sid)
    # A better source for a job we already have (e.g. the employer's listing of a StepStone alert job) isn't
    # stale just because it arrived in that company's first load: the job was already new to us.
    for c in candidates:
        if c.supersedes:
            c.raw.source_data["known_fresh"] = True
    # Known watchlist pages arrive as stubs (not refetched); they only refresh last_seen_at.
    candidates = [c for c in candidates if not (c.raw.source_data.get("stub") and c.is_new)]

    _phase("dedupe", t_phase); t_phase = time.monotonic()
    # 3. hard filters
    first_run = not db.has_successful_run() if db else True
    filters = HardFilters(profile, first_run=first_run, now=now)
    filters.apply(candidates)

    _phase("filters", t_phase); t_phase = time.monotonic()
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

    _phase("details", t_phase); t_phase = time.monotonic()
    # 5. extraction, dealbreakers, ranking (spec 7.5, 7.9). New postings first, then the backlog.
    #    Explore-lane jobs get a smaller budget: those mentioning most of the owner's skills first;
    #    the rest stay pending and the backlog picks them up on later runs.
    enricher = _enricher(profile, db)
    explore = sorted((c for c in passed if c.lane == "explore"),
                     key=lambda c: keyword_overlap(c.raw.description, enricher.index), reverse=True)
    explore_cap = int(load_config("llm.yaml")["stages"][STAGE].get("explore_per_run", 20))
    to_extract = [c for c in passed if c.lane != "explore"] + explore[:explore_cap]
    # The fast lane must finish in minutes (free-tier AI does ~4 analyses a minute): a few core jobs, no explore;
    # the rest are saved as pending and the daily run's backlog analyses them.
    extract_deadline = None
    if fast:
        fast_cfg = sources_cfg.get("fast_lane", {})
        to_extract = [c for c in passed if c.lane != "explore"][: int(fast_cfg.get("max_extractions", 12))]
        extract_deadline = time.monotonic() + float(fast_cfg.get("max_extraction_seconds", 300))
    for c in to_extract:
        if extract_deadline and time.monotonic() > extract_deadline:
            break
        cols, reason = enricher.run(c.raw.title, c.raw.description, source_contract=c.raw.contract_type,
                                    remote_policy=c.raw.remote_policy, salary_text=c.raw.salary_text,
                                    unfiltered=c.raw.source_data.get("filter_mode") == "none")
        c.enrichment = cols
        c.raw.remote_policy = cols.get("remote_policy", c.raw.remote_policy)
        c.raw.salary_text = cols.get("salary_text", c.raw.salary_text)
        if reason and c.raw.source_data.get("filter_mode") != "none":
            c.filter_reasons.append(reason)
    dealbroken = Counter(c.filter_reasons[0] for c in passed if not c.passed)
    passed = [c for c in passed if c.passed]
    backlog = _process_backlog(enricher, db, write=bool(run_id), now=now) if db and not fast else {}

    _phase("analysis", t_phase); t_phase = time.monotonic()
    # 6. write
    new = [c for c in candidates if c.is_new]
    known_ids = [c.existing_id for c in candidates if c.existing_id]
    repost_ids = [c.repost_of for c in candidates if c.repost_of]
    # Ranked first (highest score), then unranked newest-first (spec 7.9).
    surface: list[Candidate] = sorted(
        passed,
        key=lambda c: (c.enrichment.get("rank_score") is not None, c.enrichment.get("rank_score") or 0,
                       c.raw.posted_date or now.date()),
        reverse=True,
    )
    # A watched company's first load goes to the app timeline, not the email (owner decision 2026-10-11).
    # Explore-lane jobs are only shown in the app (owner decision 2026-10-12).
    surface = [c for c in surface if c.lane == "core" and not c.raw.source_data.get("initial_load")
               and not c.raw.source_data.get("no_digest")]           # superseded copy was already emailed
    min_score = float(profile["feed"].get("min_rank_score", 0))
    surface = [c for c in surface if (c.enrichment.get("rank_score") or 0) >= min_score
               or c.enrichment.get("rank_score") is None][: int(profile["feed"].get("max_items", 10))]
    surface_ids: list[str] = []
    if run_id and db:
        ids = db.insert_postings(new)
        db.touch(known_ids)
        db.record_reposts(repost_ids)
        if alerts:
            _optional("alerts parsed", alerts.mark_parsed)
        if not fast and employer_watch.get("totals") is not None:
            totals = employer_watch["totals"]
            rows = employer_watch["rows"]
            _optional("ba employer flags", lambda: db.set_ba_watch([r["id"] for r in rows if totals.get(r["name"], 0) > 0],
                                                                    [r["id"] for r in rows if totals.get(r["name"], 0) == 0
                                                                     and r["name"] in totals], now))
        # Cross-source merging (spec 7.3.2): retire weaker copies only for rows that passed.
        db.supersede([sid for c in passed for sid in c.supersedes])
        for sid, text in merge.enrich:
            db.add_description(sid, text)
        surface_ids = [ids[c.raw.source_job_id or c.dedupe_hash] for c in surface]
        key = lambda c: (f"careers:{c.raw.company_name}" if c.raw.source == "careers" else c.raw.source)  # noqa: E731
        inserted_by_source = Counter(key(c) for c in new)
        updated_by_source = Counter(key(c) for c in candidates if c.existing_id)
        for r in source_results:
            db.record_source_run(run_id, r["source"], r["status"], r["fetched"],
                                 inserted_by_source[r["source"]], updated_by_source[r["source"]], r["ms"], r["error"])
        _flush_llm(enricher, db)
        _flush_router(page_router, db, PAGE_STAGE)
        # Housekeeping after the jobs are saved: a failure here is logged and skipped, it never costs
        # the digest (2026-10-12: one malformed company domain failed the whole run). Not in the fast lane.
    if run_id and db and not fast:
        if disc_cfg.get("enabled"):
            stats["discovery"] = _optional("discovery", lambda: _discover(db, candidates, disc_cfg, now))
        stats["refiltered"] = _optional("refilter", lambda: _refilter(db, profile, sources_cfg, now))
        stats["reranked"] = _rerank(db, enricher, profile, now)
        # Ghost score (spec 7.8): every passed job still in view, recomputed daily (age grows).
        ghosts = _optional("ghost", lambda: _ghost(db, sources_cfg, now))
        if isinstance(ghosts, dict):
            stats["ghost"] = dict(Counter(b for b, _ in ghosts.values()))
            for c, sid in zip(surface, surface_ids):
                if sid in ghosts:
                    c.enrichment["ghost_bucket"], c.enrichment["ghost_reasons"] = ghosts[sid]
        # Auto-expiry of silent applications (spec 4.3 step 7, 10.6)
        tracking = load_config("tracking.yaml")
        stats["expired_applications"] = db.expire_stale_applications(int(tracking.get("auto_expiry_days", 30)))
        # CV previews (owner decision 2026-10-19): unsaved compiles go after 30 days.
        stats["cv_previews_pruned"] = _optional("cv previews", lambda: cv_compile.prune_stale(30))
        # Retention (spec 13): email bodies are kept for 12 months.
        stats["purged_email_bodies"] = db.purge_old_email_bodies(int(tracking.get("email_body_retention_months", 12)))

    _phase("write", t_phase); t_phase = time.monotonic()
    # 7. digest (the fast lane: an instant email with what's new, nothing when nothing is)
    secret, app_url = os.environ.get("ACTION_LINK_SECRET"), os.environ.get("APP_URL")
    links = [action_links(i, app_url, secret) for i in surface_ids] if secret and app_url and surface_ids else None
    if fast:
        subject, text, html = build_digest([c.raw for c in surface], len(surface), now.date(), links, app_url,
                                           extras=[c.enrichment for c in surface], instant=True)
        stats.update({"fetched": len(raws), "new": len(new), "passed": len(passed), "alerted": len(surface),
                      "llm_calls": enricher.router.calls, "failed_sources": failed_sources, "_surface_ids": surface_ids})
        return stats, (subject, text, html)
    reminders = _reminders(db, now) if db else []
    warnings_list = _optional("control warnings", lambda: db.control_warnings()) if db else None
    warnings_list = warnings_list if isinstance(warnings_list, list) else []
    stats["control_warnings"] = len(warnings_list)
    stats["outreach_reminders"] = len(reminders)
    # The count in the email matches the feed's timeline: core jobs; explore jobs get their own line.
    n_explore = sum(c.lane == "explore" for c in passed)
    # Jobs the fast lane already sent as instant alerts (they're known by now, so not new in this run).
    alerted = _optional("alerted count", lambda: db.notified_since(now - timedelta(hours=24))) if db else 0
    stats["already_alerted"] = alerted if isinstance(alerted, int) else 0
    subject, text, html = build_digest([c.raw for c in surface], len(passed) - n_explore, now.date(), links, app_url,
                                       extras=[c.enrichment for c in surface], reminders=reminders,
                                       explore=n_explore, warnings=warnings_list, already_alerted=stats["already_alerted"])
    if failed_sources:
        note = f"Note: these sources failed today and were skipped: {', '.join(failed_sources)}."
        text = f"{note}\n\n{text}"
        html = f"<p><em>{note}</em></p>{html}"

    reasons = Counter(r for c in candidates if c.is_new for r in c.filter_reasons[:1])
    extraction = Counter(c.enrichment.get("extraction_status", "none") for c in candidates
                         if c.is_new and c.enrichment)
    stats.update({
        "extraction": dict(extraction),
        "dealbreakers": dict(dealbroken),
        "backlog": backlog,
        "llm_calls": enricher.router.calls,
        "llm_saved_by_code": enricher.skipped_by_code,
        "first_run": first_run,
        "fetched": len(raws),
        "unique": len(candidates),
        "known": len(known_ids),
        "new": len(new),
        "passed": len(passed),
        "passed_explore": sum(c.lane == "explore" for c in passed),
        "surfaced": len(surface),
        "rejected": dict(reasons),
        "details_ok": detail_ok,
        "details_failed": detail_failed,
        "failed_sources": failed_sources,
        "_surface_ids": surface_ids,
    })
    return stats, (subject, text, html)


BACKLOG_DAYS = 7      # older postings that never got extracted stay unranked
BACKLOG_LIMIT = 60


def _enricher(profile: dict[str, Any], db: Database | None) -> Enricher:
    llm_cfg = load_config("llm.yaml")
    router = build_router(llm_cfg, STAGE, cache_get=db.cache_get if db else None)
    return Enricher(profile, llm_cfg, load_config("scoring.yaml"), router)


def _process_backlog(enricher: Enricher, db: Database, write: bool, now: datetime) -> dict[str, int]:
    """Extract and rank passed postings from earlier runs that are still pending or failed."""
    if enricher.router.exhausted:
        return {}
    rows = db.pending_extractions(now - timedelta(days=BACKLOG_DAYS), BACKLOG_LIMIT * 3)
    # Same order as new jobs: core first (newest first), then explore jobs mentioning most of the
    # owner's skills. Nothing is skipped; the order only decides who goes first when the budget is short.
    core = [r for r in rows if r.get("lane") != "explore"]
    explore = sorted((r for r in rows if r.get("lane") == "explore"),
                     key=lambda r: keyword_overlap(r["description"], enricher.index), reverse=True)
    rows = (core + explore)[:BACKLOG_LIMIT]
    counts: Counter[str] = Counter()
    for r in rows:
        if enricher.router.exhausted:
            break
        cols, reason = enricher.run(r["title"], r["description"], source_contract=r["contract_type"],
                                    remote_policy=r["remote_policy"], salary_text=r["salary_text"],
                                    unfiltered=(r.get("source_data") or {}).get("filter_mode") == "none")
        if reason and (r.get("source_data") or {}).get("filter_mode") != "none":
            cols.update(filter_status="rejected", filter_reasons=[reason])
        else:
            reason = None
        counts["rejected" if reason else cols["extraction_status"]] += 1
        if write:
            db.update_posting(r["id"], cols)
    return dict(counts)


def backlog_only(profile: dict[str, Any], write: bool) -> int:
    db = Database.from_env()
    if db is None:
        log.error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set.")
        return 1
    enricher = _enricher(profile, db)
    counts = _process_backlog(enricher, db, write=write, now=datetime.now(timezone.utc))
    if write:
        _flush_llm(enricher, db)
    errors = Counter(u["error"] for u in enricher.router.usage if u["error"])
    log.info("backlog: %s, llm_calls=%d, llm_errors=%s", counts, enricher.router.calls, dict(errors))
    return 0


def _load_profile(db: Database | None) -> dict[str, Any]:
    """The profile edited in the app (database) wins; PROFILE_YAML / profile.yaml are the fallback."""
    if db:
        try:
            row = db.owner_profile()
        except Exception:  # noqa: BLE001 - fall back rather than fail the run
            row = None
            log.warning("profile: database unavailable, using the fallback")
        if row:
            profile = validate_profile(row[0], "the app")
            profile["_version"] = row[1]
            log.info("profile: from the app (version %d)", row[1])
            _skills_from_db(db, profile)
            return profile
    profile = load_profile()
    profile["_version"] = 0
    return profile


def _skills_from_db(db: Database, profile: dict[str, Any]) -> None:
    """The skills database is the source of the owner's skills; the profile's list is the fallback. The
    version becomes '<profile version>.<skills stamp>' so a skills change re-ranks every job."""
    try:
        skills, stamp = skills_from_rows(db.ranking_skills())
    except Exception:  # noqa: BLE001 - fall back to the profile's list rather than fail the run
        log.warning("skills: database unavailable, using the profile's list")
        return
    if not skills:
        return
    profile["skills"] = skills
    profile["_version"] = f"{profile['_version']}.{stamp}"
    # (not "skills: …": GitHub masks that, it is a line of the PROFILE_YAML secret)
    log.info("skill list from the skills database: %d skills", sum(len(v) for v in skills.values()))


def _rerank(db: Database, enricher: Enricher, profile: dict[str, Any], now: datetime) -> int:
    """After a profile change, re-rank stored jobs of the last 30 days from their stored skills
    (no LLM calls: extraction results are already in the row)."""
    version = profile.get("_version")
    changed = 0
    for r in db.postings_to_rerank(now - timedelta(days=30)):
        if (r.get("rank_details") or {}).get("ranked_with") == version:
            continue
        fit, rank, details = score(r, r.get("remote_policy"), enricher.index, profile, enricher.weights)
        details["ranked_with"] = version
        db.update_posting(r["id"], {"fit_score": fit, "rank_score": rank, "rank_details": details})
        changed += 1
    return changed


def _ghost(db: Database, sources_cfg: dict[str, Any], now: datetime) -> dict[str, tuple[str, list[str]]]:
    """Scores and stores the ghost bucket of passed jobs seen in the last 45 days; returns {id: (bucket, reasons)}."""
    weights = load_config("scoring.yaml").get("ghost") or {}
    agencies = [a.lower() for a in (sources_cfg.get("discovery") or {}).get("agencies", [])]
    targets = db.ghost_targets(now - timedelta(days=45))
    ctx = db.ghost_context([t["id"] for t in targets])
    out: dict[str, tuple[str, list[str]]] = {}
    rows = []
    for t in targets:
        total, bucket, signals = ghost.score(t, ctx.get(t["id"], {}), weights, agencies, now.date())
        rows.append({"id": t["id"], "ghost_score": total, "ghost_bucket": bucket, "ghost_signals": signals})
        out[t["id"]] = (bucket, ghost.reasons(signals))
    db.set_ghost_scores(rows)
    return out


def _phase(name: str, since: float) -> None:
    """Phase durations in the public log (counts and seconds only)."""
    log.info("phase %s: %.0f s", name, time.monotonic() - since)


def _optional(step: str, fn):
    """Run a non-essential step; on any error log its type (no details: public logs) and go on."""
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001
        log.warning("%s skipped after an error: %s", step, type(exc).__name__)
        return {"error": type(exc).__name__}


REFILTER_DAYS = 14
REFILTER_DETAIL_CAP = 40


def _refilter(db: Database, profile: dict[str, Any], sources_cfg: dict[str, Any], now: datetime) -> int:
    """After the title families change, jobs of the last two weeks that failed only on the title are
    checked again; those that now pass become pending (the backlog analyses them). Arbeitsagentur rows
    never had their description fetched, so it is fetched now (capped)."""
    ba = BundesagenturSource(sources_cfg.get("ba_api", {}))
    filters = HardFilters(profile, first_run=False, now=now)
    details = changed = 0
    for r in db.title_rejected_since(now - timedelta(days=REFILTER_DAYS)):
        raw = RawPosting(source=r["source"], source_job_id=r["source_job_id"], company_name=r["company_name"],
                         title=r["title"], country=r["country"], contract_type=r["contract_type"],
                         posted_date=date.fromisoformat(r["posted_date"]) if r["posted_date"] else None,
                         poster_type=r["poster_type"], source_data=r["source_data"] or {})
        c = Candidate(raw=raw, dedupe_hash="")
        # Judged as on the day it was found (freshness then, not now).
        filters.now = _ts(r["first_seen_at"])
        if filters.reason(c):
            continue
        fields: dict[str, Any] = {"filter_status": "passed", "filter_reasons": None, "title_family": c.title_family,
                                  "lane": c.lane, "extraction_status": "pending"}
        if r["source"] == ba.name and r["description_missing"] and details < REFILTER_DETAIL_CAP:
            try:
                ba.fetch_details(raw)
                details += 1
                fields.update(description=raw.description, description_missing=raw.description is None,
                              poster_type=raw.poster_type, source_data=raw.source_data)
                if raw.apply_url:
                    fields["apply_url"] = raw.apply_url
            except (httpx.HTTPError, ValueError):
                pass
        db.update_posting(r["id"], fields)
        changed += 1
    return changed


def _ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _discover(db: Database, candidates: list[Candidate], cfg: dict[str, Any], now: datetime) -> dict[str, int]:
    """Register employers seen with a job in Germany, then probe a few for an ATS (spec 7.2)."""
    agencies = [a.lower() for a in cfg.get("agencies", [])]
    is_agency = lambda name, poster: poster == "agency" or any(a in name.lower() for a in agencies)  # noqa: E731
    counts: Counter[str] = Counter()

    def rows_from(items):
        rows: dict[str, dict[str, Any]] = {}
        for name, source, country, passed, poster in items:
            norm = normalize_company(name or "")
            if not norm or country != "DE":
                continue
            r = rows.setdefault(norm, {"name": name, "name_normalized": norm, "discovered_from": source,
                                       "is_agency": is_agency(name, poster), "relevant": False})
            r["relevant"] = r["relevant"] or passed
            if r["is_agency"]:
                r["discovery_status"] = "skipped"
        # PostgREST bulk inserts need identical keys in every row
        for r in rows.values():
            r.setdefault("discovery_status", "pending")
        return list(rows.values())

    if db.company_count() == 0:                       # one-off seed from everything stored so far
        seed = db.all_postings_for_seed()
        db.register_companies(rows_from((r["company_name"], r["source"], r["country"], r["filter_status"] == "passed",
                                         r["poster_type"]) for r in seed))
        counts["seeded_from_postings"] = len(seed)
    db.register_companies(rows_from((c.raw.company_name, c.raw.source, c.raw.country, c.passed, c.raw.poster_type)
                                    for c in candidates if c.is_new and not c.raw.source_data.get("stub")))
    # Alert jobs without a description: their employers are probed first (owner request 2026-10-20).
    db.prioritise_companies([normalize_company(c.raw.company_name) for c in candidates
                             if c.is_new and c.passed and c.raw.source.startswith("alert") and not c.raw.description])

    # Relevance groups first (owner decision 2026-10-21): only groups A and B are probed.
    db.mark_agencies(agencies)
    counts.update({f"tier_changed_{k}": v for k, v in (db.score_companies() or {}).items()})
    comps = db.companies_to_probe(int(cfg.get("companies_per_run", 20)), now)
    counts.update(_probe_companies(db, comps, cfg, float(cfg.get("max_seconds_per_run", 300)),
                                   int(cfg.get("parallel", 4))))
    return dict(counts)


def _probe_companies(db: Database, comps: list[dict[str, Any]], cfg: dict[str, Any], seconds: float,
                     workers: int) -> Counter[str]:
    """Probes companies for a readable career site, `workers` at a time, until `seconds` have passed."""
    counts: Counter[str] = Counter()
    lock = threading.Lock()
    api = ATS(httpx.Client(headers={"User-Agent": "jobsignal/0.1 (personal job search)"}, timeout=6,
                           follow_redirects=True, limits=httpx.Limits(max_connections=workers * 12)))
    deadline = time.monotonic() + seconds
    retry_days = int(cfg.get("retry_not_found_days", 30))

    def probe(comp: dict[str, Any]) -> None:
        if time.monotonic() > deadline:
            with lock:
                counts["left_for_later"] += 1
            return
        now = datetime.now(timezone.utc)
        try:
            found = probe_company(comp["name"], api)
        except Exception:  # noqa: BLE001 - one odd company must not stop discovery (or the run)
            found = None
            with lock:
                counts["errors"] += 1
        if found:
            fields = {"discovery_status": "found", "ats": found.ats, "ats_token": found.token,
                      "verified_name": found.verified_name, "careers_url": found.careers_url,
                      "feed_type": "jsonld" if found.ats in ("jsonld", "sitemap") else "ats_feed",
                      "watch": True, "discovery_checked_at": now.isoformat(), "notes": f"found via {found.via}"}
            key = f"found_via_{found.via}"
        else:
            fields = {"discovery_status": "not_found", "discovery_checked_at": now.isoformat(),
                      "next_check_at": (now + timedelta(days=retry_days)).isoformat()}
            key = "not_found"
        # A slow database write is retried once; if it still fails the company stays unchecked for the next
        # run (2026-10-21: one write timeout stopped the whole sweep).
        for attempt in (1, 2):
            try:
                db.update_company(comp["id"], fields)
                break
            except Exception:  # noqa: BLE001
                if attempt == 2:
                    key = "write_errors"
                else:
                    time.sleep(2)
        with lock:
            counts[key] += 1

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(probe, comps))
    return counts


def discovery_sweep(minutes: float = 45, workers: int = 8) -> int:
    """One-off: probe every group A and B company not checked yet (owner request 2026-10-21)."""
    db = Database.from_env()
    if db is None:
        log.error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set.")
        return 1
    cfg = load_sources().get("discovery", {})
    db.mark_agencies([a.lower() for a in cfg.get("agencies", [])])
    log.info("tiers changed: %s", db.score_companies())
    comps = db.companies_to_probe(5000, datetime.now(timezone.utc))
    log.info("sweep: %d companies to check, %d at a time", len(comps), workers)
    counts = _probe_companies(db, comps, cfg, minutes * 60, workers)
    log.info("sweep done: %s", dict(counts))
    return 0


def _flush_llm(enricher: Enricher, db: Database) -> None:
    _flush_router(enricher.router, db, STAGE)


def _flush_router(router, db: Database, stage: str) -> None:
    if router.new_cache:
        db.cache_put(router.new_cache, stage)
    if router.usage:
        db.record_llm_usage(router.usage)


def _reminders(db: Database, now: datetime) -> list[str]:
    """Outreach reminders for the digest; never fails the run (the digest goes out without them)."""
    try:
        today = now.astimezone(ZoneInfo("Europe/Berlin")).date()
        return outreach_reminders(*db.outreach_rows(today - timedelta(days=14)), today)
    except Exception:  # noqa: BLE001
        log.warning("outreach reminders skipped")
        return []


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
