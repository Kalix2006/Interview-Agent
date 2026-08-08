import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyAnswer,
  generateQuestion,
  parseClassifyResult,
  parseGeneratedQuestion,
  CLASSIFY_FALLBACK,
  type HistoryEntry,
} from "../lib/gemini.ts";
import { getRelevantDays, type CandidateProfile, type CurriculumEmbedding } from "../lib/retrieval.ts";

const ROOT = resolve(process.cwd());
const SAMPLE_ID = process.env.SAMPLE_CANDIDATE_ID ?? "CAND-010";
const K = 5;

const candidates = JSON.parse(
  readFileSync(resolve(ROOT, "data", "candidates.json"), "utf8")
) as { candidates: CandidateProfile[] };
const embeddings = JSON.parse(
  readFileSync(resolve(ROOT, "data", "curriculum-embeddings.json"), "utf8")
) as CurriculumEmbedding[];

const sample = candidates.candidates.find((c) => c.member.id === SAMPLE_ID);
if (!sample) throw new Error(`Sample candidate ${SAMPLE_ID} not found in data/candidates.json`);

const query = [
  "Probe this candidate on retrieval and semantic search: how to build a query router",
  "that decides between SQL and vector search, merge and deduplicate retrieval sources,",
  "vector database fundamentals, multi-agent orchestration, and which security and",
  "deployment guardrails they skipped.",
].join(" ");

console.log("=== pure parser checks ===\n");

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

let failures = 0;
for (const [label, text, expected] of parseChecks) {
  const got = text.includes("depth") ? parseClassifyResult(text) : parseGeneratedQuestion(text);
  const ok = (got !== null) === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
console.log(`parser checks: ${parseChecks.length - failures}/${parseChecks.length} passed\n`);
if (failures > 0) throw new Error(`${failures} parser check(s) failed`);

const fallback: HistoryEntry[] = [
  { role: "interviewer", content: "What is the biggest challenge in retrieval-augmented search?" },
  { role: "candidate", content: "Maybe the routing. I think it depends. Not fully sure." },
];
const weakAnswer = "I think, maybe, it is like a vector database thing. Probably not sure.";
const strongAnswer = [
  "I would build a router that embeds the query and scores both a SQL candidate and a vector",
  "candidate, then pick whichever has higher confidence. For vectors I would use an HNSW index",
  "with a weekly re-embedding job, and I would dedupe overlapping chunks by hashing before",
  "calling the model so the answer is not contradictory.",
].join(" ");

console.log(`Candidate: ${sample.member.name} (${sample.member.jobRole}, ${sample.member.yearsExperience}y)`);
console.log("Query:    " + query + "\n");

const days = await getRelevantDays(query, sample, embeddings, K);
console.log(`Retrieved days for grounding: ${days.map((d) => `D${d.day}:${d.title}`).join(", ")}\n`);

console.log("=== generateQuestion (fresh) ===");
const fresh = await generateQuestion(days, [], false);
console.log(`[D${fresh.day}] ${fresh.question}`);
console.log(`  rationale: ${fresh.rationale}\n`);

console.log("=== generateQuestion (follow-up) ===");
const followUp = await generateQuestion(days, fallback, true);
console.log(`[D${followUp.day}] ${followUp.question}`);
console.log(`  rationale: ${followUp.rationale}\n`);

console.log("=== classifyAnswer (weak/hedged answer) ===");
console.log(JSON.stringify(await classifyAnswer(fresh.question, weakAnswer), null, 2), "\n");

console.log("=== classifyAnswer (strong answer) ===");
console.log(JSON.stringify(await classifyAnswer(fresh.question, strongAnswer), null, 2), "\n");

console.log("fallback default:", JSON.stringify(CLASSIFY_FALLBACK));
