/**
 * Operational data: role gates, carry-forward, and the read path.
 *
 *   CHECK_CURATE_EMAIL=... CHECK_CURATE_PASSWORD=... \
 *   CHECK_READ_EMAIL=...   CHECK_READ_PASSWORD=... \
 *   npx tsx --env-file=.env.local scripts/checks/operational.ts
 *
 * Signs in as REAL users of each role rather than using the service role,
 * because the property under test is the RLS policy itself. A service-role run
 * would pass whether or not the policies exist, which is the opposite of
 * useful for a table whose whole write story is "the database enforces the
 * same rule the button does".
 *
 * Everything it writes is removed again at the end, including on failure. It
 * writes to the real tables — there is nowhere else to test a policy — so it
 * uses far-future weeks that no real report will ever cover, and it never
 * invents plausible-looking market figures that could be mistaken for
 * transcribed data.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database.types";
import { weekContainingDate } from "../../src/lib/analysis/week-period";
import {
  congestionRegions,
  formatMonth,
  isCarriedForward,
  monthOf,
  namedValues,
  readNumber,
  WAITING_TIME_PORTS,
} from "../../src/lib/analysis/operational";

/** Deliberately absurd, so a stray row is obviously test residue. */
const W1 = "2099-01-05"; // a Tuesday
const WEEK1 = weekContainingDate(W1).start; // 2099-01-04
const WEEK2 = weekContainingDate("2099-01-12").start; // 2099-01-11
const MONTH_EARLY = "2099-01-01";
const MONTH_LATE = "2099-03-01";

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
};

