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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

from pipeline.actions import action_links
from pipeline.config import ConfigError, load_config, load_profile, load_sources, validate_profile
from pipeline.enrich import Enricher
from pipeline.rank import score
from pipeline.extract.jd import STAGE
from pipeline.llm.router import build_router
from pipeline.db import Database
from pipeline.dedupe import apply_dedupe, build_candidates
from pipeline.deliver import send_email
from pipeline.digest import build_digest
from pipeline.filters import HardFilters
from pipeline.models import Candidate, RawPosting
from pipeline.discovery import probe_company, watch_entry
from pipeline.normalize import dedupe_hash, normalize_company
from pipeline.sources.ats import ATS
from pipeline.extract.page import STAGE as PAGE_STAGE, make_page_extractor
from pipeline.sources.arbeitnow import ArbeitnowSource
from pipeline.sources.ba import BundesagenturSource
from pipeline.sources.careers import CareersSource

log = logging.getLogger("jobsignal")



def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pipeline.run")
    parser.add_argument("--dry-run", action="store_true", help="write nothing, send nothing")
    parser.add_argument("--preview", type=Path, help="with --dry-run: write the digest HTML to this file (local use only)")
    parser.add_argument("--backlog-only", action="store_true",
                        help="only extract and rank stored postings that are still pending; no fetch, no email")
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

    if args.backlog_only:
        return backlog_only(profile, write=not args.dry_run)

    db: Database | None = None
    run_id: str | None = None
    try:
        db = Database.from_env()
        if db is None and not args.dry_run:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY must be set for a real run.")
        # GitHub drops scheduled runs at times, so the workflow has several morning crons;
        # only the first one that gets to run does the work (manual runs always proceed).
        if db and not args.dry_run and os.environ.get("GITHUB_EVENT_NAME") == "schedule":
            start_of_day = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
            if db.has_successful_run_since(start_of_day):
                log.info("today's run already succeeded; nothing to do")
                _ping(suffix="")
                return 0
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
    fetchers: list[tuple[str, str, Any]] = []        # (source key for DB, label for public logs, fetch)
    if ba_cfg.get("enabled", True):
        fetchers.append((ba.name, ba.name, lambda: ba.fetch(profile["search_terms"])))
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
        watchlist += [watch_entry(c) for c in db.watched_companies() if c["name"].lower() not in named]
    careers = CareersSource(
        watchlist, {**sources_cfg.get("careers", {}), "search_terms": profile["search_terms"],
                    "title_allow": profile["titles"].get("allow", [])},
        known_ids=(lambda ids: db.known_ids("careers", ids)) if db else (lambda ids: set()),
        page_extractor=make_page_extractor(page_router, llm_cfg["stages"][PAGE_STAGE]),
    )
    for i, company in enumerate(watchlist, 1):
        # Company names are private: the public log only says 'careers#N'.
        fetchers.append((f"careers:{company['name']}", f"careers#{i}", lambda c=company: careers.fetch_company(c)))

    for source, label, fetch in fetchers:
        t0 = time.monotonic()
        try:
            got = fetch()
            raws.extend(got)
            source_results.append({"source": source, "status": "success" if got else "empty",
                                   "fetched": len(got), "error": None, "ms": _ms(t0)})
        except Exception as exc:  # noqa: BLE001
            failed_sources.append(label)
            source_results.append({"source": source, "status": "failed", "fetched": 0,
                                   "error": type(exc).__name__, "ms": _ms(t0)})
            log.warning("source %s failed: %s", label, type(exc).__name__)

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
    # Known watchlist pages arrive as stubs (not refetched); they only refresh last_seen_at.
    candidates = [c for c in candidates if not (c.raw.source_data.get("stub") and c.is_new)]

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

    # 5. extraction, dealbreakers, ranking (spec 7.5, 7.9). New postings first, then the backlog.
    enricher = _enricher(profile, db)
    for c in passed:
        cols, reason = enricher.run(c.raw.title, c.raw.description, source_contract=c.raw.contract_type,
                                    remote_policy=c.raw.remote_policy, salary_text=c.raw.salary_text)
        c.enrichment = cols
        c.raw.remote_policy = cols.get("remote_policy", c.raw.remote_policy)
        c.raw.salary_text = cols.get("salary_text", c.raw.salary_text)
        if reason and c.raw.source_data.get("filter_mode") != "none":
            c.filter_reasons.append(reason)
    dealbroken = Counter(c.filter_reasons[0] for c in passed if not c.passed)
    passed = [c for c in passed if c.passed]
    backlog = _process_backlog(enricher, db, write=bool(run_id), now=now) if db else {}

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
    surface = [c for c in surface if not c.raw.source_data.get("initial_load")
               and not c.raw.source_data.get("no_digest")]           # superseded copy was already emailed
    min_score = float(profile["feed"].get("min_rank_score", 0))
    surface = [c for c in surface if (c.enrichment.get("rank_score") or 0) >= min_score
               or c.enrichment.get("rank_score") is None][: int(profile["feed"].get("max_items", 10))]
    surface_ids: list[str] = []
    if run_id and db:
        ids = db.insert_postings(new)
        db.touch(known_ids)
        db.record_reposts(repost_ids)
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
        if disc_cfg.get("enabled"):
            stats["discovery"] = _discover(db, candidates, disc_cfg, now)
        stats["reranked"] = _rerank(db, enricher, profile, now)
        # Auto-expiry of silent applications (spec 4.3 step 7, 10.6)
        tracking = load_config("tracking.yaml")
        stats["expired_applications"] = db.expire_stale_applications(int(tracking.get("auto_expiry_days", 30)))
        # Retention (spec 13): email bodies are kept for 12 months.
        stats["purged_email_bodies"] = db.purge_old_email_bodies(int(tracking.get("email_body_retention_months", 12)))

    # 7. digest
    secret, app_url = os.environ.get("ACTION_LINK_SECRET"), os.environ.get("APP_URL")
    links = [action_links(i, app_url, secret) for i in surface_ids] if secret and app_url and surface_ids else None
    subject, text, html = build_digest([c.raw for c in surface], len(passed), now.date(), links, app_url,
                                       extras=[c.enrichment for c in surface])
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
    rows = db.pending_extractions(now - timedelta(days=BACKLOG_DAYS), BACKLOG_LIMIT)
    counts: Counter[str] = Counter()
    for r in rows:
        if enricher.router.exhausted:
            break
        cols, reason = enricher.run(r["title"], r["description"], source_contract=r["contract_type"],
                                    remote_policy=r["remote_policy"], salary_text=r["salary_text"])
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
            return profile
    profile = load_profile()
    profile["_version"] = 0
    return profile


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

    api = ATS(httpx.Client(headers={"User-Agent": "jobsignal/0.1 (personal job search)"}, timeout=6,
                           follow_redirects=True))
    deadline = time.monotonic() + float(cfg.get("max_seconds_per_run", 300))
    for comp in db.companies_to_probe(int(cfg.get("companies_per_run", 20)), now):
        if time.monotonic() > deadline:
            break
        found = probe_company(comp["name"], api)
        if found:
            db.update_company(comp["id"], {
                "discovery_status": "found", "ats": found.ats, "ats_token": found.token,
                "verified_name": found.verified_name, "careers_url": found.careers_url,
                "feed_type": "jsonld" if found.ats in ("jsonld", "sitemap") else "ats_feed",
                "watch": True, "discovery_checked_at": now.isoformat(), "notes": f"found via {found.via}"})
            counts[f"found_via_{found.via}"] += 1
        else:
            db.update_company(comp["id"], {"discovery_status": "not_found", "discovery_checked_at": now.isoformat(),
                                           "next_check_at": (now + timedelta(days=int(cfg.get("retry_not_found_days", 30)))).isoformat()})
            counts["not_found"] += 1
    return dict(counts)


def _flush_llm(enricher: Enricher, db: Database) -> None:
    _flush_router(enricher.router, db, STAGE)


def _flush_router(router, db: Database, stage: str) -> None:
    if router.new_cache:
        db.cache_put(router.new_cache, stage)
    if router.usage:
        db.record_llm_usage(router.usage)


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
