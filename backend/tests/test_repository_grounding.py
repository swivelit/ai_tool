from app.web_ai.code_quality.repository_index import (
    build_repository_index,
    source_file,
)
from app.web_ai.generation.answer_guard import AnswerGuard, AnswerGuardContext
from app.web_ai.generation.repository_grounding import (
    REPOSITORY_PATH_VALIDATOR_VERSION,
    cited_repository_paths,
    evaluate_repository_path_grounding,
    strip_ungrounded_repository_path_claims,
)
from app.web_ai.generation.repair import build_repair_request


def test_repository_answer_rejects_phantom_path_against_indexed_version():
    assert cited_repository_paths("The file src/nonexistent.ts.") == (
        "src/nonexistent.ts",
    )
    index = build_repository_index((
        source_file("src/pricing.js", "export function finalPrice() {}"),
        source_file("src/orderService.js", "export function createOrder() {}"),
    ))
    paths = tuple(item.path for item in index.files)
    answer = (
        "`src/pricing.js` defines finalPrice.\n"
        "`src/nonexistent.ts` defines a hidden importer."
    )

    evaluated = evaluate_repository_path_grounding(answer, paths)
    assert evaluated.cited_paths == (
        "src/pricing.js", "src/nonexistent.ts",
    )
    assert evaluated.invalid_paths == ("src/nonexistent.ts",)
    assert evaluated.validator_version == REPOSITORY_PATH_VALIDATOR_VERSION

    quality = AnswerGuard().check(answer, AnswerGuardContext(
        answer_class="normal",
        task_contract="What do these repository files do?",
        repository_context_used=True,
        repository_file_paths=paths,
        verified_buffered=True,
    ))
    check = next(
        item for item in quality.checks
        if item.check_type == "repository_path_grounding"
    )
    assert check.status == "failed"
    assert dict(check.observations) == {
        "cited_path_count": 2,
        "invalid_path_count": 1,
        "validator_version": REPOSITORY_PATH_VALIDATOR_VERSION,
    }

    cleaned, changed = strip_ungrounded_repository_path_claims(answer, paths)
    assert changed is True
    assert "src/nonexistent.ts" not in cleaned
    assert evaluate_repository_path_grounding(cleaned, paths).passed is True

    repair = build_repair_request(
        user_id=1,
        request_id="repository-grounding-repair",
        reply_language="en",
        current_answer=answer,
        failed_checks=(check,),
        evidence_pack=None,
        task_contract="Describe the requested repository file and its importers.",
        repository_file_paths=paths,
    )
    rendered = "\n".join(
        str(message["content"])
        for message in repair.request.metadata["provider_messages"]
    )
    assert "Indexed repository files (authoritative for file existence)" in rendered
    assert "src/pricing.js" in rendered
    assert "src/orderService.js" in rendered
    assert "src/nonexistent.ts" in rendered  # bounded current draft only
    assert "src/nonexistent.ts" not in rendered.split(
        "Indexed repository files (authoritative for file existence):", 1,
    )[1]
    assert "do not invent its behavior or importers" in rendered
