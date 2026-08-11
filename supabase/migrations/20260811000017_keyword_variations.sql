-- ============================================================================
-- nestle-scm — keywords.variations  [schema-brief table 3]
--
-- Additive. A nullable array of extra surface forms that mean the same thing as
-- `keyword` and should match alongside it. Two things it is deliberately NOT:
--
--   * not a replacement for `notes` — notes stays exactly as imported, it is a
--     note to a human curator and several of its sentences ("Require Gate 1",
--     "promote to alert tier") are not variant lists at all;
--   * not a pattern language. Entries are literal terms. No wildcards, no
--     regex, no admin-supplied quantifiers: keyword rows are admin-editable and
--     a user-supplied nested quantifier is a catastrophic-backtracking (ReDoS)
--     hazard on every article body the matcher touches. Anything expressible as
--     a pattern here is expressible as more literal rows.
--
-- Separator spellings ("container ship" / "container-ship" / "containership")
-- are NOT stored here. The matcher normalises separators itself, so those
-- forms cost nothing and would only be noise in this column.
--
-- RLS unchanged — keywords already has whole-row policies covering it.
-- ============================================================================

alter table public.keywords add column variations text[];

comment on column public.keywords.variations is
  'Extra literal surface forms matched alongside keyword (synonyms, transliterations, US/UK spellings, abbreviations). Literal terms only — never patterns. Separator spellings are handled by the matcher and do not belong here.';

-- ---------------------------------------------------------------------------
-- One-time pre-population from `notes`.
--
-- Most of the imported taxonomy already carries its variant list in prose, in
-- one of two unambiguous shapes:
--
--     "Also void sailing, blanked sailing. ALERT TIER."
--     "Index spelling variants: Bab-el-Mandeb, Bab el Mandab."
--
-- Everything after the first sentence is commentary ("ALERT TIER.",
-- "Panama signal") and is cut, as is any " - " aside. What remains is split on
-- commas. Four items are then discarded:
--
--   * anything containing "/" — "earnings beat/miss", "shares rose/fell",
--     "filter URL paths /jobs/ and /careers/". A slash means either a nested
--     alternation the comma split cannot see, or an instruction rather than a
--     term, and guessing wrong here writes a bad matcher rule;
--   * a bare single word on a NEGATIVE row — "buyback", "upgrade",
--     "downgrade", "ticker". Widening an exclusion term is the one direction
--     that silently *loses* articles, and "upgrade" alone would suppress any
--     story about a terminal upgrade. Those rows keep their notes and can be
--     curated by hand;
--   * a repeat of the keyword itself;
--   * anything shorter than two characters.
--
-- Notes that name a spelling *inside* the phrase rather than a whole
-- alternative ("Index US spelling 'utilization' too.") are not parseable by
-- this rule — the two rows in that shape are set explicitly below.
-- ---------------------------------------------------------------------------

with parsed as (
  select
    k.id,
    k.keyword,
    k.list_type,
    split_part(
      split_part(
        regexp_replace(k.notes, '^(Also|Index spelling variants:)\s*', '', 'i'),
        '.', 1
      ),
      ' - ', 1
    ) as list_body
  from public.keywords k
  where k.notes ~* '^(Also |Index spelling variants:)'
),
items as (
  select
    p.id,
    p.keyword,
    p.list_type,
    btrim(
      regexp_replace(
        regexp_replace(raw_item, '\([^)]*\)', ' ', 'g'),
        '\s+', ' ', 'g'
      )
    ) as item
  from parsed p
  cross join lateral unnest(string_to_array(p.list_body, ',')) as raw_item
),
kept as (
  select id, array_agg(item order by item) as variations
  from items
  where length(item) >= 2
    and position('/' in item) = 0
    and lower(item) <> lower(keyword)
    and (list_type <> 'negative' or position(' ' in item) > 0)
  group by id
)
update public.keywords k
set variations = kept.variations
from kept
where k.id = kept.id;

-- US spellings named as a token inside the phrase, spelled out in full.
update public.keywords set variations = array['yard utilization']
  where keyword = 'yard utilisation' and variations is null;
update public.keywords set variations = array['labor negotiation']
  where keyword = 'labour negotiation' and variations is null;
