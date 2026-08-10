-- ============================================================================
-- nestle-scm — source/keyword taxonomy columns  [schema-brief tables 2 & 3]
--
-- Additive only, no behavior change. All columns nullable, free text, NO CHECK
-- constraints (same reasoning as list_type: new tier/priority/gate/match_type
-- values must not require a migration). These exist purely so the client's
-- taxonomy dataset (74 sources, 161 keywords) can be imported without losing
-- information; no matching logic reads them yet. RLS is unchanged — existing
-- whole-row policies on both tables already cover these columns.
-- ============================================================================

alter table public.sources
  add column tier           text,   -- e.g. 'T1 - Core ocean freight', 'PR wires'
  add column priority       text,   -- handling strategy within a polarity: 'Critical'..'Block'
  add column content_type   text,   -- 'Trade press', 'Newswire', 'Aggregator', 'Equity analysis'
  add column region         text,   -- 'Global', 'India / South Asia', 'Middle East'
  add column handling_notes text;   -- free-text operator notes; informational, not machine-parsed

alter table public.keywords
  add column gate       text,   -- matching-role: 'Gate 1 - Domain anchor (REQUIRED)', 'Gate 2 - Topic', 'Exclusion'
  add column cluster    text,   -- thematic grouping: 'Chokepoints & routing', 'Ports - Asia', ...
  add column match_type text;   -- 'Exact phrase' | 'Stem / partial' | 'Entity'; stored intent, not yet executed
