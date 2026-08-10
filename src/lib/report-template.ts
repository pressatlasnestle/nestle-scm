/**
 * SHARED report template — the single source of truth for the Monday digest's
 * markup. The newsletter preview panel AND the (future) mailer both call
 * `renderReport()`, so what an admin previews is byte-for-byte what recipients
 * receive. Design changes happen by editing THIS file — there is deliberately no
 * in-app editor / WYSIWYG.
 *
 * `renderReport()` returns a complete, self-contained HTML document with inline
 * styles only (no external CSS/JS/fonts) so it renders identically in email
 * clients and in the preview iframe.
 */

export type ReportSentiment = "positive" | "neutral" | "negative";

export type ReportStory = {
  headline: string;
  media: string;
  published_at?: string | null;
  sentiment: ReportSentiment;
  summary: string;
  url?: string | null;
  keywords?: string[];
};

export type ReportMediaCount = { media: string; count: number };
export type ReportKeywordCount = { keyword: string; count: number };

/**
 * Shape the template renders. When a real `reports` row exists, this is built
 * from its columns + `stats_snapshot`; see `reportDataFromRow()`.
 */
export type ReportData = {
  week_of: string; // ISO date
  article_count: number;
  source_count: number;
  sentiment: { positive: number; neutral: number; negative: number };
  top_stories: ReportStory[];
  media_breakdown: ReportMediaCount[];
  top_keywords: ReportKeywordCount[];
};

// ---------------------------------------------------------------------------
// Palette — plain hex (email clients don't support CSS variables). Tuned for a
// light background so the digest is readable in every mail client.
// ---------------------------------------------------------------------------
const C = {
  navy: "#0a121f",
  ink: "#1a2740",
  muted: "#5b6c89",
  dim: "#8494af",
  teal: "#12a394",
  tealBg: "#e6faf7",
  amber: "#b8791f",
  amberBg: "#fbf1de",
  coral: "#d9503f",
  coralBg: "#fbe9e6",
  indigo: "#5566c9",
  line: "#e2e8f0",
  pageBg: "#eef2f7",
  card: "#ffffff",
};

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const SENTIMENT_STYLE: Record<
  ReportSentiment,
  { label: string; color: string; bg: string }
> = {
  positive: { label: "Positive", color: C.teal, bg: C.tealBg },
  neutral: { label: "Neutral", color: C.muted, bg: "#eef2f7" },
  negative: { label: "Negative", color: C.coral, bg: C.coralBg },
};

function statTile(value: string | number, label: string, color: string): string {
  return `
    <td align="center" style="padding:14px 10px;background:${C.card};border:1px solid ${C.line};border-radius:10px;">
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:700;color:${color};line-height:1;">${esc(value)}</div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:${C.dim};margin-top:6px;">${esc(label)}</div>
    </td>`;
}

function storyBlock(s: ReportStory): string {
  const sent = SENTIMENT_STYLE[s.sentiment] ?? SENTIMENT_STYLE.neutral;
  const headline = s.url
    ? `<a href="${esc(s.url)}" style="color:${C.ink};text-decoration:none;">${esc(s.headline)}</a>`
    : esc(s.headline);
  const meta = [esc(s.media), fmtDate(s.published_at)].filter(Boolean).join(" &middot; ");
  const kw =
    s.keywords && s.keywords.length
      ? `<div style="margin-top:8px;">${s.keywords
          .map(
            (k) =>
              `<span style="display:inline-block;font-family:'Courier New',monospace;font-size:11px;color:${C.indigo};background:#eef1fb;border-radius:4px;padding:2px 7px;margin:2px 4px 2px 0;">${esc(k)}</span>`
          )
          .join("")}</div>`
      : "";
  return `
    <tr>
      <td style="padding:16px 18px;background:${C.card};border:1px solid ${C.line};border-radius:10px;">
        <div>
          <span style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:700;color:${sent.color};background:${sent.bg};border-radius:5px;padding:3px 9px;">${esc(sent.label)}</span>
        </div>
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;color:${C.ink};line-height:1.35;margin:9px 0 4px;">${headline}</div>
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.dim};">${meta}</div>
        <div style="font-family:Arial,Helvetica,sans-serif;font-size:13.5px;color:${C.muted};line-height:1.55;margin-top:9px;">${esc(s.summary)}</div>
        ${kw}
      </td>
    </tr>
    <tr><td style="height:12px;line-height:12px;font-size:0;">&nbsp;</td></tr>`;
}

function barRow(label: string, count: number, max: number, color: string): string {
  const pct = max > 0 ? Math.max(4, Math.round((count / max) * 100)) : 0;
  return `
    <tr>
      <td style="padding:5px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:${C.ink};width:42%;">${esc(label)}</td>
      <td style="padding:5px 0;width:48%;">
        <div style="background:#eef2f7;border-radius:5px;height:10px;width:100%;">
          <div style="background:${color};border-radius:5px;height:10px;width:${pct}%;"></div>
        </div>
      </td>
      <td style="padding:5px 0 5px 10px;font-family:'Courier New',monospace;font-size:12px;color:${C.muted};text-align:right;">${esc(count)}</td>
    </tr>`;
}

