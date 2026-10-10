import smtplib

import pytest

from pipeline import deliver
from pipeline.deliver import DeliveryError, send_email

ENV = {"GMAIL_ADDRESS": "someone@example.com", "GMAIL_APP_PASSWORD": "abcd efgh ijkl mnop"}


class FakeSMTP:
    instances: list["FakeSMTP"] = []

    def __init__(self, host, port, timeout):
        self.host, self.port = host, port
        self.sent = []
        FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def starttls(self, context):
        self.tls = True

    def login(self, user, password):
        self.login_args = (user, password)

    def send_message(self, msg):
        self.sent.append(msg)


@pytest.fixture
def fake_smtp(monkeypatch):
    FakeSMTP.instances.clear()
    monkeypatch.setattr(deliver.smtplib, "SMTP", FakeSMTP)
    return FakeSMTP


def test_sends_to_self_over_starttls(fake_smtp):
    send_email("subj", "body", env=ENV)
    smtp = fake_smtp.instances[0]
    assert (smtp.host, smtp.port) == ("smtp.gmail.com", 587)
    assert smtp.tls
    assert smtp.login_args == ("someone@example.com", "abcdefghijklmnop")  # spaces stripped
    assert smtp.sent[0]["To"] == "someone@example.com"


def test_missing_credentials():
    with pytest.raises(DeliveryError, match="must be set"):
        send_email("s", "b", env={})


def test_auth_error_does_not_leak_password(monkeypatch):
    class BadLogin(FakeSMTP):
        def login(self, user, password):
            raise smtplib.SMTPAuthenticationError(535, b"bad " + password.encode())

    monkeypatch.setattr(deliver.smtplib, "SMTP", BadLogin)
    with pytest.raises(DeliveryError) as exc:
        send_email("s", "b", env=ENV)
    assert "abcd" not in str(exc.value)
