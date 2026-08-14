"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/actions/result";
import { monthOf } from "@/lib/analysis/operational";
import { parseCsv } from "@/lib/analysis/csv";
import {
  buildUploadPayload,
  groupProblems,
  parseUpload,
} from "@/lib/analysis/operational-template";
import { parseIsoDate } from "@/lib/analysis/week-period";
import type { Json } from "@/types/database.types";

const PATH = "/analysis";

/**
 * Writing the manually-entered operational series.
 *
 * These run under the CALLER'S client, not the service role. There is no Vault
 * secret to reach and no RLS to work around: the operational_* tables carry a
 * can_curate() write policy precisely so the database enforces the same rule
 * the UI does. An admin client here would bypass that and leave the button as
 * the only gate.
 *
 * Every write is logged to audit_log as 'operational_data.update' with the
 * submitted values. These figures reach client-facing reports and are typed by
 * hand, so "who entered 3.50 for Shanghai/Ningbo, and when" has to be
 * answerable; entered_by holds only the LAST editor, so the audit trail is the
 * history.
 */

/** Blank is absent, not zero. Non-numeric is absent too, never NaN. */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A submitted {key: value} map, cleaned for storage.
 *
 * Keys whose value is blank or unparseable are DROPPED rather than stored as
 * null, so "no figure for this region" and "a figure of zero" stay distinct all
 * the way to the chart.
 */
function toNumberMap(input: Record<string, unknown> | undefined | null) {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    const parsed = toNumberOrNull(value);
    if (parsed !== null) out[key] = parsed;
  }
  return out;
}

async function requireCurate() {
  const ctx = await getSessionContext();
  if (!ctx.canCurate) {
    return { ctx: null as null, error: "You don't have permission to do that." };
  }
  return { ctx, error: null as string | null };
}

// ---------------------------------------------------------------------------
// The weekly grid
// ---------------------------------------------------------------------------

export type DayEntry = {
  /** YYYY-MM-DD. Days absent from the payload are left untouched. */
  day: string;
  congestion?: {
    globalTeuWaiting?: string | null;
    globalPctFleet?: string | null;
    regions?: Record<string, string | null>;
  };
  fleet?: Record<string, { ships?: string | null; teu?: string | null }>;
  ports?: {
    portName: string;
    ships_anchorage?: string | null;
    ships_port?: string | null;
    teu_anchorage?: string | null;
    teu_port?: string | null;
    queue_berth_ratio?: string | null;
  }[];
};

export type SaveWeekResult = ActionResult & {
  /** Days that actually carried at least one value. */
  daysWritten?: number;
  portRowsWritten?: number;
};

/**
 * Saves a whole week of daily figures in one call.
 *
 * IDEMPOTENT AND SCOPED TO WHAT IT CARRIES. Every write is an upsert on the
 * day (or the day+port), so re-saving replaces those days and leaves every
 * other day alone. A day whose cells are all blank writes nothing at all —
 * blank is absent, and an all-blank column must not create a row of nulls that
 * would later read back as "this day was entered".
 *
 * Rows are written in a loop rather than one bulk upsert per table because the
 * per-day payloads are independent and a failure on one day should report
 * which day, not abandon the week silently. A week is at most 7 days and 35
 * port rows; the round trips are not the cost worth optimising here.
 */
