-- ============================================================================
-- nestle-scm — newsapi.ai (Event Registry) replaces NewsData.io
--
-- A full swap of the aggregator channel, not a parallel one. Everything
-- NewsData contributed was one article; the reason to move is coverage.
--
-- Measured 2026-08-11 by probing all 40 gap-source candidate domains through
-- Event Registry's /suggestSourcesFast. 17 are known, against NewsData's 9,
-- and it is a strict superset — nothing reachable before was lost:
--
--   already covered by NewsData (9)
--     bbc.com  bloomberg.com  business-standard.com  ec.europa.eu
--     economictimes.indiatimes.com  ft.com  reuters.com  theguardian.com
--     tradewindsnews.com
--   newly reachable (8)
--     ambrey.com  drewry.co.uk  hafen-hamburg.de  lloydslist.com
--     portofrotterdam.com  shippingwatch.com  unctad.org  xeneta.com
--
-- Four of the eight — Lloyd's List, Drewry, ShippingWatch, Xeneta — are the
-- paywalled T1b trade press that NewsData could not see at all, and that the
-- source taxonomy rates Critical or High.
--
-- Still unknown to any channel: alphaliner.com, linerlytica.com,
-- sea-intelligence.com, freightos.com, bimco.org, ics-shipping.org,
-- worldshipping.org, mpa.gov.sg, jnport.gov.in, dpworld.com, globalpsa.com,
-- apmterminals.com, adaniports.com, portofantwerpbruges.com, suezcanal.gov.eg,
-- kuehne-nagel.com, dsv.com, flexport.com, dryadglobal.com and the carrier
-- newsrooms. Corporate and institutional newsrooms remain the gap.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. run_type
--
-- 'newsdata_sweep' is KEPT in the allowed set even though nothing will ever
-- write it again. One such run was recorded on 2026-08-11 (2 found, 1 new)
-- before the swap, and dropping the value would make the constraint reject a
-- row that is already there — the migration would simply fail. The same
-- reasoning that keeps the one 'newsdata' article applies to its run: it is an
-- accurate record of something that happened, and the ingestion log is where
-- you go to find out what happened.
-- ---------------------------------------------------------------------------
alter table public.ingestion_runs
  drop constraint ingestion_runs_run_type_check;

alter table public.ingestion_runs
  add constraint ingestion_runs_run_type_check
  check (run_type in (
    'backfill', 'scheduled', 'manual', 'source_added',
    'google_news_sweep', 'newsapi_ai_sweep', 'newsdata_sweep'
  ));

comment on column public.ingestion_runs.run_type is
  'backfill = one-time 7d seed; scheduled = 12h cron, 24h window; manual = operator re-run; source_added = auto-fired when a source is added, 7d window, that source only; google_news_sweep = one-time Google News breadth seed; newsapi_ai_sweep = newsapi.ai (Event Registry) pass over gap sources that have no usable feed; newsdata_sweep = retired, historical rows only.';

-- ---------------------------------------------------------------------------
-- 2. source_channel
--
-- The single article carrying source_channel = 'newsdata' is left exactly as
-- it is. It is an accurate historical record of where that row came from, and
-- rewriting it would be a lie about provenance to make a list look tidy. The
-- code's SourceChannel union no longer contains 'newsdata', so channelRank()
-- returns null for it and dedup falls through to the word-count rule — the
-- same treatment as any pre-migration-18 row, which is the correct handling
-- for a channel that no longer competes.
--
-- Still no CHECK constraint here, for the reason migration 18 gave and
-- migration 20 restated: new channels are expected, the write path is code,
-- and the authoritative list is the TypeScript union.
-- ---------------------------------------------------------------------------
comment on column public.articles.source_channel is
  'Fetch path that produced this row: media_rss | google_alerts | google_news_seed | newsapi_ai. Drives cross-channel dedup priority in that order (media_rss wins). Also seen: newsdata, a retired channel kept on historical rows only — it ranks as unknown and falls back to the word-count rule.';

-- ---------------------------------------------------------------------------
-- 3. website_domain for the sources newsapi.ai can actually reach
--
-- Set on every gap row with at least one indexed publisher, cleared on rows
-- whose publishers are all unknown so that a stale NewsData-era value cannot
-- make a source look covered when it is not.
--
-- The five inactive rows below (Drewry, Lloyd's List, ShippingWatch,
-- TradeWinds, Xeneta) get their domains but keep is_active = false, the same
-- policy migration 19 applied to TradeWinds. They are paywalled T1b rows
-- someone deactivated; newsapi.ai now makes them reachable, but turning a
-- source back on is a curation decision, not a migration's. Until they are
-- activated the sweep will not query them.
-- ---------------------------------------------------------------------------
update public.sources set website_domain = 'ambrey.com'
  where name = 'Ambrey / Dryad Global / Vanguard';
update public.sources set website_domain = 'bloomberg.com'
  where name = 'Bloomberg - shipping / trade';
update public.sources set website_domain = 'drewry.co.uk'
  where name = 'Drewry (WCI)';
update public.sources set website_domain = 'economictimes.indiatimes.com,business-standard.com'
  where name = 'Economic Times / Business Standard - logistics';
update public.sources set website_domain = 'ec.europa.eu'
  where name = 'European Commission DG MOVE / EU ETS maritime';
update public.sources set website_domain = 'ft.com'
  where name = 'Financial Times - trade / shipping topic';
update public.sources set website_domain = 'lloydslist.com'
  where name = 'Lloyd''s List';
update public.sources set website_domain = 'portofrotterdam.com,hafen-hamburg.de'
  where name = 'Port of Rotterdam / Antwerp-Bruges / Hamburg';
update public.sources set website_domain = 'reuters.com'
  where name = 'Reuters - shipping / commodities section';
update public.sources set website_domain = 'shippingwatch.com'
  where name = 'ShippingWatch';
update public.sources set website_domain = 'theguardian.com,bbc.com'
  where name = 'The Guardian / BBC - geopolitics';
update public.sources set website_domain = 'tradewindsnews.com'
  where name = 'TradeWinds';
update public.sources set website_domain = 'unctad.org'
  where name = 'UNCTAD - maritime transport';
update public.sources set website_domain = 'xeneta.com'
  where name = 'Xeneta';

-- Rows whose publishers are none of them indexed: null means "no aggregator
-- coverage", and must not be left holding a domain that no channel queries.
update public.sources
set website_domain = null
where website_domain is not null
  and name not in (
    'Ambrey / Dryad Global / Vanguard',
    'Bloomberg - shipping / trade',
    'Drewry (WCI)',
    'Economic Times / Business Standard - logistics',
    'European Commission DG MOVE / EU ETS maritime',
    'Financial Times - trade / shipping topic',
    'Lloyd''s List',
    'Port of Rotterdam / Antwerp-Bruges / Hamburg',
    'Reuters - shipping / commodities section',
    'ShippingWatch',
    'The Guardian / BBC - geopolitics',
    'TradeWinds',
    'UNCTAD - maritime transport',
    'Xeneta'
  );

comment on column public.sources.website_domain is
  'Publisher domain(s) for aggregator lookups, comma-separated when the row groups several publishers. Set only where newsapi.ai indexes the publisher; null means no aggregator coverage.';
