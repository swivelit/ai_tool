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

const GENERIC_FAILURE_PATTERNS = [
  /I could not fetch a reliable web result/i,
  /I could not complete the web lookup/i,
  /I couldn['\u2019]t find any reliable information/i,
  /I could not fetch the weather right now/i,
  /Internal Server Error/i,
  /OpenAI provider\/configuration error/i,
  /requires OPENAI_API_KEY/i,
  /local_timeout/i,
];

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
  const answer = mockAnswer(question);
  return {
    status: 200,
    requestId: `mock_${QUESTION_BANK.indexOf(question)}`,
    payload: {
      ok: true,
      assistant: {
        text: answer,
      },
      meta: {
        route: "mock_backend",
        source: "mock_backend",
        request_id: `mock_${QUESTION_BANK.indexOf(question)}`,
      },
    },
  };
}

function mockAnswer(question) {
  const answers = {
    "Hi elli": "Hi, I am Elli. How can I help you today?",
    "Do you know about IPL?":
      "Yes. The IPL, or Indian Premier League, is a professional Twenty20 cricket league in India with city-based franchise teams.",
    "Tell me about Indian Premier League":
      "The Indian Premier League is a major T20 cricket league in India where franchise teams play a fast, tournament-style season.",
    "What is photosynthesis?":
      "Photosynthesis is how plants use sunlight, carbon dioxide, and water to make glucose for food and release oxygen.",
    "Explain quantum computing in simple words":
      "Quantum computing uses qubits, which can represent more than just 0 or 1, so some problems can be explored in new ways.",
    "Write a short email asking for a meeting":
      "Subject: Meeting Request\n\nHi, I hope you are well. Could we schedule a short meeting this week to discuss the topic? Best regards.",
    "Do you know about the new election details?":
      "Which election and location do you mean? Share the country, state, or election name and I can look up the latest details.",
    "What is the latest IPL score today?":
      "Live IPL score lookup needs a configured live sports data provider. The backend does not have a reliable live sports provider configured right now, so I cannot verify today's score safely.",
    "Give me 5 birthday gift ideas for my brother":
      "1. Wireless earbuds\n2. A good backpack\n3. A book in his favorite genre\n4. A smartwatch or fitness band\n5. A personalized wallet",
    "What is a compiler?":
      "A compiler is a program that translates source code written by a developer into machine code or another executable form.",
    "Explain black holes simply":
      "A black hole is a region of space where gravity is so strong that even light cannot escape once it gets too close.",
    "Summarize why the sky is blue":
      "The sky looks blue because air molecules scatter shorter blue wavelengths of sunlight more than longer red wavelengths.",
    "What is fistula?":
      "A fistula is an abnormal tunnel or connection between two body parts, such as organs or skin. A clinician can diagnose the cause and treatment.",
    "Create a reminder for tomorrow morning":
      "What should I remind you about tomorrow morning?",
    "What is the weather tomorrow?":
      "Which location should I check the weather for tomorrow?",
  };
  return answers[question] || `I can help with: ${question}`;
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

function requestIdOf(payload, fallback = "") {
  return String(
    payload?.meta?.request_id ||
      payload?.request_id ||
      payload?.requestId ||
      fallback ||
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
  const requestId = `smoke_script_${Date.now()}_${index}`;
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-request-id": requestId,
    },
    body: JSON.stringify({
      // Backwards-compatible body field only. Backend auth owns the real user
      // identity and overwrites any spoofed user_id from the verified bearer.
      user_id: Number(env.SMOKE_CHAT_USER_ID || 1),
      message: question,
      reply_language: "en",
      request_id: requestId,
      client_fallback_reason: "local_timeout",
      client_local_budget_ms: 15_000,
      client_original_route: "local_answer",
    }),
  });
  const payload = await readJsonResponse(response);
  const headerRequestId =
    typeof response.headers?.get === "function" ? response.headers.get("x-request-id") : "";
  return { status: response.status, payload, requestId: requestIdOf(payload, headerRequestId || requestId) };
}

function includesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function normalizedAnswer(payload) {
  return answerText(payload).replace(/\s+/g, " ").trim();
}

function hasFiveIdeas(answer) {
  const numbered = (answer.match(/(?:^|\s)(?:[1-5][.)]|[1-5]\s+-)/g) || []).length;
  const bullets = (answer.match(/(?:^|\n)\s*[-*]\s+/g) || []).length;
  return numbered >= 5 || bullets >= 5 || /\bfive\b/i.test(answer);
}

