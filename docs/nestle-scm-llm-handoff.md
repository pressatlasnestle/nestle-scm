---
title: Nestlé SCM Media Monitor — handoff for a maintaining LLM
repo: pressatlasnestle/nestle-scm
supabase_project: wbxxtreznqdawzhzbstk
app: https://nestle-scm.vercel.app
state_at_writing: commit 2d2af6c, 16 August 2026
---

# Handoff

You are inheriting a live ocean-freight media intelligence platform used by a
Nestlé supply chain team. This note is written for you, not for a person. It
assumes you can read code and query Postgres, and it spends its length on the
things that are **not** visible from either.

Read this before changing anything. Several decisions in here look wrong until
you know why they were made, and at least four have already been "fixed" once
and reverted.

---

## 1. Orientation in ten lines

- Next.js 15 App Router on Vercel, Supabase Postgres behind it, `pg_cron` in the
  database calling application routes over HTTP. **The database is the scheduler.**
- Two routes exist: `src/app/api/ingestion/run` and `src/app/api/sorting/run`.
  That is all. Everything else is a server action.
- Admin UI lives under `src/app/(admin)/` — `analysis`, `articles`, `audit-log`,
  `integrations`, `keywords`, `media-universe`, `newsletter`, `recipients`,
  `themes`, `users`.
- Domain logic is in `src/lib/ingestion/` (fetch, match, dedup, run) and
  `src/lib/analysis/` (sorting, coding, similarity, operational, week-period,
  week-stats, narrative) and `src/lib/newsletter/`.
- CLI equivalents of every pipeline stage exist as `npm run ingest | sort | code
  | recode | narrative`.
- Verification is `npm run check` (ten suites, no DB needed) plus ~a dozen
  DB-backed suites listed in `package.json`.
- There are **no automated tests in the usual sense**. The `check:*` scripts are
  the test suite. Treat them as such.
- Roles are `read | curate | admin` in `profiles.role`. RLS is on for all 17
  tables and resolves through four SECURITY DEFINER helpers.
- There is no PR workflow. Everything is committed directly to `main`. There has
  never been a pull request in this repository.
- Commit messages are long and carry the reasoning, measurements and before/after
  distributions. **They are the design record.** `git log` is worth reading.

---

## 2. Invariants — do not break these

These are load-bearing. Each has a comment in the source explaining it; this is
the index.

### 2.1 Absent is not zero

Applies to operational figures, newsletter sections, and deltas.

A figure nobody entered is **not stored, not rendered, and not zero-filled**. A
chart of zeros would be a false claim about the market — there is no such thing
as a day with zero port congestion. A section with no data is omitted entirely,
heading included.

For deltas this extends further: a missing prior period renders as
`first-edition` or `no-prior`, **never `0%`**, because a zero delta asserts that
nothing changed, which is a different claim from having nothing to compare.

### 2.2 Published values are stored, never derived

`operational_port_congestion.queue_berth_ratio` approximates
`ships_anchorage / ships_port` but does not equal it. Busan (122/48 = 2.54) and
Antwerp (17/21 = 0.81) reconcile exactly; Shanghai/Ningbo computes 3.526 against
a published 3.50 and Gibraltar 2.63 against 2.80.

If you "simplify" this into a division, the panel will print figures that
disagree with the dashboard the reader has open. There is an assertion pinning
the Shanghai/Ningbo case — it exists precisely to stop this refactor.

Relatedly: **there are no CHECK constraints on any operational numeric**, on
purpose. The system records what was published including a figure that looks
wrong.

### 2.3 A sent newsletter edition is frozen

`newsletter_editions_frozen` is a `BEFORE UPDATE OR DELETE` trigger raising
`42501` on any row with `status = 'sent'`. DELETE is blocked too — allowing it
would leave delete-and-recreate as a route to rewriting a sent record.

This is in the database, not the UI, because a disabled button is not a gate.

### 2.4 Coding is gated on sorting, and the gate is asserted twice

`coding-batch.ts` filters on `ai_sorting_status = 'complete'`, and
`assertSorted()` in `coding.ts` **throws** if any row reaching the coder is
unsorted.

The assertion exists because the previous filter was `not(ai_sorting_flagged is
true)`, which reads like a gate and lets every unsorted row through — 28
articles were coded without ever being screened, and nothing complained for
days. A query condition can be quietly wrong; a thrown error cannot.

If you touch the selection, keep both. The suite `check:coding-gate` asserts on
the **emitted query conditions**, not on the source line, for the same reason.

### 2.5 A coded article's body is locked

`dedup.ts` returns `skipped_coded` before channel priority or word count are
consulted. `ai_sentiment`, `ai_themes` and `ai_summary` are all derived from the
stored `body`; superseding the body without re-coding leaves them describing text
that is no longer there.

