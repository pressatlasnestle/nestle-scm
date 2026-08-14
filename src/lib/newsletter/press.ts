/**
 * "What moved in the press" — choosing and grouping the month's coverage.
 *
 * The candidate set is every `articles` row that is active, coded, and
 * published inside the edition month. Everything below is about ORDER, and the
 * order matters more than it looks: three plausible-seeming ways to rank these
 * rows all produce a section that reads correctly and carries no information.
 *
 * NOT BY ai_sentiment. Of the 161 coded articles, 68 are "Very unfavourable"
 * and 32 "Very favourable" — 62% sit at the extremes and 42% in a single
 * bucket. Sorting by it leaves 68 rows tied for first, broken by whatever the
 * query happens to sort on next. The scale needs recalibrating before it can
 * order anything, and until then it is a coin toss wearing a label.
 *
 * NOT BY ai_relevance_score. The column exists and is NULL on every one of
 * those 161 rows — nothing populates it. Coalescing it to zero and sorting
 * gives a stable-looking order carrying no information at all, which is worse
 * than an obviously broken one because nobody would ever look at it twice. It
 * is a dead column: either wire it into the coder or drop it.
 *
 * SO: recency within a theme, and theme order by how many of the month's
 * articles carry that theme. That is honest about what it is — a volume
 * ranking and a date ranking, both of which the data actually supports.
 *
 * DEDUPLICATION ACROSS THEMES. ai_themes is an array and an article carries up
 * to three; "Chokepoints & routing" alone tags 91 of the 161. Left ungrouped,
 * a reader meets the same story under three headings and stops trusting the
 * section. Every article therefore appears exactly once, under its
 * highest-volume theme.
 */

import {
  isNearDuplicateHeadline,
  normalizeHeadline,
} from "@/lib/analysis/similarity";
import type { Month } from "./month";

/** The columns the press section needs. Matches the select in the page. */
export type PressCandidate = {
  id: string;
  headline: string;
  /** Present on every coded row — this is the one-liner. */
  ai_summary: string | null;
  url: string | null;
  media: string | null;
  published_at: string | null;
  ai_themes: string[] | null;
};

export type PressItem = {
  id: string;
  headline: string;
  summary: string;
  url: string | null;
  /** The outlet, or null when nothing usable was recorded. See outletName(). */
  media: string | null;
  publishedAt: string | null;
  /** The theme it was filed under, after dedup. */
  theme: string;
};

export type PressTheme = {
  theme: string;
  /**
   * How many of the month's articles carry this theme, BEFORE dedup. This is
   * what orders the themes, and it is deliberately not the same number as
   * `items.length` — an article tagged with a bigger theme is counted here but
   * filed there.
   */
  periodCount: number;
  /** What the edition renders, at most PRESS_ITEMS_PER_THEME. */
  items: PressItem[];
  /** Kept by the curator, filed here, but past the per-theme cap. */
  heldBack: PressItem[];
  /** Kept by the curator but suppressed as a near-duplicate of a rendered item. */
  nearDuplicates: PressItem[];
  /** Filed here and toggled out by the curator. */
  excluded: PressItem[];
};

export type PressSelection = {
  themes: PressTheme[];
  /** Rendered in the edition. */
  shown: number;
  /** Coded, active articles published in the month — the whole candidate set. */
  candidates: number;
  /**
   * Distinct NAMED outlets behind the candidate set — see outletName(). Counts
   * only what the corpus actually attributes, so the source line can say
   * "named outlets" and be true rather than counting search queries as
   * publications.
   */
  outlets: number;
};

/**
 * Items per theme in the rendered edition.
 *
 * The cap is applied AFTER the curator's exclusions, so toggling out one of the
 * five promotes the sixth rather than leaving a gap. The composer lists every
 * candidate either way and says how many are held back, because a cap nobody
 * can see reads as "this was all there was".
 */
export const PRESS_ITEMS_PER_THEME = 5;

/**
 * Where articles carrying no theme are filed.
 *
 * Every coded row currently carries one to three themes, so this group is
 * normally empty. It exists so that an untagged article is visibly filed
 * somewhere rather than silently dropped between the grouping and the render —
 * which is the failure that would never show up in a count.
 */
export const UNTHEMED_GROUP = "Other coverage";

