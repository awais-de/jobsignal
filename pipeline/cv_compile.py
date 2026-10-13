"""Compile one CV build to PDF (GitHub Actions, started from the app: workflow cv.yml).

Reads cv_builds.tex_source, runs pdflatex, stores the PDF in the private storage bucket cv-pdfs and
writes the page count (or the LaTeX error) back to the row.

The CV is personal and this repo's Actions logs are public: LaTeX output (which quotes the text) goes
to files only, the log prints counts and states, and errors are stored in the private database.
A package missing from the small TeX installation is installed and the compile retried.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

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
    rows = c.get(f"{url}/rest/v1/cv_builds", headers=h, params={"id": f"eq.{build_id}", "select": "tex_source"}).json()
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
    return 0


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
