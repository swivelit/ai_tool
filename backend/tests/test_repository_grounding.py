from app.web_ai.code_quality.repository_index import (
    build_repository_index,
    source_file,
)
from app.web_ai.generation.answer_guard import AnswerGuard, AnswerGuardContext
from app.web_ai.generation.repository_grounding import (
    REPOSITORY_PATH_VALIDATOR_VERSION,
    append_ungrounded_repository_path_warning,
    cited_repository_paths,
    evaluate_repository_path_grounding,
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
        "index_complete": 1,
        "validator_version": REPOSITORY_PATH_VALIDATOR_VERSION,
    }
    assert check.reason_code == "nonexistent_file"

    partial_quality = AnswerGuard().check(answer, AnswerGuardContext(
        answer_class="normal",
        task_contract="What do these repository files do?",
        repository_context_used=True,
        repository_file_paths=paths,
        repository_index_complete=False,
        verified_buffered=True,
    ))
    partial_check = next(
        item for item in partial_quality.checks
        if item.check_type == "repository_path_grounding"
    )
    assert partial_check.status == "warning"
    assert partial_check.reason_code == "grounding_indeterminate"
    assert partial_quality.failed_checks == ()

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


def test_repository_grounding_does_not_treat_honest_g04_refusal_as_a_citation():
    prompt = "What does src/nonexistent.ts do, and which functions import it?"
    answer = (
        "I can't determine that from the information available. I don't have the "
        "repository contents or a file index in this chat, so I can't verify whether "
        "`src/nonexistent.ts` exists or which functions import it."
    )

    evaluated = evaluate_repository_path_grounding(
        answer,
        ("src/pricing.js",),
        user_message=prompt,
    )

    assert evaluated.cited_paths == ()
    assert evaluated.invalid_paths == ()
    assert evaluated.passed is True


def test_repository_grounding_still_rejects_an_asserted_phantom_path():
    answer = "The pricing logic lives in `src/nonexistent.ts`."

    evaluated = evaluate_repository_path_grounding(
        answer,
        ("src/pricing.js",),
    )

    assert evaluated.cited_paths == ("src/nonexistent.ts",)
    assert evaluated.invalid_paths == ("src/nonexistent.ts",)
    assert evaluated.passed is False


def test_repository_warning_never_modifies_fenced_diff_bytes():
    diff = """The following patch is proposed:

```diff
--- a/src/components/Button.jsx
+++ b/src/components/Button.jsx
@@ -1,2 +1,2 @@
-export const Button = () => null
+export const Button = () => <button />
```
"""
    warned, changed = append_ungrounded_repository_path_warning(
        diff, ("src/pricing.js",), index_complete=True,
    )
    assert changed is True
    assert warned.startswith(diff.rstrip())
    assert diff.split("```diff\n", 1)[1].split("```", 1)[0] == (
        warned.split("```diff\n", 1)[1].split("```", 1)[0]
    )
    assert "--- a/src/components/Button.jsx" in warned
    assert "+++ b/src/components/Button.jsx" in warned
    assert warned.count("Repository path verification could not verify:") == 1
