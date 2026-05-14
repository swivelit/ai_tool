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

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function seededSample(values: string[], count: number, seed = 1778790105) {
  const random = seededRandom(seed);
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy.slice(0, count);
}

function mockResponse(question: string) {
  return {
    ok: true,
    assistant: {
      text: `Mock backend answer for: ${question}`,
    },
    meta: {
      route: "mock_backend",
      source: "mock_backend",
    },
  };
}

async function askBackend(baseUrl: string, question: string, index: number) {
  const headers: Record<string, string> = {
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
  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status} for "${question}"`);
  }
  return response.json();
}

async function main() {
  const questions = seededSample(QUESTION_BANK, 10);
  const baseUrl = String(process.env.SMOKE_CHAT_BASE_URL || "").trim();
  const useMock = !baseUrl || !process.env.OPENAI_API_KEY;
  const rows: string[] = [
    "question | status | answerPreview",
  ];

  for (const [index, question] of questions.entries()) {
    const payload = useMock
      ? mockResponse(question)
      : await askBackend(baseUrl, question, index);
    const answer = String(payload?.assistant?.text || payload?.item?.details || "").trim();
    if (!answer) throw new Error(`Empty answer for "${question}"`);
    if (/local_timeout/i.test(answer)) {
      throw new Error(`local_timeout leaked into answer for "${question}"`);
    }
    rows.push(`${question} | pass | ${answer.slice(0, 72)}`);
  }

  console.log(rows.join("\n"));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