function isLiveSportsInfraBlocker(answer) {
  return (
    /live (?:ipl )?(?:sports|score).*provider/i.test(answer) ||
    /(?:can(?:not|'t)|unable to) check (?:the )?live (?:ipl )?score/i.test(answer)
  ) &&
    /(?:not configured|unavailable|not available|cannot verify|can't verify|doesn['\u2019]t have|no reliable live)/i.test(answer);
}

function validateQuestionAnswer(question, status, payload) {
  const answer = normalizedAnswer(payload);
  const preview = previewText(payload);
  const combined = `${answer} ${preview}`;
  const route = routeOf(payload).toLowerCase();
  const source = sourceOf(payload).toLowerCase();

  if (status !== 200) {
    return { result: "fail", reason: `http_${status || "error"}` };
  }
  if (!answer) {
    return { result: "fail", reason: "empty_answer" };
  }
  if (includesAny(combined, GENERIC_FAILURE_PATTERNS)) {
    return { result: "fail", reason: "generic_failure_answer" };
  }
  if (payload?.ok === false && !hasClearConsentReason(payload)) {
    return { result: "fail", reason: "payload_not_ok" };
  }

  switch (question) {
    case "Hi elli":
      return /(?:hi|hello|hey|greetings)\b/i.test(answer) && /(?:help|assist|elli|today)/i.test(answer)
        ? { result: "pass", reason: "" }
        : { result: "fail", reason: "expected_greeting" };
    case "Do you know about IPL?":
    case "Tell me about Indian Premier League":
      return /(?:ipl|indian premier league)/i.test(answer) && /(?:cricket|t20|twenty20|league|franchise|teams?)/i.test(answer)
        ? { result: "pass", reason: "" }
        : { result: "fail", reason: "expected_general_ipl_answer" };
    case "What is photosynthesis?":
      return /photosynthesis|plants?/i.test(answer) && /sunlight|light/i.test(answer) && /carbon dioxide|co2|oxygen|glucose|food|chlorophyll/i.test(answer)
        ? { result: "pass", reason: "" }
        : { result: "fail", reason: "expected_photosynthesis_explanation" };
    case "Explain quantum computing in simple words":
      return /quantum|qubit/i.test(answer) && /computer|computing/i.test(answer)
        ? { result: "pass", reason: "" }
        : { result: "fail", reason: "expected_quantum_explanation" };
    case "Write a short email asking for a meeting":
      return /(?:hi|hello|dear|subject:)/i.test(answer) && /meeting/i.test(answer) && /(?:regards|sincerely|thank|available|schedule)/i.test(answer)
        ? { result: "pass", reason: "" }
        : { result: "fail", reason: "expected_email_like_response" };
    case "Do you know about the new election details?":
      if (/which election|what election|which location|country|state|where/i.test(answer)) {
        return { result: "pass", reason: "" };
      }
      return /(?:web|search|backend|agentic_web|mock)/i.test(`${route} ${source}`) && /election|vote|poll|result|candidate|latest|current|source/i.test(answer)
        ? { result: "pass", reason: "" }
        : { result: "fail", reason: "expected_election_lookup_or_clarification" };
    case "What is the latest IPL score today?":
      if (isLiveSportsInfraBlocker(answer)) {
        return { result: "infra", reason: "live_sports_provider_unavailable" };
      }
      return /(?:web|search|sports|mock)/i.test(`${route} ${source}`) &&
        /(?:ipl|indian premier league)/i.test(answer) &&
        /(?:score|run|runs|wicket|match|won|playing|vs\.?|versus)/i.test(answer)
        ? { result: "pass", reason: "" }
        : { result: "fail", reason: "expected_live_ipl_score_or_infra_blocker" };
    case "Give me 5 birthday gift ideas for my brother":
      return hasFiveIdeas(answer) && /gift|idea|brother|birthday|earbuds|book|wallet|backpack|watch/i.test(answer)
        ? { result: "pass", reason: "" }
        : { result: "fail", reason: "expected_five_gift_ideas" };
    case "What is a compiler?":
      return /compiler/i.test(answer) && /(?:source code|code|program)/i.test(answer) && /(?:machine|executable|translate|translates|binary)/i.test(answer)
        ? { result: "pass", reason: "" }
        : { result: "fail", reason: "expected_compiler_explanation" };
    case "Explain black holes simply":
      return /black hole/i.test(answer) && /gravity|gravitational/i.test(answer) && /light|escape/i.test(answer)
        ? { result: "pass", reason: "" }
        : { result: "fail", reason: "expected_black_hole_explanation" };
    case "Summarize why the sky is blue":
      return /sky/i.test(answer) && /blue/i.test(answer) && /(?:rayleigh|scatter|scattering|wavelength|sunlight|atmosphere)/i.test(answer)
        ? { result: "pass", reason: "" }
        : { result: "fail", reason: "expected_sky_blue_explanation" };
    case "What is fistula?":
      if (/emergency detected|call emergency/i.test(answer)) {
        return { result: "fail", reason: "misclassified_fistula_as_emergency" };
      }
      return /fistula/i.test(answer) && /(?:abnormal|tunnel|connection|passage)/i.test(answer) && /(?:doctor|clinician|medical|healthcare|consult|diagnos)/i.test(answer)
        ? { result: "pass", reason: "" }
        : { result: "fail", reason: "expected_safe_medical_explanation" };
    case "Create a reminder for tomorrow morning":
      if (/do not have any reminders scheduled for tomorrow|do not have any tomorrow reminders/i.test(answer)) {
        return { result: "fail", reason: "listed_reminders_instead_of_creation_clarification" };
      }
      return /(?:what|which|tell me|share).*(?:remind|reminder|about)|(?:remind|reminder).*(?:what|about)/i.test(answer)
        ? { result: "pass", reason: "" }
        : { result: "fail", reason: "expected_reminder_content_clarification" };
    case "What is the weather tomorrow?":
      if (/which location|what location|city|place|where/i.test(answer)) {
        return { result: "pass", reason: "" };
      }
      return /weather|temperature|forecast|rain|°|degrees|celsius|fahrenheit/i.test(answer)
        ? { result: "pass", reason: "" }
        : { result: "fail", reason: "expected_weather_answer_or_location_clarification" };
    default:
      return { result: "pass", reason: "" };
  }
}

function evaluateAnswer(question, status, payload) {
  return validateQuestionAnswer(question, status, payload);
}

function rowPass(status, payload, question = "") {
  const evaluation = evaluateAnswer(question, status, payload);
  const answer = answerText(payload);
  return (
    evaluation.result === "pass" &&
    answer.length > 0 &&
    (payload?.ok !== false || hasClearConsentReason(payload))
  );
}

function formatRow(question, status, payload, requestId = "") {
  const evaluation = evaluateAnswer(question, status, payload);
  const pass = evaluation.result === "pass";
  const preview =
    status >= 500
      ? errorPreviewText(payload) || previewText(payload)
      : previewText(payload);
  const route = routeOf(payload) || "unknown";
  const source = sourceOf(payload) || "unknown";
  const httpStatus = status || "error";
  const result = evaluation.result;
  return {
    pass,
    failed: result === "fail",
    blocked: result === "infra",
    result,
    reason: evaluation.reason,
    status: httpStatus,
    route,
    source,
    preview,
    requestId: requestIdOf(payload, requestId),
    question,
    line: `${question} | ${httpStatus} | ${route} | ${source} | ${preview.slice(0, 72)} | ${result}`,
  };
}

function selectQuestions(env = process.env) {
  return envFlag(env.SMOKE_CHAT_ALL_QUESTIONS) ? [...QUESTION_BANK] : seededSample(QUESTION_BANK, 10);
}

async function main(env = process.env, fetchImpl = fetch) {
  const questions = selectQuestions(env);
  const baseUrl = String(env.SMOKE_CHAT_BASE_URL || "").trim();
  const useMock = envFlag(env.SMOKE_CHAT_USE_MOCK) || !baseUrl;
  const rows = [
    "question | httpStatus | route | source | answerPreview | pass/fail",
  ];
  let failed = false;
  const results = [];
  let token = "";

  if (!useMock) {
    token = await resolveAuthToken(env, fetchImpl);
    await ensureBackendUser(baseUrl, token, env, fetchImpl);
  }

  for (const [index, question] of questions.entries()) {
    let status = 0;
    let payload = {};
    let requestId = "";
    try {
      const result = useMock
        ? mockResponse(question)
        : await askBackend(baseUrl, token, question, index, env, fetchImpl);
      status = result.status;
      payload = result.payload;
      requestId = result.requestId || requestIdOf(payload);
    } catch (error) {
      payload = {
        ok: false,
        error: error instanceof Error ? error.message : String(error || "error"),
      };
    }

    const row = formatRow(question, status, payload, requestId);
    failed ||= row.failed;
    results.push(row);
    rows.push(row.line);
  }

  const passedCount = results.filter((row) => row.pass).length;
  const failedRows = results.filter((row) => row.failed);
  const blockedRows = results.filter((row) => row.blocked);
  rows.push(
    `summary | total=${results.length} | passed=${passedCount} | failed=${failedRows.length} | blocked=${blockedRows.length}`,
  );
  if (failedRows.length > 0) {
    rows.push("failed questions:");
    for (const row of failedRows) {
      rows.push(
        `- ${row.question} | status=${row.status} | route=${row.route} | source=${row.source} | request_id=${row.requestId || "unknown"} | reason=${row.reason} | preview=${row.preview.slice(0, 160)}`,
      );
    }
  }
  if (blockedRows.length > 0) {
    rows.push("infra blocked questions:");
    for (const row of blockedRows) {
      rows.push(
        `- ${row.question} | status=${row.status} | route=${row.route} | source=${row.source} | request_id=${row.requestId || "unknown"} | reason=${row.reason} | preview=${row.preview.slice(0, 160)}`,
      );
    }
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
  QUESTION_BANK,
  answerText,
  askBackend,
  evaluateAnswer,
  ensureBackendUser,
  fetchFirebaseIdToken,
  formatRow,
  previewText,
  resolveAuthToken,
  rowPass,
  selectQuestions,
  seededSample,
};
