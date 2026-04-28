import { NativeOnDeviceChatMessage, NativeOnDeviceModelAsset } from "./nativeOnDeviceModelBridge";

export type NativePromptTemplateName = "qwen3" | "gemma3" | "generic";

function cleanContent(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeTemplateName(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/[_\s-]+/g, "");
}

export function selectNativePromptTemplate(
  asset?: Pick<NativeOnDeviceModelAsset, "id" | "chatTemplate" | "promptFormat"> | null,
): NativePromptTemplateName {
  const configured = normalizeTemplateName(asset?.chatTemplate || asset?.promptFormat);
  if (["qwen", "qwen3", "chatml"].includes(configured)) return "qwen3";
  if (["gemma", "gemma3"].includes(configured)) return "gemma3";

  const modelId = normalizeTemplateName(asset?.id);
  if (modelId.includes("qwen")) return "qwen3";
  if (modelId.includes("gemma")) return "gemma3";
  return "generic";
}

function roleOf(message: NativeOnDeviceChatMessage) {
  const role = String(message.role || "user").trim().toLowerCase();
  return role === "system" || role === "assistant" ? role : "user";
}

function renderQwenPrompt(messages: NativeOnDeviceChatMessage[]) {
  const turns = messages
    .map((message) => {
      const content = cleanContent(message.content);
      if (!content) return "";
      return `<|im_start|>${roleOf(message)}\n${content}\n<|im_end|>`;
    })
    .filter(Boolean);
  return `${turns.join("\n")}\n<|im_start|>assistant\n`;
}

function renderGemmaPrompt(messages: NativeOnDeviceChatMessage[]) {
  const system = messages
    .filter((message) => roleOf(message) === "system")
    .map((message) => cleanContent(message.content))
    .filter(Boolean)
    .join("\n\n");
  const turns: string[] = [];
  if (system) {
    turns.push(`<start_of_turn>user\nSystem instructions:\n${system}<end_of_turn>`);
  }
  for (const message of messages) {
    const role = roleOf(message);
    if (role === "system") continue;
    const content = cleanContent(message.content);
    if (!content) continue;
    turns.push(`<start_of_turn>${role === "assistant" ? "model" : "user"}\n${content}<end_of_turn>`);
  }
  return `${turns.join("\n")}\n<start_of_turn>model\n`;
}

function renderGenericPrompt(messages: NativeOnDeviceChatMessage[]) {
  const turns = messages
    .map((message) => {
      const content = cleanContent(message.content);
      if (!content) return "";
      const role = roleOf(message);
      if (role === "system") return `<|system|>\n${content}`;
      if (role === "assistant") return `<|assistant|>\n${content}`;
      return `<|user|>\n${content}`;
    })
    .filter(Boolean);
  return `${turns.join("\n")}\n<|assistant|>\n`;
}

export function renderNativeChatPrompt(
  messages: NativeOnDeviceChatMessage[],
  asset?: NativeOnDeviceModelAsset | null,
) {
  const template = selectNativePromptTemplate(asset);
  if (template === "qwen3") return renderQwenPrompt(messages);
  if (template === "gemma3") return renderGemmaPrompt(messages);
  return renderGenericPrompt(messages);
}
