-- ============================================================================
-- nestle-scm — newsletter_editions
--
-- One row per monthly "Ocean Freight Update — AOA" edition. The series ran
-- April 2025 to March 2026 as a hand-assembled Outlook mail and lapsed; this
-- table is what lets it restart without the assembly.
--
-- TWO HALVES THAT NEVER BLEND. Every column here is AUTHORED — typed by the
-- curator. There is no column for a figure, a table or a press item, because
-- those are GENERATED: read out of articles and the operational_* tables at
-- draft time and recomputed on every view. Storing a generated value alongside
-- the authored text would create two answers to "what was September's TEU at
-- anchorage" and no rule for which one wins.
--
-- The one exception is `snapshot`, and it is the exception that proves the
-- rule — see the freeze below.
--
-- NO CHECK CONSTRAINTS ON THE AUTHORED TEXT, same discipline as the
-- operational tables and for a stronger reason: this is editorial judgement
-- about Nestlé's lanes, and a length or format rule would be the database
-- arguing with the person whose judgement the edition exists to carry. `status`
-- does carry a CHECK, because it is a two-state machine the freeze trigger
-- depends on, not prose.
--
-- PLAIN UNIQUE (month_of), NEVER A PARTIAL INDEX. Migration 0024's lesson:
-- PostgREST's upsert needs a constraint it can name as an ON CONFLICT arbiter,
-- and Postgres will not accept a partial index without repeating its predicate
-- in the statement — which PostgREST cannot express. Postgres treats NULLs as
-- distinct anyway, so the plain form costs nothing.
-- ============================================================================

create table public.newsletter_editions (
  id                   uuid primary key default gen_random_uuid(),
  month_of             date not null unique,
  status               text not null default 'draft'
                       check (status in ('draft', 'sent')),

  -- --- Authored. Never prefilled from anything generated. -----------------
  headline_read        text,
  regional_commentary  text,
  reliability_note     text,
  watch_list           jsonb,
  recommended_actions  jsonb,

  -- --- The curator's press selection --------------------------------------
  included_article_ids uuid[],

  -- --- Frozen at send ------------------------------------------------------
  snapshot             jsonb,
  sent_at              timestamptz,
  sent_by              uuid references public.profiles(id) on delete set null,

  entered_by           uuid references public.profiles(id) on delete set null,
  entered_at           timestamptz not null default now()
);

comment on table public.newsletter_editions is
  'One row per monthly Ocean Freight Update edition. Holds ONLY the authored halves — every figure, table and press item is generated at view time from articles and the operational_* tables. A row with status=''sent'' is frozen by a trigger and renders from `snapshot` alone.';

comment on column public.newsletter_editions.month_of is
  'First of the month the edition covers. One row per month, so "the September edition" is a single well-defined thing the composer can upsert on.';

comment on column public.newsletter_editions.headline_read is
  'Authored, 3-4 sentences. Deliberately has no generated counterpart to fall back on: a suggested draft that the curator lightly edits reliably becomes the shipped text, and the commentary is the only part of the edition carrying judgement about Nestlé''s lanes.';

comment on column public.newsletter_editions.watch_list is
  'Authored: [{risk, lanes, window, direction}]. jsonb rather than a child table because it is only ever read and written whole, and its shape is an editorial choice that will move.';

comment on column public.newsletter_editions.recommended_actions is
  'Authored, ordered: ["…"]. The order is the priority and is preserved as given.';

comment on column public.newsletter_editions.included_article_ids is
  'The press items the curator kept. NULL means "not yet curated" — every candidate is in. Once the curator toggles anything, this holds the full remaining set, so an exclusion survives a recompute. The composer always lists every candidate with its state, so nothing is dropped silently.';

comment on column public.newsletter_editions.snapshot is
  'NULL while the edition is a draft. Written once, at send, with every generated value the edition rendered from. A sent edition reads from here and never recomputes.';

