-- ============================================================================
-- nestle-scm — sorting gets its own schedule, and stale runs get closed
--
-- Stage 1 sorting used to run at the tail of the ingestion job, inside the
-- same serverless invocation, handed to next/server's after(). after() defers
-- past the RESPONSE but not past maxDuration, so the sort inherited whatever
-- was left of the run's 60 seconds — and as the source list grew, that was
-- nothing. Measured on this database:
--
--   run                  fetch   new   sorted   left pending
--   12 Aug 11:22 sched    53s     44       16             28
--   13 Aug 00:00 sched    52s     16       12              4
--   13 Aug 12:00 sched  KILLED    29        0             29
--   14 Aug 00:00 sched  KILLED    33        0             33
--   14 Aug 12:00 sched    57s     31        0             31
--
-- Note the last row: that run SUCCEEDED. It closed cleanly, reported
-- partial_failure for source health, and still sorted none of its articles.
-- No concurrency number fixes that, because the problem is not how fast the
-- fetch is — it is that the fetch and the sort are spending the same budget.
--
-- So sorting moves out. It gets its own route and its own schedule, and it
-- selects by ai_sorting_status = 'pending' rather than by the ids a particular
-- run inserted. A pass keyed on "what this run inserted" leaves a permanent
-- hole whenever a pass is missed; a pass keyed on "everything outstanding"
-- cannot, because the next pass is defined by what is left rather than by what
-- happened earlier.
--
-- Hourly, not 12-hourly. Sorting is cheap (one flash-lite call per article,
-- ~0.4s at concurrency 4), the route stops itself at 45s and leaves the rest
-- pending, so a large backlog simply takes several passes. The cadence sets
-- how quickly new articles become codable, and an hour is well inside the
-- weekly newsletter cycle it feeds.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- trigger_sorting — the sorting schedule's only entry point
-- ---------------------------------------------------------------------------
-- Deliberately a near-copy of trigger_ingestion() rather than a generalisation
-- of it. The two differ only in path, and a shared helper taking a path would
-- turn "which endpoints may cron call with the shared secret" from a fact you
-- can read here into a value passed in from elsewhere. Two short functions
-- keep the answer enumerable.
create or replace function public.trigger_sorting()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  v_base_url text;
  v_secret   text;
begin
  select trim(both '"' from value::text)
    into v_base_url
    from public.app_settings
   where key = 'app_base_url';

  select decrypted_secret
    into v_secret
    from vault.decrypted_secrets
   where name = 'ingestion_cron_secret';

  if v_base_url is null or v_base_url = '' or v_secret is null then
    raise notice
      'trigger_sorting(): skipped — app_base_url and/or ingestion_cron_secret not configured.';
    return;
  end if;

  perform extensions.net.http_post(
    url     := rtrim(v_base_url, '/') || '/api/sorting/run',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-ingestion-secret', v_secret
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end;
$$;

comment on function public.trigger_sorting() is
  'Cron entry point for Stage 1 sorting: POSTs to /api/sorting/run, which sorts whatever is still ai_sorting_status = ''pending''. Independent of ingestion by design — see migration 20260814000031.';

-- Same lockdown as trigger_ingestion(): SECURITY DEFINER reads a Vault secret,
-- so only the cron owner may call it.
revoke all on function public.trigger_sorting() from public;
revoke all on function public.trigger_sorting() from anon, authenticated;

select cron.unschedule('scm-sorting-pending')
where exists (
  select 1 from cron.job where jobname = 'scm-sorting-pending'
);

select cron.schedule(
  'scm-sorting-pending',
  '30 * * * *',
  $cron$select public.trigger_sorting()$cron$
);

-- Offset to :30 rather than :00 so a sorting pass never starts in the same
-- minute as the 12-hourly ingestion run. They no longer share an invocation,
-- but they would still share a cold start and a connection pool, and there is
-- no reason to make them contend when the schedule can simply not overlap.

-- ---------------------------------------------------------------------------
-- Run health — closing rows the process never came back to close
-- ---------------------------------------------------------------------------
-- Two rows sat at status='running' with every counter null for over a day,
-- because closeRun() never executed: the lambda was killed mid-fetch. An open
-- row is indistinguishable from a run in progress, which is why nobody noticed.
--
-- The code side of this is two mechanisms, in run.ts:
--   * a wall-clock budget (DEFAULT_BUDGET_MS) that stops fetching between
--     batches and closes the row as 'failed', for a run that merely overruns;
--   * reapStaleRuns(), called at the start of every run, which closes any row
--     left at 'running' past STALE_RUN_MS — for a process that died so hard it
--     could not run its own cleanup.
--
-- Closing the two known-stranded rows below is the same operation reapStaleRuns
-- performs, written here so the historical record is repaired by the migration
-- that introduces the guard rather than by an untracked manual UPDATE.
update public.ingestion_runs
   set status       = 'failed',
       completed_at = started_at + interval '60 seconds',
       errors       = jsonb_build_array(jsonb_build_object(
                        'source',   '(runtime)',
                        'sourceId', null,
                        'error',    'Killed at maxDuration=60s during fetch, before closeRun(); the row was left open at ''running''. Closed retrospectively by migration 20260814000031. Runs are now bounded by DEFAULT_BUDGET_MS and stale rows are reaped by the next run.'
                      ))
 where status = 'running'
   and completed_at is null;

comment on column public.ingestion_runs.status is
  'running = in flight; ok = every source fetched cleanly; partial_failure = the universe was covered but some sources errored; failed = the run did not cover the universe (stopped at its budget, reaped as stale, or every source errored). A run is never left at ''running'' by a process that dies — see reapStaleRuns().';
