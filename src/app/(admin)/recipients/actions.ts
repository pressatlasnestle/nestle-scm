"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/actions/result";

const PATH = "/recipients";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function addRecipient(input: {
  name: string;
  email: string;
}): Promise<ActionResult> {
  const name = input.name.trim();
  const email = input.email.trim();

  if (!email) return { ok: false, error: "Email address is required." };
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };

  const { userId } = await getSessionContext();
  const supabase = await createClient();

  const { error } = await supabase
    .from("report_recipients")
    .insert({ name: name || null, email, added_by: userId });

  if (error) return { ok: false, error: toActionError(error) };
  revalidatePath(PATH);
  return { ok: true };
}

export async function deleteRecipient(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("report_recipients").delete().eq("id", id);
  if (error) return { ok: false, error: toActionError(error) };
  revalidatePath(PATH);
  return { ok: true };
}

export async function setRecipientActive(
  id: string,
  active: boolean
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("report_recipients")
    .update({ is_active: active })
    .eq("id", id);
  if (error) return { ok: false, error: toActionError(error) };
  revalidatePath(PATH);
  return { ok: true };
}
