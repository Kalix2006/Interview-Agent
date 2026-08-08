import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GoogleGenAI } from "@google/genai";

export const EMBEDDING_MODEL = "gemini-embedding-001";

export type CandidateMember = {
  id: string;
  name: string;
  jobRole: string;
  yearsExperience: number;
  education: string;
  status: string;
};

export type CandidateMission = {
  day: number;
  title: string;
  passed?: boolean;
  skipped?: boolean;
  attempts?: number;
};

export type CandidateSignals = {
  commitDays: number;
  missionsCompleted: number;
  missionsFirstTry: number;
};

export type CandidateProfile = {
  member: CandidateMember;
  missions: CandidateMission[];
  signals: CandidateSignals;
  coveredDayIds?: number[];
};

export type CurriculumDay = {
  day: number;
  title: string;
  type: string;
  tools: string[];
  objectives: string[];
};

export type CurriculumEmbedding = {
  dayId: number;
  embedding: number[];
};

export type RankedDay = CurriculumDay & { score: number };

const SKIPPED_BOOST = 0.3;
const FAILED_BOOST = 0.25;
const HIGH_ATTEMPTS_BOOST = 0.15;
const HIGH_ATTEMPTS_THRESHOLD = 3;
const EMBED_RETRIES = 3;

let curriculumDaysCache: CurriculumDay[] | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function loadCurriculumDays(): CurriculumDay[] {
  if (curriculumDaysCache) return curriculumDaysCache;
  const raw = readFileSync(resolve(process.cwd(), "data", "curriculum.json"), "utf8");
  const parsed = JSON.parse(raw) as { days: CurriculumDay[] };
  if (!Array.isArray(parsed.days) || parsed.days.length === 0) {
    throw new Error("data/curriculum.json does not contain a non-empty \"days\" array");
  }
  curriculumDaysCache = parsed.days;
  return curriculumDaysCache;
}

export function getCurriculumDay(dayNumber: number): CurriculumDay | undefined {
  return loadCurriculumDays().find((day) => day.day === dayNumber);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Cannot compare embeddings of different dimensions (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function deriveCoveredDayIds(profile: CandidateProfile): Set<number> {
  if (Array.isArray(profile.coveredDayIds)) return new Set(profile.coveredDayIds);
  return new Set(profile.missions.filter((m) => m.passed === true).map((m) => m.day));
}

function deriveBoosts(profile: CandidateProfile): Map<number, number> {
  const boosts = new Map<number, number>();
  for (const mission of profile.missions) {
    let boost = 0;
    if (mission.skipped === true) boost += SKIPPED_BOOST;
    if (mission.passed === false) boost += FAILED_BOOST;
    if (typeof mission.attempts === "number" && mission.attempts >= HIGH_ATTEMPTS_THRESHOLD) {
      boost += HIGH_ATTEMPTS_BOOST;
    }
    if (boost > 0) boosts.set(mission.day, (boosts.get(mission.day) ?? 0) + boost);
  }
  return boosts;
}

export function rankDays(
  historyEmbedding: number[],
  profile: CandidateProfile,
  curriculumEmbeddings: CurriculumEmbedding[],
  k: number
): RankedDay[] {
  if (!Array.isArray(curriculumEmbeddings) || curriculumEmbeddings.length === 0) {
    throw new Error("curriculumEmbeddings must be a non-empty array");
  }
  const covered = deriveCoveredDayIds(profile);
  const boosts = deriveBoosts(profile);
  const daysById = new Map(loadCurriculumDays().map((day) => [day.day, day]));

  const scored: RankedDay[] = [];
  for (const item of curriculumEmbeddings) {
    if (covered.has(item.dayId)) continue;
    const day = daysById.get(item.dayId);
    if (!day) continue;
    const score = cosineSimilarity(historyEmbedding, item.embedding) + (boosts.get(item.dayId) ?? 0);
    scored.push({ ...day, score });
  }

  scored.sort((a, b) => b.score - a.score || a.day - b.day);
  return scored.slice(0, k);
}

let aiClient: GoogleGenAI | undefined;

async function embedText(text: string): Promise<number[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required. Set it in a .env file or the environment. See README setup steps.");
  }
  const client = (aiClient ??= new GoogleGenAI({ apiKey }));
  let lastError: unknown;
  for (let attempt = 1; attempt <= EMBED_RETRIES; attempt++) {
    try {
      const response = await client.models.embedContent({ model: EMBEDDING_MODEL, contents: text });
      const values = response.embeddings?.[0]?.values;
      if (!values || values.length === 0) {
        throw new Error(`No embedding returned for query text (model ${EMBEDDING_MODEL})`);
      }
      return values;
    } catch (error) {
      lastError = error;
      if (attempt < EMBED_RETRIES) {
        const isRateLimit = /429|RESOURCE_EXHAUSTED/i.test(errorMessage(error));
        await sleep((isRateLimit ? 2000 : 1000) * attempt);
      }
    }
  }
  throw new Error(`Embedding request failed after ${EMBED_RETRIES} attempts: ${errorMessage(lastError)}`);
}

export async function getRelevantDays(
  historyText: string,
  profile: CandidateProfile,
  curriculumEmbeddings: CurriculumEmbedding[],
  k: number
): Promise<RankedDay[]> {
  const text = historyText.trim();
  if (!text) {
    throw new Error("historyText must be a non-empty string");
  }
  const embedding = await embedText(text);
  return rankDays(embedding, profile, curriculumEmbeddings, k);
}
