/**
 * The operational CSV upload: template round trip, validation, and the write.
 *
 *   CHECK_CURATE_EMAIL=... CHECK_CURATE_PASSWORD=... \
 *   CHECK_READ_EMAIL=...   CHECK_READ_PASSWORD=... \
 *   npx tsx --env-file=.env.local scripts/checks/operational-upload.ts
 *
 * Signs in as REAL users of each role. The upload writes through a
 * SECURITY INVOKER function, so "a read user cannot upload" is a claim about
 * the RLS policy and a service-role run would pass whether or not the policy
 * exists.
 *
 * The parsing half runs with no database at all — it is pure — and the writing
 * half uses year-2099 dates that no real report will cover, removed again at
 * the end on success and on failure alike. No figure written here is a
 * plausible market number: they are 111, 222, 999 and the like, so nothing can
 * be mistaken for transcription if cleanup ever fails.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "../../src/types/database.types";
import { parseCsv } from "../../src/lib/analysis/csv";
import {
  buildTemplateCsv,
  buildUploadPayload,
  groupProblems,
  parseUpload,
  planChanges,
  suggestPort,
  TEMPLATE_HEADERS,
  templateRows,
  type ExistingData,
} from "../../src/lib/analysis/operational-template";
import {
  carriedPorts,
  readNumber,
  readObject,
  type CongestionRow,
  type FleetStatusRow,
  type PortCongestionRow,
} from "../../src/lib/analysis/operational";

const DAYS = [
  "2099-01-05",
  "2099-01-06",
  "2099-01-07",
  "2099-01-08",
  "2099-01-09",
  "2099-01-10",
  "2099-01-11",
];
const MON = DAYS[0];
const TUE = DAYS[1];
const OUTSIDE = "2099-02-16";
const ALL_DAYS = [...DAYS, OUTSIDE];

/** Real names from the seed, chosen for their punctuation. */
const PORTS = [
  "Shanghai/Ningbo",
  "Gibraltar (Algeciras/Tanger Med)",
  "LA/LB",
  "Wilmington(NC)",
  "Kingston (Jamica)",
];

const EMPTY: ExistingData = { congestion: [], fleet: [], ports: [] };

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
  return { supabase, role: role as string | null };
}

/** Replaces the Value column for rows matching a predicate. Simulates typing. */
function fill(
  csv: string,
  edit: (cells: string[]) => string | null
): string {
  const rows = parseCsv(csv);
  const out = [rows[0]];
  for (const cells of rows.slice(1)) {
    const next = edit(cells);
    out.push(next === null ? cells : [...cells.slice(0, 4), next]);
  }
  return `${out
    .map((r) => r.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(","))
    .join("\r\n")}\r\n`;
}

