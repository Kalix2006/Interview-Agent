# Interview Agent

AI-powered technical interview agent for the AI Cohort hackathon.

## Setup

1. **Install dependencies:** `npm install`
2. **Create a `.env` file** in the project root with your Groq API key:

   ```
   GROQ_API_KEY=your-groq-key-here
   ```

   Get a Groq key from [Groq Cloud Console](https://console.groq.com/keys).

   **Groq** powers every LLM call: per-turn question generation, answer classification, and the feedback report. There is no other AI provider — no Gemini, no embedding API. Curriculum retrieval is a deterministic lexical scorer over the committed curriculum data, so it never calls an external service.

3. **Start the development server:** `npm run dev`
4. **Open http://localhost:3000**

## Route Map

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/candidates` | Returns all 20 candidates from `data/candidates.json` |
| `POST` | `/api/interview/turn` | Runs one interview turn. Request: `{ candidateId: string, history: HistoryEntry[] }`. Response: `{ reply: string, done: boolean, feedback?: FeedbackResult }`. Questions carry `[D:N]` tags. |
| `POST` | `/api/interview/feedback` | Generates structured feedback report. Request: `{ history: HistoryEntry[] }`. Response: `{ topics: TopicCompetency[], gaps: string[], next: string[] }`. |

**HistoryEntry:** `{ role: "interviewer" | "candidate", content: string }`

**Completion:** Interview ends when `questionsAsked >= 8` AND `daysCovered >= 4`, or forces end at `questionsAsked >= 12`.

## Vercel Deployment

1. Push this repo to GitHub.
2. Import in Vercel (or use `vercel` CLI).
3. **Critical:** In Vercel Project Settings → Environment Variables, add:
   - `GROQ_API_KEY` = your Groq key
4. Deploy. The free tier includes serverless functions (max 10s execution on Hobby).

> **Note:** `GROQ_API_KEY` must be set in Vercel project settings. Do NOT commit `.env` or any API keys to the repo.

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
      feedback/route.ts      # POST → structured feedback
  page.tsx                   # Demo UI (candidate select, chat, report)
  globals.css                # Design tokens (Swiss Modernism, navy/green)
  layout.tsx                 # Root layout with Inter font
lib/
  retrieval.ts               # Lexical retrieval & candidate profiles (no embeddings API)
  llm.ts                     # Shared types, JSON parsers, deterministic fallbacks
  groq.ts                    # Groq calls (question, classify, feedback report)
  provider.ts                # Groq-first provider with deterministic fallbacks
  interview.ts               # Pure interview logic (completion, follow-up, history)
data/
  candidates.json            # 20 candidate profiles
  curriculum.json            # 31 curriculum days
scripts/
  sanity-check-*.ts          # Unit/integration checks
```

## Sanity Checks

```bash
npm run sanity:retrieval   # Lexical retrieval logic
npm run sanity:llm         # Parsers/fallbacks (+ live Groq call when GROQ_API_KEY is set)
npm run sanity:provider    # Groq calls + provider fallback chain (mocked)
npm run sanity:interview   # Interview completion/follow-up logic
npm run sanity:feedback    # Feedback report parsing
npm run sanity:voice       # Voice state machine (idle prompts, end warning)
npm run sanity:edge-cases  # Edge case verification
```

## License

MIT