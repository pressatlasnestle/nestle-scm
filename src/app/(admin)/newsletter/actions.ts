"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSessionContext } from "@/lib/auth";
import { toActionError, type ActionResult } from "@/lib/actions/result";
import type { Json } from "@/types/database.types";
import { parseIsoDate, weekContainingDate } from "@/lib/analysis/week-period";
import { weekRangeLabel } from "@/lib/newsletter/week";
import {
  buildEdition,
  isEmptyEdition,
  subjectLine,
} from "@/lib/newsletter/edition";
import {
  applyEdit,
  mergeGenerated,
  parseSections,
  sectionsToJson,
  slotFor,
  SECTION_KEYS,
  type EditionSection,
  type SectionKey,
} from "@/lib/newsletter/sections";
import { generateSections } from "@/lib/newsletter/generate";
import { loadBaseUrl, loadEdition } from "@/lib/newsletter/load";
import { renderEditionHtml } from "@/lib/newsletter/email";
import { buildSnapshot, snapshotToJson } from "@/lib/newsletter/snapshot";

const PATH = "/newsletter";

/**
 * Composing and sending an edition.
 *
 * WHICH CLIENT DOES WHAT, and why it is split.
 *
 * Every DATABASE write runs under the CALLER'S client, because
 * newsletter_editions carries a can_curate() write policy precisely so the
 * database enforces the same rule the button does. An admin client here would
 * bypass that and leave the disabled button as the only gate.
 *
 * The LLM call is the one exception, and it has to be: get_integration_secret()
 * — the Vault decrypt for the Gemini key — is granted to service_role alone
 * (migration 0019). So the admin client is constructed for that call and that
 * call only, AFTER the authorisation check, and the result comes back as plain
 * text that is then written under the caller's client. Same ordering the
 * ingestion route and the Analysis regenerate action use.
 *
 * Every write is logged to audit_log as 'newsletter.update' or
 * 'newsletter.send'. The row holds only the current text, so the audit trail is
 * the history of what the edition said and who — or what — said it.
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
 * that" — true, but it tells the curator nothing about why. Passed through
 * verbatim instead.
 */
function toEditionError(error: { message?: string } | null): string {
  const message = error?.message ?? "";
  if (/is frozen/i.test(message)) return message;
  return toActionError(error);
}

type Client = Awaited<ReturnType<typeof createClient>>;

/**
 * The one shape every action here works on: an existing draft, or a new one.
 *
 * A sent edition is refused HERE, with the reason, rather than being left to
 * trip the freeze trigger and surface as a constraint error. The trigger is
 * still the gate — nothing reaches the database without passing it — this is
 * just the sentence a person can act on.
 */
type OpenDraft =
  | { ok: false; error: string }
  | {
      ok: true;
      week: ReturnType<typeof weekContainingDate>;
      supabase: Client;
      sections: EditionSection[];
      includedArticleIds: string[] | null;
      /** False for a week that has never been saved. */
      exists: boolean;
    };

async function openDraft(weekStart: string): Promise<OpenDraft> {
  const parsed = parseIsoDate(weekStart);
  if (!parsed) return { ok: false, error: "That is not a valid week." };
  const week = weekContainingDate(parsed);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("newsletter_editions")
    .select("status, sections, included_article_ids")
    .eq("week_of", week.start)
    .maybeSingle();

  if (error) return { ok: false, error: toEditionError(error) };
  if (data?.status === "sent") {
    return {
      ok: false,
      error: `The edition for ${weekRangeLabel(week)} was sent and is frozen. Issue a new edition rather than editing this one.`,
    };
  }

  return {
    ok: true,
    week,
    supabase,
    sections: parseSections(data?.sections ?? null),
    includedArticleIds: data?.included_article_ids ?? null,
    exists: Boolean(data),
  };
}

/**
 * Upserts the draft under the caller's client.
 *
 * A field left undefined is not written at all, so saving one section cannot
 * blank the press selection and vice versa. `included_article_ids` is passed
 * explicitly as null when the curator has cleared it, which is why the check is
 * `!== undefined` rather than a truthiness test — null and absent mean
 * different things here, as they do everywhere else in this feature.
 */
