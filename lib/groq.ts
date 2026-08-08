import type { HistoryEntry, ClassifyResult, GeneratedQuestion } from "./gemini.ts";

export const GROQ_CHAT_MODEL = "llama-3.3-70b-versatile";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const REQUEST_TIMEOUT_MS = 15000;

function getApiKey(): string {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error("GROQ_API_KEY is not set");
  }
  return apiKey;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonObject(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const direct = tryParseJson(cleaned);
  if (direct !== null) return direct;
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const sliced = tryParseJson(cleaned.slice(start, end + 1));
    if (sliced !== null) return sliced;
  }
  return null;
}

async function callGroqJson(
  systemPrompt: string,
  userPrompt: string,
  label: string
): Promise<string> {
  const apiKey = getApiKey();
  const response = await fetchWithTimeout(
    GROQ_ENDPOINT,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_CHAT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
        max_tokens: 1024,
      }),
    },
    REQUEST_TIMEOUT_MS
  );

  if (!response.ok) {
    const statusText = `${response.status} ${response.statusText}`;
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {}
    throw new Error(`${label} HTTP ${statusText}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error(`${label} returned empty content`);
  }
  return content;
}

export function parseClassifyResultGroq(text: string): ClassifyResult | null {
  const raw = extractJsonObject(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { depth, hedging, accuracy } = raw as Record<string, unknown>;
  if (depth !== "shallow" && depth !== "adequate" && depth !== "deep") return null;
  if (typeof hedging !== "boolean") return null;
  if (accuracy !== "low" && accuracy !== "med" && accuracy !== "high") return null;
  return { depth, hedging, accuracy };
}

export function parseGeneratedQuestionGroq(text: string): GeneratedQuestion | null {
  const raw = extractJsonObject(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { day, question, rationale } = raw as Record<string, unknown>;
  if (typeof day !== "number" || !Number.isInteger(day)) return null;
  if (typeof question !== "string" || question.trim().length === 0) return null;
  if (typeof rationale !== "string" || rationale.trim().length === 0) return null;
  return { day, question: question.trim(), rationale: rationale.trim() };
}

export async function classifyAnswerGroq(question: string, answerText: string): Promise<ClassifyResult | null> {
  const trimmedQuestion = question.trim();
  const trimmedAnswer = answerText.trim();
  if (!trimmedQuestion || !trimmedAnswer) {
    throw new Error("classifyAnswerGroq requires non-empty question and answerText");
  }
  const systemPrompt = `You are a strict technical interviewer grading a candidate's answer during a technical interview.

Classify the candidate's answer to the question into a strict JSON object:
- "depth": "shallow" | "adequate" | "deep" - how much substance and structure the answer has. shallow = vague, one-liner, off-topic, or keywords without explanation. adequate = hits the main points with some detail. deep = precise, structured, connects concepts, gives concrete examples and trade-offs.
- "hedging": boolean - true if the answer is dominated by uncertainty qualifiers ("I think", "maybe", "not sure", "I don't remember", "probably") and shows little confident knowledge; false otherwise.
- "accuracy": "low" | "med" | "high" - technical correctness of what the candidate said relative to the question. low = clearly wrong or hallucinated; med = partially right with errors or gaps; high = correct and complete.

Respond ONLY with the JSON object. Do not add any commentary.`;
  const userPrompt = ["Question:", trimmedQuestion, "", "Candidate's answer:", trimmedAnswer].join("\n");

  const raw = await callGroqJson(systemPrompt, userPrompt, "classifyAnswerGroq");
  return parseClassifyResultGroq(raw);
}

function serializeDaysGroq(days: { day: number; title: string; type: string; objectives: string[]; score: number }[]): string {
  return JSON.stringify(
    days.map((day, index) => ({
      rank: index + 1,
      day: day.day,
      title: day.title,
      type: day.type,
      objectives: day.objectives,
      score: Number(day.score.toFixed(3)),
    })),
    null,
    2
  );
}

function serializeHistoryGroq(history: HistoryEntry[]): string {
  if (history.length === 0) return "(no prior conversation)";
  return history.map((h) => `${h.role === "interviewer" ? "Interviewer" : "Candidate"}: ${h.content}`).join("\n");
}

export async function generateQuestionGroq(
  retrievedDays: { day: number; title: string; type: string; objectives: string[]; score: number }[],
  history: HistoryEntry[],
  isFollowUp: boolean
): Promise<GeneratedQuestion | null> {
  if (!Array.isArray(retrievedDays) || retrievedDays.length === 0) {
    throw new Error("generateQuestionGroq requires at least one retrieved day");
  }
  const followUp = isFollowUp && history.length > 0;
  const systemPrompt = `You are a technical interviewer for an AI engineering cohort focused on building a production healthcare chatbot.

You are shown a ranked list of curriculum days (with objectives) and the conversation transcript so far.
Your job is to ask EXACTLY ONE interview question.

Rules:
- Ground the question explicitly in the objectives of ONE of the provided days. Never ask about a topic that is not listed in the provided objectives.
- Ask a single, focused, conversational question. Do not ask multiple questions at once.
- For a follow-up question, go one level deeper into what the candidate just said, staying on the same day they are currently discussing.
- For a fresh question, pick the most relevant day that should be probed next.
- Respond ONLY with a JSON object with exactly three fields:
  - "day": number - the curriculum day your question is grounded in
  - "question": string - the single question to ask
  - "rationale": string - ONE sentence explaining why this day/question was chosen now`;

  const userPrompt = [
    "Curriculum days (ranked, best first):",
    serializeDaysGroq(retrievedDays),
    "",
    "Conversation so far:",
    serializeHistoryGroq(history),
    "",
    `Question type: ${followUp ? "FOLLOW-UP on the candidate's last answer" : "FRESH question to open the next area"}`,
  ].join("\n");

  const raw = await callGroqJson(systemPrompt, userPrompt, "generateQuestionGroq");
  return parseGeneratedQuestionGroq(raw);
}
