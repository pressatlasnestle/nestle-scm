/**
 * Favourability grading checks. LIVE — calls Gemini once per fixture.
 *
 *   npm run check:favourability
 *
 * The fixtures are not invented. Every one is a real article from this corpus
 * that the previous prompt graded WRONG, and they are the whole point of the
 * change — a check built on synthetic examples would have passed against the
 * old prompt too.
 *
 * What went wrong, measured on 161 coded rows:
 *   'Very favourable'   PSA Antwerp adds new STS crane at Noordzee Terminal
 *   'Very favourable'   T-Mining joins DCSA+ to advance standards
 *   'Very favourable'   WaveBL integrates with Evergreen for eBL adoption
 *   'Very unfavourable' MSC fined $6 million over Charleston vessel incident
 *
 * None of those move a Nestlé container, and the last one shared its grade
 * with a typhoon stranding 2.4M TEUs.
 *
 * Bodies are trimmed excerpts of the real rows. They are inlined rather than
 * read from the database so the check pins the PROMPT rather than whatever the
 * corpus happens to contain today — an article being re-ingested, edited or
 * excluded must not silently disable a test.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { codeArticle, loadActiveThemes } from "@/lib/analysis/coding";
import type { SentimentTier } from "@/lib/analysis/coding";

type Fixture = {
  label: string;
  headline: string;
  body: string;
  keywords: string[];
  expectTier: SentimentTier;
  /** Inclusive bounds on relevance. */
  relevance: [number, number];
  why: string;
};

const FIXTURES: Fixture[] = [
  {
    label: "PSA crane (was Very favourable)",
    headline: "PSA Antwerp adds new STS crane at Noordzee Terminal",
    body: "PSA Antwerp has taken delivery of an additional ship-to-shore crane at its Noordzee Terminal, bringing the quay's complement up by one unit. The crane was delivered by barge and will enter service after commissioning.",
    keywords: ["terminal operator", "container shipping"],
    expectTier: "Neutral",
    relevance: [0, 19],
    why: "one crane, in Europe, changing no Nestlé AOA transit time",
  },
  {
    label: "PSA 14th crane (was Very favourable)",
    headline: "PSA Belgium adds 14th STS crane at Noordzee Terminal",
    body: "PSA Belgium has installed its fourteenth ship-to-shore crane at the Noordzee Terminal in Antwerp. The investment is part of a programme to raise quay capacity at the facility over the coming years.",
    keywords: ["terminal operator"],
    expectTier: "Neutral",
    relevance: [0, 19],
    why: "capacity investment years from any operational effect",
  },
  {
    label: "T-Mining standards (was Very favourable)",
    headline: "T-Mining joins DCSA+ to advance Secure Container Release standards",
    body: "T-Mining has joined the DCSA+ programme to help advance industry standards for secure container release. The company said participation would support wider adoption of digital release processes across the container supply chain.",
    keywords: ["container shipping"],
    expectTier: "Neutral",
    relevance: [0, 19],
    why: "an industry standards programme, no lane consequence",
  },
  {
    label: "WaveBL eBL (was Very favourable)",
    headline:
      "WaveBL integrates with Evergreen to expand electronic Bill of Lading adoption",
    body: "WaveBL has completed an integration with Evergreen Line enabling the carrier's customers to issue and transfer electronic bills of lading through the WaveBL platform. The companies said the integration supports wider eBL adoption.",
    keywords: ["bill of lading", "Evergreen"],
    expectTier: "Neutral",
    relevance: [0, 19],
    why: "a documentation product integration",
  },
  {
    label: "MSC $6m fine (was Very unfavourable)",
    headline: "MSC fined $6 million over Charleston vessel incident",
    body: "MSC Shipmanagement has been fined USD 6 million following the runaway movement of the MSC Michigan VII near the Ravenel Bridge at Charleston. The penalty follows a US Coast Guard investigation into the incident.",
    keywords: ["MSC / Mediterranean Shipping Company"],
    expectTier: "Neutral",
    relevance: [0, 19],
    why: "a penalty on a carrier, in a US port, with no AOA lane consequence",
  },
  {
    label: "Typhoon Dolphin (severe, correctly)",
    headline:
      "Typhoon Dolphin Deepens China Port Congestion, Stranding 2.4M TEUs",
    body: "Typhoon Dolphin has forced terminal closures across Shanghai, Ningbo and Shenzhen, with an estimated 2.4 million TEUs of container capacity stranded at anchor or held at berth. Carriers have begun omitting port calls and vessel bunching is expected to persist for several weeks after the ports reopen.",
    keywords: ["port congestion", "TEU", "typhoon / cyclone / hurricane"],
    expectTier: "Very unfavourable",
    relevance: [80, 100],
    why: "millions of TEUs stranded at primary Asian origin ports",
  },
  {
    // REACHABILITY. The full recode produced zero 'Very favourable' rows out of
    // 161, and "no article in this window described an at-scale improvement" is
    // indistinguishable from "the top of the scale is unreachable" unless it is
    // tested. This fixture is the test: a scale with a grade nothing can reach
    // is a four-point scale wearing a five-point label.
    label: "at-scale corridor restoration (proves the top grade is reachable)",
    headline:
      "All major carriers restore Suez routings as Red Sea transits resume at scale",
    body: "Maersk, MSC, CMA CGM, Hapag-Lloyd and Cosco have all restored their Asia-Europe and Asia-Middle East strings to Suez Canal routings, ending the Cape of Good Hope diversion for the great majority of container capacity. Carriers said Asia-Europe transit times fall by 10 to 14 days and that war risk surcharges are being withdrawn across affected trades.",
    keywords: ["Suez Canal", "Red Sea", "Maersk", "MSC / Mediterranean Shipping Company"],
    expectTier: "Very favourable",
    relevance: [70, 100],
    why: "a primary AOA corridor restored across the whole carrier set",
  },
  {
    label: "Gulf of Oman strike (severe, correctly)",
    headline: "US forces strike containership Vela Nova in Gulf of Oman",
    body: "US forces struck the containership Vela Nova in the Gulf of Oman. War risk premiums for the Strait of Hormuz corridor rose sharply following the strike, and several carriers said they were reviewing routings for services transiting the Gulf.",
    keywords: ["Strait of Hormuz", "war risk surcharge", "container shipping"],
    expectTier: "Very unfavourable",
    relevance: [70, 100],
    why: "a container vessel struck in a corridor Nestlé AOA cargo transits",
  },
];

