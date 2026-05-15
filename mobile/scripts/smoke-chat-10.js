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

async function askBackend(baseUrl, question, index) {
  const headers = {
    "Content-Type": "application/json",
  };
  const token = process.env.SMOKE_CHAT_AUTH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      user_id: Number(process.env.SMOKE_CHAT_USER_ID || 1),
      message: question,
      reply_language: "en",
      request_id: `smoke_script_${Date.now()}_${index}`,
      client_fallback_reason: "local_timeout",
      client_local_budget_ms: 15_000,
      client_original_route: "local_answer",
    }),
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { ok: false, error: text || "non_json_response" };
  }
  return { status: response.status, payload };
}

async function main() {
  const questions = seededSample(QUESTION_BANK, 10);
  const baseUrl = String(process.env.SMOKE_CHAT_BASE_URL || "").trim();
  const useMock =
    String(process.env.SMOKE_CHAT_USE_MOCK || "").toLowerCase() === "true" ||
    !baseUrl;
  const rows = [
    "question | httpStatus | route | source | answerPreview | pass/fail",
  ];
  let failed = false;

  for (const [index, question] of questions.entries()) {
    let status = 0;
    let payload = {};
    try {
      const result = useMock
        ? mockResponse(question)
        : await askBackend(baseUrl, question, index);
      status = result.status;
      payload = result.payload;
    } catch (error) {
      payload = {
        ok: false,
        error: error instanceof Error ? error.message : String(error || "error"),
      };
    }

    const answer = answerText(payload);
    const pass =
      status === 200 &&
      answer.length > 0 &&
      !/local_timeout/i.test(answer) &&
      (payload?.ok !== false || hasClearConsentReason(payload));
    failed ||= !pass;
    rows.push(
      `${question} | ${status || "error"} | ${routeOf(payload) || "unknown"} | ${sourceOf(payload) || "unknown"} | ${answer.slice(0, 72)} | ${pass ? "pass" : "fail"}`,
    );
  }

  console.log(rows.join("\n"));
  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
