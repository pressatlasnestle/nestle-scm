/**
 * Role access checks for the Analysis panel.
 *
 *   CHECK_USER_EMAIL=... CHECK_USER_PASSWORD=... npx tsx --env-file=.env.local \
 *     scripts/checks/analysis-access.ts
 *
 * The panel's rule is that a `read` user can see and export EVERYTHING, and
 * that the single exception is regenerating the narrative. Both halves need
 * proving, and the second half needs proving at the database level rather than
 * only in the server action: a UI gate that is the only gate is not a gate.
 *
 * Sign in as the role you want to test. The script reports what that role can
 * and cannot do; it asserts the expectations for `read` specifically.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database.types";
import { applyWeek, resolveWeek } from "../../src/lib/analysis/week-period";
import { parseStoredNarrative } from "../../src/lib/analysis/narrative";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const email = process.env.CHECK_USER_EMAIL!;
  const password = process.env.CHECK_USER_PASSWORD!;
  const weekArg = process.argv[2] ?? null;

  const supabase = createClient<Database>(url, anon);
  const { error: authError } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (authError) throw new Error(`Sign-in failed: ${authError.message}`);

  const { data: role } = await supabase.rpc("current_app_role");
  console.log(`Role under test: ${role}\n`);

  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  };

  const week = resolveWeek(weekArg, new Date());

  // --- Everything a read user must be able to do ---------------------------
  const { data: articles, error: articlesError } = await applyWeek(
    supabase.from("articles").select("id, ai_themes, ai_sentiment, keyword_mention_count"),
    week
  ).limit(2000);
  check(
    !articlesError && (articles?.length ?? 0) > 0,
    `can read the week's articles — ${articles?.length ?? 0} rows${
      articlesError ? ` (${articlesError.message})` : ""
    }`
  );

  const { data: report, error: reportError } = await supabase
    .from("reports")
    .select("analysis_narrative, analysis_generated_at")
    .eq("week_of", week.start)
    .maybeSingle();
  const narrative = parseStoredNarrative(report?.analysis_narrative);
  check(
    !reportError && narrative !== null,
    `can read the stored narrative — ${
      narrative ? `${narrative.themes.length} themes, ${narrative.period_summary.length} chars` : "none"
    }${reportError ? ` (${reportError.message})` : ""}`
  );

  // Exports are built client-side from rows already fetched above, so a role
  // that can read the rows can export. Confirm the export inputs are all
  // present rather than asserting on a download that has no server side.
  const exportable =
    (articles ?? []).every((a) => "ai_themes" in a && "keyword_mention_count" in a) &&
    narrative !== null;
  check(exportable, "has every field the CSV exports are built from");

  // --- The one thing it must NOT be able to do -----------------------------
  // reports has a SELECT policy for app users and no insert/update policy at
  // all, so this must be refused by RLS regardless of what the UI shows.
  const { error: writeError } = await supabase
    .from("reports")
    .upsert(
      { week_of: week.start, analysis_narrative: { tampered: true } },
      { onConflict: "week_of" }
    );
  check(
    writeError !== null,
    `is refused when writing a narrative directly — ${
      writeError ? writeError.message : "WRITE SUCCEEDED, which is a hole"
    }`
  );

  // And the narrative on disk must be untouched by that attempt.
  const { data: after } = await supabase
    .from("reports")
    .select("analysis_narrative")
    .eq("week_of", week.start)
    .maybeSingle();
  check(
    parseStoredNarrative(after?.analysis_narrative) !== null,
    "the stored narrative survived the refused write intact"
  );

  await supabase.auth.signOut();
  console.log(failures === 0 ? "\nAll access checks passed." : `\n${failures} FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