const opts = { days: DAYS, ports: PORTS, portVocabulary: PORTS };

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

  // Applies a file exactly as the server action does: re-parse, then one RPC.
  const upload = async (
    who: { supabase: SupabaseClient<Database> },
    csv: string
  ) => {
    const plan = parseUpload(parseCsv(csv), opts);
    if (plan.structuralError || plan.problems.length > 0) {
      return { plan, error: null as { code?: string; message: string } | null, sent: false };
    }
    const payload = buildUploadPayload(plan.values);
    const { error } = await who.supabase.rpc("apply_operational_upload", {
      p_payload: payload as unknown as Json,
    });
    return { plan, error, sent: true };
  };

  const readBack = async () => {
    const [c, f, p] = await Promise.all([
      reader.supabase
        .from("operational_congestion")
        .select("day_of, global_teu_waiting, global_pct_fleet, region_data, entered_at, entered_by")
        .in("day_of", ALL_DAYS)
        .order("day_of"),
      reader.supabase
        .from("operational_fleet_status")
        .select("day_of, status_data, entered_at, entered_by")
        .in("day_of", ALL_DAYS)
        .order("day_of"),
      reader.supabase
        .from("operational_port_congestion")
        .select("day_of, port_name, ships_anchorage, ships_port, teu_anchorage, teu_port, queue_berth_ratio, entered_at, entered_by")
        .in("day_of", ALL_DAYS)
        // Ordered by port too: within a day PostgREST returns rows in whatever
        // order the planner produces, and the comparisons below are on the
        // serialised list.
        .order("day_of")
        .order("port_name"),
    ]);
    return {
      congestion: (c.data ?? []) as CongestionRow[],
      fleet: (f.data ?? []) as FleetStatusRow[],
      ports: (p.data ?? []) as PortCongestionRow[],
    } satisfies ExistingData;
  };

  try {
    // =====================================================================
    // The template, with no database involved
    // =====================================================================
    console.log("\nTEMPLATE SHAPE");
    const blank = buildTemplateCsv(DAYS, PORTS, EMPTY);
    const blankRows = parseCsv(blank);

    check(
      blankRows[0].join(",") === TEMPLATE_HEADERS.join(","),
      `header row reads ${blankRows[0].join(", ")}`
    );
    check(
      blankRows.length - 1 === templateRows(DAYS, PORTS).length,
      `every template row is written (${blankRows.length - 1})`
    );
    check(
      blankRows.length - 1 === 7 * (2 + 5 + 10 + 25),
      `7 days x (2 global + 5 regions + 10 fleet + 25 port) = ${blankRows.length - 1} rows`
    );
    check(
      blankRows.slice(1).every((r) => r[4] === ""),
      "with no data stored, EVERY value cell is blank — never a pre-filled zero"
    );
    check(
      blankRows.slice(1).every((r) => DAYS.includes(r[0])),
      "the user never types a date: every row carries one from the template"
    );
    check(
      blankRows
        .slice(1)
        .filter((r) => r[1] === "Port congestion")
        .every((r) => PORTS.includes(r[2])),
      "and never types a port name either"
    );
    check(blank.includes("\r\n"), "written with CRLF, for Excel on Windows");

    // =====================================================================
    // 8 — a file that has been through Excel on Windows
    // =====================================================================
    console.log("\nBOM AND CRLF");
    const bommed = `﻿${blank}`;
    const bomRows = parseCsv(bommed);
    check(
      bomRows[0][0] === "Date",
      `a UTF-8 BOM does not become part of the first header cell (${JSON.stringify(bomRows[0][0])})`
    );
    check(
      parseUpload(bomRows, opts).structuralError === null,
      "so a BOM'd file is not rejected as 'not the template'"
    );
    check(
      parseCsv(blank.replace(/\r\n/g, "\n")).length === bomRows.length,
      "LF-only line endings parse to the same rows as CRLF"
    );
    check(
      parseCsv(`${blank}\r\n\r\n`).length === bomRows.length,
      "Excel's trailing blank lines do not become rows of failures"
    );
    check(
      parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n')[1].join("|") === 'x, y|he said "hi"',
      "quoted commas and doubled quotes survive"
    );

    // =====================================================================
    // Structural mistakes stop once, rather than 300 times
    // =====================================================================
    console.log("\nSTRUCTURAL ERRORS");
    const wrongHeader = blank.replace("Date,Section,Item,Measure,Value", "Day,Section,Item,Metric,Value");
    const wrongPlan = parseUpload(parseCsv(wrongHeader), opts);
    check(
      wrongPlan.structuralError !== null && wrongPlan.problems.length === 0,
      "a renamed header column is ONE message, not one per row"
    );
    check(
      /Date, Section, Item, Measure, Value/.test(wrongPlan.structuralError ?? ""),
      `and it says what the row should read — "${(wrongPlan.structuralError ?? "").slice(0, 90)}…"`
    );
    check(
      parseUpload([], opts).structuralError !== null,
      "an empty file is a structural error, not a silent success"
    );

    // =====================================================================
    // 3 — an unrecognised port is rejected BY NAME
    // =====================================================================
    console.log("\nUNRECOGNISED PORT");
    const typo = blank.replace(/Shanghai\/Ningbo/g, "Shanghai Ningbo");
    const typoPlan = parseUpload(parseCsv(fill(typo, (c) => (c[1] === "Port congestion" ? "5" : null))), opts);
    check(typoPlan.problems.length > 0, "a misspelled port is a problem, not a silently skipped row");
    const msg = typoPlan.problems[0].message;
    check(/Shanghai Ningbo/.test(msg), `the message names the port as written — "${msg}"`);
    check(/did you mean/i.test(msg) && /Shanghai\/Ningbo/.test(msg), "and suggests the real name");
    check(
      !/parse|invalid|token|line \d+ col/i.test(msg),
      "and reads as English, not as a parser diagnostic"
    );

    // One rename in the spreadsheet hits 5 measures x 7 days. Reported once,
    // against the rows it applies to, or it buries everything else wrong.
    const typoGroups = groupProblems(typoPlan.problems);
    check(
      typoPlan.problems.length === 35 && typoGroups.length === 1,
      `35 affected rows collapse to ${typoGroups.length} message`
    );
    check(
      /^Rows \d+–\d+, \d+–\d+/.test(typoGroups[0].label),
      `and it names the rows the user can see in Excel — "${typoGroups[0].label}"`
    );
    check(
      groupProblems([{ line: 9, message: "x" }])[0].label === "Row 9",
      "a lone problem says Row, singular"
    );
    check(
      groupProblems([
        { line: 4, message: "x" },
        { line: 5, message: "x" },
        { line: 9, message: "x" },
      ])[0].label === "Rows 4–5, 9",
      "consecutive rows collapse to a range, gaps stay separate"
    );
    check(
      suggestPort("Shanghai Ningbo", PORTS) === "Shanghai/Ningbo" &&
        suggestPort("Wilmington NC", PORTS) === "Wilmington(NC)",
      "punctuation-only differences are matched"
    );
    check(
      suggestPort("Reykjavik", PORTS) === null,
      "a genuinely unrelated name gets no misleading suggestion"
    );

    console.log("\nNON-NUMERIC VALUES");
    const junk = parseUpload(
      parseCsv(fill(blank, (c) => (c[0] === MON && c[1] === "Fleet status" ? "n/a" : null))),
      opts
    );
    check(junk.problems.length === 10, `each unparseable cell is reported (${junk.problems.length})`);
    check(
      /is not a number/.test(junk.problems[0].message) &&
        /empty/.test(junk.problems[0].message),
      `and says what to do instead — "${junk.problems[0].message}"`
    );
    check(
      parseUpload(parseCsv(fill(blank, (c) => (c[0] === MON && c[1] === "Fleet status" ? "1,234" : null))), opts)
        .values.every((v) => v.value === 1234),
      "a thousands separator typed by Excel is read as a number, not rejected"
    );

    // =====================================================================
    // Blank is not zero
    // =====================================================================
    console.log("\nBLANK IS NOT ZERO");
    const untouched = parseUpload(parseCsv(blank), opts);
    check(untouched.values.length === 0, "an untouched template carries no values");
    check(untouched.problems.length === 0, "and no problems — a blank cell is not an error");
    check(
      untouched.blank === blankRows.length - 1,
      `every blank cell is counted so the panel can say so (${untouched.blank})`
    );
    const zeroed = parseUpload(parseCsv(fill(blank, (c) => (c[0] === MON && c[1] === "Fleet status" ? "0" : null))), opts);
    check(
      zeroed.values.length === 10 && zeroed.values.every((v) => v.value === 0),
      "a typed 0 IS a value, and stays distinct from a blank"
    );

    // =====================================================================
    // The write
    // =====================================================================
    console.log("\nWRITE — FIRST UPLOAD");
    // Monday only, and deliberately partial: some measures left blank.
    const first = fill(blank, (cells) => {
      if (cells[0] !== MON) return null;
      if (cells[1] === "Port congestion total") return cells[3] === "TEU at anchorage" ? "111" : "1.5";
      if (cells[1] === "Port congestion by region") return "11";
      if (cells[1] === "Fleet status") return cells[3] === "Ships" ? "22" : "222";
      if (cells[1] === "Port congestion") {
        if (cells[2] === "Shanghai/Ningbo") {
          // 67/19 computes 3.526; Linerlytica publishes 3.50.
          if (cells[3] === "Ships at anchorage") return "67";
          if (cells[3] === "Ships at port") return "19";
          if (cells[3] === "Queue to berth ratio") return "3.5";
        }
        return "999";
      }
      return null;
    });

    const r1 = await upload(curate, first);
    check(
      r1.error === null,
      `curate CAN apply an upload${r1.error ? ` — ${r1.error.message}` : ""}`
    );

    const after1 = await readBack();
    check(after1.congestion.length === 1, `one day written, not seven (${after1.congestion.length})`);
    check(after1.congestion[0].day_of === MON, "and it is the day the file carried");
    check(
      Number(after1.congestion[0].global_teu_waiting) === 111,
      `the global figure round-trips (${after1.congestion[0].global_teu_waiting})`
    );
    check(
      Object.keys(readObject(after1.congestion[0].region_data)).length === 5,
      "all five regions land"
    );
    check(
      after1.ports.length === 5,
      `five port rows for one day (${after1.ports.length})`
    );

    // --- 4 — the ratio is stored, never recomputed --------------------------
    console.log("\nQUEUE / BERTH RATIO");
    const sh = after1.ports.find((p) => p.port_name === "Shanghai/Ningbo")!;
    const computed = Number(sh.ships_anchorage) / Number(sh.ships_port);
    check(
      Number(sh.queue_berth_ratio) === 3.5,
      `67 / 19 uploads and reads back as the PUBLISHED 3.50 (${sh.queue_berth_ratio})`
    );
    check(
      Math.abs(computed - 3.5) > 0.02,
      `and the arithmetic really does disagree (${computed.toFixed(3)}), so this is not a tautology`
    );

    // --- 7 — compound port names survive ------------------------------------
    console.log("\nCOMPOUND PORT NAMES");
    for (const port of PORTS) {
      check(
        after1.ports.some((p) => p.port_name === port),
        `"${port}" round-trips through template, CSV quoting and the foreign key`
      );
    }

    // =====================================================================
    // 2 — the same file twice
    // =====================================================================
    console.log("\nIDEMPOTENCE");
    const r2 = await upload(curate, first);
    check(r2.error === null, "the same file applies a second time without error");
    const after2 = await readBack();
    check(
      after2.congestion.length === after1.congestion.length &&
        after2.ports.length === after1.ports.length,
      `and creates no duplicate rows (${after2.ports.length} port rows, was ${after1.ports.length})`
    );
    check(
      JSON.stringify(after2.ports.map((p) => [p.day_of, p.port_name, p.ships_anchorage, p.queue_berth_ratio])) ===
        JSON.stringify(after1.ports.map((p) => [p.day_of, p.port_name, p.ships_anchorage, p.queue_berth_ratio])),
      "every value is identical after the second apply"
    );

    // =====================================================================
    // 5 — the pre-filled template, re-uploaded unchanged
    // =====================================================================
    console.log("\nPRE-FILLED TEMPLATE");
    const prefilled = buildTemplateCsv(DAYS, PORTS, after2);
    const prefilledRows = parseCsv(prefilled);
    const monRows = prefilledRows.slice(1).filter((r) => r[0] === MON);
    check(
      monRows.every((r) => r[4] !== ""),
      "Monday comes back with every cell filled in from what is stored"
    );
    check(
      prefilledRows.slice(1).filter((r) => r[0] === TUE).every((r) => r[4] === ""),
      "and Tuesday, which was never entered, comes back blank — not zero"
    );
    check(
      prefilledRows.find((r) => r[0] === MON && r[2] === "Shanghai/Ningbo" && r[3] === "Queue to berth ratio")?.[4] ===
        "3.5",
      "the published ratio is pre-filled as stored"
    );

    const rePlan = parseUpload(prefilledRows, opts);
    const diff = planChanges(rePlan, after2);
    check(
      diff.changed.length === 0 && diff.added === 0,
      `re-uploading it unchanged changes nothing (${diff.changed.length} changed, ${diff.added} added)`
    );
    check(
      diff.unchanged === rePlan.values.length && rePlan.values.length > 0,
      `all ${diff.unchanged} values are recognised as already stored`
    );

    const r3 = await upload(curate, prefilled);
    check(r3.error === null, "and it applies cleanly");
    const after3 = await readBack();
    check(
      JSON.stringify(after3.ports.map((p) => [p.port_name, p.ships_anchorage, p.queue_berth_ratio])) ===
        JSON.stringify(after2.ports.map((p) => [p.port_name, p.ships_anchorage, p.queue_berth_ratio])),
      "leaving every stored figure exactly as it was"
    );

    // --- The preview shows an overwrite as from → to -------------------------
    const edited = fill(prefilled, (c) =>
      c[0] === MON && c[1] === "Port congestion total" && c[3] === "TEU at anchorage" ? "333" : null
    );
    const editDiff = planChanges(parseUpload(parseCsv(edited), opts), after3);
    check(
      editDiff.changed.length === 1 &&
        editDiff.changed[0].from === 111 &&
        editDiff.changed[0].to === 333,
      `an edited value previews as 111 → 333 (${JSON.stringify(editDiff.changed)})`
    );

    // =====================================================================
    // 1 — a blank cell leaves the stored value alone
    // =====================================================================
    console.log("\nBLANK LEAVES THE EXISTING VALUE");
    // Everything Monday cleared except one region, which is changed. This is
    // the file that would wipe the day if blank meant null.
    const clearAll = fill(prefilled, (cells) => {
      if (cells[0] !== MON) return null;
      if (cells[1] === "Port congestion by region" && cells[2] === "Europe") return "77";
      return "";
    });
    const clearPlan = parseUpload(parseCsv(clearAll), opts);
    check(clearPlan.values.length === 1, `that file carries exactly one value (${clearPlan.values.length})`);
    check(clearPlan.problems.length === 0, "and no problems");

    const r4 = await upload(curate, clearAll);
    check(r4.error === null, "it applies");
    const after4 = await readBack();
    const mon4 = after4.congestion.find((c) => c.day_of === MON)!;
    check(
      Number(mon4.global_teu_waiting) === 111,
      `the blanked global figure is UNTOUCHED, not nulled (${mon4.global_teu_waiting})`
    );
    check(
      readNumber(readObject(mon4.region_data)["europe"]) === 77,
      `the one filled region did change (${JSON.stringify(readObject(mon4.region_data)["europe"])})`
    );
    check(
      Object.keys(readObject(mon4.region_data)).length === 5,
      `and the other four regions are still there (${Object.keys(readObject(mon4.region_data)).length})`
    );
    const sh4 = after4.ports.find((p) => p.port_name === "Shanghai/Ningbo")!;
    check(
      Number(sh4.queue_berth_ratio) === 3.5 && Number(sh4.ships_anchorage) === 67,
      `the blanked port figures survive too (ratio ${sh4.queue_berth_ratio}, anchorage ${sh4.ships_anchorage})`
    );
    const fleet4 = readObject(after4.fleet.find((f) => f.day_of === MON)?.status_data ?? null);
    const firstStatus = readObject(Object.values(fleet4)[0] as never);
    check(
      readNumber(firstStatus.ships) === 22 && readNumber(firstStatus.teu) === 222,
      `and a fleet status keeps BOTH halves — the two-level merge (${JSON.stringify(firstStatus)})`
    );

    // A file carrying only Ships must not drop the stored TEU. This is the case
    // a shallow jsonb merge gets wrong.
    const shipsOnly = fill(prefilled, (cells) => {
      if (cells[0] !== MON) return null;
      if (cells[1] === "Fleet status") return cells[3] === "Ships" ? "44" : "";
      return "";
    });
    await upload(curate, shipsOnly);
    const after5 = await readBack();
    const merged = readObject(
      readObject(after5.fleet.find((f) => f.day_of === MON)?.status_data ?? null)[
        Object.keys(fleet4)[0]
      ] as never
    );
    check(
      readNumber(merged.ships) === 44 && readNumber(merged.teu) === 222,
      `a file with only Ships updates Ships and keeps TEU (${JSON.stringify(merged)})`
    );

    // =====================================================================
    // 3 (the transaction half) — nothing from a failing file is written
    // =====================================================================
    console.log("\nTHE TRANSACTION HOLDS");
    const before = await readBack();
    const beforeDays = before.congestion.map((c) => c.day_of).join(",");

    // Bypasses the parser deliberately: this is the DATABASE's guarantee, that
    // a payload whose last row trips the foreign key leaves the first rows
    // unwritten too.
    const poisoned = {
      congestion: [{ day_of: TUE, global_teu_waiting: 555, global_pct_fleet: null, region_data: { europe: 5 } }],
      fleet: [{ day_of: TUE, status_data: { "Active Ships": { ships: 5 } } }],
      ports: [
        { day_of: TUE, port_name: "Shanghai/Ningbo", ships_anchorage: 5 },
        { day_of: TUE, port_name: "Nowhere-on-Sea", ships_anchorage: 5 },
      ],
    };
    const { error: poisonError } = await curate.supabase.rpc("apply_operational_upload", {
      p_payload: poisoned as unknown as Json,
    });
    check(
      poisonError?.code === "23503",
      `an unknown port is refused by the database — ${poisonError?.code ?? "IT SUCCEEDED, which is a hole"}`
    );

    const afterPoison = await readBack();
    check(
      afterPoison.congestion.map((c) => c.day_of).join(",") === beforeDays,
      `and NOTHING from that file was written — still ${afterPoison.congestion.length} congestion day(s), no Tuesday`
    );
    check(
      !afterPoison.fleet.some((f) => f.day_of === TUE) &&
        !afterPoison.ports.some((p) => p.day_of === TUE),
      "not the fleet row, and not even the valid port row that came before the bad one"
    );

    // And the parser catches it first, so the database never sees it.
    const namedRefusal = parseUpload(
      parseCsv(fill(blank.replace(/LA\/LB/g, "Nowhere-on-Sea"), (c) => (c[1] === "Port congestion" ? "5" : null))),
      opts
    );
    check(
      namedRefusal.problems.some((p) => /Nowhere-on-Sea/.test(p.message)),
      "and the panel names the port before anything is sent at all"
    );

    // =====================================================================
    // 6 — a read user cannot upload
    // =====================================================================
    console.log("\nWRITE GATE");
    const readerAttempt = await upload(reader, first);
    check(
      readerAttempt.sent,
      "the read user's file parses fine — the refusal is the database's, not the parser's"
    );
    check(
      readerAttempt.error !== null,
      `the read role is refused by apply_operational_upload — ${readerAttempt.error?.code ?? "IT SUCCEEDED, which is a hole"}`
    );
    const afterReader = await readBack();
    check(
      Number(afterReader.congestion.find((c) => c.day_of === MON)?.global_teu_waiting) === 111,
      "and nothing changed"
    );

    // =====================================================================
    // The template offers the same ports the grid does
    // =====================================================================
    console.log("\nTEMPLATE / GRID AGREEMENT");
    const carried = carriedPorts(afterReader.ports).filter(Boolean);
    check(
      carried.length === 5 && PORTS.every((p) => carried.includes(p)),
      `the watchlist carried forward for the template is the grid's five (${carried.join(", ")})`
    );
  } finally {
    const admin = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
    await admin.from("operational_port_congestion").delete().in("day_of", ALL_DAYS);
    await admin.from("operational_fleet_status").delete().in("day_of", ALL_DAYS);
    await admin.from("operational_congestion").delete().in("day_of", ALL_DAYS);

    const counts = await Promise.all(
      (["operational_congestion", "operational_fleet_status", "operational_port_congestion"] as const).map(
        async (t) => {
          const { count } = await admin.from(t).select("id", { count: "exact", head: true });
          return `${t}=${count ?? 0}`;
        }
      )
    );
    console.log(`\nCleanup — ${counts.join("  ")}`);
  }

  console.log(failures === 0 ? "\nAll upload checks passed." : `\n${failures} FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
