import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getRelevantDays,
  type CandidateProfile,
} from "../lib/retrieval.ts";

const ROOT = resolve(process.cwd());
const SAMPLE_ID = process.env.SAMPLE_CANDIDATE_ID ?? "CAND-010";
const K = 5;

const candidates = JSON.parse(
  readFileSync(resolve(ROOT, "data", "candidates.json"), "utf8")
) as { candidates: CandidateProfile[] };

const sample = candidates.candidates.find((c) => c.member.id === SAMPLE_ID);
if (!sample) throw new Error(`Sample candidate ${SAMPLE_ID} not found in data/candidates.json`);

const query = [
  "Probe this candidate on retrieval and semantic search: how to build a query router",
  "that decides between SQL and vector search, merge and deduplicate retrieval sources,",
  "vector database fundamentals, multi-agent orchestration, and which security and",
  "deployment guardrails they skipped.",
].join(" ");

console.log(`Candidate: ${sample.member.name} (${sample.member.jobRole}, ${sample.member.yearsExperience}y)`);
console.log(`Query:    ${query}`);
console.log(`Scorer:   lexical token overlap (idf-weighted), no external embedding API`);
console.log(`k = ${K}\n`);

const results = await getRelevantDays(query, sample, K);

for (const result of results) {
  console.log(`[day ${String(result.day).padStart(2, "0")}] ${result.title}  (score: ${result.score.toFixed(3)})`);
  console.log(`    ${result.objectives.join(" | ")}`);
}

const covered = deriveCovered(sample);
const invalidCovered = results.filter((r) => covered.has(r.day));
const sortedDesc = results.every((r, i) => i === 0 || results[i - 1].score >= r.score);

console.log("\n--- validation ---");
console.log(`count: ${results.length} (<= k: ${results.length <= K})`);
console.log(`no covered days included: ${invalidCovered.length === 0}`);
console.log(`scores sorted descending: ${sortedDesc}`);
console.log(`all have objectives: ${results.every((r) => r.objectives.length > 0)}`);
console.log(`relevant topic surfaced (vector / retrieval / routing): ${
  results.some((r) => /vector|retriev|rout|agent|security|guardrail/i.test(r.title))
}`);

function deriveCovered(profile: CandidateProfile): Set<number> {
  if (Array.isArray(profile.coveredDayIds)) return new Set(profile.coveredDayIds);
  return new Set(profile.missions.filter((m) => m.passed === true).map((m) => m.day));
}
