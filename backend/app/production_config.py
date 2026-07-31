from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal, InvalidOperation
import os
from urllib.parse import urlsplit

from .database_url import is_postgres_database_url
from .ai.swico_tiers import SWICO_TIER_IDS, SWICO_TIER_MODEL_ALLOWLIST
from .ai.openai_catalog import CURRENT_SWICO_STANDARD_RATES, price_environment_names
from .web_ai.settings import TriagConfigurationError, TriagSettings


class ProductionConfigurationError(RuntimeError):
    """Raised with variable names only; configuration values are never included."""

    def __init__(self, errors: list[str]):
        self.errors = tuple(errors)
        super().__init__("Invalid production configuration: " + "; ".join(errors))


_TRUE = {"1", "true", "yes", "y", "on"}
_FALSE = {"0", "false", "no", "n", "off"}


def _value(env: Mapping[str, str], name: str, default: str = "") -> str:
    return str(env.get(name, default) or "").strip()


def _bool(env: Mapping[str, str], name: str, default: bool) -> bool | None:
    raw = _value(env, name, "true" if default else "false").lower()
    if raw in _TRUE:
        return True
    if raw in _FALSE:
        return False
    return None


def _decimal(env: Mapping[str, str], name: str, default: str) -> Decimal | None:
    try:
        return Decimal(_value(env, name, default))
    except (InvalidOperation, ValueError):
        return None


def _integer(env: Mapping[str, str], name: str, default: str) -> int | None:
    try:
        return int(_value(env, name, default))
    except ValueError:
        return None


def _exact_https_origin(origin: str) -> bool:
    if not origin or origin.endswith("/") or "*" in origin:
        return False
    parsed = urlsplit(origin)
    return bool(
        parsed.scheme == "https"
        and parsed.hostname
        and not parsed.username
        and not parsed.password
        and not parsed.path
        and not parsed.query
        and not parsed.fragment
        and origin == f"https://{parsed.netloc}"
    )