/**
 * The outlet name, or null when the corpus does not actually hold one.
 *
 * Articles captured through the Google Alerts channel store the ALERT QUERY in
 * `media`, not the publisher — 'Google Alert - "Red Sea" ("ocean freight" OR
 * "container shipping" OR "liner shipping")' and five others like it, together
 * covering 49 of August 2026's 106 coded articles. Printed as a byline in a
 * client-facing edition that is not merely ugly, it is false: it attributes the
 * story to a search.
 *
 * The alert queries all begin with a fixed literal prefix, so this is an exact
 * match rather than a guess. Nothing is inferred in its place — several of those
 * headlines carry the publisher as a " - Outlet" suffix, and harvesting it would
 * be a heuristic that silently mis-attributes every headline containing a dash.
 * The item renders with its date and its link, and no byline.
 *
 * The real fix belongs in the Google Alerts ingestion, which should record the
 * publisher it already receives. Until it does, this is the honest reading of
 * what the column holds.
 */
export function outletName(media: string | null): string | null {
  const value = (media ?? "").trim();
  if (!value) return null;
  if (/^Google Alert\s*[-–]/i.test(value)) return null;
  return value;
}

function toItem(row: PressCandidate, theme: string): PressItem {
  return {
    id: row.id,
    headline: row.headline,
    summary: (row.ai_summary ?? "").trim(),
    url: row.url,
    media: outletName(row.media),
    publishedAt: row.published_at,
    theme,
  };
}

/**
 * Newest first, with a deterministic tiebreak.
 *
 * published_at is a `date`, so a month's worth of articles collides heavily on
 * it — a dozen stories share 14 September. Falling back to the headline keeps
 * the order stable between two renders of the same draft, which matters because
 * the curator's toggles are keyed on what they saw.
 */
function byRecency(a: PressItem, b: PressItem): number {
  const da = a.publishedAt ?? "";
  const db = b.publishedAt ?? "";
  if (da !== db) return db.localeCompare(da);
  return a.headline.localeCompare(b.headline);
}

/**
 * Groups the month's coverage into the section the edition renders.
 *
 * `included` is the curator's selection: NULL means the edition has not been
 * curated yet and everything is in. An empty array is a real selection meaning
 * "nothing" — distinct from NULL, the same absent-versus-empty rule the
 * operational figures follow.
 */
