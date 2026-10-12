"""Discovery via the company's own website (spec 7.2 steps 3-5), for employers whose ATS address
can't be guessed from their name (typically Workday, SuccessFactors and custom career sites).

1. Website: www.<name>.de / .com, accepted only if the page names the company.
2. Careers page: the homepage link mentioning Karriere / Career / Jobs / Stellen.
3. ATS fingerprint: links, iframes and scripts on the careers page pointing at a known ATS.
4. Otherwise JSON-LD: job links on the careers page (or its sitemap.xml) whose pages carry
   schema.org JobPosting data (e.g. SuccessFactors career-site-builder sites).
A link from the company's own site is trusted as its ATS; it still needs at least one job.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse

import httpx

from pipeline.discovery_names import tokens
from pipeline.sources.careers import _job_posting_ld

FINGERPRINTS: list[tuple[str, re.Pattern[str]]] = [
    ("workday", re.compile(r"https?://([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com/(?:[a-z]{2}-[A-Z]{2}/)?([A-Za-z0-9_-]+)")),
    ("personio", re.compile(r"([a-z0-9-]+)\.jobs\.personio\.(?:de|com)")),
    ("softgarden", re.compile(r"([a-z0-9-]+)\.softgarden\.io")),
    ("greenhouse", re.compile(r"(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io/(?:embed/job_board(?:/js)?\?for=)?([a-z0-9_-]+)")),
    ("lever", re.compile(r"jobs\.lever\.co/([a-z0-9_-]+)")),
    ("workable", re.compile(r"apply\.workable\.com/([a-z0-9_-]+)")),
    ("recruitee", re.compile(r"([a-z0-9-]+)\.recruitee\.com")),
    ("ashby", re.compile(r"jobs\.ashbyhq\.com/([A-Za-z0-9_.-]+)")),
    ("smartrecruiters", re.compile(r"(?:careers|jobs)\.smartrecruiters\.com/([A-Za-z0-9_-]+)")),
    ("join", re.compile(r"join\.com/companies/([a-z0-9_-]+)")),
    ("teamtailor", re.compile(r"([a-z0-9-]+)\.teamtailor\.com")),
]
_IGNORE_TOKENS = {"www", "jobs", "careers", "career", "api", "app", "embed", "static", "assets", "cdn"}
_CAREERS = re.compile(r"karriere|career|jobs?\b|stellen|arbeiten[- ]bei|join[- ]us|work[- ]with[- ]us|vacanc", re.I)


@dataclass
class SiteHit:
    kind: str            # an ATS name, or 'jsonld' (job pages on the careers site) or 'sitemap'
    token: str           # ATS token; Workday 'host|tenant|site'; for jsonld/sitemap the link pattern
    careers_url: str


# Network errors, and URLs that can't be built from a name (a host label over 63 characters raises
# UnicodeError, a ValueError; bad characters raise InvalidURL): the company is simply "not found".
_FETCH_ERRORS = (httpx.HTTPError, httpx.InvalidURL, ValueError)


def find_website(name: str, c: httpx.Client) -> str | None:
    toks = tokens(name)
    if not toks:
        return None
    for slug in dict.fromkeys(["-".join(toks), "".join(toks)] + [t for t in toks if len(t) >= 5]):
        if len(slug) > 63:          # not a possible domain name
            continue
        for tld in ("de", "com"):
            url = f"https://www.{slug}.{tld}/"
            try:
                r = c.get(url)
            except _FETCH_ERRORS:
                continue
            if r.status_code == 200 and slug.split("-")[0] in _page_name(r.text).replace(" ", "") + " " + _page_name(r.text):
                return str(r.url)
    return None


def _page_name(html: str) -> str:
    title = (re.search(r"<title[^>]*>(.*?)</title>", html, re.S | re.I) or [None, ""])[1]
    site = (re.search(r'property=["\']og:site_name["\'][^>]*content=["\']([^"\']+)', html, re.I) or [None, ""])[1]
    return " ".join(tokens(f"{title} {site}"))


def careers_url(home: str, html: str) -> str | None:
    best = None
    for href, text in re.findall(r'<a[^>]+href=["\']([^"\'#]+)["\'][^>]*>(.*?)</a>', html, re.S | re.I):
        label = re.sub(r"<[^>]+>", " ", text)
        if _CAREERS.search(href) or _CAREERS.search(label):
            url = urljoin(home, href)
            if urlparse(url).scheme in ("http", "https"):
                # Prefer a direct ATS link, then a page on the company's own domain.
                if any(p.search(url) for _, p in FINGERPRINTS):
                    return url
                best = best or url
    return best


def fingerprint(html: str) -> tuple[str, str] | None:
    for kind, pat in FINGERPRINTS:
        for m in pat.finditer(html):
            if kind == "workday":
                return kind, f"{m.group(1)}.{m.group(2)}.myworkdayjobs.com|{m.group(1)}|{m.group(3)}"
            token = m.group(1)
            if token.lower() not in _IGNORE_TOKENS:
                return kind, token
    return None


def jsonld_pattern(url: str, html: str, c: httpx.Client) -> str | None:
    """A link pattern for job pages on this careers page that carry JobPosting JSON-LD."""
    links = sorted({urljoin(url, h) for h in re.findall(r'href=["\']([^"\'#]+)["\']', html)
                    if re.search(r"/(job|jobs|stelle|stellen|stellenangebot|vacanc|position)[^/]*/", h, re.I)})
    for link in links[:3]:
        try:
            if _job_posting_ld(c.get(link).text):
                m = re.search(r"/(job|jobs|stelle|stellen|stellenangebote?|vacancies|vacancy|position|positions)/", urlparse(link).path, re.I)
                return re.escape(m.group(0)) if m else None
        except _FETCH_ERRORS:
            continue
    return None


def _site_name(url: str) -> str:
    parts = urlparse(url).netloc.lower().split(".")
    return parts[-2] if len(parts) >= 2 else parts[0]


def _job_portal(home: str, html: str) -> str | None:
    """A dedicated job portal linked from the careers page: jobs./karriere./careers. on the same base domain."""
    for href in re.findall(r'href=["\']([^"\'#]+)["\']', html):
        u = urljoin(home, href)
        host = urlparse(u).netloc.lower()
        if _site_name(u) == _site_name(home) and re.match(r"(jobs|karriere|careers?|stellen)\.", host):
            return f"{urlparse(u).scheme}://{host}/"
    return None


def _sitemap_jobs(root: str, c: httpx.Client) -> tuple[list[str], bool]:
    """Job URLs in the site's sitemap.xml, and whether the first one carries JobPosting JSON-LD."""
    try:
        sm = c.get(f"{root}/sitemap.xml")
        locs = re.findall(r"<loc>\s*([^<\s]+)\s*</loc>", sm.text) if sm.status_code == 200 else []
        jobs = [u for u in locs if re.search(r"/jobs?/", u)]
        return jobs, bool(jobs) and bool(_job_posting_ld(c.get(jobs[0]).text))
    except _FETCH_ERRORS:
        return [], False


