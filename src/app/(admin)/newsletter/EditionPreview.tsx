"use client";

import { useState } from "react";
import { useToast } from "@/components/Toast";

/**
 * The rendered edition, and the whole of its delivery mechanism.
 *
 * There is no sending here — no SMTP, no distribution list, no unsubscribe.
 * Deliverability and list management are a separate project, and every prior
 * edition travelled as a forwarded Outlook mail anyway. Export is two buttons:
 * copy as rich HTML, so a paste into Outlook or Gmail keeps its formatting, and
 * download .html.
 *
 * The preview is an iframe with srcDoc rather than the markup injected into the
 * panel. The email is a complete document with its own light palette, and
 * dropping it into the dark admin shell would let the panel's own stylesheet
 * reach it — at which point the preview would stop being evidence of anything.
 *
 * TWO WIDTHS, both one click away. 640px is the design width; 375px is a phone,
 * and it is where a table-based layout actually breaks. Checking only the first
 * is how a column collapses in the client and nowhere else.
 */

const WIDTHS = [
  { value: 640, label: "640px · desktop" },
  { value: 375, label: "375px · phone" },
] as const;

export function EditionPreview({
  html,
  subject,
  filename,
  frozen,
}: {
  html: string;
  subject: string;
  /** e.g. "ocean-freight-update-2026-09.html" */
  filename: string;
  /** True for a sent edition, which renders from its snapshot. */
  frozen: boolean;
}) {
  const toast = useToast();
  const [width, setWidth] = useState<number>(640);

  async function copyText(value: string, what: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${what} copied.`);
    } catch {
      toast.error(`Could not copy the ${what.toLowerCase()}.`);
    }
  }

  /**
   * Rich copy.
   *
   * The clipboard carries BOTH flavours: text/html for Outlook and Gmail, and
   * text/plain for anything that only takes text. Writing html alone leaves a
   * plain-text paste showing the markup, which is the failure people actually
   * hit when they paste into a chat window instead.
   */
  async function copyRich() {
    const plain = toPlainText(html);
    try {
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
        throw new Error("The clipboard API is not available in this browser.");
      }
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]);
      toast.success("Edition copied — paste into Outlook or Gmail.");
    } catch {
      // Never fails silently: a copy that did not happen is indistinguishable
      // from a slow one, and the curator would paste stale clipboard content
      // into a client mail without knowing.
      toast.error(
        "Could not copy as formatted HTML. Use ↓ Download .html and attach or open it instead."
      );
    }
  }

  function download() {
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="chart-card">
      <div className="chart-head">
        <div>
          <h3>Preview</h3>
          <p>
            {frozen
              ? "Rendered from the snapshot frozen when this edition was sent. It cannot change."
              : "Exactly what the export produces. Figures follow the data until the edition is sent."}
          </p>
        </div>
        <div className="preview-actions">
          {WIDTHS.map((w) => (
            <button
              key={w.value}
              type="button"
              className={`btn btn-sm${width === w.value ? " btn-primary" : ""}`}
              onClick={() => setWidth(w.value)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <div className="preview-subject">
        <span className="stat-label" style={{ margin: 0 }}>
          Subject
        </span>
        <code>{subject}</code>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => copyText(subject, "Subject line")}
        >
          Copy
        </button>
      </div>

      <div className="preview-frame">
        <iframe
          title="Edition preview"
          srcDoc={html}
          style={{ width, maxWidth: "100%" }}
          // The email is a complete, self-contained document. Sandboxing it
          // without allow-scripts costs nothing — it has none — and keeps a
          // pasted-in link from being able to navigate the panel.
          sandbox=""
        />
      </div>

      <div className="preview-export">
        <button type="button" className="btn btn-sm btn-primary" onClick={copyRich}>
          ⧉ Copy as rich HTML
        </button>
        <button type="button" className="btn btn-sm" onClick={download}>
          ↓ Download .html
        </button>
        <span className="cell-sub">
          Paste into a new Outlook or Gmail message. Nothing is sent from here.
        </span>
      </div>
    </div>
  );
}

/**
 * A readable plain-text fallback for the clipboard.
 *
 * Built by letting the browser parse the document and reading its text, rather
 * than by stripping tags with a regex — a regex would leave the contents of
 * <title> and the inline style attributes in the output.
 */
function toPlainText(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    // innerText needs layout, and a DOMParser document has none — it comes back
    // empty rather than undefined, so `??` would not fall through to
    // textContent. Check the length, not for null.
    const rendered = doc.body?.innerText ?? "";
    const text = rendered.trim() ? rendered : (doc.body?.textContent ?? "");
    return text.replace(/[ \t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return "";
  }
}
