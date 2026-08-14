import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import {
  editionWeekChoices,
  resolveEditionWeek,
  type Week,
} from "@/lib/newsletter/week";
import { parseSections } from "@/lib/newsletter/sections";
import { loadBaseUrl, loadEdition, loadWeekCounts } from "@/lib/newsletter/load";
import { parseSnapshot } from "@/lib/newsletter/snapshot";
import { NewsletterComposer, type EditionListItem } from "./NewsletterComposer";

export const dynamic = "force-dynamic";

/** How many completed weeks the dropdown offers, on top of the running one. */
const WEEK_CHOICES = 12;

type SearchParams = { week?: string };

/**
 * The weekly "Ocean Freight Update — AOA" composer.
 *
 * A sibling of /analysis rather than a tab inside it: same ISO week, different
 * job. /analysis is for reading what happened; this is for writing what gets
 * sent, to a different audience, on a Monday.
 *
 * All roles may open it, same tier as Analysis. Everything that writes or sends
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

  // The running week first, then the completed ones. A deep link can name a
  // week older than the list reaches; merging it in keeps the control
  // consistent with what is on screen rather than showing a value that matches
  // none of its options.
  const choices: Week[] = editionWeekChoices(now, WEEK_CHOICES);
  const weeks = choices.some((w) => w.start === week.start)
    ? choices
    : [...choices, week].sort((a, b) => (a.start < b.start ? 1 : -1));

  const [{ data: edition }, { data: allEditions }, weekCounts] = await Promise.all([
    supabase
      .from("newsletter_editions")
      .select("week_of, status, sections, included_article_ids, snapshot, sent_at, entered_at")
      .eq("week_of", week.start)
      .maybeSingle(),
    supabase
      .from("newsletter_editions")
      .select("week_of, status, sent_at")
      .order("week_of", { ascending: false }),
    // The coded-article count per week, so a quiet week is visible BEFORE it is
    // opened. It is the thing that tells a non-technical user why a thin week
    // looks thin.
    loadWeekCounts(supabase, weeks),
  ]);

  const sent = edition?.status === "sent";
  const snapshot = sent ? parseSnapshot(edition?.snapshot ?? null) : null;

  // A sent edition renders from its saved copy and nothing else — no live read,
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
      status={sent ? "sent" : "draft"}
      exists={Boolean(edition)}
      sentAt={edition?.sent_at ?? null}
      savedAt={edition?.entered_at ?? null}
      sections={parseSections(edition?.sections ?? null)}
      includedArticleIds={edition?.included_article_ids ?? null}
      input={loaded?.input ?? null}
      truncated={loaded?.truncated ?? false}
      loadError={loaded?.loadError ?? null}
      snapshot={snapshot}
      snapshotUnreadable={sent && snapshot === null}
      baseUrl={baseUrl}
      canCurate={ctx.canCurate}
      // The server's clock, so "in progress" cannot differ between two people
      // looking at the same week from different machines.
      now={now.toISOString()}
    />
  );
}
