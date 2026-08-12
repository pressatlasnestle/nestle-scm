/**
 * Coding checks — the 5-point tier mapping and the storyline grouping.
 *
 *   npm run check:coding
 *
 * Both are pure, and both are places where a silent error would be invisible
 * in the output: a wrong tier still looks like a tier, and a fragmented
 * grouping still looks like a grouping.
 *
 * The theme-normalisation checks that used to live here are gone with the
 * function. Migration 0023 replaced free-text themes with a closed vocabulary
 * compiled into the model's response schema, and normalisation became actively
 * harmful — singularising the head noun turned "Port & terminal operations"
 * into "Port & terminal operation", which matches no row in `themes`.
 * Validation is now exact set membership against the active names, and the
 * enum is enforced server-side by the API. See check:themes for that.
 */
import {
  sentimentTier,
  SENTIMENT_TIERS,
  type Sentiment,
} from "@/lib/analysis/coding";
import { groupByTheme, type StorylineArticle } from "@/lib/analysis/storylines";

const SENTIMENTS: Sentiment[] = ["negative", "neutral", "positive"];

type TierCase = { h: Sentiment; b: Sentiment; expect: string };

const TIER_CASES: TierCase[] = [
  { h: "positive", b: "positive", expect: "Very favourable" },
  { h: "positive", b: "neutral", expect: "Favourable" },
  { h: "neutral", b: "positive", expect: "Favourable" },
  { h: "neutral", b: "neutral", expect: "Neutral" },
  // The consequential case: headline and body disagree → Neutral, not
  // whichever side is louder. A mixed article is a mixed article.
  { h: "positive", b: "negative", expect: "Neutral" },
  { h: "negative", b: "positive", expect: "Neutral" },
  { h: "neutral", b: "negative", expect: "Unfavourable" },
  { h: "negative", b: "neutral", expect: "Unfavourable" },
  { h: "negative", b: "negative", expect: "Very unfavourable" },
];

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

  // --- tier mapping -------------------------------------------------------
  for (const c of TIER_CASES) {
    const got = sentimentTier(c.h, c.b);
    const ok = got === c.expect;
    if (!ok) failures += 1;
    console.log(
      `${ok ? "PASS" : "FAIL"}  tier(headline=${c.h}, body=${c.b}) → ${got}` +
        (ok ? "" : ` (expected ${c.expect})`)
    );
  }

  // Every one of the 9 pairs must land on a real tier, and all 5 tiers must be
  // reachable — a mapping that can never produce "Very favourable" would pass
  // the cases above while still being wrong.
  const produced = new Set<string>();
  let allValid = true;
  for (const h of SENTIMENTS) {
    for (const b of SENTIMENTS) {
      const tier = sentimentTier(h, b);
      produced.add(tier);
      if (!(SENTIMENT_TIERS as readonly string[]).includes(tier)) allValid = false;
    }
  }
  const coverageOk = allValid && produced.size === SENTIMENT_TIERS.length;
  if (!coverageOk) failures += 1;
  console.log(
    `${coverageOk ? "PASS" : "FAIL"}  all 9 pairs valid, all 5 tiers reachable (${produced.size}/5)`
  );

  // Symmetry: swapping headline and body must not change the tier, because the
  // two are weighted equally. If this ever fails, the weights drifted.
  let symmetric = true;
  for (const h of SENTIMENTS) {
    for (const b of SENTIMENTS) {
      if (sentimentTier(h, b) !== sentimentTier(b, h)) symmetric = false;
    }
  }
  if (!symmetric) failures += 1;
  console.log(`${symmetric ? "PASS" : "FAIL"}  tier is symmetric in headline/body`);

  // --- storyline grouping -------------------------------------------------
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

  // A multi-theme article appears in every group it belongs to.
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

  // Stability: same input, same order, every time. An unstable lead would make
  // one period render differently on two consecutive loads.
  const again = groupByTheme([...corpus].reverse());
  const stableOk =
    JSON.stringify(again.map((g) => [g.theme, g.lead.id])) ===
    JSON.stringify(groups.map((g) => [g.theme, g.lead.id]));
  if (!stableOk) failures += 1;
  console.log(
    `${stableOk ? "PASS" : "FAIL"}  grouping is order-independent and stable`
  );

  // Ties on mention count break deterministically rather than arbitrarily.
  const tied = groupByTheme([
    article("z", ["tie"], 5, "Neutral", "2026-08-01"),
    article("y", ["tie"], 5, "Neutral", "2026-08-09"),
  ]);
  const tieOk = tied[0].lead.id === "y";
  if (!tieOk) failures += 1;
  console.log(`${tieOk ? "PASS" : "FAIL"}  mention-count tie breaks on recency → ${tied[0].lead.id}`);

  const total =
    TIER_CASES.length + 9;
  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
