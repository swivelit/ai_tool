from __future__ import annotations

from pathlib import Path
import re

import yaml


ROOT = Path(__file__).resolve().parents[2]
BLUEPRINT = ROOT / "render.staging.yaml"
WORKFLOW = ROOT / ".github" / "workflows" / "deployed-smoke.yml"


def load_blueprint() -> dict:
    return yaml.safe_load(BLUEPRINT.read_text(encoding="utf-8"))


def staging_environment(data: dict) -> dict:
    projects = data["projects"]
    assert [project["name"] for project in projects] == ["Swico Staging"]
    environments = projects[0]["environments"]
    assert [environment["name"] for environment in environments] == ["Staging"]
    return environments[0]


def services_by_name(data: dict) -> dict[str, dict]:
    return {service["name"]: service for service in staging_environment(data)["services"]}


def env_vars(service: dict) -> dict[str, dict]:
    return {item["key"]: item for item in service["envVars"]}


def test_staging_blueprint_contains_required_safe_values():
    services = services_by_name(load_blueprint())
    assert set(services) == {
        "swico-api-staging", "swico-web-staging",
        "swico-upload-cache-staging", "swico-code-validator-staging",
        "swico-knowledge-worker-staging",
    }
    api = services["swico-api-staging"]
    values = {key: item.get("value") for key, item in env_vars(api).items() if "value" in item}
    assert values == {
        "APP_ENV": "staging",
        "WEB_APP_ENABLED": "true",
        "WEB_TURN_OPTIMIZER_ENABLED": "true",
        "WEB_TRIAG_ENABLED": "false",
        "WEB_TRIAG_SHADOW_MODE": "true",
        "WEB_TRIAG_POLICY_VERSION": "v1",
        "WEB_TRIAG_RELEASE_STATE": "controlled",
        "WEB_ROLLOUT_POLICY_VERSION": "v1",
        "WEB_ROLLOUT_TRIAG_MODE": "disabled",
        "WEB_ROLLOUT_TRIAG_PERCENT": "0",
        "WEB_ROLLOUT_KNOWLEDGE_MODE": "disabled",
        "WEB_ROLLOUT_KNOWLEDGE_PERCENT": "0",
        "WEB_ROLLOUT_REPOSITORY_MODE": "disabled",
        "WEB_ROLLOUT_REPOSITORY_PERCENT": "0",
        "WEB_ROLLOUT_ANSWER_GUARD_MODE": "disabled",
        "WEB_ROLLOUT_ANSWER_GUARD_PERCENT": "0",
        "WEB_TRIAG_ROLLOUT_REPORT_ENABLED": "false",
        "WEB_TRIAG_ROLLOUT_REPORT_DEFAULT_WINDOW_HOURS": "24",
        "WEB_TRIAG_ROLLOUT_REPORT_MAX_WINDOW_HOURS": "168",
        "WEB_TRIAG_ROLLOUT_ACCEPTANCE_MIN_SAMPLE": "20",
        "WEB_RAG_HYBRID_ENABLED": "false",
        "WEB_RAG_DENSE_ENABLED": "false",
        "WEB_RAG_RETRIEVAL_EVALUATOR_ENABLED": "false",
        "WEB_RAG_MAX_CORRECTIVE_ROUNDS": "2",
        "WEB_RAG_QUERY_EMBEDDING_CACHE_TTL_SECONDS": "86400",
        "WEB_RAG_EMBEDDING_MODEL": "text-embedding-3-small",
        "WEB_RAG_EMBEDDING_DIMENSIONS": "1536",
        "WEB_RAG_PERSISTENT_KNOWLEDGE_ENABLED": "false",
        "WEB_RAG_TRIPLET_ENABLED": "false",
        "WEB_RAG_HIERARCHY_ENABLED": "false",
        "WEB_KNOWLEDGE_JOB_BATCH_SIZE": "50",
        "WEB_KNOWLEDGE_WORKER_ENABLED": "false",
        "WEB_KNOWLEDGE_WORKER_POLL_SECONDS": "2",
        "WEB_KNOWLEDGE_WORKER_MAX_CONCURRENCY": "1",
        "WEB_RAG_LITE_CANDIDATE_LIMIT": "12",
        "WEB_RAG_LITE_EVIDENCE_ITEM_LIMIT": "4",
        "WEB_RAG_LITE_EVIDENCE_TOKEN_CAP": "1200",
        "WEB_RAG_STANDARD_CANDIDATE_LIMIT": "30",
        "WEB_RAG_STANDARD_EVIDENCE_ITEM_LIMIT": "7",
        "WEB_RAG_STANDARD_EVIDENCE_TOKEN_CAP": "3200",
        "WEB_RAG_PRO_CANDIDATE_LIMIT": "60",
        "WEB_RAG_PRO_EVIDENCE_ITEM_LIMIT": "12",
        "WEB_RAG_PRO_EVIDENCE_TOKEN_CAP": "6000",
        "WEB_ANSWER_GUARD_ENABLED": "false",
        "WEB_VERIFIED_STREAMING_ENABLED": "false",
        "WEB_ANSWER_GUARD_MODEL_VERIFIER_ENABLED": "false",
        "WEB_ANSWER_GUARD_REPAIR_ENABLED": "false",
        "WEB_ANSWER_GUARD_MAX_BUFFER_CHARACTERS": "200000",
        "WEB_REPOSITORY_UPLOAD_ENABLED": "false",
        "WEB_REPOSITORY_TTL_SECONDS": "3600",
        "WEB_REPOSITORY_MAX_ARCHIVE_BYTES": "26214400",
        "WEB_REPOSITORY_MAX_UNCOMPRESSED_BYTES": "104857600",
        "WEB_REPOSITORY_MAX_FILES": "5000",
        "WEB_REPOSITORY_MAX_COMPRESSION_RATIO": "100",
        "WEB_REPOSITORY_RATE_LIMIT_PER_MINUTE": "3",
        "WEB_RAG_REPOSITORY_INDEX_ENABLED": "false",
        "WEB_PRO_CODE_VALIDATION_ENABLED": "false",
        "WEB_CODE_VALIDATOR_URL": "http://swico-code-validator-staging:10001",
        "WEB_CODE_VALIDATOR_TIMEOUT_SECONDS": "90",
        "WEB_SAME_THREAD_CONTEXT_MODE": "adaptive",
        "WEB_SWICO_BRAND_GUARD_ENABLED": "true",
        "WEB_CONTEXT_MAX_TURNS": "2",
        "WEB_CONTEXT_MAX_CHARS": "900",
        "WEB_PROFILE_PROMPT_MAX_CHARS": "500",
        "WEB_SIMPLE_MAX_OUTPUT_TOKENS": "220",
        "WEB_NORMAL_MAX_OUTPUT_TOKENS": "420",
        "WEB_DETAILED_MAX_OUTPUT_TOKENS": "1800",
        "WEB_LONG_FORM_MAX_OUTPUT_TOKENS": "6000",
        "OPENAI_MAX_OUTPUT_TOKENS_HARD": "6000",
        "OPENAI_REASONING_EFFORT_SIMPLE": "none",
        "OPENAI_REASONING_EFFORT_NORMAL": "low",
        "OPENAI_REASONING_EFFORT_DETAILED": "low",
        "OPENAI_REASONING_EFFORT_LONG_FORM": "low",
        "WEB_PROVIDER_CALLS_PER_TURN_MAX": "1",
        "WEB_PROMPT_TOKEN_BREAKDOWN_ENABLED": "true",
        "WEB_CACHE_BEFORE_BILLING_ENABLED": "true",
        "WEB_PROMPT_CACHE_ENABLED": "false",
        "WEB_PROMPT_CACHE_VERSION": "v1",
        "WEB_MAX_PROVIDER_ATTEMPTS": "1",
        "WEB_MESSAGE_EDIT_ENABLED": "false",
        "WEB_CROSS_THREAD_MEMORY_ENABLED": "false",
        "WEB_MEMORY_MAX_ITEMS": "2",
        "WEB_MEMORY_MAX_CHARS": "1200",
        "WEB_MEMORY_LLM_SUMMARIZATION_ENABLED": "false",
        "WEB_LONG_INPUT_ENABLED": "false",
        "WEB_LONG_INPUT_INLINE_THRESHOLD_CHARS": "12000",
        "WEB_LONG_INPUT_MAX_CHARS": "64000",
        "WEB_DOCUMENT_OCR_ENABLED": "false",
        "WEB_LEGACY_DOC_CONVERSION_ENABLED": "false",
        "WEB_ATTACHMENTS_ENABLED": "true",
        "WEB_VOICE_RECORDING_ENABLED": "true",
        "WEB_VOICE_REPLY_ENABLED": "false",
        "WEB_VOICE_BILLING_ENABLED": "false",
        "WEB_REALTIME_VOICE_ENABLED": "false",
        "WEB_REALTIME_VOICE_PLAYBACK_MODE": "pcm_stream",
        "WEB_REALTIME_VOICE_BACKCHANNEL_ENABLED": "false",
        "WEB_SEPARATE_VOICE_CREDITS_ENABLED": "false",
        "WEB_REALTIME_VOICE_SESSION_TICKET_TTL_SECONDS": "60",
        "WEB_REALTIME_VOICE_MAX_SESSION_SECONDS": "900",
        "WEB_REALTIME_VOICE_IDLE_TIMEOUT_SECONDS": "60",
        "WEB_REALTIME_VOICE_MAX_CONCURRENT_SESSIONS_PER_USER": "1",
        "WEB_REALTIME_VOICE_START_RATE_LIMIT_PER_MINUTE": "5",
        "WEB_UPLOAD_TTL_SECONDS": "300",
        "WEB_IMAGE_UPLOADS_ENABLED": "true",
        "WEB_UPLOAD_MAX_FILE_BYTES": "10485760",
        "WEB_UPLOAD_MAX_FILES_PER_MESSAGE": "5",
        "WEB_UPLOAD_MAX_TOTAL_BYTES": "26214400",
        "WEB_UPLOAD_MAX_EXTRACTED_CHARS": "100000",
        "WEB_ATTACHMENT_PROMPT_MAX_CHARS": "6000",
        "WEB_AUDIO_MAX_SECONDS": "30",
        "WEB_STT_MODE": "transcribe",
        "WEB_TTS_MAX_CHARACTERS": "5000",
        "WEB_UPLOAD_RATE_LIMIT_PER_MINUTE": "10",
        "WEB_STT_RATE_LIMIT_PER_MINUTE": "10",
        "WEB_TTS_RATE_LIMIT_PER_MINUTE": "10",
        "WEB_UPLOAD_STORE_RAW": "false",
        "LOG_CHAT_CONTENT": "false",
        "AUTH_ALLOW_DEV_TOKENS": "false",
        "EMAIL_OTP_DEV_RETURN_CODE": "false",
        "AUTO_CREATE_TABLES": "false",
        "RUN_MIGRATIONS_ON_STARTUP": "false",
        "REQUIRE_MIGRATIONS_BEFORE_STARTUP": "false",
        "BILLING_CHECKOUT_ENABLED": "false",
        "BILLING_CREDIT_PERCENT": "50",
        "RAZORPAY_MODE": "test",
        "AI_PROVIDER_ROUTING_MODE": "openai_only",
        "USAGE_ESTIMATE_REFERENCE_PROVIDER": "openai",
        "USAGE_ESTIMATE_REFERENCE_MODEL": "gpt-5-nano",
        "SENTRY_TRACES_SAMPLE_RATE": "0.05",
        "SENTRY_PROFILES_SAMPLE_RATE": "0",
        "GOOGLE_APPLICATION_CREDENTIALS": "/etc/secrets/firebase-admin-staging.json",
    }
    assert api["healthCheckPath"] == "/api/web/health"


