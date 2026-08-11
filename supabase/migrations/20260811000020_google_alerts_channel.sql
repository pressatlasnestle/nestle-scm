-- ============================================================================
-- nestle-scm — google_alerts as a distinct source_channel
--
-- 18 Google Alerts standing searches were added to `sources` under
-- tier = 'Alerts - Google standing search'. They are ordinary Atom feeds, so
-- fetchSource() already reads them with no changes. What was wrong is the
-- label: the per-source loop tagged every fetch 'media_rss', which would have
-- put a Google Alerts item and a publisher's own feed on equal footing in the
-- cross-channel dedup rule.
--
-- NOTE ON SCOPE: there is no CHECK constraint on articles.source_channel to
-- extend. Migration 18 deliberately left the column unconstrained — new
-- channels were expected, the write path is code rather than a form, and a
-- constraint would have meant a migration per channel. That reasoning still
-- holds, so this migration does not introduce one; it updates the column
-- comment, which is where the channel set is actually documented. The
-- authoritative list is the SourceChannel union in dedup.ts, and adding a
-- value there is a type error everywhere it must be handled.
--
-- Priority slot. Google Alerts sits below a publisher's own feed and above the
-- two aggregator seeds:
--
--   media_rss > google_alerts > google_news_seed > newsdata
--
-- An alert entry is Google's summary of somebody else's story — a snippet body
-- and a google.com redirect link — so it loses to the publisher's own feed for
-- the same reason the Google News seed does. It beats both seeds because it is
-- a live standing search on a curated term rather than a one-time breadth
-- sweep or a free-tier aggregator summary, and because it carries a real
-- `sources` row: its items get a source_id, and the Media Universe health
-- column reports on them.
-- ============================================================================

comment on column public.articles.source_channel is
  'Fetch path that produced this row: media_rss | google_alerts | google_news_seed | newsdata. Extend as channels are added. Drives cross-channel dedup priority in that order (media_rss wins, newsdata loses).';

comment on column public.sources.tier is
  'Editorial tier from the imported taxonomy. One value is load-bearing: tier = ''Alerts - Google standing search'' makes the per-source fetch tag its articles source_channel = ''google_alerts'' rather than ''media_rss''.';
