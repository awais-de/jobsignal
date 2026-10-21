"""Every table and view our migrations create is granted to service_role explicitly (Supabase, from 30 Oct 2026:
new tables in "public" no longer get Data API grants automatically; without one the pipeline and the Edge
Functions get 'permission denied'). From the backfill migration on, the grant must be in the creating file."""

import re
from pathlib import Path

MIGRATIONS = sorted((Path(__file__).parent.parent / "supabase" / "migrations").glob("*.sql"))
BACKFILL = "20261021090000"          # explicit grants for everything created before it

CREATE = re.compile(r"\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?(table|view)\s+(?:if\s+not\s+exists\s+)?"
                    r"(?:public\.)?([a-z_][a-z0-9_]*)", re.I)
DROP = re.compile(r"\bdrop\s+(?:table|view)\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)", re.I)
GRANT = re.compile(r"\bgrant\s+[^;]*?\bon\s+(?:table\s+)?([^;]*?)\s+to\s+([^;]*);", re.I | re.S)


def _strip_comments(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


def _granted(sql: str) -> set[str]:
    out: set[str] = set()
    for targets, grantees in GRANT.findall(_strip_comments(sql)):
        if "service_role" not in grantees.lower() or re.match(r"\s*(function|sequence|schema|all\s)", targets, re.I):
            continue
        out |= {t.strip().removeprefix("public.").lower() for t in targets.split(",") if t.strip()}
    return out


def test_every_table_and_view_is_granted_to_service_role():
    created: dict[str, str] = {}             # name -> file stem that created it
    granted_anywhere: set[str] = set()
    missing_in_file: list[str] = []
    for f in MIGRATIONS:
        sql = _strip_comments(f.read_text(encoding="utf-8"))
        here = _granted(sql)
        granted_anywhere |= here
        for name in DROP.findall(sql):
            created.pop(name.lower(), None)
        for _, name in CREATE.findall(sql):
            name = name.lower()
            created.setdefault(name, f.stem)
            if f.stem[:14] >= BACKFILL and name not in here:
                missing_in_file.append(f"{f.name}: {name}")
    assert not missing_in_file, f"grant service_role in the migration that creates: {missing_in_file}"
    missing = sorted(n for n in created if n not in granted_anywhere)
    assert not missing, f"no service_role grant for: {missing}"


def test_the_checker_catches_a_missing_grant():
    assert _granted("grant select, insert on table public.a, public.b to service_role;") == {"a", "b"}
    assert _granted("grant select on a to authenticated;") == set()
    assert _granted("grant execute on function public.f(int) to service_role;") == set()
