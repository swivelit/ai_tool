const QUESTION_BANK = [
  "Hi elli",
  "Do you know about IPL?",
  "Tell me about Indian Premier League",
  "What is photosynthesis?",
  "Explain quantum computing in simple words",
  "Write a short email asking for a meeting",
  "Do you know about the new election details?",
  "What is the latest IPL score today?",
  "Give me 5 birthday gift ideas for my brother",
  "What is a compiler?",
  "Explain black holes simply",
  "Summarize why the sky is blue",
  "What is fistula?",
  "Create a reminder for tomorrow morning",
  "What is the weather tomorrow?",
];

const MISSING_REAL_AUTH_MESSAGE =
  "Real backend smoke tests require SMOKE_CHAT_AUTH_TOKEN or SMOKE_CHAT_FIREBASE_EMAIL/SMOKE_CHAT_FIREBASE_PASSWORD/SMOKE_CHAT_FIREBASE_API_KEY.";

class SmokeConfigError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "SmokeConfigError";
    this.exitCode = exitCode;
  }
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function seededSample(values, count, seed = 1778790105) {
  const random = seededRandom(seed);
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy.slice(0, count);
}

function envFlag(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

function mockResponse(question) {
  return {
    status: 200,
    payload: {
      ok: true,
      assistant: {
        text: `Mock backend answer for: ${question}`,
      },
      meta: {
        route: "mock_backend",
        source: "mock_backend",
      },
    },
  };
}

function answerText(payload) {
  return String(
    payload?.assistant?.text ||
      payload?.assistant?.english ||
      payload?.item?.details ||
      payload?.details ||
      "",
  ).trim();
}

function previewValue(value) {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorPreviewText(payload) {
  return String(
    previewValue(payload?.detail) ||
      previewValue(payload?.error?.message) ||
      previewValue(payload?.error) ||
      previewValue(payload?.message) ||
      previewValue(payload?.reason) ||
      "",
  )
    .replace(/\s+/g, " ")
    .trim();
}

function previewText(payload) {
  return String(
    answerText(payload) ||
      errorPreviewText(payload) ||
      "",
  )
    .replace(/\s+/g, " ")
    .trim();
}

function routeOf(payload) {
  return String(payload?.meta?.route || payload?.pipeline?.route_taken || "");
}

function sourceOf(payload) {
  return String(
    payload?.meta?.source ||
      payload?.meta?.agent_source ||
      payload?.pipeline?.direct_answer_source ||
      "",
  );
}

function hasClearConsentReason(payload) {
  return (
    payload?.kind === "cloud_consent_required" ||
    payload?.meta?.cloudFallback?.kind === "cloud_consent_required" ||
    payload?.meta?.route === "cloud_consent_required"
  );
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { ok: false, error: text || "non_json_response" };
  }
}

function safeErrorPreview(payload) {
  return String(
    payload?.error?.message ||
      payload?.error ||
      payload?.detail ||
      payload?.message ||
      "request failed",
  )
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

async function fetchFirebaseIdToken(env = process.env, fetchImpl = fetch) {
  const email = String(env.SMOKE_CHAT_FIREBASE_EMAIL || "").trim();
  const password = String(env.SMOKE_CHAT_FIREBASE_PASSWORD || "");
  const apiKey = String(
    env.SMOKE_CHAT_FIREBASE_API_KEY || env.EXPO_PUBLIC_FIREBASE_API_KEY || "",
  ).trim();
  if (!email || !password || !apiKey) {
    return null;
  }

  const response = await fetchImpl(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true,
      }),
    },
  );
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    throw new SmokeConfigError(
      `Firebase sign-in failed: ${safeErrorPreview(payload)}`,
      1,
    );
  }

  const idToken = String(payload?.idToken || "").trim();
  if (!idToken) {
    throw new SmokeConfigError("Firebase sign-in did not return an ID token.", 1);
  }
  return idToken;
}

async function resolveAuthToken(env = process.env, fetchImpl = fetch) {
  const explicitToken = String(env.SMOKE_CHAT_AUTH_TOKEN || "").trim();
  if (explicitToken) {
    return explicitToken;
  }

  const firebaseToken = await fetchFirebaseIdToken(env, fetchImpl);
  if (firebaseToken) {
    return firebaseToken;
  }

  throw new SmokeConfigError(MISSING_REAL_AUTH_MESSAGE, 2);
}

