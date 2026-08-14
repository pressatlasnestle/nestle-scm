"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getSessionContext } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/actions/result";
import type { Json } from "@/types/database.types";
import { monthFromIso, parseMonthParam } from "@/lib/newsletter/month";
import {
  buildGenerated,
  readAuthored,
  sectionStates,
  subjectLine,
  type WatchListEntry,
} from "@/lib/newsletter/edition";
import { loadBaseUrl, loadEdition } from "@/lib/newsletter/load";
import { renderEditionHtml } from "@/lib/newsletter/email";
import { buildSnapshot, snapshotToJson } from "@/lib/newsletter/snapshot";

const PATH = "/newsletter";

/**
 * Composing and sending an edition.
 *
 * These run under the CALLER'S client, never the service role. There is no
 * secret to reach and nothing to work around: newsletter_editions carries a
 * can_curate() write policy exactly so the database enforces the same rule the
 * button does. An admin client here would bypass that and leave the disabled
 * button as the only gate.
 *
 * Every write is logged to audit_log — 'newsletter.update' and
 * 'newsletter.send'. The row holds only the LATEST authored text, so the audit
 * trail is the history of what the edition said and who said it. That matters
 * more here than for most tables: this text goes to the client under the desk's
 * name.
 */

async function requireCurate() {
  const ctx = await getSessionContext();
  if (!ctx.canCurate) {
    return { ctx: null as null, error: "You don't have permission to do that." };
  }
  return { ctx, error: null as string | null };
}

/**
 * Maps a write failure to copy.
 *
 * The freeze trigger raises 42501 with a message written for a person to read,
 * and the generic mapper would flatten it to "You don't have permission to do
 * that" — which is true but tells the curator nothing about why. Passed through
 * verbatim instead.
 */
