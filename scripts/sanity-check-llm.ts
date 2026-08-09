import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildFallbackQuestion,
  CLASSIFY_FALLBACK,
  parseClassifyResult,
  parseFeedbackReport,
  parseGeneratedQuestion,
  type HistoryEntry,
} from "../lib/llm.ts";
import { generateQuestion as providerGenerateQuestion } from "../lib/provider.ts";
import { getRelevantDays, type CandidateProfile } from "../lib/retrieval.ts";

const ROOT = resolve(process.cwd());
const SAMPLE_ID = process.env.SAMPLE_CANDIDATE_ID ?? "CAND-010";
const K = 5;

let failures = 0;

function check(label: string, condition: boolean): void {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
}

const candidates = JSON.parse(
  readFileSync(resolve(ROOT, "data", "candidates.json"), "utf8")
) as { candidates: CandidateProfile[] };

const sample = candidates.candidates.find((c) => c.member.id === SAMPLE_ID);
if (!sample) throw new Error(`Sample candidate ${SAMPLE_ID} not found in data/candidates.json`);

console.log("=== pure parser checks (llm.ts) ===\n");

const parseChecks: Array<[string, string, boolean]> = [
  ["valid classify", '{"depth":"deep","hedging":false,"accuracy":"high"}', true],
  ["fenced classify", '```json\n{"depth":"shallow","hedging":true,"accuracy":"low"}\n```', true],
  ["embedded classify", 'Here you go: {"depth":"adequate","hedging":false,"accuracy":"med"}', true],
  ["bad enum depth", '{"depth":"expert","hedging":false,"accuracy":"high"}', false],
  ["bad hedging type", '{"depth":"deep","hedging":"yes","accuracy":"high"}', false],
  ["missing accuracy", '{"depth":"deep","hedging":false}', false],
  ["non-object classify", '"deep"', false],
  ["invalid json classify", "{depth: deep}", false],
  ["valid question", '{"day":10,"question":"How would you route between SQL and vector search?","rationale":"Day 10 is their top gap."}', true],
  ["bad question day", '{"day":"ten","question":"q","rationale":"r"}', false],
  ["empty question", '{"day":10,"question":"   ","rationale":"r"}', false],
  ["no rationale", '{"day":10,"question":"q"}', false],
];

for (const [label, text, expected] of parseChecks) {
  const got = text.includes("depth") ? parseClassifyResult(text) : parseGeneratedQuestion(text);
  const ok = (got !== null) === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

const validReport = JSON.stringify({
  topics: [
    { day: 22, title: "Multi-Agent Orchestration", score: "low", rationale: "Could not explain trade-offs." },
    { day: 8, title: "Vector Databases Overview", score: "high", rationale: "Described HNSW indexing precisely." },
  ],
  gaps: ["Confused routing with RAG retrieval"],
  next: ["Study agent delegation patterns"],
});
check("valid feedback report parses", parseFeedbackReport(validReport) !== null);
check("bad feedback score rejects", parseFeedbackReport(JSON.stringify({ topics: [{ day: 1, title: "T", score: "expert", rationale: "r" }], gaps: [], next: [] })) === null);

console.log("\n=== deterministic fallback checks ===\n");

check("CLASSIFY_FALLBACK has valid shape", CLASSIFY_FALLBACK.depth === "adequate" && typeof CLASSIFY_FALLBACK.hedging === "boolean");

const query = [
  "Probe this candidate on retrieval and semantic search: how to build a query router",
  "that decides between SQL and vector search, merge and deduplicate retrieval sources,",
  "vector database fundamentals, multi-agent orchestration, and which security and",
  "deployment guardrails they skipped.",
].join(" ");

console.log(`Candidate: ${sample.member.name} (${sample.member.jobRole})`);
const days = await getRelevantDays(query, sample, K);
console.log(`Retrieved days for grounding: ${days.map((d) => `D${d.day}:${d.title}`).join(", ")}\n`);
check("lexical retrieval returns top-k days", days.length > 0 && days.length <= K);

const fallback = buildFallbackQuestion(days, 0);
check("buildFallbackQuestion returns a grounded question", typeof fallback.day === "number" && fallback.question.length > 0);

console.log("\n=== live Groq provider (skipped when GROQ_API_KEY is missing) ===\n");

const fallbackHistory: HistoryEntry[] = [
  { role: "interviewer", content: "[D:10] What is the biggest challenge in retrieval-augmented search?" },
  { role: "candidate", content: "Maybe the routing. I think it depends. Not fully sure." },
];

if (!process.env.GROQ_API_KEY) {
  console.log("SKIP  live Groq calls (GROQ_API_KEY not set)");
} else {
  const fresh = await providerGenerateQuestion(days, [], false);
  check("generateQuestion (fresh) via Groq", typeof fresh.day === "number" && fresh.question.length > 0);
  console.log(`  [D${fresh.day}] ${fresh.question}`);

  const followUp = await providerGenerateQuestion(days, fallbackHistory, true);
  check("generateQuestion (follow-up) via Groq", typeof followUp.day === "number" && followUp.question.length > 0);
  console.log(`  [D${followUp.day}] ${followUp.question}`);
}

console.log(`\n=== LLM sanity summary: ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`} ===`);
if (failures > 0) process.exit(1);
