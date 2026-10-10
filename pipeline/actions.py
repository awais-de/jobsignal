"""Signed Apply/Skip links for the digest (spec 7.10).

Format must match supabase/functions/action/index.ts:
  base64url("<posting_id>.<action>.<expiry_unix>") + "." + base64url(HMAC-SHA256(secret, payload))
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time

TTL_DAYS = 14  # STARTING VALUE: links survive two weeks of neglect (spec 2.5)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_token(posting_id: str, action: str, secret: str, now: float | None = None,
               ttl_days: int = TTL_DAYS) -> str:
    if action not in ("apply", "skip"):
        raise ValueError(f"unknown action {action}")
    expiry = int((now or time.time()) + ttl_days * 86400)
    payload = f"{posting_id}.{action}.{expiry}".encode()
    sig = hmac.new(secret.encode(), payload, hashlib.sha256).digest()
    return f"{_b64url(payload)}.{_b64url(sig)}"


def action_links(posting_id: str, app_url: str, secret: str) -> tuple[str, str]:
    base = app_url.rstrip("/")
    return (f"{base}/a?t={make_token(posting_id, 'apply', secret)}",
            f"{base}/a?t={make_token(posting_id, 'skip', secret)}")