comment on column public.newsletter_editions.sent_by is
  'ON DELETE SET NULL so removing a user cannot be blocked by an edition they sent. The sender''s name is also copied into `snapshot` at send time, which is the record that has to survive.';

comment on column public.newsletter_editions.entered_by is
  'Who last saved the draft. Overwritten on each save; the history is in audit_log under newsletter.update.';

-- ---------------------------------------------------------------------------
-- THE FREEZE — the single most important rule in this table.
--
-- While an edition is a draft its figures recompute live, which is the point:
-- the curator enters another day of congestion and the draft follows. On send,
-- every generated value is written into `snapshot` and the edition must never
-- move again.
--
-- A newsletter that silently changes after it has gone out is a false record of
-- what the client received, and next month's "vs last month" would compare
-- against numbers nobody was ever sent. So sending is one-way: no un-send, no
-- edit-after-send. A correction is a NEW edition that says it is one.
--
-- Enforced here rather than only in the server action, because a disabled
-- button is not a gate — the composer, a stray script and a hand-written
-- PostgREST call must all be refused by the same rule.
--
-- DELETE IS REFUSED TOO. Blocking only UPDATE would leave delete-and-recreate
-- as a way to reconstruct exactly the false record this exists to prevent.
--
-- The service role is exempt from the DELETE branch alone, and that exemption
-- is honest rather than convenient: it is the key that could drop this table
-- outright, so pretending it is fenced would buy nothing, and it is what lets
-- scripts/checks/newsletter.ts remove the year-2099 sent edition it has to
-- create in order to prove the UPDATE branch works. UPDATE has no exemption at
-- all — nothing, at any privilege level, has a reason to rewrite a sent
-- edition.
-- ---------------------------------------------------------------------------
create or replace function public.newsletter_edition_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'sent' then
    return case tg_op when 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' and current_user in ('service_role', 'postgres', 'supabase_admin') then
    return old;
  end if;

  raise exception
    'Edition % was sent on % and is frozen. A sent edition is the record of what the client received; issue a new edition instead.',
    to_char(old.month_of, 'Mon YYYY'), coalesce(to_char(old.sent_at, 'YYYY-MM-DD'), 'an earlier date')
    using errcode = '42501';
end;
$$;

comment on function public.newsletter_edition_frozen() is
  'Refuses any UPDATE to a sent edition, and any DELETE of one except by the service role. Raises 42501 so the app surfaces it as a permission refusal rather than a generic failure.';

-- Not SECURITY DEFINER: it reads only the row already in front of it and needs
-- no rights the caller lacks. Revoked from the API roles all the same — a
-- trigger function has no business being reachable as an RPC.
revoke all on function public.newsletter_edition_frozen() from public, anon, authenticated;

create trigger newsletter_editions_frozen
  before update or delete on public.newsletter_editions
  for each row execute function public.newsletter_edition_frozen();

-- ---------------------------------------------------------------------------
-- RLS — mirrors the operational tables exactly: two policies, read for every
-- active app user, write for curate AND admin.
--
-- Composing an edition is the same kind of act as entering a week of
-- congestion figures or excluding an article, both of which curate can already
-- do. It is not a configuration change. Gating it to admin would mean the
-- person who writes the newsletter cannot save it.
--
-- The composer's server actions run under the CALLER'S client, never the
-- service role, precisely so this policy is the gate rather than the button.
-- ---------------------------------------------------------------------------
alter table public.newsletter_editions enable row level security;

create policy newsletter_editions_select_app_users
  on public.newsletter_editions for select to authenticated
  using (public.is_app_user());

create policy newsletter_editions_curate_write
  on public.newsletter_editions for all to authenticated
  using (public.can_curate()) with check (public.can_curate());

-- Reads are "the edition for this month" and "the months that exist", both
-- served by the unique constraint's index. No further index earns its keep at
-- twelve rows a year.
