import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("debug-only canonical Swico API fixture", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("EXPO_PUBLIC_E2E_MOCK_API", "1");
    vi.stubEnv("EXPO_PUBLIC_E2E_REPLY_LANGUAGE", "en");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("models the current /api/web bootstrap, settings, search, and billing surfaces", async () => {
    const user = { getIdToken: vi.fn().mockResolvedValue("fixture-token") } as any;
    const { getBootstrap, getPayments, getThreads, searchChats } = await import("../lib/swicoApi");
    const bootstrap = await getBootstrap(user);
    expect(bootstrap.features.web_chat).toBe(true);
    expect(bootstrap.features.web_knowledge_library).toBe(true);
    expect(bootstrap.assistant.tiers.length).toBeGreaterThan(1);
    expect((await getThreads(user)).items[0]?.id).toBe("e2e-thread-1");
    expect((await searchChats(user, "fixture")).items[0]?.source_kind).toBe("summary");
    expect((await getPayments(user)).items).toEqual([]);
  });

  it("emits a terminal SSE-shaped response without touching the network", async () => {
    const user = { getIdToken: vi.fn().mockResolvedValue("fixture-token") } as any;
    const { streamChat } = await import("../lib/swicoApi");
    const events: string[] = [];
    await streamChat(user, { request_id: "e2e-request", message: "hello", input_mode: "text" }, {
      onAccepted: vi.fn(),
      onEvent: event => events.push(event.event),
    }, new AbortController().signal);
    expect(events).toEqual(["thread", "status", "delta", "sources", "quality", "usage", "done"]);
    expect(user.getIdToken).not.toHaveBeenCalled();
  });
});
