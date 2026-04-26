import { describe, expect, it } from "vitest";

import {
  createLocalModelRuntime,
  getLocalRuntimeConfigError,
} from "../lib/localModelRuntime";

describe("local model runtime architecture", () => {
  it("rejects loopback for an external LAN adapter", () => {
    const runtime = createLocalModelRuntime({
      mode: "local_adapter",
      baseUrl: "http://127.0.0.1:11434/v1",
      adapterLocation: "external_lan",
      allowDeviceLoopback: false,
    });

    expect(runtime.kind).toBe("openai_compatible_local_adapter");
    expect(runtime.isConfigured()).toBe(false);
    expect(runtime.describe().configured).toBe(false);
    expect(
      getLocalRuntimeConfigError(
        {
          mode: "local_adapter",
          baseUrl: "http://127.0.0.1:11434/v1",
          adapterLocation: "external_lan",
          allowDeviceLoopback: false,
        },
        "Local chat",
      ),
    ).toContain("adapterLocation=external_lan");
  });

  it("allows loopback only when explicitly configured as device-hosted", () => {
    const runtime = createLocalModelRuntime({
      mode: "local_adapter",
      baseUrl: "http://127.0.0.1:11434/v1",
      adapterLocation: "device_loopback",
      allowDeviceLoopback: true,
    });

    expect(runtime.kind).toBe("openai_compatible_local_adapter");
    expect(runtime.isConfigured()).toBe(true);
    expect(runtime.describe()).toMatchObject({
      mode: "local_adapter",
      primary: "phone_local",
      backendRole: "fallback_only",
      openAiPolicy: "fallback_only",
      allowDeviceLoopback: true,
      adapterLocation: "device_loopback",
    });
  });

  it("represents native on-device runtime as a clear TODO stub", async () => {
    const runtime = createLocalModelRuntime({
      mode: "native_on_device",
      openAiPolicy: "fallback_only",
    });

    expect(runtime.kind).toBe("native_on_device");
    expect(runtime.isConfigured()).toBe(false);
    expect(runtime.describe()).toMatchObject({
      mode: "native_on_device",
      primary: "phone_local",
      configured: false,
      backendRole: "fallback_only",
      openAiPolicy: "fallback_only",
    });
    await expect(
      runtime.completeChat({
        model: "google/gemma-3-4b-it",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow("native_on_device runtime");
  });
});