def test_staging_blueprint_has_all_sync_false_placeholders():
    services = services_by_name(load_blueprint())
    api_vars = env_vars(services["swico-api-staging"])
    for key in (
        "CORS_ALLOW_ORIGINS", "OPENAI_API_KEY", "RAZORPAY_KEY_ID",
        "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "SENTRY_DSN",
    ):
        assert api_vars[key] == {"key": key, "sync": False}
    web_vars = env_vars(services["swico-web-staging"])
    for key in (
        "VITE_API_BASE_URL", "VITE_FIREBASE_API_KEY", "VITE_FIREBASE_AUTH_DOMAIN",
        "VITE_FIREBASE_PROJECT_ID", "VITE_FIREBASE_APP_ID",
        "VITE_FIREBASE_MESSAGING_SENDER_ID",
    ):
        assert web_vars[key] == {"key": key, "sync": False}


def test_staging_blueprint_cannot_reference_production_resources_or_groups():
    data = load_blueprint()
    environment = staging_environment(data)
    databases = environment["databases"]
    assert [database["name"] for database in databases] == ["swico-postgres-staging"]
    assert databases[0]["ipAllowList"] == []
    services = services_by_name(data)
    api = services["swico-api-staging"]
    assert api["region"] == databases[0]["region"]
    assert env_vars(api)["DATABASE_URL"] == {
        "key": "DATABASE_URL",
        "fromDatabase": {"name": "swico-postgres-staging", "property": "connectionString"},
    }
    assert env_vars(api)["WEB_UPLOAD_CACHE_URL"] == {
        "key": "WEB_UPLOAD_CACHE_URL",
        "fromService": {
            "type": "keyvalue", "name": "swico-upload-cache-staging",
            "property": "connectionString",
        },
    }
    cache = services["swico-upload-cache-staging"]
    assert cache == {
        "type": "keyvalue", "name": "swico-upload-cache-staging",
        "region": "singapore", "plan": "starter", "ipAllowList": [],
        "maxmemoryPolicy": "allkeys-lru", "persistenceMode": "off",
    }
    validator = services["swico-code-validator-staging"]
    assert validator["type"] == "pserv"
    assert validator["region"] == api["region"]
    assert validator["startCommand"] == (
        "uvicorn app.code_validator.main:app --app-dir backend "
        "--host 0.0.0.0 --port 10001"
    )
    validator_vars = env_vars(validator)
    assert validator_vars == {
        "CODE_VALIDATOR_AUTH_TOKEN": {
            "key": "CODE_VALIDATOR_AUTH_TOKEN", "generateValue": True,
        },
        "CODE_VALIDATOR_ISOLATION_PROOF": {
            "key": "CODE_VALIDATOR_ISOLATION_PROOF", "value": "static-only",
        },
        "CODE_VALIDATOR_NETWORK_ISOLATED": {
            "key": "CODE_VALIDATOR_NETWORK_ISOLATED", "value": "false",
        },
        "CODE_VALIDATOR_TIMEOUT_SECONDS": {
            "key": "CODE_VALIDATOR_TIMEOUT_SECONDS", "value": "90",
        },
        "CODE_VALIDATOR_MAX_OUTPUT_BYTES": {
            "key": "CODE_VALIDATOR_MAX_OUTPUT_BYTES", "value": "65536",
        },
    }
    forbidden_validator_keys = {
        "OPENAI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "DATABASE_URL",
        "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "FIREBASE_CREDENTIALS_JSON",
        "SMTP_PASSWORD", "SARVAM_API_KEY",
    }
    assert forbidden_validator_keys.isdisjoint(validator_vars)
    worker = services["swico-knowledge-worker-staging"]
    worker_vars = env_vars(worker)
    assert worker["type"] == "worker"
    assert worker["region"] == api["region"]
    assert worker["startCommand"] == "cd backend && python -m app.knowledge_worker"
    assert worker_vars["DATABASE_URL"] == {
        "key": "DATABASE_URL",
        "fromDatabase": {
            "name": "swico-postgres-staging",
            "property": "connectionString",
        },
    }
    assert worker_vars["OPENAI_API_KEY"] == {
        "key": "OPENAI_API_KEY", "sync": False,
    }
    forbidden_worker_keys = {
        "GOOGLE_APPLICATION_CREDENTIALS", "FIREBASE_CREDENTIALS_JSON",
        "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET",
        "SMTP_HOST", "SMTP_PASSWORD", "DOWNLOAD_TOKEN_SECRET",
        "WEB_CODE_VALIDATOR_URL", "WEB_CODE_VALIDATOR_AUTH_TOKEN",
        "WEB_UPLOAD_CACHE_URL", "SARVAM_API_KEY",
    }
    assert forbidden_worker_keys.isdisjoint(worker_vars)
    serialized = BLUEPRINT.read_text(encoding="utf-8").lower()
    assert "tamil_voice_ai_db" not in serialized
    assert "fromgroup" not in serialized
    assert "envVarGroups" not in data
    assert "envVarGroups" not in environment
    assert not any("prod" in resource["name"].lower() for resource in [*environment["services"], *databases])