Deliberately **not** locked on `ai_sorting_status = 'complete'` — that would lock
everything, since sorting reaches every row within the hour.

### 2.6 Provenance beats length

Channel priority: `media_rss` > `google_alerts` > `google_news_seed` >
`newsapi_ai`. Across channels this decides outright and word count is not
consulted. Within a channel, word count still decides.

The aggregator returns full article text and would win on length every time
while being the less authoritative record. Do not "improve" this by comparing
word counts globally.

### 2.7 Direction and magnitude are separate axes

`ai_sentiment` carries direction only; `ai_relevance_score` (0–100) carries
magnitude. Collapsing them, or deriving one from the other, has already happened
twice and produced a broken corpus both times. See §4.

The only forced coupling is: `impact_kind = 'none'` forces `Neutral` and caps
relevance below 20. Nothing else is forced — a `specific` or `market_wide`
article is free to be Neutral and free to score low.

### 2.8 Email HTML constraints

The newsletter email must contain **no `<svg`, no `class=`, no `<link`, no
`<style`**. Gmail strips inline SVG entirely and Outlook renders through Word,
which does not support it. The panel's Recharts components **cannot** be reused
in the email — doing so produces a preview that looks perfect and an email that
arrives blank.

Charts in the email are inline-styled HTML table cells. The frame is
`width:100%; max-width:640px` with an `[if mso]` ghost table — note the order,
`width:640px; max-width:100%` computes to `none` against an auto-width table cell
and silently forces a 656px layout on a phone.

`check:newsletter` asserts the absence of all four strings. Keep those
assertions; they are one string search and they protect the whole thing.

---

## 3. Failure modes already encountered

Written up because each cost real time and each will look novel when it recurs.

### 3.1 Sorting silently stops while runs report success

**Symptom:** `ai_sorting_status = 'pending'` accumulates over days. Ingestion
runs report `ok` or `partial_failure` and close cleanly.

**Cause (already fixed once):** sorting used to run inside the ingestion request
via `after()`. `after()` defers past the *response*, not past `maxDuration`, so
sorting inherited whatever seconds the fetch had not spent. A run on 14 Aug
completed in 57s of its 60s budget, captured 31 articles and sorted **zero**.

**Now:** sorting is its own route on its own hourly cron, selecting on
`ai_sorting_status = 'pending'` rather than on the ids a run inserted. A pass
keyed on what is outstanding cannot leave a permanent hole.

**If it recurs:** check `cron.job` is still active, then POST the sorting route
manually, then look at `SORT_BUDGET_MS` (45s against a 60s route). Do **not**
re-couple it to ingestion, and do not simply raise the timeout — that was tried,
it held for two days, and the ceiling returned.

### 3.2 Runs stranded at `status = 'running'`

An open row is indistinguishable from a run in progress, so stranded rows sit
unnoticed. `reapStaleRuns()` runs at the start of every run and closes anything
left running past ten minutes. If you see open rows older than that, the reaper
is not firing.

### 3.3 `partial_failure` on every run

Currently expected if sources are misconfigured, and **it was once meaningless**:
21 `list_type = 'positive'` sources had no RSS URL and failed every run forever.
A status that is always `partial_failure` cannot report a real failure.

`sources.is_fetchable` now separates "should be fetched" from "is a source". 50
active sources are fetchable, 38 are not. Of the non-fetchable, 17 are
`list_type = 'negative'` (the exclusion list, never fetched anyway) and the rest
are real publishers that are either paywalled with no feed (Lloyd's List,
TradeWinds, Drewry, Xeneta, ShippingWatch) or grouping rows naming several
publishers at once, which no single URL can represent.

Twelve sources have real but broken feeds (403/404/HTML-not-feed) and **should**
keep reporting. Do not silence those.

### 3.4 Duplicate articles that dedup cannot see

**This is unfixed and structural.** `computeDedupKey` hashes
`headline | media | published_date | byline`. For Google Alerts, `media` holds
the **alert query name**, not the publisher. The same article matching two
standing alerts produces two different keys and is stored twice.

Measured case: two rows sharing the headline "Container carriers line up Arctic
services as Red Sea alternative", both URLs resolving to the same Seatrade page
differing only in a Google redirect `cd=` parameter.

**The fix is one field** — derive `media` from the resolved publisher rather than
the alert name. It has not been done because it changes the dedup key for
existing rows and needs a migration plan. If you take it on, that is the
consideration.

### 3.5 Snippet pollution

Google Alerts bodies are ~150-character windows onto a page, centred on whichever
term the alert matched — and they **frequently contain other stories' text**. In
the measured pair above, the two bodies shared 6 of 39 distinct tokens (15.4%
Jaccard) and neither was about the story in the shared headline.

