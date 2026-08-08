import { GoogleGenAI, Type, type Schema } from "@google/genai";
import type { RankedDay } from "./retrieval.ts";

export const GEMINI_CHAT_MODEL = "gemini-3.5-flash";

export type Depth = "shallow" | "adequate" | "deep";
export type Accuracy = "low" | "med" | "high";

export type ClassifyResult = {
  depth: Depth;
  hedging: boolean;
  accuracy: Accuracy;
};

export type GeneratedQuestion = {
  day: number;
  question: string;
  rationale: string;
};

export type HistoryEntry = {
  role: "interviewer" | "candidate";
  content: string;
};

export type FeedbackResult = {
  summary: string;
  strengths: string[];
  gaps: string[];
  next: string[];
};

export const CLASSIFY_FALLBACK: ClassifyResult = { depth: "adequate", hedging: false, accuracy: "med" };

const GENAI_RETRIES = 2;
const RETRY_DELAY_MS = 750;

let aiClient: GoogleGenAI | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required. Set it in a .env file or the environment. See README setup steps.");
  }
  return (aiClient ??= new GoogleGenAI({ apiKey }));
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

export function parseClassifyResult(text: string): ClassifyResult | null {
  const raw = extractJsonObject(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { depth, hedging, accuracy } = raw as Record<string, unknown>;
  if (depth !== "shallow" && depth !== "adequate" && depth !== "deep") return null;
  if (typeof hedging !== "boolean") return null;
  if (accuracy !== "low" && accuracy !== "med" && accuracy !== "high") return null;
  return { depth, hedging, accuracy };
}

export function parseGeneratedQuestion(text: string): GeneratedQuestion | null {
  const raw = extractJsonObject(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { day, question, rationale } = raw as Record<string, unknown>;
  if (typeof day !== "number" || !Number.isInteger(day)) return null;
  if (typeof question !== "string" || question.trim().length === 0) return null;
  if (typeof rationale !== "string" || rationale.trim().length === 0) return null;
  return { day, question: question.trim(), rationale: rationale.trim() };
}

const CLASSIFY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    depth: { type: Type.STRING, format: "enum", enum: ["shallow", "adequate", "deep"] },
    hedging: { type: Type.BOOLEAN },
    accuracy: { type: Type.STRING, format: "enum", enum: ["low", "med", "high"] },
  },
  required: ["depth", "hedging", "accuracy"],
};

const QUESTION_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    day: { type: Type.INTEGER, description: "Curriculum day number the question is grounded in" },
    question: { type: Type.STRING, description: "The single interview question to ask" },
    rationale: { type: Type.STRING, description: "One sentence explaining why this day/question was chosen now" },
  },
  required: ["day", "question", "rationale"],
};

async function callJsonModel(systemPrompt: string, userPrompt: string, schema: Schema): Promise<string> {
  const response = await getClient().models.generateContent({
    model: GEMINI_CHAT_MODEL,
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    config: {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
      responseSchema: schema,
    },
  });
  const text = response.text;
  if (!text || text.trim().length === 0) {
    throw new Error(`No text returned from ${GEMINI_CHAT_MODEL}`);
  }
  return text;
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= GENAI_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < GENAI_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  console.warn(`[gemini] ${label} failed after ${GENAI_RETRIES} attempts: ${errorMessage(lastError)}`);
  return null;
}

function buildFallbackQuestion(days: RankedDay[]): GeneratedQuestion {
  const top = days[0];
  const objective = top.objectives[0] ?? "the core concepts of this curriculum day";
  return {
    day: top.day,
    question: `Walk me through how you would approach this task: "${objective}".`,
    rationale: `Targeting Day ${top.day} (${top.title}) because it is the highest-priority area for this candidate.`,
  };
}

