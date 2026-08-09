import type { HistoryEntry } from "../lib/llm.ts";
import {
  DEFAULT_MIN_DAYS,
  DEFAULT_MIN_QUESTIONS,
  buildSeedQuery,
  countQuestionsAsked,
  decideFollowUp,
  deriveCoveredDayIds,
  parseDayTag,
  recentContextText,
  shouldEndInterview,
  tagQuestion,
  trailingSameDayCount,
} from "../lib/interview.ts";
import type { CandidateProfile } from "../lib/retrieval.ts";

let failures = 0;

function check(label: string, condition: boolean): void {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
}

const tagged = (day: number, text: string): HistoryEntry => ({ role: "interviewer", content: tagQuestion(day, text) });
const answer = (text: string): HistoryEntry => ({ role: "candidate", content: text });

check("parseDayTag basic", parseDayTag("[D:10] How do you route?") === 10);
check("parseDayTag no tag", parseDayTag("How do you route?") === null);
check("parseDayTag case-insensitive", parseDayTag("[d:3] hi") === 3);
check("parseDayTag multi-digit", parseDayTag("[D:22] hi") === 22);
check("tagQuestion round-trips", parseDayTag(tagQuestion(7, "Why?")) === 7);
check("tagQuestion format", tagQuestion(5, "Q") === "[D:5] Q");

const oneQ = [tagged(10, "Q1"), answer("A1")];
const twoSameDay = [tagged(10, "Q1"), answer("A1"), tagged(10, "Q2"), answer("A2")];
const mixedDays = [tagged(10, "Q1"), answer("A1"), tagged(22, "Q2"), answer("A2"), tagged(10, "Q3")];

check("countQuestionsAsked empty", countQuestionsAsked([]) === 0);
check("countQuestionsAsked counts interviewer turns", countQuestionsAsked(mixedDays) === 3);
check("deriveCoveredDayIds", JSON.stringify([...deriveCoveredDayIds(mixedDays)].sort((a, b) => a - b)) === "[10,22]");
check("deriveCoveredDayIds empty", deriveCoveredDayIds([]).size === 0);
check("trailingSameDayCount one", trailingSameDayCount(oneQ) === 1);
check("trailingSameDayCount two", trailingSameDayCount(twoSameDay) === 2);
check("trailingSameDayCount resets on day change", trailingSameDayCount(mixedDays) === 1);

check("shouldEndInterview not yet (7/4)", shouldEndInterview(7, 4) === false);
check("shouldEndInterview not yet (8/3)", shouldEndInterview(8, 3) === false);
check("shouldEndInterview met (8/4)", shouldEndInterview(8, 4) === true);
check("shouldEndInterview force-end (12/0)", shouldEndInterview(12, 0) === true);
check("shouldEndInterview custom thresholds", shouldEndInterview(2, 1, { minQuestions: 2, minDays: 1 }) === true);
check("shouldEndInterview custom max force", shouldEndInterview(3, 0, { minQuestions: 8, minDays: 4, maxQuestions: 3 }) === true);
check("defaults are 8/4", DEFAULT_MIN_QUESTIONS === 8 && DEFAULT_MIN_DAYS === 4);

const strong: { depth: "deep"; hedging: false; accuracy: "high" } = { depth: "deep", hedging: false, accuracy: "high" };
const weak: { depth: "shallow"; hedging: true; accuracy: "low" } = { depth: "shallow", hedging: true, accuracy: "low" };

check("no prior question -> no follow-up", decideFollowUp(weak, [], false) === false);
check("strong answer -> new topic", decideFollowUp(strong, oneQ, true) === false);
check("null classification -> new topic", decideFollowUp(null, oneQ, true) === false);
check("weak answer on opener -> follow-up", decideFollowUp(weak, oneQ, true) === true);
check("weak answer after one follow-up -> still allowed", decideFollowUp(weak, twoSameDay, true) === true);
check("weak answer after two follow-ups -> new topic", decideFollowUp(weak, [tagged(10, "Q1"), answer("A1"), tagged(10, "Q2"), answer("A2"), tagged(10, "Q3"), answer("A3")], true) === false);

check("\"I don't know\" -> no follow-up", decideFollowUp(weak, [tagged(10, "Q1"), answer("I don't know")], true) === false);
check("\"IDK\" -> no follow-up", decideFollowUp(weak, [tagged(10, "Q1"), answer("IDK")], true) === false);
check("\"Not sure\" -> no follow-up", decideFollowUp(weak, [tagged(10, "Q1"), answer("Not sure")], true) === false);
check("\"Pass\" -> no follow-up", decideFollowUp(weak, [tagged(10, "Q1"), answer("Pass")], true) === false);
check("\"Skip\" -> no follow-up", decideFollowUp(weak, [tagged(10, "Q1"), answer("Skip")], true) === false);
check("case-insensitive don't know", decideFollowUp(weak, [tagged(10, "Q1"), answer("I DON'T KNOW")], true) === false);
check("normal weak answer still triggers follow-up", decideFollowUp(weak, [tagged(10, "Q1"), answer("I think maybe it uses vectors")], true) === true);

const profile = {
  member: { id: "X", name: "X", jobRole: "ML Engineer", yearsExperience: 3, education: "", status: "COMPLETED" },
  missions: [
    { day: 8, title: "Vector Databases", passed: false },
    { day: 27, title: "Security Guardrails", skipped: true },
    { day: 10, title: "Retrieval", passed: true },
  ],
  signals: { commitDays: 0, missionsCompleted: 0, missionsFirstTry: 0 },
} satisfies CandidateProfile;

const seed = buildSeedQuery(profile);
check("buildSeedQuery mentions role", seed.includes("ML Engineer"));
check("buildSeedQuery includes failed day", seed.includes("Day 8") && seed.includes("failed"));
check("buildSeedQuery includes skipped day", seed.includes("Day 27") && seed.includes("skipped"));
check("buildSeedQuery excludes passed day", !seed.includes("Day 10"));

const ctx = recentContextText([tagged(10, "Q"), answer("short answer")]);
check("recentContextText renders interviewer", ctx.includes("Interviewer:"));
check("recentContextText renders candidate", ctx.includes("Candidate:"));
check("recentContextText truncates", recentContextText([answer("x".repeat(2000))]).length <= 1300);

console.log(`\ninterview logic checks: passed ${failures === 0}`);
if (failures > 0) throw new Error(`${failures} check(s) failed`);