export async function saveOperationalWeek(
  entries: DayEntry[]
): Promise<SaveWeekResult> {
  const { ctx, error } = await requireCurate();
  if (!ctx) return { ok: false, error: error! };

  const supabase = await createClient();
  const now = new Date().toISOString();
  // Typed as Json so it satisfies the audit_log metadata column without a cast
  // at the insert site.
  const logged: Json[] = [];

  let daysWritten = 0;
  let portRowsWritten = 0;

  for (const entry of entries) {
    const day = parseIsoDate(entry.day);
    if (!day) return { ok: false, error: `"${entry.day}" is not a valid date.` };

    // --- Congestion ------------------------------------------------------
    const teu = toNumberOrNull(entry.congestion?.globalTeuWaiting);
    const pct = toNumberOrNull(entry.congestion?.globalPctFleet);
    const regions = toNumberMap(entry.congestion?.regions);
    if (teu !== null || pct !== null || Object.keys(regions).length > 0) {
      const { error: e } = await supabase.from("operational_congestion").upsert(
        {
          day_of: day,
          global_teu_waiting: teu,
          global_pct_fleet: pct,
          region_data: regions,
          entered_by: ctx.userId,
          entered_at: now,
        },
        { onConflict: "day_of" }
      );
      if (e) return { ok: false, error: toActionError(e) };
      daysWritten += 1;
      logged.push({
        dataset: "operational_congestion",
        period: day,
        global_teu_waiting: teu,
        global_pct_fleet: pct,
        regions,
      });
    }

    // --- Fleet status ----------------------------------------------------
    const statuses: Record<string, { ships?: number; teu?: number }> = {};
    for (const [status, values] of Object.entries(entry.fleet ?? {})) {
      const ships = toNumberOrNull(values?.ships);
      const teuValue = toNumberOrNull(values?.teu);
      if (ships === null && teuValue === null) continue;
      statuses[status] = {};
      if (ships !== null) statuses[status].ships = ships;
      if (teuValue !== null) statuses[status].teu = teuValue;
    }
    if (Object.keys(statuses).length > 0) {
      const { error: e } = await supabase.from("operational_fleet_status").upsert(
        {
          day_of: day,
          status_data: statuses,
          entered_by: ctx.userId,
          entered_at: now,
        },
        { onConflict: "day_of" }
      );
      if (e) return { ok: false, error: toActionError(e) };
      logged.push({
        dataset: "operational_fleet_status",
        period: day,
        statuses,
      });
    }

    // --- Port congestion --------------------------------------------------
    for (const port of entry.ports ?? []) {
      const name = (port.portName ?? "").trim();
      if (!name) continue;

      const values = {
        ships_anchorage: toNumberOrNull(port.ships_anchorage),
        ships_port: toNumberOrNull(port.ships_port),
        teu_anchorage: toNumberOrNull(port.teu_anchorage),
        teu_port: toNumberOrNull(port.teu_port),
        // Stored exactly as typed. Never computed from the two ship counts —
        // Linerlytica smooths it, and deriving it would print figures that
        // disagree with the client's own source document.
        queue_berth_ratio: toNumberOrNull(port.queue_berth_ratio),
      };
      if (Object.values(values).every((v) => v === null)) continue;

      const { error: e } = await supabase
        .from("operational_port_congestion")
        .upsert(
          {
            day_of: day,
            port_name: name,
            ...values,
            entered_by: ctx.userId,
            entered_at: now,
          },
          { onConflict: "day_of,port_name" }
        );
      if (e) {
        // An unknown port trips the foreign key. Say which, rather than
        // surfacing a constraint name.
        if (e.code === "23503") {
          return {
            ok: false,
            error: `"${name}" is not in the port list. Pick a port from the dropdown.`,
          };
        }
        return { ok: false, error: toActionError(e) };
      }
      portRowsWritten += 1;
      logged.push({
        dataset: "operational_port_congestion",
        period: day,
        port: name,
        ...values,
      });
    }
  }

  if (logged.length > 0) {
    await supabase.from("audit_log").insert({
      actor_id: ctx.userId,
      action: "operational_data.update",
      target_type: "operational_week",
      target_id: null,
      // One row per save carrying every value submitted. Per-value rows would
      // swamp the log for a single act of transcription.
      metadata: { entries: logged },
    });
  }

  revalidatePath(PATH);
  return { ok: true, daysWritten, portRowsWritten };
}

// ---------------------------------------------------------------------------
// The CSV upload — a second way into the same three tables
// ---------------------------------------------------------------------------

export type UploadResult = ActionResult & {
  valuesWritten?: number;
  daysWritten?: number;
};

/**
 * Applies an uploaded template.
 *
 * THE SERVER RE-PARSES THE FILE. The panel already parsed it to show the
 * preview, but what arrives here is the file text, not the panel's conclusions.
 * Parsing is pure and deterministic, so the second pass costs nothing and means
 * a client that has been tampered with cannot write a value the file does not
 * contain, or a port the file does not name.
 *
 * ALL OR NOTHING. Any row problem refuses the whole file — this is not a
 * partial-import tool. A file with one unrecognised port leaves the database
 * exactly as it was, so the fix is "correct that row and upload again" rather
 * than "work out which of the other 300 rows went in".
 *
 * The write itself goes through apply_operational_upload(), a SECURITY INVOKER
 * function, for the one thing PostgREST cannot give from here: a single
 * transaction across three tables. can_curate() still decides, under the
 * caller's own client, exactly as it does for the grid.
 */
