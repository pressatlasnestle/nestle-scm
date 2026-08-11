import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

/**
 * Per-stage model selection for the AI Brain.
 *
 * The Gemini API key stays in integration_secrets (Vault-backed, service-role
 * decrypt via get_integration_secret). Only the *model id* lives here, in
 * app_settings, and it splits in two because the stages have different
 * economics: sorting fires automatically on every ingested article and wants
 * the cheapest model that can judge relevance; coding runs on analyst-triggered
 * batches and can afford a stronger one.
 *
 * integration_secrets.gemini.model_id is superseded by these keys. The column
 * still exists — Claude's report-narrative model uses it — but the Gemini card
 * no longer edits it and nothing in this directory reads it.
 */

export type AnalysisClient = SupabaseClient<Database>;

export type AnalysisStage = "sorting" | "coding";

export const STAGE_SETTING_KEY: Record<AnalysisStage, string> = {
  sorting: "sorting_model_id",
  coding: "coding_model_id",
};

/** Every app_settings key this module is willing to write, for validating input. */
export const STAGE_MODEL_KEYS: readonly string[] = Object.values(STAGE_SETTING_KEY);

/**
 * Used only when the app_settings row is missing entirely — migration 0022
 * seeds both, so in practice this covers a database that predates it rather
 * than an operator clearing the field (the admin action rejects a blank value).
 */
export const STAGE_FALLBACK_MODEL: Record<AnalysisStage, string> = {
  sorting: "gemini-3.5-flash-lite",
  coding: "gemini-3.6-flash",
};

export const STAGE_LABEL: Record<AnalysisStage, string> = {
  sorting: "Sorting model",
  coding: "Coding model",
};

/**
 * Reads the model id for a stage. Deliberately NOT cached at module scope:
 * an admin changing the model in Integrations must take effect on the very
 * next run, and a module-level cache would survive across calls inside one
 * warm serverless instance and silently keep using the old value.
 */
export async function getStageModel(
  client: AnalysisClient,
  stage: AnalysisStage
): Promise<string> {
  const { data } = await client
    .from("app_settings")
    .select("value")
    .eq("key", STAGE_SETTING_KEY[stage])
    .maybeSingle();

  // app_settings.value is jsonb; a model id is stored as a JSON string, so a
  // valid row deserialises to a plain string here.
  return typeof data?.value === "string" && data.value.trim()
    ? data.value.trim()
    : STAGE_FALLBACK_MODEL[stage];
}
