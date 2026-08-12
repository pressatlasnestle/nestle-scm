/**
 * Near-duplicate headline checks.
 *
 *   npm run check:similarity
 *
 * Every case below is a real headline from this corpus, not invented. That
 * matters more here than in most checks, because the whole risk is a threshold
 * tuned against imagined data: too low and genuinely different stories about
 * the same carriers get merged, too high and the syndicated repeats this
 * exists to remove survive.
 *
 * The pairs are therefore split into two lists that pull in opposite
 * directions, and the threshold has to satisfy both at once.
 */
import {
  dedupeByHeadline,
  headlineSimilarity,
  headlineTokens,
  MIN_TOKENS_FOR_FUZZY,
  isNearDuplicateHeadline,
  NEAR_DUPLICATE_THRESHOLD,
  normalizeHeadline,
} from "../../src/lib/analysis/similarity";

/** The real pair from week 2026-W33 that started this. */
const CRUNCH = "Container crunch at Singapore and Colombo disrupts Indian export supply chains";

/** Real pair from the same theme, polarity and day — must NOT be merged. */
const SUEZ = "Maersk and Hapag-Lloyd Return More Services to Suez Canal - Jordan News";
const RED_SEA = "Hapag-Lloyd and Maersk Move Another Joint Service to Red Sea - Ship & Bunker";

type Pair = { name: string; a: string; b: string };

const SHOULD_MERGE: Pair[] = [
  {
    name: "the actual bug — byte-identical headlines, different Alert queries",
    a: CRUNCH,
    b: CRUNCH,
  },
  {
    name: "same headline with a publisher suffix appended",
    a: CRUNCH,
    b: `${CRUNCH} - Reuters`,
  },
  {
    name: "same headline with a longer publisher suffix",
    a: CRUNCH,
    b: `${CRUNCH} - Ship & Bunker`,
  },
  {
    name: "casing and punctuation differences only",
    a: "Maersk Reports Operational Disruptions After Colombia Earthquake",
    b: "maersk reports operational disruptions after colombia earthquake.",
  },
  {
    name: "curly vs straight apostrophe",
    a: "Mundra’s Rail-Led Growth Is Just Getting Started",
    b: "Mundra's Rail-Led Growth Is Just Getting Started",
  },
  {
    name: "one reordered word — a near rewrite, not an exact repeat",
    a: "Container crunch at Singapore and Colombo disrupts Indian export supply chains",
    b: "Container crunch at Colombo and Singapore disrupts Indian export supply chains",
  },
  {
    name: "trailing wire tag",
    a: "Panama Canal Authority schedules two more reductions for maximum draft level",
    b: "Panama Canal Authority schedules two more reductions for maximum draft level | Reuters",
  },
];

const SHOULD_KEEP: Pair[] = [
  {
    name: "REAL false-positive risk: same carriers, same theme, same day, different stories",
    a: SUEZ,
    b: RED_SEA,
  },
  {
    name: "same event, genuinely different wording (out of scope by design)",
    a: "China bypasses shipping chokepoints with 'Ice Silk Road' through Arctic",
    b: "China launches Arctic 'Ice Silk Road' container route to dodge Red Sea chokepoint",
  },
  {
    name: "same subject, opposite direction",
    a: "Panama Canal Authority schedules two more reductions for maximum draft level",
    b: "Panama Canal Authority lifts draft restrictions as water levels recover",
  },
  {
    name: "shared carrier name only",
    a: "Maersk reports operational disruptions after Colombia earthquake",
    b: "Maersk and Hapag-Lloyd Return More Services to Suez Canal",
  },
  {
    name: "unrelated stories",
    a: "PSA Belgium adds 14th STS crane at Noordzee Terminal",
    b: "Container crunch at Singapore and Colombo disrupts Indian export supply chains",
  },
  {
    name: "short headlines sharing most words are NOT fuzzily merged",
    a: "Suez Canal traffic rises",
    b: "Suez Canal traffic falls",
  },
];