def discover_via_website(name: str, c: httpx.Client) -> SiteHit | None:
    """Detection order, most complete first: own portal's sitemap with JSON-LD job pages; a known
    ATS linked from the site; JSON-LD job links on the careers page; a sitemap without JSON-LD
    (job pages then go through LLM page extraction)."""
    home = find_website(name, c)
    if not home:
        return None
    try:
        cu = careers_url(home, c.get(home).text)
        if not cu:
            return None
        cpage = c.get(cu)
        html, cu = cpage.text, str(cpage.url)          # after redirects (often straight to an ATS)
        portal = _job_portal(cu, html)
        if portal and not cu.startswith(portal):
            ppage = c.get(portal)
            html, cu = f"{html}\n{ppage.text}", str(ppage.url)
    except _FETCH_ERRORS:
        return None
    root = f"{urlparse(cu).scheme}://{urlparse(cu).netloc}"
    # Same company site if the registrable name matches (zalando.de and jobs.zalando.com both count).
    on_own_domain = _site_name(home) == _site_name(cu)
    sitemap_jobs, sitemap_ld = _sitemap_jobs(root, c) if on_own_domain else ([], False)
    pattern = "/jobs/" if sitemap_jobs and "/jobs/" in sitemap_jobs[0] else "/job/"
    if sitemap_jobs and sitemap_ld:
        return SiteHit("sitemap", pattern, f"{root}/sitemap.xml")
    hit = fingerprint(f"{cu}\n{html}")
    if hit:
        return SiteHit(hit[0], hit[1], cu)
    jl = jsonld_pattern(cu, html, c)
    if jl:
        return SiteHit("jsonld", jl, cu)
    if sitemap_jobs:
        return SiteHit("sitemap", pattern, f"{root}/sitemap.xml")
    return None
