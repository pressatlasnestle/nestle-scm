-- ============================================================================
-- nestle-scm — articles.coding_version: which methodology graded this row
--
-- The favourability methodology changed in 628c50a. 161 articles were recoded
-- under it; 114 have arrived since, and any article the sorting backlog was
-- hiding has never been coded at all. A corpus half on the old scale and half
-- on the new one is worse than either, because the newsletter ranks across all
-- of it — a 'Very unfavourable' from the pre-628c50a arithmetic and one from
-- the anchored scale are not the same claim, and nothing in the data said so.
--
-- coded_status could not say so either. It has two values, 'pending' and
-- 'coded', and 'coded' means only "some version of the engine has been here".
-- That is why the previous recode was not resumable: to find its work it
-- selected coded_status='coded', which is exactly the set it was creating as
-- it went, so a restart re-coded everything it had already done. At ~20s an
-- article across 275 articles, a restart after a failure at article 180 cost
-- an hour of Gemini calls to arrive back where it started.
--
-- A version number makes the target set shrink as the work proceeds:
--
--   coding_version IS NULL OR coding_version < CODING_VERSION
--
-- An article coded under the current methodology drops out of that set the
-- moment its row is written. Kill the recode and restart it, and it resumes at
-- the first article it had not reached — not because it remembered anything,
-- but because the question "what still needs coding" has a truthful answer in
-- the data. No checkpoint file, nothing to keep in sync.
--
-- The 161 rows from 628c50a are set to 1, one below the current CODING_VERSION
-- of 2, so this pass revisits them too. That is deliberate and is the point of
-- the exercise: it puts the whole corpus on one methodology in one pass rather
-- than leaving two cohorts that happen to agree.
-- ============================================================================

alter table public.articles
  add column coding_version int;

comment on column public.articles.coding_version is
  'Which favourability methodology produced this row''s grade. Written by codeArticles() as CODING_VERSION. null = coded before versioning (pre-628c50a arithmetic scale, or the 628c50a recode). A recode targets rows below the current version, which is what makes it resumable — see scripts/recode.ts.';

-- Everything already coded predates the version column by definition. 1 rather
-- than 0 so the value reads as "the first methodology we tracked" rather than
-- as an unset default.
update public.articles
   set coding_version = 1
 where coded_status = 'coded'
   and coding_version is null;

-- Partial, because this is the only shape the recode queries: give me the rows
-- that are behind. Rows already at the current version are not scanned.
create index articles_coding_version_idx
  on public.articles (coding_version)
  where coded_status = 'coded';
