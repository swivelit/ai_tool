import json
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont

from swico_video_node import provenance


def test_provenance_is_opaque_and_metadata_is_bounded():
    value = provenance.provenance_id("job-123@example.invalid")
    assert value.startswith("swico-v1-") and len(value) == len("swico-v1-") + 24
    assert "example" not in value
    args = provenance.metadata_args(value)
    assert provenance.DISCLOSURE_TEXT in " ".join(args)
    assert value in " ".join(args)
    with pytest.raises(ValueError):
        provenance.metadata_args("not-a-provenance-id")


def test_disclosure_draws_high_contrast_bounded_marker():
    image = Image.new("RGB", (496, 368), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=12)
    rect = provenance.draw_disclosure(draw, image.width, image.height, font)
    assert rect[0] == 0 and rect[1] == 0 and rect[2] <= image.width and rect[3] <= image.height
    assert image.getpixel((1, 1)) == (0, 0, 0)
    assert image.getpixel((rect[2] - 1, rect[3] - 1)) != (255, 255, 255)


def test_output_metadata_verification_requires_exact_disclosure(tmp_path: Path):
    output = tmp_path / "output.mp4"
    identifier = provenance.provenance_id("fixture")
    seen = []

    def capture(argv, **kwargs):
        seen.append(argv)
        return json.dumps({"format":{"tags":{
            "comment": provenance.DISCLOSURE_TEXT,
            "description": f"{provenance.DISCLOSURE_TEXT};provenance={identifier}",
        }}})

    assert provenance.verify_output(output, identifier, capture_fn=capture)["provenance_id"] == identifier
    assert str(output) in seen[0]
    with pytest.raises(ValueError, match="metadata"):
        provenance.verify_output(output, identifier, capture_fn=lambda *_args, **_kwargs: json.dumps({"format":{"tags":{}}}))
