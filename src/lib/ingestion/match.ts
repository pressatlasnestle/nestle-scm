import type { IngestionClient, KeywordRow } from "./types";

/**
 * Phase 3 — two-gate matching + exclusion suppression.
 *
 * This is a PRAGMATIC v1, not NLP. It does substring and word-boundary regex
 * matching over headline + body. It has no lemmatiser, no POS tagging and no
 * sense disambiguation, so "Stem / partial" in particular is an approximation
 * (see compileVariant) that should be re-tuned once real captured articles are
 * available to grade it against. Don't read more into it than that.
 */

export const GATE_1 = "Gate 1 - Domain anchor (REQUIRED)";
export const GATE_2 = "Gate 2 - Topic";
export const GATE_EXCLUSION = "Exclusion";

// ---------------------------------------------------------------------------
// Term compilation
// ---------------------------------------------------------------------------

/**
 * Several imported keywords pack alternatives into one row —
 * "MSC / Mediterranean Shipping Company", "FCL / LCL" (whose own note says
 * "Index both variants separately"), "Rotterdam / Antwerp-Bruges / Hamburg".
 * Matched literally, none of those strings would ever appear in an article, so
 * a slash-separated keyword is split into alternatives and matches if ANY of
 * them hits. The stored keyword text is unchanged — matched_keywords records
 * the whole row's text, which is what the admin panel shows.
 */
function splitVariants(keyword: string): string[] {
  return keyword
    .split("/")
    .map((part) => stripParenthetical(part))
    .filter((part): part is string => part !== null && part.length > 1);
}

/**
 * Parenthetical text in the taxonomy is a note to the human curator, not part
 * of the term: "Gemini (Google AI model)", "ONE (as standalone word)",
 * "Maersk Training (non-liner units)". Matched literally, none of those would
 * ever hit, so the parenthetical is stripped.
 *
 * Except when the parenthetical is the only thing narrowing a generic word to
 * one sense. "shipping (fandom)" and "containerisation (software)" strip down
 * to "shipping" and "containerisation" — bare, common maritime words that as
 * exclusion terms would fire on almost every genuine article. That sense
 * distinction cannot be made lexically at all, so the variant is dropped
 * rather than approximated. Returning null drops it.
 *
 * The test is: did a parenthetical qualify a single all-lowercase word? That
 * keeps "ONE (as standalone word)" (acronym), "Gemini (Google AI model)"
 * (proper noun) and every multi-word term such as "shipping cost (e-commerce)",
 * and drops only the two that are genuinely unmatchable.
 */
function stripParenthetical(part: string): string | null {
  const hadParenthetical = /\([^)]*\)/.test(part);
  const stripped = part.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();

  if (hadParenthetical && /^[a-z]+$/.test(stripped)) return null;
  return stripped;
}

/**
 * Case-sensitivity. The brief derives this from `notes ILIKE '%case-sensitive%'`
 * to cover TEU/FEU/GRI/OTP/PSS/BAF. Applied literally to the imported data that
 * misfires: "general rate increase" and "on-time performance" carry notes
 * reading "Also GRI (case-sensitive)" / "Also OTP (case-sensitive)" — the note
 * is about the abbreviation, not the phrase, and forcing the phrase
 * case-sensitive would make a headline "General Rate Increase Announced" fail
 * to match.
 *
 * So the operative rule is the shape of the term itself: an all-caps token of
 * two or more characters is matched case-sensitively and anchored on word
 * boundaries. That agrees with the notes exactly where the notes are right
 * (TEU, FEU — and GRI/OTP/PSS/BAF the moment they get their own rows), and it
 * additionally protects bare acronyms whose notes say nothing, most importantly
 * the exclusion term "ONE": case-insensitive, it would match the word "one" in
 * nearly every article and suppress the corpus.
 */
