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
});
