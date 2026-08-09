-- ============================================================================
-- nestle-scm — Initial schema
-- Locked contract: 9 tables (profiles, sources, keywords, app_settings,
-- articles, ingestion_runs, reports, report_recipients, audit_log).
-- Auth is handled by Supabase Auth (auth.users); `profiles` extends it 1:1.
-- RLS policies live in the companion migration 20260809000002_rls_and_policies.sql
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. profiles — extends Supabase Auth with app roles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'read'
              check (role in ('read', 'curate', 'admin')),
  is_active   boolean not null default true,
  invited_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

comment on table public.profiles is
  'App roles keyed 1:1 on auth.users. read=view only, curate=exclude/delete articles, admin=manage everything.';

-- ---------------------------------------------------------------------------
-- 2. sources — Media Universe
-- ---------------------------------------------------------------------------
create table public.sources (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  rss_url           text,
  website_domain    text,
  list_type         text check (list_type in ('positive', 'negative')),  -- null = neutral
  category          text,
  is_active         boolean not null default true,
  added_by          uuid references public.profiles(id) on delete set null,
  last_fetched_at   timestamptz,
  last_fetch_status text check (last_fetch_status in ('ok', 'error', 'no_new_items')),
  last_fetch_error  text,
  created_at        timestamptz not null default now()
);

comment on column public.sources.list_type is
  'positive-only mode pulls list_type=''positive''; whole-universe mode pulls everything except list_type=''negative''.';

-- ---------------------------------------------------------------------------
-- 3. keywords
-- ---------------------------------------------------------------------------
create table public.keywords (
  id         uuid primary key default gen_random_uuid(),
  keyword    text not null unique,
  is_active  boolean not null default true,
  added_by   uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. app_settings — key/value global config
-- ---------------------------------------------------------------------------
create table public.app_settings (
  key        text primary key,
  value      jsonb,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5. articles — core table; one row per unique story (by dedup_key), permanently
-- ---------------------------------------------------------------------------
create table public.articles (
  id                  uuid primary key default gen_random_uuid(),
  dedup_key           text not null,
  url                 text,
  alt_urls            text[] not null default '{}',
  headline            text not null,
  byline              text,
  media               text,
  source_id           uuid references public.sources(id) on delete set null,
  published_at        date,
  body                text,               -- nullable: purged after report generation
  word_count          int,
  ingested_at         timestamptz not null default now(),
  status              text not null default 'active'
                      check (status in ('active', 'excluded', 'deleted')),
  status_changed_by   uuid references public.profiles(id) on delete set null,
  status_changed_at   timestamptz,
  ai_summary          text,
  ai_sentiment        text,
  ai_relevance_score  numeric,
  ai_category         text,
  ai_tags             text[] not null default '{}',
  matched_keywords    text[] not null default '{}',
  body_purged_at      timestamptz
);

comment on column public.articles.dedup_key is
  'Hash of normalized(headline + media + published_date + byline). Unique tombstone key: excluded/deleted rows are never resurrected.';

-- ---------------------------------------------------------------------------
-- 6. ingestion_runs — operational log for the Ingestion Logs panel
-- ---------------------------------------------------------------------------
create table public.ingestion_runs (
  id                        uuid primary key default gen_random_uuid(),
  run_type                  text not null check (run_type in ('backfill', 'scheduled', 'manual')),
  window_start              timestamptz,
  window_end                timestamptz,
  started_at                timestamptz not null default now(),
  completed_at              timestamptz,
  status                    text not null default 'running'
                            check (status in ('running', 'ok', 'partial_failure', 'failed')),
  sources_checked           int,
  articles_found            int,
  articles_new              int,
  articles_duplicate        int,
  articles_skipped_paywall  int,
  errors                    jsonb,
  triggered_by              uuid references public.profiles(id) on delete set null  -- null = cron
);

-- ---------------------------------------------------------------------------
-- 7. reports — history of Monday digests
-- ---------------------------------------------------------------------------
create table public.reports (
  id               uuid primary key default gen_random_uuid(),
  week_of          date,
  generated_at     timestamptz,
  sent_at          timestamptz,
  status           text not null default 'draft' check (status in ('draft', 'sent', 'failed')),
  recipient_count  int,
  article_count    int,
  stats_snapshot   jsonb,
  html_content     text,
  created_by       uuid references public.profiles(id) on delete set null  -- null = cron
);

comment on column public.reports.stats_snapshot is
  'Frozen aggregates (counts by media, sentiment split, top keywords, most-repeated stories). Enables historical dashboards after article bodies are purged.';

-- ---------------------------------------------------------------------------
-- 8. report_recipients — email-only distribution list
-- ---------------------------------------------------------------------------
create table public.report_recipients (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  name       text,
  is_active  boolean not null default true,
  added_by   uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 9. audit_log — accountability trail for curate/admin actions
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references public.profiles(id) on delete set null,
  action      text,                -- e.g. 'article.exclude', 'source.add', 'keyword.remove'
  target_type text,                -- e.g. 'article', 'source', 'keyword'
  target_id   uuid,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes (minimum per contract)
-- ---------------------------------------------------------------------------
create unique index articles_dedup_key_uidx on public.articles (dedup_key);
create index articles_status_idx        on public.articles (status);
create index articles_published_at_idx  on public.articles (published_at);
create index articles_media_idx         on public.articles (media);

create index ingestion_runs_started_at_idx on public.ingestion_runs (started_at);

create index reports_week_of_idx on public.reports (week_of);

create index sources_list_type_idx on public.sources (list_type);
create index sources_is_active_idx on public.sources (is_active);
