import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

export type RankedDay = CurriculumDay & { score: number };

const SKIPPED_BOOST = 0.3;
const FAILED_BOOST = 0.25;
const HIGH_ATTEMPTS_BOOST = 0.15;
const HIGH_ATTEMPTS_THRESHOLD = 3;

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "how", "in",
  "is", "it", "its", "of", "on", "or", "that", "the", "their", "them", "they", "this", "to",
  "was", "were", "what", "when", "which", "who", "with", "you", "your", "candidate", "candidates",
  "interview", "interviewing", "years", "experience", "weakest", "curriculum", "areas", "area",
  "would", "can", "should", "must", "about", "into", "over", "out", "so", "than", "then", "too",
]);

let curriculumDaysCache: CurriculumDay[] | undefined;

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

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function dayText(day: CurriculumDay): string {
  return [day.title, day.type, ...day.tools, ...day.objectives].join(" ");
}

function buildDayIndex(days: CurriculumDay[]): Map<number, string[]> {
  const index = new Map<number, string[]>();
  for (const day of days) {
    const tokens = tokenize(dayText(day));
    index.set(day.day, [...new Set(tokens)]);
  }
  return index;
}

function computeIdf(days: CurriculumDay[], index: Map<number, string[]>): Map<string, number> {
  const total = days.length;
  const documentFrequency = new Map<string, number>();
  for (const tokens of index.values()) {
    for (const token of tokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [token, frequency] of documentFrequency) {
    idf.set(token, Math.log(1 + total / (1 + frequency)));
  }
  return idf;
}

export function rankDays(
  historyText: string,
  profile: CandidateProfile,
  k: number,
  extraCovered?: ReadonlySet<number>
): RankedDay[] {
  const days = loadCurriculumDays();
  const index = buildDayIndex(days);
  const idf = computeIdf(days, index);
  const queryTokens = new Set(tokenize(historyText));
  const covered = deriveCoveredDayIds(profile);
  const boosts = deriveBoosts(profile);

  const scored: RankedDay[] = [];
  for (const day of days) {
    if (covered.has(day.day)) continue;
    if (extraCovered && extraCovered.has(day.day)) continue;
    const tokens = index.get(day.day) ?? [];
    let score = 0;
    for (const token of queryTokens) {
      if (tokens.includes(token)) score += idf.get(token) ?? 1;
    }
    scored.push({ ...day, score: score + (boosts.get(day.day) ?? 0) });
  }

  scored.sort((a, b) => b.score - a.score || a.day - b.day);
  return scored.slice(0, k);
}

export async function getRelevantDays(
  historyText: string,
  profile: CandidateProfile,
  k: number,
  extraCovered?: ReadonlySet<number>
): Promise<RankedDay[]> {
  const text = historyText.trim();
  if (!text) {
    throw new Error("historyText must be a non-empty string");
  }
  return rankDays(text, profile, k, extraCovered);
}
