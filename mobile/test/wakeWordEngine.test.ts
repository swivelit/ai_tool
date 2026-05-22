import { describe, expect, it, vi, afterEach } from "vitest";

import { normalizeAssistantSettings } from "@/lib/storage";
import { ensureWakeModel, startWakeWordListening, stopWakeWordListening } from "@/lib/wakeWordEngine";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("wakeWordEngine", () => {
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
});
