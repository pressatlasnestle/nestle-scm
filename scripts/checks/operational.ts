/**
 * Operational data: role gates, daily grain, and the stored-not-derived rules.
 *
 *   CHECK_CURATE_EMAIL=... CHECK_CURATE_PASSWORD=... \
 *   CHECK_READ_EMAIL=...   CHECK_READ_PASSWORD=... \
 *   npx tsx --env-file=.env.local scripts/checks/operational.ts
 *
 * Signs in as REAL users of each role rather than using the service role,
 * because the property under test is the RLS policy itself. A service-role run
 * would pass whether or not the policies exist, which is the opposite of
 * useful for tables whose whole write story is "the database enforces the same
 * rule the button does".
 *
 * Everything it writes uses year-2099 dates that no real report will cover, and
 * is removed again at the end — on success and on failure alike. It never
 * invents plausible market figures that could be mistaken for transcription.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/types/database.types";
import {
  dailySeries,
  fleetStatusValues,
  formatMonth,
  isCarriedForward,
  latestByDay,
  monthOf,
  namedValues,
  readNumber,
  type CongestionRow,
} from "../../src/lib/analysis/operational";

const MON = "2099-01-05";
const WED = "2099-01-07";
const FRI = "2099-01-09";
const OUTSIDE = "2099-02-16"; // a day in a different week, must be untouched
const ALL_DAYS = [MON, WED, FRI, OUTSIDE];
const MONTH_EARLY = "2099-01-01";
const MONTH_LATE = "2099-03-01";

/** Real names from the seed, chosen for their punctuation. */
const COMPOUND_PORTS = [
  "Shanghai/Ningbo",
  "Gibraltar (Algeciras/Tanger Med)",
  "LA/LB",
  "Wilmington(NC)",
];

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
};

