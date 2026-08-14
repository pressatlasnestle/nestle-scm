/**
 * Storyline grouping checks. Pure — no network, no database.
 *
 *   npm run check:coding
 *
 * The favourability checks that used to live here are gone with the function
 * they tested. sentimentTier() computed the grade by adding a headline and a
 * body sentiment, and that arithmetic was itself a cause of the barbell it
 * produced: 'Very unfavourable' needed only (negative, negative), while the
 * moderate tiers were reachable ONLY when headline and body disagreed. The
 * grade now comes from the model against an anchored scale, with a required
 * impact_rationale as the forcing function, so it cannot be checked without
 * calling Gemini — see check:favourability, which does exactly that against
 * real articles from this corpus.
 */
import { groupByTheme, type StorylineArticle } from "@/lib/analysis/storylines";

function article(
  id: string,
  themes: string[],
  mentions: number | null,
  sentiment: string | null = "Neutral",
  published = "2026-08-01"
): StorylineArticle {
  return {
    id,
    headline: `headline ${id}`,
    url: null,
    media: null,
    published_at: published,
    keyword_mention_count: mentions,
    ai_sentiment: sentiment,
    ai_themes: themes,
  };
}

function main() {
  let failures = 0;

  const corpus: StorylineArticle[] = [
    article("a", ["red sea return", "freight rates"], 12, "Unfavourable"),
    article("b", ["red sea return"], 40, "Favourable"),
    article("c", ["red sea return"], 3, "Neutral"),
    article("d", ["freight rates"], 8, "Unfavourable"),
    article("e", ["panama canal draft restrictions"], 99, "Very unfavourable"),
  ];

  const groups = groupByTheme(corpus);

  const biggest = groups[0];
  const biggestOk = biggest.theme === "red sea return" && biggest.articleCount === 3;
  if (!biggestOk) failures += 1;
  console.log(
    `${biggestOk ? "PASS" : "FAIL"}  biggest group first → "${biggest.theme}" (${biggest.articleCount})`
  );

  // Lead is the most-mentioned WITHIN the group, not the most-mentioned
  // overall — article e has 99 mentions but belongs to another storyline.
  const leadOk = biggest.lead.id === "b" && biggest.lead.keyword_mention_count === 40;
  if (!leadOk) failures += 1;
  console.log(
    `${leadOk ? "PASS" : "FAIL"}  lead is highest mention count in group → ${biggest.lead.id}`
  );

  const rates = groups.find((g) => g.theme === "freight rates");
  const multiOk =
    rates?.articleCount === 2 && rates.articles.some((x) => x.id === "a");
  if (!multiOk) failures += 1;
  console.log(
    `${multiOk ? "PASS" : "FAIL"}  multi-theme article joins both groups (freight rates = ${rates?.articleCount})`
  );

  const splitOk =
    biggest.sentimentSplit["Favourable"] === 1 &&
    biggest.sentimentSplit["Unfavourable"] === 1 &&
    biggest.sentimentSplit["Neutral"] === 1;
  if (!splitOk) failures += 1;
  console.log(
    `${splitOk ? "PASS" : "FAIL"}  per-storyline sentiment split → ${JSON.stringify(biggest.sentimentSplit)}`
  );

  const again = groupByTheme([...corpus].reverse());
  const stableOk =
    JSON.stringify(again.map((g) => [g.theme, g.lead.id])) ===
    JSON.stringify(groups.map((g) => [g.theme, g.lead.id]));
  if (!stableOk) failures += 1;
  console.log(
    `${stableOk ? "PASS" : "FAIL"}  grouping is order-independent and stable`
  );

  const tied = groupByTheme([
    article("z", ["tie"], 5, "Neutral", "2026-08-01"),
    article("y", ["tie"], 5, "Neutral", "2026-08-09"),
  ]);
  const tieOk = tied[0].lead.id === "y";
  if (!tieOk) failures += 1;
  console.log(`${tieOk ? "PASS" : "FAIL"}  mention-count tie breaks on recency → ${tied[0].lead.id}`);

  const total = 6;
  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
