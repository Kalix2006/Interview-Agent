import type { ClassifyResult, HistoryEntry } from "./llm.ts";
import type { CandidateProfile } from "./retrieval.ts";

export const DEFAULT_MIN_QUESTIONS = 8;
export const DEFAULT_MIN_DAYS = 4;
export const MAX_FOLLOW_UPS_PER_DAY = 2;

export function parseDayTag(content: string): number | null {
  const match = /\[D:(\d+)\]/i.exec(content);
  return match ? Number(match[1]) : null;
}

export function tagQuestion(day: number, question: string): string {
  return `[D:${day}] ${question}`;
}

export function countQuestionsAsked(history: HistoryEntry[]): number {
  return history.filter((turn) => turn.role === "interviewer").length;
}

export function deriveCoveredDayIds(history: HistoryEntry[]): Set<number> {
  const days = new Set<number>();
  for (const turn of history) {
    if (turn.role !== "interviewer") continue;
    const day = parseDayTag(turn.content);
    if (day !== null) days.add(day);
  }
  return days;
}

export function lastInterviewerTurn(history: HistoryEntry[]): HistoryEntry | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "interviewer") return history[i];
  }
  return null;
}

export function lastCandidateTurn(history: HistoryEntry[]): HistoryEntry | null {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "candidate") return history[i];
  }
  return null;
}

export function trailingSameDayCount(history: HistoryEntry[]): number {
  const interviewerTurns = history.filter((turn) => turn.role === "interviewer");
  if (interviewerTurns.length === 0) return 0;
  const lastDay = parseDayTag(interviewerTurns[interviewerTurns.length - 1].content);
  if (lastDay === null) return 0;
  let count = 0;
  for (let i = interviewerTurns.length - 1; i >= 0; i--) {
    if (parseDayTag(interviewerTurns[i].content) === lastDay) count++;
    else break;
  }
  return count;
}

export type CompletionOptions = {
  minQuestions?: number;
  minDays?: number;
  maxQuestions?: number;
};

export function shouldEndInterview(
  questionsAsked: number,
  daysCovered: number,
  options?: CompletionOptions
): boolean {
  const minQuestions = options?.minQuestions ?? DEFAULT_MIN_QUESTIONS;
  const minDays = options?.minDays ?? DEFAULT_MIN_DAYS;
  const maxQuestions = options?.maxQuestions ?? minQuestions + 4;
  return (questionsAsked >= minQuestions && daysCovered >= minDays) || questionsAsked >= maxQuestions;
}

export function decideFollowUp(
  classification: ClassifyResult | null,
  history: HistoryEntry[],
  hasPriorQuestion: boolean
): boolean {
  if (!hasPriorQuestion || !classification) return false;
  const lastAnswer = lastCandidateTurn(history);
  if (lastAnswer && isDontKnowAnswer(lastAnswer.content)) return false;
  const weak =
    classification.depth === "shallow" || classification.hedging || classification.accuracy === "low";
  if (!weak) return false;
  return trailingSameDayCount(history) < MAX_FOLLOW_UPS_PER_DAY + 1;
}

export function isDontKnowAnswer(text: string): boolean {
  const lowered = text.trim().toLowerCase();
  const dontKnowPatterns = [
    /i don'?t know/,
    /i do not know/,
    /i don'?t remember/,
    /i do not remember/,
    /i can'?t remember/,
    /i cannot remember/,
    /\bidk\b/,
    /\bdunno\b/,
    /\bnot sure\b/,
    /\bunsure\b/,
    /i have no idea/,
    /\bno idea\b/,
    /don'?t know/,
    /\bpass\b/,
    /\bskip\b/,
    /i cannot answer/,
    /i can't answer/,
    /cannot answer/,
    /can'?t answer/,
    /have no clue/,
    /\bno clue\b/,
    /\bclueless\b/,
    /\bbeats me\b/,
    /you tell me/,
    /\bsearch me\b/,
    /i'?ve got nothing/,
    /got nothing/,
    /no idea how/,
    /no idea what/,
  ];
  return dontKnowPatterns.some((pattern) => pattern.test(lowered));
}

export function buildSeedQuery(profile: CandidateProfile): string {
  const lines = [
    `Interview a ${profile.member.jobRole} with ${profile.member.yearsExperience} years of experience on their weakest curriculum areas.`,
  ];
  for (const mission of profile.missions) {
    if (mission.passed === false || mission.skipped === true) {
      const status = mission.passed === false ? "failed" : "skipped";
      lines.push(`Day ${mission.day}: ${mission.title} (${status})`);
    }
  }
  return lines.join("\n");
}

export function recentContextText(history: HistoryEntry[], maxChars = 1200): string {
  const lines = history.map((turn) => `${turn.role === "interviewer" ? "Interviewer" : "Candidate"}: ${turn.content}`);
  let text = lines.join("\n");
  if (text.length > maxChars) text = "..." + text.slice(text.length - maxChars);
  return text;
}

export function normalizeHistory(value: unknown): HistoryEntry[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const history: HistoryEntry[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return null;
    const { role, content } = entry as { role?: unknown; content?: unknown };
    if (role !== "interviewer" && role !== "candidate") return null;
    if (typeof content !== "string") return null;
    const trimmed = content.trim();
    if (trimmed.length === 0) return null;
    history.push({ role, content: trimmed });
  }
  return history;
}
