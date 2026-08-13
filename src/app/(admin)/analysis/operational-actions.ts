"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/actions/result";
import { monthOf } from "@/lib/analysis/operational";
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
