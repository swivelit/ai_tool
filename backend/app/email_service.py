from __future__ import annotations

import os
import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Protocol

from .auth import is_production_environment


class EmailServiceConfigurationError(RuntimeError):
    pass


class EmailSender(Protocol):
    def send(self, *, to_email: str, subject: str, text_body: str) -> None:
        ...


@dataclass(frozen=True)
class SmtpSettings:
    username: str
    password: str
    from_email: str
    host: str
    port: int
    use_tls: bool


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def get_smtp_settings() -> SmtpSettings:
    username = os.getenv("EMAIL_USER", "").strip()
    password = os.getenv("EMAIL_PASS", "").strip()
    from_email = os.getenv("EMAIL_FROM", "").strip() or username
    host = os.getenv("SMTP_HOST", "").strip() or "smtp.gmail.com"

    try:
        port = int(os.getenv("SMTP_PORT", "").strip() or "587")
    except ValueError:
        port = 587

    if not username or not password or not from_email:
        raise EmailServiceConfigurationError(
            "Email delivery is not configured. Set EMAIL_USER and EMAIL_PASS on the backend."
        )

    return SmtpSettings(
        username=username,
        password=password,
        from_email=from_email,
        host=host,
        port=port,
        use_tls=_env_bool("SMTP_USE_TLS", True),
    )


class SmtpEmailSender:
    def __init__(self, settings: SmtpSettings | None = None) -> None:
        self.settings = settings or get_smtp_settings()

    def send(self, *, to_email: str, subject: str, text_body: str) -> None:
        message = EmailMessage()
        message["From"] = self.settings.from_email
        message["To"] = to_email
        message["Subject"] = subject
        message.set_content(text_body)

        if self.settings.use_tls:
            context = ssl.create_default_context()
            with smtplib.SMTP(self.settings.host, self.settings.port, timeout=20) as smtp:
                smtp.starttls(context=context)
                smtp.login(self.settings.username, self.settings.password)
                smtp.send_message(message)
            return

        with smtplib.SMTP_SSL(
            self.settings.host,
            self.settings.port,
            context=ssl.create_default_context(),
            timeout=20,
        ) as smtp:
            smtp.login(self.settings.username, self.settings.password)
            smtp.send_message(message)


def get_email_sender() -> EmailSender:
    return SmtpEmailSender()


def build_otp_email_body(*, code: str, purpose: str, ttl_minutes: int) -> tuple[str, str]:
    if purpose == "password_reset":
        subject = "Your password reset code"
        action = "reset your password"
    else:
        subject = "Your account verification code"
        action = "create your account"

    body = (
        f"Your verification code is {code}.\n\n"
        f"Use this code to {action}. It expires in {ttl_minutes} minutes.\n\n"
        "If you did not request this code, you can ignore this email."
    )
    return subject, body


def safe_email_unavailable_detail() -> str:
    if is_production_environment():
        return "Email delivery is temporarily unavailable. Please try again later."
    return "Email delivery is not configured. Set EMAIL_USER and EMAIL_PASS on the backend."
