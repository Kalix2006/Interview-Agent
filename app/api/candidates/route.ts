import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const raw = readFileSync(resolve(process.cwd(), "data", "candidates.json"), "utf8");
    const parsed = JSON.parse(raw) as { candidates: unknown[] };
    if (!Array.isArray(parsed.candidates)) {
      throw new Error('data/candidates.json must contain a "candidates" array');
    }
    return NextResponse.json({ candidates: parsed.candidates });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
