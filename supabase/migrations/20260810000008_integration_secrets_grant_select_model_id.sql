-- ============================================================================
-- nestle-scm — grant SELECT on integration_secrets.model_id to authenticated
--
-- Migration 7 added model_id and granted UPDATE (model_id) so admins can swap
-- models, and rebuilt integration_secrets_status (security_invoker = on) to
-- expose model_id. But it never granted SELECT (model_id) on the base table.
-- Because the status view runs with the *invoker's* privileges, any authenticated
-- read of the view — which selects model_id — fails the column-privilege check,
-- so the admin panel's Integrations read returns nothing.
--
-- model_id is explicitly NON-secret (unlike vault_secret_id, which stays ungranted).
-- Granting SELECT on just this column fixes the read while keeping the key pointer
-- invisible to clients. RLS (curate + admin) still gates row visibility.
-- ============================================================================

grant select (model_id) on public.integration_secrets to authenticated;
