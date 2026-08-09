import {
  createInitialVoiceContext,
  detectBrowserSupport,
  MAX_CONSECUTIVE_IDLE_PROMPTS,
  reduce,
  type VoiceContext,
  type VoiceEvent,
} from "../lib/voice-state-machine.ts";

let failures = 0;

function check(label: string, condition: boolean): void {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
}

function kinds(context: VoiceContext, events: VoiceEvent[]): { context: VoiceContext; decisions: string[] } {
  let ctx = context;
  const decisions: string[] = [];
  for (const event of events) {
    const result = reduce(ctx, event);
    ctx = result.context;
    for (const d of result.decisions) decisions.push(d.kind);
  }
  return { context: ctx, decisions };
}

function hasKind(decisionKinds: string[], kind: string): boolean {
  return decisionKinds.includes(kind);
}

function run(events: VoiceEvent[]): { context: VoiceContext; decisions: string[] } {
  return kinds(createInitialVoiceContext(), events);
}

function hasDecision(decisions: { kind: string }[], kind: string): boolean {
  return decisions.some((d) => d.kind === kind);
}

console.log("\n=== Voice state machine: initial state ===");

const initial = createInitialVoiceContext();
check("initial phase is setup", initial.phase === "setup");
check("initial transcript is empty", initial.partialTranscript === "");
check("initial consecutiveIdlePrompts is 0", initial.consecutiveIdlePrompts === 0);
check("initial questionsAsked is 0", initial.questionsAsked === 0);

console.log("\n=== Voice state machine: start interview ===");

let r = reduce(createInitialVoiceContext(), { type: "START_INTERVIEW" });
check("START_INTERVIEW transitions to connecting", r.context.phase === "connecting");
check("START_INTERVIEW resets counters", r.context.questionsAsked === 0 && r.context.consecutiveIdlePrompts === 0);
check("START_INTERVIEW requests the first turn", hasDecision(r.decisions, "request_turn"));

console.log("\n=== Voice state machine: happy path (speech -> submit -> next question) ===");

r = reduce(createInitialVoiceContext(), { type: "START_INTERVIEW" });
r = reduce(r.context, { type: "SPEECH_DETECTED", transcript: "I would use a vector database" });
check("SPEECH_DETECTED stores the transcript", r.context.partialTranscript === "I would use a vector database");
check("SPEECH_DETECTED keeps the current phase", r.context.phase === "connecting");
check("SPEECH_DETECTED resets idle counter", r.context.consecutiveIdlePrompts === 0);

r = reduce(r.context, { type: "SUBMIT_ANSWER", transcript: "I would use a vector database" });
check("SUBMIT_ANSWER transitions to processing", r.context.phase === "processing");
check("SUBMIT_ANSWER requests a turn with the transcript", hasDecision(r.decisions, "request_turn"));

r = reduce(r.context, { type: "TURN_RESPONSE", hasNext: true, question: "What about retrieval?" });
check("TURN_RESPONSE with next question transitions to speaking", r.context.phase === "speaking");
check("TURN_RESPONSE emits speak decision", hasDecision(r.decisions, "speak"));
check("TURN_RESPONSE increments questionsAsked", r.context.questionsAsked === 1);
check("TURN_RESPONSE clears the partial transcript", r.context.partialTranscript === "");

r = reduce(r.context, { type: "AI_SPEECH_ENDED" });
check("AI_SPEECH_ENDED transitions to listening", r.context.phase === "listening");
check("AI_SPEECH_ENDED emits start_listening", hasDecision(r.decisions, "start_listening"));
check("AI_SPEECH_ENDED resets idle counter", r.context.consecutiveIdlePrompts === 0);

console.log("\n=== Voice state machine: idle prompts (2 then submit empty) ===");

const idleRun = (n: number): { context: VoiceContext; decisions: string[] } =>
  run([
    { type: "START_INTERVIEW" },
    { type: "AI_SPEECH_ENDED" },
    ...Array.from({ length: n }, () => ({ type: "IDLE_TIMEOUT" }) as VoiceEvent),
  ]);

