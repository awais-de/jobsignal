import base64
import hashlib
import hmac
from datetime import date

import pytest

from pipeline.actions import action_links, make_token
from pipeline.digest import build_digest
from pipeline.models import RawPosting

PID = "11111111-2222-3333-4444-555555555555"


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def test_token_format_matches_edge_function():
    tok = make_token(PID, "apply", "s3cret", now=1_000_000)
    p, s = tok.split(".")
    payload = _unb64(p)
    assert payload == f"{PID}.apply.{1_000_000 + 14 * 86400}".encode()
    assert _unb64(s) == hmac.new(b"s3cret", payload, hashlib.sha256).digest()
    assert "=" not in tok and "+" not in tok and "/" not in tok    # URL-safe, unpadded


def test_unknown_action_rejected():
    with pytest.raises(ValueError):
        make_token(PID, "delete", "s")


def test_links_point_to_confirm_page():
    apply, skip = action_links(PID, "https://app.example.org/", "s")
    assert apply.startswith("https://app.example.org/a?t=") and skip.startswith("https://app.example.org/a?t=")
    assert apply != skip


def test_digest_renders_buttons():
    p = RawPosting(source="ba_api", source_job_id="1", company_name="Beispiel", title="Data Engineer",
                   posted_date=date(2026, 10, 9))
    _, text, html = build_digest([p], 1, date(2026, 10, 10), [("https://x/a?t=A", "https://x/a?t=S")])
    assert ">Apply</a>" in html and ">Skip</a>" in html
    assert "Apply: https://x/a?t=A" in text
