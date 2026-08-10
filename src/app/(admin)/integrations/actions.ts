"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/actions/result";

const PATH = "/integrations";
const PROVIDERS = ["gemini", "claude", "news_aggregator", "resend"] as const;
type Provider = (typeof PROVIDERS)[number];

/**
 * Sets or rotates a provider API key via the Vault-backed RPC. The plaintext
 * value is passed straight to the RPC and never returned or logged here — the
 * RPC stores only last_four + a Vault pointer.
 */
export async function setIntegrationKey(
  provider: string,
  secretValue: string
): Promise<ActionResult> {
  await requireAdmin();

  if (!PROVIDERS.includes(provider as Provider)) {
    return { ok: false, error: "Unknown provider." };
  }
  if (!secretValue.trim()) {
    return { ok: false, error: "Enter an API key." };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_integration_secret", {
    p_provider: provider,
    p_secret_value: secretValue,
  });

  if (error) return { ok: false, error: toActionError(error) };
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Updates only model_id via the column-scoped UPDATE path — no Vault call, no
 * key required. Only works once the provider row exists (i.e. a key has been
 * set at least once); a 0-row update is surfaced as an explicit message rather
 * than a silent no-op.
 */
export async function saveIntegrationModel(
  provider: string,
  modelId: string
): Promise<ActionResult> {
  await requireAdmin();

  if (!PROVIDERS.includes(provider as Provider)) {
    return { ok: false, error: "Unknown provider." };
  }

  const supabase = await createClient();

  // model_id lives on the provider's key record, which only exists once a key
  // has been set (authenticated clients cannot INSERT the row — only the RPC can).
  // Verify existence via the status view before attempting the update.
  const { data: existing } = await supabase
    .from("integration_secrets_status")
    .select("provider")
    .eq("provider", provider)
    .maybeSingle();

  if (!existing) {
    return {
      ok: false,
      error:
        "Set an API key for this provider first — the model is stored on the provider's key record.",
    };
  }

  // No .select() here on purpose: RETURNING would require table-level SELECT,
  // but the schema grants only column-level SELECT (to keep vault_secret_id
  // hidden). The column-scoped UPDATE (model_id) grant + admin RLS is enough.
  const { error } = await supabase
    .from("integration_secrets")
    .update({ model_id: modelId.trim() || null })
    .eq("provider", provider);

  if (error) return { ok: false, error: toActionError(error) };
  revalidatePath(PATH);
  return { ok: true };
}