function main() {
  let failures = 0;
  const check = (ok: boolean, msg: string) => {
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`);
  };

  console.log(`threshold = ${NEAR_DUPLICATE_THRESHOLD}\n`);

  console.log("MUST MERGE (near-duplicates)");
  for (const p of SHOULD_MERGE) {
    const score = headlineSimilarity(p.a, p.b);
    check(
      isNearDuplicateHeadline(p.a, p.b),
      `${p.name} — dice ${score.toFixed(3)}`
    );
  }

  console.log("\nMUST KEEP (genuinely different)");
  for (const p of SHOULD_KEEP) {
    const score = headlineSimilarity(p.a, p.b);
    check(
      !isNearDuplicateHeadline(p.a, p.b),
      `${p.name} — dice ${score.toFixed(3)}`
    );
  }

  // Margin between the two groups, measured only over pairs the THRESHOLD
  // actually decides. Headlines shorter than MIN_TOKENS_FOR_FUZZY are settled
  // by the exact-match rule before the score is consulted, so including their
  // scores here would report a tightness that does not exist in the decision
  // path. A threshold sitting a hundredth above a real pair is tuned to this
  // week's data rather than to the problem.
  const decidedByThreshold = (p: Pair) =>
    headlineTokens(p.a).size >= MIN_TOKENS_FOR_FUZZY &&
    headlineTokens(p.b).size >= MIN_TOKENS_FOR_FUZZY;

  const closestKeep = Math.max(
    ...SHOULD_KEEP.filter(decidedByThreshold).map((p) =>
      headlineSimilarity(p.a, p.b)
    )
  );
  const closestMerge = Math.min(
    ...SHOULD_MERGE.filter(decidedByThreshold).map((p) =>
      headlineSimilarity(p.a, p.b)
    )
  );
  console.log(
    `\n  highest "keep" score  ${closestKeep.toFixed(3)}` +
      `   lowest "merge" score  ${closestMerge.toFixed(3)}`
  );
  const margin = closestMerge - closestKeep;
  check(
    margin > 0.2,
    `the two groups are separated by ${margin.toFixed(3)}, not a hair's breadth`
  );

  // --- Selection behaviour -------------------------------------------------
  console.log("\nSELECTION");

  // The real list, in real rank order, as the PDF rendered it.
  const ranked = [
    { headline: "Maersk reports operational disruptions after Colombia earthquake", mentions: 13 },
    { headline: CRUNCH, mentions: 7 },
    { headline: CRUNCH, mentions: 5 },
    { headline: "MSC’s TIL withdraws request for approval of Tercat takeover", mentions: 4 },
  ];
  const picked = dedupeByHeadline(ranked, (r) => r.headline, 3);

  check(picked.length === 3, `still returns 3 stories, not 2 (got ${picked.length})`);
  check(
    picked.filter((p) => p.headline === CRUNCH).length === 1,
    "the duplicated story appears exactly once"
  );
  check(
    picked[2]?.mentions === 4,
    `the next-ranked story is promoted into the freed slot (got ${picked[2]?.mentions} mentions)`
  );
  check(
    picked[0]?.mentions === 13 && picked[1]?.mentions === 7,
    "ranking order is otherwise untouched, and the higher-ranked copy is the one kept"
  );

  // A list with no duplicates must come back completely unchanged.
  const clean = [
    { headline: SUEZ, mentions: 8 },
    { headline: RED_SEA, mentions: 7 },
    { headline: "China bypasses shipping chokepoints with 'Ice Silk Road' through Arctic", mentions: 12 },
  ];
  const cleanPicked = dedupeByHeadline(clean, (r) => r.headline, 3);
  check(
    cleanPicked.length === 3,
    `a list of genuinely different stories is untouched (got ${cleanPicked.length})`
  );

  // Fewer candidates than the limit must not error or pad.
  const short = dedupeByHeadline([{ headline: CRUNCH, mentions: 7 }], (r) => r.headline, 3);
  check(short.length === 1, `a one-story list stays one story (got ${short.length})`);

  // Every candidate a duplicate → exactly one survives.
  const allSame = dedupeByHeadline(
    [
      { headline: CRUNCH, mentions: 7 },
      { headline: `${CRUNCH} - Reuters`, mentions: 5 },
      { headline: `${CRUNCH} - Ship & Bunker`, mentions: 3 },
    ],
    (r) => r.headline,
    3
  );
  check(allSame.length === 1, `an all-duplicate list collapses to one (got ${allSame.length})`);

  // --- Normalisation -------------------------------------------------------
  console.log("\nNORMALISATION");
  check(
    normalizeHeadline("Mundra’s Rail-Led Growth!") === "mundra s rail led growth",
    `punctuation and case are stripped → "${normalizeHeadline("Mundra’s Rail-Led Growth!")}"`
  );
  check(
    headlineSimilarity("", "") === 0,
    "two empty headlines score 0, so a missing title cannot suppress everything"
  );
  check(
    !isNearDuplicateHeadline("", CRUNCH),
    "an empty headline never near-duplicates a real one"
  );

  const total =
    SHOULD_MERGE.length + SHOULD_KEEP.length + 1 + 6 + 3;
  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
