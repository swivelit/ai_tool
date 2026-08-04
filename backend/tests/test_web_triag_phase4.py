from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import io
import hashlib
import json
import stat
from uuid import uuid4
import zipfile

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from app.code_validator.main import app as validator_app
from app.code_validator.isolation import detect_isolation_capabilities
from app.code_validator.settings import ValidatorSettings
from app.database import SessionLocal
from app.models import (
    WebCodeEdge, WebCodeFile, WebCodeRepository, WebCodeSymbol,
    WebChatThread, WebUsageStage,
)
from app.web_ai.code_quality.repository_archive import (
    ArchiveLimits,
    UnsafeRepositoryArchive,
    inspect_repository_zip,
)
from app.web_ai.code_quality.repository_index import (
    build_repository_index,
    source_file,
)
from app.web_ai.code_quality.result_parser import (
    RepositoryValidationResult,
    ValidationCheckResult,
    extract_proposed_files,
)
from app.web_ai.code_quality.validation_client import (
    RepositoryValidationClient,
    ValidationClientSettings,
    unavailable_result,
)
from app.web_ai.generation.answer_guard import AnswerGuard, AnswerGuardContext
from app.web_ai.generation.repository_grounding import (
    evaluate_repository_path_grounding,
)
from app.web_ai.persistence import get_or_create_usage_stage
from app.web_ai.retrieval.code_symbols import retrieve_repository_contract
from app.web_ai.settings import TriagSettings
from app.web_ai.tier_policy import tier_policy_for
from app.web_ai.triage import TriageInput, build_execution_plan
from app.web_api.conversation_continuity import SameThreadContinuityDecision
from app.web_api.repository_store import (
    EphemeralRepositorySnapshot,
    get_repository_snapshot,
    put_repository_snapshot,
)
from app.web_api.upload_store import InProcessEphemeralUploadStore
from app.web_api.chat_service import (
    AttachmentRequestError,
    _load_repository_snapshot_for_turn,
    _repository_index_manifest,
    _resolved_repository_validation_mode,
    prepare_web_turn,
)
from app.web_api import chat_service as web_chat_service
from tests.conftest import auth_headers, create_test_user


LIMITS = ArchiveLimits(1_000_000, 2_000_000, 100, 20)


def _zip(entries: dict[str, bytes | str], *, symlink: str | None = None) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as package:
        for path, value in entries.items():
            package.writestr(path, value)
        if symlink:
            info = zipfile.ZipInfo(symlink)
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            package.writestr(info, "target.py")
    return output.getvalue()


@pytest.mark.parametrize("path", [
    "../secret.py", "/absolute.py", "safe/../../escape.py", "bad\x00name.py",
])
def test_repository_archive_rejects_unsafe_paths(path):
    with pytest.raises(UnsafeRepositoryArchive):
        inspect_repository_zip(_zip({path: "x = 1"}), limits=LIMITS)


def test_repository_archive_rejects_symlink_nested_archive_and_zip_bomb():
    with pytest.raises(UnsafeRepositoryArchive, match="special_archive_entry"):
        inspect_repository_zip(_zip({}, symlink="link.py"), limits=LIMITS)
    with pytest.raises(UnsafeRepositoryArchive, match="nested_archive"):
        inspect_repository_zip(_zip({"nested.zip": b"PK"}), limits=LIMITS)
    with pytest.raises(UnsafeRepositoryArchive, match="compression_ratio"):
        inspect_repository_zip(
            _zip({"bomb.py": "x" * 200_000}),
            limits=ArchiveLimits(1_000_000, 1_000_000, 10, 2),
        )


def test_binary_and_dependency_directories_are_filtered():
    result = inspect_repository_zip(_zip({
        "app/main.py": "def hello(name: str) -> str:\n    return name\n",
        "node_modules/pkg/index.js": "throw new Error('never index me')",
        "assets/logo.png": b"\x89PNG\x00binary",
    }), limits=LIMITS)
    assert [item.path for item in result.files] == ["app/main.py"]
    assert result.ignored_file_count == 2


