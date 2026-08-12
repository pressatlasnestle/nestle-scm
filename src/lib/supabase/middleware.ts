import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/types/database.types";

/**
 * Refreshes the Supabase auth session on every request and redirects
 * unauthenticated users to /login. Kept minimal per @supabase/ssr guidance:
 * do not run other logic between client creation and getUser().
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;

  // Pages anyone may reach without a session.
  const isPublicPage = path === "/login" || path.startsWith("/auth");

  /**
   * API routes are never redirected to /login. They authenticate themselves.
   *
   * This is not a relaxation of the auth model — it is the fix for a real
   * outage. pg_cron POSTs to /api/ingestion/run carrying a shared secret and
   * NO session cookie, so the redirect below fired. NextResponse.redirect()
   * defaults to 307, which PRESERVES the method, and pg_net follows redirects
   * — so the POST was replayed against the /login PAGE, which has no POST
   * handler. The result was a 405 on a route whose POST export was correct all
   * along, and the scheduled ingestion silently did nothing.
   *
   * The session is still refreshed for these requests (we fall through to
   * supabaseResponse rather than returning early), so an admin calling an API
   * route from the browser keeps working exactly as before.
   *
   * The contract this creates: any route under /api that needs authorisation
   * MUST check it in its own handler. /api/ingestion/run does — shared secret
   * or admin role — before it constructs the service-role client.
   */
  const isApi = path.startsWith("/api/");

  if (!user && !isPublicPage && !isApi) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && path === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
