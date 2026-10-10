"""Email delivery via Gmail SMTP with an app password (spec 7.10).

The dedicated address sends to itself. `python -m pipeline.deliver --test` sends
one test message; the smtp-test workflow runs it with the repo secrets.
"""

from __future__ import annotations

import argparse
import logging
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 587

log = logging.getLogger("jobsignal")


class DeliveryError(Exception):
    pass


def send_email(subject: str, text: str, html: str | None = None, env: dict[str, str] | None = None) -> None:
    env = os.environ if env is None else env
    address = env.get("GMAIL_ADDRESS")
    password = (env.get("GMAIL_APP_PASSWORD") or "").replace(" ", "")
    if not address or not password:
        raise DeliveryError("GMAIL_ADDRESS and GMAIL_APP_PASSWORD must be set.")

    msg = EmailMessage()
    msg["From"] = f"jobsignal <{address}>"
    msg["To"] = address
    msg["Subject"] = subject
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as smtp:
            smtp.starttls(context=ssl.create_default_context())
            smtp.login(address, password)
            smtp.send_message(msg)
    except smtplib.SMTPAuthenticationError:
        raise DeliveryError("Gmail rejected the login: check GMAIL_APP_PASSWORD.") from None
    except (smtplib.SMTPException, OSError) as exc:
        raise DeliveryError(f"Sending failed: {type(exc).__name__}") from None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pipeline.deliver")
    parser.add_argument("--test", action="store_true", help="send one test email")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if not args.test:
        parser.print_help()
        return 2
    try:
        send_email(
            "jobsignal: test email",
            "This is a test from the jobsignal smtp-test workflow. "
            "If you can read this, the daily digest can be delivered.",
        )
    except DeliveryError as exc:
        log.error("%s", exc)
        return 1
    log.info("test email sent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
