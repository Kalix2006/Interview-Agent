import type { RankedDay } from "../lib/retrieval.ts";
import type { HistoryEntry } from "../lib/gemini.ts";
import { classifyAnswerGroq, generateQuestionGroq, parseClassifyResultGroq, parseGeneratedQuestionGroq } from "../lib/groq.ts";

let failures = 0;

function check(label: string, condition: boolean): void {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
}

function makeDay(day: number, title: string, objectives: string[]): RankedDay {
  return { day, title, type: "MODULE", tools: [], objectives, score: 1.0 };
}

const sampleDays: RankedDay[] = [
  makeDay(10, "Retrieval & Matching Engine", [
    "Build a query router",
    "Merge retrieval sources",
  ]),
  makeDay(8, "Vector Databases Overview", [
    "Set up Chroma",
    "Compare databases",
  ]),
];

const sampleHistory: HistoryEntry[] = [
  { role: "interviewer", content: "[D:10] How would you route between SQL and vector search?" },
  { role: "candidate", content: "I would use a classifier to decide." },
];

function withMockedFetch(
  handler: (url: string, init: RequestInit) => Promise<Response>,
  run: () => Promise<void>
): Promise<void> {
  const original = globalThis.fetch;
  (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init ?? {});
  }) as typeof fetch;
  return run().finally(() => {
    (globalThis as { fetch: typeof fetch }).fetch = original;
  });
}

const okClassify = (): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: '{"depth":"deep","hedging":false,"accuracy":"high"}' } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

const okQuestion = (): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: '{"day":10,"question":"How would you handle X?","rationale":"Tests the candidate on routing."}' } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

const malformed = (): Response =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: "not valid json at all" } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );

const httpError = (status: number, statusText: string): Response =>
  new Response(`error ${statusText}`, { status, statusText });