def _index():
    return build_repository_index((
        source_file(
            "app/main.py",
            "from fastapi import FastAPI\napp = FastAPI()\n"
            "@app.get('/items')\ndef list_items() -> list[str]:\n"
            "    return helper()\n",
        ),
        source_file(
            "app/helpers.py",
            "def helper() -> list[str]:\n    return ['one']\n",
        ),
        source_file(
            "tests/test_main.py",
            "from app.main import list_items\n"
            "def test_items():\n    assert list_items()\n",
        ),
        source_file(
            "web/client.ts",
            "import { api } from './api'\n"
            "export interface Item { id: string }\n"
            "export function loadItems(): Promise<Item[]> { return api.get() }\n",
        ),
        source_file(
            "package.json",
            json.dumps({
                "dependencies": {"react": "19.0.0", "typescript": "5.7.0"},
                "scripts": {"typecheck": "tsc --noEmit", "evil": "curl bad"},
            }),
        ),
    ))


def test_real_parsers_extract_symbols_routes_imports_and_contract_locators():
    index = _index()
    assert any(item.kind == "route" and item.name == "list_items" for item in index.symbols)
    assert any(item.kind == "interface" and item.name == "Item" for item in index.symbols)
    assert any(item.kind == "imports" and item.target == "fastapi:FastAPI" for item in index.edges)
    result = retrieve_repository_contract(
        owner_user_id=7,
        request_id="request-1",
        repository_id=str(uuid4()),
        source_version="abcdef123456",
        index=index,
        query="fix list_items in app/main.py and update its tests",
        token_cap=180,
        evidence_item_limit=2,
        required_validation_categories=("syntax", "typecheck", "test"),
    )
    assert result.contract.target_files[0] == "app/main.py"
    assert result.evidence_pack.total_token_count <= 180
    assert [item.citation_label for item in result.evidence_pack.items] == ["S1", "S2"]
    assert all(":" in item.source_locator for item in result.evidence_pack.items)
    assert "curl bad" not in result.contract.prompt_contract(1_000)


def test_index_metadata_drops_literal_defaults_and_private_dependency_urls():
    secret = "SUPER_SECRET_VALUE"
    index = build_repository_index((
        source_file(
            "app/secrets.py",
            f"def connect(token: str = '{secret}') -> str:\n    return token\n",
        ),
        source_file(
            "web/secrets.ts",
            f"export function connect(token = '{secret}'): string {{ return token }}",
        ),
        source_file(
            "package.json",
            json.dumps({
                "dependencies": {
                    "safe-package": "^1.2.3",
                    "private-package": f"https://{secret}@registry.invalid/pkg",
                },
            }),
        ),
    ))
    serialized = json.dumps({
        "symbols": [item.__dict__ for item in index.symbols],
        "dependencies": index.dependency_versions,
    })
    assert secret not in serialized
    assert ("safe-package", "^1.2.3") in index.dependency_versions
    assert not any(
        name == "private-package" for name, _ in index.dependency_versions
    )


def test_repository_contract_is_repeatable_and_token_bounded():
    kwargs = dict(
        owner_user_id=1, request_id="same",
        repository_id=str(uuid4()), source_version="version1",
        index=_index(), query="debug helper", token_cap=120,
        evidence_item_limit=3,
    )
    first = retrieve_repository_contract(**kwargs)
    second = retrieve_repository_contract(**kwargs)
    assert first == second
    assert first.evidence_pack.total_token_count <= 120


def test_repository_contract_honors_explicit_unchanged_files():
    result = retrieve_repository_contract(
        owner_user_id=1, request_id="unchanged",
        repository_id=str(uuid4()), source_version="version1",
        index=_index(),
        query=(
            "Fix list_items in app/main.py but do not change "
            "tests/test_main.py"
        ),
        token_cap=160, evidence_item_limit=3,
    )
    assert "app/main.py" in result.contract.target_files
    assert result.contract.unchanged_files == ("tests/test_main.py",)


