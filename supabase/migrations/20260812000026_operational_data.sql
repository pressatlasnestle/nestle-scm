-- ============================================================================
-- nestle-scm — manually-entered operational market data
--
-- Everything else on the Analysis panel is derived from the article corpus.
-- These three tables are not: they hold figures an analyst reads off a
-- Linerlytica or Sea-Intelligence report and types in. That difference is the
-- reason they are separate tables rather than columns on `reports`, and the
-- reason the panel renders them in their own section — a reader must be able
-- to tell at a glance which numbers came from the corpus and which came from a
-- third-party subscription.
--
-- GRAIN. Congestion and waiting time are WEEKLY and keyed on week_of, which is
-- the Monday of an ISO week, matching lib/analysis/week-period.ts exactly.
-- Schedule reliability is MONTHLY, because Sea-Intelligence publishes it
-- monthly in the Global Liner Performance report — hence glp_issue_number, so
-- an entry can be traced back to the issue it was read from.
--
-- WHY jsonb FOR THE BREAKDOWNS. The region list, the port list and the
-- alliance list are all editorial choices that will move: alliances reshuffle
-- (2M has already dissolved into Gemini), ports come and go from a watchlist.
-- Modelling them as columns would mean a migration every time the source
-- report changes its table, and modelling them as child rows would be three
-- more tables for data that is only ever read and written whole. A jsonb blob
-- per period is the right shape for something copied from one report table.
--
-- NO CHECK CONSTRAINTS on the numeric or jsonb fields, same discipline as
-- sources/keywords/themes. These are transcriptions of someone else's
-- published figures; if Linerlytica prints a percentage above 100 or a
-- negative delta, the job here is to record what was published, not to argue
-- with it. The write path is a form with its own validation.
--
-- ONE ROW PER PERIOD, enforced by a unique key, so "the congestion figure for
-- week X" is a single well-defined thing and the panel can upsert on it. Same
-- reasoning as reports.week_of in migration 0024 — and, as there, a plain
-- UNIQUE constraint rather than a partial index, because PostgREST's upsert
-- needs a constraint it can name as an ON CONFLICT arbiter.
-- ============================================================================

create table public.operational_congestion (
  id                uuid primary key default gen_random_uuid(),
  week_of           date not null unique,
  global_teu_waiting numeric,
  global_pct_fleet  numeric,
  region_data       jsonb,
  entered_by        uuid references public.profiles(id) on delete set null,
  entered_at        timestamptz not null default now()
);

comment on table public.operational_congestion is
  'Weekly port congestion, transcribed from Linerlytica. Not derived from the article corpus.';
comment on column public.operational_congestion.week_of is
  'Monday of the ISO week, matching lib/analysis/week-period.ts. One row per week.';
comment on column public.operational_congestion.region_data is
  'Per-region TEU waiting: {europe, north_america, north_asia, southeast_asia, south_america}. jsonb because the region list is an editorial choice that will change.';
comment on column public.operational_congestion.entered_by is
  'Who last wrote this row. Overwritten on edit; the full history is in audit_log under operational_data.update.';

create table public.operational_waiting_time (
  id         uuid primary key default gen_random_uuid(),
  week_of    date not null unique,
  port_data  jsonb,
  entered_by uuid references public.profiles(id) on delete set null,
  entered_at timestamptz not null default now()
);

comment on table public.operational_waiting_time is
  'Weekly average vessel waiting time in days, per port cluster, transcribed from Linerlytica.';
comment on column public.operational_waiting_time.port_data is
  'Port cluster to days waiting: {"Antwerp-Rotterdam": 1.8, ...}. jsonb because the watchlist changes.';

create table public.operational_schedule_reliability (
  id                     uuid primary key default gen_random_uuid(),
  month_of               date not null unique,
  glp_issue_number       integer,
  global_reliability_pct numeric,
  avg_delay_days         numeric,
  alliance_data          jsonb,
  entered_by             uuid references public.profiles(id) on delete set null,
  entered_at             timestamptz not null default now()
);

comment on table public.operational_schedule_reliability is
  'Monthly schedule reliability from Sea-Intelligence''s Global Liner Performance report. Monthly, not weekly — the panel carries the most recent month forward across week navigation.';
comment on column public.operational_schedule_reliability.month_of is
  'First day of the month the figures describe. One row per month.';
comment on column public.operational_schedule_reliability.glp_issue_number is
  'Which Global Liner Performance issue the figures were read from, so an entry is traceable to its source.';
comment on column public.operational_schedule_reliability.alliance_data is
  'Alliance to reliability percentage: {"Gemini Cooperation": 90.1, ...}. jsonb because alliances reshuffle.';

-- ---------------------------------------------------------------------------
-- RLS: read for every active app user, write for curate AND admin.
--
-- Wider than themes/sources, which are admin-only, and deliberately so. This
-- is routine weekly data entry off a subscription report — the same kind of
-- act as excluding an article or running AI coding, both of which curate can
-- already do — not a configuration change that alters how the pipeline
-- behaves. Gating it to admin would mean the person who reads the report every
-- Monday cannot enter what they read.
-- ---------------------------------------------------------------------------
alter table public.operational_congestion enable row level security;
alter table public.operational_waiting_time enable row level security;
alter table public.operational_schedule_reliability enable row level security;

create policy operational_congestion_select_app_users
  on public.operational_congestion for select to authenticated
  using (public.is_app_user());
create policy operational_congestion_curate_write
  on public.operational_congestion for all to authenticated
  using (public.can_curate()) with check (public.can_curate());

create policy operational_waiting_time_select_app_users
  on public.operational_waiting_time for select to authenticated
  using (public.is_app_user());
create policy operational_waiting_time_curate_write
  on public.operational_waiting_time for all to authenticated
  using (public.can_curate()) with check (public.can_curate());

create policy operational_schedule_reliability_select_app_users
  on public.operational_schedule_reliability for select to authenticated
  using (public.is_app_user());
create policy operational_schedule_reliability_curate_write
  on public.operational_schedule_reliability for all to authenticated
  using (public.can_curate()) with check (public.can_curate());

-- Reads are always "the row for this period", never a scan, so the unique
-- constraints above already provide the only index the panel needs.
