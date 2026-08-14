-- ============================================================================
-- nestle-scm — the newsletter is WEEKLY, not monthly
--
-- Migration 0028 keyed newsletter_editions on month_of. That was wrong. The
-- product is a Monday digest covering Monday to Sunday inclusive, and the
-- weekly digest preview that used to sit at /newsletter had the cadence right
-- all along. The monthly framing came from the originating email chain, which
-- described the PREDECESSOR series rather than this one.
--
-- Verified empty first: select count(*) from newsletter_editions returned 0.
-- Doing this over live rows would be a different job with a data migration
-- attached — a `sent` snapshot is frozen and carries a month's figures inside
-- it, so reinterpreting one as a week is not a rename, it is a rewrite of a
-- record that is meant never to change.
--
-- WHAT DOES NOT CHANGE, and deliberately so. Everything else 0028 established
-- stands: the authored/generated separation, the freeze trigger, the
-- stock-not-flow delta rule, the RLS policies. This changes the window and the
-- labels, not the architecture.
--
-- week_of holds the ISO MONDAY of the week, matching reports.week_of and
-- lib/analysis/week-period.ts exactly, so "week of 10 Aug" means one thing
-- across the whole application.
--
-- The unique constraint is renamed with the column rather than dropped and
-- recreated. It stays a plain UNIQUE and never becomes a partial index:
-- PostgREST's upsert needs an arbiter it can name in ON CONFLICT, which is
-- migration 0024's lesson and the reason 0028 wrote it this way.
-- ============================================================================

alter table public.newsletter_editions rename column month_of to week_of;

alter table public.newsletter_editions
  rename constraint newsletter_editions_month_of_key
  to newsletter_editions_week_of_key;

comment on table public.newsletter_editions is
  'One row per weekly Ocean Freight Update edition, Monday to Sunday inclusive. Holds ONLY the authored halves — every figure, table and press item is generated at view time from articles and the operational_* tables. A row with status=''sent'' is frozen by a trigger and renders from `snapshot` alone.';

comment on column public.newsletter_editions.week_of is
  'The ISO Monday of the week the edition covers, matching reports.week_of and lib/analysis/week-period.ts. One row per week, so "the week of 10 Aug edition" is a single well-defined thing the composer can upsert on. The week runs to the Sunday INCLUSIVE: an article dated the Sunday belongs to this edition, one dated the Monday belongs to the next.';

comment on column public.newsletter_editions.snapshot is
  'NULL while the edition is a draft. Written once, at send, with every generated value the edition rendered from. A sent edition reads from here and never recomputes. Schedule reliability inside it is still MONTHLY — Sea-Intelligence publishes it monthly and in arrears — so several consecutive weekly snapshots legitimately carry the same reliability figure and the same GLP issue number.';

-- ---------------------------------------------------------------------------
-- The freeze, unchanged in behaviour, corrected in wording.
--
-- The message named the period as a month ("Edition Nov 2099 was sent"). A
-- curator reading that against a weekly edition would reasonably conclude they
-- were looking at the wrong row. Everything else about the trigger — refusing
-- every UPDATE to a sent edition, refusing DELETE except to the service role,
-- raising 42501 so the app surfaces it as a refusal — is as 0028 left it and is
-- correct.
-- ---------------------------------------------------------------------------
create or replace function public.newsletter_edition_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'sent' then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' and current_user in ('service_role', 'postgres', 'supabase_admin') then
    return old;
  end if;

  raise exception
    'The edition for the week of % was sent on % and is frozen. A sent edition is the record of what the client received; issue a new edition instead.',
    to_char(old.week_of, 'DD Mon YYYY'), coalesce(to_char(old.sent_at, 'YYYY-MM-DD'), 'an earlier date')
    using errcode = '42501';
end;
$$;

comment on function public.newsletter_edition_frozen() is
  'Refuses any UPDATE to a sent edition, and any DELETE of one except by the service role. Raises 42501 so the app surfaces it as a permission refusal rather than a generic failure.';

revoke all on function public.newsletter_edition_frozen() from public, anon, authenticated;

-- The trigger itself is unchanged — CREATE OR REPLACE FUNCTION rebinds it in
-- place, so it is deliberately not dropped and recreated.

-- ---------------------------------------------------------------------------
-- `reports` IS DELIBERATELY LEFT ALONE.
--
-- It was worth checking, because 0028 removed the digest renderers on the
-- basis that no reports row had ever been generated, and the table now holds
-- one. It does — and the row is not a digest. Its digest columns
-- (html_content, stats_snapshot, generated_at, article_count, recipient_count)
-- are all still null. What is populated is analysis_narrative, written by the
-- Analysis panel's Regenerate action and by scripts/narrative.ts, and READ on
-- every render of /analysis.
--
-- So reports is a live, read table serving the weekly narrative, not a
-- pipeline feeding a void. Dropping it would break /analysis. Its digest
-- columns are genuinely unused, but removing them is a separate decision with
-- its own migration, not a side effect of renaming a column on another table.
-- ---------------------------------------------------------------------------
