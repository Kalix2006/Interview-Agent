import type { RankedDay } from "./retrieval.ts";
import {
  buildFallbackQuestion,
  classifyAnswer as classifyAnswerGemini,
  CLASSIFY_FALLBACK,
  generateQuestion as generateQuestionGemini,
  type ClassifyResult,
  type GeneratedQuestion,
  type HistoryEntry,
} from "./gemini.ts";
import { classifyAnswerGroq, generateQuestionGroq } from "./groq.ts";

function redactError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/(?:Bearer\s+|key=)[A-Za-z0-9._\-]+/gi, "[REDACTED]");
  }
  return String(error).replace(/(?:Bearer\s+|key=)[A-Za-z0-9._\-]+/gi, "[REDACTED]");
}

async function tryGroqGenerateQuestion(
  retrievedDays: RankedDay[],
  history: HistoryEntry[],
  isFollowUp: boolean
): Promise<GeneratedQuestion | null> {
  try {
    return await generateQuestionGroq(retrievedDays, history, isFollowUp);
  } catch (error) {
    console.warn(`[provider] groq generateQuestion failed: ${redactError(error)} — falling back to gemini`);
    return null;
  }
}

async function tryGroqClassifyAnswer(
  question: string,
  answerText: string
): Promise<ClassifyResult | null> {
  try {
    return await classifyAnswerGroq(question, answerText);
  } catch (error) {
    console.warn(`[provider] groq classifyAnswer failed: ${redactError(error)} — falling back to gemini`);
    return null;
  }
}

export async function generateQuestion(
  retrievedDays: RankedDay[],
  history: HistoryEntry[],
  isFollowUp: boolean
): Promise<GeneratedQuestion> {
  if (!Array.isArray(retrievedDays) || retrievedDays.length === 0) {
    throw new Error("generateQuestion requires at least one retrieved day");
  }

  const groqResult = await tryGroqGenerateQuestion(retrievedDays, history, isFollowUp);
  if (groqResult) return groqResult;

  return await generateQuestionGemini(retrievedDays, history, isFollowUp);
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

  const groqResult = await tryGroqClassifyAnswer(trimmedQuestion, trimmedAnswer);
  if (groqResult) return groqResult;

  return await classifyAnswerGemini(trimmedQuestion, trimmedAnswer);
}

export { CLASSIFY_FALLBACK, buildFallbackQuestion };
export type { ClassifyResult, GeneratedQuestion, HistoryEntry };