async function main(): Promise<void> {
  console.log("\n=== Provider: pure Groq parser checks ===");

  check("parseClassifyResultGroq valid", parseClassifyResultGroq('{"depth":"deep","hedging":false,"accuracy":"high"}')?.depth === "deep");
  check("parseClassifyResultGroq rejects bad enum", parseClassifyResultGroq('{"depth":"BAD","hedging":false,"accuracy":"high"}') === null);
  check("parseClassifyResultGroq rejects missing", parseClassifyResultGroq('{"depth":"deep","hedging":false}') === null);
  check("parseClassifyResultGroq handles fenced", parseClassifyResultGroq('```json\n{"depth":"shallow","hedging":true,"accuracy":"low"}\n```')?.hedging === true);
  check("parseClassifyResultGroq handles embedded JSON", parseClassifyResultGroq('Here is the result: {"depth":"adequate","hedging":false,"accuracy":"med"}')?.accuracy === "med");
  check("parseClassifyResultGroq rejects non-JSON", parseClassifyResultGroq("not json") === null);
  check("parseClassifyResultGroq rejects non-object", parseClassifyResultGroq('["depth","deep"]') === null);

  check("parseGeneratedQuestionGroq valid", parseGeneratedQuestionGroq('{"day":10,"question":"How do you route?","rationale":"Tests routing."}')?.day === 10);
  check("parseGeneratedQuestionGroq rejects bad day", parseGeneratedQuestionGroq('{"day":"10","question":"Q","rationale":"r"}') === null);
  check("parseGeneratedQuestionGroq rejects empty question", parseGeneratedQuestionGroq('{"day":10,"question":"   ","rationale":"r"}') === null);
  check("parseGeneratedQuestionGroq rejects empty rationale", parseGeneratedQuestionGroq('{"day":10,"question":"Q","rationale":""}') === null);
  check("parseGeneratedQuestionGroq handles fenced", parseGeneratedQuestionGroq('```\n{"day":8,"question":"Describe X","rationale":"Because Y"}\n```')?.day === 8);

  console.log("\n=== Provider: classifyAnswerGroq — happy path ===");

  process.env.GROQ_API_KEY = "test-key";
  await withMockedFetch(async () => okClassify(), async () => {
    const result = await classifyAnswerGroq("Q?", "A deep, structured answer with examples.");
    check("classifyAnswerGroq returns parsed result on valid JSON", result?.depth === "deep" && result.accuracy === "high");
  });

  console.log("\n=== Provider: generateQuestionGroq — happy path ===");

  await withMockedFetch(async () => okQuestion(), async () => {
    const result = await generateQuestionGroq(sampleDays, sampleHistory, false);
    check("generateQuestionGroq returns parsed result on valid JSON", result?.day === 10 && result.question.includes("X"));
  });

  console.log("\n=== Provider: Groq returns malformed JSON ===");

  await withMockedFetch(async () => malformed(), async () => {
    const r = await classifyAnswerGroq("Q?", "A.");
    check("classifyAnswerGroq returns null on malformed JSON", r === null);
  });

  console.log("\n=== Provider: Groq returns HTTP error ===");

  await withMockedFetch(async () => httpError(429, "Too Many Requests"), async () => {
    let threw = false;
    try {
      await classifyAnswerGroq("Q?", "A.");
    } catch {
      threw = true;
    }
    check("classifyAnswerGroq throws on HTTP error (provider.ts catches it)", threw);
  });

  console.log("\n=== Provider: GROQ_API_KEY missing ===");

  delete process.env.GROQ_API_KEY;
  let threw = false;
  try {
    await classifyAnswerGroq("Q?", "A.");
  } catch {
    threw = true;
  }
  check("classifyAnswerGroq throws when GROQ_API_KEY missing (provider.ts catches it)", threw);

  console.log("\n=== Provider: provider.ts fallback chain (Groq fails → Gemini called) ===");

  const provider = await import("../lib/provider.ts");
  check("provider.ts exports generateQuestion", typeof provider.generateQuestion === "function");
  check("provider.ts exports classifyAnswer", typeof provider.classifyAnswer === "function");

  console.log("\n=== Provider: provider.ts never throws on Groq failure (fallback fires) ===");

  process.env.GROQ_API_KEY = "test-key";
  await withMockedFetch(async () => httpError(500, "Internal Server Error"), async () => {
    let result;
    try {
      result = await provider.classifyAnswer("What is RAG?", "Retrieval Augmented Generation combines retrieval with a language model.");
    } catch (e) {
      console.log(`  unexpected throw: ${e instanceof Error ? e.message : String(e)}`);
    }
    check("provider.classifyAnswer returns a result when Groq fails (falls back to Gemini)", result !== undefined);
    if (result) {
      check("fallback result has valid shape", result.depth !== undefined && typeof result.hedging === "boolean" && result.accuracy !== undefined);
    }
  });

  await withMockedFetch(async () => httpError(500, "Internal Server Error"), async () => {
    let result;
    try {
      result = await provider.generateQuestion(sampleDays, sampleHistory, false);
    } catch (e) {
      console.log(`  unexpected throw: ${e instanceof Error ? e.message : String(e)}`);
    }
    check("provider.generateQuestion returns a result when Groq fails (falls back to Gemini)", result !== undefined);
    if (result) {
      check("fallback question has valid shape", typeof result.day === "number" && typeof result.question === "string" && result.question.length > 0);
    }
  });

  console.log("\n=== Provider: provider.ts Groq success path returns Groq result ===");

  await withMockedFetch(async () => okClassify(), async () => {
    const result = await provider.classifyAnswer("Q?", "A deep, structured answer with examples.");
    check("provider returns Groq classify result when Groq succeeds", result?.depth === "deep" && result.accuracy === "high");
  });

  await withMockedFetch(async () => okQuestion(), async () => {
    const result = await provider.generateQuestion(sampleDays, sampleHistory, false);
    check("provider returns Groq question result when Groq succeeds", result?.day === 10 && result.question.includes("X"));
  });

  console.log(`\n=== Provider sanity summary: ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`} ===`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Test runner crashed:", e);
  process.exit(1);
});