function toEditionError(error: { message?: string } | null): string {
  const message = error?.message ?? "";
  if (/is frozen/i.test(message)) return message;
  return toActionError(error);
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Watch-list rows with nothing in them are not entries; they are blank rows. */
function cleanWatchList(entries: WatchListEntry[] | undefined): Json {
  return (entries ?? [])
    .map((e) => ({
      risk: trimmed(e.risk),
      lanes: trimmed(e.lanes),
      window: trimmed(e.window),
      direction: trimmed(e.direction),
    }))
    .filter((e) => e.risk || e.lanes || e.window || e.direction) as Json;
}

function cleanActions(actions: string[] | undefined): Json {
  return (actions ?? []).map(trimmed).filter(Boolean) as Json;
}

export type EditionDraftInput = {
  /** Any date inside the month; snapped to the 1st. */
  monthStart: string;
  headlineRead?: string;
  regionalCommentary?: string;
  reliabilityNote?: string;
  watchList?: WatchListEntry[];
  recommendedActions?: string[];
  /**
   * The curator's press selection, or null while nothing has been toggled.
   * Null and [] are different: null means "not curated, everything is in",
   * [] means "every candidate was toggled out".
   */
  includedArticleIds?: string[] | null;
};

/**
 * Writes the authored half of a draft.
 *
 * Upserts on month_of, so the first save creates the edition and every later
 * one replaces it. Nothing generated is written — no figure, no press item, no
 * rendered HTML. Those are read fresh on every view, which is what lets a
 * draft follow the operational data as more days are entered.
 */
export async function saveEdition(
  input: EditionDraftInput
): Promise<ActionResult> {
  const { ctx, error } = await requireCurate();
  if (!ctx) return { ok: false, error: error! };

  const parsed = parseMonthParam(input.monthStart);
  if (!parsed) return { ok: false, error: "That is not a valid month." };
  const month = monthFromIso(parsed);

  const supabase = await createClient();

  // Read first so a sent edition is refused with the reason rather than with a
  // constraint error. The trigger is still the gate — this is the message.
  const { data: existing } = await supabase
    .from("newsletter_editions")
    .select("status, sent_at")
    .eq("month_of", month.start)
    .maybeSingle();

  if (existing?.status === "sent") {
    return {
      ok: false,
      error: `The ${month.label} edition was sent and is frozen. Issue a new edition rather than editing this one.`,
    };
  }

  const payload = {
    month_of: month.start,
    status: "draft",
    headline_read: trimmed(input.headlineRead) || null,
    regional_commentary: trimmed(input.regionalCommentary) || null,
    reliability_note: trimmed(input.reliabilityNote) || null,
    watch_list: cleanWatchList(input.watchList),
    recommended_actions: cleanActions(input.recommendedActions),
    included_article_ids:
      input.includedArticleIds === undefined ? null : input.includedArticleIds,
    entered_by: ctx.userId,
    entered_at: new Date().toISOString(),
  };

  const { error: writeError } = await supabase
    .from("newsletter_editions")
    .upsert(payload, { onConflict: "month_of" });
  if (writeError) return { ok: false, error: toEditionError(writeError) };

  await supabase.from("audit_log").insert({
    actor_id: ctx.userId,
    action: "newsletter.update",
    target_type: "newsletter_edition",
    target_id: null,
    // The full authored text, because the row keeps only the latest version and
    // "what did the September read say before it was rewritten" has to be
    // answerable for something that goes out under the desk's name.
    metadata: {
      month_of: month.start,
      headline_read: payload.headline_read,
      regional_commentary: payload.regional_commentary,
      reliability_note: payload.reliability_note,
      watch_list: payload.watch_list,
      recommended_actions: payload.recommended_actions,
      included_article_count: payload.included_article_ids?.length ?? null,
    },
  });

  revalidatePath(PATH);
  return { ok: true };
}

export type SendResult = ActionResult & { subject?: string };

/**
 * Freezes and sends an edition.
 *
 * Saves the draft first so what is frozen is what the curator was looking at,
 * then RE-READS the stored row and recomputes every generated value server-side
 * before building the snapshot. The client's rendering is never trusted as the
 * record: it is the record of what the client's JavaScript believed, which is
 * not the same thing.
 *
 * The status flip carries `.eq("status", "draft")` so a second send — a double
 * click, two tabs — matches zero rows and reports that it was already sent,
 * rather than overwriting the first snapshot with a later recomputation.
 *
 * "Send" here means "freeze and export". There is no SMTP and no distribution
 * list; delivery is the curator pasting the body into Outlook, exactly as every
 * prior edition travelled.
 */
export async function sendEdition(
  input: EditionDraftInput
): Promise<SendResult> {
  const { ctx, error } = await requireCurate();
  if (!ctx) return { ok: false, error: error! };

  const parsed = parseMonthParam(input.monthStart);
  if (!parsed) return { ok: false, error: "That is not a valid month." };
  const month = monthFromIso(parsed);

  const saved = await saveEdition(input);
  if (!saved.ok) return saved;

  const supabase = await createClient();

  const { data: row, error: readError } = await supabase
    .from("newsletter_editions")
    .select(
      "status, headline_read, regional_commentary, reliability_note, watch_list, recommended_actions, included_article_ids"
    )
    .eq("month_of", month.start)
    .maybeSingle();

  if (readError) return { ok: false, error: toEditionError(readError) };
  if (!row) {
    return { ok: false, error: "That edition could not be read back to send." };
  }
  if (row.status === "sent") {
    return {
      ok: false,
      error: `The ${month.label} edition has already been sent.`,
    };
  }

  const [{ input: editionInput }, baseUrl] = await Promise.all([
    loadEdition(supabase, month, row.included_article_ids),
    loadBaseUrl(supabase),
  ]);

  const generated = buildGenerated(editionInput);
  const authored = readAuthored(row);
  const sections = sectionStates(generated, authored);
  const edition = { generated, authored, sections };

  // An edition with no section at all would be a header and a sign-off. That is
  // not a correction-worthy edge case to render politely around; it is a sign
  // that nothing has been written or entered yet.
  if (!sections.some((s) => s.present)) {
    return {
      ok: false,
      error:
        "This edition has no content — nothing authored and no figures entered. There is nothing to freeze.",
    };
  }

  const sentAt = new Date().toISOString();
  const snapshot = buildSnapshot({
    edition,
    subject: subjectLine(month),
    html: renderEditionHtml(edition, { baseUrl }),
    sentAt,
    sentByName: ctx.fullName ?? ctx.email,
  });

  const { data: updated, error: sendError } = await supabase
    .from("newsletter_editions")
    .update({
      status: "sent",
      snapshot: snapshotToJson(snapshot),
      sent_at: sentAt,
      sent_by: ctx.userId,
    })
    .eq("month_of", month.start)
    .eq("status", "draft")
    .select("id");

  if (sendError) return { ok: false, error: toEditionError(sendError) };
  if (!updated || updated.length === 0) {
    return {
      ok: false,
      error: `The ${month.label} edition was sent by someone else while this one was open.`,
    };
  }

  await supabase.from("audit_log").insert({
    actor_id: ctx.userId,
    action: "newsletter.send",
    target_type: "newsletter_edition",
    target_id: updated[0].id,
    metadata: {
      month_of: month.start,
      subject: snapshot.subject,
      sections_included: sections.filter((s) => s.present).map((s) => s.key),
      sections_dropped: sections.filter((s) => !s.present).map((s) => s.key),
      press_shown: generated.press.shown,
      press_candidates: generated.press.candidates,
      source_count: generated.sourceCount,
    },
  });

  revalidatePath(PATH);
  return { ok: true, subject: snapshot.subject };
}