async function ensureBackendUser(baseUrl, token, env = process.env, fetchImpl = fetch) {
  const headers = {
    Authorization: `Bearer ${token}`,
  };
  const resolved = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/users/resolve`, {
    method: "GET",
    headers,
  });
  const resolvePayload = await readJsonResponse(resolved);

  if (!resolved.ok) {
    throw new SmokeConfigError(
      `Backend auth check failed with HTTP ${resolved.status}: ${safeErrorPreview(resolvePayload)}`,
      1,
    );
  }

  if (resolvePayload?.found) {
    return resolvePayload;
  }

  if (!envFlag(env.SMOKE_CHAT_ENSURE_USER)) {
    throw new SmokeConfigError(
      "Auth token is valid, but no backend user exists for this Firebase account. Sign up once in the app or set SMOKE_CHAT_ENSURE_USER=true for a dedicated smoke account.",
      2,
    );
  }

  const created = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/users`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: String(env.SMOKE_CHAT_USER_NAME || "Smoke Test User"),
      timezone: String(env.SMOKE_CHAT_TIMEZONE || "Asia/Kolkata"),
      assistant_name: String(env.SMOKE_CHAT_ASSISTANT_NAME || "Elli"),
      reply_language: String(env.SMOKE_CHAT_REPLY_LANGUAGE || "en"),
    }),
  });
  const createPayload = await readJsonResponse(created);
  if (!created.ok) {
    throw new SmokeConfigError(
      `Backend smoke user creation failed with HTTP ${created.status}: ${safeErrorPreview(createPayload)}`,
      1,
    );
  }
  return { found: true, user: createPayload };
}

async function askBackend(baseUrl, token, question, index, env = process.env, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      // Backwards-compatible body field only. Backend auth owns the real user
      // identity and overwrites any spoofed user_id from the verified bearer.
      user_id: Number(env.SMOKE_CHAT_USER_ID || 1),
      message: question,
      reply_language: "en",
      request_id: `smoke_script_${Date.now()}_${index}`,
      client_fallback_reason: "local_timeout",
      client_local_budget_ms: 15_000,
      client_original_route: "local_answer",
    }),
  });
  const payload = await readJsonResponse(response);
  return { status: response.status, payload };
}

function rowPass(status, payload) {
  const answer = answerText(payload);
  return (
    status === 200 &&
    answer.length > 0 &&
    !/local_timeout/i.test(answer) &&
    (payload?.ok !== false || hasClearConsentReason(payload))
  );
}

function formatRow(question, status, payload) {
  const pass = rowPass(status, payload);
  const preview =
    status >= 500
      ? errorPreviewText(payload) || previewText(payload)
      : previewText(payload);
  const route = routeOf(payload) || "unknown";
  const source = sourceOf(payload) || "unknown";
  const httpStatus = status || "error";
  const result = pass ? "pass" : "fail";
  return {
    pass,
    line: `${question} | ${httpStatus} | ${route} | ${source} | ${preview.slice(0, 72)} | ${result}`,
  };
}

async function main(env = process.env, fetchImpl = fetch) {
  const questions = seededSample(QUESTION_BANK, 10);
  const baseUrl = String(env.SMOKE_CHAT_BASE_URL || "").trim();
  const useMock = envFlag(env.SMOKE_CHAT_USE_MOCK) || !baseUrl;
  const rows = [
    "question | httpStatus | route | source | answerPreview | pass/fail",
  ];
  let failed = false;
  let token = "";

  if (!useMock) {
    token = await resolveAuthToken(env, fetchImpl);
    await ensureBackendUser(baseUrl, token, env, fetchImpl);
  }

  for (const [index, question] of questions.entries()) {
    let status = 0;
    let payload = {};
    try {
      const result = useMock
        ? mockResponse(question)
        : await askBackend(baseUrl, token, question, index, env, fetchImpl);
      status = result.status;
      payload = result.payload;
    } catch (error) {
      payload = {
        ok: false,
        error: error instanceof Error ? error.message : String(error || "error"),
      };
    }

    const row = formatRow(question, status, payload);
    failed ||= !row.pass;
    rows.push(row.line);
  }

  console.log(rows.join("\n"));
  if (failed) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error || "error"));
    process.exitCode = error instanceof SmokeConfigError ? error.exitCode : 1;
  });
}

module.exports = {
  MISSING_REAL_AUTH_MESSAGE,
  SmokeConfigError,
  answerText,
  askBackend,
  ensureBackendUser,
  fetchFirebaseIdToken,
  formatRow,
  previewText,
  resolveAuthToken,
  rowPass,
  seededSample,
};
