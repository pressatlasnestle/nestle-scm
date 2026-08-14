import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import { recentMonths, resolveMonth, type Month } from "@/lib/newsletter/month";
import { EMPTY_AUTHORED, readAuthored } from "@/lib/newsletter/edition";
import { loadBaseUrl, loadEdition } from "@/lib/newsletter/load";
import { parseSnapshot } from "@/lib/newsletter/snapshot";
import { NewsletterComposer, type EditionListItem } from "./NewsletterComposer";

export const dynamic = "force-dynamic";

/** How many months the dropdown offers. A year of editions. */
const MONTH_CHOICES = 12;

type SearchParams = { month?: string };

/**
 * The monthly "Ocean Freight Update — AOA" composer.
 *
 * A sibling of /analysis rather than a tab inside it: different cadence
 * (monthly against weekly), different job (composing something to send against
 * reading what happened) and different audience (the client against the desk).
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
  const month = resolveMonth(sp.month, now);

  // A deep link can name a month older than the dropdown reaches. Merging it in
  // keeps the select consistent with what is on screen, rather than rendering a
  // control whose value matches none of its options.
  const choices: Month[] = recentMonths(now, MONTH_CHOICES);
  const months = choices.some((m) => m.start === month.start)
    ? choices
    : [...choices, month].sort((a, b) => (a.start < b.start ? 1 : -1));

  const [{ data: edition }, { data: allEditions }] = await Promise.all([
    supabase
      .from("newsletter_editions")
      .select(
        "month_of, status, headline_read, regional_commentary, reliability_note, watch_list, recommended_actions, included_article_ids, snapshot, sent_at, entered_at"
      )
      .eq("month_of", month.start)
      .maybeSingle(),
    // Drives the status marks in the dropdown, so a curator can tell at a
    // glance which months are already frozen without opening each one.
    supabase
      .from("newsletter_editions")
      .select("month_of, status, sent_at")
      .order("month_of", { ascending: false }),
  ]);

  const sent = edition?.status === "sent";
  const snapshot = sent ? parseSnapshot(edition?.snapshot ?? null) : null;

  // A sent edition renders from its snapshot and nothing else — no live read,
  // no recompute. Loading the month's rows anyway would only create the chance
  // of showing them.
  const loaded = sent
    ? null
    : await loadEdition(supabase, month, edition?.included_article_ids ?? null);

  const baseUrl = await loadBaseUrl(supabase);

  const editionList: EditionListItem[] = (allEditions ?? []).map((e) => ({
    monthStart: e.month_of,
    status: e.status,
    sentAt: e.sent_at,
  }));

  return (
    <NewsletterComposer
      month={month}
      months={months}
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
