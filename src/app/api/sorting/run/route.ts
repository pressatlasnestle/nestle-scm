import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  countPendingArticles,
  sortPendingArticles,
  SORT_BUDGET_MS,
} from "@/lib/analysis/sorting";

/**
 * Stage 1 sorting, on its own trigger.
 *
 * WHY THIS ROUTE EXISTS. Sorting used to run at the tail of the ingestion run,
 * handed to next/server's after(). after() defers past the response but not
 * past maxDuration, so the sort inherited whatever seconds the fetch had not
 * spent — and as the source list grew, that was none. The evidence was
 * unambiguous: the scheduled run of 14 August 12:00 completed successfully in
 * 57 of its 60 seconds, captured 31 articles, and sorted zero of them. Runs on
 * 13 and 14 August were killed outright and sorted zero as well. Five days of
 * ingestion produced 125 articles that no sorting pass ever reached.
 *
 * Coupling them was what made that possible. A fetch and a sort in one
 * invocation share one budget, so the slower one silently takes the other's
 * time, and the symptom surfaces days later as unsorted articles rather than
 * immediately as a failed run. Raising FETCH_CONCURRENCY treated the symptom
 * and the ceiling came back, which is what a tuning fix does to a structural
 * problem.
 *
 * So this route does not know or care what any run inserted. It asks the only
 * question that cannot go stale — what is still pending? — and works through
 * it. A missed pass costs one hour, not one batch of articles forever, because
 * the next pass is defined by the outstanding work rather than by the run that
 * created it.
 *
 * Authorisation is the ingestion route's, deliberately unchanged: the same
 * shared secret for pg_cron, the same admin-session fallback for a human. One
 * secret to configure, not two.
 */

export const runtime = "nodejs";
// One Gemini call per article at concurrency 4. The pass stops itself at
// SORT_BUDGET_MS and leaves the remainder pending, so this ceiling bounds how
// much one invocation does — never whether the backlog is finished.
export const maxDuration = 60;

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

  const client = createAdminClient();

  try {
    const pendingBefore = await countPendingArticles(client);
    if (pendingBefore === 0) {
      return NextResponse.json({
        pendingBefore: 0,
        processed: 0,
        flagged: 0,
        confirmed: 0,
        failed: 0,
        remaining: 0,
      });
    }

    const summary = await sortPendingArticles(client, {
      budgetMs: SORT_BUDGET_MS,
    });

    const remaining = await countPendingArticles(client);
    console.log(
      `[sorting] ${summary.processed} sorted (${summary.flagged} flagged, ${summary.confirmed} confirmed), ${summary.failed} failed, ${remaining} still pending`
    );
    for (const e of summary.errors) {
      console.error(`[sorting] ${e.articleId}: ${e.error}`);
    }

    return NextResponse.json({ pendingBefore, ...summary, remaining });
  } catch (err) {
    console.error("[sorting] pass failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sorting pass failed." },
      { status: 500 }
    );
  }
}
