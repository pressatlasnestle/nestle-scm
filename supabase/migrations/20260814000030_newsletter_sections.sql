-- ============================================================================
-- nestle-scm — one uniform section shape, written by the model, edited by hand
--
-- Migration 0028 gave the edition five bespoke authored columns, each with its
-- own type, its own form control, its own save path and its own place in the
-- renderer. Five of everything for what is, in every case, a title and some
-- prose.
--
-- They collapse into ONE ordered jsonb array:
--
--   [{ key, title, body, generated_at, edited_at }, ...]
--
-- One shape means one generator, one editor, one save path and one renderer.
-- It also means adding or dropping a section later is a content change rather
-- than a migration, which matters because the section list is an editorial
-- decision and editorial decisions move.
--
-- Verified empty first: select count(*) from newsletter_editions returned 0, so
-- there is nothing to migrate and the old columns can simply go. Over live rows
-- this would be a different job — watch_list held objects and
-- recommended_actions held an array of strings, so both would need converting
-- to prose, and a `sent` snapshot would need reinterpreting, which is a rewrite
-- of a record that is meant never to change.
--
-- THE COLUMNS ARE DROPPED, NOT LEFT BEHIND. A half-migrated table where the old
-- columns still exist and are always null is worse than either state: the next
-- reader cannot tell which is authoritative, and PostgREST will happily accept
-- a write to the dead one.
--
-- WHAT DELIBERATELY DOES NOT CHANGE. included_article_ids, snapshot, sent_at,
-- sent_by, the freeze trigger, both RLS policies and the newsletter.update /
-- newsletter.send audit actions are all exactly as 0028 and 0029 left them.
-- This is a change to how the prose is stored, not to who may write it or to
-- what happens when it is sent.
-- ============================================================================

alter table public.newsletter_editions
  drop column headline_read,
  drop column regional_commentary,
  drop column reliability_note,
  drop column watch_list,
  drop column recommended_actions;

alter table public.newsletter_editions
  add column sections jsonb not null default '[]'::jsonb;

comment on column public.newsletter_editions.sections is
  'Ordered array of [{key, title, body, generated_at, edited_at}]. `key` names the slot the edition renders it in; `title` is the reader-facing heading, not an internal name. generated_at is set when the model wrote the body; edited_at is set when a person did. A section whose body is empty is not rendered at all — no heading, no placeholder line.';

-- ---------------------------------------------------------------------------
-- NO CHECK CONSTRAINT ON THE ARRAY, and that is the same discipline the
-- authored columns carried for the same reason: this is editorial text, and a
-- shape rule in the database would be the database arguing with the person
-- whose judgement the edition exists to carry. The reader (lib/newsletter/
-- sections.ts) is defensive instead — anything it does not recognise is
-- dropped rather than thrown, so a malformed row renders as a shorter edition
-- rather than a broken page.
--
-- NOT NULL DEFAULT '[]' rather than nullable: "no sections yet" and "an empty
-- list of sections" are the same statement here, unlike the operational
-- figures where absent and zero are genuinely different. One representation
-- means the reader never has to ask which null it is looking at.
-- ---------------------------------------------------------------------------

-- edited_at inside the jsonb is what protects a section from the next
-- Generate. It is deliberately NOT a column: it is per-section, and hoisting it
-- would put us back to one column per section, which is what this migration
-- exists to undo.
