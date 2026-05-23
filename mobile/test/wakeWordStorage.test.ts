import { describe, expect, it } from "vitest";

import { normalizeAssistantSettings } from "@/lib/storage";

describe("wake model storage normalization", () => {
  it("normalizes wakeModel and observed transcriptions without losing old settings", () => {
    const settings = normalizeAssistantSettings({
      handsFreeEnabled: true,
      wakePhrase: "  Hey Elli  ",
      wakeObservedTranscriptions: [" hey elli ", "", "hey elli"],
      wakeModel: {
        status: "ready",
        phraseKey: "hey-elli",
        modelPaths: {
          wakeModel: "file:///wake.onnx",
          melspectrogramModel: "",
        },
        sampleRate: 16000,
        frameMs: 80,
        modelRoles: ["wake", "", "embedding", "wake"],
      },
    } as any);

    expect(settings.wakePhrase).toBe("Hey Elli");
    expect(settings.wakeObservedTranscriptions).toEqual(["hey elli"]);
    expect(settings.wakeModel).toMatchObject({
      status: "ready",
      phraseKey: "hey-elli",
      wakePhrase: "Hey Elli",
      sampleRate: 16000,
      frameMs: 80,
      modelPaths: {
        wakeModel: "file:///wake.onnx",
      },
      modelRoles: ["wake", "embedding"],
    });
  });

  it("does not treat arbitrary custom phrases as model-ready by default", () => {
    const settings = normalizeAssistantSettings({
      wakePhrase: "custom elli",
      wakeModel: { status: "active" } as any,
    });

    expect(settings.wakeModel.status).toBe("missing");
  });
});
