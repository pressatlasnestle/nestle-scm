/**
 * Proves SUPABASE_SERVICE_ROLE_KEY is a real service-role credential before
 * anything writes production data.
 *
 *   npx tsx --env-file=.env.local scripts/checks/service-role.ts
 *
 * Read-only. Never prints the key or any secret value.
 *
 * The point is elevated access, not connectivity. The anon key is a *working*
 * credential — it constructs a client and reads app_settings quite happily — so
 * a check that only proved "it connects" would pass on the placeholder. Checks
 * 3 and 4 are the discriminating ones: `integration_secrets` has all privileges
 * revoked from anon and authenticated, and get_integration_secret() is granted
 * to service_role alone.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const results: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail: string) {
  results.push({ name, ok, detail });
}

function decodeRole(token: string): { label: string; ok: boolean } {
  // Newer Supabase projects issue opaque keys rather than JWTs. This project's
  // publishable key is already in that format, so the secret may be too.
  if (token.startsWith("sb_publishable_")) {
    return { label: "publishable key — this is the browser key, not a secret", ok: false };
  }
  if (token.startsWith("sb_secret_")) {
    // No claims to read; checks 3 and 4 carry the proof instead.
    return { label: "sb_secret_* (opaque secret key, no role claim to decode)", ok: true };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return { label: "not a JWT and not an sb_secret_* key — malformed", ok: false };
  }
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8")
    ) as { role?: string; ref?: string };
    return {
      label: `JWT role="${payload.role}" ref="${payload.ref}"`,
      ok: payload.role === "service_role",
    };
  } catch {
    return { label: "JWT payload did not decode", ok: false };
  }
}

async function main() {
  if (!url) throw new Error("NEXT_PUBLIC_SUPABASE_URL is not set.");
  if (!key || !key.trim()) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is empty — fill it in .env.local before running this."
    );
  }

  // --- 1. role claim ------------------------------------------------------
  const role = decodeRole(key.trim());
  record("1. key format / role claim", role.ok, role.label);

  const client = createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // --- 2. app_settings: the credential is accepted at all -----------------
  const settings = await client.from("app_settings").select("key, value");
  record(
    "2. read app_settings",
    !settings.error,
    settings.error
      ? settings.error.message
      : `${settings.data?.length ?? 0} rows (${(settings.data ?? [])
          .map((r) => r.key)
          .join(", ")})`
  );

  // --- 3. integration_secrets: RLS bypass, the real proof -----------------
  const secrets = await client
    .from("integration_secrets")
    .select("provider, is_set");
  record(
    "3. read integration_secrets (RLS bypass)",
    !secrets.error && (secrets.data?.length ?? 0) > 0,
    secrets.error
      ? `${secrets.error.code ?? "?"} ${secrets.error.message}`
      : `${secrets.data?.length ?? 0} providers (${(secrets.data ?? [])
          .map((r) => r.provider)
          .join(", ")})`
  );

  // --- 4. the service_role-only RPC from migration 19 ---------------------
  const rpc = await client.rpc("get_integration_secret", {
    p_provider: "news_aggregator",
  });
  const secretLen = typeof rpc.data === "string" ? rpc.data.length : 0;
  record(
    "4. rpc get_integration_secret (service_role grant)",
    !rpc.error && secretLen > 0,
    rpc.error
      ? `${rpc.error.code ?? "?"} ${rpc.error.message}`
      : `returned a ${secretLen}-char secret (value not printed)`
  );

  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}\n        ${r.detail}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  if (failed > 0) {
    console.log(
      "\nDo NOT run the backfill. The key is the placeholder, the wrong key, or malformed."
    );
  }
  process.exit(failed === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
