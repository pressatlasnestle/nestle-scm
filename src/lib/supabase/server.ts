import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Database } from "@/types/database.types";

/**
 * Server-side Supabase client bound to the request's auth cookies.
 * Use in Server Components (reads) and Server Actions (writes). Every query
 * runs as the logged-in user, so RLS is enforced — this client never has
 * service-role powers.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          // In a Server Component this throws (read-only cookies); that's fine —
          // session refresh happens in middleware. Server Actions / Route
          // Handlers can set, so we still attempt it.
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // no-op: called from a Server Component render
          }
        },
      },
    }
  );
}
