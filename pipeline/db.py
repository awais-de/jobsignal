"""Supabase access through PostgREST with the secret key (service role)."""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterable

import httpx

from pipeline.dedupe import StoredPosting
from pipeline.models import Candidate

BATCH = 50  # keeps in.(...) filters well under URL length limits


class DBError(Exception):
    pass


class Database:
    def __init__(self, url: str, key: str, client: httpx.Client | None = None):
        self.client = client or httpx.Client(
            base_url=f"{url.rstrip('/')}/rest/v1",
            headers={"apikey": key, "Content-Type": "application/json"},
            timeout=30,
        )

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Database | None":
        env = os.environ if env is None else env
        url, key = env.get("SUPABASE_URL"), env.get("SUPABASE_SECRET_KEY")
        return cls(url, key) if url and key else None

    # -- low level ------------------------------------------------------------
    def _req(self, method: str, path: str, **kw: Any) -> Any:
        resp = self.client.request(method, path, **kw)
        if resp.status_code >= 400:
            # Status and PostgREST error code only: never echo row data into logs.
            code = ""
            try:
                code = resp.json().get("code", "")
            except ValueError:
                pass
            raise DBError(f"{method} {path.split('?')[0]} failed: HTTP {resp.status_code} {code}".strip())
        return resp.json() if resp.content else None

    # -- runs -----------------------------------------------------------------
    def has_successful_run_since(self, since: datetime) -> bool:
        """A successful *daily* run since `since` (fast-lane runs don't count)."""
        rows = self._req("GET", "/pipeline_runs", params={
            "select": "id", "status": "eq.success", "dry_run": "eq.false", "kind": "eq.daily",
            "started_at": f"gte.{since.isoformat()}", "limit": 1})
        return bool(rows)

    def run_in_progress(self, kind: str, within_minutes: int) -> bool:
        """A run of this kind started in the last `within_minutes` and still running."""
        since = datetime.now(timezone.utc) - timedelta(minutes=within_minutes)
        rows = self._req("GET", "/pipeline_runs", params={
            "select": "id", "status": "eq.running", "kind": f"eq.{kind}", "dry_run": "eq.false",
            "started_at": f"gte.{since.isoformat()}", "limit": 1})
        return bool(rows)

    def failing_sources(self, prefix: str, attempts: int = 3, window: int = 10) -> set[str]:
        """Sources (starting with `prefix`) whose last `attempts` tries, within the last `window` finished
        runs, all failed. Skipped runs don't count as tries; once a source's failures leave the window
        (~5 hours of fast runs) it is tried again."""
        last = self._req("GET", "/pipeline_runs", params={
            "select": "id", "status": "in.(success,failed)", "dry_run": "eq.false",
            "order": "started_at.desc", "limit": window})
        order = {r["id"]: i for i, r in enumerate(last)}          # 0 = newest
        if not order:
            return set()
        rows = self._req("GET", "/source_runs", params={
            "select": "source,status,pipeline_run_id", "source": f"like.{prefix}*",
            "pipeline_run_id": f"in.({','.join(order)})"})
        tries: dict[str, list[tuple[int, str]]] = {}
        for r in rows:
            tries.setdefault(r["source"], []).append((order[r["pipeline_run_id"]], r["status"]))
        return {s for s, t in tries.items()
                if len(t) >= attempts and all(status == "failed" for _, status in sorted(t)[:attempts])}

    def has_successful_run(self) -> bool:
        rows = self._req("GET", "/pipeline_runs", params={"select": "id", "status": "eq.success", "dry_run": "eq.false", "limit": 1})
        return bool(rows)

    def start_run(self, dry_run: bool, kind: str = "daily") -> str:
        rows = self._req("POST", "/pipeline_runs", json={"dry_run": dry_run, "kind": kind}, headers={"Prefer": "return=representation"})
        return rows[0]["id"]

    def finish_run(self, run_id: str, status: str, stats: dict[str, Any], error: str | None = None) -> None:
        self._req("PATCH", "/pipeline_runs", params={"id": f"eq.{run_id}"},
                  json={"status": status, "stats": stats, "error": error,
                        "finished_at": datetime.now(timezone.utc).isoformat()})

    def record_source_run(self, run_id: str, source: str, status: str, fetched: int,
                          inserted: int, updated: int, duration_ms: int, error: str | None) -> None:
        self._req("POST", "/source_runs", json={
            "pipeline_run_id": run_id, "source": source, "status": status, "fetched": fetched,
            "inserted": inserted, "updated": updated, "duration_ms": duration_ms, "error": error,
        })

    # -- postings -------------------------------------------------------------
    def stored_for(self, candidates: list[Candidate]) -> list[StoredPosting]:
        cols = ("id,source,source_job_id,dedupe_hash,first_seen_at,triage_status,deleted_at,"
                "filter_status,surfaced_on,description_missing,notes")
        found: dict[str, StoredPosting] = {}
        ids = sorted({c.raw.source_job_id for c in candidates if c.raw.source_job_id})
        hashes = sorted({c.dedupe_hash for c in candidates})
        for field, values in (("source_job_id", ids), ("dedupe_hash", hashes)):
            for chunk in _chunks(values, BATCH):
                rows = self._req("GET", "/job_postings", params={"select": cols, field: f"in.({_in_list(chunk)})"})
                for r in rows:
                    found[r["id"]] = StoredPosting(
                        id=r["id"], source=r["source"], source_job_id=r["source_job_id"],
                        dedupe_hash=r["dedupe_hash"], first_seen_at=_ts(r["first_seen_at"]),
                        triage_status=r["triage_status"], deleted_at=_ts(r["deleted_at"]) if r["deleted_at"] else None,
                        filter_status=r["filter_status"], surfaced_on=r["surfaced_on"],
                        has_description=not r["description_missing"], has_notes=bool(r.get("notes")),
                    )
        return list(found.values())

    def known_ids(self, source: str, ids: list[str]) -> set[str]:
        """Which of these source_job_ids are already stored (lets sources skip fetching them)."""
        found: set[str] = set()
        for chunk in _chunks(sorted(set(ids)), BATCH):
            rows = self._req("GET", "/job_postings", params={
                "select": "source_job_id", "source": f"eq.{source}", "source_job_id": f"in.({_in_list(chunk)})"})
            found.update(r["source_job_id"] for r in rows)
        return found

    def insert_postings(self, candidates: list[Candidate]) -> dict[str, str]:
        """Insert new candidates; returns {source_job_id or hash: id}."""
        out: dict[str, str] = {}
        # PostgREST bulk inserts need identical keys in every row (PGRST102). Passed postings
        # carry extraction/ranking columns, rejected ones don't, so insert each key-shape separately.
        groups: dict[tuple[str, ...], list[dict[str, Any]]] = {}
        for c in candidates:
            row = _row(c)
            groups.setdefault(tuple(sorted(row)), []).append(row)
        for rows_of_shape in groups.values():
            for chunk in _chunks(rows_of_shape, BATCH):
                rows = self._req("POST", "/job_postings", json=chunk,
                                 headers={"Prefer": "return=representation"},
                                 params={"select": "id,source_job_id,dedupe_hash"})
                for r in rows:
                    out[r["source_job_id"] or r["dedupe_hash"]] = r["id"]
        return out

    # -- cross-source merging (spec 7.3.2) ---------------------------------------------
    def supersede(self, ids: list[str]) -> None:
        for chunk in _chunks(sorted(set(ids)), BATCH):
            self._req("PATCH", "/job_postings", params={"id": f"in.({','.join(chunk)})", "triage_status": "eq.new",
                                                        "notes": "is.null"},
                      json={"filter_status": "rejected", "filter_reasons": ["superseded"]})

    def add_description(self, posting_id: str, description: str) -> None:
        """A weaker duplicate's description for a canonical row that had none; re-extracted next."""
        self._req("PATCH", "/job_postings", params={"id": f"eq.{posting_id}", "description_missing": "eq.true"},
                  json={"description": description, "description_missing": False, "extraction_status": "pending"})

    def descriptions(self, ids: list[str]) -> dict[str, str]:
        out: dict[str, str] = {}
        for chunk in _chunks(sorted(set(ids)), BATCH):
            for r in self._req("GET", "/job_postings", params={"select": "id,description",
                                                                "id": f"in.({','.join(chunk)})"}):
                if r["description"]:
                    out[r["id"]] = r["description"]
        return out

    def touch(self, ids: list[str]) -> None:
        for chunk in _chunks(ids, 500):
            self._req("POST", "/rpc/touch_postings", json={"ids": chunk})

    # -- job-alert emails (spec 7.1 tier 5) ---------------------------------------------
    def unparsed_alerts(self, domain_like: str, since: datetime) -> list[dict[str, Any]]:
        return self._req("GET", "/inbound_emails", params={
            "select": "id,subject,body_text,received_at", "category": "eq.job_alert", "parsed_at": "is.null",
            "from_domain": f"like.{domain_like}", "received_at": f"gte.{since.isoformat()}", "body_text": "not.is.null",
            "order": "received_at", "limit": 200})

    def mark_alerts_parsed(self, counts: dict[str, int]) -> None:
        if counts:
            self._req("POST", "/rpc/mark_alerts_parsed", json={"counts": counts})

    # -- ghost score (spec 7.8) --------------------------------------------------------
    GHOST_COLUMNS = ("id,source,company_name,posted_date,repost_count,reappear_count,poster_type,evergreen_language,"
                     "specificity_score,named_contact,start_date_text,reference_number,extraction_status")

    def ghost_targets(self, seen_since: datetime) -> list[dict[str, Any]]:
        """Passed postings still in view: first or last seen since `seen_since`."""
        out: list[dict[str, Any]] = []
        while True:
            rows = self._req("GET", "/job_postings", params={
                "select": self.GHOST_COLUMNS, "filter_status": "eq.passed", "deleted_at": "is.null",
                "or": f"(first_seen_at.gte.{seen_since.isoformat()},last_seen_at.gte.{seen_since.isoformat()})",
                "order": "id", "limit": 1000, "offset": len(out)})
            out += rows
            if len(rows) < 1000:
                return out

    def ghost_context(self, ids: list[str]) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for chunk in _chunks(ids, 300):
            for r in self._req("POST", "/rpc/ghost_context", json={"ids": chunk}) or []:
                out[r["id"]] = r
        return out

    def set_ghost_scores(self, rows: list[dict[str, Any]]) -> None:
        for chunk in _chunks(rows, 300):
            self._req("POST", "/rpc/set_ghost_scores", json={"rows": chunk})

    def record_reposts(self, ids: list[str]) -> None:
        for chunk in _chunks(ids, 500):
            self._req("POST", "/rpc/record_reposts", json={"ids": chunk})

    # -- extraction / LLM -------------------------------------------------------
    def pending_extractions(self, since: datetime, limit: int) -> list[dict[str, Any]]:
        """Passed postings from earlier runs whose extraction hasn't succeeded yet."""
        return self._req("GET", "/job_postings", params={
            "select": "id,title,description,contract_type,remote_policy,salary_text,source_data,lane",
            "filter_status": "eq.passed", "extraction_status": "in.(pending,failed)",
            "description": "not.is.null", "deleted_at": "is.null",
            # Core jobs first (old rows have no lane), explore jobs with what budget is left.
            "first_seen_at": f"gte.{since.isoformat()}", "order": "lane.asc.nullsfirst,first_seen_at.desc", "limit": limit,
        })

    def title_rejected_since(self, since: datetime) -> list[dict[str, Any]]:
        """Jobs whose only failure was the title list: re-checked when the title families change."""
        out: list[dict[str, Any]] = []
        while True:
            rows = self._req("GET", "/job_postings", params={
                "select": "id,source,source_job_id,company_name,title,country,contract_type,posted_date,poster_type,"
                          "source_data,first_seen_at,description_missing",
                "filter_status": "eq.rejected", "filter_reasons": "eq.{title_not_allowed}", "deleted_at": "is.null",
                "first_seen_at": f"gte.{since.isoformat()}", "order": "id", "limit": 1000, "offset": len(out)})
            out += rows
            if len(rows) < 1000:
                return out

    def update_posting(self, posting_id: str, fields: dict[str, Any]) -> None:
        self._req("PATCH", "/job_postings", params={"id": f"eq.{posting_id}"}, json=fields)

    def cache_get(self, key: str) -> dict[str, Any] | None:
        rows = self._req("GET", "/llm_cache", params={"select": "result", "cache_key": f"eq.{key}"})
        return rows[0]["result"] if rows else None

    def cache_put(self, entries: dict[str, dict[str, Any]], stage: str) -> None:
        rows = [{"cache_key": k, "stage": stage, "result": v} for k, v in entries.items()]
        for chunk in _chunks(rows, BATCH):
            self._req("POST", "/llm_cache", json=chunk,
                      headers={"Prefer": "resolution=ignore-duplicates,return=minimal"})

    def record_llm_usage(self, rows: list[dict[str, Any]]) -> None:
        for chunk in _chunks(rows, BATCH):
            self._req("POST", "/llm_usage", json=chunk)

    # -- owner profile (editable in the app) ------------------------------------------------
    def ranking_skills(self) -> list[dict[str, Any]]:
        """The owner's skills from the skills database (see pipeline/skills_db.py)."""
        return self._req("POST", "/rpc/ranking_skills", json={}) or []

    def owner_profile(self) -> tuple[dict[str, Any], int] | None:
        rows = self._req("GET", "/owner_profile", params={"select": "profile,version", "id": "eq.1"})
        return (rows[0]["profile"], rows[0]["version"]) if rows else None

    # -- market demand (pipeline/skill_demand.py) -----------------------------------------
    def skill_catalog(self) -> list[dict[str, Any]]:
        return self._req("GET", "/skills", params={"select": "id,name,name_key,aliases", "deleted_at": "is.null"})

    def postings_for_demand(self, start: datetime, end: datetime) -> list[dict[str, Any]]:
        """Postings in a job family, first seen in [start, end), with their text."""
        out, offset = [], 0
        while True:
            rows = self._req("GET", "/job_postings", params={
                "select": "id,company_key,title,description,title_family,source",
                "title_family": "not.is.null", "description": "not.is.null", "deleted_at": "is.null",
                "and": f"(first_seen_at.gte.{start.isoformat()},first_seen_at.lt.{end.isoformat()})",
                "order": "id", "limit": 500, "offset": offset})
            out.extend(rows)
            if len(rows) < 500:
                return out
            offset += 500

    def replace_skill_demand(self, week: date, rows: list[dict[str, Any]]) -> None:
        self._req("DELETE", "/skill_demand_weekly", params={"week_start": f"eq.{week.isoformat()}"})
        for chunk in _chunks(rows, 500):
            self._req("POST", "/skill_demand_weekly", json=chunk, headers={"Prefer": "return=minimal"})

    def postings_to_rerank(self, since: datetime) -> list[dict[str, Any]]:
        return self._req("GET", "/job_postings", params={
            "select": "id,must_have_skills,nice_to_have_skills,remote_policy,rank_details",
            "filter_status": "eq.passed", "extraction_status": "eq.done", "deleted_at": "is.null",
            "first_seen_at": f"gte.{since.isoformat()}", "limit": 2000})

    # -- companies (spec 6.2, 7.2) -------------------------------------------------------
    def company_count(self) -> int:
        resp = self.client.get("/companies", params={"select": "id", "limit": 1},
                               headers={"Prefer": "count=exact", "Range": "0-0"})
        return int(resp.headers.get("content-range", "*/0").split("/")[-1] or 0)

    def all_postings_for_seed(self) -> list[dict[str, Any]]:
        out, offset = [], 0
        while True:
            rows = self._req("GET", "/job_postings", params={
                "select": "company_name,source,country,filter_status,poster_type", "country": "eq.DE",
                "source": "in.(ba_api,arbeitnow,careers)", "order": "id", "limit": 1000, "offset": offset})
            out.extend(rows)
            if len(rows) < 1000:
                return out
            offset += 1000

    def register_companies(self, rows: list[dict[str, Any]]) -> None:
        """Insert unseen employers (unique on name_normalized); mark relevant ones."""
        for chunk in _chunks(rows, 200):
            self._req("POST", "/companies?on_conflict=name_normalized", json=chunk,
                      headers={"Prefer": "resolution=ignore-duplicates,return=minimal"})
        relevant = sorted({r["name_normalized"] for r in rows if r.get("relevant")})
        for chunk in _chunks(relevant, BATCH):
            self._req("PATCH", "/companies", params={"name_normalized": f"in.({_in_list(chunk)})", "relevant": "eq.false"},
                      json={"relevant": True})

    def prioritise_companies(self, names_normalized: list[str]) -> None:
        """Probe these first (alert jobs without a description: their employer listing has one)."""
        for chunk in _chunks(sorted(set(names_normalized)), BATCH):
            self._req("PATCH", "/companies", params={"name_normalized": f"in.({_in_list(chunk)})", "priority": "eq.0"},
                      json={"priority": 1})

    def companies_to_probe(self, limit: int, now: datetime) -> list[dict[str, Any]]:
        """Group A first, then B, never C (owner decision 2026-10-21; tiers from score_companies)."""
        tiers = "(tier.in.(A,B),tier.is.null)"
        pending = self._req("GET", "/companies", params={
            "select": "id,name", "discovery_status": "eq.pending", "is_agency": "eq.false", "deleted_at": "is.null",
            "or": tiers, "order": "priority.desc,tier.asc.nullsfirst,relevance_score.desc,created_at.asc", "limit": limit})
        if len(pending) >= limit:
            return pending
        retry = self._req("GET", "/companies", params={
            "select": "id,name", "discovery_status": "eq.not_found", "is_agency": "eq.false", "deleted_at": "is.null",
            "or": tiers, "next_check_at": f"lte.{now.isoformat()}",
            "order": "priority.desc,tier.asc.nullsfirst,relevance_score.desc,next_check_at.asc", "limit": limit - len(pending)})
        return pending + retry

    def ba_watch_companies(self, all_unreadable: bool) -> list[dict[str, Any]]:
        """Group-A companies without a readable career site: all of them (daily run) or the ones known to post
        at the Arbeitsagentur (fast lane)."""
        params = {"select": "id,name", "tier": "eq.A", "discovery_status": "eq.not_found", "is_agency": "eq.false",
                  "deleted_at": "is.null", "limit": 500}
        if not all_unreadable:
            params["ba_watch"] = "eq.true"
        return self._req("GET", "/companies", params=params)

    def set_ba_watch(self, posting: list[str], silent: list[str], now: datetime) -> None:
        for ids, flag in ((posting, True), (silent, False)):
            for chunk in _chunks(ids, BATCH):
                self._req("PATCH", "/companies", params={"id": f"in.({','.join(chunk)})"},
                          json={"ba_watch": flag, "ba_checked_at": now.isoformat()})

    def score_companies(self) -> dict[str, int]:
        return self._req("POST", "/rpc/score_companies", json={}) or {}

    def mark_agencies(self, names: list[str]) -> int:
        return int(self._req("POST", "/rpc/mark_agencies", json={"names": names}) or 0) if names else 0

    def update_company(self, company_id: str, fields: dict[str, Any]) -> None:
        self._req("PATCH", "/companies", params={"id": f"eq.{company_id}"}, json=fields)

    def watched_companies(self) -> list[dict[str, Any]]:
        return self._req("GET", "/companies", params={
            "select": "id,name,ats,ats_token,filter_mode,careers_url,tier,manually_edited", "watch": "eq.true", "discovery_status": "eq.found",
            "deleted_at": "is.null"})

    # -- tracking ---------------------------------------------------------------
    def expire_stale_applications(self, days: int) -> int:
        return int(self._req("POST", "/rpc/expire_stale_applications", json={"p_days": days}) or 0)

    def control_warnings(self, max_age_hours: int = 24) -> list[dict[str, str]] | None:
        """Warnings of the latest control-panel snapshot (taken 05:07 UTC), or None when there is none recent."""
        since = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)
        rows = self._req("GET", "/control_snapshots", params={
            "select": "warnings", "created_at": f"gte.{since.isoformat()}", "order": "created_at.desc", "limit": 1})
        return rows[0]["warnings"] if rows else None

    def outreach_rows(self, since: date) -> tuple[list[dict], list[dict], list[dict]]:
        """Recent applications, their status and all pings: the inputs of the digest's outreach reminders."""
        apps = self._req("GET", "/applications", params={
            "select": "id,job_posting_id,applied_at,job_postings(company_name,title)", "deleted_at": "is.null",
            "applied_at": f"gte.{since.isoformat()}"})
        ids = [a["id"] for a in apps]
        statuses = []
        for chunk in _chunks(ids, BATCH):
            statuses += self._req("GET", "/application_status", params={
                "select": "application_id,status", "application_id": f"in.({','.join(chunk)})"})
        pings = self._req("GET", "/outreach", params={
            "select": "job_posting_id,status,follow_up_due,followed_up_at,contacts(full_name,company_name)",
            "deleted_at": "is.null"})
        return apps, statuses, pings

    def purge_old_email_bodies(self, months: int) -> int:
        return int(self._req("POST", "/rpc/purge_old_email_bodies", json={"p_months": months}) or 0)

    def manual_postings_without_hash(self) -> list[dict[str, Any]]:
        """Postings added by hand get a placeholder hash; the pipeline computes the real one."""
        return self._req("GET", "/job_postings", params={
            "select": "id,company_name,title,city", "dedupe_hash": "like.manual:*"})

    def mark_surfaced(self, ids: list[str], day: date) -> None:
        for chunk in _chunks(ids, BATCH):
            self._req("PATCH", "/job_postings", params={"id": f"in.({','.join(chunk)})"},
                      json={"surfaced_on": day.isoformat()})
        self.mark_notified(ids)

    def mark_notified(self, ids: list[str]) -> None:
        """When the owner was told about these jobs (the time-to-apply funnel measures from it)."""
        now = datetime.now(timezone.utc).isoformat()
        for chunk in _chunks(ids, BATCH):
            self._req("PATCH", "/job_postings", params={"id": f"in.({','.join(chunk)})", "notified_at": "is.null"},
                      json={"notified_at": now})

    def notified_since(self, since: datetime) -> int:
        """Jobs the fast lane sent as instant alerts since `since` (surfaced_on stays empty for those)."""
        resp = self.client.get("/job_postings", params={"select": "id", "notified_at": f"gte.{since.isoformat()}",
                                                         "surfaced_on": "is.null", "limit": 1},
                               headers={"Prefer": "count=exact", "Range": "0-0"})
        return int(resp.headers.get("content-range", "*/0").split("/")[-1] or 0)


def _row(c: Candidate) -> dict[str, Any]:
    r = c.raw
    return {
        "dedupe_hash": c.dedupe_hash,
        "source": r.source,
        "source_job_id": r.source_job_id,
        "source_url": r.source_url,
        "apply_url": r.apply_url,
        "company_name": r.company_name,
        "title": r.title,
        "location_raw": r.location_raw,
        "city": r.city,
        "country": r.country,
        "remote_policy": r.remote_policy,
        "description": r.description,
        "description_missing": r.description is None,
        "posted_date": r.posted_date.isoformat() if r.posted_date else None,
        "contract_type": r.contract_type,
        "poster_type": r.poster_type,
        "salary_text": r.salary_text,
        "source_data": r.source_data or None,
        "company_id": r.source_data.get("company_id"),
        "filter_status": "passed" if c.passed else "rejected",
        "filter_reasons": c.filter_reasons or None,
        "title_family": c.title_family,
        "lane": c.lane,
        **c.enrichment,
    }


def _chunks(items: list, n: int) -> Iterable[list]:
    for i in range(0, len(items), n):
        yield items[i:i + n]


def _in_list(values: list[str]) -> str:
    return ",".join('"' + v.replace('"', '') + '"' for v in values)


def _ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
