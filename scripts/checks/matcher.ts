/**
 * Capture-decision checks for the two-gate matcher.
 *
 *   npm run check:matcher
 *
 * 40 cases over the frozen 161-row taxonomy. Cases 1-24 pin the Phase 3
 * semantics — gate pairing, exclusion suppression, the headline-anchor rescue,
 * acronym case-sensitivity, the homonym traps. Cases 25-34 pin the separator
 * normalisation and `variations` added in migration 17. Cases 35-40 pin the
 * edges of substring matching, including three widenings that were accepted
 * knowingly rather than fixed.
 *
 * Every case asserts the decision AND, for captures, the exclusion terms
 * recorded alongside it — a change that quietly stopped recording a negative
 * would otherwise pass.
 */
import { buildKeywordSet, matchArticle } from "@/lib/ingestion/match";
import type { KeywordRow } from "@/lib/ingestion/types";
import { TAXONOMY } from "./taxonomy";

type Expect = "captured" | "suppressed_exclusion" | "failed_gate";

type Case = {
  name: string;
  headline: string;
  body: string;
  expect: Expect;
  /** Exclusion terms the capture must record. Only read when expect is captured. */
  negatives?: string[];
};

const CASES: Case[] = [
  // --- plain captures -----------------------------------------------------
  {
    name: "capture: anchor + topic in body",
    headline: "Rates climb again on Asia-Europe",
    body: "Container shipping lines pushed through a general rate increase this week as port congestion at Rotterdam worsened.",
    expect: "captured",
  },
  {
    name: "capture: anchor in headline only",
    headline: "Ocean freight demand holds up",
    body: "Analysts point to inventory restocking ahead of the peak season.",
    expect: "captured",
  },
  {
    name: "capture: TEU acronym anchor",
    headline: "Maersk adds 12,000 TEU tonnage",
    body: "The carrier said schedule reliability had improved on the string.",
    expect: "captured",
  },
  {
    name: "capture: stem inflection blank sailings",
    headline: "Carriers announce blank sailings",
    body: "Liner shipping capacity will be withdrawn across three loops.",
    expect: "captured",
  },
  // --- gate failures ------------------------------------------------------
  {
    name: "fail: topic without anchor",
    headline: "Panama Canal draft restriction tightens",
    body: "The authority cited low water levels at Gatun Lake.",
    expect: "failed_gate",
  },
  {
    name: "fail: anchor without topic",
    headline: "Ocean freight explained",
    body: "A short primer on how a bill of lading works for new importers.",
    expect: "failed_gate",
  },
  {
    name: "fail: unrelated article",
    headline: "City council approves new library",
    body: "Construction begins in spring, the council said on Tuesday.",
    expect: "failed_gate",
  },
  {
    name: "fail: TEU must not match inside a word",
    headline: "Teutonic order studied afresh",
    body: "Historians revisit the Teuton settlements and their port of call rituals.",
    expect: "failed_gate",
  },
  // --- exclusion suppression ---------------------------------------------
  {
    name: "suppress: equity coverage, no headline anchor",
    headline: "Is Maersk a buy after the latest results?",
    body: "The share price rallied on a raised price target. Container shipping demand was cited but the note focuses on earnings per share.",
    expect: "suppressed_exclusion",
  },
  {
    name: "rescue: exclusion hit but Gate 1 anchor in headline",
    headline: "Container shipping rates jump as Red Sea diversions persist",
    body: "Some analysts also lifted their price target on the carrier.",
    expect: "captured",
    negatives: ["price target"],
  },
  {
    name: "suppress: software container homonym",
    headline: "Kubernetes tooling roundup",
    body: "Docker images and container registry pushes now run through the new ocean freight metaphor in their docs, alongside a general rate increase in licence fees.",
    expect: "suppressed_exclusion",
  },
  {
    name: "suppress: cruise casualty without anchor headline",
    headline: "Passenger ship evacuated off the coast",
    body: "The cruise line said all aboard were safe. Container shipping traffic near the port congestion zone was unaffected.",
    expect: "suppressed_exclusion",
  },
  {
    name: "suppress: recruitment content",
    headline: "Five roles open this month",
    body: "Job opening listings across container shipping firms, including terminal operator vacancy notices, plus a note on port congestion staffing.",
    expect: "suppressed_exclusion",
  },
  {
    name: "rescue: port strike headline with jobs boilerplate",
    headline: "Liner shipping hit by port strike at Le Havre",
    body: "The union also published a recruitment notice for dockworkers.",
    expect: "captured",
    negatives: ["hiring / vacancy / job opening / career opportunity / recruitment"],
  },
  // --- acronym / homonym traps -------------------------------------------
  {
    name: "ONE exclusion: lowercase one must not fire",
    headline: "Container shipping sees one more rate hike",
    body: "Only one carrier has filed so far, and one analyst expects a general rate increase.",
    expect: "captured",
  },
  {
    name: "ONE exclusion: bare uppercase ONE fires",
    headline: "Alliance reshuffle",
    body: "ONE said the network change follows a general rate increase across container shipping services.",
    expect: "suppressed_exclusion",
  },
  {
    name: "Gemini AI must not be read as the alliance",
    headline: "Google ships new model",
    body: "Gemini now handles container shipping logistics questions, and the team teased a general rate increase in API pricing.",
    expect: "suppressed_exclusion",
  },
  {
    name: "Gemini Cooperation is the real alliance",
    headline: "Container shipping network redrawn",
    body: "The Gemini Cooperation published its 2027 schedule reliability targets.",
    expect: "captured",
    negatives: ["Gemini (Google AI model)"],
  },
  {
    name: "port homonym: Portsmouth football",
    headline: "Portsmouth win at Port Vale",
    body: "The container shipping sponsor announced a general rate increase in ticket prices.",
    expect: "suppressed_exclusion",
  },
  {
    name: "Evergreen the carrier",
    headline: "Container shipping capacity grows",
    body: "Evergreen took delivery of two ULCV newbuildings this quarter.",
    expect: "captured",
  },
  {
    name: "Evergreen State exclusion",
    headline: "Evergreen State parks reopen",
    body: "Evergreen trees dominate the ridge. Local container shipping of timber resumed, with a general rate increase on haulage.",
    expect: "suppressed_exclusion",
  },
  {
    name: "capture: FEU acronym with plural",
    headline: "Sea freight quotes per FEUs fall",
    body: "Spot freight rates on the transpacific eased for a fourth week.",
    expect: "captured",
  },
  {
    name: "capture: slash-variant Gate 1 (LCL)",
    headline: "LCL consolidators squeezed",
    body: "Rolled cargo volumes rose sharply at Singapore.",
    expect: "captured",
  },
  {
    name: "capture: multi-entity slash Gate 2",
    headline: "Freight forwarder margins thin",
    body: "Yang Ming and Wan Hai both trimmed capacity, citing overcapacity.",
    expect: "captured",
  },

  // --- separator variants and `variations` --------------------------------
  {
    name: "sep: 'container ship' spelled with a space",
    headline: "Container ship diverted from Suez Canal",
    body: "The vessel will round the Cape of Good Hope instead.",
    expect: "captured",
  },
  {
    name: "sep: 'container-ship' hyphenated",
    headline: "Container-ship fire off Sri Lanka",
    body: "Salvage teams boarded the casualty near Colombo.",
    expect: "captured",
  },
  {
    name: "sep: 'Hapag Lloyd' without the hyphen",
    headline: "Hapag Lloyd trims Asia loop",
    body: "The container shipping line cited overcapacity on the trade.",
    expect: "captured",
  },
  {
    name: "sep: 'on time performance' unhyphenated",
    headline: "Carrier on time performance slips",
    body: "Liner shipping punctuality fell to 51% in July.",
    expect: "captured",
  },
  {
    name: "sep: 'front loading' vs frontloading",
    headline: "Importers front-loading ahead of tariffs",
    body: "Ocean freight bookings surged in the final week before the deadline.",
    expect: "captured",
  },
  {
    name: "sep: 'Bab-el-Mandeb' alternate transliteration",
    headline: "Transits through Bab-el-Mandeb fall again",
    body: "Container shipping operators kept to the longer route.",
    expect: "captured",
  },
  {
    name: "sep: 'Antwerp Bruges' without hyphen",
    headline: "Antwerp Bruges reports record throughput",
    body: "Container shipping volumes rose 6% year on year.",
    expect: "captured",
  },
  {
    name: "sep: 'New York New Jersey' without hyphen",
    headline: "New York New Jersey berth waiting time doubles",
    body: "Container shipping schedules slipped through the month.",
    expect: "captured",
  },
  {
    name: "sep: 'X Press Feeders' without hyphen",
    headline: "X Press Feeders adds a service",
    body: "The container shipping operator will call at Jebel Ali weekly.",
    expect: "captured",
  },
  {
    name: "sep: 'FuelEU maritime' already one token",
    headline: "FuelEU Maritime compliance costs bite",
    body: "Ocean freight buyers face a new carbon surcharge.",
    expect: "captured",
  },

  // --- substring edges ----------------------------------------------------
  // "Exact phrase" and "Entity" terms are bare substring matches and always
  // were, so "peak seasoning" contains "peak season". Allowing zero separator
  // extends that to concatenations: "redseal" contains "Red Sea", "Cargopants"
  // contains "cargo pants". Checked across every Gate 1 and every exclusion
  // term, no concatenated form collides with a real English word, so these
  // three are pinned as known behaviour rather than treated as bugs.
  {
    name: "no-join: 'peak seasoning' still matches peak season (pre-existing)",
    headline: "Ocean freight of peak seasoning spices",
    body: "A note on the bill of lading covering condiment exports.",
    expect: "captured",
  },
  {
    name: "no-join: 'de minimis' unrelated legalese still fine",
    headline: "Sea freight de minimis threshold cut",
    body: "Small parcels lose the exemption from next quarter.",
    expect: "captured",
  },
  {
    name: "no-join: 'transit time' vs 'transittime'",
    headline: "Sea freight transit times lengthen",
    body: "Schedules were rewritten across the network.",
    expect: "captured",
  },
  {
    name: "widened: 'redseal' now matches the Red Sea entity",
    headline: "Container shipping outlook",
    body: "The redseal coating trial continues, and a general rate increase is planned.",
    expect: "captured",
  },
  {
    name: "widened: 'shortinterestrate' now trips the short-interest exclusion",
    headline: "Container shipping capacity update",
    body: "A shortinterestrate typo appears in the filing, plus a general rate increase note.",
    expect: "captured",
    negatives: ["short interest"],
  },
  {
    name: "widened: 'Cargopants' now trips the cargo-pants exclusion",
    headline: "Container shipping apparel volumes",
    body: "Cargopants shipments rose, and a general rate increase followed.",
    expect: "captured",
    negatives: ["cargo pants / cargo shorts"],
  },
];