def production_configuration_errors(environ: Mapping[str, str] | None = None) -> list[str]:
    env = os.environ if environ is None else environ
    errors: list[str] = []

    if _value(env, "APP_ENV").lower() not in {"prod", "production"}:
        errors.append("APP_ENV must be production")

    required_false = (
        "LOG_CHAT_CONTENT",
        "AUTH_ALLOW_DEV_TOKENS",
        "AUTO_CREATE_TABLES",
        "RUN_MIGRATIONS_ON_STARTUP",
        "REQUIRE_MIGRATIONS_BEFORE_STARTUP",
        "EMAIL_OTP_DEV_RETURN_CODE",
    )
    for name in required_false:
        parsed = _bool(env, name, False)
        if parsed is not False:
            errors.append(f"{name} must be false")

    if _bool(env, "WEB_APP_ENABLED", False) is not True:
        errors.append("WEB_APP_ENABLED must be true")
    if _bool(env, "WEB_SIMPLE_TURN_TIER_DOWNSHIFT_ENABLED", False) is None:
        errors.append("WEB_SIMPLE_TURN_TIER_DOWNSHIFT_ENABLED must be a boolean")
    try:
        TriagSettings.from_environ(env)
    except TriagConfigurationError as exc:
        errors.extend(exc.errors)

    voice_recording = _bool(env, "WEB_VOICE_RECORDING_ENABLED", False)
    voice_reply = _bool(env, "WEB_VOICE_REPLY_ENABLED", False)
    voice_billing = _bool(env, "WEB_VOICE_BILLING_ENABLED", False)
    for name, parsed in (
        ("WEB_VOICE_RECORDING_ENABLED", voice_recording),
        ("WEB_VOICE_REPLY_ENABLED", voice_reply),
        ("WEB_VOICE_BILLING_ENABLED", voice_billing),
    ):
        if parsed is None:
            errors.append(f"{name} must be a boolean")
    if voice_reply is True and voice_billing is not True:
        errors.append("WEB_VOICE_REPLY_ENABLED requires WEB_VOICE_BILLING_ENABLED")
    if voice_billing is True and voice_recording is not True:
        errors.append("WEB_VOICE_BILLING_ENABLED requires WEB_VOICE_RECORDING_ENABLED")
    realtime_voice = _bool(env, "WEB_REALTIME_VOICE_ENABLED", False)
    separate_voice = _bool(env, "WEB_SEPARATE_VOICE_CREDITS_ENABLED", False)
    adaptive_endpointing = _bool(env, "WEB_REALTIME_VOICE_ADAPTIVE_ENDPOINTING_ENABLED", True)
    if realtime_voice is None:
        errors.append("WEB_REALTIME_VOICE_ENABLED must be a boolean")
    if separate_voice is None:
        errors.append("WEB_SEPARATE_VOICE_CREDITS_ENABLED must be a boolean")
    if adaptive_endpointing is None:
        errors.append("WEB_REALTIME_VOICE_ADAPTIVE_ENDPOINTING_ENABLED must be a boolean")
    if realtime_voice is True and separate_voice is not True:
        errors.append("WEB_REALTIME_VOICE_ENABLED requires WEB_SEPARATE_VOICE_CREDITS_ENABLED")
    if realtime_voice is True and voice_billing is not True:
        errors.append("WEB_REALTIME_VOICE_ENABLED requires WEB_VOICE_BILLING_ENABLED")
    if realtime_voice is True and not _value(env, "WEB_UPLOAD_CACHE_URL"):
        errors.append("WEB_REALTIME_VOICE_ENABLED requires WEB_UPLOAD_CACHE_URL")
    if _value(env, "SARVAM_STT_STREAM_MESSAGE_ENCODING", "audio/wav").lower() not in {
        "audio/wav", "pcm_s16le",
    }:
        errors.append("SARVAM_STT_STREAM_MESSAGE_ENCODING is unsupported")
    if _value(env, "WEB_REALTIME_VOICE_PLAYBACK_MODE", "buffered_mp3").lower() not in {
        "buffered_mp3", "pcm_stream", "auto",
    }:
        errors.append("WEB_REALTIME_VOICE_PLAYBACK_MODE is unsupported")
    if _value(env, "SARVAM_TTS_STREAM_OUTPUT_CODEC", "mp3").lower() not in {
        "mp3", "linear16",
    }:
        errors.append("SARVAM_TTS_STREAM_OUTPUT_CODEC is unsupported")
    tts_sample_rate = _integer(env, "SARVAM_TTS_STREAM_SAMPLE_RATE", "24000")
    if tts_sample_rate not in {8000, 16000, 22050, 24000}:
        errors.append("SARVAM_TTS_STREAM_SAMPLE_RATE is unsupported")
    playback_mode = _value(env, "WEB_REALTIME_VOICE_PLAYBACK_MODE", "buffered_mp3").lower()
    tts_codec = _value(env, "SARVAM_TTS_STREAM_OUTPUT_CODEC", "mp3").lower()
    if playback_mode == "buffered_mp3" and tts_codec != "mp3":
        errors.append("WEB_REALTIME_VOICE_PLAYBACK_MODE buffered_mp3 requires SARVAM_TTS_STREAM_OUTPUT_CODEC mp3")
    if playback_mode == "pcm_stream" and tts_codec != "linear16":
        errors.append("WEB_REALTIME_VOICE_PLAYBACK_MODE pcm_stream requires SARVAM_TTS_STREAM_OUTPUT_CODEC linear16")
    for name, default in (
        ("WEB_REALTIME_VOICE_SESSION_TICKET_TTL_SECONDS", "60"),
        ("WEB_REALTIME_VOICE_MAX_SESSION_SECONDS", "900"),
        ("WEB_REALTIME_VOICE_IDLE_TIMEOUT_SECONDS", "60"),
        ("WEB_REALTIME_VOICE_MAX_CONCURRENT_SESSIONS_PER_USER", "1"),
        ("WEB_REALTIME_VOICE_START_RATE_LIMIT_PER_MINUTE", "5"),
    ):
        configured = _integer(env, name, default)
        if configured is None or configured <= 0:
            errors.append(f"{name} must be a positive integer")
    concurrency = _integer(env, "WEB_REALTIME_VOICE_MAX_CONCURRENT_SESSIONS_PER_USER", "1")
    if concurrency is not None and concurrency != 1:
        errors.append("WEB_REALTIME_VOICE_MAX_CONCURRENT_SESSIONS_PER_USER must be 1")
    for name, default in (
        ("WEB_REALTIME_VOICE_END_SILENCE_MS", "900"),
        ("WEB_REALTIME_VOICE_UNFINISHED_GRACE_MS", "650"),
        ("WEB_REALTIME_VOICE_MAX_ENDPOINT_WAIT_MS", "1800"),
        ("WEB_REALTIME_VOICE_MIN_SPEECH_MS", "250"),
        ("WEB_REALTIME_VOICE_MAX_UTTERANCE_MS", "30000"),
        ("WEB_REALTIME_VOICE_BARGE_IN_MIN_MS", "180"),
        ("WEB_REALTIME_VOICE_PREROLL_MS", "320"),
        ("RAZORPAY_READ_RETRY_ATTEMPTS", "3"),
        ("RAZORPAY_READ_RETRY_BASE_MS", "500"),
        ("RAZORPAY_READ_RETRY_MAX_MS", "4000"),
        ("RAZORPAY_HTTP_TIMEOUT_SECONDS", "15"),
    ):
        configured = _integer(env, name, default)
        if configured is None or configured <= 0:
            errors.append(f"{name} must be a positive integer")
    endpoint_wait = _integer(env, "WEB_REALTIME_VOICE_MAX_ENDPOINT_WAIT_MS", "1800")
    end_silence = _integer(env, "WEB_REALTIME_VOICE_END_SILENCE_MS", "900")
    if endpoint_wait is not None and end_silence is not None and endpoint_wait < end_silence:
        errors.append("WEB_REALTIME_VOICE_MAX_ENDPOINT_WAIT_MS must be at least WEB_REALTIME_VOICE_END_SILENCE_MS")
    if endpoint_wait is not None and endpoint_wait > 10_000:
        errors.append("WEB_REALTIME_VOICE_MAX_ENDPOINT_WAIT_MS must be at most 10000")
    max_utterance = _integer(env, "WEB_REALTIME_VOICE_MAX_UTTERANCE_MS", "30000")
    if endpoint_wait is not None and max_utterance is not None and max_utterance <= endpoint_wait:
        errors.append("WEB_REALTIME_VOICE_MAX_UTTERANCE_MS must be greater than WEB_REALTIME_VOICE_MAX_ENDPOINT_WAIT_MS")
    retry_base = _integer(env, "RAZORPAY_READ_RETRY_BASE_MS", "500")
    retry_max = _integer(env, "RAZORPAY_READ_RETRY_MAX_MS", "4000")
    if retry_base is not None and retry_max is not None and retry_max < retry_base:
        errors.append("RAZORPAY_READ_RETRY_MAX_MS must be at least RAZORPAY_READ_RETRY_BASE_MS")
    for name, default in (
        ("WEB_TTS_MAX_CHARACTERS", "5000"),
        ("WEB_STT_RATE_LIMIT_PER_MINUTE", "10"),
        ("WEB_TTS_RATE_LIMIT_PER_MINUTE", "10"),
    ):
        configured = _integer(env, name, default)
        if configured is None or configured <= 0:
            errors.append(f"{name} must be a positive integer")
    for name, default in (
        ("SARVAM_PRICE_STT_INR_PER_HOUR", "30"),
        ("SARVAM_PRICE_TTS_V2_INR_PER_10K_CHARS", "15"),
        ("SARVAM_PRICE_TTS_V3_INR_PER_10K_CHARS", "30"),
    ):
        configured = _decimal(env, name, default)
        if configured is None or configured <= 0:
            errors.append(f"{name} must be a positive decimal")

    default_tier = _value(env, "SWICO_DEFAULT_TIER", "lite").lower()
    if default_tier not in SWICO_TIER_IDS:
        errors.append("SWICO_DEFAULT_TIER is unsupported")
    selection_enabled = _bool(env, "SWICO_TIER_SELECTION_ENABLED", True)
    pro_is_enabled = _bool(env, "SWICO_PRO_ENABLED", False)
    if selection_enabled is None:
        errors.append("SWICO_TIER_SELECTION_ENABLED must be a boolean")
    if pro_is_enabled is None:
        errors.append("SWICO_PRO_ENABLED must be a boolean")
    if default_tier == "pro" and pro_is_enabled is not True:
        errors.append("SWICO_DEFAULT_TIER cannot be pro while SWICO_PRO_ENABLED is false")
    configured_tier_models: dict[str, list[str]] = {}
    for tier_name in ("LITE", "STANDARD", "PRO"):
        primary_name = f"SWICO_{tier_name}_MODEL_PRIMARY"
        fallbacks_name = f"SWICO_{tier_name}_MODEL_FALLBACKS"
        primary = _value(env, primary_name)
        fallbacks = [item.strip() for item in _value(env, fallbacks_name).split(",") if item.strip()]
        if not primary:
            errors.append(f"{primary_name} must be configured")
        elif primary not in SWICO_TIER_MODEL_ALLOWLIST:
            errors.append(f"{primary_name} must use an allowlisted model")
        if not fallbacks:
            errors.append(f"{fallbacks_name} must configure at least one fallback")
        elif any(model not in SWICO_TIER_MODEL_ALLOWLIST for model in fallbacks):
            errors.append(f"{fallbacks_name} must use only allowlisted models")
        configured_tier_models[tier_name] = [primary, *fallbacks]

    if _value(env, "OPENAI_PRICING_AS_OF") != "2026-07-17":
        errors.append("OPENAI_PRICING_AS_OF must be configured")
    enabled_tiers = ["LITE", "STANDARD"]
    if pro_is_enabled is True:
        enabled_tiers.append("PRO")
    enabled_models = {
        model
        for tier_name in enabled_tiers
        for model in configured_tier_models.get(tier_name, [])
        if model in SWICO_TIER_MODEL_ALLOWLIST
    }
    for model in sorted(enabled_models):
        expected_rates = CURRENT_SWICO_STANDARD_RATES[model]
        for name, expected in zip(price_environment_names(model), expected_rates):
            rate = _decimal(env, name, "")
            if rate is None or rate <= 0 or rate != Decimal(expected):
                errors.append(f"{name} must be configured")

    if "BILLING_CHECKOUT_ENABLED" not in env or not _value(env, "BILLING_CHECKOUT_ENABLED"):
        errors.append("BILLING_CHECKOUT_ENABLED must be set explicitly")
    elif _bool(env, "BILLING_CHECKOUT_ENABLED", False) is None:
        errors.append("BILLING_CHECKOUT_ENABLED must be a boolean")

    database_url = _value(env, "DATABASE_URL")
    if not database_url:
        errors.append("DATABASE_URL must be configured")
    elif not is_postgres_database_url(database_url):
        errors.append("DATABASE_URL must use PostgreSQL in production")

    firebase_json_configured = bool(_value(env, "FIREBASE_CREDENTIALS_JSON"))
    firebase_file_configured = bool(_value(env, "GOOGLE_APPLICATION_CREDENTIALS"))
    if not (firebase_json_configured or firebase_file_configured):
        errors.append(
            "exactly one of FIREBASE_CREDENTIALS_JSON or "
            "GOOGLE_APPLICATION_CREDENTIALS must be configured"
        )
    elif firebase_json_configured and firebase_file_configured:
        errors.append(
            "FIREBASE_CREDENTIALS_JSON and GOOGLE_APPLICATION_CREDENTIALS "
            "cannot both be configured"
        )

    routing_mode = _value(env, "AI_PROVIDER_ROUTING_MODE", "cost_optimized").lower()
    if routing_mode not in {"cost_optimized", "language_optimized", "openai_only", "sarvam_only"}:
        errors.append("AI_PROVIDER_ROUTING_MODE is unsupported")
    if routing_mode != "sarvam_only" and not _value(env, "OPENAI_API_KEY"):
        errors.append("OPENAI_API_KEY must be configured for the selected routing mode")
    if routing_mode != "openai_only" and not _value(env, "SARVAM_API_KEY"):
        errors.append("SARVAM_API_KEY must be configured for the selected routing mode")
    if _bool(env, "OPENAI_ENABLE_GPT35_EMERGENCY_FALLBACK", False) is not False:
        errors.append("OPENAI_ENABLE_GPT35_EMERGENCY_FALLBACK must be false because the configured snapshot is deprecated")

    key_id = _value(env, "RAZORPAY_KEY_ID")
    key_secret = _value(env, "RAZORPAY_KEY_SECRET")
    webhook_secret = _value(env, "RAZORPAY_WEBHOOK_SECRET")
    razorpay_mode = _value(env, "RAZORPAY_MODE", "test").lower()
    if razorpay_mode not in {"test", "live"}:
        errors.append("RAZORPAY_MODE must be test or live")
    if not key_id:
        errors.append("RAZORPAY_KEY_ID must be configured")
    elif razorpay_mode == "test" and not key_id.startswith("rzp_test_"):
        errors.append("RAZORPAY_KEY_ID must use rzp_test_ in Test Mode")
    elif razorpay_mode == "live" and not key_id.startswith("rzp_live_"):
        errors.append("RAZORPAY_KEY_ID must use rzp_live_ in Live Mode")
    if not key_secret:
        errors.append("RAZORPAY_KEY_SECRET must be configured")
    if not webhook_secret:
        errors.append("RAZORPAY_WEBHOOK_SECRET must be configured")
    if key_secret and webhook_secret and key_secret == webhook_secret:
        errors.append("RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET must be distinct")

    if _decimal(env, "BILLING_CREDIT_PERCENT", "50") != Decimal("50"):
        errors.append("BILLING_CREDIT_PERCENT must be 50")
    minimum = _integer(env, "BILLING_MIN_TOPUP_PAISE", "1500")
    maximum = _integer(env, "BILLING_MAX_TOPUP_PAISE", "50000")
    if minimum is None or minimum <= 0:
        errors.append("BILLING_MIN_TOPUP_PAISE must be a positive integer")
    if maximum is None or maximum <= 0 or (minimum is not None and maximum < minimum):
        errors.append("BILLING_MAX_TOPUP_PAISE must be valid")
    if minimum is not None and maximum is not None and not (minimum <= 1500 <= maximum):
        errors.append("BILLING_MIN_TOPUP_PAISE and BILLING_MAX_TOPUP_PAISE must allow ₹15")
    enforce_packages = _bool(env, "BILLING_ENFORCE_TOPUP_PACKAGES", False)
    package_values: list[int] = []
    packages: set[int] = set()
    try:
        package_values = [int(item.strip()) for item in _value(env, "BILLING_TOPUP_PACKAGES_PAISE", "1500,29900").split(",") if item.strip()]
        packages = set(package_values)
    except ValueError:
        errors.append("BILLING_TOPUP_PACKAGES_PAISE must contain integers")
    if enforce_packages is None:
        errors.append("BILLING_ENFORCE_TOPUP_PACKAGES must be a boolean")
    elif enforce_packages:
        errors.append("BILLING_ENFORCE_TOPUP_PACKAGES must be false")
    if 1500 not in packages:
        errors.append("BILLING_TOPUP_PACKAGES_PAISE must include ₹15")
    if packages != {1500, 29900} or len(package_values) != 2:
        errors.append("BILLING_TOPUP_PACKAGES_PAISE must contain exactly ₹15 and ₹299")
    if minimum != 1500:
        errors.append("BILLING_MIN_TOPUP_PAISE must be 1500")
    if maximum is not None and (maximum < 29900 or maximum % 100 != 0):
        errors.append("BILLING_MAX_TOPUP_PAISE must be a whole-rupee bound allowing ₹299")

    origins = [item.strip() for item in _value(env, "CORS_ALLOW_ORIGINS").split(",") if item.strip()]
    if not origins:
        errors.append("CORS_ALLOW_ORIGINS must list approved HTTPS origins")
    elif len(origins) != len(set(origins)) or any(not _exact_https_origin(item) for item in origins):
        errors.append("CORS_ALLOW_ORIGINS must contain unique exact HTTPS origins without wildcards or trailing slashes")

    real_embeddings = _bool(env, "GLOBAL_QA_REAL_EMBEDDINGS_ENABLED", False)
    embedding_provider = _value(env, "GLOBAL_QA_EMBEDDING_PROVIDER", "token_hash").lower()
    if real_embeddings is True and embedding_provider not in {"openai", "token_hash", "token_hash_v1"}:
        errors.append("GLOBAL_QA_REAL_EMBEDDINGS_ENABLED cannot load a local embedding provider in the web service")

    return errors


def validate_production_configuration(environ: Mapping[str, str] | None = None) -> None:
    errors = production_configuration_errors(environ)
    if errors:
        raise ProductionConfigurationError(errors)
