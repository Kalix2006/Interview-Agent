import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CURRICULUM_PATH = join(ROOT, "data", "curriculum.json");
const OUTPUT_PATH = join(ROOT, "data", "curriculum-embeddings.json");
const MODEL = "gemini-embedding-001";
const MAX_RETRIES = 3;

type CurriculumDay = { day: number; title: string; objectives: string[] };

function dayToText(day: CurriculumDay): string {
  return `Day ${day.day}: ${day.title}. Objectives: ${day.objectives.join("; ")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function embedDay(ai: GoogleGenAI, day: CurriculumDay): Promise<{ dayId: number; embedding: number[] }> {
  const response = await ai.models.embedContent({ model: MODEL, contents: dayToText(day) });
  const values = response.embeddings?.[0]?.values;
  if (!values || values.length === 0) {
    throw new Error(`No embedding returned for day ${day.day}`);
  }
  return { dayId: day.day, embedding: values };
}

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is required. Set it in a .env file or the environment. See README setup steps."
    );
  }

  const raw = await readFile(CURRICULUM_PATH, "utf8");
  const curriculum = JSON.parse(raw) as { days: CurriculumDay[] };
  if (!Array.isArray(curriculum.days) || curriculum.days.length === 0) {
    throw new Error(`Invalid curriculum file: expected a non-empty "days" array in ${CURRICULUM_PATH}`);
  }

  const ai = new GoogleGenAI({ apiKey });
  const results: Array<{ dayId: number; embedding: number[] }> = [];
  const failures: string[] = [];

  for (const day of curriculum.days) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await embedDay(ai, day);
        results.push(result);
        lastError = undefined;
        console.log(`[${day.day}/${curriculum.days.length}] embedded day ${day.day}: ${day.title}`);
        break;
      } catch (error) {
        lastError = error;
        if (attempt < MAX_RETRIES) {
          const isRateLimit = /429|RESOURCE_EXHAUSTED/i.test(errorMessage(error));
          const delay = (isRateLimit ? 2000 : 1000) * attempt;
          console.log(`  retry ${attempt}/${MAX_RETRIES} for day ${day.day} in ${delay}ms`);
          await sleep(delay);
        }
      }
    }
    if (lastError !== undefined) {
      failures.push(`day ${day.day} (${day.title}): ${errorMessage(lastError)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Failed to embed ${failures.length} day(s):\n${failures.join("\n")}`);
  }

  await writeFile(OUTPUT_PATH, JSON.stringify(results, null, 2) + "\n", "utf8");
  console.log(`Wrote ${results.length} embeddings to ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
