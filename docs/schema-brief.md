# nestle-scm — Initial Schema Migration Brief

This is the locked contract for the database. Ingestion, admin panel, dashboard, and
report generation should all build against these table/column names as-is — changes
here should happen once, before parallel work starts, not mid-build.

**Auth note:** Login/password handling uses Supabase Auth (`auth.users`) directly —
we don't reinvent that. `profiles` below extends it with role/app-specific fields,
keyed 1:1 on `auth.users.id`.

---

## 1. `profiles`
Extends Supabase Auth with app roles.

| column | type | notes |
|---|---|---|
| id | uuid PK | references `auth.users(id)` |
| email | text | |
| full_name | text | |
| role | text | check in `('read','curate','admin')` |
| is_active | boolean | default `true` |
| invited_by | uuid | references `profiles(id)`, nullable |
| created_at | timestamptz | default `now()` |

Role meaning: `read` = view dashboard/reports only. `curate` = read + exclude/delete
articles. `admin` = curate + manage users, keywords, media universe, settings.

---

## 2. `sources` (Media Universe)

| column | type | notes |
|---|---|---|
| id | uuid PK | default `gen_random_uuid()` |
| name | text | not null |
| rss_url | text | |
| website_domain | text | |
| list_type | text | `'positive'` \| `'negative'` \| `null` (neutral) |
| category | text | optional, e.g. "trade press" |
| is_active | boolean | default `true` |
| added_by | uuid | references `profiles(id)` |
| last_fetched_at | timestamptz | |
| last_fetch_status | text | `'ok'` \| `'error'` \| `'no_new_items'` |
| last_fetch_error | text | nullable |
| created_at | timestamptz | default `now()` |

`list_type` drives the universe toggle: positive-only mode pulls `list_type='positive'`
sources only; whole-universe mode pulls everything except `list_type='negative'`.

**Delete semantics:** hard delete is safe here — a source has no rows that must
outlive it for integrity, only ones that should outlive it for history. `articles.source_id`
must be `references sources(id) ON DELETE SET NULL`, so deleting a source stops future
pulls immediately but leaves already-ingested articles intact (UI shows "source removed"
where `source_id is null` but `media` text field still names it, since `media` is stored
as plain text on the article, not derived from the FK at render time).

---

## 3. `keywords`

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| keyword | text | not null, unique |
| is_active | boolean | default `true` |
| added_by | uuid | references `profiles(id)` |
| created_at | timestamptz | default `now()` |

**Delete semantics:** hard delete is safe — `articles.matched_keywords` stores the
keyword text at match time (not an FK), so deleting a keyword row doesn't touch
already-tagged articles' history, it only stops the term from being matched going
forward.

---

## 4. `app_settings`
Key-value store for global config, so new settings don't need migrations.

| column | type | notes |
|---|---|---|
| key | text PK | e.g. `'universe_mode'` |
| value | jsonb | e.g. `'"whole_universe"'` or `'"positive_only"'` |
| updated_by | uuid | references `profiles(id)` |
| updated_at | timestamptz | |

---

## 5. `articles`
The core table. One row per unique story (by fingerprint), permanently — even after
soft-delete or body purge.

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| dedup_key | text | unique index — hash of normalized(headline + media + published_date + byline) |
| url | text | the canonical/first-seen URL |
| alt_urls | text[] | other URL variants seen for the same story (handles timestamped URL endings) |
| headline | text | not null |
| byline | text | nullable |
| media | text | source/publication name |
| source_id | uuid | references `sources(id)`, nullable |
| published_at | date | |
| body | text | **nullable** — purged after report generation |
| word_count | int | of the body at time of last update |
| ingested_at | timestamptz | default `now()` |
| status | text | `'active'` \| `'excluded'` \| `'deleted'` — default `'active'` |
| status_changed_by | uuid | references `profiles(id)` |
| status_changed_at | timestamptz | |
| ai_summary | text | |
| ai_sentiment | text | |
| ai_relevance_score | numeric | |
| ai_category | text | |
| ai_tags | text[] | |
| matched_keywords | text[] | |
| body_purged_at | timestamptz | nullable |

**Dedup / update logic (ingestion-side, not DB-enforced beyond the unique index):**
1. Normalize headline/media/date/byline → compute `dedup_key`.
2. Look up existing row by `dedup_key`.
   - Not found → insert new row, `status='active'`.
   - Found, `status='active'` → compare `word_count`; if new pull has a longer body,
     update `body`, `word_count`, `url` (push old url into `alt_urls`); otherwise discard the pull.
   - Found, `status` in `('excluded','deleted')` → **skip entirely, never resurrect.**
     This is what makes deletion/exclusion permanent across future pulls.
3. "Delete" in the UI sets `status='deleted'` and nulls `body` immediately — it is a
   soft delete. The row (and its `dedup_key`) is retained forever as a tombstone.

---