def test_repository_prompt_manifest_is_pre_generation_and_index_scoped():
    index = _index()
    result = retrieve_repository_contract(
        owner_user_id=1, request_id="manifest",
        repository_id=str(uuid4()), source_version="version1",
        index=index, query="What does src/nonexistent.ts do?",
        token_cap=200, evidence_item_limit=3,
    )
    snapshot = EphemeralRepositorySnapshot(
        id=result.contract.repository_id,
        owner_user_id=1,
        source_version="version1",
        content_hash="content",
        created_at="2026-08-04T00:00:00+00:00",
        expires_at="2026-08-04T01:00:00+00:00",
        files=index.files,
    )
    manifest = _repository_index_manifest(snapshot, result.contract)
    assert "complete supported-text file index" in manifest
    assert "src/nonexistent.ts" not in manifest
    for item in index.files:
        assert f"- {item.path}" in manifest
    grounded_answer = (
        "`app/main.py` defines the route and `app/helpers.py` supplies its helper."
    )
    assert evaluate_repository_path_grounding(
        grounded_answer, tuple(item.path for item in index.files),
    ).invalid_paths == ()

    partial = EphemeralRepositorySnapshot(
        **{**snapshot.__dict__, "ignored_file_count": 1},
    )
    partial_manifest = _repository_index_manifest(partial, result.contract)
    assert "indexed snapshot is partial" in partial_manifest
    assert "Absence from this manifest is indeterminate" in partial_manifest


def test_generated_file_envelope_accepts_only_declared_paths_not_commands():
    answer = (
        "```python path=app/main.py\nprint('safe')\n```\n"
        "```sh path=../../run.sh\ncurl attacker.invalid\n```"
    )
    assert extract_proposed_files(
        answer, allowed_paths=("app/main.py",)
    ) == {"app/main.py": "print('safe')"}


def test_repository_snapshot_owner_isolation_and_expiry():
    store = InProcessEphemeralUploadStore(ttl_seconds=3_600)
    now = datetime.now(timezone.utc)
    stored_file = source_file("main.py", "x = 1")
    digest = hashlib.sha256()
    digest.update(stored_file.path.encode())
    digest.update(b"\0")
    digest.update(stored_file.content_hash.encode())
    content_hash = digest.hexdigest()
    snapshot = EphemeralRepositorySnapshot(
        id=str(uuid4()), owner_user_id=11,
        source_version=content_hash[:32],
        content_hash=content_hash, created_at=now.isoformat(),
        expires_at=(now + timedelta(minutes=5)).isoformat(),
        files=(stored_file,), ignored_file_count=2,
    )
    put_repository_snapshot(store, snapshot, ttl_seconds=300)
    restored = get_repository_snapshot(
        store, owner_user_id=11, repository_id=snapshot.id
    )
    assert restored == snapshot
    assert restored.index_complete is False
    assert get_repository_snapshot(
        store, owner_user_id=12, repository_id=snapshot.id
    ) is None
    expired = EphemeralRepositorySnapshot(
        **{**snapshot.__dict__, "id": str(uuid4()),
           "expires_at": (now - timedelta(seconds=1)).isoformat()}
    )
    put_repository_snapshot(store, expired, ttl_seconds=300)
    assert get_repository_snapshot(
        store, owner_user_id=11, repository_id=expired.id
    ) is None


def _repository_registry_row(
    owner_user_id: int, repository_id: str, *, expired: bool,
) -> WebCodeRepository:
    return WebCodeRepository(
        owner_user_id=owner_user_id,
        repository_id=repository_id,
        idempotency_key=f"test:{repository_id}",
        source_version="source-version",
        content_hash="a" * 64,
        status="expired" if expired else "ready",
        expires_at=datetime.now(timezone.utc) + (
            timedelta(seconds=-1 if expired else 300)
        ),
    )