/** The article used twice to prove determinism, chosen for a clear grade. */
const REPRO = FIXTURES[6];

async function main() {
  const client = createAdminClient();
  const themes = await loadActiveThemes(client);
  let failures = 0;

  console.log(`Vocabulary: ${themes.length} active themes\n`);

  for (const f of FIXTURES) {
    const r = await codeArticle(client, f.headline, f.body, f.keywords, themes);
    const tierOk = r.tier === f.expectTier;
    const relOk = r.relevance >= f.relevance[0] && r.relevance <= f.relevance[1];
    const rationaleOk = r.impactRationale.trim().length > 0;
    const ok = tierOk && relOk && rationaleOk;
    if (!ok) failures += 1;

    console.log(
      `${ok ? "PASS" : "FAIL"}  ${f.label}\n` +
        `        → ${r.tier} / relevance ${r.relevance}` +
        (tierOk ? "" : `  [expected ${f.expectTier}]`) +
        (relOk ? "" : `  [expected ${f.relevance[0]}-${f.relevance[1]}]`) +
        `\n        rationale: ${r.impactRationale}`
    );
  }

  // --- Reproducibility ----------------------------------------------------
  //
  // THREE passes, not two, and the reason is worth recording. An earlier
  // version of this check ran two adjacent calls, asserted exact equality on
  // both fields, and passed — while the very same input had scored 5 points
  // differently in the fixture loop moments before. Two adjacent calls agree
  // far more often than three spread apart, so a two-call check reports a
  // stability that is not there.
  //
  // What temperature 0 actually buys: it makes sampling greedy, not the
  // arithmetic deterministic. Batched inference on GPUs reorders floating-point
  // reductions depending on what else is in the batch, so a token near a
  // probability tie can land either way between calls. That is enough to move
  // a free integer like relevance and not enough to move a five-way enum.
  //
  // So the two fields are held to different bars, deliberately:
  //   * TIER must be identical. It is what ranks, filters and charts, and a
  //     grade that moves between passes is the defect this whole change exists
  //     to fix.
  //   * RELEVANCE is allowed a small spread, and the spread is REPORTED rather
  //     than hidden, so drift beyond it shows up as a failure instead of as a
  //     surprise later.
  console.log("");
  const passes = [];
  for (let i = 0; i < 3; i += 1) {
    passes.push(
      await codeArticle(client, REPRO.headline, REPRO.body, REPRO.keywords, themes)
    );
  }

  const tiers = passes.map((p) => p.tier);
  const scores = passes.map((p) => p.relevance);
  const tierStable = new Set(tiers).size === 1;
  if (!tierStable) failures += 1;
  console.log(
    `${tierStable ? "PASS" : "FAIL"}  tier identical across 3 passes → ${tiers.join(", ")}`
  );

  const spread = Math.max(...scores) - Math.min(...scores);
  const spreadOk = spread <= 10;
  if (!spreadOk) failures += 1;
  console.log(
    `${spreadOk ? "PASS" : "FAIL"}  relevance spread ${spread} across 3 passes ` +
      `(${scores.join(", ")}) — tolerance 10`
  );

  // The PRIMARY theme is the assertion. Themes come back most-important-first,
  // and the first one is what anchors an article to a storyline; whether a
  // marginal third theme is also included is a judgement at the boundary of
  // "does this article genuinely span it", and that boundary is exactly where
  // near-tie sampling lands. Requiring all three passes to agree on the full
  // SET would be asserting that no such boundary exists.
  //
  // Every pass is printed, so a set that starts drifting further than its tail
  // is visible rather than averaged away.
  const primaries = passes.map((p) => p.themes[0]);
  const primaryStable = new Set(primaries).size === 1;
  if (!primaryStable) failures += 1;
  console.log(
    `${primaryStable ? "PASS" : "FAIL"}  primary theme identical across 3 passes → ${primaries.join(" | ")}`
  );
  for (const [i, p] of passes.entries()) {
    console.log(`        pass ${i + 1}: ${p.themes.join(", ")}`);
  }

  const total = FIXTURES.length + 3;
  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
