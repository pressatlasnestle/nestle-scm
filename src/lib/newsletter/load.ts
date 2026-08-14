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
 *
 * THE WINDOW IS A DATE RANGE, NOT A ROLLING SEVEN DAYS. Every query below is
 * bounded by the week's Monday and Sunday as literal dates, both ends
 * inclusive. `published_at > now() - interval '7 days'` would return a
 * different set every hour and silently disagree with the date range the
 * edition prints on itself; published_at is a `date` column, so there is no
 * timezone arithmetic to do and no now() to consult.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";
import {
  monthOf,
  type CongestionRow,
  type FleetStatusRow,
  type PortCongestionRow,
  type ScheduleReliabilityRow,
} from "@/lib/analysis/operational";
import { isRunningWeek, previousWeek, type Week } from "./week";
import type { PressCandidate } from "./press";
import type { EditionInput } from "./edition";

type Client = SupabaseClient<Database>;

/**
 * Hard ceiling on articles pulled for one week. PostgREST caps at 1000 by
 * default anyway; naming it means a week that exceeded it is a visible number
 * in the composer rather than a press section that is quietly incomplete.
 */
export const MAX_WEEK_ROWS = 2000;

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
  /** True when the week hit MAX_WEEK_ROWS, so the press section is partial. */
  truncated: boolean;
  loadError: string | null;
};

/**
 * Reads one week, plus the week before it for the deltas.
 *
 * The prior week is fetched in full rather than as a single "latest day" row
 * because the latest entered day is not knowable without looking: a week whose
 * last entry was the Wednesday is completely ordinary, and a query for the
 * Sunday would find nothing.
 */
export async function loadEdition(
  supabase: Client,
  week: Week,
  includedArticleIds: string[] | null
): Promise<LoadedEdition> {
  const prior = previousWeek(week);

  const inWeek = <T extends { gte: (c: string, v: string) => T; lte: (c: string, v: string) => T }>(
    query: T,
    column: string,
    w: Week
  ) => query.gte(column, w.start).lte(column, w.end);

  const [
    congestion,
    priorCongestion,
    fleet,
    priorFleet,
    ports,
    priorPorts,
    reliability,
    press,
    history,
  ] = await Promise.all([
    inWeek(supabase.from("operational_congestion").select(CONGESTION_SELECT), "day_of", week).order("day_of"),
    inWeek(supabase.from("operational_congestion").select(CONGESTION_SELECT), "day_of", prior).order("day_of"),
    inWeek(supabase.from("operational_fleet_status").select(FLEET_SELECT), "day_of", week).order("day_of"),
    inWeek(supabase.from("operational_fleet_status").select(FLEET_SELECT), "day_of", prior).order("day_of"),
    inWeek(supabase.from("operational_port_congestion").select(PORT_SELECT), "day_of", week).order("day_of"),
    inWeek(supabase.from("operational_port_congestion").select(PORT_SELECT), "day_of", prior).order("day_of"),
    // Reliability is MONTHLY and published in arrears, so it is carried
    // forward: the most recent month at or before the one the week ends in.
    // Bounded rather than simply "latest" so navigating back to an older week
    // cannot show figures published after it — a carried-forward number is
    // fine, a time-travelling one is not. This lookup is unchanged from 537fcbf.
    //
    // TWO rows, not one. The second is the previous PUBLISHED month, and it is
    // what the reliability deltas compare against. Comparing week-on-week would
    // compare the carried-forward figure with itself and print 0% for three
    // weeks out of four — a claim that nothing moved, made about a number that
    // was never re-measured.
    supabase
      .from("operational_schedule_reliability")
      .select(RELIABILITY_SELECT)
      .lte("month_of", monthOf(week.end))
      .order("month_of", { ascending: false })
      .limit(2),
    // Candidates: active, coded, published inside the week. BOTH ENDS
    // INCLUSIVE — an article dated the Sunday belongs to this week, one dated
    // the Monday belongs to the next. Rows with a null published_at are
    // excluded for the same reason the week resolver excludes them: a story
    // whose date is unknown cannot be shown to fall in a given week.
    supabase
      .from("articles")
      .select(PRESS_SELECT)
      .eq("status", "active")
      .eq("coded_status", "coded")
      .not("published_at", "is", null)
      .gte("published_at", week.start)
      .lte("published_at", week.end)
      .order("published_at", { ascending: false })
      .limit(MAX_WEEK_ROWS),
    // Is there ANY operational reading before this week? This is what separates
    // "first edition" from "the previous week was never entered". Four cheap
    // limit-1 probes rather than one clever query, because the four tables have
    // no join worth writing.
    Promise.all([
      supabase.from("operational_congestion").select("day_of").lt("day_of", week.start).limit(1),
      supabase.from("operational_fleet_status").select("day_of").lt("day_of", week.start).limit(1),
      supabase.from("operational_port_congestion").select("day_of").lt("day_of", week.start).limit(1),
      supabase
        .from("operational_schedule_reliability")
        .select("month_of")
        .lt("month_of", monthOf(week.start))
        .limit(1),
    ]),
  ]);

  const hasHistoryBefore = history.some((r) => (r.data?.length ?? 0) > 0);

  const reliabilityRows = (reliability.data ?? []) as ScheduleReliabilityRow[];

  // Only the article read is worth surfacing: the press section is the one part
  // of the edition that is never empty for an ordinary week, so an error there
  // reads as "quiet week" if it is not said out loud.
  const loadError = press.error?.message ?? null;

  return {
    input: {
      week,
      congestion: (congestion.data ?? []) as CongestionRow[],
      priorCongestion: (priorCongestion.data ?? []) as CongestionRow[],
      fleet: (fleet.data ?? []) as FleetStatusRow[],
      priorFleet: (priorFleet.data ?? []) as FleetStatusRow[],
      ports: (ports.data ?? []) as PortCongestionRow[],
      priorPorts: (priorPorts.data ?? []) as PortCongestionRow[],
      reliability: reliabilityRows[0] ?? null,
      priorReliability: reliabilityRows[1] ?? null,
      press: (press.data ?? []) as PressCandidate[],
      includedArticleIds,
      hasHistoryBefore,
      // Read here rather than inside buildGenerated(), which must stay pure:
      // at send time this becomes part of the frozen record of whether the week
      // had closed when the edition went out.
      partialWeek: isRunningWeek(week),
    },
    truncated: (press.data?.length ?? 0) >= MAX_WEEK_ROWS,
    loadError,
  };
}

/**
 * Coded-article counts for the weeks the selector offers.
 *
 * Shown beside each week so a thin week is visible BEFORE it is opened rather
 * than after. That is permanently useful, not a workaround for the corpus's
 * current shape — ingestion started recently, so older weeks are thin and the
 * most recent ones are dense, and that resolves by itself.
 *
 * One exact head-count per week rather than one big fetch bucketed in memory.
 * A single query spanning twelve weeks would be capped by PostgREST at 1000
 * rows and would silently under-count the very weeks the number exists to
 * describe; a head request transfers no rows at all.
 */
export async function loadWeekCounts(
  supabase: Client,
  weeks: Week[]
): Promise<Record<string, number>> {
  const results = await Promise.all(
    weeks.map(async (w) => {
      const { count } = await supabase
        .from("articles")
        .select("id", { count: "exact", head: true })
        .eq("status", "active")
        .eq("coded_status", "coded")
        .not("published_at", "is", null)
        .gte("published_at", w.start)
        .lte("published_at", w.end);
      return [w.start, count ?? 0] as const;
    })
  );
  return Object.fromEntries(results);
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
