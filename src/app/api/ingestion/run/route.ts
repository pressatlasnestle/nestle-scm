import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  runBackfill,
  runForSource,
  runManual,
  runScheduled,
  type RunType,
} from "@/lib/ingestion/run";
import { runGoogleNewsSweep } from "@/lib/ingestion/google-news";

/**
 * The single entry point for every ingestion run.
 *
 * Two callers, two ways in:
 *   * pg_cron (via pg_net) presents the shared secret in x-ingestion-secret.
 *     This is why scheduling lives in Postgres rather than Vercel Cron — the
 *     schedule is part of the database, not the hosting provider.
 *   * an admin in the browser is authorised by their own session + role.
 *
 * The pipeline itself always runs under the service-role client: cron has no
 * user session, and articles/ingestion_runs RLS is written for human callers.
 * The authorisation above is therefore the only gate, and it is checked before
 * the admin client is ever constructed.
 */

export const runtime = "nodejs";
// Vercel Hobby caps at 60s; raise this if a full backfill needs longer and the
// plan allows it. Sources are fetched in parallel batches to fit.
export const maxDuration = 60;

const RUN_TYPES: RunType[] = [
  "backfill",
  "scheduled",
  "manual",
  "source_added",
  "google_news_sweep",
];

function secretMatches(provided: string | null): boolean {
  const expected = process.env.INGESTION_CRON_SECRET;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function callerIsAdmin(): Promise<boolean> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return false;
    const { data: role } = await supabase.rpc("current_app_role");
    return role === "admin";
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const authorised =
    secretMatches(request.headers.get("x-ingestion-secret")) ||
    (await callerIsAdmin());

  if (!authorised) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: { runType?: string; sourceId?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }

  const runType = body.runType as RunType | undefined;
  if (!runType || !RUN_TYPES.includes(runType)) {
    return NextResponse.json(
      { error: `runType must be one of: ${RUN_TYPES.join(", ")}` },
      { status: 400 }
    );
  }
  if (runType === "source_added" && !body.sourceId) {
    return NextResponse.json(
      { error: "sourceId is required for runType=source_added." },
      { status: 400 }
    );
  }

  const client = createAdminClient();

  try {
    const summary =
      runType === "backfill"
        ? await runBackfill(client)
        : runType === "scheduled"
          ? await runScheduled(client)
          : runType === "manual"
            ? await runManual(client)
            : runType === "google_news_sweep"
              ? await runGoogleNewsSweep(client)
              : await runForSource(client, body.sourceId as string);

    return NextResponse.json(summary);
  } catch (err) {
    console.error("[ingestion] run failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Ingestion run failed." },
      { status: 500 }
    );
  }
}
