import { buildFeedbackReportFallback, parseFeedbackReport, type Topic } from "../lib/llm.ts";

let failures = 0;

function check(label: string, condition: boolean): void {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
}

const validReport = JSON.stringify({
  topics: [
    { day: 22, title: "Multi-Agent Orchestration", score: "low", rationale: "Could not explain single vs multi-agent trade-offs." },
    { day: 8, title: "Vector Databases Overview", score: "high", rationale: "Described HNSW indexing and re-embedding jobs precisely." },
  ],
  gaps: ["Confused routing with RAG retrieval", "No mention of guardrails"],
  next: ["Study agent delegation patterns", "Practice structured answers"],
});

check("valid report parses", parseFeedbackReport(validReport) !== null);
check("parsed day/title/score preserved", (() => {
  const report = parseFeedbackReport(validReport);
  return (
    report?.topics[0].day === 22 &&
    report.topics[0].title === "Multi-Agent Orchestration" &&
    report.topics[0].score === "low" &&
    report.topics[1].score === "high" &&
    report.gaps.length === 2 &&
    report.next.length === 2
  );
})());

check("missing topics -> null", parseFeedbackReport('{"gaps":[],"next":[]}') === null);
check("empty topics -> null", parseFeedbackReport('{"topics":[],"gaps":[],"next":[]}') === null);
check("bad score enum -> null", parseFeedbackReport(JSON.stringify({ topics: [{ day: 1, title: "T", score: "expert", rationale: "r" }], gaps: [], next: [] })) === null);
check("string day -> null", parseFeedbackReport(JSON.stringify({ topics: [{ day: "one", title: "T", score: "low", rationale: "r" }], gaps: [], next: [] })) === null);
check("empty rationale -> null", parseFeedbackReport(JSON.stringify({ topics: [{ day: 1, title: "T", score: "low", rationale: "  " }], gaps: [], next: [] })) === null);
check("gaps not strings -> null", parseFeedbackReport(JSON.stringify({ topics: [{ day: 1, title: "T", score: "low", rationale: "r" }], gaps: [1], next: [] })) === null);
check("missing next -> null", parseFeedbackReport(JSON.stringify({ topics: [{ day: 1, title: "T", score: "low", rationale: "r" }], gaps: [] })) === null);
check("fenced json parses", parseFeedbackReport('```json\n' + validReport + '\n```') !== null);
check("non-object -> null", parseFeedbackReport('"hello"') === null);
check("invalid json -> null", parseFeedbackReport('{topics: nope}') === null);

const topics: Topic[] = [
  { day: 10, title: "The Retrieval & Matching Engine" },
  { day: 27, title: "Security, Privacy & Guardrails" },
];
const fallback = buildFeedbackReportFallback(topics);
check("fallback covers all provided topics", fallback.topics.length === 2);
check("fallback score is medium", fallback.topics.every((t) => t.score === "medium"));
check("fallback preserves day/title", fallback.topics[0].day === 10 && fallback.topics[1].title === "Security, Privacy & Guardrails");
check("fallback flags unable message", fallback.gaps.includes("Unable to generate full feedback."));
check("fallback next is actionable", fallback.next.length > 0);

console.log(`\nfeedback checks: passed ${failures === 0}`);
if (failures > 0) throw new Error(`${failures} check(s) failed`);
