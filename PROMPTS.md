# PROMPTS.md — AI Usage Log

Log of AI-assisted prompts, changes, and outcomes for the **Interview Agent** project.

Session date: **2026-08-09**
Branch: `main` · Working directory: `C:\Users\Kalimuthukumar\Desktop\Interview Agent`

---

## 1. Session recap — Groq-only refactor & feedback fix

**Prompt (from previous session):** Convert the app to Groq-only (remove Gemini/embeddings) and fix the feedback endpoint to produce real per-topic competency feedback.

**What was done:**
- Deleted `lib/gemini.ts` and `scripts/embed-curriculum.ts`; created `lib/llm.ts` with shared types, parsers, and deterministic fallbacks.
- Added `generateFeedbackGroq` / `generateFeedbackReportGroq` to `lib/groq.ts`.
- Made `lib/provider.ts` Groq-first with deterministic fallbacks; replaced live Gemini embeddings in `lib/retrieval.ts` with an idf-weighted lexical scorer.
- Fixed `app/page.tsx` so `[D:N]` day tags are preserved when history is sent to the turn and feedback APIs — this was the root cause of the stale "does not cover any curriculum topics" feedback.
- Removed `@google/genai` and `GEMINI_API_KEY`; updated sanity scripts and README.

**Files changed:** `lib/llm.ts`, `lib/groq.ts`, `lib/provider.ts`, `lib/retrieval.ts`, `lib/interview.ts`, `app/page.tsx`, `app/api/interview/turn/route.ts`, `app/api/interview/feedback/route.ts`, `scripts/*`, `package.json`, `README.md`, `.env`.

**Outcome:** Feedback reports now reflect the candidate's actual answers (verified live: D8 high, D10 medium, D22 low with rationale).

---

## 2. Mic was listening while the AI was asking a question

**Prompt:** "the mic was listening when ai asking question. so the sound become interrupted and it take the question as the answer and moving to the next question. fix this issue. while asking question, should not listen for the answer"

**What was done:**
- Recognition (continuous) was never stopped between turns, so it captured the AI's own speech.
- Added `stopListening()` + `clearTimers()` at the start of the `speak` decision and in `request_turn`.
- Made `speakText.onerror` ignore `canceled`/`interrupted` errors so cancelled speech can't spuriously re-open the mic.

**Files changed:** `app/page.tsx`

**Outcome:** Mic is off while the AI speaks and during processing; it re-opens only after the AI finishes speaking.

---

## 3. Long answers split / feedback not working in production

**Prompt:** "in production, it doesnt pickup the log answers. if its a long answer, it split the answer and take it as a answer for next question. fix this. and the feedback generation not working in production"

**What was done:**
- **Long answers:** `onresult` only kept the last final chunk (replaced instead of accumulated) and ignored interim results, so continuous speech never reset timers and the 2.5s silence timer split answers. Now finals accumulate across events, the trailing interim is included, both the idle and silence timers reset on every result, and `END_OF_TURN_SILENCE_MS` was raised 2500 → 4000ms.
- **Feedback in production:** `max_tokens` was 1024 (truncating the full report JSON) → now 2048; Groq timeout 15s → 30s; the feedback route now degrades to a deterministic fallback report on any Groq failure instead of returning 500; the report parser merges valid per-topic scores and fills in missing topics instead of rejecting the whole report.

**Files changed:** `app/page.tsx`, `lib/voice-state-machine.ts`, `lib/groq.ts`, `app/api/interview/feedback/route.ts`

**Outcome:** Long answers are captured as one answer; feedback generation works on the production server (verified via `next start`).

---

## 4. Vercel — long answer triggers "are you there" and skips to next question

**Prompt:** "while running the application in vercel, while answering long answer, it prompts 'are you there' and stops listening and move to the next question"

**What was done:**
- Root cause: on HTTPS, Chrome's speech recognition can go quiet mid-answer (no `onresult` events), so the 10s idle prompt fired and the answer was cut.
- Added a real-time microphone level monitor (Web Audio API `AnalyserNode`, 200ms polling) that runs only during the listening phase.
- While the candidate is making sound (`isEffectivelyTalking()`), both the idle "Are you there?" timer and the end-of-turn submit timer re-arm instead of firing.
- Added a 30s safety cap so continuous background noise cannot stall the interview forever; audio monitor is stopped whenever the mic should be off.

**Files changed:** `app/page.tsx`

**Outcome:** Long answers are no longer interrupted or submitted early, even when speech recognition stops emitting results mid-answer.

---

## 5. Update README per current features and changes

**Prompt:** "update the readme file according to the current features and changes"

**What was done:**
- Refreshed `README.md` with a Features section (Groq-only, hands-free voice, no false self-answers, long-answer capture, idle handling, proctoring controls, per-topic feedback, deterministic retrieval).
- Added "How It Works", "Voice & Listening Behavior", optional env vars, updated route map, project structure (`lib/voice-state-machine.ts`), and corrected sanity-check script names (`sanity:edge`).

**Files changed:** `README.md`

---

## 6. Create AI usage log (this file)

**Prompt:** "create AI-usage logs as a PROMPTS.md in this conversation and store it in root folder"

**What was done:** Created this log.

---

## 7. Mid-interview 500 on Vercel (`/api/interview/turn`)

**Prompt:** "Failed to load resource: the server responded with a status of 500 ()" — during a live interview on Vercel.

**Root cause:** Groq returned HTTP 429 (daily token limit nearly exhausted — 99,371/100,000 tokens used in one day) on mid-interview turns. The turn route had no provider-level fallback for `generateFeedbackGroq` at the completion turn, and an empty retrieval result could reach `generateQuestion` unguarded — either path threw and surfaced as a 500.

**What was done:**
- `lib/groq.ts`: `callGroqJson` now accepts a per-call timeout; classify uses 6s, question generation 12s (fail fast instead of burning the whole function budget), feedback stays at 30s.
- `lib/llm.ts`: `buildFallbackQuestion` now guards against an empty/invalid days array with a general engineering question.
- `app/api/interview/turn/route.ts`: the route is now **fail-closed** — any app-level error inside the interview turn degrades to a deterministic grounded question (or a completed turn with fallback feedback) and returns HTTP 200, never 500. Retrieval returning zero days falls back to the first uncovered curriculum day; the completion-path feedback falls back via the same safety net.

**Files changed:** `lib/groq.ts`, `lib/llm.ts`, `app/api/interview/turn/route.ts`

**Outcome:** Verified end-to-end against the production build (`next start`) while Groq was actively rate-limiting: a mid-interview turn returns 200 with a grounded `[D:…]` question, and a completion turn returns 200 with `done: true` + fallback feedback. All 7 sanity suites pass; lint and build clean.

---

## Session summary

| Area | Change |
|------|--------|
| AI provider | Groq-only (`llama-3.3-70b-versatile`); Gemini/embeddings fully removed |
| Retrieval | Deterministic idf-weighted lexical scorer over curriculum data |
| Voice UX | Mic active only during listening; long answers captured without splitting |
| Idle handling | Real-time mic-level monitoring defers idle/silence timers while talking |
| Feedback | Per-topic competency report grounded in the transcript; graceful fallbacks |
| Turn resilience | `/api/interview/turn` fail-closed: provider failures degrade to grounded questions, never 500; per-call Groq timeouts |
| Verification | `npm run lint`, `npm run build`, and all sanity suites pass; endpoints verified against `next start` |
