import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import {
  STAGE_FALLBACK_MODEL,
  STAGE_LABEL,
  STAGE_SETTING_KEY,
} from "@/lib/analysis/models";
import { IntegrationCard, type ProviderStatus } from "./IntegrationCard";

export const dynamic = "force-dynamic";

// Card order per brief: Gemini, Claude, News Aggregator, Resend.
const PROVIDER_META: Omit<
  ProviderStatus,
  "isSet" | "lastFour" | "modelId" | "updatedByEmail" | "updatedAt"
>[] = [
  {
    provider: "gemini",
    name: "Gemini",
    role: "Article sorting & coding",
    // Gemini's model ids are per-stage and live in app_settings, not on the key
    // record — filled in below, where the settings have been read.
    hasModel: false,
    notConfiguredNote:
      "No key has been set for this provider yet. Sorting and coding will fail until one is.",
  },
  {
    provider: "claude",
    name: "Claude",
    role: "Report narrative generation",
    hasModel: true,
    modelPlaceholder: "claude-haiku-4-5",
    notConfiguredNote:
      "No key has been set for this provider yet. The model is stored alongside the key.",
  },
  {
    provider: "news_aggregator",
    name: "News Aggregator",
    role: "Whole-universe keyword search, beyond listed RSS sources",
    hasModel: false,
    notConfiguredNote:
      "Google News / RSS search API key. No key has been set for this provider yet.",
  },
  {
    provider: "resend",
    name: "Resend",
    role: "Monday digest delivery",
    hasModel: false,
    notConfiguredNote: "No key has been set for this provider yet.",
  },
];

type StatusRow = {
  provider: string | null;
  is_set: boolean | null;
  last_four: string | null;
  model_id: string | null;
  updated_by: string | null;
  updated_at: string | null;
};

export default async function IntegrationsPage() {
  await requireAdmin();
  const supabase = await createClient();

  // Display reads from the status VIEW, never the base table.
  const { data: statusRows } = await supabase
    .from("integration_secrets_status")
    .select("provider, is_set, last_four, model_id, updated_by, updated_at");

  const rows = (statusRows as StatusRow[] | null) ?? [];

  // Resolve updated_by uuids → emails for the "last updated by" line.
  const editorIds = [...new Set(rows.map((r) => r.updated_by).filter(Boolean))] as string[];
  const emailById = new Map<string, string | null>();
  if (editorIds.length > 0) {
    const { data: profs } = await supabase
      .from("profiles")
      .select("id, email")
      .in("id", editorIds);
    for (const p of profs ?? []) emailById.set(p.id, p.email);
  }

  const byProvider = new Map(rows.map((r) => [r.provider, r]));

  // Per-stage Gemini models live in app_settings, alongside universe_mode.
  const { data: settingRows } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", [STAGE_SETTING_KEY.sorting, STAGE_SETTING_KEY.coding]);

  const settingValue = (key: string, fallback: string) => {
    const v = settingRows?.find((r) => r.key === key)?.value;
    return typeof v === "string" && v.trim() ? v : fallback;
  };

  const cards: ProviderStatus[] = PROVIDER_META.map((meta) => {
    const row = byProvider.get(meta.provider);
    return {
      ...meta,
      isSet: row?.is_set ?? false,
      lastFour: row?.last_four ?? null,
      modelId: row?.model_id ?? null,
      updatedByEmail: row?.updated_by ? emailById.get(row.updated_by) ?? null : null,
      updatedAt: row?.updated_at ?? null,
      ...(meta.provider === "gemini"
        ? {
            stageModels: [
              {
                settingKey: STAGE_SETTING_KEY.sorting,
                label: STAGE_LABEL.sorting,
                value: settingValue(
                  STAGE_SETTING_KEY.sorting,
                  STAGE_FALLBACK_MODEL.sorting
                ),
                placeholder: STAGE_FALLBACK_MODEL.sorting,
                hint: "Runs automatically on every article an ingestion run captures — one call each. Keep this one cheap.",
              },
              {
                settingKey: STAGE_SETTING_KEY.coding,
                label: STAGE_LABEL.coding,
                value: settingValue(
                  STAGE_SETTING_KEY.coding,
                  STAGE_FALLBACK_MODEL.coding
                ),
                placeholder: STAGE_FALLBACK_MODEL.coding,
                hint: "Runs only when an analyst triggers AI Analysis on a reviewed batch. Can afford a stronger model.",
              },
            ],
          }
        : {}),
    };
  });

  return (
    <>
      <div className="panel-head">
        <div>
          <h1>Integrations</h1>
          <p>
            API keys are stored encrypted in Supabase Vault. Values are never
            shown once saved — only masked status.
          </p>
        </div>
      </div>

      <div className="integration-grid">
        {cards.map((c) => (
          <IntegrationCard key={c.provider} status={c} />
        ))}
      </div>

      <div className="panel-foot-note">
        Model IDs are plain config, not secrets — changing one takes effect on
        the next run, no redeploy needed. Gemini&rsquo;s two models are read
        fresh per call and are never cached, so a change here applies to the
        very next sorting or coding run.
      </div>
    </>
  );
}
