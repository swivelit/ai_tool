import { describe, expect, it, vi, afterEach } from "vitest";

import { normalizeAssistantSettings } from "@/lib/storage";
import {
  ensureWakeModel,
  startWakeWordListening,
  stopWakeWordListening,
  validateWakeModelBundleConfig,
  wakeModelStateFromApiStatus,
} from "@/lib/wakeWordEngine";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("wakeWordEngine", () => {
  it("does not prepare a production model when native wake detection is unavailable", async () => {
    const settings = normalizeAssistantSettings({
      handsFreeEnabled: true,
      wakePhrase: "Hey Elli",
    });
    const model = await ensureWakeModel(settings);
    expect(model.ready).toBe(false);
    expect(model.status).toBe("unsupported");
  });

  it("does not start production wake listening without a ready model", async () => {
    await expect(
      startWakeWordListening(
        {
          status: "pending",
          ready: false,
          wakePhrase: "Hey Elli",
        },
        { onWake: () => undefined },
      ),
    ).rejects.toThrow(/Wake model is not ready/);
  });

  it("does not start production wake listening with an incomplete OpenWakeWord bundle", async () => {
    await expect(
      startWakeWordListening(
        {
          status: "ready",
          ready: true,
          wakePhrase: "Hey Elli",
          phraseKey: "hey-elli",
          modelPaths: {
            wakeModel: "file:///wake.onnx",
          },
        },
        { onWake: () => undefined },
      ),
    ).rejects.toThrow(/mel or embedding/);
  });

  it("preserves pending Hey Elli backend status as Needs model", () => {
    const settings = normalizeAssistantSettings({
      handsFreeEnabled: true,
      wakePhrase: "Hey Elli",
    });

    const model = wakeModelStateFromApiStatus(settings, {
      ready: false,
      status: "pending",
      phrase_key: "hey-elli",
      wake_phrase: "Hey Elli",
      model_type: "custom",
      detail: "Needs model",
    });

    expect(model.ready).toBe(false);
    expect(model.status).toBe("pending");
    expect(model.modelType).toBe("custom");
    expect(model.detail).toBe("Needs model");
  });

  it("validates model bundle roles and native start paths before claiming compatibility", () => {
    const incomplete = validateWakeModelBundleConfig({
      phraseKey: "hey-elli",
      wakePhrase: "Hey Elli",
      modelPaths: {
        wakeModel: "file:///wake.onnx",
        melspectrogramModel: "file:///melspectrogram.onnx",
        embeddingModel: "file:///embedding_model.onnx",
      },
      manifestRoles: ["wake"],
    });
    expect(incomplete.ok).toBe(false);
    expect(incomplete.manifestRolesPresent).toBe(false);

    const complete = validateWakeModelBundleConfig({
      phraseKey: "hey-elli",
      wakePhrase: "Hey Elli",
      modelPaths: {
        wakeModel: "file:///wake.onnx",
        melspectrogramModel: "file:///melspectrogram.onnx",
        embeddingModel: "file:///embedding_model.onnx",
      },
      manifestRoles: ["wake", "melspectrogram", "embedding"],
    });
    expect(complete).toMatchObject({
      ok: true,
      deterministicTestSeam: false,
      manifestRolesPresent: true,
      startConfigModelPathsPresent: true,
    });
  });

  it("supports debug E2E mock wake only when explicitly enabled", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("EXPO_PUBLIC_E2E_MOCK_HANDS_FREE", "1");
    const settings = normalizeAssistantSettings({
      handsFreeEnabled: true,
      wakePhrase: "Hey Elli",
    });
    const model = await ensureWakeModel(settings);
    expect(model.ready).toBe(true);
    expect(model.status).toBe("e2e_mock");

    const onWake = vi.fn();
    await startWakeWordListening(model, { onWake });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await stopWakeWordListening();
    expect(onWake).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "e2e_mock",
        phraseKey: "e2e-mock",
      }),
    );
  });

  it("rejects E2E mock wake in production runtime", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EXPO_PUBLIC_E2E_MOCK_HANDS_FREE", "1");
    const settings = normalizeAssistantSettings({
      handsFreeEnabled: true,
      wakePhrase: "Hey Elli",
    });

    await expect(ensureWakeModel(settings)).rejects.toThrow(/debug\/dev-only/);
  });
});