function isAcronym(variant: string): boolean {
  return /^[A-Z0-9][A-Z0-9&.-]*$/.test(variant) && /[A-Z]{2,}/.test(variant);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Separator normalisation. A multi-word term reaches print with a space, a
 * hyphen or nothing at all, and the three are the same term: "container ship"
 * / "container-ship" / "containership", "Hapag-Lloyd" / "Hapag Lloyd",
 * "front-loading" / "frontloading", "Bab al-Mandeb" / "Bab al Mandeb". So
 * every separator position in a compiled term accepts any run of spaces and
 * hyphens, including none.
 *
 * This is pure normalisation and needs no admin input — it is the reason the
 * `variations` column does not have to carry the trivial re-spellings, only
 * genuinely different words ("void sailing" for "blank sailing").
 *
 * `[\s-]*` is a flat character class with a single quantifier and no nesting,
 * so it adds no backtracking risk. That matters: the same reasoning is why
 * admin-supplied wildcards stayed out of `variations`.
 */
function joinWithSeparatorVariants(variant: string): string {
  return variant
    .split(/[\s-]+/)
    .filter(Boolean)
    .map(escapeRegex)
    .join("[\\s-]*");
}

/**
 * Builds the matcher for one variant.
 *
 * - Acronym            → case-sensitive, word-bounded, optional plural "s"
 *                        (so TEU matches "TEUs" but not "PHONE" or "Teuton").
 * - Exact phrase/Entity→ case-insensitive whole-phrase substring match, with
 *                        separators allowed to vary (see
 *                        joinWithSeparatorVariants).
 * - Stem / partial     → word-bounded root plus the common inflections
 *                        s/es/ing/ed. Crude by design: "blank sailing" also
 *                        catches "blank sailings", but nothing here knows that
 *                        "blanked sailing" is the same concept unless the root
 *                        happens to cover it.
 */
function compileVariant(variant: string, matchType: string | null): RegExp {
  const escaped = joinWithSeparatorVariants(variant);

  if (isAcronym(variant)) {
    return new RegExp(`\\b${escaped}s?\\b`, "g");
  }

  if ((matchType ?? "").toLowerCase().startsWith("stem")) {
    // Inflect the final word only; "grounding" -> grounding|groundings|...
    return new RegExp(`\\b${escaped}(?:s|es|ing|ed)?\\b`, "gi");
  }

  return new RegExp(escaped, "gi");
}

export type CompiledKeyword = {
  /** The stored keyword text, recorded verbatim in matched_keywords. */
  keyword: string;
  gate: string | null;
  listType: string;
  patterns: RegExp[];
};

/**
 * `variations` holds extra surface forms that mean the same thing as the
 * keyword but are not derivable from it — synonyms ("void sailing" for "blank
 * sailing"), abbreviations ("GRI"), transliterations ("Bab-el-Mandeb"), US
 * spellings ("labor negotiation"). They are compiled exactly like the keyword's
 * own variants and are equally sufficient to match; the row still reports its
 * `keyword` text in matched_keywords, so nothing downstream has to learn about
 * them.
 *
 * They go through splitVariants too, so a slash inside a variation splits the
 * same way it does in the keyword itself.
 */
export function compileKeyword(row: KeywordRow): CompiledKeyword | null {
  const variants = [
    ...splitVariants(row.keyword),
    ...(row.variations ?? []).flatMap(splitVariants),
  ];
  if (variants.length === 0) return null;
  return {
    keyword: row.keyword,
    gate: row.gate,
    listType: row.list_type,
    patterns: variants.map((v) => compileVariant(v, row.match_type)),
  };
}

function hits(compiled: CompiledKeyword, text: string): boolean {
  return compiled.patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

// ---------------------------------------------------------------------------
// Keyword set
// ---------------------------------------------------------------------------

export type KeywordSet = {
  gate1: CompiledKeyword[];
  gate2: CompiledKeyword[];
  exclusions: CompiledKeyword[];
};

/**
 * Loads the active keyword rows once per run. Gates are read off
 * `keywords.gate`; capture is driven only by list_type='positive' rows, and
 * exclusions only by rows that are negative or explicitly gated 'Exclusion'.
 */
export async function loadKeywords(
  client: IngestionClient
): Promise<KeywordSet> {
  const { data, error } = await client
    .from("keywords")
    .select("*")
    .eq("is_active", true);

  if (error) throw new Error(`Failed to load keywords: ${error.message}`);
  return buildKeywordSet(data ?? []);
}

/** Split out from loadKeywords so the matcher can be exercised without a DB. */
export function buildKeywordSet(rows: KeywordRow[]): KeywordSet {
  const set: KeywordSet = { gate1: [], gate2: [], exclusions: [] };

  for (const row of rows) {
    const compiled = compileKeyword(row);
    if (!compiled) continue;

    const isNegative =
      row.list_type === "negative" || row.gate === GATE_EXCLUSION;

    if (isNegative) {
      set.exclusions.push(compiled);
      continue;
    }
    if (row.gate === GATE_1) set.gate1.push(compiled);
    else if (row.gate === GATE_2) set.gate2.push(compiled);
    // Positive keywords with no gate set match nothing on their own — the
    // two-gate rule is defined in terms of gates, and inventing a default
    // would silently widen capture.
  }

  return set;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export type MatchDecision =
  | {
      captured: true;
      matchedKeywords: string[];
      matchedNegativeKeywords: string[];
    }
  | { captured: false; reason: "failed_gate" | "suppressed_exclusion" };

export type MatchInput = {
  headline: string;
  body: string;
};

/**
 * Decides whether an article is captured.
 *
 * 1. Both gates, over headline + body: at least one Gate 1 domain anchor AND
 *    at least one Gate 2 topic. Failing either means the article is not
 *    captured at all — no row, no per-article log line.
 * 2. Exclusion check, only for articles that already passed step 1.
 *    - no exclusion hit                     → capture
 *    - exclusion hit, Gate 1 anchor present
 *      in the HEADLINE specifically         → capture anyway, and record the
 *                                             negative matches so a curator can
 *                                             see why a borderline story stayed
 *    - exclusion hit, no headline anchor    → suppress; the run's
 *                                             articles_suppressed_exclusion is
 *                                             incremented and nothing is stored
 *
 * No per-carrier special-casing (Maersk/MSC/Evergreen/ONE/Gemini): every
 * co-occurrence warning in the source data reduces to "require a Gate 1
 * anchor", which every capture already satisfies by construction.
 */
export function matchArticle(
  input: MatchInput,
  keywords: KeywordSet
): MatchDecision {
  const headline = input.headline ?? "";
  const text = `${headline}\n${input.body ?? ""}`;

  const gate1Hits = keywords.gate1.filter((k) => hits(k, text));
  if (gate1Hits.length === 0) return { captured: false, reason: "failed_gate" };

  const gate2Hits = keywords.gate2.filter((k) => hits(k, text));
  if (gate2Hits.length === 0) return { captured: false, reason: "failed_gate" };

  const matchedKeywords = [
    ...gate1Hits.map((k) => k.keyword),
    ...gate2Hits.map((k) => k.keyword),
  ];

  const exclusionHits = keywords.exclusions.filter((k) => hits(k, text));
  if (exclusionHits.length === 0) {
    return { captured: true, matchedKeywords, matchedNegativeKeywords: [] };
  }

  const anchoredInHeadline = keywords.gate1.some((k) => hits(k, headline));
  if (!anchoredInHeadline) {
    return { captured: false, reason: "suppressed_exclusion" };
  }

  return {
    captured: true,
    matchedKeywords,
    matchedNegativeKeywords: exclusionHits.map((k) => k.keyword),
  };
}
