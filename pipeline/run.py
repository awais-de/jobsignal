"""Entry point for the daily run: `python -m pipeline.run [--dry-run]`.

Phase 0 stub: loads and validates the profile, then exits. Stages from spec
section 4.3 are added phase by phase.

Logging rule (spec 12.1): the logs of a public repo are public, so log counts
and source names only, never profile values, postings' personal context,
digest contents or email text.
"""

from __future__ import annotations

import argparse
import logging
import sys

from pipeline.config import ConfigError, load_profile

log = logging.getLogger("jobsignal")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pipeline.run")
    parser.add_argument("--dry-run", action="store_true", help="write nothing, send nothing")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    try:
        profile = load_profile()
    except ConfigError as exc:
        log.error("%s", exc)
        return 1

    log.info(
        "profile loaded: %d allow patterns, %d block patterns",
        len(profile["titles"].get("allow", [])),
        len(profile["titles"].get("block", [])),
    )
    log.info("dry run: no stages implemented yet" if args.dry_run else "no stages implemented yet")
    return 0


if __name__ == "__main__":
    sys.exit(main())