async function writeDraft(
  supabase: Client,
  weekStart: string,
  userId: string,
  fields: {
    sections?: EditionSection[];
    includedArticleIds?: string[] | null;
  }
) {
  return supabase.from("newsletter_editions").upsert(
    {
      week_of: weekStart,
      status: "draft",
      entered_by: userId,
      entered_at: new Date().toISOString(),
      ...(fields.sections ? { sections: sectionsToJson(fields.sections) } : {}),
      ...(fields.includedArticleIds !== undefined
        ? { included_article_ids: fields.includedArticleIds }
        : {}),
    },
    { onConflict: "week_of" }
  );
}

async function audit(supabase: Client, userId: string, metadata: Json) {
  await supabase.from("audit_log").insert({
    actor_id: userId,
    action: "newsletter.update",
    target_type: "newsletter_edition",
    target_id: null,
    metadata,
  });
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

export type GenerateResult = ActionResult & {
  /** Section titles the model wrote. */
  written?: string[];
  /** Section titles left alone because a person had edited them. */
  keptEdited?: string[];
  /** Section titles the model had nothing to say for. */
  empty?: string[];
};

/**
 * Writes every section the week's data can support.
 *
 * SECTIONS A PERSON HAS EDITED ARE LEFT ALONE, and the result says which. An
 * edit silently wiped by a second button press is the fastest way to lose this
 * team's trust in the tool, and there is no undo to recover it with. Anyone who
 * wants an edited section rewritten uses Regenerate inside that section, which
 * is scoped to that section alone.
 */
export async function generateEdition(
  weekStart: string,
  only: SectionKey | null = null
): Promise<GenerateResult> {
  const { ctx, error } = await requireCurate();
  if (!ctx) return { ok: false, error: error! };

  const draft = await openDraft(weekStart);
  if (!draft.ok) return { ok: false, error: draft.error };

  if (only && !SECTION_KEYS.includes(only)) {
    return { ok: false, error: "That is not a section of this newsletter." };
  }

  try {
    const { input } = await loadEdition(
      draft.supabase,
      draft.week,
      draft.includedArticleIds
    );
    const edition = buildEdition(input, draft.sections);

    // The admin client exists for the Vault-backed key and nothing else. It is
    // built here, after the permission check, and never used for a write.
    const written = await generateSections(
      createAdminClient(),
      edition.generated,
      only
    );

    const merged = mergeGenerated(
      draft.sections,
      written.bodies,
      new Date().toISOString(),
      only
    );

    const { error: writeError } = await writeDraft(
      draft.supabase,
      draft.week.start,
      ctx.userId,
      { sections: merged.sections }
    );
    if (writeError) return { ok: false, error: toEditionError(writeError) };

    await audit(draft.supabase, ctx.userId, {
      week_of: draft.week.start,
      event: only ? "section_regenerated" : "sections_generated",
      section: only,
      written: merged.written,
      kept_edited: merged.keptEdited,
      empty: merged.empty,
      articles_used: written.articlesUsed,
      // The bodies themselves, because the row keeps only the current text and
      // "what did the model write before someone rewrote it" has to be
      // answerable for something going out under the desk's name.
      bodies: merged.sections.map((s) => ({ key: s.key, body: s.body })),
    });

    revalidatePath(PATH);

    const titles = (keys: SectionKey[]) =>
      keys.map((k) => slotFor(k)?.title ?? k);

    return {
      ok: true,
      written: titles(merged.written),
      keptEdited: titles(merged.keptEdited),
      empty: titles(merged.empty),
    };
  } catch (err) {
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Could not write the newsletter.",
    };
  }
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

/**
 * Saves one section's text.
 *
 * Stamps edited_at, which is what protects it from the next Generate. Clearing
 * the box removes the section entirely — the same result as the model having
 * nothing to say, because it is the same instruction.
 */
export async function saveSection(
  weekStart: string,
  key: SectionKey,
  body: string
): Promise<ActionResult> {
  const { ctx, error } = await requireCurate();
  if (!ctx) return { ok: false, error: error! };
  if (!SECTION_KEYS.includes(key)) {
    return { ok: false, error: "That is not a section of this newsletter." };
  }

  const draft = await openDraft(weekStart);
  if (!draft.ok) return { ok: false, error: draft.error };

  const next = applyEdit(draft.sections, key, body, new Date().toISOString());

  const { error: writeError } = await writeDraft(
    draft.supabase,
    draft.week.start,
    ctx.userId,
    { sections: next }
  );
  if (writeError) return { ok: false, error: toEditionError(writeError) };

  await audit(draft.supabase, ctx.userId, {
    week_of: draft.week.start,
    event: "section_edited",
    section: key,
    body: body.trim(),
  });

  revalidatePath(PATH);
  return { ok: true };
}

/** Saves the curator's press selection. Separate because it is not prose. */
export async function saveIncludedArticles(
  weekStart: string,
  includedArticleIds: string[] | null
): Promise<ActionResult> {
  const { ctx, error } = await requireCurate();
  if (!ctx) return { ok: false, error: error! };

  const draft = await openDraft(weekStart);
  if (!draft.ok) return { ok: false, error: draft.error };

  const { error: writeError } = await writeDraft(
    draft.supabase,
    draft.week.start,
    ctx.userId,
    { includedArticleIds }
  );
  if (writeError) return { ok: false, error: toEditionError(writeError) };

  await audit(draft.supabase, ctx.userId, {
    week_of: draft.week.start,
    event: "articles_selected",
    included_article_count: includedArticleIds?.length ?? null,
  });

  revalidatePath(PATH);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export type SendResult = ActionResult & { subject?: string };

/**
 * Freezes and sends an edition.
 *
 * RE-READS the stored row and recomputes every generated value server-side
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
export async function sendEdition(weekStart: string): Promise<SendResult> {
  const { ctx, error } = await requireCurate();
  if (!ctx) return { ok: false, error: error! };

  const draft = await openDraft(weekStart);
  if (!draft.ok) return { ok: false, error: draft.error };
  const label = weekRangeLabel(draft.week);

  const [{ input }, baseUrl] = await Promise.all([
    loadEdition(draft.supabase, draft.week, draft.includedArticleIds),
    loadBaseUrl(draft.supabase),
  ]);

  const edition = buildEdition(input, draft.sections);

  // An edition with nothing in it would be a header and a sign-off. That is not
  // an edge case to render politely around; it is a sign that nothing has been
  // written or entered yet.
  if (isEmptyEdition(edition)) {
    return {
      ok: false,
      error:
        "This edition is empty — no figures entered and nothing written. Press Generate newsletter first.",
    };
  }

  const sentAt = new Date().toISOString();
  const snapshot = buildSnapshot({
    edition,
    subject: subjectLine(draft.week),
    html: renderEditionHtml(edition, { baseUrl }),
    sentAt,
    sentByName: ctx.fullName ?? ctx.email,
  });

  const { data: updated, error: sendError } = await draft.supabase
    .from("newsletter_editions")
    .update({
      status: "sent",
      snapshot: snapshotToJson(snapshot),
      sent_at: sentAt,
      sent_by: ctx.userId,
    })
    .eq("week_of", draft.week.start)
    .eq("status", "draft")
    .select("id");

  if (sendError) return { ok: false, error: toEditionError(sendError) };
  if (!updated || updated.length === 0) {
    return {
      ok: false,
      error: draft.exists
        ? `The edition for ${label} was sent by someone else while this one was open.`
        : `Nothing has been saved for ${label} yet. Press Generate newsletter first.`,
    };
  }

  await draft.supabase.from("audit_log").insert({
    actor_id: ctx.userId,
    action: "newsletter.send",
    target_type: "newsletter_edition",
    target_id: updated[0].id,
    metadata: {
      week_of: draft.week.start,
      subject: snapshot.subject,
      partial_week: edition.generated.partialWeek,
      sections_sent: edition.sections.map((s) => s.key),
      blocks_included: edition.blocks.filter((b) => b.present).map((b) => b.key),
      blocks_dropped: edition.blocks.filter((b) => !b.present).map((b) => b.key),
      press_shown: edition.generated.press.shown,
      press_candidates: edition.generated.press.candidates,
    },
  });

  revalidatePath(PATH);
  return { ok: true, subject: snapshot.subject };
}