function serializeDays(days: RankedDay[]): string {
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

function serializeHistory(history: HistoryEntry[]): string {
  if (history.length === 0) return "(no prior conversation)";
  return history.map((h) => `${h.role === "interviewer" ? "Interviewer" : "Candidate"}: ${h.content}`).join("\n");
}

const QUESTION_SYSTEM_PROMPT = `You are a technical interviewer for an AI engineering cohort focused on building a production healthcare chatbot.

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

export async function generateQuestion(
  retrievedDays: RankedDay[],
  history: HistoryEntry[],
  isFollowUp: boolean
): Promise<GeneratedQuestion> {
  if (!Array.isArray(retrievedDays) || retrievedDays.length === 0) {
    throw new Error("generateQuestion requires at least one retrieved day");
  }
  const followUp = isFollowUp && history.length > 0;
  const userPrompt = [
    "Curriculum days (ranked, best first):",
    serializeDays(retrievedDays),
    "",
    "Conversation so far:",
    serializeHistory(history),
    "",
    `Question type: ${followUp ? "FOLLOW-UP on the candidate's last answer" : "FRESH question to open the next area"}`,
  ].join("\n");

  const generated = await withRetry(async () => {
    const raw = await callJsonModel(QUESTION_SYSTEM_PROMPT, userPrompt, QUESTION_SCHEMA);
    const result = parseGeneratedQuestion(raw);
    if (!result) throw new Error("Gemini returned malformed JSON for generateQuestion");
    return result;
  }, "generateQuestion");

  return generated ?? buildFallbackQuestion(retrievedDays);
}

const CLASSIFY_SYSTEM_PROMPT = `You are a strict technical interviewer grading a candidate's answer during a technical interview.

Classify the candidate's answer to the question into a strict JSON object:
- "depth": "shallow" | "adequate" | "deep" - how much substance and structure the answer has. shallow = vague, one-liner, off-topic, or keywords without explanation. adequate = hits the main points with some detail. deep = precise, structured, connects concepts, gives concrete examples and trade-offs.
- "hedging": boolean - true if the answer is dominated by uncertainty qualifiers ("I think", "maybe", "not sure", "I don't remember", "probably") and shows little confident knowledge; false otherwise.
- "accuracy": "low" | "med" | "high" - technical correctness of what the candidate said relative to the question. low = clearly wrong or hallucinated; med = partially right with errors or gaps; high = correct and complete.

Respond ONLY with the JSON object. Do not add any commentary.`;

export async function classifyAnswer(question: string, answerText: string): Promise<ClassifyResult> {
  const trimmedQuestion = question.trim();
  const trimmedAnswer = answerText.trim();
  if (!trimmedQuestion || !trimmedAnswer) {
    throw new Error("classifyAnswer requires non-empty question and answerText");
  }
  const userPrompt = ["Question:", trimmedQuestion, "", "Candidate's answer:", trimmedAnswer].join("\n");

  const classified = await withRetry(async () => {
    const raw = await callJsonModel(CLASSIFY_SYSTEM_PROMPT, userPrompt, CLASSIFY_SCHEMA);
    const result = parseClassifyResult(raw);
    if (!result) throw new Error("Gemini returned malformed JSON for classifyAnswer");
    return result;
  }, "classifyAnswer");

  return classified ?? { ...CLASSIFY_FALLBACK };
}

const FEEDBACK_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING, description: "2-3 sentence summary of the candidate's interview performance" },
    strengths: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "2-4 concrete strengths demonstrated during the interview",
    },
    gaps: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "2-4 areas where the candidate was weak, vague, or incorrect",
    },
    next: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "2-4 actionable next steps for the candidate",
    },
  },
  required: ["summary", "strengths", "gaps", "next"],
};

export function parseFeedbackResult(text: string): FeedbackResult | null {
  const raw = extractJsonObject(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { summary, strengths, gaps, next } = raw as Record<string, unknown>;
  if (typeof summary !== "string" || summary.trim().length === 0) return null;
  if (!Array.isArray(strengths) || !strengths.every((item) => typeof item === "string")) return null;
  if (!Array.isArray(gaps) || !gaps.every((item) => typeof item === "string")) return null;
  if (!Array.isArray(next) || !next.every((item) => typeof item === "string")) return null;
  return {
    summary: summary.trim(),
    strengths: strengths.map((item) => (item as string).trim()).filter((item) => item.length > 0),
    gaps: gaps.map((item) => (item as string).trim()).filter((item) => item.length > 0),
    next: next.map((item) => (item as string).trim()).filter((item) => item.length > 0),
  };
}

function buildFeedbackFallback(history: HistoryEntry[], coveredDayIds: number[]): FeedbackResult {
  const dayList = coveredDayIds.length > 0 ? coveredDayIds.map((d) => `Day ${d}`).join(", ") : "no days completed";
  return {
    summary: `The interview covered ${coveredDayIds.length} curriculum area(s): ${dayList}.`,
    strengths: [],
    gaps: [],
    next: ["Revisit the curriculum days that were not fully covered during the interview."],
  };
}

const FEEDBACK_SYSTEM_PROMPT = `You are a hiring manager reviewing a technical interview transcript for an AI engineering cohort focused on building a production healthcare chatbot.

Given the full interview transcript (questions carry a day tag like [D:10] identifying the curriculum day they belong to) and the list of covered curriculum days, produce an interview feedback report as a strict JSON object:
- "summary": string - 2-3 sentences summarizing overall performance.
- "strengths": array of strings - 2-4 concrete strengths demonstrated.
- "gaps": array of strings - 2-4 areas where the candidate was weak, vague, or technically off.
- "next": array of strings - 2-4 actionable next steps for the candidate.

Ground every point in what the candidate actually said. Do not invent topics. Respond ONLY with the JSON object.`;

export async function generateFeedback(
  history: HistoryEntry[],
  coveredDayIds: number[]
): Promise<FeedbackResult> {
  const transcript = history
    .map((h) => `${h.role === "interviewer" ? "Interviewer" : "Candidate"}: ${h.content}`)
    .join("\n");
  const covered = coveredDayIds.length > 0 ? coveredDayIds.join(", ") : "(none)";
  const userPrompt = ["Covered curriculum days:", covered, "", "Interview transcript:", transcript].join("\n");

  const generated = await withRetry(async () => {
    const raw = await callJsonModel(FEEDBACK_SYSTEM_PROMPT, userPrompt, FEEDBACK_SCHEMA);
    const result = parseFeedbackResult(raw);
    if (!result) throw new Error("Gemini returned malformed JSON for generateFeedback");
    return result;
  }, "generateFeedback");

  return generated ?? buildFeedbackFallback(history, coveredDayIds);
}
