"""Supabase access through PostgREST with the secret key (service role)."""

from __future__ import annotations

import os
from datetime import date, datetime, timezone
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
    def has_successful_run(self) -> bool:
        rows = self._req("GET", "/pipeline_runs", params={"select": "id", "status": "eq.success", "dry_run": "eq.false", "limit": 1})
        return bool(rows)

    def start_run(self, dry_run: bool) -> str:
        rows = self._req("POST", "/pipeline_runs", json={"dry_run": dry_run}, headers={"Prefer": "return=representation"})
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
        cols = "id,source,source_job_id,dedupe_hash,first_seen_at,triage_status,deleted_at"
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
                    )
        return list(found.values())

    def insert_postings(self, candidates: list[Candidate]) -> dict[str, str]:
        """Insert new candidates; returns {source_job_id or hash: id}."""
        out: dict[str, str] = {}
        for chunk in _chunks(candidates, BATCH):
            rows = self._req("POST", "/job_postings", json=[_row(c) for c in chunk],
                             headers={"Prefer": "return=representation"},
                             params={"select": "id,source_job_id,dedupe_hash"})
            for r in rows:
                out[r["source_job_id"] or r["dedupe_hash"]] = r["id"]
        return out

    def touch(self, ids: list[str]) -> None:
        for chunk in _chunks(ids, 500):
            self._req("POST", "/rpc/touch_postings", json={"ids": chunk})

    def record_reposts(self, ids: list[str]) -> None:
        for chunk in _chunks(ids, 500):
            self._req("POST", "/rpc/record_reposts", json={"ids": chunk})

    def mark_surfaced(self, ids: list[str], day: date) -> None:
        for chunk in _chunks(ids, BATCH):
            self._req("PATCH", "/job_postings", params={"id": f"in.({','.join(chunk)})"},
                      json={"surfaced_on": day.isoformat()})


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
        "filter_status": "passed" if c.passed else "rejected",
        "filter_reasons": c.filter_reasons or None,
    }


def _chunks(items: list, n: int) -> Iterable[list]:
    for i in range(0, len(items), n):
        yield items[i:i + n]


def _in_list(values: list[str]) -> str:
    return ",".join('"' + v.replace('"', '') + '"' for v in values)


def _ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
