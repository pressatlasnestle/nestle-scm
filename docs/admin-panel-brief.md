# Admin Panel — Build Brief

Companion to `schema-brief.md` and `admin-panel-mockup.html`. The mockup shows layout,
tone, and interaction *ideas* — this brief covers what it can't: real data wiring, role
gating, and states a static HTML file has no way to demonstrate. Where they conflict,
this brief wins.

## Stack / conventions
- Next.js (App Router), against the already-migrated Supabase project (`wbxxtreznqdawzhzbstk`).
- Server Components for data fetching where possible; Server Actions for writes
  (create/update/delete) rather than client-side `fetch` to API routes, unless there's
  a specific reason a given action needs to be client-only.
- Use the generated `Database` type (`src/types/database.types.ts`) everywhere —
  no hand-written row interfaces.
- Follow the mockup's visual language (palette, type, the "signal board" health-dot
  pattern) but this is a real app, not a static page — components, not one big file.

## Global behaviors the mockup doesn't show
- **Role gating is real, not cosmetic.** `read` users should not see Users & Roles,
  Integrations, or Audit Log in the sidebar at all — not just have the actions disabled.
  `curate` sees everything except Users & Roles, Integrations, Audit Log (admin-only).
  Resolve role via `current_app_role()` server-side before rendering nav, not by
  hiding elements client-side after the fact.
- **Confirmations are real modals**, not `confirm()`. Same consequence-aware copy as
  the mockup's `data-note` text, but styled to match — a plain `window.confirm` was
  a mockup shortcut, not the intended final UI.
- **Every write shows a real result**: a toast/inline success state on save, and a
  clear error state on failure (e.g. RLS rejection, network error) — don't let a
  failed write silently look like it worked.
- **Empty states matter.** Zero sources, zero keywords, zero recipients — each needs
  a real "nothing here yet" state with the add-form still usable, not just an empty
  table shell.
- **Loading states**: skeleton or spinner while each table's initial query resolves —
  don't flash empty-then-populated.
- No pagination needed yet at this data volume (handful of sources/keywords/users) —
  don't build it preemptively; flag if any table looks likely to exceed ~50 rows soon.

## Per-section wiring

**Media Universe**
- Table reads from `sources`. Universe-mode toggle reads/writes `app_settings`
  (`key = 'universe_mode'`).
- Add-source form inserts into `sources`; delete removes the row (hard delete is
  correct per schema brief — `articles.source_id` is `ON DELETE SET NULL`, so this
  is safe). Confirm modal uses the mockup's per-source consequence copy.
- Health column (`last_fetched_at`, `last_fetch_status`, `last_fetch_error`) is
  read-only — populated by the ingestion pipeline, not editable here.

**Keywords**
- Straightforward CRUD against `keywords`. Delete is a real hard delete (safe, per
  schema brief — no FK dependency).

**Users & Roles**
- Reads `profiles`. Role changes are an `UPDATE profiles SET role = ...` gated by
  the existing RLS (admin-only). "Invite user" — for now, this can be an admin
  manually setting a role after the person signs up themselves (the `on_auth_user_created`
  trigger already auto-provisions them as `read`); a proper email-invite flow can come
  later if needed — don't over-build this for a pro-bono test.

**Integrations**
- `SELECT` from `integration_secrets_status` (never the base table) for display.
- "Set key" / "Replace key" submits through the `set_integration_secret()` RPC —
  never a direct table write. Input should be cleared immediately on submit; never
  echo the typed value back after save.
- "Save model" is a plain `UPDATE integration_secrets SET model_id = ...` — this one
  *can* go through the normal client path, since the column grant already restricts
  it to `model_id` only. No RPC needed for this one.
- Card order: Gemini, Claude, News Aggregator, Resend (matches mockup).

**Recipients**
- CRUD against `report_recipients`. Keep visually and structurally distinct from
  Users & Roles — different table, different purpose, no login implied.

**Audit Log**
- Read-only, admin-gated, from `audit_log`. Filter by actor/action client-side is
  fine at this volume — no need for server-side search yet.

## Explicit non-goals for this pass
- No pagination, no bulk actions, no CSV export — add later if the data volume
  justifies it.
- No email-invite flow for new users yet (see Users & Roles above).
- No mobile-specific layout pass — responsive-safe is enough, this is an internal
  ops tool primarily used on desktop.

## Acceptance check before calling this done
- A `read` user cannot see or reach Users & Roles, Integrations, or Audit Log —
  confirm this by actually logging in as one, not just by reading the code.
- Deleting a source/keyword actually removes it and the confirm copy matches the
  consequence.
- Setting a Gemini/Claude/Resend/News-Aggregator key never displays the value again
  anywhere — check network tab too, not just the rendered UI.
- Changing a model ID does not require re-entering the key.
- Universe-mode toggle actually persists (reload the page, confirm it stuck).