Consequence: when two duplicates grade differently, the input genuinely differs.
Do not diagnose that as model non-determinism. Check `md5(body)` first.

Temperature is already `0` (`src/lib/analysis/gemini.ts`).

### 3.6 Recharts renders nothing at width zero

A `ResponsiveContainer` in a plain block wrapper measured width 0 and emitted no
`<svg>` at all, while identical charts inside `.chart-grid` were fine. Figures
rendered; the chart did not. There is no error.

If a chart is blank, measure the container's computed width before anything else.

### 3.7 Dropdowns clipped inside scroll containers

The entry grid's port combobox sat inside `.grid-scroll` (`overflow: auto`). An
absolutely-positioned descendant is **clipped** by an overflowing ancestor, and
no `z-index` defeats a clip — they are different mechanisms. The visible symptom
was a thin white strip, which is the list's own scrollbar, the only part that
survived.

Fixed by portalling to `document.body` with `position: fixed`. Note the
consequences that came with it: the scroll listener is registered in the
**capture phase**, because `.grid-scroll`'s scroll event does not bubble; and
outside-click detection cannot use a `contains()` test on the wrapper alone,
since the list is no longer in the input's subtree.

### 3.8 CSS source order beat a modal's max-width

`.grid-modal` sat above `.modal` in the stylesheet, so `.modal`'s `max-width` won
on source order and the grid rendered at 436px instead of 1180px. Now
`.modal.grid-modal`. If a container is mysteriously narrow, check specificity and
source order before layout.

---

## 4. The favourability methodology, and why it is on version 3

`articles.coding_version` records which methodology produced a grade. Read this
section before touching `src/lib/analysis/coding.ts` — the scale has been wrong
twice, in opposite directions, and both corrections were over-corrections.

**Original (arithmetic).** The model graded headline and body separately as
±1/0, and the tier was their sum. With each component in {+1, 0, −1}, the extreme
tiers were reachable from agreement and the moderate tiers required disagreement,
so the distribution concentrated at its ends **by arithmetic**. Measured: 42.2%
Very unfavourable against 6.8% Unfavourable. No prompt change could have fixed
it.

**Version 1–2 (single-limb impact test).** Replaced with an anchored five-point
scale, a separate 0–100 relevance axis, and a required `impact_rationale` naming
the affected lane. The forcing rule asked for **a named lane, port, service or
cost**.

That rule measured whether a *proper noun* was present, not whether an impact
was. Market-wide news names no single lane precisely because it moves all of
them. Result over 268 rows: **74.3% Neutral**, 197 of 199 Neutrals below
relevance 20, and 98 rationales carrying near-verbatim the same sentence. One
article carrying the figure "global schedule reliability fell from 64.5% in May
to 62.6% in June" was graded Neutral/15 because no berth was named.

**Version 3 (current).** The impact test has two limbs stated as equals —
`specific` and `market_wide` — and a `market_wide` classification requires no
proper noun. Direction for market movements is supplied as a table (rates rising
→ Unfavourable, and so on) because the model had no rule for which way a rate
rise cuts and defaulted to Neutral. Relevance is anchored on the size of the
effect. The prose regex was replaced by the `impact_kind` enum.

Current distribution (268 coded, verified):

```
                    0-19  20-39  40-59  60-79  80-100  total
Very unfavourable      0      0      0      2      19     21
Unfavourable           0      7     38     36       0     81
Neutral              126      1      2      0       0    129
Favourable             0      5     20     12       0     37
Very favourable        0      0      0      0       0      0
```

**If you change the methodology, bump `CODING_VERSION` and run a full recode.**
`scripts/recode.ts` is resumable — it skips rows already at the current version.
267 articles took 531.8s at concurrency 4.

**Guardrails for any future recalibration**, both directions, because setting
only a ceiling is how 74.3% Neutral happened:

- `Very unfavourable` at or below **25%**
- `Neutral` at or below **55%**
- Report the **cross-tabulation of tier against relevance band**, not the tier
  table. The tier table alone hid the axis fusion last time — it showed a
  plausible spread of grades while every Neutral sat under 20.
- Run fixtures from **every** generation together. Each correction so far has
  over-corrected the last, so a crane must stay Neutral *while* a rate rally
  becomes Unfavourable.

### Open question, not yet resolved

`Very favourable` holds **zero** articles, and the 80–100 relevance band contains
only `Very unfavourable` rows. The grade is reachable under test (a restoration
at scale returns Very favourable/95).

Whether this reflects a disruption-heavy period or an asymmetry between the top
and bottom anchors is **not established**. Note that "a trade Nestlé uses is
disrupted now" happens most weeks, while "all major carriers restoring Suez
routings at scale" happens once in years. If the corpus stays at zero, look at
the positive anchors before concluding it is the market.

---

## 5. Things that are dormant, dead or half-finished

