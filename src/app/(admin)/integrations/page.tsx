import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
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
    role: "Article analysis & summarization",
    hasModel: true,
    modelPlaceholder: "gemini-2.5-flash",
    notConfiguredNote:
      "No key has been set for this provider yet. The model is stored alongside the key.",
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

  const cards: ProviderStatus[] = PROVIDER_META.map((meta) => {
    const row = byProvider.get(meta.provider);
    return {
      ...meta,
      isSet: row?.is_set ?? false,
      lastFour: row?.last_four ?? null,
      modelId: row?.model_id ?? null,
      updatedByEmail: row?.updated_by ? emailById.get(row.updated_by) ?? null : null,
      updatedAt: row?.updated_at ?? null,
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
        the next run, no redeploy needed.
      </div>
    </>
  );
}