export function selectPress(
  candidates: PressCandidate[],
  included: string[] | null
): PressSelection {
  // --- 1. Theme volume across the whole month, before any dedup ------------
  const volume = new Map<string, number>();
  for (const row of candidates) {
    for (const theme of row.ai_themes ?? []) {
      const name = theme.trim();
      if (!name) continue;
      volume.set(name, (volume.get(name) ?? 0) + 1);
    }
  }

  // --- 2. File each article under its highest-volume theme -----------------
  // Ties break on the theme name so two renders of the same draft agree.
  const filed = new Map<string, PressItem[]>();
  for (const row of candidates) {
    const themes = (row.ai_themes ?? []).map((t) => t.trim()).filter(Boolean);
    const best =
      themes.length === 0
        ? UNTHEMED_GROUP
        : themes.reduce((winner, theme) => {
            const a = volume.get(theme) ?? 0;
            const b = volume.get(winner) ?? 0;
            if (a !== b) return a > b ? theme : winner;
            return theme < winner ? theme : winner;
          });

    const bucket = filed.get(best) ?? [];
    bucket.push(toItem(row, best));
    filed.set(best, bucket);
  }

  // --- 3. Theme order, before selection --------------------------------------
  // Ordered first because the near-duplicate pass below walks the themes in
  // render order: when one story is filed under two themes, the copy that
  // survives should be the one the reader meets first.
  const themeNames = [...filed.keys()].sort((a, b) => {
    if (a === UNTHEMED_GROUP) return 1;
    if (b === UNTHEMED_GROUP) return -1;
    const va = volume.get(a) ?? 0;
    const vb = volume.get(b) ?? 0;
    if (va !== vb) return vb - va;
    return a.localeCompare(b);
  });

  // --- 4. The curator's selection, then duplicates, then the cap -------------
  const keep = included === null ? null : new Set(included);
  const themes: PressTheme[] = [];

  /**
   * Two passes over duplicates, with deliberately different reach.
   *
   * Filing by id is not enough. One story is routinely captured TWICE, because
   * two standing Google Alert queries each returned it; ingestion is right to
   * keep both, since their provenance and mention counts differ. Rendered side
   * by side they read as the desk padding the section.
   *
   * EXACT matches are suppressed across the WHOLE EDITION. Two captures whose
   * headlines are identical after normalisation are the same story by
   * inspection, not by inference, so there is no false-positive risk in
   * comparing them across themes — and cross-theme is exactly where they turn
   * up, because the two captures often carry different ai_themes and are filed
   * apart.
   *
   * FUZZY matches — syndication variants, a " - Publisher" suffix — are
   * suppressed only WITHIN a theme. That is the window lib/analysis/similarity
   * is calibrated for, and its calibration depends on it: token overlap is safe
   * there because two headlines whose one differing word flips the meaning
   * almost never share a theme. Widening the fuzzy pass to the whole edition
   * would catch a little more and start suppressing genuinely different
   * stories, which is the worse error for a section whose job is to be trusted.
   */
  const seenExact = new Set<string>();

  for (const theme of themeNames) {
    const sorted = (filed.get(theme) ?? []).slice().sort(byRecency);
    const kept = keep === null ? sorted : sorted.filter((i) => keep.has(i.id));
    const excluded = keep === null ? [] : sorted.filter((i) => !keep.has(i.id));

    const items: PressItem[] = [];
    const nearDuplicates: PressItem[] = [];
    const heldBack: PressItem[] = [];

    for (const item of kept) {
      const normalized = normalizeHeadline(item.headline);
      const exactRepeat = normalized.length > 0 && seenExact.has(normalized);
      const fuzzyRepeat =
        !exactRepeat &&
        items.some((p) => isNearDuplicateHeadline(p.headline, item.headline));

      if (exactRepeat || fuzzyRepeat) {
        nearDuplicates.push(item);
      } else if (items.length < PRESS_ITEMS_PER_THEME) {
        items.push(item);
        if (normalized) seenExact.add(normalized);
      } else {
        // Past the cap: not rendered, so it does not claim the headline either.
        // If a later theme carries the same story it should still be able to
        // print it.
        heldBack.push(item);
      }
    }

    // A theme with no candidate at all is not carried. One whose candidates
    // were all toggled out or all suppressed IS carried, with an empty `items`
    // — the composer needs it so those rows stay visible and toggleable, and
    // the email skips any theme whose `items` is empty rather than printing a
    // heading over nothing.
    if (
      items.length === 0 &&
      heldBack.length === 0 &&
      nearDuplicates.length === 0 &&
      excluded.length === 0
    ) {
      continue;
    }

    themes.push({
      theme,
      periodCount: volume.get(theme) ?? kept.length + excluded.length,
      items,
      heldBack,
      nearDuplicates,
      excluded,
    });
  }

  const outlets = new Set(
    candidates.map((c) => outletName(c.media)).filter(Boolean)
  );

  return {
    themes,
    shown: themes.reduce((n, t) => n + t.items.length, 0),
    candidates: candidates.length,
    outlets: outlets.size,
  };
}

/**
 * Every candidate grouped for the composer, including the ones the curator has
 * toggled out — the composer must show the whole set with its state, or an
 * exclusion looks identical to an article that was never captured.
 */
export function allCandidatesByTheme(
  candidates: PressCandidate[]
): PressTheme[] {
  return selectPress(candidates, null).themes.map((t) => ({
    ...t,
    // Re-expanded, and back into recency order: selectPress splits the theme
    // into rendered / held back / suppressed, but the composer needs one list
    // to draw a toggle against every candidate. Which bucket each fell into is
    // recomputed for display from the live selection.
    items: [...t.items, ...t.heldBack, ...t.nearDuplicates].sort(byRecency),
    heldBack: [],
    nearDuplicates: [],
  }));
}

/** The ids that would render if nothing were toggled out. The default state. */
export function defaultIncludedIds(candidates: PressCandidate[]): string[] {
  return candidates.map((c) => c.id);
}

/** "September 2026" press-section caption, stated wherever the section renders. */
export function pressCaption(month: Month, selection: PressSelection): string {
  return (
    `${selection.shown} of ${selection.candidates} coded article` +
    `${selection.candidates === 1 ? "" : "s"} published in ${month.label}, ` +
    `grouped by theme. Themes are ordered by how many of the month's articles ` +
    `carry them; stories run newest first within a theme. An article carrying ` +
    `several themes appears once, under its busiest one.`
  );
}
