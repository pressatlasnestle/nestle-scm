-- ============================================================================
-- nestle-scm — NewsData.io sweep: run type, secret access, gap-source domains
--
-- The curated source list has 25 positive rows with no usable public feed —
-- paywalled trade press, carrier newsrooms, port and canal authorities,
-- analyst houses. Expanded through their slash-grouped names that is ~45
-- publishers the pipeline currently sees nothing from. NewsData.io is the
-- aggregator meant to close part of that gap.
--
-- "Part of" is measured, not assumed. Probing NewsData's /sources endpoint
-- with all 40 candidate domains on 2026-08-11 returned 9 as indexed:
--
--   bbc.com  bloomberg.com  business-standard.com  ec.europa.eu
--   economictimes.indiatimes.com  ft.com  reuters.com  theguardian.com
--   tradewindsnews.com
--
-- Everything else — alphaliner.com, drewry.co.uk, linerlytica.com,
-- lloydslist.com, shippingwatch.com, sea-intelligence.com, xeneta.com,
-- freightos.com, bimco.org, ics-shipping.org, worldshipping.org, mpa.gov.sg,
-- jnport.gov.in, dpworld.com, globalpsa.com, apmterminals.com,
-- adaniports.com, portofrotterdam.com, portofantwerpbruges.com,
-- hafen-hamburg.de, suezcanal.gov.eg, unctad.org, kuehne-nagel.com, dsv.com,
-- flexport.com, evergreen-marine.com, hmm21.com, yangming.com, zim.com,
-- ambrey.com, dryadglobal.com — is answered "The domain you provided does not
-- exist in our database." NewsData indexes news publishers, not institutional
-- and corporate newsrooms, so this channel closes the mainstream-press half of
-- the gap and leaves the trade/primary-source half open. Nothing downstream
-- should be written as though NewsData covers the whole list.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. run_type
-- ---------------------------------------------------------------------------
alter table public.ingestion_runs
  drop constraint ingestion_runs_run_type_check;

alter table public.ingestion_runs
  add constraint ingestion_runs_run_type_check
  check (run_type in (
    'backfill', 'scheduled', 'manual', 'source_added',
    'google_news_sweep', 'newsdata_sweep'
  ));

comment on column public.ingestion_runs.run_type is
  'backfill = one-time 7d seed; scheduled = 12h cron, 24h window; manual = operator re-run; source_added = auto-fired when a source is added, 7d window, that source only; google_news_sweep = one-time Google News breadth seed; newsdata_sweep = NewsData.io aggregator pass over gap sources that have no usable feed.';

-- ---------------------------------------------------------------------------
-- 2. Server-side read access to a Vault-backed provider key
--
-- The NewsData key is already in Vault, written through the Integrations panel
-- by set_integration_secret(). The pipeline runs in Node under the service-role
-- client and needs the plaintext to call the API, and until now nothing outside
-- SQL could read it back.
--
-- The property migration 6 protects is that a *browser session* can never see a
-- key: anon and authenticated get the integration_secrets_status view, which
-- has no vault_secret_id and no plaintext. That property is preserved exactly —
-- execute is revoked from anon and authenticated and granted only to
-- service_role, which is the key-bypasses-RLS role the browser never holds.
-- ---------------------------------------------------------------------------
create or replace function public.get_integration_secret(p_provider text)
returns text
language sql
security definer
set search_path = public, vault
as $$
  select v.decrypted_secret
  from public.integration_secrets s
  join vault.decrypted_secrets v on v.id = s.vault_secret_id
  where s.provider = p_provider and s.is_set;
$$;

revoke all on function public.get_integration_secret(text) from public, anon, authenticated;
grant execute on function public.get_integration_secret(text) to service_role;

comment on function public.get_integration_secret(text) is
  'Returns the plaintext Vault secret for a provider. service_role only — never granted to anon or authenticated, who keep seeing only integration_secrets_status.';

-- ---------------------------------------------------------------------------
-- 3. website_domain on the gap sources NewsData actually indexes
--
-- A source row may group several publishers ("The Guardian / BBC -
-- geopolitics"), exactly as a keyword row groups several terms. website_domain
-- therefore accepts a comma-separated list, which is also the shape NewsData's
-- own domainurl parameter takes. Rows whose publishers are not indexed are
-- deliberately left null: the sweep skips them, and a null here reads as
-- "no aggregator coverage" rather than "not looked at yet".
--
-- TradeWinds gets its domain but keeps is_active = false. It is a T1b
-- paywalled row someone deactivated; NewsData now makes it reachable, but
-- turning a source back on is a curation decision, not a migration's.
-- ---------------------------------------------------------------------------
update public.sources set website_domain = 'bloomberg.com'
  where name = 'Bloomberg - shipping / trade';
update public.sources set website_domain = 'economictimes.indiatimes.com,business-standard.com'
  where name = 'Economic Times / Business Standard - logistics';
update public.sources set website_domain = 'ec.europa.eu'
  where name = 'European Commission DG MOVE / EU ETS maritime';
update public.sources set website_domain = 'ft.com'
  where name = 'Financial Times - trade / shipping topic';
update public.sources set website_domain = 'reuters.com'
  where name = 'Reuters - shipping / commodities section';
update public.sources set website_domain = 'theguardian.com,bbc.com'
  where name = 'The Guardian / BBC - geopolitics';
update public.sources set website_domain = 'tradewindsnews.com'
  where name = 'TradeWinds';

comment on column public.sources.website_domain is
  'Publisher domain(s) for aggregator lookups, comma-separated when the row groups several publishers. Set only where an aggregator indexes the publisher; null means no aggregator coverage.';
