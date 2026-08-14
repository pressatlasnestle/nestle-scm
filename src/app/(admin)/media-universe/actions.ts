"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionContext } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/actions/result";
import { runForSource } from "@/lib/ingestion/run";

export type UniverseMode = "whole_universe" | "positive_only";
export type ListTypeInput = "neutral" | "positive" | "negative";

const PATH = "/media-universe";

export async function addSource(input: {
  name: string;
  rssUrl: string;
  listType: ListTypeInput;
  category: string;
}): Promise<ActionResult> {
  const name = input.name.trim();
  const rssUrl = input.rssUrl.trim();
  const category = input.category.trim();

  if (!name) return { ok: false, error: "Source name is required." };

  const { userId } = await getSessionContext();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("sources")
    .insert({
      name,
      rss_url: rssUrl || null,
      list_type: input.listType === "neutral" ? null : input.listType,
      category: category || null,
      added_by: userId,
      // Derived from whether a feed was actually supplied. A source added
      // without a URL is not fetchable by definition, and marking it so here
      // is what keeps the fetcher from logging a failure for it on every run
      // forever — the state 21 existing sources were in.
      is_fetchable: Boolean(rssUrl),
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: toActionError(error) };

  // source_added run: a newly added source should not sit blank until the next
  // scheduled run. after() defers it past the response so the admin isn't kept
  // waiting on a network fetch, and a failed ingest never fails the add — the
  // run is logged to ingestion_runs either way.
  //
  // Only when there is something to fetch. Firing a run for a source with no
  // feed would produce an ingestion_runs row whose only content is the error
  // that the source has no feed, which is not news to anyone.
  if (data?.id && rssUrl) {
    const sourceId = data.id;
    after(async () => {
      try {
        await runForSource(createAdminClient(), sourceId, userId);
      } catch (err) {
        console.error("[ingestion] source_added run failed:", err);
      }
    });
  }

  revalidatePath(PATH);
  return { ok: true };
}

export async function deleteSource(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("sources").delete().eq("id", id);
  if (error) return { ok: false, error: toActionError(error) };
  revalidatePath(PATH);
  return { ok: true };
}

export async function setSourceActive(
  id: string,
  active: boolean
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("sources")
    .update({ is_active: active })
    .eq("id", id);
  if (error) return { ok: false, error: toActionError(error) };
  revalidatePath(PATH);
  return { ok: true };
}

/**
 * Toggles whether a source is fetched for RSS.
 *
 * Separate from setSourceActive() because they answer different questions.
 * is_active is "do we monitor this at all"; is_fetchable is "does this have a
 * feed to read". A paywalled publisher with no feed is very much still
 * monitored — the aggregator sweeps cover it — it just cannot be asked for RSS.
 * Collapsing the two would have meant deactivating Lloyd's List to stop it
 * failing, which would also have removed it from the universe.
 */
export async function setSourceFetchable(
  id: string,
  fetchable: boolean
): Promise<ActionResult> {
  const supabase = await createClient();

  if (fetchable) {
    // Turning it back on without a feed would restore exactly the behaviour
    // this flag exists to stop: one logged failure per run, forever.
    const { data } = await supabase
      .from("sources")
      .select("rss_url")
      .eq("id", id)
      .maybeSingle();

    if (!data?.rss_url?.trim()) {
      return {
        ok: false,
        error:
          "This source has no RSS URL, so there is nothing to fetch. Add a feed URL first.",
      };
    }
  }

  const { error } = await supabase
    .from("sources")
    .update({ is_fetchable: fetchable })
    .eq("id", id);
  if (error) return { ok: false, error: toActionError(error) };
  revalidatePath(PATH);
  return { ok: true };
}

export async function setUniverseMode(mode: UniverseMode): Promise<ActionResult> {
  const { userId } = await getSessionContext();
  const supabase = await createClient();

  const { error } = await supabase.from("app_settings").upsert(
    {
      key: "universe_mode",
      value: mode,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );

  if (error) return { ok: false, error: toActionError(error) };
  revalidatePath(PATH);
  return { ok: true };
}