export async function applyOperationalUpload(input: {
  /** The uploaded file's text, verbatim. BOM and CRLF included. */
  csv: string;
  /** The seven days the template was generated for, YYYY-MM-DD. */
  days: string[];
  /** The five tracked ports it was generated with. */
  ports: string[];
  /** For the audit trail, so a figure can be traced back to a file. */
  filename?: string;
}): Promise<UploadResult> {
  const { ctx, error } = await requireCurate();
  if (!ctx) return { ok: false, error: error! };

  for (const day of input.days) {
    if (!parseIsoDate(day)) {
      return { ok: false, error: `"${day}" is not a valid date.` };
    }
  }

  const supabase = await createClient();

  // The full vocabulary, not the five in the template: swapping a port in the
  // file is legitimate, and the database will accept any name that exists.
  const { data: portRows, error: portError } = await supabase
    .from("ports")
    .select("name")
    .order("name");
  if (portError) return { ok: false, error: toActionError(portError) };

  const plan = parseUpload(parseCsv(input.csv), {
    days: input.days,
    ports: input.ports,
    portVocabulary: (portRows ?? []).map((p) => p.name),
  });

  if (plan.structuralError) return { ok: false, error: plan.structuralError };
  if (plan.problems.length > 0) {
    // The panel already listed these; this is the backstop for a file that got
    // here another way. Grouped, so one renamed port is one sentence.
    const groups = groupProblems(plan.problems);
    const rest = groups.length - 1;
    return {
      ok: false,
      error:
        `${groups[0].label}: ${groups[0].message}` +
        (rest > 0 ? ` (and ${rest} other problem${rest === 1 ? "" : "s"}.)` : ""),
    };
  }
  if (plan.values.length === 0) {
    return {
      ok: false,
      error:
        "Every cell in that file is empty, so there is nothing to save. Fill in the Value column and upload it again.",
    };
  }

  const payload = buildUploadPayload(plan.values);

  const { error: writeError } = await supabase.rpc("apply_operational_upload", {
    p_payload: payload as unknown as Json,
  });
  if (writeError) {
    // An unknown port trips the foreign key. Name it, rather than surfacing a
    // constraint name — and nothing was written, because the function body is
    // one transaction.
    if (writeError.code === "23503") {
      return {
        ok: false,
        error:
          "One of the port names in that file is not in the port list, so nothing was saved. Download the template again — it names the ports for you.",
      };
    }
    return { ok: false, error: toActionError(writeError) };
  }

  await supabase.from("audit_log").insert({
    actor_id: ctx.userId,
    action: "operational_data.update",
    target_type: "operational_week",
    target_id: null,
    metadata: {
      // Same action as the grid, because it is the same change to the same
      // tables. The source distinguishes them when reading the log back.
      source: "csv_upload",
      filename: input.filename ?? null,
      days: plan.days,
      blank_cells: plan.blank,
      entries: [payload as unknown as Json],
    },
  });

  revalidatePath(PATH);
  return {
    ok: true,
    valuesWritten: plan.values.length,
    daysWritten: plan.days.length,
  };
}

// ---------------------------------------------------------------------------
// Schedule reliability — its own dialog, its own grain
// ---------------------------------------------------------------------------

export type ScheduleReliabilityInput = {
  /** Any date inside the month being entered; snapped to the 1st. */
  monthStart: string;
  glpIssueNumber?: string | number | null;
  globalReliabilityPct?: string | number | null;
  avgDelayDays?: string | number | null;
  alliances?: Record<string, string | number | null>;
};

export async function saveScheduleReliability(
  input: ScheduleReliabilityInput
): Promise<ActionResult> {
  const { ctx, error } = await requireCurate();
  if (!ctx) return { ok: false, error: error! };

  const parsed = parseIsoDate(input.monthStart);
  if (!parsed) return { ok: false, error: "That is not a valid month." };
  const month = monthOf(parsed);

  const supabase = await createClient();
  const issue = toNumberOrNull(input.glpIssueNumber);
  const payload = {
    month_of: month,
    // Integer column: a fractional issue number is a typing slip, not data.
    glp_issue_number: issue === null ? null : Math.trunc(issue),
    global_reliability_pct: toNumberOrNull(input.globalReliabilityPct),
    avg_delay_days: toNumberOrNull(input.avgDelayDays),
    alliance_data: toNumberMap(input.alliances),
    entered_by: ctx.userId,
    entered_at: new Date().toISOString(),
  };

  const { error: writeError } = await supabase
    .from("operational_schedule_reliability")
    .upsert(payload, { onConflict: "month_of" });
  if (writeError) return { ok: false, error: toActionError(writeError) };

  await supabase.from("audit_log").insert({
    actor_id: ctx.userId,
    action: "operational_data.update",
    target_type: "operational_schedule_reliability",
    target_id: null,
    metadata: {
      dataset: "operational_schedule_reliability",
      period: month,
      glp_issue_number: payload.glp_issue_number,
      global_reliability_pct: payload.global_reliability_pct,
      avg_delay_days: payload.avg_delay_days,
      alliances: payload.alliance_data,
    },
  });

  revalidatePath(PATH);
  return { ok: true };
}