function client(): SupabaseClient<Database> {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

async function signIn(email: string, password: string) {
  const supabase = client();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign-in failed for ${email}: ${error.message}`);
  const { data: role } = await supabase.rpc("current_app_role");
  return { supabase, role: role as string | null };
}

async function main() {
  const curate = await signIn(
    process.env.CHECK_CURATE_EMAIL!,
    process.env.CHECK_CURATE_PASSWORD!
  );
  const reader = await signIn(
    process.env.CHECK_READ_EMAIL!,
    process.env.CHECK_READ_PASSWORD!
  );
  console.log(`curate user role: ${curate.role}   read user role: ${reader.role}\n`);
  check(curate.role === "curate", "curate fixture really has the curate role");
  check(reader.role === "read", "read fixture really has the read role");

  const {
    data: { user },
  } = await curate.supabase.auth.getUser();
  const curateId = user!.id;

  try {
    // --- Write gate ------------------------------------------------------
    console.log("\nWRITE GATE");

    const readAttempt = await reader.supabase
      .from("operational_congestion")
      .insert({ week_of: WEEK1, global_teu_waiting: 1 });
    check(
      readAttempt.error !== null,
      `read role is refused a congestion write — ${readAttempt.error?.message ?? "IT SUCCEEDED, which is a hole"}`
    );

    const readWaiting = await reader.supabase
      .from("operational_waiting_time")
      .insert({ week_of: WEEK1, port_data: {} });
    check(readWaiting.error !== null, "read role is refused a waiting-time write");

    const readReliability = await reader.supabase
      .from("operational_schedule_reliability")
      .insert({ month_of: MONTH_EARLY });
    check(readReliability.error !== null, "read role is refused a reliability write");

    const curateWrite = await curate.supabase
      .from("operational_congestion")
      .upsert(
        {
          week_of: WEEK1,
          global_teu_waiting: 111,
          global_pct_fleet: 1.1,
          region_data: { europe: 11, north_america: 22 },
          entered_by: curateId,
          entered_at: new Date().toISOString(),
        },
        { onConflict: "week_of" }
      );
    check(
      curateWrite.error === null,
      `curate role CAN write congestion${curateWrite.error ? ` — ${curateWrite.error.message}` : ""}`
    );

    // --- Upsert replaces, never duplicates -------------------------------
    await curate.supabase.from("operational_congestion").upsert(
      {
        week_of: WEEK1,
        global_teu_waiting: 222,
        region_data: { europe: 33 },
        entered_by: curateId,
        entered_at: new Date().toISOString(),
      },
      { onConflict: "week_of" }
    );
    const { data: afterUpsert } = await curate.supabase
      .from("operational_congestion")
      .select("week_of, global_teu_waiting")
      .eq("week_of", WEEK1);
    check(
      afterUpsert?.length === 1 && Number(afterUpsert[0].global_teu_waiting) === 222,
      `re-editing a week REPLACES its row (${afterUpsert?.length} row, value ${afterUpsert?.[0]?.global_teu_waiting})`
    );

    // --- Audit trail ------------------------------------------------------
    console.log("\nAUDIT");
    const auditWrite = await curate.supabase.from("audit_log").insert({
      actor_id: curateId,
      action: "operational_data.update",
      target_type: "operational_congestion",
      metadata: { dataset: "operational_congestion", period: WEEK1, global_teu_waiting: 222 },
    });
    check(
      auditWrite.error === null,
      `curate CAN write the audit row the action writes${auditWrite.error ? ` — ${auditWrite.error.message}` : ""}`
    );

    // The policy also pins actor_id to the caller, so a forged actor fails.
    const forged = await curate.supabase.from("audit_log").insert({
      actor_id: "00000000-0000-0000-0000-000000000000",
      action: "operational_data.update",
      target_type: "operational_congestion",
    });
    check(forged.error !== null, "an audit row cannot be attributed to someone else");

    // --- Absent week means absent card -----------------------------------
    console.log("\nABSENCE");
    const { data: emptyWeek } = await reader.supabase
      .from("operational_congestion")
      .select("week_of")
      .eq("week_of", WEEK2)
      .maybeSingle();
    check(
      emptyWeek === null,
      "a week with no entry reads back null, so the panel renders no card rather than an empty one"
    );

    // --- Carry-forward ----------------------------------------------------
    console.log("\nCARRY-FORWARD (monthly reliability against a weekly panel)");
    for (const month of [MONTH_EARLY, MONTH_LATE]) {
      await curate.supabase.from("operational_schedule_reliability").upsert(
        {
          month_of: month,
          glp_issue_number: month === MONTH_EARLY ? 901 : 903,
          global_reliability_pct: month === MONTH_EARLY ? 61 : 63,
          alliance_data: { "Ocean Alliance": 60 },
          entered_by: curateId,
          entered_at: new Date().toISOString(),
        },
        { onConflict: "month_of" }
      );
    }

    // The panel's own query: latest month at or before the selected week.
    const latestAtOrBefore = async (weekEnd: string) => {
      const { data } = await reader.supabase
        .from("operational_schedule_reliability")
        .select("month_of, glp_issue_number")
        .lte("month_of", `${weekEnd.slice(0, 7)}-01`)
        .order("month_of", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    };

    const jan = await latestAtOrBefore("2099-01-10");
    check(
      jan?.month_of === MONTH_EARLY,
      `a January week shows January (${jan?.month_of}, GLP ${jan?.glp_issue_number})`
    );

    const feb = await latestAtOrBefore("2099-02-14");
    check(
      feb?.month_of === MONTH_EARLY,
      `a February week CARRIES FORWARD January, since February was never entered (${feb?.month_of})`
    );

    const apr = await latestAtOrBefore("2099-04-11");
    check(
      apr?.month_of === MONTH_LATE,
      `an April week carries forward March, the newest entered (${apr?.month_of})`
    );

    const mar = await latestAtOrBefore("2099-03-07");
    check(
      mar?.month_of === MONTH_LATE,
      `a March week switches to March as soon as it exists (${mar?.month_of})`
    );

    // A week BEFORE anything was entered must not show future figures.
    const before = await latestAtOrBefore("2098-12-06");
    check(
      before === null,
      "a week earlier than every entry shows nothing, rather than figures published after it"
    );

    // The carried-forward NOTE fires only when the months differ.
    check(
      isCarriedForward(MONTH_EARLY, "2099-02-08") &&
        !isCarriedForward(MONTH_EARLY, "2099-01-04"),
      "the 'carried forward' note appears for a different month and not for the same one"
    );
    check(
      formatMonth(MONTH_EARLY) === "January 2099",
      `month label reads as prose — "${formatMonth(MONTH_EARLY)}"`
    );
    check(
      monthOf("2099-01-27") === MONTH_EARLY,
      "any day in a month maps to that month's first"
    );

    // --- Reading hand-entered jsonb --------------------------------------
    console.log("\nHAND-ENTERED VALUES");
    const { data: stored } = await reader.supabase
      .from("operational_congestion")
      .select("region_data")
      .eq("week_of", WEEK1)
      .maybeSingle();
    const regions = congestionRegions(stored?.region_data ?? null);
    check(
      regions.length === 1 && regions[0].name === "Europe" && regions[0].value === 33,
      `stored jsonb reads back with form labels (${JSON.stringify(regions)})`
    );

    check(readNumber("1.8") === 1.8, "a numeric string parses (a form posts strings)");
    check(readNumber("") === null, "a blank is absent, not zero");
    check(readNumber("n/a") === null, "unparseable text is absent, not NaN");
    check(readNumber(0) === 0, "an explicit zero survives as zero");

    const mixed = namedValues(
      { "Antwerp-Rotterdam": 1.8, "Shanghai-Ningbo": "", "Unknown Port": 4 },
      WAITING_TIME_PORTS
    );
    check(
      mixed.length === 2 &&
        mixed[0].name === "Antwerp-Rotterdam" &&
        mixed[1].name === "Unknown Port",
      `blank keys are dropped, unknown keys are kept and appended (${JSON.stringify(mixed)})`
    );
  } finally {
    // --- Cleanup, on success and on failure ------------------------------
    const admin = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    await admin.from("operational_congestion").delete().in("week_of", [WEEK1, WEEK2]);
    await admin.from("operational_waiting_time").delete().in("week_of", [WEEK1, WEEK2]);
    await admin
      .from("operational_schedule_reliability")
      .delete()
      .in("month_of", [MONTH_EARLY, MONTH_LATE]);
    await admin
      .from("audit_log")
      .delete()
      .eq("action", "operational_data.update")
      .eq("target_type", "operational_congestion")
      .contains("metadata", { period: WEEK1 });

    const { count } = await admin
      .from("operational_congestion")
      .select("week_of", { count: "exact", head: true });
    console.log(`\nCleanup: ${count ?? 0} congestion row(s) remain (expected 0 unless real data exists).`);
  }

  console.log(failures === 0 ? "\nAll operational checks passed." : `\n${failures} FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
