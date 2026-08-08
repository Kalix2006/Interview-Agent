import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CandidateProfile, CurriculumEmbedding } from "../lib/retrieval.ts";
import { getRelevantDays } from "../lib/retrieval.ts";
import {
  countQuestionsAsked,
  deriveCoveredDayIds,
  shouldEndInterview,
  trailingSameDayCount,
  decideFollowUp,
  normalizeHistory,
} from "../lib/interview.ts";

// Load .env manually for direct node execution
const envPath = resolve(process.cwd(), ".env");
if (readFileSync(envPath, "utf8").trim()) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key && rest.length) process.env[key.trim()] = rest.join("=").trim();
  }
}

let failures = 0;

function check(label: string, condition: boolean): void {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
}

async function loadEmbeddings(): Promise<CurriculumEmbedding[]> {
  const raw = readFileSync(resolve(process.cwd(), "data", "curriculum-embeddings.json"), "utf8");
  return JSON.parse(raw) as CurriculumEmbedding[];
}

function loadCandidates(): CandidateProfile[] {
  const raw = readFileSync(resolve(process.cwd(), "data", "candidates.json"), "utf8");
  return (JSON.parse(raw) as { candidates: CandidateProfile[] }).candidates;
}

function resolveCandidate(body: { candidate?: unknown; candidateId?: unknown }): CandidateProfile | null {
  const candidate = body.candidate;
  if (
    candidate &&
    typeof candidate === "object" &&
    candidate !== null &&
    (candidate as { member?: unknown }).member &&
    typeof (candidate as { member?: unknown }).member === "object" &&
    (candidate as { member?: unknown }).member !== null &&
    (candidate as { member: { id?: unknown } }).member.id &&
    Array.isArray((candidate as { missions?: unknown }).missions)
  ) {
    return candidate as CandidateProfile;
  }
  if (typeof body.candidateId === "string" && body.candidateId.length > 0) {
    return loadCandidates().find((c) => c.member.id === body.candidateId) ?? null;
  }
  return null;
}

