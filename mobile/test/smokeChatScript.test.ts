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
    expect(result.stdout).toContain("summary | total=10");
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

    const serverRow = formatRow("Q", 503, {
      assistant: { text: "" },
      detail:
        "OpenAI provider/configuration error. Check OPENAI_API_KEY and OPENAI_MODEL settings.",
    });
    expect(serverRow.pass).toBe(false);
    expect(serverRow.line).toContain("OpenAI provider/configuration error");
  });

  it("can select the full smoke question bank", () => {
    const { QUESTION_BANK, selectQuestions } = requireScript(scriptPath) as {
      QUESTION_BANK: string[];
      selectQuestions: (env: Record<string, string>) => string[];
    };

    expect(selectQuestions({ SMOKE_CHAT_ALL_QUESTIONS: "true" })).toEqual(QUESTION_BANK);
    expect(selectQuestions({ SMOKE_CHAT_ALL_QUESTIONS: "" })).toHaveLength(10);
  });

  it("fails generic failure answers and weak per-question answers", () => {
    const { evaluateAnswer, formatRow } = requireScript(scriptPath) as {
      evaluateAnswer: (question: string, status: number, payload: any) => { result: string; reason: string };
      formatRow: (question: string, status: number, payload: any) => { pass: boolean; failed: boolean; reason: string };
    };

    expect(
      evaluateAnswer("What is photosynthesis?", 200, {
        ok: true,
        assistant: { text: "I could not fetch a reliable web result for that right now." },
      }),
    ).toMatchObject({ result: "fail", reason: "generic_failure_answer" });
    expect(
      evaluateAnswer("Do you know about the new election details?", 200, {
        ok: true,
        assistant: { text: "I couldn't find any reliable information about the new election details right now." },
        meta: { route: "agentic_web_search", source: "backend_pipeline" },
      }),
    ).toMatchObject({ result: "fail", reason: "generic_failure_answer" });

    expect(
      evaluateAnswer("Create a reminder for tomorrow morning", 200, {
        ok: true,
        assistant: { text: "You do not have any reminders scheduled for tomorrow." },
      }),
    ).toMatchObject({ result: "fail", reason: "listed_reminders_instead_of_creation_clarification" });

    const row = formatRow("What is a compiler?", 200, {
      ok: true,
      assistant: { text: "A compiler is useful." },
    });
    expect(row.pass).toBe(false);
    expect(row.failed).toBe(true);
    expect(row.reason).toBe("expected_compiler_explanation");
  });

  it("marks missing live sports provider as infra instead of pass", () => {
    const { formatRow, rowPass } = requireScript(scriptPath) as {
      formatRow: (question: string, status: number, payload: any) => {
        pass: boolean;
        blocked: boolean;
        result: string;
        reason: string;
      };
      rowPass: (status: number, payload: any, question?: string) => boolean;
    };
    const payload = {
      ok: true,
      assistant: {
        text:
          "Live IPL score lookup needs a configured live sports data provider. The backend does not have a reliable live sports provider configured right now, so I cannot verify today's score safely.",
      },
      meta: { route: "agentic_web_search", source: "backend_pipeline" },
    };

    const row = formatRow("What is the latest IPL score today?", 200, payload);
    expect(row.pass).toBe(false);
    expect(row.blocked).toBe(true);
    expect(row.result).toBe("infra");
    expect(row.reason).toBe("live_sports_provider_unavailable");
    expect(rowPass(200, payload, "What is the latest IPL score today?")).toBe(false);

    const rewrittenPayload = {
      ok: true,
      assistant: {
        text:
          "I can't check the live IPL score right now because the backend doesn't have a reliable live sports data provider configured.",
      },
      meta: { route: "agentic_web_search", source: "backend_pipeline" },
    };
    const rewrittenRow = formatRow("What is the latest IPL score today?", 200, rewrittenPayload);
    expect(rewrittenRow.pass).toBe(false);
    expect(rewrittenRow.blocked).toBe(true);
    expect(rewrittenRow.result).toBe("infra");
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