function anon(): SupabaseClient<Database> {
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

async function signIn(email: string, password: string) {
  const supabase = anon();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign-in failed for ${email}: ${error.message}`);
  const { data: role } = await supabase.rpc("current_app_role");
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, role: role as string | null, id: user!.id };
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
  console.log(`curate role: ${curate.role}   read role: ${reader.role}\n`);
  check(curate.role === "curate", "curate fixture really has the curate role");
  check(reader.role === "read", "read fixture really has the read role");

  const stamp = () => ({ entered_by: curate.id, entered_at: new Date().toISOString() });

  try {
    // --- Vocabulary -------------------------------------------------------
    console.log("\nPORTS VOCABULARY");
    const { data: allPorts } = await reader.supabase.from("ports").select("name");
    check(allPorts?.length === 180, `180 ports seeded (${allPorts?.length})`);
    const names = new Set((allPorts ?? []).map((p) => p.name));
    for (const port of COMPOUND_PORTS) {
      check(names.has(port), `compound/typo name survives the seed verbatim: "${port}"`);
    }
    check(
      names.has("Kingston (Jamica)"),
      "the source typo 'Kingston (Jamica)' is preserved, not silently corrected"
    );

    const readerPortWrite = await reader.supabase.from("ports").insert({ name: "ZZ Test Port" });
    check(readerPortWrite.error !== null, "read role cannot add a port");

    // --- Write gate, all four tables --------------------------------------
    console.log("\nWRITE GATE");
    const refusals: [string, { error: unknown }][] = [
      ["operational_congestion", await reader.supabase.from("operational_congestion").insert({ day_of: MON })],
      ["operational_fleet_status", await reader.supabase.from("operational_fleet_status").insert({ day_of: MON })],
      ["operational_port_congestion", await reader.supabase.from("operational_port_congestion").insert({ day_of: MON, port_name: "Singapore" })],
      ["operational_schedule_reliability", await reader.supabase.from("operational_schedule_reliability").insert({ month_of: MONTH_EARLY })],
    ];
    for (const [table, res] of refusals) {
      check(res.error !== null, `read role is refused a write to ${table}`);
    }

    const curateWrite = await curate.supabase.from("operational_congestion").upsert(
      { day_of: MON, global_teu_waiting: 111, region_data: { europe: 11 }, ...stamp() },
      { onConflict: "day_of" }
    );
    check(curateWrite.error === null, `curate role CAN write${curateWrite.error ? ` — ${curateWrite.error.message}` : ""}`);

    // --- Audit attribution -------------------------------------------------
    console.log("\nAUDIT");
    const auditOk = await curate.supabase.from("audit_log").insert({
      actor_id: curate.id,
      action: "operational_data.update",
      target_type: "operational_week",
      metadata: { entries: [{ dataset: "operational_congestion", period: MON }] },
    });
    check(auditOk.error === null, "curate CAN write the audit row the action writes");

    const forged = await curate.supabase.from("audit_log").insert({
      actor_id: "00000000-0000-0000-0000-000000000000",
      action: "operational_data.update",
      target_type: "operational_week",
    });
    check(forged.error !== null, "an audit row cannot be attributed to another user");

    // --- Unknown port is refused -------------------------------------------
    console.log("\nPORT FOREIGN KEY");
    const unknownPort = await curate.supabase.from("operational_port_congestion").insert({
      day_of: MON,
      port_name: "Nowhere-on-Sea",
      ships_anchorage: 1,
      ...stamp(),
    });
    check(
      unknownPort.error?.code === "23503",
      `a port not in the vocabulary is refused by the database — ${unknownPort.error?.code ?? "IT SUCCEEDED, which is a hole"}`
    );

    // --- Daily grain, partial week -----------------------------------------
    console.log("\nDAILY GRAIN");
    // Monday, Wednesday, Friday only — Tuesday and Thursday are never written.
    for (const [day, teu] of [[MON, 100], [WED, 300], [FRI, 500]] as const) {
      await curate.supabase.from("operational_congestion").upsert(
        { day_of: day, global_teu_waiting: teu, global_pct_fleet: 1, region_data: { europe: teu / 10 }, ...stamp() },
        { onConflict: "day_of" }
      );
    }
    // A day in another week, to prove a week save leaves it alone.
    await curate.supabase.from("operational_congestion").upsert(
      { day_of: OUTSIDE, global_teu_waiting: 999, ...stamp() },
      { onConflict: "day_of" }
    );

    const weekRange = async () => {
      const { data } = await reader.supabase
        .from("operational_congestion")
        .select("day_of, global_teu_waiting, global_pct_fleet, region_data, entered_at, entered_by")
        .gte("day_of", "2099-01-05")
        .lte("day_of", "2099-01-11")
        .order("day_of");
      return (data ?? []) as CongestionRow[];
    };

    const partial = await weekRange();
    check(
      partial.length === 3,
      `a partial week reads back as the 3 days present, not 7 (${partial.length})`
    );
    check(
      partial.map((r) => r.day_of).join(",") === `${MON},${WED},${FRI}`,
      `and in day order (${partial.map((r) => r.day_of).join(",")})`
    );
    const series = dailySeries(partial, (r) => r.global_teu_waiting);
    check(
      series.length === 3 && series.every((p) => p.value > 0),
      "the chart series has 3 points and no zero-filled gaps"
    );
    check(
      !series.some((p) => p.day === "2099-01-06" || p.day === "2099-01-08"),
      "the un-entered days are absent from the series entirely"
    );
    check(
      latestByDay(partial)?.day_of === FRI,
      `latestByDay picks the newest entered day (${latestByDay(partial)?.day_of})`
    );

    // --- Re-save replaces, and does not disturb other days ------------------
    console.log("\nIDEMPOTENCE");
    await curate.supabase.from("operational_congestion").upsert(
      { day_of: MON, global_teu_waiting: 222, region_data: { europe: 22 }, ...stamp() },
      { onConflict: "day_of" }
    );
    const afterResave = await weekRange();
    check(afterResave.length === 3, `re-saving does not duplicate rows (${afterResave.length})`);
    check(
      Number(afterResave.find((r) => r.day_of === MON)?.global_teu_waiting) === 222,
      "the re-saved day is replaced with the new value"
    );
    check(
      Number(afterResave.find((r) => r.day_of === WED)?.global_teu_waiting) === 300,
      "days in the grid that were not changed keep their values"
    );
    const { data: outside } = await reader.supabase
      .from("operational_congestion")
      .select("global_teu_waiting")
      .eq("day_of", OUTSIDE)
      .maybeSingle();
    check(
      Number(outside?.global_teu_waiting) === 999,
      "a day OUTSIDE the saved week is untouched"
    );

    // --- queue_berth_ratio is stored, never derived -------------------------
    console.log("\nQUEUE / BERTH RATIO");
    // The real Shanghai/Ningbo case: 67/19 computes 3.526, published 3.50.
    await curate.supabase.from("operational_port_congestion").upsert(
      {
        day_of: MON,
        port_name: "Shanghai/Ningbo",
        ships_anchorage: 67,
        ships_port: 19,
        teu_anchorage: 500000,
        teu_port: 250000,
        queue_berth_ratio: 3.5,
        ...stamp(),
      },
      { onConflict: "day_of,port_name" }
    );
    const { data: sh } = await reader.supabase
      .from("operational_port_congestion")
      .select("ships_anchorage, ships_port, queue_berth_ratio")
      .eq("day_of", MON)
      .eq("port_name", "Shanghai/Ningbo")
      .maybeSingle();

    const computed = Number(sh!.ships_anchorage) / Number(sh!.ships_port);
    check(
      Number(sh!.queue_berth_ratio) === 3.5,
      `Shanghai/Ningbo 67/19 reads back the PUBLISHED 3.50 (${sh!.queue_berth_ratio})`
    );
    check(
      Math.abs(computed - 3.5) > 0.02,
      `and the derived value really does differ (${computed.toFixed(3)}), so this is not a tautology`
    );

    // Compound names survive a round trip through the FK.
    for (const port of COMPOUND_PORTS) {
      const { error } = await curate.supabase.from("operational_port_congestion").upsert(
        { day_of: WED, port_name: port, ships_anchorage: 1, ...stamp() },
        { onConflict: "day_of,port_name" }
      );
      check(error === null, `"${port}" round-trips through the foreign key`);
    }

    const { data: portRows } = await reader.supabase
      .from("operational_port_congestion")
      .select("port_name")
      .eq("day_of", WED);
    check(
      portRows?.length === COMPOUND_PORTS.length,
      `all ${COMPOUND_PORTS.length} compound ports stored on one day (${portRows?.length})`
    );

    // The compound key is per (day, port), so one port across several days is
    // several rows and writing one day never collides with another. By now
    // Shanghai/Ningbo has been written on Monday (the ratio case), Wednesday
    // (the compound-name loop) and Friday.
    await curate.supabase.from("operational_port_congestion").upsert(
      { day_of: FRI, port_name: "Shanghai/Ningbo", ships_anchorage: 5, ...stamp() },
      { onConflict: "day_of,port_name" }
    );
    const { data: shDays } = await reader.supabase
      .from("operational_port_congestion")
      .select("day_of")
      .eq("port_name", "Shanghai/Ningbo")
      .order("day_of");
    check(
      shDays?.map((r) => r.day_of).join(",") === `${MON},${WED},${FRI}`,
      `one port across three days is three distinct rows (${shDays?.map((r) => r.day_of).join(",")})`
    );

    // ...and re-writing one of those days replaces only that day.
    await curate.supabase.from("operational_port_congestion").upsert(
      { day_of: FRI, port_name: "Shanghai/Ningbo", ships_anchorage: 6, ...stamp() },
      { onConflict: "day_of,port_name" }
    );
    const { data: shAfter } = await reader.supabase
      .from("operational_port_congestion")
      .select("day_of, ships_anchorage, queue_berth_ratio")
      .eq("port_name", "Shanghai/Ningbo")
      .order("day_of");
    check(
      shAfter?.length === 3 && Number(shAfter[2].ships_anchorage) === 6,
      `re-writing one (day, port) replaces just it (${shAfter?.length} rows, Friday now ${shAfter?.[2]?.ships_anchorage})`
    );
    check(
      Number(shAfter?.[0].queue_berth_ratio) === 3.5,
      `and Monday's published ratio is undisturbed (${shAfter?.[0]?.queue_berth_ratio})`
    );

    // --- Fleet status: overlapping categories, never totalled ---------------
    console.log("\nFLEET STATUS");
    await curate.supabase.from("operational_fleet_status").upsert(
      {
        day_of: MON,
        status_data: {
          "Ships at port": { ships: 1165, teu: 7000000 },
          "Active Ships": { ships: 5426, teu: 31000000 },
          "Ships at anchorage": { ships: 1180, teu: 6000000 },
          "Ships in shipyard": { ships: "", teu: "" },
        },
        ...stamp(),
      },
      { onConflict: "day_of" }
    );
    const { data: fleetRow } = await reader.supabase
      .from("operational_fleet_status")
      .select("status_data")
      .eq("day_of", MON)
      .maybeSingle();
    const statuses = fleetStatusValues(fleetRow?.status_data ?? null);
    check(statuses.length === 3, `a status with blank ships and TEU is omitted (${statuses.length} of 4 kept)`);
    const atPort = statuses.find((s) => s.status === "Ships at port")!;
    const active = statuses.find((s) => s.status === "Active Ships")!;
    const anchorage = statuses.find((s) => s.status === "Ships at anchorage")!;
    check(
      atPort.ships! + anchorage.ships! < active.ships!,
      `the categories really do overlap — at port ${atPort.ships} + anchorage ${anchorage.ships} = ${atPort.ships! + anchorage.ships!} < active ${active.ships}, so they must never be stacked or totalled`
    );

    // --- Hand-entered values -----------------------------------------------
    console.log("\nHAND-ENTERED VALUES");
    check(readNumber("1.8") === 1.8, "a numeric string parses (a form posts strings)");
    check(readNumber("") === null, "a blank is absent, not zero");
    check(readNumber("  ") === null, "whitespace is absent too");
    check(readNumber("n/a") === null, "unparseable text is absent, not NaN");
    check(readNumber(0) === 0, "an explicit zero survives as zero");
    check(readNumber(null) === null, "null is absent");

    const mixed = namedValues(
      { europe: 500, north_america: "", "Unknown Region": 7, bad: "n/a" },
      ["europe", "north_america"]
    );
    check(
      mixed.length === 2 && mixed[0].name === "europe" && mixed[1].name === "Unknown Region",
      `blanks and junk dropped, unknown keys kept and appended (${JSON.stringify(mixed)})`
    );

    // --- Reliability carry-forward is untouched by this change --------------
    console.log("\nRELIABILITY (unchanged, monthly)");
    for (const month of [MONTH_EARLY, MONTH_LATE]) {
      await curate.supabase.from("operational_schedule_reliability").upsert(
        { month_of: month, glp_issue_number: month === MONTH_EARLY ? 901 : 903, global_reliability_pct: 61, ...stamp() },
        { onConflict: "month_of" }
      );
    }
    const latestAtOrBefore = async (weekEnd: string) => {
      const { data } = await reader.supabase
        .from("operational_schedule_reliability")
        .select("month_of")
        .lte("month_of", `${weekEnd.slice(0, 7)}-01`)
        .order("month_of", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data?.month_of ?? null;
    };
    check((await latestAtOrBefore("2099-02-14")) === MONTH_EARLY, "a February week still carries January forward");
    check((await latestAtOrBefore("2099-04-11")) === MONTH_LATE, "an April week carries March forward");
    check((await latestAtOrBefore("2098-12-06")) === null, "a week before every entry shows nothing");
    check(isCarriedForward(MONTH_EARLY, "2099-02-08"), "the carried-forward note fires across months");
    check(formatMonth(MONTH_EARLY) === "January 2099", `month label reads as prose — "${formatMonth(MONTH_EARLY)}"`);
    check(monthOf("2099-01-27") === MONTH_EARLY, "any day maps to its month's first");
  } finally {
    // --- Cleanup, on success and on failure --------------------------------
    const admin = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    await admin.from("operational_port_congestion").delete().in("day_of", ALL_DAYS);
    await admin.from("operational_fleet_status").delete().in("day_of", ALL_DAYS);
    await admin.from("operational_congestion").delete().in("day_of", ALL_DAYS);
    await admin.from("operational_schedule_reliability").delete().in("month_of", [MONTH_EARLY, MONTH_LATE]);
    await admin.from("audit_log").delete().eq("action", "operational_data.update");
    await admin.from("ports").delete().eq("name", "ZZ Test Port");

    const counts = await Promise.all(
      (["operational_congestion", "operational_fleet_status", "operational_port_congestion", "operational_schedule_reliability"] as const).map(
        async (t) => {
          const { count } = await admin.from(t).select("id", { count: "exact", head: true });
          return `${t}=${count ?? 0}`;
        }
      )
    );
    const { count: portCount } = await admin.from("ports").select("id", { count: "exact", head: true });
    console.log(`\nCleanup — ${counts.join("  ")}  ports=${portCount ?? 0}`);
  }

  console.log(failures === 0 ? "\nAll operational checks passed." : `\n${failures} FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