async function runTests() {
  const embeddings = await loadEmbeddings();
  const candidates = loadCandidates();

  console.log("\n=== EDGE CASE 1: Candidate with zero completed days ===");

  const zeroDaysCandidate: CandidateProfile = {
    member: { id: "SYNTH-0", name: "Synthetic", jobRole: "AI Engineer", yearsExperience: 3, education: "", status: "COMPLETED" },
    missions: [
      { day: 8, title: "Vector Databases", passed: false },
      { day: 10, title: "Retrieval", passed: false },
      { day: 12, title: "Prompt Engineering", passed: false },
      { day: 22, title: "Multi-agent", skipped: true },
      { day: 27, title: "Security", passed: false },
    ],
    signals: { commitDays: 5, missionsCompleted: 0, missionsFirstTry: 0 },
    coveredDayIds: [],
  };

  console.log(`Testing synthetic candidate with ${zeroDaysCandidate.missions.filter(m => m.passed === true).length} passed missions`);

  const seedQuery = `Interview a ${zeroDaysCandidate.member.jobRole} with ${zeroDaysCandidate.member.yearsExperience} years of experience on their weakest curriculum areas.`;

  try {
    const retrieved = await getRelevantDays(seedQuery, zeroDaysCandidate, embeddings, 5);
    check("retrieval returns non-empty for zero-days candidate", retrieved.length > 0);
    check("retrieval returns RankedDay objects", retrieved.every(d => typeof d.day === "number" && typeof d.title === "string"));
    check("retrieval does not include passed days", !retrieved.some(d => zeroDaysCandidate.missions.some(m => m.day === d.day && m.passed === true)));
    check("retrieval does not crash (core assertion)", true);
  } catch (err) {
    check("retrieval does not crash", false);
    console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }

  const minPassedCandidate = candidates.find(c => c.missions.filter(m => m.passed === true).length === 4) ?? candidates[0];
  console.log(`\nAlso testing real candidate: ${minPassedCandidate.member.name} (${minPassedCandidate.member.id}) with ${minPassedCandidate.missions.filter(m => m.passed === true).length} passed missions`);
  try {
    const realSeedQuery = `Interview a ${minPassedCandidate.member.jobRole} with ${minPassedCandidate.member.yearsExperience} years of experience on their weakest curriculum areas.`;
    const retrieved2 = await getRelevantDays(realSeedQuery, minPassedCandidate, embeddings, 5);
    check("retrieval works for minimal passed-days candidate", retrieved2.length > 0);
  } catch (err) {
    check("retrieval works for minimal passed-days candidate", false);
    console.log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log("\n=== EDGE CASE 2: Deep answers should not exceed max follow-ups, must reach 4 distinct days ===");

  const deepClassification = { depth: "deep" as const, hedging: false, accuracy: "high" as const };

  function makeTurn(day: number, text: string) {
    return { role: "interviewer" as const, content: `[D:${day}] ${text}` };
  }
  function makeAnswer(text: string) {
    return { role: "candidate" as const, content: text };
  }

  let history: { role: "interviewer" | "candidate"; content: string }[] = [];
  let followUpCount = 0;
  let maxFollowUpsSeen = 0;

  for (let round = 1; round <= 15; round++) {
    const currentDay = round % 4 + 8;
    history.push(makeTurn(currentDay, `Question ${round} about Day ${currentDay}`));
    history.push(makeAnswer(`Deep detailed answer about ${currentDay} with examples and trade-offs.`));

    const trailing = trailingSameDayCount(history);
    maxFollowUpsSeen = Math.max(maxFollowUpsSeen, trailing);

    const followUp = decideFollowUp(deepClassification, history, true);
    if (followUp) followUpCount++;
  }

  check("deep answers never trigger follow-up", followUpCount === 0);
  check("max consecutive same-day never exceeds 3 (MAX_FOLLOW_UPS_PER_DAY + 1)", maxFollowUpsSeen <= 3);

  history = [
    makeTurn(10, "Q1"), makeAnswer("Deep answer 10a"),
    makeTurn(10, "Q2"), makeAnswer("Deep answer 10b"),
    makeTurn(10, "Q3"), makeAnswer("Deep answer 10c"),
    makeTurn(22, "Q1"), makeAnswer("Deep answer 22a"),
    makeTurn(22, "Q2"), makeAnswer("Deep answer 22b"),
    makeTurn(8, "Q1"), makeAnswer("Deep answer 8a"),
    makeTurn(27, "Q1"), makeAnswer("Deep answer 27a"),
    makeTurn(27, "Q2"), makeAnswer("Deep answer 27b"),
  ];

  const daysCovered = deriveCoveredDayIds(history).size;
  const questionsAsked = countQuestionsAsked(history);
  const done = shouldEndInterview(questionsAsked, daysCovered);

  check("with deep answers across 4 distinct days and 8 questions, interview completes", done === true);
  check("distinct days covered >= 4", daysCovered >= 4);
  check("questions asked >= 8", questionsAsked >= 8);

  console.log(`  questionsAsked: ${questionsAsked}, daysCovered: ${daysCovered}, done: ${done}`);

  console.log("\n=== EDGE CASE 3: Missing/invalid candidateId returns 400 ===");

  const testCases = [
    { body: {}, desc: "empty body" },
    { body: { candidateId: null }, desc: "candidateId null" },
    { body: { candidateId: "" }, desc: "candidateId empty string" },
    { body: { candidateId: 123 }, desc: "candidateId non-string" },
    { body: { candidateId: "NONEXISTENT" }, desc: "candidateId not found" },
    { body: { candidate: null }, desc: "candidate null" },
    { body: { candidate: {} }, desc: "candidate empty object" },
    { body: { candidate: { member: {}, missions: [] } }, desc: "candidate missing member.id" },
    { body: { candidate: { member: { id: "X" }, missions: "not-array" } }, desc: "candidate missions not array" },
  ];

  for (const tc of testCases) {
    const profile = resolveCandidate(tc.body as any);
    check(`resolveCandidate returns null for ${tc.desc}`, profile === null);
  }

  const validProfile = resolveCandidate({ candidateId: candidates[0].member.id });
  check("resolveCandidate returns profile for valid candidateId", validProfile !== null);

  console.log("\n=== EDGE CASE 4: Malformed history validation ===");

  const historyCases = [
    { input: undefined, expect: [], desc: "undefined -> empty array" },
    { input: null, expect: null, desc: "null -> null (invalid)" },
    { input: "not array", expect: null, desc: "string -> null (invalid)" },
    { input: { foo: "bar" }, expect: null, desc: "object -> null (invalid)" },
    { input: [{ role: "interviewer", content: "valid" }], expect: "valid", desc: "valid single turn" },
    { input: [{ role: "invalid", content: "bad role" }], expect: null, desc: "invalid role -> null" },
    { input: [{ role: "interviewer", content: 123 }], expect: null, desc: "non-string content -> null" },
    { input: [{ role: "interviewer", content: "   " }], expect: null, desc: "whitespace-only content -> null" },
    { input: [{ role: "interviewer", content: "Q" }, { role: "candidate", content: "A" }], expect: "valid", desc: "valid two turns" },
    { input: [{ role: "interviewer", content: "Q" }, { role: "interviewer", content: "Q2" }], expect: "valid", desc: "two interviewer turns (valid)" },
    { input: [{ role: "candidate", content: "A" }], expect: "valid", desc: "candidate-only turn (valid)" },
    { input: [{ role: "interviewer", content: "Q" }, null], expect: null, desc: "null entry in array -> null" },
  ];

  for (const tc of historyCases) {
    const result = normalizeHistory(tc.input as any);
    const pass = tc.expect === "valid" ? result !== null && Array.isArray(result)
      : tc.expect === null ? result === null
      : Array.isArray(result) && result.length === 0;
    check(`normalizeHistory: ${tc.desc}`, pass);
    if (!pass) console.log(`  got: ${JSON.stringify(result)}`);
  }

  console.log(`\n=== EDGE CASE SUMMARY: ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`} ===`);
  if (failures > 0) process.exit(1);
}

runTests().catch(err => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
