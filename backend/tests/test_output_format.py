from app.ai.prompts import build_provider_messages
from app.ai.types import AIRequest, AIRoute
from app.web_ai.generation.answer_guard import AnswerGuard, AnswerGuardContext
from app.ai.types import AIProviderResponse
from app.web_ai.generation.generator import VerifiedGenerator
from app.web_ai.generation.output_format import (
    autoclose_unbalanced_fence,
    fence_marker_count,
    has_unfenced_code_like_content,
)
from app.web_ai.streaming_policy import StreamingPolicy


def _route() -> AIRoute:
    return AIRoute(
        provider="openai", model="configured-model", route="coding",
        reason="test", language="en", intent="coding",
        max_output_tokens=600,
    )


def test_generation_prompt_always_requires_fenced_code_output():
    request = AIRequest(
        user_id=1,
        message="Create a landing page with HTML, CSS, and JavaScript.",
        reply_language="en",
        channel="text",
        request_id="fence-prompt",
        metadata={"client_surface": "web", "answer_class": "detailed"},
    )
    system = build_provider_messages(request, _route(), provider="openai")[0][
        "content"
    ]
    assert "fenced Markdown block with an appropriate language tag" in system


def test_vision_attachment_is_sent_as_structured_image_input():
    request = AIRequest(
        user_id=1,
        message="Describe the image.",
        reply_language="en",
        channel="text",
        request_id="vision-prompt",
        metadata={
            "client_surface": "web",
            "vision_inputs": [{
                "media_type": "image/png",
                "data_base64": "c3ludGhldGlj",
            }],
        },
    )
    content = build_provider_messages(
        request, _route(), provider="openai"
    )[-1]["content"]
    assert isinstance(content, list)
    assert [item["type"] for item in content] == [
        "input_text", "input_image",
    ]
    assert content[1]["image_url"].startswith("data:image/png;base64,")


def test_answer_guard_rejects_landing_page_markup_outside_fences():
    answer = "Here is the page.\n<html>\n<body>Landing</body>\n</html>"
    quality = AnswerGuard().check(
        answer,
        AnswerGuardContext(
            answer_class="detailed",
            task_contract="Create a landing page.",
            verified_buffered=True,
        ),
    )
    check = next(
        item for item in quality.checks
        if item.check_type == "output_fenced_code_present"
    )
    assert check.status == "failed"
    assert has_unfenced_code_like_content(answer) is True
    assert has_unfenced_code_like_content(
        "```html\n<html>\n</html>\n```"
    ) is False


def test_landing_page_draft_is_repaired_to_fenced_output():
    guard = AnswerGuard()
    context = AnswerGuardContext(
        answer_class="detailed",
        task_contract="Create a landing page.",
        verified_buffered=True,
    )

    def response(text: str) -> AIProviderResponse:
        return AIProviderResponse(
            text=text, provider="openai", model="configured-model",
            route="coding", reason="test", language="en", intent="coding",
        )

    generated = VerifiedGenerator(
        StreamingPolicy("verified_buffered")
    ).generate(
        generate_draft=lambda _delta: response(
            "<html>\n<body>Landing</body>\n</html>"
        ),
        verify=lambda answer: guard.check(answer, context),
        repair=lambda _answer, _quality: response(
            "```html\n<html>\n<body>Landing</body>\n</html>\n```"
        ),
        verify_repaired=lambda answer, _prior: guard.check(answer, context),
        on_delta=None,
        on_status=None,
        cancellation_signal=None,
    )
    assert generated.repair_attempts == 1
    assert generated.quality is not None and generated.quality.passed
    assert generated.response.text.startswith("```html\n")
    assert generated.response.text.endswith("\n```")


def test_fence_autoclose_counts_only_standalone_markers():
    odd = "```html\n<section>ok</section>"
    closed, changed = autoclose_unbalanced_fence(odd)
    assert changed is True
    assert closed.endswith("\n```")
    assert fence_marker_count(closed) == 2

    even = "```html\n<section>ok</section>\n```"
    unchanged, changed = autoclose_unbalanced_fence(even)
    assert changed is False
    assert unchanged == even

    inline = "Explain the literal inline token ` ``` ` without a block."
    unchanged, changed = autoclose_unbalanced_fence(inline)
    assert changed is False
    assert unchanged == inline
