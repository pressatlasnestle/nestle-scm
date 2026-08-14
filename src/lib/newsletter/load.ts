/**
 * Reading everything an edition is built from.
 *
 * Shared by the composer page and the send action ON PURPOSE. The action must
 * not trust a snapshot assembled in the browser and posted back — that would
 * make the frozen record of what the client received whatever the client's
 * JavaScript said it was. It re-reads the same rows through the same function,
 * so what is frozen is what the server can see at the moment of sending.
 *
 * Every read here runs under whichever client is passed in, which in both
 * callers is the CALLER'S client. There is no Vault secret to reach and no RLS
 * to work around: newsletter_editions and the operational_* tables all carry
 * policies precisely so the database enforces the same rule the UI does.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";
import type {
  CongestionRow,
  FleetStatusRow,
  PortCongestionRow,
  ScheduleReliabilityRow,
} from "@/lib/analysis/operational";
import { previousMonth, type Month } from "./month";
import type { PressCandidate } from "./press";
import type { EditionInput } from "./edition";

type Client = SupabaseClient<Database>;

/**
 * Hard ceiling on articles pulled for one month. PostgREST caps at 1000 by
 * default anyway; naming it means a month that exceeded it is a visible number
 * in the composer rather than a press section that is quietly incomplete.
 */
export const MAX_MONTH_ROWS = 2000;

const PRESS_SELECT =
  "id, headline, ai_summary, url, media, published_at, ai_themes";

const CONGESTION_SELECT =
  "day_of, global_teu_waiting, global_pct_fleet, region_data, entered_at, entered_by";
const FLEET_SELECT = "day_of, status_data, entered_at, entered_by";
const PORT_SELECT =
  "day_of, port_name, ships_anchorage, ships_port, teu_anchorage, teu_port, queue_berth_ratio, entered_at, entered_by";
const RELIABILITY_SELECT =
  "month_of, glp_issue_number, global_reliability_pct, avg_delay_days, alliance_data, entered_at, entered_by";

export type LoadedEdition = {
  input: EditionInput;
  /** True when the month hit MAX_MONTH_ROWS, so the press section is partial. */
  truncated: boolean;
  loadError: string | null;
};

/**
 * Reads one month, plus the month before it for the deltas.
 *
 * The prior month is fetched in full rather than as a single "latest day" row
 * because the latest entered day is not knowable without looking: a month whose
 * last entry was the 12th is completely ordinary, and a query for the last day
 * of the month would find nothing.
 */
export async function loadEdition(
  supabase: Client,
  month: Month,
  includedArticleIds: string[] | null
): Promise<LoadedEdition> {
  const prior = previousMonth(month);

  const inMonth = <T extends { gte: (c: string, v: string) => T; lte: (c: string, v: string) => T }>(
    query: T,
    column: string,
    m: Month
  ) => query.gte(column, m.start).lte(column, m.end);

  const [
    congestion,
    priorCongestion,
    fleet,
    priorFleet,
    ports,
    priorPorts,
    reliability,
    priorReliability,
    press,
    history,
  ] = await Promise.all([
    inMonth(supabase.from("operational_congestion").select(CONGESTION_SELECT), "day_of", month).order("day_of"),
    inMonth(supabase.from("operational_congestion").select(CONGESTION_SELECT), "day_of", prior).order("day_of"),
    inMonth(supabase.from("operational_fleet_status").select(FLEET_SELECT), "day_of", month).order("day_of"),
    inMonth(supabase.from("operational_fleet_status").select(FLEET_SELECT), "day_of", prior).order("day_of"),
    inMonth(supabase.from("operational_port_congestion").select(PORT_SELECT), "day_of", month).order("day_of"),
    inMonth(supabase.from("operational_port_congestion").select(PORT_SELECT), "day_of", prior).order("day_of"),
    supabase
      .from("operational_schedule_reliability")
      .select(RELIABILITY_SELECT)
      .eq("month_of", month.start)
      .maybeSingle(),
    supabase
      .from("operational_schedule_reliability")
      .select(RELIABILITY_SELECT)
      .eq("month_of", prior.start)
      .maybeSingle(),
    // Candidates: active, coded, published inside the month. Rows with a null
    // published_at are excluded for the same reason the week resolver excludes
    // them — a story whose date is unknown cannot be shown to fall in a month.
    supabase
      .from("articles")
      .select(PRESS_SELECT)
      .eq("status", "active")
      .eq("coded_status", "coded")
      .not("published_at", "is", null)
      .gte("published_at", month.start)
      .lte("published_at", month.end)
      .order("published_at", { ascending: false })
      .limit(MAX_MONTH_ROWS),
    // Is there ANY operational reading before this month? This is what separates
    // "first edition" from "the previous month was never entered". Four cheap
    // limit-1 probes rather than one clever query, because the four tables have
    // no join worth writing.
    Promise.all([
      supabase.from("operational_congestion").select("day_of").lt("day_of", month.start).limit(1),
      supabase.from("operational_fleet_status").select("day_of").lt("day_of", month.start).limit(1),
      supabase.from("operational_port_congestion").select("day_of").lt("day_of", month.start).limit(1),
      supabase.from("operational_schedule_reliability").select("month_of").lt("month_of", month.start).limit(1),
    ]),
  ]);

  const hasHistoryBefore = history.some((r) => (r.data?.length ?? 0) > 0);

  // Only the article read is worth surfacing: the press section is the one part
  // of the edition that is never empty for an ordinary month, so an error there
  // reads as "quiet month" if it is not said out loud.
  const loadError = press.error?.message ?? null;

  return {
    input: {
      month,
      congestion: (congestion.data ?? []) as CongestionRow[],
      priorCongestion: (priorCongestion.data ?? []) as CongestionRow[],
      fleet: (fleet.data ?? []) as FleetStatusRow[],
      priorFleet: (priorFleet.data ?? []) as FleetStatusRow[],
      ports: (ports.data ?? []) as PortCongestionRow[],
      priorPorts: (priorPorts.data ?? []) as PortCongestionRow[],
      reliability: (reliability.data ?? null) as ScheduleReliabilityRow | null,
      priorReliability: (priorReliability.data ?? null) as ScheduleReliabilityRow | null,
      press: (press.data ?? []) as PressCandidate[],
      includedArticleIds,
      hasHistoryBefore,
    },
    truncated: (press.data?.length ?? 0) >= MAX_MONTH_ROWS,
    loadError,
  };
}

/** The app's public URL, for the email's link back to the Analysis panel. */
export async function loadBaseUrl(supabase: Client): Promise<string | null> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "app_base_url")
    .maybeSingle();
  const value = data?.value;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