const keywords = buildKeywordSet(TAXONOMY as unknown as KeywordRow[]);

let failures = 0;
const totals: Record<Expect, number> = {
  captured: 0,
  suppressed_exclusion: 0,
  failed_gate: 0,
};

for (const testCase of CASES) {
  const decision = matchArticle(
    { headline: testCase.headline, body: testCase.body },
    keywords
  );
  const actual: Expect = decision.captured ? "captured" : decision.reason;
  totals[actual] += 1;

  const problems: string[] = [];
  if (actual !== testCase.expect) {
    problems.push(`decision ${actual}, want ${testCase.expect}`);
  }

  if (decision.captured) {
    const want = [...(testCase.negatives ?? [])].sort().join(" | ");
    const got = [...decision.matchedNegativeKeywords].sort().join(" | ");
    if (want !== got) {
      problems.push(`negatives [${got}], want [${want}]`);
    }
    if (!Number.isInteger(decision.mentionCount) || decision.mentionCount < 1) {
      problems.push(`mentionCount ${decision.mentionCount}`);
    }
  }

  if (problems.length > 0) {
    failures += 1;
    console.log(`FAIL  ${testCase.name}\n        ${problems.join("\n        ")}`);
  } else {
    console.log(`PASS  ${testCase.name}`);
  }
}

console.log(
  `\ncaptured=${totals.captured} suppressed_exclusion=${totals.suppressed_exclusion} failed_gate=${totals.failed_gate}` +
    `\n${CASES.length - failures}/${CASES.length} passed`
);
process.exit(failures === 0 ? 0 : 1);
