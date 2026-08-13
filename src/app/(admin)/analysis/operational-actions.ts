"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/actions/result";
import { monthOf } from "@/lib/analysis/operational";
import { parseIsoDate, weekContainingDate } from "@/lib/analysis/week-period";

const PATH = "/analysis";

/**
 * Writing the manually-entered operational series.
 *
 * Unlike the AI actions in ./actions.ts, these run under the CALLER'S client,
 * not the service role. There is no Vault secret to reach and no RLS to work
 * around: operational_* tables carry a can_curate() write policy precisely so
 * that the database enforces the same rule the UI does. Using the admin client
 * here would bypass that and leave the button as the only gate.
 *
 * Every write is logged to audit_log under 'operational_data.update'. These
 * figures go into client-facing reports and are typed by hand, so "who entered
 * 4.2 days for Antwerp-Rotterdam, and when" has to be answerable. The row
 * itself only records the LAST editor in entered_by; the audit trail is what
 * preserves the history.
 */

/** Blank strings are absent values, not zeros. Rejects non-numeric outright. */
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
 * null, so "no figure for this port" and "a figure of zero" stay distinct all
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
  if (!ctx.canCurate) return { ctx: null, error: "You don't have permission to do that." };
  return { ctx, error: null };
}

async function logEntry(
  supabase: Awaited<ReturnType<typeof createClient>>,
  actorId: string,
  dataset: string,
  period: string,
  fields: Record<string, unknown>
) {
  await supabase.from("audit_log").insert({
    actor_id: actorId,
    action: "operational_data.update",
    target_type: dataset,
    target_id: null,
    // The submitted values ride along, so the log answers "what was it changed
    // TO" and not merely "it was changed".
    metadata: { dataset, period, ...fields },
  });
}

export type CongestionInput = {
  weekStart: string;
  globalTeuWaiting?: string | number | null;
  globalPctFleet?: string | number | null;
  regions?: Record<string, string | number | null>;
};

export async function saveCongestion(input: CongestionInput): Promise<ActionResult> {
  const { ctx, error } = await requireCurate();
  if (!ctx) return { ok: false, error: error! };

  const parsed = parseIsoDate(input.weekStart);
  if (!parsed) return { ok: false, error: "That is not a valid week." };
  // Snapped to the ISO Monday, so a hand-edited URL cannot write a row keyed on
  // a Wednesday that no week lookup would ever find again.
  const week = weekContainingDate(parsed).start;

  const supabase = await createClient();
  const payload = {
    week_of: week,
    global_teu_waiting: toNumberOrNull(input.globalTeuWaiting),
    global_pct_fleet: toNumberOrNull(input.globalPctFleet),
    region_data: toNumberMap(input.regions),
    entered_by: ctx.userId,
    entered_at: new Date().toISOString(),
  };

  const { error: writeError } = await supabase
    .from("operational_congestion")
    .upsert(payload, { onConflict: "week_of" });
  if (writeError) return { ok: false, error: toActionError(writeError) };

  await logEntry(supabase, ctx.userId, "operational_congestion", week, {
    global_teu_waiting: payload.global_teu_waiting,
    global_pct_fleet: payload.global_pct_fleet,
    regions: payload.region_data,
  });

  revalidatePath(PATH);
  return { ok: true };
}

export type WaitingTimeInput = {
  weekStart: string;
  ports?: Record<string, string | number | null>;
};

export async function saveWaitingTime(input: WaitingTimeInput): Promise<ActionResult> {
  const { ctx, error } = await requireCurate();
  if (!ctx) return { ok: false, error: error! };

  const parsed = parseIsoDate(input.weekStart);
  if (!parsed) return { ok: false, error: "That is not a valid week." };
  const week = weekContainingDate(parsed).start;

  const supabase = await createClient();
  const portData = toNumberMap(input.ports);

  const { error: writeError } = await supabase
    .from("operational_waiting_time")
    .upsert(
      {
        week_of: week,
        port_data: portData,
        entered_by: ctx.userId,
        entered_at: new Date().toISOString(),
      },
      { onConflict: "week_of" }
    );
  if (writeError) return { ok: false, error: toActionError(writeError) };

  await logEntry(supabase, ctx.userId, "operational_waiting_time", week, {
    ports: portData,
  });

  revalidatePath(PATH);
  return { ok: true };
}

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

  await logEntry(supabase, ctx.userId, "operational_schedule_reliability", month, {
    glp_issue_number: payload.glp_issue_number,
    global_reliability_pct: payload.global_reliability_pct,
    avg_delay_days: payload.avg_delay_days,
    alliances: payload.alliance_data,
  });

  revalidatePath(PATH);
  return { ok: true };
}