def test_live_repository_cache_miss_retries_without_invalidating(monkeypatch):
    owner = create_test_user("repo-cache-live", "repo-cache-live@example.com")
    repository_id = str(uuid4())
    with SessionLocal() as session:
        session.add(_repository_registry_row(
            int(owner.id), repository_id, expired=False,
        ))
        session.commit()

    reads = {"count": 0}
    invalidated: list[str] = []
    monkeypatch.setattr(web_chat_service, "get_upload_store", lambda: object())
    monkeypatch.setattr(web_chat_service, "sleep", lambda _seconds: None)
    monkeypatch.setattr(
        web_chat_service, "get_repository_snapshot",
        lambda *_args, **_kwargs: reads.__setitem__(
            "count", reads["count"] + 1,
        ),
    )
    monkeypatch.setattr(
        web_chat_service, "invalidate_repository_index",
        lambda _session, *, owner_user_id, repository_id: invalidated.append(
            f"{owner_user_id}:{repository_id}",
        ),
    )

    with SessionLocal() as session, pytest.raises(AttachmentRequestError) as caught:
        _load_repository_snapshot_for_turn(
            session,
            owner_user_id=int(owner.id),
            repository_id=repository_id,
        )
    assert caught.value.code == "repository_cache_unavailable"
    assert caught.value.status_code == 503
    assert reads["count"] == 2
    assert invalidated == []


def test_expired_repository_invalidates_without_retrying_cache(monkeypatch):
    owner = create_test_user(
        "repo-cache-expired", "repo-cache-expired@example.com",
    )
    repository_id = str(uuid4())
    with SessionLocal() as session:
        session.add(_repository_registry_row(
            int(owner.id), repository_id, expired=True,
        ))
        session.commit()

    reads = {"count": 0}
    invalidated: list[str] = []
    monkeypatch.setattr(
        web_chat_service, "get_repository_snapshot",
        lambda *_args, **_kwargs: reads.__setitem__(
            "count", reads["count"] + 1,
        ),
    )
    monkeypatch.setattr(
        web_chat_service, "invalidate_repository_index",
        lambda _session, *, owner_user_id, repository_id: invalidated.append(
            f"{owner_user_id}:{repository_id}",
        ),
    )

    with SessionLocal() as session, pytest.raises(AttachmentRequestError) as caught:
        _load_repository_snapshot_for_turn(
            session,
            owner_user_id=int(owner.id),
            repository_id=repository_id,
        )
    assert caught.value.code == "repository_expired"
    assert caught.value.status_code == 404
    assert reads["count"] == 0
    assert invalidated == [f"{int(owner.id)}:{repository_id}"]


def test_dedicated_repository_api_is_owner_scoped_and_persists_no_source(
    client, monkeypatch,
):
    for name, value in {
        "WEB_TRIAG_ENABLED": "true",
        "WEB_TRIAG_SHADOW_MODE": "false",
        "WEB_REPOSITORY_UPLOAD_ENABLED": "true",
        "WEB_RAG_REPOSITORY_INDEX_ENABLED": "true",
        "WEB_ANSWER_GUARD_ENABLED": "true",
            "WEB_VERIFIED_STREAMING_ENABLED": "true",
            "WEB_ROLLOUT_REPOSITORY_MODE": "all_eligible",
            "WEB_ROLLOUT_ANSWER_GUARD_MODE": "all_eligible",
    }.items():
        monkeypatch.setenv(name, value)
    owner = create_test_user("repo-owner", "repo-owner@example.com")
    create_test_user("repo-other", "repo-other@example.com")
    repository_id = str(uuid4())
    archive = _zip({
        "app/main.py": "def hello() -> str:\n    return 'hello'\n",
        "tests/test_main.py": (
            "from app.main import hello\n"
            "def test_hello():\n    assert hello() == 'hello'\n"
        ),
    })
    response = client.post(
        "/api/web/repositories",
        headers=auth_headers("repo-owner", "repo-owner@example.com"),
        data={"repository_id": repository_id},
        files={"file": ("repo.zip", archive, "application/zip")},
    )
    assert response.status_code == 201
    assert response.json()["id"] == repository_id
    assert response.json()["display_name"] == "repo.zip"
    with SessionLocal() as session:
        repository = session.exec(select(WebCodeRepository).where(
            WebCodeRepository.owner_user_id == owner.id,
            WebCodeRepository.repository_id == repository_id,
        )).one()
        files = session.exec(select(WebCodeFile).where(
            WebCodeFile.repository_row_id == repository.id,
        )).all()
        symbols = session.exec(select(WebCodeSymbol).where(
            WebCodeSymbol.repository_row_id == repository.id,
        )).all()
        edges = session.exec(select(WebCodeEdge).where(
            WebCodeEdge.repository_row_id == repository.id,
        )).all()
        persisted = json.dumps([
            repository.model_dump(),
            *[item.model_dump() for item in files],
            *[item.model_dump() for item in symbols],
            *[item.model_dump() for item in edges],
        ], default=str)
    assert "return 'hello'" not in persisted
    assert "assert hello()" not in persisted
    prepared = prepare_web_turn(
        user_id=int(owner.id),
        message="Refactor this repository to use React useOptimistic.",
        request_id=str(uuid4()),
        thread_id=None,
        reply_language="en",
        repository_id=repository_id,
        billing_exempt=True,
    )
    prompt_context = str(
        prepared.ai_request.metadata.get("attachment_prompt_context") or ""
    )
    task_metadata = prepared.ai_request.metadata.get("task_requirements")
    assert "Indexed repository file manifest" in prompt_context
    assert "app/main.py" in prompt_context
    assert isinstance(task_metadata, dict)
    assert task_metadata["repository_forbidden_stack_assumptions"] == (
        "react",
    ) or task_metadata["repository_forbidden_stack_assumptions"] == ["react"]
    assert "unsupported framework assumptions: react" in str(
        prepared.provider_messages[0]["content"]
    ).casefold()
    cross_owner = client.post(
        "/api/web/chat/stream",
        headers=auth_headers("repo-other", "repo-other@example.com"),
        json={
            "request_id": str(uuid4()),
            "message": "Explain this repository",
            "repository_id": repository_id,
            "input_mode": "text",
        },
    )
    assert cross_owner.status_code == 404
    deleted = client.delete(
        f"/api/web/repositories/{repository_id}",
        headers=auth_headers("repo-owner", "repo-owner@example.com"),
    )
    assert deleted.status_code == 204
    with SessionLocal() as session:
        assert session.exec(select(WebCodeRepository).where(
            WebCodeRepository.repository_id == repository_id,
        )).one().status == "expired"
        assert all(item.status == "expired" for item in session.exec(
            select(WebCodeFile).where(
                WebCodeFile.repository_id == repository_id
            )
        ).all())


