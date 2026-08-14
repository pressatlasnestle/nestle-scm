-- ============================================================================
-- nestle-scm — articles.impact_kind: which limb of the impact test applied
--
-- The favourability engine asks whether an article moves Nestlé's containers.
-- Until now that test had one limb — does it name a lane, port, service or
-- cost — and the answer was enforced by pattern-matching the rationale prose
-- for phrases like "no specific ... lane".
--
-- Measured on 268 rows, that produced:
--   * 199 Neutral (74.3%), 197 of them below relevance 20;
--   * 98 rationales carrying near-verbatim the same sentence, "The article
--     names no specific Nestlé AOA lane, port, service or cost";
--   * a relevance axis perfectly correlated with the tier — nothing Neutral
--     above 39, nothing non-Neutral below 20.
--
-- The rule measured the presence of a PROPER NOUN, not the presence of an
-- impact. Market-wide news names no single lane precisely because it moves all
-- of them, so "rates rally across Asia-Europe" scored 15 while "Antwerp takes
-- delivery of a crane" named two proper nouns.
--
-- The test now has two limbs — specific and market_wide — and this column
-- records which one carried each article. Three reasons it is stored rather
-- than derived:
--
--   1. The forcing rule reads it. 'none' forces Neutral and caps relevance
--      below 20; the other two force nothing. Enforcing on an enum the model
--      committed to beats enforcing on a regex over English, which matched
--      subordinate clauses: "rates are rallying, though no single lane is
--      named" is a correct Unfavourable rationale that the old pattern would
--      have caught and overwritten.
--   2. It is the only way to check that the second limb is being used at all.
--      If market_wide comes back near zero after this change, the corpus is
--      back where it started, and without this column nobody could tell.
--   3. It kills the stock phrase. A classification cannot be reached for the
--      way a sentence can.
--
-- Left null for existing rows rather than backfilled with a guess. Every row
-- is about to be re-coded at coding_version 3, which fills it from the model
-- rather than from an inference about what a previous prompt might have meant.
-- ============================================================================

alter table public.articles
  add column impact_kind text
  check (impact_kind in ('specific', 'market_wide', 'none'));

comment on column public.articles.impact_kind is
  'Which limb of the impact test the article satisfied: specific = names a lane, port, terminal, service, surcharge or cost; market_wide = a movement in rates, capacity, schedule reliability, transit times or routing across trades Nestlé AOA uses; none = neither, which forces Neutral and relevance below 20. null = coded before coding_version 3.';
