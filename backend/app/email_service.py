from __future__ import annotations

import os
import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Any, Protocol

from .auth import is_production_environment


EMAIL_DELIVERY_UNAVAILABLE_MESSAGE = (
    "Email delivery is temporarily unavailable. Please try again later."
)
DEFAULT_SMTP_HOST = "smtp.gmail.com"
DEFAULT_SMTP_PORT = 587


class EmailServiceConfigurationError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        missing: list[str] | None = None,
        invalid: list[str] | None = None,
        status: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.missing = list(missing or [])
        self.invalid = list(invalid or [])
        self.status = dict(status or {})


class EmailDeliverySendError(RuntimeError):
    def __init__(
        self,
        *,
        stage: str,
        exception_class: str,
        host: str,
        port: int,
        use_tls: bool,
    ) -> None:
        self.stage = stage
        self.exception_class = exception_class
        self.host = host
        self.port = port
        self.use_tls = use_tls
        super().__init__(
            "SMTP email delivery failed "
            f"stage={stage} exception_class={exception_class} "
            f"host={host} port={port} use_tls={use_tls}"
        )

    @classmethod
    def from_exception(
        cls,
        exc: BaseException,
        *,
        stage: str,
        settings: "SmtpSettings",
    ) -> "EmailDeliverySendError":
        return cls(
            stage=stage,
            exception_class=exc.__class__.__name__,
            host=settings.host,
            port=settings.port,
            use_tls=settings.use_tls,
        )


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


def _smtp_port_metadata() -> tuple[int | str, int | None, bool]:
    raw = os.getenv("SMTP_PORT", "").strip()
    if not raw:
        return DEFAULT_SMTP_PORT, DEFAULT_SMTP_PORT, True

    try:
        parsed = int(raw)
    except ValueError:
        return raw, None, False

    if parsed < 1 or parsed > 65535:
        return parsed, None, False
    return parsed, parsed, True


def _mask_email(value: str) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        return ""
    if "@" not in normalized:
        return "***"

    local, domain = normalized.split("@", 1)
    if not local:
        masked_local = "***"
    elif len(local) <= 2:
        masked_local = f"{local[:1]}***"
    else:
        masked_local = f"{local[:2]}***"
    return f"{masked_local}@{domain.lower()}"


def email_delivery_runtime_status(
    *,
    app_env: str | None = None,
    require_otp_secret: bool | None = None,
) -> dict[str, Any]:
    username = os.getenv("EMAIL_USER", "").strip()
    password = os.getenv("EMAIL_PASS", "").strip()
    from_env = os.getenv("EMAIL_FROM", "").strip()
    from_email = from_env or username
    host = os.getenv("SMTP_HOST", "").strip() or DEFAULT_SMTP_HOST
    port_value, _parsed_port, port_valid = _smtp_port_metadata()
    otp_secret = os.getenv("EMAIL_OTP_SECRET", "").strip()
    requires_otp_secret = (
        is_production_environment(app_env)
        if require_otp_secret is None
        else bool(require_otp_secret)
    )

    missing: list[str] = []
    invalid: list[str] = []
    if not username:
        missing.append("EMAIL_USER")
    if not password:
        missing.append("EMAIL_PASS")
    if not from_email:
        missing.append("EMAIL_FROM")
    if not host:
        missing.append("SMTP_HOST")
    if requires_otp_secret and not otp_secret:
        missing.append("EMAIL_OTP_SECRET")
    if not port_valid:
        invalid.append("SMTP_PORT")

    return {
        "configured": not missing and not invalid,
        "email_user_set": bool(username),
        "email_pass_set": bool(password),
        "email_from_set": bool(from_env),
        "email_otp_secret_set": bool(otp_secret),
        "smtp_host": host,
        "smtp_port": port_value,
        "smtp_use_tls": _env_bool("SMTP_USE_TLS", True),
        "from_matches_user": bool(
            username and from_email and username.lower() == from_email.lower()
        ),
        "missing": missing,
        "invalid": invalid,
        "masked_email_user": _mask_email(username),
        "masked_from_email": _mask_email(from_email),
    }


