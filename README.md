# Interview Agent

AI-powered technical interview agent for the AI Cohort hackathon.

## Setup

1. Install dependencies: `npm install`
2. Create a `.env` file in the project root with your Gemini API key:

   ```
   GEMINI_API_KEY=your-key-here
   ```

   Get a free key from [Google AI Studio](https://aistudio.google.com/apikey).
3. Start the development server: `npm run dev`
4. Open http://localhost:3000

### Regenerating curriculum embeddings

Pre-generated embeddings are committed at `data/curriculum-embeddings.json`, so the runtime never needs to call the embedding API. To regenerate them (requires `GEMINI_API_KEY`):

```
npm run embed:curriculum
```

This calls the Gemini `gemini-embedding-001` API for each curriculum day's objectives and overwrites `data/curriculum-embeddings.json` with an array of `{ dayId, embedding }`.
