import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const mobileDir = resolve(testDir, "..");
const scriptPath = resolve(mobileDir, "scripts/smoke-chat-10.js");
const requireScript = createRequire(import.meta.url);

function scriptEnv(overrides: Record<string, string>) {
  return {
    ...process.env,
    SMOKE_CHAT_BASE_URL: "",
    SMOKE_CHAT_USE_MOCK: "",
    SMOKE_CHAT_AUTH_TOKEN: "",
    SMOKE_CHAT_FIREBASE_API_KEY: "",
    EXPO_PUBLIC_FIREBASE_API_KEY: "",
    SMOKE_CHAT_FIREBASE_EMAIL: "",
    SMOKE_CHAT_FIREBASE_PASSWORD: "",
    SMOKE_CHAT_ENSURE_USER: "",
    ...overrides,
  };
}

describe("smoke-chat-10 script", () => {
  it("succeeds in explicit mock mode without auth", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: mobileDir,
      env: scriptEnv({
        SMOKE_CHAT_USE_MOCK: "true",
      }),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("question | httpStatus | route | source | answerPreview | pass/fail");
    expect(result.stdout).toContain("mock_backend");
    expect(result.stderr).toBe("");
  });

  it("fails fast with code 2 for real backend mode without auth", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: mobileDir,
      env: scriptEnv({
        SMOKE_CHAT_BASE_URL: "https://example.invalid",
        SMOKE_CHAT_USE_MOCK: "false",
      }),
      encoding: "utf8",
    });

    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).toBe(2);
    expect(output).toContain("SMOKE_CHAT_AUTH_TOKEN");
    expect(output).not.toContain("question | httpStatus");
  });

  it("uses detail/error/message payloads for non-200 answer previews", () => {
    const { formatRow, previewText } = requireScript(scriptPath) as {
      formatRow: (question: string, status: number, payload: any) => { pass: boolean; line: string };
      previewText: (payload: any) => string;
    };

    expect(previewText({ detail: "Not authenticated" })).toBe("Not authenticated");
    expect(previewText({ error: "Service unavailable" })).toBe("Service unavailable");
    expect(previewText({ message: "Backend missing" })).toBe("Backend missing");

    const row = formatRow("Q", 401, { detail: "Not authenticated" });
    expect(row.pass).toBe(false);
    expect(row.line).toContain("Not authenticated");
  });

  it("sends the resolved bearer token to /api/chat", async () => {
    const { askBackend } = requireScript(scriptPath) as {
      askBackend: (
        baseUrl: string,
        token: string,
        question: string,
        index: number,
        env: Record<string, string>,
        fetchImpl: typeof fetch,
      ) => Promise<{ status: number; payload: any }>;
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, assistant: { text: "ok" } }),
    }));

    await askBackend(
      "https://api.example.test",
      "firebase-id-token",
      "hello",
      0,
      { SMOKE_CHAT_USER_ID: "22" },
      fetchMock as any,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as any[];
    expect(url).toBe("https://api.example.test/api/chat");
    expect(init.headers.Authorization).toBe("Bearer firebase-id-token");
  });
});
