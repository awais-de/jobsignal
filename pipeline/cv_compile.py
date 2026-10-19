"""Compile one CV build to PDF (GitHub Actions, started from the app: workflow cv.yml).

Reads cv_builds.tex_source, runs pdflatex, stores the PDF in the private storage bucket cv-pdfs and
writes the page count (or the LaTeX error) back to the row.

The CV is personal and this repo's Actions logs are public: LaTeX output (which quotes the text) goes
to files only, the log prints counts and states, and errors are stored in the private database.
A package missing from the small TeX installation is installed and the compile retried.

Compiles are previews (owner decision 2026-10-19): once a new one of the same CV succeeds, the older
ones that weren't saved to Drive are deleted, PDF and row. "Same CV": the same ad-hoc CV, or the same
job and format. Saved builds (status 'saved') are never touched. The daily run also deletes unsaved
compiles older than 30 days (prune_stale).
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

log = logging.getLogger("jobsignal")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
MAX_INSTALL_ROUNDS = 4


def main(build_id: str) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if not UUID.match(build_id):
        log.error("not a build id")
        return 1
    url, key = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SECRET_KEY"]
    h = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    c = httpx.Client(timeout=60)
    rows = c.get(f"{url}/rest/v1/cv_builds", headers=h, params={
        "id": f"eq.{build_id}", "select": "tex_source,created_at,job_posting_id,base_cv_id,cv_draft_id"}).json()
    if not rows:
        log.error("build not found")
        return 1
    patch = lambda fields: c.patch(f"{url}/rest/v1/cv_builds", headers=h, params={"id": f"eq.{build_id}"},  # noqa: E731
                                   json=fields).raise_for_status()
    patch({"status": "compiling", "error": None})

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        (work / "cv.tex").write_text(rows[0]["tex_source"], encoding="utf-8")
        ok, pages, error = compile_tex(work)
        if not ok:
            patch({"status": "failed", "error": error})
            log.info("cv build failed (details in the app)")
            return 0
        path = f"{build_id}.pdf"
        r = c.post(f"{url}/storage/v1/object/cv-pdfs/{path}",
                   headers={"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/pdf",
                            "x-upsert": "true"},
                   content=(work / "cv.pdf").read_bytes())
        r.raise_for_status()
        patch({"status": "compiled", "pages": pages, "pdf_path": path})
        log.info("cv build compiled: %d page%s", pages, "" if pages == 1 else "s")
    try:
        n = delete_builds(c, url, key, older_previews(c, url, h, build_id, rows[0]))
        if n:
            log.info("replaced %d earlier preview%s", n, "" if n == 1 else "s")
    except httpx.HTTPError as exc:          # a leftover preview costs a little storage, never the compile
        log.warning("couldn't remove earlier previews: %s", type(exc).__name__)
    return 0


def older_previews(c: httpx.Client, url: str, h: dict[str, str], build_id: str, b: dict[str, Any]) -> list[dict[str, Any]]:
    """Earlier, unsaved compiles of the same CV: replaced by this one."""
    params = {"select": "id,pdf_path", "id": f"neq.{build_id}", "status": "in.(compiled,failed)",
              "resume_id": "is.null", "created_at": f"lt.{b['created_at']}"}
    if b.get("cv_draft_id"):
        params["cv_draft_id"] = f"eq.{b['cv_draft_id']}"
    elif b.get("job_posting_id") and b.get("base_cv_id"):
        params.update(job_posting_id=f"eq.{b['job_posting_id']}", base_cv_id=f"eq.{b['base_cv_id']}", cv_draft_id="is.null")
    else:
        return []
    return c.get(f"{url}/rest/v1/cv_builds", headers=h, params=params).json()


def delete_builds(c: httpx.Client, url: str, key: str, builds: list[dict[str, Any]]) -> int:
    """Deletes the PDFs (storage API) and then the rows of these builds."""
    if not builds:
        return 0
    h = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    paths = [b["pdf_path"] for b in builds if b.get("pdf_path")]
    if paths:
        c.request("DELETE", f"{url}/storage/v1/object/cv-pdfs", headers=h, json={"prefixes": paths}).raise_for_status()
    ids = ",".join(b["id"] for b in builds)
    c.delete(f"{url}/rest/v1/cv_builds", headers=h, params={"id": f"in.({ids})"}).raise_for_status()
    return len(builds)


def prune_stale(days: int = 30) -> int:
    """Unsaved compiles older than `days`, e.g. of CVs no longer worked on (daily run)."""
    url, key = os.environ["SUPABASE_URL"].rstrip("/"), os.environ["SUPABASE_SECRET_KEY"]
    h = {"apikey": key, "Authorization": f"Bearer {key}"}
    since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    with httpx.Client(timeout=60) as c:
        rows = c.get(f"{url}/rest/v1/cv_builds", headers=h, params={
            "select": "id,pdf_path", "status": "in.(compiled,failed,queued,compiling)", "resume_id": "is.null",
            "created_at": f"lt.{since}", "limit": 500}).json()
        return delete_builds(c, url, key, rows)


def compile_tex(work: Path) -> tuple[bool, int, str | None]:
    """pdflatex with output to files; installs missing packages (TinyTeX tlmgr) and retries."""
    for _ in range(MAX_INSTALL_ROUNDS + 1):
        with open(work / "console.txt", "w") as out:
            subprocess.run(["pdflatex", "-interaction=nonstopmode", "-halt-on-error", "cv.tex"],
                           cwd=work, stdout=out, stderr=subprocess.STDOUT, timeout=120)
        text = (work / "cv.log").read_text(encoding="utf-8", errors="replace") if (work / "cv.log").exists() else ""
        m = re.search(r"Output written on cv\.pdf \((\d+) pages?", text)
        if m and (work / "cv.pdf").exists():
            return True, int(m.group(1)), None
        missing = re.search(r"File `([^']+\.(?:sty|cls|tex|def|fd))' not found", text)
        if not missing or not install_for(missing.group(1)):
            return False, 0, latex_error(text)
    return False, 0, latex_error(text)


def install_for(filename: str) -> bool:
    """Install the TeX Live package that provides `filename`. Package names only reach the log."""
    found = subprocess.run(["tlmgr", "search", "--global", "--file", f"/{filename}"],
                           capture_output=True, text=True, timeout=120).stdout
    pkgs = sorted({line[:-1] for line in found.splitlines() if line.endswith(":") and not line.startswith(" ")})
    if not pkgs:
        return False
    log.info("installing TeX package(s): %s", ", ".join(pkgs))
    return subprocess.run(["tlmgr", "install", *pkgs], capture_output=True, timeout=300).returncode == 0


def latex_error(log_text: str) -> str:
    """The first LaTeX error with a few lines of context, for the app (stored privately)."""
    lines = log_text.splitlines()
    for i, line in enumerate(lines):
        if line.startswith("!"):
            return "\n".join(lines[i:i + 6])[:1500]
    return "pdflatex produced no PDF (no error message in the log)."


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else ""))
