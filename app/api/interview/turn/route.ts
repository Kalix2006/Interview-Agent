import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import {
  buildFeedbackFallback,
  type ClassifyResult,
  type FeedbackResult,
} from "@/lib/llm.ts";
import { generateFeedbackGroq } from "@/lib/groq.ts";
import { classifyAnswer, generateQuestion } from "@/lib/provider.ts";
import {
  deriveCoveredDayIds as deriveProfileCoveredDayIds,
  getCurriculumDay,
  getRelevantDays,
  type CandidateProfile,
  type RankedDay,
} from "@/lib/retrieval.ts";
import {
  buildSeedQuery,
  countQuestionsAsked,
  decideFollowUp,
  deriveCoveredDayIds,
  isDontKnowAnswer,
  lastCandidateTurn,
  lastInterviewerTurn,
  normalizeHistory,
  parseDayTag,
  recentContextText,
  shouldEndInterview,
  tagQuestion,
  type CompletionOptions,
} from "@/lib/interview.ts";

export const dynamic = "force-dynamic";

const RETRIEVAL_K = 5;

type TurnResponse = {
  reply: string;
  done: boolean;
  feedback?: FeedbackResult;
};

let candidatesCache: CandidateProfile[] | undefined;

function loadCandidates(): CandidateProfile[] {
  if (candidatesCache) return candidatesCache;
  const raw = readFileSync(resolve(process.cwd(), "data", "candidates.json"), "utf8");
  const parsed = JSON.parse(raw) as { candidates: CandidateProfile[] };
  if (!Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
    throw new Error('data/candidates.json must contain a non-empty "candidates" array');
  }
  candidatesCache = parsed.candidates;
  return parsed.candidates;
}

function completionOptions(): CompletionOptions {
  const positiveInt = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
  };
  const minQuestions = positiveInt(process.env.MIN_QUESTIONS, 8);
  const minDays = positiveInt(process.env.MIN_DAYS, 4);
  const maxQuestions = positiveInt(process.env.MAX_QUESTIONS, minQuestions + 4);
  return { minQuestions, minDays, maxQuestions };
}

type RequestBody = {
  history?: unknown;
  candidate?: unknown;
  candidateId?: unknown;
};

function resolveCandidate(body: RequestBody): CandidateProfile | null {
  const candidate = body.candidate;
  if (
    candidate &&
    typeof candidate === "object" &&
    (candidate as { member?: unknown }).member &&
    Array.isArray((candidate as { missions?: unknown }).missions)
  ) {
    return candidate as CandidateProfile;
  }
  if (typeof body.candidateId === "string" && body.candidateId.length > 0) {
    return loadCandidates().find((c) => c.member.id === body.candidateId) ?? null;
  }
  return null;
}

function httpError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function firstFallbackDay(profile: CandidateProfile, interviewCovered: ReadonlySet<number>): RankedDay {
  const profileCovered = deriveProfileCoveredDayIds(profile);
  for (let day = 1; day <= 31; day++) {
    const curriculumDay = getCurriculumDay(day);
    if (curriculumDay && !profileCovered.has(day) && !interviewCovered.has(day)) {
      return { ...curriculumDay, score: 0 };
    }
  }
  for (let day = 1; day <= 31; day++) {
    const curriculumDay = getCurriculumDay(day);
    if (curriculumDay && !interviewCovered.has(day)) {
      return { ...curriculumDay, score: 0 };
    }
  }
  const any = getCurriculumDay(1);
  return {
    ...(any ?? { day: 1, title: "Core Concepts", type: "MODULE", tools: [], objectives: [] }),
    score: 0,
  };
}

async function runInterviewTurn(
  profile: CandidateProfile,
  history: NonNullable<ReturnType<typeof normalizeHistory>>,
  options: CompletionOptions
): Promise<TurnResponse> {
  const questionsAsked = countQuestionsAsked(history);
  const covered = deriveCoveredDayIds(history);
  const daysCovered = covered.size;

  if (shouldEndInterview(questionsAsked, daysCovered, options)) {
    const feedback = await generateFeedbackGroq(history, [...covered].sort((a, b) => a - b));
    return {
      reply: "Interview completed.",
      done: true,
      feedback: feedback ?? buildFeedbackFallback(history, [...covered].sort((a, b) => a - b)),
    };
  }

  const hasPriorQuestion = questionsAsked > 0;
  let classification: ClassifyResult | null = null;
  const lastAnswer = lastCandidateTurn(history);
  const candidateSaysDontKnow = lastAnswer ? isDontKnowAnswer(lastAnswer.content) : false;
  if (hasPriorQuestion && lastAnswer && !candidateSaysDontKnow) {
    const lastQuestion = lastInterviewerTurn(history);
    if (lastQuestion) {
      classification = await classifyAnswer(lastQuestion.content, lastAnswer.content);
    }
  }
  const followUp = decideFollowUp(classification, history, hasPriorQuestion) && !candidateSaysDontKnow;

  const queryText =
    !hasPriorQuestion
      ? buildSeedQuery(profile)
      : candidateSaysDontKnow
        ? buildSeedQuery(profile)
        : recentContextText(history);
  let retrieved = await getRelevantDays(queryText, profile, RETRIEVAL_K, covered);
  if (retrieved.length === 0) {
    retrieved = [firstFallbackDay(profile, covered)];
  }

  let grounding: RankedDay[];
  if (followUp) {
    const lastQuestion = lastInterviewerTurn(history);
    const currentDay = lastQuestion ? parseDayTag(lastQuestion.content) : null;
    const dayObj = currentDay !== null ? getCurriculumDay(currentDay) : undefined;
    grounding = dayObj ? [{ ...dayObj, score: Number.MAX_SAFE_INTEGER }] : retrieved;
    if (grounding.length === 0) {
      grounding = [firstFallbackDay(profile, covered)];
    }
  } else {
    grounding = retrieved;
  }

  const generated = await generateQuestion(grounding, history, followUp);
  const day = Number.isInteger(generated.day) && generated.day >= 1 ? generated.day : grounding[0].day;
  covered.add(day);
  return { reply: tagQuestion(day, generated.question), done: false };
}

function buildFallbackTurn(
  profile: CandidateProfile,
  history: NonNullable<ReturnType<typeof normalizeHistory>>,
  options: CompletionOptions
): TurnResponse {
  const covered = deriveCoveredDayIds(history);
  if (shouldEndInterview(countQuestionsAsked(history), covered.size, options)) {
    return {
      reply: "Interview completed.",
      done: true,
      feedback: buildFeedbackFallback(history, [...covered].sort((a, b) => a - b)),
    };
  }
  const day = firstFallbackDay(profile, covered);
  const reply = tagQuestion(day.day, `Walk me through how you would approach ${day.title.toLowerCase()}.`);
  covered.add(day.day);
  return { reply, done: false };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => null)) as RequestBody | null;
    if (!body || typeof body !== "object") {
      return httpError("Request body must be a JSON object", 400);
    }
    const profile = resolveCandidate(body);
    if (!profile) {
      return httpError('Request must include a "candidate" profile or a valid "candidateId"', 400);
    }
    const history = normalizeHistory(body.history);
    if (!history) {
      return httpError('"history" must be an array of { role, content } turns', 400);
    }
    const options = completionOptions();

    try {
      return NextResponse.json(await runInterviewTurn(profile, history, options));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[turn] interview turn failed, using deterministic fallback: ${message}`);
      return NextResponse.json(buildFallbackTurn(profile, history, options));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return httpError(`Interview turn failed: ${message}`, 500);
  }
}