def test_staging_static_site_includes_exact_security_headers():
    web = services_by_name(load_blueprint())["swico-web-staging"]
    actual = {header["name"]: header["value"] for header in web["headers"]}
    expected: dict[str, str] = {}
    for line in (ROOT / "web" / "public" / "_headers").read_text(encoding="utf-8").splitlines()[1:]:
        if line.strip():
            name, value = line.strip().split(":", 1)
            expected[name] = value.strip()
    assert actual == expected
    assert actual["Strict-Transport-Security"] == "max-age=31536000; includeSubDomains"
    assert "preload" not in actual["Strict-Transport-Security"].lower()
    assert web["routes"] == [{"type": "rewrite", "source": "/*", "destination": "/index.html"}]


def test_public_headers_preserve_voice_csp_and_nonduplicated_permissions_policy():
    source = (ROOT / "web" / "public" / "_headers").read_text(encoding="utf-8")
    assert "Permissions-Policy: camera=(), geolocation=(), microphone=(self)" in source
    assert "Permissions-Policy: Permissions-Policy:" not in source
    assert "connect-src 'self' https: wss:" in source
    assert "img-src 'self' data: blob: https:" in source
    assert "media-src 'self' blob:" in source


def test_web_meta_csp_allows_blob_image_previews_without_broadening_scripts():
    source = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    match = re.search(
        r'<meta[^>]+http-equiv="Content-Security-Policy"[^>]+content="([^"]+)"',
        source,
    )
    assert match
    directives = {
        parts[0]: set(parts[1:])
        for parts in (segment.strip().lower().split() for segment in match.group(1).split(";"))
        if parts and parts[0]
    }
    assert directives["img-src"] >= {"'self'", "data:", "blob:", "https:"}
    assert directives["media-src"] >= {"'self'", "blob:"}
    assert "blob:" not in directives["script-src"]