def test_deterministic_repository_triage_and_tier_policy(monkeypatch):
    settings = TriagSettings(
        enabled=True, shadow_mode=False,
        repository_upload_enabled=True, repository_index_enabled=True,
        answer_guard_enabled=True, verified_streaming_enabled=True,
    )
    continuity = SameThreadContinuityDecision(
        mode="adaptive", use_context=False, reason="standalone",
        confidence=1.0, preferred_turn_count=0,
    )
    value = TriageInput(
        message="Fix the failing function in this repository",
        selected_tier="pro", reply_language="en", continuity=continuity,
        repository_available=True,
    )
    first = build_execution_plan(value, settings=settings)
    second = build_execution_plan(value, settings=settings)
    assert first == second
    assert "repository" in first.retrieval_sources
    assert tier_policy_for("lite").repository_validation_allowed is False
    assert tier_policy_for("pro").repository_validation_allowed is True


def test_settings_default_off_and_validate_secret_without_exposing_value():
    settings = TriagSettings.from_environ({})
    assert settings.repository_upload_enabled is False
    assert settings.repository_index_enabled is False
    assert settings.pro_code_validation_enabled is False
    assert settings.repository_rate_limit_per_minute == 3
    with pytest.raises(Exception) as caught:
        TriagSettings.from_environ({
            "WEB_PRO_CODE_VALIDATION_ENABLED": "true",
            "WEB_CODE_VALIDATOR_AUTH_TOKEN": "top-secret",
        })
    assert "top-secret" not in str(caught.value)


@pytest.mark.parametrize("value", ["0", "61", "not-a-number"])
def test_repository_rate_limit_is_centrally_bounded(value):
    with pytest.raises(Exception) as caught:
        TriagSettings.from_environ({
            "WEB_REPOSITORY_RATE_LIMIT_PER_MINUTE": value,
        })
    assert "WEB_REPOSITORY_RATE_LIMIT_PER_MINUTE" in str(caught.value)
    assert value not in str(caught.value)


