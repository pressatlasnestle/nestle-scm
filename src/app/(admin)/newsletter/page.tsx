import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import {
  recentEditionWeeks,
  resolveEditionWeek,
  type Week,
} from "@/lib/newsletter/week";
import { EMPTY_AUTHORED, readAuthored } from "@/lib/newsletter/edition";
import { loadBaseUrl, loadEdition, loadWeekCounts } from "@/lib/newsletter/load";
import { parseSnapshot } from "@/lib/newsletter/snapshot";
import { NewsletterComposer, type EditionListItem } from "./NewsletterComposer";

export const dynamic = "force-dynamic";

/** How many weeks the dropdown offers. Roughly a quarter of editions. */
const WEEK_CHOICES = 12;

type SearchParams = { week?: string };

/**
 * The weekly "Ocean Freight Update — AOA" composer.
 *
 * A sibling of /analysis rather than a tab inside it: same ISO week, different
 * job. /analysis is for reading what happened; this is for composing what gets
 * sent, to a different audience, on a Monday.
 *
 * All roles may open it, same tier as Analysis. Everything authored or sendable
 * checks canCurate in its own server action, and the database checks it again.
 */
export default async function NewsletterPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await getSessionContext();
  const supabase = await createClient();
  const sp = await searchParams;

  const now = new Date();
  const week = resolveEditionWeek(sp.week, now);

  // A deep link can name a week older than the dropdown reaches. Merging it in
  // keeps the select consistent with what is on screen, rather than rendering a
  // control whose value matches none of its options.
  const choices: Week[] = recentEditionWeeks(now, WEEK_CHOICES);
  const weeks = choices.some((w) => w.start === week.start)
    ? choices
    : [...choices, week].sort((a, b) => (a.start < b.start ? 1 : -1));

  const [{ data: edition }, { data: allEditions }, weekCounts] = await Promise.all([
    supabase
      .from("newsletter_editions")
      .select(
        "week_of, status, headline_read, regional_commentary, reliability_note, watch_list, recommended_actions, included_article_ids, snapshot, sent_at, entered_at"
      )
      .eq("week_of", week.start)
      .maybeSingle(),
    // Drives the status marks in the dropdown, so a curator can tell at a
    // glance which weeks are already frozen without opening each one.
    supabase
      .from("newsletter_editions")
      .select("week_of, status, sent_at")
      .order("week_of", { ascending: false }),
    // And the coded-article count per week, so a thin week is visible BEFORE it
    // is opened. Permanently useful, not a workaround for the corpus being
    // young — some weeks are genuinely quiet.
    loadWeekCounts(supabase, weeks),
  ]);

  const sent = edition?.status === "sent";
  const snapshot = sent ? parseSnapshot(edition?.snapshot ?? null) : null;

  // A sent edition renders from its snapshot and nothing else — no live read,
  // no recompute. Loading the week's rows anyway would only create the chance
  // of showing them.
  const loaded = sent
    ? null
    : await loadEdition(supabase, week, edition?.included_article_ids ?? null);

  const baseUrl = await loadBaseUrl(supabase);

  const editionList: EditionListItem[] = (allEditions ?? []).map((e) => ({
    weekStart: e.week_of,
    status: e.status,
    sentAt: e.sent_at,
  }));

  return (
    <NewsletterComposer
      week={week}
      weeks={weeks}
      weekCounts={weekCounts}
      editions={editionList}
      status={edition?.status === "sent" ? "sent" : "draft"}
      exists={Boolean(edition)}
      sentAt={edition?.sent_at ?? null}
      savedAt={edition?.entered_at ?? null}
      authored={edition ? readAuthored(edition) : EMPTY_AUTHORED}
      includedArticleIds={edition?.included_article_ids ?? null}
      input={loaded?.input ?? null}
      truncated={loaded?.truncated ?? false}
      loadError={loaded?.loadError ?? null}
      snapshot={snapshot}
      snapshotUnreadable={sent && snapshot === null}
      baseUrl={baseUrl}
      canCurate={ctx.canCurate}
    />
  );
}
