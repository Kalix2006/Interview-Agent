import type { RankedDay } from "./retrieval.ts";
import {
  buildFallbackQuestion,
  CLASSIFY_FALLBACK,
  type ClassifyResult,
  type GeneratedQuestion,
  type HistoryEntry,
} from "./llm.ts";
import { classifyAnswerGroq, generateQuestionGroq } from "./groq.ts";

function redactError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/(?:Bearer\s+|key=)[A-Za-z0-9._\-]+/gi, "[REDACTED]");
  }
  return String(error).replace(/(?:Bearer\s+|key=)[A-Za-z0-9._\-]+/gi, "[REDACTED]");
}

export async function generateQuestion(
  retrievedDays: RankedDay[],
  history: HistoryEntry[],
  isFollowUp: boolean
): Promise<GeneratedQuestion> {
  if (!Array.isArray(retrievedDays) || retrievedDays.length === 0) {
    throw new Error("generateQuestion requires at least one retrieved day");
  }

  try {
    const result = await generateQuestionGroq(retrievedDays, history, isFollowUp);
    if (result) return result;
  } catch (error) {
    console.warn(`[provider] groq generateQuestion failed: ${redactError(error)} — using deterministic fallback`);
  }

  return buildFallbackQuestion(retrievedDays, history.length);
}

export async function classifyAnswer(
  question: string,
  answerText: string
): Promise<ClassifyResult> {
  const trimmedQuestion = question.trim();
  const trimmedAnswer = answerText.trim();
  if (!trimmedQuestion || !trimmedAnswer) {
    throw new Error("classifyAnswer requires non-empty question and answerText");
  }

  try {
    const result = await classifyAnswerGroq(trimmedQuestion, trimmedAnswer);
    if (result) return result;
  } catch (error) {
    console.warn(`[provider] groq classifyAnswer failed: ${redactError(error)} — using deterministic fallback`);
  }

  return { ...CLASSIFY_FALLBACK };
}

export { CLASSIFY_FALLBACK, buildFallbackQuestion };
export type { ClassifyResult, GeneratedQuestion, HistoryEntry };