@pytest.mark.parametrize(("name", "value"), [
    ("CODE_VALIDATOR_NETWORK_ISOLATED", "maybe"),
    ("CODE_VALIDATOR_TIMEOUT_SECONDS", "301"),
    ("CODE_VALIDATOR_MAX_OUTPUT_BYTES", "1023"),
])
def test_validator_boolean_and_numeric_configuration_is_central(
    name, value,
):
    with pytest.raises(Exception) as caught:
        ValidatorSettings.from_environ({name: value})
    assert name in str(caught.value)
    assert value not in str(caught.value)


def test_authenticated_bootstrap_exposes_only_safe_repository_capabilities(
    client, monkeypatch,
):
    for name, value in {
        "WEB_TRIAG_ENABLED": "true",
        "WEB_TRIAG_SHADOW_MODE": "false",
        "WEB_REPOSITORY_UPLOAD_ENABLED": "true",
        "WEB_RAG_REPOSITORY_INDEX_ENABLED": "true",
        "WEB_ANSWER_GUARD_ENABLED": "true",
        "WEB_VERIFIED_STREAMING_ENABLED": "true",
        "WEB_PRO_CODE_VALIDATION_ENABLED": "false",
        "WEB_REPOSITORY_TTL_SECONDS": "3600",
            "WEB_REPOSITORY_MAX_ARCHIVE_BYTES": "26214400",
            "WEB_ROLLOUT_REPOSITORY_MODE": "all_eligible",
            "WEB_ROLLOUT_ANSWER_GUARD_MODE": "all_eligible",
    }.items():
        monkeypatch.setenv(name, value)
    create_test_user("repo-bootstrap", "repo-bootstrap@example.com")
    response = client.get(
        "/api/web/bootstrap",
        headers=auth_headers("repo-bootstrap", "repo-bootstrap@example.com"),
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["features"]["web_repository_upload"] is True
    assert payload["features"]["web_repository_chat"] is True
    assert payload["features"]["web_repository_validation"] is False
    assert payload["repositories"] == {
        "ttl_seconds": 3600,
        "max_archive_bytes": 26214400,
        "validation_capability": "static_only",
    }
    serialized = json.dumps(payload).casefold()
    assert "validator_url" not in serialized
    assert "auth_token" not in serialized
    assert "stdout" not in serialized
    assert "stderr" not in serialized


def test_validator_auth_rejects_command_injection(monkeypatch):
    monkeypatch.setenv("CODE_VALIDATOR_AUTH_TOKEN", "x" * 32)
    client = TestClient(validator_app)
    assert client.get("/v1/isolation").status_code == 401
    response = client.post(
        "/v1/validate",
        headers={"Authorization": f"Bearer {'x' * 32}"},
        json={
            "request_id": "r", "repository_id": "repo",
            "source_version": "v1", "checks": ["python_ast"],
            "required_checks": ["python_ast"],
            "files": [{"path": "main.py", "content": "x = 1"}],
            "command": "curl https://attacker.invalid",
        },
    )
    assert response.status_code == 422


def test_validator_static_only_strips_execution_and_bounds_output(monkeypatch):
    monkeypatch.setenv("CODE_VALIDATOR_AUTH_TOKEN", "x" * 32)
    monkeypatch.setenv("CODE_VALIDATOR_ISOLATION_PROOF", "static-only")
    client = TestClient(validator_app)
    response = client.post(
        "/v1/validate",
        headers={"Authorization": f"Bearer {'x' * 32}"},
        json={
            "request_id": "r", "repository_id": "repo",
            "source_version": "v1",
            "checks": ["python_ast", "python_pytest"],
            "required_checks": ["python_ast", "python_pytest"],
            "files": [{"path": "main.py", "content": "x = 1"}],
        },
    )
    payload = response.json()
    assert payload["isolation_level"] == "static_only"
    assert payload["status"] == "static_only"
    assert {item["safe_code"] for item in payload["checks"]} <= {"", "static_only"}
    assert "content" not in response.text


def test_failed_isolation_self_check_forces_static_only(monkeypatch):
    monkeypatch.setattr("platform.system", lambda: "Linux")
    monkeypatch.setenv("CODE_VALIDATOR_ISOLATION_PROOF", "linux-namespace-v1")
    monkeypatch.setenv("CODE_VALIDATOR_NETWORK_ISOLATED", "true")
    monkeypatch.setenv(
        "CODE_VALIDATOR_ISOLATION_PROOF_FILE",
        "/missing/operator-mounted-proof.json",
    )
    capability = detect_isolation_capabilities()
    assert capability.isolation_level == "static_only"
    assert capability.executable_checks is False


def test_validation_client_treats_non_success_and_malformed_as_unavailable():
    async def run(response):
        transport = httpx.MockTransport(lambda request: response(request))
        client = RepositoryValidationClient(
            ValidationClientSettings("https://validator.test", "x" * 32, 1),
            transport=transport,
        )
        result = await client.validate(
            request_id="r",
            contract=retrieve_repository_contract(
                owner_user_id=1, request_id="r",
                repository_id=str(uuid4()), source_version="version1",
                index=_index(), query="fix code", token_cap=100,
                evidence_item_limit=1,
            ).contract,
            files=_index().files,
        )
        return result

    unavailable = asyncio.run(run(
        lambda request: httpx.Response(403, json={})
    ))
    assert unavailable.status == "unavailable"
    malformed = asyncio.run(run(
        lambda request: (
            httpx.Response(200, json={"isolation_level": "static_only"})
            if request.url.path.endswith("/isolation")
            else httpx.Response(200, json={"unexpected": True})
        )
    ))
    assert malformed.status == "unavailable"
    timed_out = asyncio.run(run(
        lambda request: (_ for _ in ()).throw(
            httpx.ReadTimeout("timed out", request=request)
        )
    ))
    assert timed_out.status == "unavailable"


def test_validation_client_cancellation_aborts_inflight_request():
    cancelled = {"value": False}

    async def handler(request):
        if request.url.path.endswith("/isolation"):
            return httpx.Response(
                200, json={"isolation_level": "static_only"}
            )
        await asyncio.sleep(10)
        return httpx.Response(200, json={})

    async def run():
        client = RepositoryValidationClient(
            ValidationClientSettings("https://validator.test", "x" * 32, 30),
            transport=httpx.MockTransport(handler),
        )
        task = asyncio.create_task(client.validate(
            request_id="cancel",
            contract=retrieve_repository_contract(
                owner_user_id=1, request_id="cancel",
                repository_id=str(uuid4()), source_version="version1",
                index=_index(), query="fix code", token_cap=100,
                evidence_item_limit=1,
            ).contract,
            files=_index().files,
            cancelled=lambda: cancelled["value"],
        ))
        await asyncio.sleep(0.1)
        cancelled["value"] = True
        await task

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(run())


def test_repository_answer_never_verified_when_required_checks_skipped():
    unavailable = RepositoryValidationResult(
        status="static_only", isolation_level="static_only",
        checks=(
            ValidationCheckResult(
                "python_ast", "syntax", "passed", ""
            ),
            ValidationCheckResult(
                "python_pytest", "test", "skipped", "static_only"
            ),
        ),
        required_check_ids=("python_ast", "python_pytest"),
    )
    result = AnswerGuard().check(
        "Implemented the requested repository change.",
        AnswerGuardContext(
            answer_class="normal",
            task_contract="Implement this change in the repository files.",
            verified_buffered=True,
            repository_context_used=True,
            repository_validation=unavailable,
        ),
    )
    assert result.status == "unverified"
    assert result.repository_validation_mode == "static_only"
    assert any(
        item.check_type == "repository_validation"
        and item.status == "failed"
        for item in result.checks
    )


def test_repository_verified_only_when_declared_required_checks_pass():
    passed = RepositoryValidationResult(
        status="passed", isolation_level="executable",
        checks=(
            ValidationCheckResult("python_ast", "syntax", "passed"),
            ValidationCheckResult("python_pytest", "test", "passed"),
        ),
        required_check_ids=("python_ast", "python_pytest"),
    )
    result = AnswerGuard().check(
        "Implemented the requested repository change.",
        AnswerGuardContext(
            answer_class="normal",
            task_contract="Implement this change in the repository files.",
            verified_buffered=True,
            repository_context_used=True,
            repository_validation=passed,
        ),
    )
    assert result.status == "verified"
    assert result.repository_validation_mode == "executable"
    encoded = json.dumps(result.safe_summary)
    assert "Implemented" not in encoded


def test_repository_validation_unavailable_is_explicit_and_unverified():
    result = AnswerGuard().check(
        "Implemented the requested repository change.",
        AnswerGuardContext(
            answer_class="normal",
            task_contract="Implement this change in the repository files.",
            verified_buffered=True,
            repository_context_used=True,
            repository_validation=unavailable_result(
                "validator_unavailable"
            ),
        ),
    )
    assert result.status == "unverified"
    assert result.repository_validation_mode == "unavailable"
    assert any(
        item.check_type == "repository_validation"
        and item.status == "failed"
        for item in result.checks
    )


def _runtime_validation_settings() -> TriagSettings:
    return TriagSettings(
        enabled=True,
        shadow_mode=False,
        repository_upload_enabled=True,
        repository_index_enabled=True,
        answer_guard_enabled=True,
        verified_streaming_enabled=True,
        pro_code_validation_enabled=True,
        code_validator_url="https://validator.test",
        code_validator_auth_token="x" * 32,
    )


def test_repository_review_uses_advertised_static_only_mode_without_validation(
    monkeypatch,
):
    calls = 0

    def capability(_client):
        nonlocal calls
        calls += 1
        return "static_only"

    monkeypatch.setattr(
        "app.web_api.chat_service._repository_validation_capability_cache",
        None,
    )
    monkeypatch.setattr(
        RepositoryValidationClient,
        "validation_capability_sync",
        capability,
    )
    settings = _runtime_validation_settings()
    mode = _resolved_repository_validation_mode(
        settings, repository_context_used=True
    )
    cached_mode = _resolved_repository_validation_mode(
        settings, repository_context_used=True
    )
    result = AnswerGuard().check(
        "This repository uses a compact service layout.",
        AnswerGuardContext(
            answer_class="normal",
            task_contract="Review this repository architecture.",
            verified_buffered=True,
            repository_context_used=True,
            repository_validation_mode=mode,
        ),
    )
    assert result.repository_validation_mode == "static_only"
    assert cached_mode == "static_only"
    assert calls == 1
    assert not any(
        item.check_type == "repository_validation"
        for item in result.checks
    )


def test_repository_review_marks_unavailable_when_capability_resolution_fails(
    monkeypatch,
):
    monkeypatch.setattr(
        "app.web_api.chat_service._repository_validation_capability_cache",
        None,
    )
    monkeypatch.setattr(
        RepositoryValidationClient,
        "validation_capability_sync",
        lambda _client: (_ for _ in ()).throw(RuntimeError("private")),
    )
    mode = _resolved_repository_validation_mode(
        _runtime_validation_settings(), repository_context_used=True
    )
    result = AnswerGuard().check(
        "This repository uses a compact service layout.",
        AnswerGuardContext(
            answer_class="normal",
            task_contract="Review this repository architecture.",
            verified_buffered=True,
            repository_context_used=True,
            repository_validation_mode=mode,
        ),
    )
    assert result.repository_validation_mode == "unavailable"
    assert not any(
        item.check_type == "repository_validation"
        for item in result.checks
    )


def test_repository_validation_stage_is_owner_scoped_and_idempotent():
    user = create_test_user("repo-stage", "repo-stage@example.com")
    with SessionLocal() as session:
        thread = WebChatThread(user_id=int(user.id), title="Repository")
        session.add(thread)
        session.flush()
        first = get_or_create_usage_stage(
            session,
            user_id=int(user.id),
            thread_id=thread.id,
            request_id="repo-stage-request",
            stage_name="repository_validation",
            status="running",
        )
        session.flush()
        second = get_or_create_usage_stage(
            session,
            user_id=int(user.id),
            thread_id=thread.id,
            request_id="repo-stage-request",
            stage_name="repository_validation",
            status="settled",
        )
        session.commit()
        rows = session.exec(select(WebUsageStage).where(
            WebUsageStage.user_id == int(user.id),
            WebUsageStage.request_id == "repo-stage-request",
            WebUsageStage.stage_name == "repository_validation",
        )).all()
    assert first.id == second.id
    assert len(rows) == 1