def validate_email_delivery_configuration(
    *,
    app_env: str | None = None,
    require_otp_secret: bool | None = None,
) -> dict[str, Any]:
    status = email_delivery_runtime_status(
        app_env=app_env,
        require_otp_secret=require_otp_secret,
    )
    missing = list(status.get("missing") or [])
    invalid = list(status.get("invalid") or [])
    if missing or invalid:
        raise EmailServiceConfigurationError(
            "Email delivery is not configured. Check backend SMTP/OTP environment variables.",
            missing=missing,
            invalid=invalid,
            status=status,
        )
    return status


def get_smtp_settings() -> SmtpSettings:
    validate_email_delivery_configuration(require_otp_secret=False)
    username = os.getenv("EMAIL_USER", "").strip()
    password = os.getenv("EMAIL_PASS", "").strip()
    from_email = os.getenv("EMAIL_FROM", "").strip() or username
    host = os.getenv("SMTP_HOST", "").strip() or DEFAULT_SMTP_HOST
    _port_value, port, _port_valid = _smtp_port_metadata()
    if port is None:  # validate_email_delivery_configuration already guarded this.
        port = DEFAULT_SMTP_PORT

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
            try:
                smtp = smtplib.SMTP(
                    self.settings.host,
                    self.settings.port,
                    timeout=20,
                )
            except Exception as exc:
                raise EmailDeliverySendError.from_exception(
                    exc,
                    stage="connect",
                    settings=self.settings,
                ) from None

            with smtp:
                try:
                    smtp.starttls(context=context)
                except Exception as exc:
                    raise EmailDeliverySendError.from_exception(
                        exc,
                        stage="starttls",
                        settings=self.settings,
                    ) from None
                try:
                    smtp.login(self.settings.username, self.settings.password)
                except Exception as exc:
                    raise EmailDeliverySendError.from_exception(
                        exc,
                        stage="login",
                        settings=self.settings,
                    ) from None
                try:
                    smtp.send_message(message)
                except Exception as exc:
                    raise EmailDeliverySendError.from_exception(
                        exc,
                        stage="send",
                        settings=self.settings,
                    ) from None
            return

        try:
            smtp = smtplib.SMTP_SSL(
                self.settings.host,
                self.settings.port,
                context=ssl.create_default_context(),
                timeout=20,
            )
        except Exception as exc:
            raise EmailDeliverySendError.from_exception(
                exc,
                stage="connect",
                settings=self.settings,
            ) from None

        with smtp:
            try:
                smtp.login(self.settings.username, self.settings.password)
            except Exception as exc:
                raise EmailDeliverySendError.from_exception(
                    exc,
                    stage="login",
                    settings=self.settings,
                ) from None
            try:
                smtp.send_message(message)
            except Exception as exc:
                raise EmailDeliverySendError.from_exception(
                    exc,
                    stage="send",
                    settings=self.settings,
                ) from None


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


def build_response_ready_email_body(
    *,
    message_preview: str | None = None,
    thread_id: str | None = None,
    request_id: str | None = None,
) -> tuple[str, str]:
    subject = "Swico AI response is ready"
    preview = " ".join(str(message_preview or "").split())
    if preview:
        if len(preview) > 160:
            preview = preview[:157] + "..."
        preview_text = f"Your recent search: {preview}"
    else:
        preview_text = ""

    lines = ["Your Swico AI response is ready."]
    if preview_text:
        lines.append("")
        lines.append(preview_text)
    lines.append("")
    lines.append("Open the Swico AI app to view the answer.")
    if thread_id:
        lines.append(f"Thread: {thread_id}")
    if request_id:
        lines.append(f"Request: {request_id}")
    lines.append("")
    lines.append("Thanks for using Swico AI.")
    return subject, "\n".join(lines)


def send_response_ready_email(
    *,
    to_email: str,
    message_preview: str | None = None,
    thread_id: str | None = None,
    request_id: str | None = None,
) -> None:
    subject, body = build_response_ready_email_body(
        message_preview=message_preview,
        thread_id=thread_id,
        request_id=request_id,
    )
    get_email_sender().send(to_email=to_email, subject=subject, text_body=body)


def safe_email_unavailable_detail() -> str:
    if is_production_environment():
        return EMAIL_DELIVERY_UNAVAILABLE_MESSAGE
    return "Email delivery is not configured. Set EMAIL_USER and EMAIL_PASS on the backend."
