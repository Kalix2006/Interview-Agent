import {
  createInitialVoiceContext,
  detectBrowserSupport,
  END_WARNING_TIMEOUT_MS,
  IDLE_PROMPT_MS,
  IDLE_PROMPTS_BEFORE_END_WARNING,
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

console.log("\n=== Voice state machine: idle prompts (1 prompt then end warning) ===");

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
check("second IDLE_TIMEOUT transitions to ending", result.context.phase === "ending");
check("second IDLE_TIMEOUT emits prompt_end", hasKind(result.decisions, "prompt_end"));
check("second IDLE_TIMEOUT resets counter", result.context.consecutiveIdlePrompts === 0);

const afterEndingIdle = reduce(result.context, { type: "IDLE_TIMEOUT" });
check("IDLE_TIMEOUT in ending is a no-op", afterEndingIdle.context.phase === "ending");
check("IDLE_TIMEOUT in ending emits noop", hasDecision(afterEndingIdle.decisions, "noop"));

console.log("\n=== Voice state machine: idle constants ===");

check("IDLE_PROMPT_MS is 10000", IDLE_PROMPT_MS === 10000);
check("IDLE_PROMPTS_BEFORE_END_WARNING is 1", IDLE_PROMPTS_BEFORE_END_WARNING === 1);
check("END_WARNING_TIMEOUT_MS is 30000", END_WARNING_TIMEOUT_MS === 30000);

console.log("\n=== Voice state machine: cancel end warning resumes interview ===");

r = reduce(createInitialVoiceContext(), { type: "START_INTERVIEW" });
r = reduce(r.context, { type: "AI_SPEECH_ENDED" });
r = reduce(r.context, { type: "IDLE_TIMEOUT" });
r = reduce(r.context, { type: "IDLE_TIMEOUT" });
check("cancel requires ending phase", r.context.phase === "ending");
r = reduce(r.context, { type: "CANCEL_END" });
check("CANCEL_END returns to listening", r.context.phase === "listening");
check("CANCEL_END emits start_listening", hasDecision(r.decisions, "start_listening"));
check("CANCEL_END resets idle counter", r.context.consecutiveIdlePrompts === 0);

r = reduce(r.context, { type: "CANCEL_END" });
check("CANCEL_END outside ending is a no-op", r.context.phase === "listening");
check("CANCEL_END outside ending emits noop", hasDecision(r.decisions, "noop"));

console.log("\n=== Voice state machine: confirm end warning completes interview ===");

r = reduce(createInitialVoiceContext(), { type: "START_INTERVIEW" });
r = reduce(r.context, { type: "AI_SPEECH_ENDED" });
r = reduce(r.context, { type: "IDLE_TIMEOUT" });
r = reduce(r.context, { type: "IDLE_TIMEOUT" });
check("confirm requires ending phase", r.context.phase === "ending");
r = reduce(r.context, { type: "END_INTERVIEW" });
check("END_INTERVIEW transitions to complete", r.context.phase === "complete");
check("END_INTERVIEW requests feedback", hasDecision(r.decisions, "request_feedback"));

r = reduce(r.context, { type: "END_INTERVIEW" });
check("END_INTERVIEW outside ending is a no-op", r.context.phase === "complete");
check("END_INTERVIEW outside ending emits noop", hasDecision(r.decisions, "noop"));

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
