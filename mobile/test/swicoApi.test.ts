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

  it("uses the canonical billing and usage-settings contracts", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/billing/estimate")) return new Response(JSON.stringify({ gross_amount_paise: 1000, token_estimate: null }), { status: 200 });
      if (url.endsWith("/settings/usage")) return new Response(JSON.stringify({ warning_threshold_percent: 80 }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getBillingEstimate, updateUsageSettings } = await import("../lib/swicoApi");
    await getBillingEstimate(user, 1000, "chat");
    await updateUsageSettings(user, { period: "monthly", hard_limit_estimated_tokens: null, warning_threshold_percent: 80, notify_at_threshold: true });
    expect(fetchMock.mock.calls[0][0]).toContain("/api/web/billing/estimate?gross_amount_paise=1000&credit_bucket=chat");
    expect(fetchMock.mock.calls[1][0]).toContain("/api/web/settings/usage");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ period: "monthly", hard_limit_estimated_tokens: null });
  });

  it("preserves structured 402 metadata for usage limits and credit buckets", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "credits_exhausted", credit_bucket: "voice", reset_at: "2030-01-02T00:00:00Z", retry_at: "2030-01-01T00:00:00Z", retryable: true, message: "No voice credits" } }), { status: 402 }));
    vi.stubGlobal("fetch", fetchMock);
    const { SwicoApiError, swicoJson } = await import("../lib/swicoApi");
    await expect(swicoJson(user, "/api/web/chat/stream")).rejects.toMatchObject({ status: 402, code: "credits_exhausted", credit_bucket: "voice", reset_at: "2030-01-02T00:00:00Z", retry_at: "2030-01-01T00:00:00Z", retryable: true });
    expect(SwicoApiError).toBeDefined();
  });

  it("keeps payment-status responses on the internal-order endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ internal_order_id: "ord_1", status: "credited" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { getPaymentStatus } = await import("../lib/swicoApi");
    await expect(getPaymentStatus(user, "ord_1")).resolves.toMatchObject({ internal_order_id: "ord_1", status: "credited" });
    expect(fetchMock.mock.calls[0][0]).toContain("/api/web/billing/payments/ord_1");
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
    const events: { event: string; data: unknown }[] = [];
    await expect(streamChat(user, { request_id: "r", message: "hello", input_mode: "text" }, { onEvent: event => events.push(event) }, new AbortController().signal)).rejects.toMatchObject({ code: "stream_interrupted" });
    expect(events).toEqual([{ event: "delta", data: { text: "partial" } }, { event: "error", data: { code: "stream_interrupted", message: "The connection ended before Swico finished. Retry." } }]);
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

  it("keeps screen-level transport, history, retry, and expiry guards on the production path", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("../components/swico/SwicoChatScreen.tsx", import.meta.url).pathname, "utf8");
    expect(source).toContain("navigationGenerationRef.current");
    expect(source).toContain("transportAttemptRef.current");
    expect(source).toContain("if (!isCurrentTransport()) return;");
    expect(source).toContain("pendingAttachmentIdsRef");
    expect(source).toContain('item.role === "user" && item.request_id === id');
    expect(source).toContain("onAccepted: () => {");
  });

  it("rejects deferred callbacks after navigation using the production scope guard", async () => {
    const { captureSwicoScope, isSwicoScopeCurrent } = await import("../lib/swicoRequestScope");
    const scope = captureSwicoScope(4, "transport-a", "request-a", "thread-a");
    expect(isSwicoScopeCurrent(scope, { navigationGeneration: 5, transportAttemptId: "transport-a", requestId: "request-a", threadId: "thread-a" })).toBe(false);
    expect(isSwicoScopeCurrent(scope, { navigationGeneration: 4, transportAttemptId: "transport-b", requestId: "request-a", threadId: "thread-a" })).toBe(false);
    expect(isSwicoScopeCurrent(scope, { navigationGeneration: 4, transportAttemptId: "transport-a", requestId: "request-a", threadId: "thread-a" })).toBe(true);
  });

  it("keeps thread-list and message-history refreshes independent", async () => {
    const {
      captureSwicoHistoryScope,
      isSwicoHistoryScopeCurrent,
    } = await import("../lib/swicoRequestScope");
    const threads = captureSwicoHistoryScope("threads", 2, null, false);
    const messages = captureSwicoHistoryScope("messages", 2, "thread-a", false);

    expect(isSwicoHistoryScopeCurrent(threads, {
      generation: 2,
      activeThreadId: "thread-b",
      archived: false,
    })).toBe(true);
    expect(isSwicoHistoryScopeCurrent(messages, {
      generation: 2,
      activeThreadId: "thread-a",
      archived: false,
    })).toBe(true);
    expect(isSwicoHistoryScopeCurrent(messages, {
      generation: 2,
      activeThreadId: "thread-b",
      archived: false,
    })).toBe(false);
  });

  it("releases abandoned upload busy state without letting old cleanup clear a newer upload", async () => {
    const { SwicoBusyOperationController } = await import("../lib/swicoBusyOperation");
    const controller = new SwicoBusyOperationController();
    let uploading = false;
    const deferred = () => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };
    const oldUpload = deferred();
    const old = controller.begin(0);
    uploading = controller.isBusy;
    expect(uploading).toBe(true);

    expect(controller.abandon(1)).toBe(true);
    uploading = controller.isBusy;
    expect(uploading).toBe(false);

    const newUpload = deferred();
    const current = controller.begin(1);
    uploading = controller.isBusy;
    expect(uploading).toBe(true);
    oldUpload.resolve();
    expect(controller.finish(old)).toBe(false);
    expect(controller.isBusy).toBe(true);
    newUpload.resolve();
    expect(controller.finish(current)).toBe(true);
    uploading = controller.isBusy;
    expect(uploading).toBe(false);
    await expect(oldUpload.promise).resolves.toBeUndefined();
  });

  it("settles failure and cancellation cleanup only for the operation that still owns busy state", async () => {
    const { SwicoBusyOperationController } = await import("../lib/swicoBusyOperation");
    const controller = new SwicoBusyOperationController();
    const failed = controller.begin(2);
    expect(controller.isBusy).toBe(true);
    expect(controller.finish(failed)).toBe(true);
    expect(controller.isBusy).toBe(false);
    const cancelled = controller.begin(3);
    expect(controller.abandon(4)).toBe(true);
    expect(controller.finish(cancelled)).toBe(false);
    expect(controller.isBusy).toBe(false);
  });

  it("admits only one overlapping upload/preparation operation until it settles", async () => {
    const { SwicoBusyOperationController } = await import("../lib/swicoBusyOperation");
    const controller = new SwicoBusyOperationController();
    const first = controller.tryBegin(0);
    expect(first).not.toBeNull();
    expect(controller.tryBegin(0)).toBeNull();
    expect(controller.isBusy).toBe(true);
    expect(controller.finish(first!)).toBe(true);
    const second = controller.tryBegin(0);
    expect(second).not.toBeNull();
    expect(controller.isBusy).toBe(true);
    expect(controller.finish(second!)).toBe(true);
    expect(controller.isBusy).toBe(false);
  });

  it("does not restore a deliberately detached file when deferred history resolves", async () => {
    const { detachSwicoAttachment, mergeSwicoHistoryAttachments } = await import("../lib/swicoAttachmentState");
    const attachment = { id: "removed-a", name: "a.pdf", media_type: "application/pdf", size_bytes: 4, created_at: "2026-09-10T00:00:00Z", expires_at: "2026-09-10T00:10:00Z", status: "ready" as const, warnings: [] };
    let resolveHistory!: (value: { items: typeof attachment[] }) => void;
    const history = new Promise<{ items: typeof attachment[] }>(resolve => { resolveHistory = resolve; });
    const pending = new Set([attachment.id]);
    const detached = new Set<string>();
    const afterRemoval = detachSwicoAttachment([attachment], attachment.id, pending, detached);
    resolveHistory({ items: [attachment] });
    await history;
    expect(mergeSwicoHistoryAttachments([attachment], afterRemoval, pending, 5, detached)).toEqual([]);
    expect(pending.has(attachment.id)).toBe(false);
    expect(detached.has(attachment.id)).toBe(true);
  });

  it("normalizes regeneration to one target even when the historical fallback has an active edit", async () => {
    const { normalizeSwicoMutationOptions } = await import("../lib/swicoRequestPayload");
    expect(normalizeSwicoMutationOptions({ regenerateId: "assistant-a" }, "user-edit-a")).toEqual({ regenerateId: "assistant-a" });
    expect(normalizeSwicoMutationOptions({ editId: "user-edit-a" }, "user-edit-a")).toEqual({ editId: "user-edit-a" });
    expect(normalizeSwicoMutationOptions({ continueId: "assistant-a", regenerateId: "assistant-b" }, "user-edit-a")).toEqual({ regenerateId: "assistant-b" });
  });

  it("builds regeneration with one fresh mutation target while retry keeps the immutable request", async () => {
    const { buildRegeneratePayload } = await import("../lib/swicoRequestPayload");
    const original = {
      request_id: "original-request",
      message: "Explain the document",
      thread_id: "thread-a",
      repository_id: "repo-a",
      attachment_ids: ["upload-a"],
      input_mode: "text" as const,
      edit_message_id: "edit-target",
      continue_message_id: "continue-target",
    };
    const regenerated = buildRegeneratePayload(
      original,
      { content: "Explain the document", attachments: [{ id: "upload-a" }] },
      "assistant-target",
      "regenerate-request",
    );
    expect(regenerated).toMatchObject({
      request_id: "regenerate-request",
      message: "Explain the document",
      thread_id: "thread-a",
      repository_id: "repo-a",
      attachment_ids: ["upload-a"],
      regenerate_message_id: "assistant-target",
    });
    expect(regenerated).not.toHaveProperty("edit_message_id");
    expect(regenerated).not.toHaveProperty("continue_message_id");
    expect(original).toHaveProperty("edit_message_id", "edit-target");
  });

  it("keeps an expired pending selection through a deferred history merge and blocks its explicit send", async () => {
    const { mergeSwicoHistoryAttachments, expiredExplicitAttachments } = await import("../lib/swicoAttachmentState");
    const pending = {
      id: "pending-pdf", name: "report.pdf", status: "expired", expires_at: "2026-09-10T00:00:00Z",
    } as any;
    let resolveHistory!: (items: any[]) => void;
    const history = new Promise<any[]>(resolve => { resolveHistory = resolve; });
    const pendingIds = new Set([pending.id]);
    resolveHistory([{ id: "old-history", name: "old.pdf", status: "ready", expires_at: "2026-09-11T00:00:00Z" }]);
    const merged = mergeSwicoHistoryAttachments(await history, [pending], pendingIds);
    expect(merged.map(item => item.id)).toEqual(["pending-pdf", "old-history"]);
    expect(expiredExplicitAttachments(merged, pendingIds, Date.parse("2026-09-10T12:00:00Z"))).toEqual([pending]);
  });

  it("keeps parity metadata and feature-gated actions in the production screen", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(new URL("../components/swico/SwicoChatScreen.tsx", import.meta.url).pathname, "utf8");
    expect(source).toContain("input_mode");
    expect(source).toContain("voice_turn_id");
    expect(source).toContain("status === 402");
    expect(source).toContain("web_answer_feedback");
    expect(source).toContain("retry_at");
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
