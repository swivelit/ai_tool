import { afterEach, describe, expect, it, vi } from "vitest";

import golden from "../data/evals/golden_assistant.json";
import { shouldAutoSpeakReply } from "../lib/replyPlaybackPolicy";

type GoldenCase = {
  id: string;
  surface: string;
  prompt: string;
  userId?: number;
  expected?: any;
};

function jsonResponse(payload: any, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

function mockLocalStorage() {
  const storage = new Map<string, string>();

  vi.doMock("@react-native-async-storage/async-storage", () => ({
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),

      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),

      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  }));

  vi.doMock("expo-secure-store", () => ({
    getItemAsync: vi.fn(async (key: string) => storage.get(key) ?? null),

    setItemAsync: vi.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),

    deleteItemAsync: vi.fn(async (key: string) => {
      storage.delete(key);
    }),
  }));
}

function mockVoiceEnvironment(fetchMock: ReturnType<typeof vi.fn>) {
  delete (globalThis as any).__JAI_NATIVE_ON_DEVICE_MODEL_RUNTIME__;

  vi.doMock("expo-constants", () => ({
    default: {
      expoConfig: {
        extra: {
          API_BASE: "https://api.example.test",
          LOCAL_MODEL_RUNTIME_MODE: "native_on_device",
          USE_LOCAL_VOICE_PIPELINE: true,
        },
      },
    },
  }));

  vi.doMock("../lib/firebase", () => ({
    auth: {
      currentUser: null,
    },
  }));

  mockLocalStorage();

  vi.stubGlobal("fetch", fetchMock);

  vi.spyOn(console, "info").mockImplementation(() => undefined);
}

function voiceForm() {
  return {
    _parts: [
      [
        "file",
        {
          uri: "file:///tmp/audio.m4a",
          name: "audio.m4a",
          type: "audio/m4a",
        },
      ],
    ],
  } as unknown as FormData;
}

function evaluateVoiceCase(
  testCase: GoldenCase,
  payload: any,
  fetchCalls: number,
) {
  const expected = testCase.expected || {};

  const serialized = JSON.stringify(payload);

  const failures: string[] = [];

  if (expected.kind && payload.kind !== expected.kind) {
    failures.push(
      `${testCase.id}: kind ${payload.kind} !== ${expected.kind}`,
    );
  }

  if (expected.voiceUnavailable && payload.ok !== false) {
    failures.push(
      `${testCase.id}: voice unavailable response did not set ok=false`,
    );
  }

  for (const needle of expected.answerIncludes || []) {
    if (!serialized.includes(needle)) {
      failures.push(
        `${testCase.id}: response missing "${needle}"`,
      );
    }
  }

  for (const needle of expected.answerExcludes || []) {
    if (serialized.includes(needle)) {
      failures.push(
        `${testCase.id}: response leaked "${needle}"`,
      );
    }
  }

  if (expected.noBackendCall && fetchCalls > 0) {
    failures.push(
      `${testCase.id}: backend/local adapter fetch called ${fetchCalls} time(s)`,
    );
  }

  return failures;
}

describe("golden voice eval", () => {
  afterEach(() => {
    delete (globalThis as any).__JAI_NATIVE_ON_DEVICE_MODEL_RUNTIME__;

    vi.restoreAllMocks();

    vi.resetModules();

    vi.unstubAllGlobals();
  });

    it("enforces reply auto-play policy correctly", () => {
    // Normal text chat should NEVER auto-play
    expect(
      shouldAutoSpeakReply({
        source: "text",
        autoSpeakReplies: true,
        handsFreeMode: "off",
      }),
    ).toBe(false);

    // Voice chat may auto-play when enabled
    expect(
      shouldAutoSpeakReply({
        source: "voice",
        autoSpeakReplies: true,
        handsFreeMode: "off",
      }),
    ).toBe(true);

    // Voice chat stays silent when disabled
    expect(
      shouldAutoSpeakReply({
        source: "voice",
        autoSpeakReplies: false,
        handsFreeMode: "off",
      }),
    ).toBe(false);

    // Hands-free mode should always auto-play
    expect(
      shouldAutoSpeakReply({
        source: "handsfree",
        autoSpeakReplies: false,
        handsFreeMode: "wake",
      }),
    ).toBe(true);
  });

  it("returns structured unavailable state when native STT is missing", async () => {
    const cases = (golden.cases as GoldenCase[]).filter(
      (row) => row.surface === "mobile_voice",
    );

    const rows: Array<Record<string, any>> = [];

    const failures: string[] = [];

    for (const testCase of cases) {
      vi.resetModules();

      const fetchMock = vi.fn(async () =>
        jsonResponse({ ok: true }),
      );

      mockVoiceEnvironment(fetchMock);

      const { apiPostForm } = await import("../lib/api");

      const languages = [
        "english",
        "tamil",
        "tanglish",
        "auto",
      ];

      for (const language of languages) {
        const payload = await apiPostForm<any>(
          `/api/transcribe-and-analyze?user_id=${
            testCase.userId || 1
          }&reply_language=${language}&speech_language=${language}`,
          voiceForm(),
        );

        const caseFailures = evaluateVoiceCase(
          testCase,
          payload,
          fetchMock.mock.calls.length,
        );

        failures.push(...caseFailures);

        rows.push({
          id: `${testCase.id}-${language}`,
          language,
          pass: caseFailures.length === 0,
          kind: payload.kind,
          ok: payload.ok,
          backendCalls: fetchMock.mock.calls.length,
          notes: caseFailures.join("; "),
        });
      }
    }

    console.table(rows);

    console.table([
      {
        total: rows.length,
        passed: rows.filter((row) => row.pass).length,
        failed: rows.filter((row) => !row.pass).length,

        cloudConsentViolations: rows.filter(
          (row) => row.backendCalls > 0,
        ).length,

        rawNativeErrorLeaks: rows.filter((row) =>
          String(row.notes || "").includes(
            "JAI_NATIVE_STT_NOT_IMPLEMENTED",
          ),
        ).length,
      },
    ]);

    expect(failures).toEqual([]);
  });
});