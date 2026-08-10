import { PostgrestError } from "@supabase/supabase-js";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Maps a Postgres/RLS error to user-facing copy. */
export function toActionError(
  error: PostgrestError | { message?: string } | null,
  fallback = "Something went wrong. Please try again."
): string {
  if (!error) return fallback;
  const code = (error as PostgrestError).code;
  const msg = (error as PostgrestError).message ?? "";

  // RLS / privilege rejections
  if (code === "42501" || /permission denied|violates row-level/i.test(msg)) {
    return "You don't have permission to do that.";
  }
  // Unique violation
  if (code === "23505") {
    return "That already exists.";
  }
  return msg || fallback;
}