## 6. `ingestion_runs`
Operational log for the Ingestion Logs panel.

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| run_type | text | `'backfill'` \| `'scheduled'` \| `'manual'` |
| window_start | timestamptz | date-range floor this run targeted |
| window_end | timestamptz | date-range ceiling this run targeted |
| started_at | timestamptz | |
| completed_at | timestamptz | nullable |
| status | text | `'running'` \| `'ok'` \| `'partial_failure'` \| `'failed'` |
| sources_checked | int | |
| articles_found | int | |
| articles_new | int | |
| articles_duplicate | int | |
| articles_skipped_paywall | int | |
| errors | jsonb | per-source error detail |
| triggered_by | uuid | references `profiles(id)`, null = cron |

**Backfill vs. rolling window:**
- One-time `backfill` run: RSS-only, `window_start` = now − 7 days, `window_end` = now.
  Pulls whatever each feed currently exposes (feeds cap at ~20–50 recent items regardless
  of window — 7 days is a target, not a guarantee for lower-frequency publishers).
- Every `scheduled` run after that: `window_start` = now − 24h, `window_end` = now.
  Articles outside the window are ignored at fetch time (filtered on `published_at`
  before the dedup check ever runs), keeping every routine run cheap.
- The 24h window on a 12h cadence means each run re-checks the second half of the prior
  run's window too — that's intentional, it catches late-published or late-indexed
  items; the dedup fingerprint check (see `articles` above) makes the overlap free of
  duplicate inserts.

---

## 7. `reports`
History of Monday digests. `stats_snapshot` is what makes historical dashboards
possible after article bodies are purged.

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| week_of | date | |
| generated_at | timestamptz | |
| sent_at | timestamptz | nullable |
| status | text | `'draft'` \| `'sent'` \| `'failed'` |
| recipient_count | int | |
| article_count | int | |
| stats_snapshot | jsonb | frozen aggregates: counts by media, sentiment split, top keywords, most-repeated stories |
| html_content | text | stored copy of the email body actually sent |
| created_by | uuid | references `profiles(id)`, null = cron |

---

## 8. `report_recipients`
Email-only distribution list, separate from dashboard logins.

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| email | text | not null |
| name | text | |
| is_active | boolean | default `true` |
| added_by | uuid | references `profiles(id)` |
| created_at | timestamptz | |

---

## 9. `audit_log`
Accountability trail for curate/admin actions.

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| actor_id | uuid | references `profiles(id)` |
| action | text | e.g. `'article.exclude'`, `'article.delete'`, `'source.add'`, `'keyword.remove'` |
| target_type | text | e.g. `'article'`, `'source'`, `'keyword'` |
| target_id | uuid | |
| metadata | jsonb | before/after or extra context |
| created_at | timestamptz | default `now()` |

---

## 10. `integration_secrets`
Admin-managed API keys (Gemini, etc.), backed by **Supabase Vault** — not a plain
column. The raw key value never lives in this table and is never returned via the
normal client API.

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| provider | text | unique — `'gemini'`, `'claude'`, `'resend'`, etc. |
| vault_secret_id | uuid | FK into `vault.secrets.id`; actual value lives in Vault, encrypted |
| is_set | boolean | whether a value currently exists |
| last_four | text | last 4 chars only — for the admin UI's masked display |
| updated_by | uuid | references `profiles(id)` |
| updated_at | timestamptz | |
| model_id | text | nullable — plain text, NOT secret. The specific model string this provider should use (e.g. `gemini-2.5-flash`, `claude-haiku-4-5`). Editable independently of the key. |

**Provider values:** `'gemini'`, `'claude'`, `'resend'`, `'news_aggregator'` (Google News/RSS search API key used for whole-universe keyword search — separate from any single source's RSS feed). `model_id` is only meaningful for LLM providers (`gemini`, `claude`); leave null for `resend` and `news_aggregator`.

**Access pattern:** admin panel is write-only against this — submitting a new key goes
through a server route that calls `vault.create_secret()` / `vault.update_secret()`,
never a direct client insert. Reads of the *decrypted* value only happen inside
Edge Functions using the service-role context (ingestion/analysis jobs), never via
PostgREST to any authenticated session, admin included. The UI only ever shows
`is_set` + `last_four`, never the key itself. Log `integration_secret.update` to
`audit_log` on change — value excluded from the metadata.

**`model_id` update path is separate and lighter-weight than the key rotation path**,
since it isn't secret: `GRANT UPDATE (model_id) ON integration_secrets TO authenticated`
(column-level grant, not row-level), combined with the existing RLS policy requiring
`is_admin()`. No Vault call needed — this lets an admin swap models from the UI
without touching the key at all. Log `integration_secret.model_change` to `audit_log`
with `{provider, old_model_id, new_model_id}`.

---

## Indexes (minimum)
- `articles`: unique on `dedup_key`; index on `status`, `published_at`, `media`
- `ingestion_runs`: index on `started_at`
- `reports`: index on `week_of`
- `sources`: index on `list_type`, `is_active`

## Open assumptions to confirm before build
1. "Delete" = soft delete (tombstone retained forever) — confirmed design above; flag if you want a true hard-delete path for extreme cases (e.g. legal takedown).
2. Dashboard charts (bubble diagrams, media breakdown, etc.) compute live from `articles` for the *current* period, and from `reports.stats_snapshot` for historical periods.
3. "Positive/negative media" is a per-source flag (`sources.list_type`), not a separate join table — simpler unless you expect a source to flip list membership frequently with history tracking needed.
