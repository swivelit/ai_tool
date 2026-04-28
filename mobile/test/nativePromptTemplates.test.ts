import { describe, expect, it } from "vitest";

import {
  renderNativeChatPrompt,
  selectNativePromptTemplate,
} from "../lib/nativePromptTemplates";

describe("native prompt templates", () => {
  const messages = [
    { role: "system" as const, content: "Be concise." },
    { role: "user" as const, content: "Explain local models." },
    { role: "assistant" as const, content: "They run on-device." },
    { role: "user" as const, content: "Give one benefit." },
  ];

  it("renders Qwen chat as ChatML", () => {
    const prompt = renderNativeChatPrompt(messages, {
      id: "Qwen/Qwen3-8B",
      modelPath: "models/qwen.gguf",
      chatTemplate: "qwen3",
    });

    expect(selectNativePromptTemplate({ id: "Qwen/Qwen3-8B" })).toBe("qwen3");
    expect(prompt).toContain("<|im_start|>system\nBe concise.\n<|im_end|>");
    expect(prompt).toContain("<|im_start|>assistant\nThey run on-device.\n<|im_end|>");
    expect(prompt.endsWith("<|im_start|>assistant\n")).toBe(true);
  });

  it("renders Gemma chat with model turns", () => {
    const prompt = renderNativeChatPrompt(messages, {
      id: "google/gemma-3-4b-it",
      modelPath: "models/gemma.gguf",
      chatTemplate: "gemma3",
    });

    expect(selectNativePromptTemplate({ id: "google/gemma-3-4b-it" })).toBe("gemma3");
    expect(prompt).toContain("<start_of_turn>user\nSystem instructions:\nBe concise.<end_of_turn>");
    expect(prompt).toContain("<start_of_turn>model\nThey run on-device.<end_of_turn>");
    expect(prompt.endsWith("<start_of_turn>model\n")).toBe(true);
  });

  it("uses a generic fallback only for unknown templates", () => {
    const prompt = renderNativeChatPrompt(
      [{ role: "user", content: "Hello" }],
      { id: "custom/local", modelPath: "models/custom.gguf" },
    );

    expect(selectNativePromptTemplate({ id: "custom/local" })).toBe("generic");
    expect(prompt).toBe("<|user|>\nHello\n<|assistant|>\n");
  });
});
