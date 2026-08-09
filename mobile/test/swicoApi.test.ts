import { beforeEach, describe, expect, it, vi } from "vitest";

const user = {
  getIdToken: vi.fn(),
} as any;

describe("canonical Swico mobile API client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    user.getIdToken.mockReset();
    user.getIdToken.mockResolvedValue("fresh-token");
  });

  it("attaches Firebase bearer auth and refreshes exactly once after 401", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "expired" }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { swicoJson } = await import("../lib/swicoApi");
    await expect(swicoJson(user, "/api/web/bootstrap")).resolves.toEqual({ ok: true });
    expect(user.getIdToken.mock.calls).toEqual([[false], [true]]);
    expect(fetchMock.mock.calls[0][1].headers.get("Authorization")).toBe("Bearer fresh-token");
    expect(fetchMock.mock.calls[1][1].headers.get("Authorization")).toBe("Bearer fresh-token");
  });

  it("uses the canonical bootstrap endpoint and preserves server payload", async () => {
    const payload = { assistant: { tier: "free" }, features: { web_chat: true } };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { getBootstrap } = await import("../lib/swicoApi");
    await expect(getBootstrap(user)).resolves.toEqual(payload);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/web/bootstrap");
  });

  it("does not expose a legacy /api/chat call in the production route", async () => {
    const fs = await import("node:fs/promises");
    const route = await fs.readFile(new URL("../app/(chat)/index.tsx", import.meta.url).pathname, "utf8");
    const screen = await fs.readFile(new URL("../components/swico/SwicoChatScreen.tsx", import.meta.url).pathname, "utf8");
    const api = await fs.readFile(new URL("../lib/swicoApi.ts", import.meta.url).pathname, "utf8");
    expect(route).toContain("SwicoChatScreen");
    expect(`${route}\n${screen}`).not.toContain("/api/chat");
    expect(`${route}\n${screen}`).not.toContain("runLocalAssistantTurn");
    expect(`${route}\n${screen}`).not.toContain("nativeOnDeviceModelBridge");
    expect(api).toContain("/api/web/chat/stream");
  });

  it("rejects a successful stream that reaches EOF without done/error", async () => {
    class FakeXHR {
      static instances: FakeXHR[] = [];
      readyState = 0; status = 0; responseText = ""; onreadystatechange?: () => void; onerror?: () => void; onabort?: () => void; onloadend?: () => void;
      constructor() { FakeXHR.instances.push(this); }
      open() { this.readyState = 1; }
      setRequestHeader() {}
      send() { this.status = 200; this.readyState = 2; this.onreadystatechange?.(); this.responseText = "event: delta\ndata: {\"text\":\"partial\"}\n\n"; this.readyState = 3; this.onreadystatechange?.(); this.readyState = 4; this.onreadystatechange?.(); this.onloadend?.(); }
      abort() { this.onabort?.(); }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const { streamChat, SwicoStreamError } = await import("../lib/swicoApi");
    await expect(streamChat(user, { request_id: "r", message: "hello", input_mode: "text" }, { onEvent: vi.fn() }, new AbortController().signal)).rejects.toMatchObject({ code: "stream_interrupted" });
    expect(SwicoStreamError).toBeDefined();
  });

  it("resolves only after a terminal done event", async () => {
    class FakeXHR {
      readyState = 0; status = 0; responseText = ""; onreadystatechange?: () => void; onerror?: () => void; onabort?: () => void; onloadend?: () => void;
      open() { this.readyState = 1; } setRequestHeader() {}
      send() { this.status = 200; this.readyState = 2; this.onreadystatechange?.(); this.responseText = "event: delta\ndata: {\"text\":\"ok\"}\n\nevent: done\ndata: {\"finish_reason\":\"stop\"}\n\n"; this.readyState = 3; this.onreadystatechange?.(); this.readyState = 4; this.onreadystatechange?.(); this.onloadend?.(); }
      abort() { this.onabort?.(); }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const { streamChat } = await import("../lib/swicoApi");
    const events: { event: string; data: unknown }[] = [];
    await expect(streamChat(user, { request_id: "r", message: "hello", input_mode: "text" }, { onEvent: event => events.push(event) }, new AbortController().signal)).resolves.toBeUndefined();
    expect(events.at(-1)?.event).toBe("done");
  });

  it("keeps cancellation handshake in the production chat source", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("../components/swico/SwicoChatScreen.tsx", import.meta.url).pathname, "utf8");
    expect(source).toContain("queuedStopRef");
    expect(source).toContain('result.status === "stopped"');
    expect(source).toContain('result.status === "cancelling"');
    expect(source).toContain("targetController.abort()");
    expect(source).toContain("cancellationSentRef.current");
  });

  it("keeps the provider-facing large-text action prompt separate from raw pasted input", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("../components/swico/SwicoChatScreen.tsx", import.meta.url).pathname, "utf8");
    expect(source).toContain("uploadText(user, rawText, longInputMode)");
    expect(source).toContain("message: providerText");
  });

  it("surfaces a terminal SSE error without treating it as a successful stream", async () => {
    class FakeXHR {
      readyState = 0; status = 0; responseText = ""; onreadystatechange?: () => void; onerror?: () => void; onabort?: () => void; onloadend?: () => void;
      open() { this.readyState = 1; } setRequestHeader() {}
      send() { this.status = 200; this.readyState = 2; this.onreadystatechange?.(); this.responseText = 'event: error\ndata: {"code":"swico_free_unavailable","message":"Unavailable","retryable":true}\n\n'; this.readyState = 3; this.onreadystatechange?.(); this.readyState = 4; this.onreadystatechange?.(); this.onloadend?.(); }
      abort() { this.onabort?.(); }
    }
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const { streamChat } = await import("../lib/swicoApi");
    await expect(streamChat(user, { request_id: "r", message: "hello", input_mode: "text" }, { onEvent: vi.fn() }, new AbortController().signal)).rejects.toMatchObject({ code: "swico_free_unavailable", retryable: true });
  });
});
