# Interview Agent

A hands-free, voice-driven technical interview agent for the AI Cohort hackathon. The agent asks curriculum-grounded questions out loud, listens to the candidate's spoken answers, and produces a per-topic competency feedback report at the end.

Everything runs on **Groq only** — no other AI provider, no Gemini, no embedding API.

## Features

- **Groq-powered interview loop** — every LLM call (question generation, answer classification, feedback report) goes through the Groq API using `llama-3.3-70b-versatile`, with deterministic fallbacks so the interview never hard-fails when the API is unreachable.
- **Hands-free voice interaction** — the agent speaks questions (Speech Synthesis) and listens for answers (Web Speech Recognition). Requires Chrome or Edge.
- **No false self-answers** — the microphone is only active during the listening phase; it is stopped while the AI is speaking, so the AI's own question is never captured as the answer.
- **Long answers are captured fully** — recognition results are accumulated across interim/final chunks, and a real-time microphone level monitor (Web Audio API) defers the idle prompt and the end-of-turn submit while the candidate is still making sound. This prevents long answers from being split across questions or interrupted by an "Are you there?" prompt when recognition goes quiet mid-answer.
- **Idle handling** — if the candidate is genuinely silent, the agent prompts once ("Are you there?"), then shows a 30-second countdown to end the interview with cancel/confirm.
- **Proctoring controls** — pause/resume and mute-the-voice buttons, live transcript with curriculum-day badges, and a state indicator (Listening / Thinking / Your turn / Ending? / Complete).
- **Per-topic feedback report** — at the end, Groq generates a report scored per covered curriculum topic (`low | medium | high` with rationale), plus gaps and recommended next steps, all grounded in what the candidate actually said.
- **Deterministic curriculum retrieval** — relevant curriculum days are selected with an idf-weighted lexical scorer over the committed curriculum (title, type, tools, objectives), boosted by candidate weakness signals (skipped/failed days, repeated attempts). No external retrieval service or embedding API.

## Setup

Requirements: Node.js 18+.

