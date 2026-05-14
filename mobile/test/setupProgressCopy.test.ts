import { describe, expect, it } from "vitest";

import {
  formatProgressPercentLabel,
  formatSetupEtaText,
  friendlySetupError,
  getModelSetupLayout,
} from "../lib/setupProgressCopy";

describe("setupProgressCopy", () => {
  it("formats progress below one percent without rounding to zero", () => {
    expect(formatProgressPercentLabel(0)).toBe("0% complete");
    expect(formatProgressPercentLabel(0.004)).toBe("<1% complete");
    expect(formatProgressPercentLabel(0.42)).toBe("42% complete");
  });

  it("formats setup ETA states without huge minute counts", () => {
    expect(formatSetupEtaText({ ready: true, status: "installed" })).toBe("Ready");
    expect(formatSetupEtaText({ status: "verifying" })).toBe("Finalizing setup...");
    expect(formatSetupEtaText({ status: "installed" })).toBe("Finalizing setup...");
    expect(formatSetupEtaText({ status: "paused" })).toBe("Paused");
    expect(formatSetupEtaText({ status: "reconnecting" })).toBe("Waiting for connection. Retrying soon...");
    expect(formatSetupEtaText({ status: "downloading", progress: { phase: "downloading", etaSeconds: null } })).toBe("Estimating...");
    expect(formatSetupEtaText({ status: "downloading", progress: { phase: "downloading", etaSeconds: 25 * 60 } })).toBe("About 25 min left");
    expect(formatSetupEtaText({ status: "downloading", progress: { phase: "downloading", etaSeconds: 75 * 60 } })).toBe("About 1 hr 15 min left");
    expect(formatSetupEtaText({ status: "downloading", progress: { phase: "downloading", etaSeconds: 80_000 } })).toBe("Estimating...");
  });

  it("converts transient host errors to user-safe copy while keeping developer details", () => {
    const safe = friendlySetupError(
      new Error('Could not install qwen3-8b-q4_k_m.gguf: Unable to resolve host "huggingface.co"'),
    );

    expect(safe.userMessage).not.toMatch(/huggingface|qwen3-8b|\.gguf/i);
    expect(safe.userMessage).toMatch(/resume/i);
    expect(safe.userMessage).toMatch(/retry automatically/i);
    expect(safe.developerError).toMatch(/huggingface\.co/);
    expect(safe.developerError).toMatch(/qwen3-8b/);
  });

  it("surfaces actionable model setup diagnostics without leaking secrets", () => {
    expect(
      friendlySetupError(
        new Error("Required local GGUF models are not ready: Qwen/Qwen3-Embedding-0.6B missing model file qwen.gguf at file:///mock/models/qwen.gguf"),
      ).userMessage,
    ).toMatch(/model file is missing/i);
    expect(
      friendlySetupError(
        new Error("Model google/gemma is missing a resolved public/signed CDN URL (empty downloadUrl). Set EXPO_PUBLIC_LOCAL_MODEL_URL_GEMMA_4B."),
      ).userMessage,
    ).toMatch(/download URL is not configured/i);
    expect(
      friendlySetupError(
        new Error("Production model google/gemma has unresolved download metadata: cdn:// URL without a configured EXPO_PUBLIC_LOCAL_MODEL_CDN_BASE_URL."),
      ).userMessage,
    ).toMatch(/cdn:\/\/ placeholder/i);
    expect(
      friendlySetupError(
        new Error("Production model Qwen/Qwen3-8B is missing expectedBytes integrity metadata."),
      ).userMessage,
    ).toMatch(/byte-size metadata is missing/i);
    expect(
      friendlySetupError(
        new Error("Production model Qwen/Qwen3-Embedding-0.6B is missing sha256 integrity metadata."),
      ).userMessage,
    ).toMatch(/SHA-256 metadata is missing/i);
    expect(
      friendlySetupError(
        new Error("JAI_LLAMA_CPP_BACKEND_MISSING: this build was compiled without llama.cpp"),
      ).userMessage,
    ).toMatch(/llama\.cpp is not built/i);
  });

  it("selects compact responsive layout and caps card width", () => {
    const narrow = getModelSetupLayout({ width: 320, height: 640 });
    expect(narrow.compact).toBe(true);
    expect(narrow.cardWidth).toBeLessThanOrEqual(320 - narrow.horizontalPadding * 2);

    const tall = getModelSetupLayout({ width: 390, height: 860 });
    expect(tall.compact).toBe(false);
    expect(tall.cardWidth).toBeLessThanOrEqual(390 - tall.horizontalPadding * 2);

    const large = getModelSetupLayout({ width: 900, height: 1000 });
    expect(large.cardWidth).toBe(560);
  });
});
