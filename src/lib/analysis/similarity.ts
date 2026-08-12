/**
 * Near-duplicate headline detection, for story SELECTION only.
 *
 * WHAT THIS IS NOT. It is not a second dedup pipeline. Ingestion dedup
 * (lib/ingestion/dedup.ts) matches an exact fingerprint — normalised headline
 * plus media plus date plus byline — and is correct and well tested for what
 * it is designed to catch. This solves a different, narrower problem that only
 * shows up downstream.
 *
 * THE ACTUAL FAILURE. Two rows in week 2026-W33:
 *
 *   "Container crunch at Singapore and Colombo disrupts Indian export supply chains"
 *     media: Google Alert - "schedule reliability" (...)   7 mentions
 *   "Container crunch at Singapore and Colombo disrupts Indian export supply chains"
 *     media: Google Alert - "port congestion" (...)        5 mentions
 *
 * Byte-identical headlines, same day, same story — captured twice because two
 * different standing Google Alert queries each returned it, and `media` is part
 * of the fingerprint. Ingestion was right to keep both: they are different
 * captures with different provenance and different mention counts. But the
 * "top 3 unfavourable" list rendered the same story twice and pushed a real
 * third story out, which is a presentation problem, so it is fixed at
 * presentation.
 *
 * WHY TOKEN OVERLAP (DICE) RATHER THAN LEVENSHTEIN.
 *
 * The variants this has to catch are syndication artefacts: the same headline
 * with a " - Publisher" suffix appended, or minor punctuation and casing
 * differences. Levenshtein is character-level, so appending " - Ship & Bunker"
 * to a 76-character headline costs 16 edits and drags the ratio down towards
 * the threshold, while a Dice score over tokens barely moves. Dice is also
 * indifferent to word order, which Levenshtein punishes heavily and which
 * genuinely varies between wire rewrites of one story.
 *
 * The classic weakness of token overlap — a single word flipping the meaning,
 * "profit up" against "profit down" — is much reduced here because this only
 * ever compares within ONE (theme, polarity) list. Two headlines with opposite
 * meaning almost always land in different polarity lists and are never
 * compared.
 *
 * SCOPE, STATED PLAINLY. This catches near-exact repeats and syndicated
 * variants. It does NOT cluster paraphrases. Three outlets writing "China
 * bypasses shipping chokepoints with 'Ice Silk Road' through Arctic",
 * "China launches Arctic 'Ice Silk Road' container route to dodge Red Sea
 * chokepoint" and "China Uses Arctic Shipping Route to Avoid Strait of Hormuz
 * via 'Ice Silk Road'" are the same event in three sets of words, and all
 * three survive this filter. Catching those needs semantic comparison, which
 * is a much larger change with a much worse false-positive profile.
 */

/**
 * Lowercase, strip diacritics and punctuation, collapse whitespace.
 *
 * Punctuation goes because it is the single most common difference between two
 * renderings of one headline — curly versus straight quotes, an em dash versus
 * a hyphen, a trailing full stop.
 */
export function normalizeHeadline(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Distinct normalised tokens. A set, not a list: repeats carry no signal. */
export function headlineTokens(value: string): Set<string> {
  const normalized = normalizeHeadline(value);
  return new Set(normalized ? normalized.split(" ") : []);
}

/**
 * Sørensen–Dice coefficient over token sets: 2|A∩B| / (|A|+|B|), in 0..1.
 *
 * Two empty headlines score 0 rather than 1. An absent headline is not
 * evidence of duplication, and scoring it as a perfect match would let one
 * empty title suppress every other.
 */
export function headlineSimilarity(a: string, b: string): number {
  const setA = headlineTokens(a);
  const setB = headlineTokens(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;

  return (2 * shared) / (setA.size + setB.size);
}

/**
 * Default threshold.
 *
 * Calibrated against real headlines from this corpus rather than picked round:
 *
 *   1.00  the two Singapore/Colombo captures — byte-identical           merge
 *   0.92  a headline against itself plus " - Reuters"                   merge
 *   0.88  a headline against itself plus " - Ship & Bunker"             merge
 *   0.40  "Maersk and Hapag-Lloyd Return More Services to Suez Canal
 *          - Jordan News" against "Hapag-Lloyd and Maersk Move Another
 *          Joint Service to Red Sea - Ship & Bunker"                    keep
 *
 * That last pair is the one that matters. Both are in the same theme, the same
 * polarity and the same day, they share carrier names and half their function
 * words, and they are genuinely different stories. 0.82 sits far above it and
 * comfortably below every syndication variant.
 */
export const NEAR_DUPLICATE_THRESHOLD = 0.82;

/**
 * Minimum tokens before the score is trusted.
 *
 * Below this, Dice is too coarse to mean anything, and the coarseness reaches
 * further up than it looks. "Suez Canal traffic rises" against "Suez Canal
 * traffic falls" is four tokens each, shares three, and scores 0.750 — one
 * word carrying the entire meaning of the headline moves the score by a
 * quarter. That is close enough to any workable threshold to be uncomfortable,
 * and it is the exact shape of the false positive this must not produce.
 *
 * Set to 5 for that reason rather than 4: anything shorter has to match
 * exactly after normalisation, where "exactly" is a judgement Dice is not
 * needed for. Real headlines in this corpus run 8-14 tokens, so this rules out
 * almost nothing in practice — it just refuses to guess where guessing is
 * cheap to avoid.
 */
export const MIN_TOKENS_FOR_FUZZY = 5;

export function isNearDuplicateHeadline(
  a: string,
  b: string,
  threshold = NEAR_DUPLICATE_THRESHOLD
): boolean {
  const normA = normalizeHeadline(a);
  const normB = normalizeHeadline(b);
  if (!normA || !normB) return false;
  if (normA === normB) return true;

  const tokensA = headlineTokens(a);
  const tokensB = headlineTokens(b);
  if (
    tokensA.size < MIN_TOKENS_FOR_FUZZY ||
    tokensB.size < MIN_TOKENS_FOR_FUZZY
  ) {
    // Already known unequal, and too short to judge fuzzily.
    return false;
  }

  return headlineSimilarity(a, b) >= threshold;
}

/**
 * Picks up to `limit` items, skipping any whose headline near-duplicates one
 * already picked.
 *
 * Walks the full candidate list rather than the first `limit` of it, so a
 * skipped duplicate is REPLACED by the next-ranked story instead of shrinking
 * the list — the whole point being that the reader still gets three stories.
 *
 * Candidates must arrive already ranked; this preserves their order and only
 * removes.
 */
export function dedupeByHeadline<T>(
  candidates: T[],
  headlineOf: (item: T) => string,
  limit: number,
  threshold = NEAR_DUPLICATE_THRESHOLD
): T[] {
  const picked: T[] = [];

  for (const candidate of candidates) {
    if (picked.length >= limit) break;
    const headline = headlineOf(candidate);
    const duplicate = picked.some((p) =>
      isNearDuplicateHeadline(headlineOf(p), headline, threshold)
    );
    if (!duplicate) picked.push(candidate);
  }

  return picked;
}