1. **Install dependencies:** `npm install`
2. **Create a `.env` file** in the project root with your Groq API key:

   ```
   GROQ_API_KEY=your-groq-key-here
   ```

   Get a Groq key from [Groq Cloud Console](https://console.groq.com/keys).

3. **Start the development server:** `npm run dev`
4. **Open http://localhost:3000** in Chrome or Edge, select a candidate, and click **Begin interview**.

Optional environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MIN_QUESTIONS` | `8` | Minimum questions asked before the interview can complete |
| `MIN_DAYS` | `4` | Minimum distinct curriculum days covered before completion |
| `MAX_QUESTIONS` | `minQuestions + 4` | Hard cap that forces the interview to end |

## How It Works

1. **First turn** — the agent builds a seed query from the candidate's profile (job role, weak/skipped days) and asks the first question, tagged with its curriculum day (e.g. `[D:22] In designing a healthcare chatbot, how would you…`).
2. **Follow-ups** — after each answer, Groq classifies it (`depth`, `hedging`, `accuracy`). Weak answers trigger up to 2 same-day follow-ups that drill one level deeper; strong answers move to the next area.
3. **Retrieval** — each question is grounded in the top-ranked curriculum days for the current context, excluding days already covered.
4. **Completion** — the interview ends when `questionsAsked >= MIN_QUESTIONS` AND `daysCovered >= MIN_DAYS`, or is force-ended at `MAX_QUESTIONS`.
5. **Feedback** — covered days are derived from the `[D:N]` tags on interviewer turns, and Groq scores each one with a rationale grounded in the transcript.

## Route Map

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/candidates` | Returns all 20 candidates from `data/candidates.json` |
| `POST` | `/api/interview/turn` | Runs one interview turn. Request: `{ candidateId: string, history: HistoryEntry[] }`. Response: `{ reply: string, done: boolean, feedback?: FeedbackResult }`. Questions carry `[D:N]` tags. |
| `POST` | `/api/interview/feedback` | Generates a structured feedback report. Request: `{ history: HistoryEntry[] }`. Response: `{ topics: TopicCompetency[], gaps: string[], next: string[] }`. |

**HistoryEntry:** `{ role: "interviewer" | "candidate", content: string }`

**TopicCompetency:** `{ day: number, title: string, score: "low" | "medium" | "high", rationale: string }`

> **Day tags are required for feedback.** The feedback endpoint derives covered topics from the `[D:N]` tags on interviewer turns. If you call the API directly, make sure the history includes them (the web UI does this automatically).

## Voice & Listening Behavior

The browser must support the Web Speech API (Chrome or Edge). The page shows a "Voice not supported" message otherwise.

- The mic is opened only when the phase is **listening** and closed the moment the AI starts speaking.
- While the candidate is producing sound (detected from the live mic level), the end-of-turn submit and the idle prompt are both deferred, so a long or slow answer is never cut off.
- After **4 seconds of quiet**, the captured answer is submitted.
- After **10 seconds of quiet**, the agent speaks "Are you there? Take your time — I am still listening."
- A second idle timeout opens a **30-second end warning**; the interview ends automatically if the candidate doesn't respond, or they can cancel to continue.

## Vercel Deployment

1. Push this repo to GitHub.
2. Import it in Vercel (or use the `vercel` CLI).
3. **Critical:** In Vercel Project Settings → Environment Variables, add `GROQ_API_KEY` with your Groq key.
4. Deploy.

> **Notes:**
> - Do NOT commit `.env` or any API keys to the repo.
> - Serverless functions run with execution time limits (the Hobby plan has a short per-request limit). A single interview turn or feedback report makes one Groq call that can take several seconds, so keep this in mind for long transcripts.

## Live Demo (example)

After deploying to Vercel, your endpoints will be available at:

```
https://your-project.vercel.app/api/candidates
https://your-project.vercel.app/api/interview/turn
https://your-project.vercel.app/api/interview/feedback
```

### cURL Examples

**Get candidates:**
```bash
curl https://your-project.vercel.app/api/candidates
# → { "candidates": [ { "member": { "id": "CAND-001", "name": "Sarah Johnson", ... }, "missions": [...] }, ... ] }
```

**Start an interview (first turn):**
```bash
curl -X POST https://your-project.vercel.app/api/interview/turn \
  -H "Content-Type: application/json" \
  -d '{"candidateId":"CAND-010","history":[]}'
# → { "reply": "[D:22] In designing a healthcare chatbot, how would you...", "done": false }
```

**Continue interview (with history):**
```bash
curl -X POST https://your-project.vercel.app/api/interview/turn \
  -H "Content-Type: application/json" \
  -d '{"candidateId":"CAND-010","history":[{"role":"interviewer","content":"[D:22] In designing a healthcare chatbot, how would you..."},{"role":"candidate","content":"I would use a classifier to route..."}]}'
# → { "reply": "[D:22] Follow-up question...", "done": false }
```

**Get feedback report (after completion):**
```bash
curl -X POST https://your-project.vercel.app/api/interview/feedback \
  -H "Content-Type: application/json" \
  -d '{"history":[{"role":"interviewer","content":"[D:22] ..."},{"role":"candidate","content":"..."}]}'
# → { "topics":[{"day":22,"title":"Multi-Agent Orchestration","score":"medium","rationale":"..."}],"gaps":["..."],"next":["..."]}
```

## Project Structure

```
app/
  api/
    candidates/route.ts      # GET → candidates list
    interview/
      turn/route.ts          # POST → one interview turn
      feedback/route.ts      # POST → structured feedback report
  page.tsx                   # Voice-driven UI (transcript, controls, report)
  globals.css                # Design tokens (Swiss Modernism, navy/green)
  layout.tsx                 # Root layout with Inter font
lib/
  retrieval.ts               # Deterministic lexical retrieval & candidate profiles
  llm.ts                     # Shared types, JSON parsers, deterministic fallbacks
  groq.ts                    # Groq calls (question, classify, feedback report)
  provider.ts                # Groq-first provider with deterministic fallbacks
  interview.ts               # Pure interview logic (completion, follow-up, history)
  voice-state-machine.ts     # Pure voice phase reducer (idle prompts, end warning)
data/
  candidates.json            # 20 candidate profiles
  curriculum.json            # 31 curriculum days
scripts/
  sanity-check-*.ts          # Unit/integration checks (see below)
```

## Sanity Checks

```bash
npm run sanity:retrieval   # Lexical retrieval logic
npm run sanity:llm         # Parsers/fallbacks (+ live Groq call when GROQ_API_KEY is set)
npm run sanity:provider    # Groq calls + provider fallback chain (mocked)
npm run sanity:interview   # Interview completion/follow-up logic
npm run sanity:feedback    # Feedback report parsing
npm run sanity:voice       # Voice state machine (idle prompts, end warning)
npm run sanity:edge        # Edge cases (empty candidates, deep answers, validation)
```

Run the full suite plus lint and build before committing:

```bash
npm run lint
npm run build
```

## License

MIT
