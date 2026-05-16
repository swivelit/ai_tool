from stage_english_remodel import EmbeddedTextClassifier


def test_classifier_keeps_real_greetings_as_greeting():
    classifier = EmbeddedTextClassifier()

    assert classifier.predict("hi") == "greeting"
    assert classifier.predict("hello") == "greeting"


def test_classifier_does_not_default_unknown_general_questions_to_greeting():
    classifier = EmbeddedTextClassifier()

    assert classifier.predict("tell me about solo leveling") in {"general_qa", "unknown"}
    assert classifier.predict("tell me about solo leveling") != "greeting"
    assert classifier.predict("explain quantum computing") in {"general_qa", "unknown"}
    assert classifier.predict("explain quantum computing") != "greeting"
