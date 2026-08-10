import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";

/**
 * Service-role Supabase client. BYPASSES RLS entirely — it has full admin
 * powers over the project. Use ONLY in trusted server code, and ONLY after an
 * independent authorization check (e.g. requireAdmin()), never on the strength
 * of RLS, because RLS does not apply to this client.
 *
 * The service-role key is server-only: it is read from SUPABASE_SERVICE_ROLE_KEY
 * (NOT NEXT_PUBLIC_*) so it is never shipped to the browser. Keep the set of
 * callers of this helper as small as possible.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "Admin client not configured: set SUPABASE_SERVICE_ROLE_KEY (server-only) in the environment."
    );
  }

  return createClient<Database>(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