def test_workflow_selects_exact_test_file_for_each_mode():
    source = WORKFLOW.read_text(encoding="utf-8")
    assert "staging) test_file='e2e/deployed-smoke.spec.ts'" in source
    assert "production-readonly) test_file='e2e/deployed-readonly.spec.ts'" in source
    assert "production-triag) test_file='e2e/production-triag.spec.ts'" in source
    assert "production-capability) test_file='e2e/production-capability.spec.ts'" in source
    assert 'npx playwright test "$test_file" --project=chromium --project=mobile-chromium' in source
    assert 'npx playwright test "$test_file" --project=chromium --workers=1' in source
    assert "I_UNDERSTAND_THIS_WRITES_TO_PRODUCTION" in source
    assert "I_UNDERSTAND_THIS_RUNS_BILLABLE_PRODUCTION_CAPABILITY_TESTS" in source
    assert (
        "environment:\n      name: ${{ inputs.mode == 'production-capability' "
        "&& 'production-triag' || inputs.mode }}"
    ) in source
    assert "retention-days: 7" in source
    assert "RENDER_API_KEY" not in source
    assert source.index("python scripts/check-web-security-headers.py") < source.index('npx playwright test "$test_file"')
    for name in ("PLAYWRIGHT_BASE_URL", "E2E_TEST_EMAIL", "E2E_TEST_PASSWORD"):
        assert f"{name}: ${{{{ secrets.{name} }}}}" in source


