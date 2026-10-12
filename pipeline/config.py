"""Load the owner's profile.

The real profile is personal and never committed (spec 13.1). It comes from the
PROFILE_YAML environment variable (a GitHub Actions secret) or, locally, from
pipeline/config/profile.yaml. There is deliberately no fallback to
profile.example.yaml: a run on made-up values would silently send a wrong digest.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Any

import yaml

CONFIG_DIR = Path(__file__).parent / "config"
PROFILE_PATH = CONFIG_DIR / "profile.yaml"
SOURCES_PATH = CONFIG_DIR / "sources.yaml"
PROFILE_ENV = "PROFILE_YAML"

REQUIRED_KEYS = ("search_terms", "titles", "location", "contract_types", "dealbreakers", "feed", "freshness_hours")


class ConfigError(Exception):
    pass


def load_profile(env: dict[str, str] | None = None, path: Path = PROFILE_PATH) -> dict[str, Any]:
    env = os.environ if env is None else env
    raw = env.get(PROFILE_ENV)
    if raw:
        source = f"${PROFILE_ENV}"
    elif path.is_file():
        raw = path.read_text(encoding="utf-8")
        source = str(path.name)
    else:
        raise ConfigError(
            f"No profile found. Set ${PROFILE_ENV} or create {path.name} "
            "from profile.example.yaml."
        )

    try:
        profile = yaml.safe_load(raw)
    except yaml.YAMLError as exc:
        # Don't include the YAML text: logs of a public repo are public.
        raise ConfigError(f"Profile from {source} is not valid YAML (line {_line(exc)}).") from None

    return validate_profile(profile, source)


def load_sources(path: Path = SOURCES_PATH) -> dict[str, Any]:
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def load_config(name: str) -> dict[str, Any]:
    """A public config file from pipeline/config (llm.yaml, scoring.yaml, ...)."""
    return yaml.safe_load((CONFIG_DIR / name).read_text(encoding="utf-8")) or {}


def _line(exc: yaml.YAMLError) -> str:
    mark = getattr(exc, "problem_mark", None)
    return str(mark.line + 1) if mark else "?"


log = logging.getLogger("jobsignal")


def validate_profile(profile: Any, origin: str) -> dict[str, Any]:
    """Required keys present; title patterns compile (invalid ones are dropped with a warning,
    so one bad pattern typed in the app can't break the daily run)."""
    if not isinstance(profile, dict):
        raise ConfigError(f"Profile from {origin} must be a mapping.")
    missing = [k for k in REQUIRED_KEYS if k not in profile]
    if missing:
        raise ConfigError(f"Profile from {origin} is missing keys: {', '.join(missing)}")
    for key in ("allow", "block"):
        profile["titles"][key] = _valid_patterns(profile["titles"].get(key), f"title {key}")
    # Title families (pipeline/families.py): when present, they define what is searched and which
    # titles pass; titles.allow and search_terms become their union (used by the careers prefilter).
    families = profile.get("families")
    if families:
        for f in families:
            f["titles"] = _valid_patterns(f.get("titles"), "family title")
            f["exclude"] = _valid_patterns(f.get("exclude"), "family exclude")
        from pipeline.families import active_search_terms, active_title_patterns, load_families
        profile["titles"]["allow"] = active_title_patterns(families)
        profile["search_terms"] = active_search_terms(load_families(profile))
    return profile


def _valid_patterns(patterns: list[str] | None, what: str) -> list[str]:
    good = []
    for pattern in patterns or []:
        try:
            re.compile(pattern)
            good.append(pattern)
        except re.error:
            log.warning("profile: an invalid %s pattern was skipped", what)
    return good