export function renderReport(data: ReportData): string {
  const total =
    data.sentiment.positive + data.sentiment.neutral + data.sentiment.negative || 1;
  const pos = Math.round((data.sentiment.positive / total) * 100);
  const neu = Math.round((data.sentiment.neutral / total) * 100);
  const neg = Math.max(0, 100 - pos - neu);

  const maxMedia = Math.max(1, ...data.media_breakdown.map((m) => m.count));

  const stories = data.top_stories.map(storyBlock).join("");
  const media = data.media_breakdown
    .map((m) => barRow(m.media, m.count, maxMedia, C.teal))
    .join("");
  const keywords = data.top_keywords
    .map(
      (k) =>
        `<span style="display:inline-block;font-family:Arial,Helvetica,sans-serif;font-size:12.5px;color:${C.ink};background:${C.card};border:1px solid ${C.line};border-radius:16px;padding:5px 12px;margin:3px 6px 3px 0;">${esc(
          k.keyword
        )} <span style="color:${C.dim};font-family:'Courier New',monospace;font-size:11px;">${esc(k.count)}</span></span>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SCM Media Monitor — Weekly Digest</title>
</head>
<body style="margin:0;padding:0;background:${C.pageBg};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.pageBg};padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:100%;">

        <!-- Header -->
        <tr><td style="background:${C.navy};border-radius:12px 12px 0 0;padding:26px 26px 22px;">
          <div style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${C.teal};">SCM Media Monitor</div>
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:24px;font-weight:700;color:#ffffff;margin-top:6px;">Weekly Ocean Freight Digest</div>
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:${C.dim};margin-top:4px;">Week of ${esc(fmtDate(data.week_of))}</div>
        </td></tr>

        <!-- Stat tiles -->
        <tr><td style="background:${C.pageBg};padding:18px 8px 6px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="8"><tr>
            ${statTile(data.article_count, "Articles", C.ink)}
            ${statTile(data.source_count, "Sources", C.ink)}
            ${statTile(`${pos}%`, "Positive", C.teal)}
            ${statTile(`${neg}%`, "Negative", C.coral)}
          </tr></table>
        </td></tr>

        <!-- Sentiment bar -->
        <tr><td style="background:${C.pageBg};padding:8px 16px 4px;">
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;letter-spacing:0.5px;text-transform:uppercase;color:${C.dim};margin-bottom:6px;">Sentiment split</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="background:${C.teal};height:12px;width:${pos}%;border-radius:6px 0 0 6px;font-size:0;line-height:12px;">&nbsp;</td>
            <td style="background:${C.dim};height:12px;width:${neu}%;font-size:0;line-height:12px;">&nbsp;</td>
            <td style="background:${C.coral};height:12px;width:${neg}%;border-radius:0 6px 6px 0;font-size:0;line-height:12px;">&nbsp;</td>
          </tr></table>
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:11.5px;color:${C.muted};margin-top:6px;">
            ${esc(data.sentiment.positive)} positive &middot; ${esc(data.sentiment.neutral)} neutral &middot; ${esc(data.sentiment.negative)} negative
          </div>
        </td></tr>

        <!-- Top stories -->
        <tr><td style="background:${C.pageBg};padding:18px 16px 2px;">
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:${C.ink};margin-bottom:12px;">Top stories this week</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${stories}</table>
        </td></tr>

        <!-- Media breakdown -->
        <tr><td style="background:${C.pageBg};padding:10px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:${C.card};border:1px solid ${C.line};border-radius:10px;padding:16px 18px;">
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:${C.ink};margin-bottom:10px;">Coverage by source</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${media}</table>
          </td></tr></table>
        </td></tr>

        <!-- Keywords -->
        <tr><td style="background:${C.pageBg};padding:6px 16px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:${C.card};border:1px solid ${C.line};border-radius:10px;padding:16px 18px;">
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:${C.ink};margin-bottom:10px;">Most-matched keywords</div>
            <div>${keywords}</div>
          </td></tr></table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:${C.navy};border-radius:0 0 12px 12px;padding:20px 26px;">
          <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${C.dim};line-height:1.6;">
            Generated by SCM Media Monitor for the Nestlé Ocean Freight desk.<br>
            You're receiving this because you're on the Monday digest distribution list.
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Builds ReportData from a persisted `reports` row. `week_of` / `article_count`
 * are real columns; the rest comes from `stats_snapshot` with safe fallbacks,
 * since the ingestion pipeline that populates it does not exist yet.
 */
export function reportDataFromRow(row: {
  week_of: string | null;
  article_count: number | null;
  stats_snapshot: unknown;
}): ReportData {
  const s = (row.stats_snapshot ?? {}) as Record<string, unknown>;
  const sentiment = (s.sentiment ?? {}) as Record<string, unknown>;

  return {
    week_of: row.week_of ?? new Date().toISOString().slice(0, 10),
    article_count: row.article_count ?? 0,
    source_count: Number(s.source_count ?? 0),
    sentiment: {
      positive: Number(sentiment.positive ?? 0),
      neutral: Number(sentiment.neutral ?? 0),
      negative: Number(sentiment.negative ?? 0),
    },
    top_stories: Array.isArray(s.top_stories) ? (s.top_stories as ReportStory[]) : [],
    media_breakdown: Array.isArray(s.media_breakdown)
      ? (s.media_breakdown as ReportMediaCount[])
      : [],
    top_keywords: Array.isArray(s.top_keywords)
      ? (s.top_keywords as ReportKeywordCount[])
      : [],
  };
}