let result = idleRun(1);
check("first IDLE_TIMEOUT prompts to speak", hasKind(result.decisions, "prompt_idle"));
check("first IDLE_TIMEOUT increments counter", result.context.consecutiveIdlePrompts === 1);
check("first IDLE_TIMEOUT stays in listening", result.context.phase === "listening");

result = idleRun(2);
check("second IDLE_TIMEOUT still prompts", hasKind(result.decisions, "prompt_idle"));
check("second IDLE_TIMEOUT counter is 2", result.context.consecutiveIdlePrompts === 2);
check("second IDLE_TIMEOUT stays in listening", result.context.phase === "listening");

result = idleRun(3);
check("third IDLE_TIMEOUT submits an empty turn", hasKind(result.decisions, "request_turn"));
check("third IDLE_TIMEOUT transitions to processing", result.context.phase === "processing");

console.log("\n=== Voice state machine: idle exhaustion respects MAX constant ===");

check("MAX_CONSECUTIVE_IDLE_PROMPTS is 2", MAX_CONSECUTIVE_IDLE_PROMPTS === 2);
let ctx = createInitialVoiceContext();
ctx = reduce(ctx, { type: "START_INTERVIEW" }).context;
ctx = reduce(ctx, { type: "AI_SPEECH_ENDED" }).context;
ctx = reduce(ctx, { type: "IDLE_TIMEOUT" }).context;
ctx = reduce(ctx, { type: "IDLE_TIMEOUT" }).context;
const exhausted = reduce(ctx, { type: "IDLE_TIMEOUT" });
check("exhaustion submits instead of prompting", hasDecision(exhausted.decisions, "request_turn"));
check("exhaustion transitions to processing", exhausted.context.phase === "processing");

console.log("\n=== Voice state machine: completion ===");

r = reduce(createInitialVoiceContext(), { type: "START_INTERVIEW" });
r = reduce(r.context, { type: "SUBMIT_ANSWER", transcript: "last answer" });
r = reduce(r.context, { type: "TURN_RESPONSE", hasNext: false, question: "" });
check("TURN_RESPONSE without next question transitions to complete", r.context.phase === "complete");
check("TURN_RESPONSE without next question requests feedback", hasDecision(r.decisions, "request_feedback"));

console.log("\n=== Voice state machine: error handling ===");

r = reduce(createInitialVoiceContext(), { type: "FAILED", error: "network down" });
check("FAILED transitions to error phase", r.context.phase === "error");
check("FAILED stores the error message", r.context.error === "network down");
check("FAILED emits set_error", hasDecision(r.decisions, "set_error"));

console.log("\n=== Voice state machine: reset ===");

r = reduce(createInitialVoiceContext(), { type: "START_INTERVIEW" });
r = reduce(r.context, { type: "SPEECH_DETECTED", transcript: "abc" });
r = reduce(r.context, { type: "TURN_RESPONSE", hasNext: true, question: "q?" });
r = reduce(r.context, { type: "RESET" });
check("RESET returns to setup", r.context.phase === "setup");
check("RESET clears transcript", r.context.partialTranscript === "");
check("RESET clears counters", r.context.questionsAsked === 0 && r.context.consecutiveIdlePrompts === 0);
check("RESET emits reset decision", hasDecision(r.decisions, "reset"));

console.log("\n=== Voice state machine: failed state can be restarted ===");

r = reduce(createInitialVoiceContext(), { type: "FAILED", error: "mic denied" });
r = reduce(r.context, { type: "START_INTERVIEW" });
check("START_INTERVIEW after FAILED starts a fresh connecting session", r.context.phase === "connecting");
check("START_INTERVIEW after FAILED clears the error", r.context.error === undefined);

console.log("\n=== Voice state machine: detectBrowserSupport (server context) ===");

const support = detectBrowserSupport();
check("detectBrowserSupport returns an object", typeof support === "object" && support !== null);
check("detectBrowserSupport reports not ok outside a browser", support.ok === false);

console.log(`\n=== Voice state machine summary: ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`} ===`);
if (failures > 0) process.exit(1);
