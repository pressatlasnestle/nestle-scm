-- ============================================================================
-- nestle-scm — sources.is_fetchable: separating "has no feed" from "is broken"
--
-- Every scheduled run reported partial_failure, and had done for as long as
-- the schedule has existed. The status was therefore incapable of reporting a
-- real failure: a signal that is always on is not a signal.
--
-- The cause, measured. 88 active sources; 38 of them have no rss_url. Those 38
-- are two entirely different populations:
--
--   17 are list_type = 'negative' — the exclusion list (Zacks, Motley Fool, PR
--      Newswire, Port Vale FC, maritime NFT feeds, container home builders,
--      crew recruitment paths, Docker/Kubernetes media). These were ALREADY
--      excluded from fetching: selectSources() filters list_type != 'negative',
--      which is why runs check 71 sources and not 88. They contributed nothing
--      to the failures.
--
--   21 are list_type = 'positive' — genuine, intended sources that the fetcher
--      walks on every run and that fail on every run with "No RSS URL
--      configured.". These are the entire cause.
--
-- Those 21 are not misconfigured in the sense of being fixable by typing a
-- URL. They fall into two kinds:
--
--   * Paywalled with no public feed at all: Lloyd's List, TradeWinds, Drewry
--     (WCI), Xeneta, ShippingWatch. A feed does not exist to be found.
--   * Grouping rows naming several publishers at once: "Evergreen / HMM / Yang
--     Ming / ZIM", "Port of Rotterdam / Antwerp-Bruges / Hamburg", "MPA
--     Singapore / Shanghai / Ningbo / Qingdao", "JNPA / Adani Ports / DP World
--     / PSA / APM Terminals", "Reuters - shipping / commodities section",
--     "Bloomberg - shipping / trade", "Financial Times - trade / shipping
--     topic", "The Guardian / BBC - geopolitics", and so on. No single URL can
--     represent them; each would have to be split into one row per publisher
--     before it could carry a feed.
--
-- Both kinds are legitimate entries in the media universe — they are what the
-- Google News and newsapi.ai sweeps exist to cover — but neither is something
-- to ask for RSS. is_fetchable says so explicitly.
--
-- WHY A COLUMN RATHER THAN "skip rows with no rss_url". Because the two cases
-- must stay distinguishable. "Lloyd's List is paywalled and will never have a
-- feed" and "someone added a source last week and forgot to paste the URL" are
-- both rss_url IS NULL, and silently skipping both would turn the second into
-- an invisible gap in coverage. A source marked fetchable with no URL still
-- errors, loudly, exactly as before. Only the declared case is suppressed.
-- ============================================================================

alter table public.sources
  add column is_fetchable boolean not null default true;

comment on column public.sources.is_fetchable is
  'false = in the universe but never fetched for RSS, because no feed exists (paywalled publishers) or the row names several publishers at once. Not the same as is_active=false: the source stays visible and stays covered by the aggregator sweeps. A source with is_fetchable=true and no rss_url is a misconfiguration and still errors on every run — deliberately.';

-- The 38 no-URL rows, both populations. The negative ones were already skipped
-- by list_type, but marking them keeps the column honest: is_fetchable answers
-- "would we fetch this if we reached it", and for these the answer is no
-- regardless of which filter got there first.
update public.sources
   set is_fetchable = false
 where rss_url is null or btrim(rss_url) = '';

-- ---------------------------------------------------------------------------
-- ingestion_runs.sources_not_fetched
-- ---------------------------------------------------------------------------
-- Not fetching something is invisible by nature, so the count has to be
-- written down. Next to sources_checked, the two account for the whole active
-- universe — without it, a source silently dropping out of monitoring and a
-- source that was never meant to be fetched look identical in the log.
alter table public.ingestion_runs
  add column sources_not_fetched int;

comment on column public.ingestion_runs.sources_not_fetched is
  'Sources in the run''s universe deliberately skipped because is_fetchable = false. sources_checked + sources_not_fetched = the active universe for the run''s mode.';
