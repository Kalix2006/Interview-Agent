import { NextResponse, type NextRequest } from "next/server";
import { buildFeedbackReportFallback, type FeedbackReport, type Topic } from "@/lib/llm.ts";
import { generateFeedbackReportGroq } from "@/lib/groq.ts";
import { deriveCoveredDayIds, normalizeHistory } from "@/lib/interview.ts";
import { getCurriculumDay } from "@/lib/retrieval.ts";

export const dynamic = "force-dynamic";

function httpError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => null)) as { history?: unknown } | null;
    if (!body || typeof body !== "object") {
      return httpError("Request body must be a JSON object", 400);
    }
    const history = normalizeHistory(body.history);
    if (!history) {
      return httpError('"history" must be an array of { role, content } turns', 400);
    }

    const coveredDays = [...deriveCoveredDayIds(history)].sort((a, b) => a - b);
    const topics: Topic[] = [];
    for (const day of coveredDays) {
      const curriculumDay = getCurriculumDay(day);
      if (curriculumDay) topics.push({ day, title: curriculumDay.title });
    }

    if (topics.length === 0) {
      return NextResponse.json({
        topics: [],
        gaps: ["Unable to generate full feedback: the provided history does not cover any curriculum topics."],
        next: ["Run an interview first so questions are tagged with their curriculum day, then request feedback again."],
      });
    }

    let report: FeedbackReport | null = null;
    try {
      report = await generateFeedbackReportGroq(history, topics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[feedback] Groq report generation failed, using fallback: ${message}`);
    }
    return NextResponse.json(report ?? buildFeedbackReportFallback(topics));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return httpError(`Feedback request failed: ${message}`, 500);
  }
}