Do not assume these are alive.

- **`reports` digest columns** — `html_content`, `stats_snapshot`,
  `generated_at`, `article_count`, `recipient_count` are all null and nothing
  reads or writes them. The table itself is **live**: `analysis_narrative` is
  written by the Analysis panel's Regenerate action and read on every
  `/analysis` render. **Do not drop this table.**
- **`articles.ai_category`, `ai_tags`** — present in the schema, not part of the
  current coding output.
- **Congestion region vocabulary is narrower than the source dashboard.**
  `CONGESTION_REGIONS` in `src/lib/analysis/operational.ts` carries five regions;
  the Linerlytica breakdown the newsletter is meant to lead with has ten. The
  missing AOA regions (ISC/Middle East, Oceania, Africa, plus North Europe, West
  Asia, Med) **cannot currently be entered**. Adding them is a one-line change
  and both the grid and the CSV template pick them up.
- **One article stuck at `coding_version = 1`** — "Trump extends Jones Act
  waiver…". Coded before the gate existed, since flagged off-topic, so the recode
  correctly skipped it. It is the only row on a retired methodology.
- **All four operational tables are empty.** Zero rows. No operational figure has
  ever been entered, so every chart and every newsletter section that depends on
  them is currently absent by design, not broken.
- **No newsletter edition has ever been created.** `newsletter_editions` is
  empty.

---

## 6. Verification

```
npm run check                    # 10 suites, no database required
npm run typecheck && npm run build
```

DB-backed suites (need `.env.local`): `check:favourability`, `check:themes`,
`check:coded-lock`, `check:analysis`, `check:analysis-access`,
`check:operational`, `check:operational-upload`, `check:newsletter`,
`check:newsletter-visual`, `check:visual`.

**Discipline these suites follow, which you should preserve:**

- Tests that exercise RLS run as **real curate and read users**, not service
  role. The property under test is the policy, so running as service role tests
  nothing.
- Fixtures use **year-2099** dates and clean up on success *and* failure.
- Visual checks render in a real browser and **look at the output**. Every round
  of work so far has found at least one defect this way that no assertion caught
  — a container at width zero, a modal losing its max-width, a clipped dropdown,
  an axis printing seven-digit ticks off the card edge.
- `npm run harness` serves the visual harness on `localhost:4173`. It is a static
  server and never exits; that is not a hang.

### The gap you will hit

**There is no `read`-role user in the project and no credentials in the
environment.** The RLS tier of several suites has therefore never run. The
scripts report exactly what went unproven and exit non-zero rather than passing
quietly.

Creating that fixture account is the single highest-value unblocking action
available. It also unblocks browser-driven verification, which has repeatedly
been the last mile — the newsletter Save path and the Media Universe fetch toggle
have both shipped without ever being clicked by hand.

---

## 7. Working conventions

- **Migrations only.** Never apply DDL directly. Migrations live in
  `supabase/migrations/`, numbered.
- **Plain `UNIQUE`, never a partial unique index.** PostgREST's `ON CONFLICT`
  needs an arbiter it can name; a partial index makes upserts fail outright. This
  was learned in migration 0024 and is referenced in several later ones.
- **Writes run under the caller's client, not service role**, so RLS is the gate
  rather than the button. The one exception is the Vault decrypt in the
  operational upload path — and `apply_operational_upload` is deliberately
  `SECURITY INVOKER` so RLS still applies to the bulk write.
- **Every curator write is audited** to `audit_log` with the submitted values.
  Insert policy requires `actor_id = auth.uid()`, so an entry cannot be
  attributed to another user.
- **Commit messages carry the reasoning and the measurements.** Follow the
  existing style — before/after distributions, what was verified, what was not.
  When something could not be verified, say so explicitly rather than omitting
  it.
- **Report what you could not do.** The existing record consistently names
  unverified paths. Preserve that; it is why this handoff can be specific.

---

## 8. If you are asked to change the newsletter

Two behaviours are non-obvious and both are correct:

- **Reliability is monthly, the newsletter is weekly.** Four consecutive editions
  carry the same figure and GLP issue number. The carry-forward is **bounded** to
  the most recent month at or before the selected week — an unbounded "latest"
  would show March's figures on a January week, which is not carrying forward but
  showing the future. It must also compare against the previous *published*
  month, not week-on-week, or it prints `0%` three weeks in four.
- **Figures are stocks, not flows.** TEU at anchorage is a level on a given day.
  The value for a week is the **most recently entered day within it**, labelled
  with that date. Never average a period.

The week selector includes the **currently running week**, labelled "in progress
· N coded so far". Sending a running week is permitted but permanent — `week_of`
is UNIQUE and sent rows are frozen, so a Friday send means no complete edition
for that week can ever be sent. The UI warns; do not remove the warning.
