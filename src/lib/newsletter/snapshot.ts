/**
 * What gets frozen when an edition is sent.
 *
 * While an edition is a draft, every figure in it recomputes on each view —
 * that is the point, and it is why the curator can enter three more days of
 * congestion and watch the draft follow.
 *
 * On send, the whole generated half is written here and the edition never
 * recomputes again. A sent edition renders from this object alone.
 *
 * This is the single most important rule in the feature. A newsletter that
 * silently changes after it has gone out is a false record of what the client
 * received. Sending is one-way: there is no un-send and no edit-after-send, and
 * a correction is a NEW edition that says it is one. The database enforces it
 * with a trigger — see migration 0028 — because a disabled button is not a gate.
 *
 * BOTH THE VALUES AND THE HTML ARE STORED, and they answer different questions.
 * The structured half is what a human or a later feature can read: "what did
 * September's edition actually claim". The rendered html is the receipt: what
 * the curator copied into Outlook, byte for byte, immune even to a later change
 * in the renderer. Keeping only the values would let a template edit silently
 * restyle a sent edition; keeping only the html would make the figures
 * unreadable to anything but a browser.
 */

import type { Json } from "@/types/database.types";
import type { BlockState, Edition, Generated } from "./edition";
import type { EditionSection } from "./sections";
import type { Week } from "./week";

/**
 * Bumped to 2: the shape changed when the five authored fields became one
 * `sections` array. A version-1 snapshot cannot be rendered by the current
 * code, and parseSnapshot refuses it rather than half-reading it — but the
 * table held no sent editions when this changed, so no such snapshot exists.
 */
export const SNAPSHOT_VERSION = 2;

export type EditionSnapshot = {
  version: number;
  week: Week;
  subject: string;
  generated: Generated;
  /** The written sections exactly as they were when sent. */
  sections: EditionSection[];
  /** Which data blocks the edition carried. */
  blocks: BlockState[];
  /** The email body exactly as it was exported. */
  html: string;
  sentAt: string;
  /**
   * The sender's display name at the moment of sending. Copied here because
   * newsletter_editions.sent_by is ON DELETE SET NULL — removing a user must
   * not be blocked by an edition they sent, and must not erase who sent it.
   */
  sentByName: string | null;
};

export function buildSnapshot(input: {
  edition: Edition;
  subject: string;
  html: string;
  sentAt: string;
  sentByName: string | null;
}): EditionSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    week: input.edition.generated.week,
    subject: input.subject,
    generated: input.edition.generated,
    sections: input.edition.sections,
    blocks: input.edition.blocks,
    html: input.html,
    sentAt: input.sentAt,
    sentByName: input.sentByName,
  };
}

/**
 * Reads a stored snapshot back.
 *
 * Returns null rather than a half-populated object when the shape is not
 * recognised. A sent edition that cannot render from its snapshot must say so
 * loudly — falling back to a live recompute would be exactly the silent change
 * the freeze exists to prevent, and it would be invisible.
 */
export function parseSnapshot(value: Json | null): EditionSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  // An OLDER version is refused too, not only a newer one. Version 1 stored
  // five authored fields that nothing can render now, and half-reading it would
  // put a sent edition on screen missing its headline — the silent change the
  // freeze exists to prevent, wearing a different hat.
  if (raw.version !== SNAPSHOT_VERSION) return null;
  if (typeof raw.html !== "string" || raw.html.length === 0) return null;
  if (!raw.generated || typeof raw.generated !== "object") return null;
  if (!raw.week || typeof raw.week !== "object") return null;

  return value as unknown as EditionSnapshot;
}

/** A snapshot is stored in a jsonb column, so it has to satisfy Json. */
export function snapshotToJson(snapshot: EditionSnapshot): Json {
  return JSON.parse(JSON.stringify(snapshot)) as Json;
}