def test_workflow_has_read_only_permissions_and_concurrency_protection():
    data = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    assert data["permissions"] == {"contents": "read"}
    assert data["concurrency"] == {
        "group": (
            "${{ inputs.mode == 'production-triag' && "
            "'production-triag-acceptance' || "
            "inputs.mode == 'production-capability' && "
            "'production-capability-benchmark' || "
            "format('deployed-smoke-{0}', inputs.mode) }}"
        ),
        "cancel-in-progress": False,
    }
    environment = data["jobs"]["playwright"]["environment"]
    assert environment == {
        "name": (
            "${{ inputs.mode == 'production-capability' && "
            "'production-triag' || inputs.mode }}"
        ),
        "deployment": False,
    }


def test_workflow_does_not_print_secret_values():
    data = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    run_blocks = "\n".join(
        str(step.get("run", "")) for step in data["jobs"]["playwright"]["steps"]
    )
    forbidden_print = re.compile(
        r"(?:echo|printf).*\$(?:\{)?(?:E2E_TEST_EMAIL|E2E_TEST_PASSWORD|PLAYWRIGHT_BASE_URL)(?:\})?"
    )
    assert not forbidden_print.search(run_blocks)
    assert "Authorization" not in run_blocks
    assert "firebase token" not in run_blocks.lower()
    assert "if: failure()" in WORKFLOW.read_text(encoding="utf-8")
