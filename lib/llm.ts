// Shared pure helpers for LLM-driven features: types, JSON parsers, and
// deterministic fallbacks. No provider SDKs or API calls live here; the app
// talks only to Groq (see ./groq.ts and ./provider.ts).

import type { RankedDay } from "./retrieval.ts";

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

export type Topic = {
  day: number;
  title: string;
};

export type TopicCompetency = Topic & {
  score: "low" | "medium" | "high";
  rationale: string;
};

export type FeedbackReport = {
  topics: TopicCompetency[];
  gaps: string[];
  next: string[];
};

export const CLASSIFY_FALLBACK: ClassifyResult = { depth: "adequate", hedging: false, accuracy: "med" };

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

export function parseFeedbackReport(text: string): FeedbackReport | null {
  const raw = extractJsonObject(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { topics, gaps, next } = raw as Record<string, unknown>;
  if (!Array.isArray(topics) || topics.length === 0) return null;
  const parsedTopics: TopicCompetency[] = [];
  for (const topic of topics) {
    if (typeof topic !== "object" || topic === null) return null;
    const { day, title, score, rationale } = topic as Record<string, unknown>;
    if (typeof day !== "number" || !Number.isInteger(day)) return null;
    if (typeof title !== "string" || title.trim().length === 0) return null;
    if (score !== "low" && score !== "medium" && score !== "high") return null;
    if (typeof rationale !== "string" || rationale.trim().length === 0) return null;
    parsedTopics.push({ day, title: title.trim(), score, rationale: rationale.trim() });
  }
  const stringArray = (value: unknown): string[] | null => {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
    return value.map((item) => (item as string).trim()).filter((item) => item.length > 0);
  };
  const parsedGaps = stringArray(gaps);
  const parsedNext = stringArray(next);
  if (parsedGaps === null || parsedNext === null) return null;
  return { topics: parsedTopics, gaps: parsedGaps, next: parsedNext };
}

const FALLBACK_QUESTION_TEMPLATES = [
  (obj: string) => `Walk me through how you would approach this task: "${obj}".`,
  (obj: string) => `Can you describe your approach to: "${obj}"?`,
  (obj: string) => `How would you handle the following: "${obj}"?`,
  (obj: string) => `Tell me about your experience with: "${obj}".`,
  (obj: string) => `What's your thought process for: "${obj}"?`,
  (obj: string) => `Explain how you would tackle: "${obj}".`,
  (obj: string) => `Describe a scenario where you'd need to: "${obj}".`,
  (obj: string) => `What would you do if asked to: "${obj}"?`,
  (obj: string) => `Share your approach to: "${obj}".`,
  (obj: string) => `How would you go about: "${obj}"?`,
];

export function buildFallbackQuestion(days: RankedDay[], historyLength = 0): GeneratedQuestion {
  const dayPool = Array.isArray(days) ? days.filter((day) => day && Array.isArray(day.objectives)) : [];
  if (dayPool.length === 0) {
    return {
      day: 1,
      question: "Walk me through a production system you have built, from requirements to deployment.",
      rationale: "Opening with a general engineering question because no curriculum day is available for grounding.",
    };
  }
  const dayIndex = historyLength % dayPool.length;
  const pickedDay = dayPool[dayIndex];
  const objectives = pickedDay.objectives.length > 0
    ? pickedDay.objectives
    : ["the core concepts of this curriculum day"];
  const objectiveIndex = historyLength % objectives.length;
  const objective = objectives[objectiveIndex];
  const templateIndex = historyLength % FALLBACK_QUESTION_TEMPLATES.length;
  const template = FALLBACK_QUESTION_TEMPLATES[templateIndex];
  return {
    day: pickedDay.day,
    question: template(objective),
    rationale: `Targeting Day ${pickedDay.day} (${pickedDay.title}) because it is the highest-priority area for this candidate.`,
  };
}

export function buildFeedbackFallback(history: HistoryEntry[], coveredDayIds: number[]): FeedbackResult {
  const dayList = coveredDayIds.length > 0 ? coveredDayIds.map((d) => `Day ${d}`).join(", ") : "no days completed";
  return {
    summary: `The interview covered ${coveredDayIds.length} curriculum area(s): ${dayList}.`,
    strengths: [],
    gaps: [],
    next: ["Revisit the curriculum days that were not fully covered during the interview."],
  };
}

export function buildFeedbackReportFallback(topics: Topic[]): FeedbackReport {
  return {
    topics: topics.map((topic) => ({
      ...topic,
      score: "medium",
      rationale: "Unable to generate a competency assessment for this topic.",
    })),
    gaps: ["Unable to generate full feedback."],
    next: ["Please retry the feedback request."],
  };
}
