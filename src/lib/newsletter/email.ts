/**
 * The edition as email HTML.
 *
 * WHY THE PANEL'S CHARTS CANNOT BE REUSED HERE. Every chart on /analysis is
 * Recharts, and Recharts emits SVG. Gmail strips inline SVG entirely and
 * Outlook renders through Word, which has never supported it. A component
 * shared between the panel and the email would look perfect in the preview
 * iframe — which is a browser — and arrive blank in the client. That failure
 * is invisible to every test that does not open a mail client, which is why
 * the rule below is a hard constraint rather than a preference.
 *
 * So the charts here are HTML tables: a horizontal bar is a <td> with a
 * background colour and a percentage width. That renders in every client back
 * to Outlook 2007, needs no rasterisation, no image host and no CDN.
 *
 * Server-side rasterisation was the alternative and was rejected: Puppeteer on
 * Vercel means bundle size and cold starts that are a bad trade for a weekly
 * job, and it would put a binary dependency into a pipeline that has none.
 *
 * NON-NEGOTIABLE, and asserted by scripts/checks/newsletter.ts against the
 * rendered string:
 *
 *   * Every style inline. No <style> block, no external sheet, no utility
 *     classes — Gmail strips <head> styles in several contexts, and the
 *     class-based version fails silently there while looking correct locally.
 *   * Table layout. No flexbox, no grid, no CSS variables.
 *   * 640px maximum, and readable at 375px.
 *
 *     THE FRAME IS FLUID, NOT FIXED. A table with `width:640px;max-width:100%`
 *     looks like it collapses on a phone and does not: a percentage max-width
 *     resolves against an auto-width containing block, and a table cell is
 *     auto-width, so the percentage computes to `none` and the 640px stands.
 *     The email then forces a sideways scroll on every phone while passing a
 *     "contains max-width:100%" assertion. It is `width:100%;max-width:640px`
 *     instead — an absolute cap, which always applies — with an `[if mso]`
 *     ghost table pinning 640px for Outlook, which renders through Word and
 *     ignores max-width in the other direction.
 *
 *     The narrow width is a real constraint on content, not only on the frame.
 *     A 375px phone leaves about 291px inside the body, section and card
 *     padding, so any table whose minimum width exceeds that will overflow no
 *     matter what the frame says — see the port table's caption.
 *   * No <svg> anywhere in the output.
 *   * Web-safe fonts with a stack. No webfonts.
 *
 * A SECTION WITH NO DATA IS ABSENT. Not a heading over an empty table, not a
 * zero-fill, not a "data not available" row. The draft view tells the curator
 * what was dropped and why; the email is simply shorter.
 */

import {
  asAtLabel,
  blockPresent,
  deltaBasis,
  formatDelta,
  formatValue,
  sourceLine,
  subjectLine,
  type Edition,
  type FleetBar,
  type PortWatchRow,
  type RegionBar,
} from "./edition";
import {
  findSection,
  hasBody,
  renderableSections,
  type EditionSection,
} from "./sections";
import { dayLabel, weekRangeLabel } from "./week";
import { PRESS_ITEMS_PER_THEME } from "./press";

/**
 * Plain hex only — email clients do not support CSS variables, so the panel's
 * design tokens cannot cross over. Tuned for a light background because that is
 * what a mail client gives you and dark-mode handling in email is a swamp.
 *
 * Indigo carries every measured market quantity, the same discipline the panel
 * follows: reusing the favourability teal/amber/coral would assert a direction
 * the data does not carry — more TEU waiting is not "unfavourable" in the sense
 * the sentiment charts mean.
 */
const C = {
  navy: "#0a121f",
  ink: "#1a2740",
  muted: "#5b6c89",
  dim: "#8494af",
  indigo: "#4a5bc4",
  indigoSoft: "#e9ebfa",
  teal: "#12a394",
  amber: "#b8791f",
  line: "#e2e8f0",
  rule: "#eef2f7",
  pageBg: "#eef2f7",
  card: "#ffffff",
};

const SANS = "Arial,Helvetica,sans-serif";
const MONO = "'Courier New',Courier,monospace";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Authored prose into paragraphs.
 *
 * Blank lines separate paragraphs; single newlines do not. That is how people
 * actually type into a textarea, and collapsing everything into one block would
 * silently destroy the structure the curator wrote.
 */
function paragraphs(text: string, size = 14): string {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) =>
        `<p style="margin:0 0 10px;font-family:${SANS};font-size:${size}px;line-height:1.6;color:${C.ink};">${esc(
          p
        ).replace(/\n/g, "<br>")}</p>`
    )
    .join("");
}

/** Section heading. Consistent everywhere, so the eye can find the next one. */
function heading(title: string, sub?: string): string {
  return `
    <tr><td style="padding:22px 16px 8px;">
      <div style="font-family:${MONO};font-size:10.5px;letter-spacing:1.6px;text-transform:uppercase;color:${C.indigo};">${esc(
        title
      )}</div>
      ${
        sub
          ? `<div style="font-family:${SANS};font-size:11.5px;color:${C.dim};margin-top:5px;line-height:1.5;">${esc(
              sub
            )}</div>`
          : ""
      }
    </td></tr>`;
}

/** A white card the section's content sits in. */
function card(inner: string, pad = "16px 18px"): string {
  return `
    <tr><td style="padding:0 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;"><tr>
        <td style="background:${C.card};border:1px solid ${C.line};border-radius:10px;padding:${pad};">${inner}</td>
      </tr></table>
    </td></tr>`;
}

/**
 * A horizontal bar: a filled cell and the remainder.
 *
 * A minimum of 2% so a small-but-real value is still visibly a bar. A true zero
 * never reaches here — an absent figure produces no row at all — so the floor
 * cannot make nothing look like something.
 */
function bar(percent: number, colour = C.indigo): string {
  const filled = Math.max(2, Math.min(100, Math.round(percent)));
  const rest = 100 - filled;
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:${C.rule};border-radius:5px;"><tr>
      <td style="background:${colour};width:${filled}%;height:9px;font-size:0;line-height:9px;border-radius:5px;">&nbsp;</td>
      ${rest > 0 ? `<td style="width:${rest}%;height:9px;font-size:0;line-height:9px;">&nbsp;</td>` : ""}
    </tr></table>`;
}

/**
 * The delta cell: the change, with the date it is measured against beneath.
 *
 * `withBasis` is false where every row in a table compares against the SAME
 * day — the port table normally does — because repeating "vs 27 Jul" five times
 * costs the column about 65px of minimum width, and that column is what pushed
 * the whole email past 375px. Said once in the caption instead.
 */
function deltaCell(
  delta: Parameters<typeof formatDelta>[0],
  withBasis = true
): string {
  const basis = withBasis ? deltaBasis(delta) : null;
  const absent = delta.kind !== "change";
  // nowrap protects a figure — "▲ 16.7%" must never break across lines. The
  // absence phrases are prose and must be allowed to wrap: "no July 2026
  // figure" held at nowrap is 145px of unbreakable text in a column sized for
  // about 50, and one port with no prior month was enough to push the whole
  // email past a phone's width.
  return `
    <div style="font-family:${MONO};font-size:12px;color:${
      absent ? C.dim : C.ink
    };${absent ? "font-style:italic;" : ""}white-space:${absent ? "normal" : "nowrap"};line-height:1.4;">${esc(
      formatDelta(delta)
    )}</div>
    ${
      basis
        ? `<div style="font-family:${SANS};font-size:10.5px;color:${C.dim};margin-top:2px;white-space:nowrap;">${esc(
            basis
          )}</div>`
        : ""
    }`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function glanceSection(edition: Edition): string {
  const rows = edition.generated.glance
    .map((row) => {
      const at = asAtLabel(row.asAt);
      return `
      <tr>
        <td style="padding:9px 0;border-bottom:1px solid ${C.rule};font-family:${SANS};font-size:13px;color:${C.ink};line-height:1.4;">
          ${esc(row.label)}
          ${
            row.note
              ? `<div style="font-size:10.5px;color:${C.dim};margin-top:2px;">${esc(row.note)}</div>`
              : ""
          }
        </td>
        <td align="right" style="padding:9px 0 9px 10px;border-bottom:1px solid ${C.rule};white-space:nowrap;">
          <div style="font-family:${SANS};font-size:15px;font-weight:700;color:${C.ink};">${esc(
            formatValue(row.value, row.unit)
          )}${row.unit === "%" ? "" : ` <span style="font-size:10.5px;font-weight:400;color:${C.dim};">${esc(row.unit)}</span>`}</div>
          ${
            at
              ? `<div style="font-family:${SANS};font-size:10.5px;color:${C.dim};margin-top:2px;">${esc(at)}</div>`
              : ""
          }
        </td>
        <td align="right" style="padding:9px 0 9px 12px;border-bottom:1px solid ${C.rule};">${deltaCell(
          row.delta
        )}</td>
      </tr>`;
    })
    .join("");

  return (
    heading(
      "At a glance",
      "Levels on the most recent day entered in the week, compared against the most recent day of the week before. These are stocks, not totals — nothing here is summed or averaged over the week. Schedule reliability is the exception: it is published monthly and compared against the previous month, which the row says."
    ) +
    card(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;">${rows}</table>`
    )
  );
}

function regionSection(edition: Edition): string {
  const { regions, regionsAsAt } = edition.generated;
  const max = Math.max(...regions.map((r) => r.value), 1);

  const row = (r: RegionBar) => `
    <tr>
      <td style="padding:7px 0 2px;font-family:${SANS};font-size:12.5px;color:${C.ink};">${esc(
        r.label
      )}</td>
      <td align="right" style="padding:7px 0 2px 10px;font-family:${MONO};font-size:12px;color:${C.muted};white-space:nowrap;">${esc(
        formatValue(r.value, "TEU")
      )}</td>
      <td align="right" style="padding:7px 0 2px 12px;font-family:${MONO};font-size:11px;color:${
        r.delta.kind === "change" ? C.ink : C.dim
      };white-space:nowrap;${r.delta.kind === "change" ? "" : "font-style:italic;"}">${esc(
        formatDelta(r.delta)
      )}</td>
    </tr>
    <tr><td colspan="3" style="padding:0 0 6px;">${bar((r.value / max) * 100)}</td></tr>`;

  const home = regions.filter((r) => r.home);
  const rest = regions.filter((r) => !r.home);

  const divider = (label: string) => `
    <tr><td colspan="3" style="padding:12px 0 2px;font-family:${MONO};font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:${C.dim};border-top:1px solid ${C.rule};">${esc(
      label
    )}</td></tr>`;

  const body =
    (home.length ? home.map(row).join("") : "") +
    (rest.length ? divider("Rest of world") + rest.map(row).join("") : "");

  // The commentary sits INSIDE the chart's card, not under its own heading:
  // prose about a chart that has been moved away from the chart gets read as a
  // separate claim about the week.
  const regional = findSection(edition.sections, "regional");
  const commentary = hasBody(regional)
    ? `<div style="border-top:1px solid ${C.rule};margin-top:14px;padding-top:12px;">${paragraphs(
        regional!.body,
        13.5
      )}</div>`
    : "";

  return (
    heading(
      "Regional congestion",
      `Capacity waiting at anchor by region${
        regionsAsAt ? `, as at ${dayLabel(regionsAsAt)}` : ""
      }. AOA waters first. Source: Linerlytica.`
    ) +
    card(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;">${body}</table>${commentary}`
    )
  );
}

function portSection(edition: Edition): string {
  /**
   * Every row normally reads from the same day and compares against the same
   * day, so both dates are stated ONCE in the caption and dropped from the
   * cells. That is not only tidier: the repeated "as at 14 Aug" and "vs 8 Aug"
   * were what made this table's minimum width 362px, against the 291px a 375px
   * phone actually leaves for content. It rendered correctly at every width the
   * design was checked at and forced a sideways scroll on a phone.
   *
   * When the days genuinely differ — patchy entry across ports — the per-row
   * labels come back, because then they are carrying information rather than
   * repeating it.
   */
  const rows = edition.generated.ports;
  const days = new Set(rows.map((p) => p.asAt));
  const commonDay = days.size === 1 ? [...days][0] : null;
  const bases = new Set(
    rows.map((p) => (p.teuDelta ? deltaBasis(p.teuDelta) : null)).filter(Boolean)
  );
  const commonBasis = bases.size === 1 ? ([...bases][0] as string) : null;

  const th = (label: string, align: "left" | "right" = "left") =>
    `<th align="${align}" style="padding:0 0 7px;border-bottom:1px solid ${C.line};font-family:${MONO};font-size:9.5px;letter-spacing:1px;text-transform:uppercase;color:${C.dim};font-weight:400;">${esc(
      label
    )}</th>`;

  const row = (p: PortWatchRow) => `
    <tr>
      <td style="padding:10px 6px 10px 0;border-bottom:1px solid ${C.rule};font-family:${SANS};font-size:12.5px;color:${C.ink};line-height:1.35;">
        ${esc(p.port)}
        ${
          commonDay
            ? ""
            : `<div style="font-size:10px;color:${C.dim};margin-top:2px;">as at ${esc(
                dayLabel(p.asAt)
              )}</div>`
        }
      </td>
      <td align="right" style="padding:10px 0;border-bottom:1px solid ${C.rule};font-family:${MONO};font-size:12px;color:${C.ink};white-space:nowrap;">
        ${p.teuAnchorage === null ? `<span style="color:${C.dim};">—</span>` : esc(formatValue(p.teuAnchorage, "TEU"))}
        ${
          p.shipsAnchorage === null
            ? ""
            : `<div style="font-family:${SANS};font-size:10px;color:${C.dim};margin-top:2px;">${esc(
                formatValue(p.shipsAnchorage, "ships")
              )} ships</div>`
        }
      </td>
      <td align="right" style="padding:10px 0 10px 8px;border-bottom:1px solid ${C.rule};">${
        p.teuDelta
          ? deltaCell(p.teuDelta, commonBasis === null)
          : `<span style="font-family:${MONO};font-size:12px;color:${C.dim};">—</span>`
      }</td>
      <td align="right" style="padding:10px 0 10px 8px;border-bottom:1px solid ${C.rule};font-family:${MONO};font-size:12px;color:${C.ink};white-space:nowrap;">
        ${p.queueBerthRatio === null ? `<span style="color:${C.dim};">—</span>` : esc(String(p.queueBerthRatio))}
        ${
          p.ratioDelta && p.ratioDelta.kind === "change"
            ? `<div style="font-size:10px;color:${C.dim};margin-top:2px;">${esc(
                formatDelta(p.ratioDelta)
              )}</div>`
            : ""
        }
      </td>
    </tr>`;

  return (
    heading(
      "Port watch",
      `The tracked ports${commonDay ? `, as at ${dayLabel(commonDay)}` : ""}${
        commonBasis ? `, against ${commonBasis.replace(/^vs /, "")}` : ", week on week"
      }. The queue / berth ratio is printed as Linerlytica publishes it, never computed from the ship counts beside it — the source smooths it and the two figures differ.`
    ) +
    card(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;">
        <tr>${th("Port")}${th("TEU at anchor", "right")}${th("WoW", "right")}${th(
        "Queue / berth",
        "right"
      )}</tr>
        ${rows.map(row).join("")}
      </table>`
    )
  );
}

function fleetSection(edition: Edition): string {
  const bars = edition.generated.fleet;
  const maxShips = Math.max(...bars.map((b) => b.ships ?? 0), 1);

  const row = (b: FleetBar) => `
    <tr>
      <td style="padding:8px 0 2px;font-family:${SANS};font-size:12.5px;color:${C.ink};">${esc(
        b.status
      )}</td>
      <td align="right" style="padding:8px 0 2px 10px;font-family:${MONO};font-size:12px;color:${C.muted};white-space:nowrap;">
        ${b.ships === null ? "—" : esc(formatValue(b.ships, "ships"))}
        ${
          b.teu === null
            ? ""
            : ` <span style="color:${C.dim};">· ${esc(formatValue(b.teu, "TEU"))} TEU</span>`
        }
      </td>
    </tr>
    <tr><td colspan="2" style="padding:0 0 6px;">${bar(
      ((b.ships ?? 0) / maxShips) * 100
    )}</td></tr>`;

  return (
    heading(
      "Fleet status",
      `${
        edition.generated.fleetAsAt ? `As at ${dayLabel(edition.generated.fleetAsAt)}. ` : ""
      }These categories OVERLAP — ships at port and ships at anchorage are both subsets of active ships — so they are shown side by side and must never be stacked or totalled. The bar length is the ship count; the TEU figure is printed beside it. Source: Linerlytica.`
    ) +
    card(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;">${bars
        .map(row)
        .join("")}</table>`
    )
  );
}

function reliabilitySection(edition: Edition): string {
  const r = edition.generated.reliability!;
  const max = Math.max(...r.alliances.map((a) => a.value), 1);

  const figure = (value: number | null, unit: string, label: string) =>
    value === null
      ? ""
      : `<td width="50%" style="padding:0 8px 0 0;">
          <div style="font-family:${SANS};font-size:22px;font-weight:700;color:${C.ink};line-height:1.1;">${esc(
            formatValue(value, unit)
          )}${unit === "%" ? "" : `<span style="font-size:11px;font-weight:400;color:${C.dim};"> ${esc(unit)}</span>`}</div>
          <div style="font-family:${SANS};font-size:10.5px;color:${C.dim};margin-top:4px;">${esc(
            label
          )}</div>
        </td>`;

  const figures =
    r.globalPct === null && r.avgDelayDays === null
      ? ""
      : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:14px;"><tr>
          ${figure(r.globalPct, "%", "On time, globally")}
          ${figure(r.avgDelayDays, "days", "Average delay, late arrivals")}
        </tr></table>`;

  const alliances = r.alliances.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;">${r.alliances
        .map(
          (a) => `
        <tr>
          <td style="padding:7px 0 2px;font-family:${SANS};font-size:12.5px;color:${C.ink};">${esc(
            a.name
          )}</td>
          <td align="right" style="padding:7px 0 2px 10px;font-family:${MONO};font-size:12px;color:${C.muted};white-space:nowrap;">${esc(
            formatValue(a.value, "%")
          )}</td>
          <td align="right" style="padding:7px 0 2px 12px;font-family:${MONO};font-size:11px;color:${
            a.delta && a.delta.kind === "change" ? C.ink : C.dim
          };white-space:nowrap;">${a.delta ? esc(formatDelta(a.delta)) : ""}</td>
        </tr>
        <tr><td colspan="3" style="padding:0 0 6px;">${bar(
          (a.value / max) * 100,
          C.teal
        )}</td></tr>`
        )
        .join("")}</table>`
    : "";

  const written = findSection(edition.sections, "reliability");
  const note = hasBody(written)
    ? `<div style="border-top:1px solid ${C.rule};margin-top:14px;padding-top:12px;">${paragraphs(
        written!.body,
        13.5
      )}</div>`
    : "";

  /**
   * The caption a monthly figure needs inside a weekly edition.
   *
   * Sea-Intelligence publishes reliability monthly and in arrears, so four
   * consecutive weekly editions carry the same number and the same GLP issue.
   * Left unexplained that reads as a fresh weekly figure which mysteriously
   * never moves — worse than showing nothing, because a reader will eventually
   * act on it as if it were new. So the caption states three things every time:
   * the month it covers, the issue it came from, and that it is unchanged until
   * the next issue.
   *
   * It also says what the percentages beside it are measured against, because
   * they are month-on-month while everything else in the edition is week on
   * week, and an unlabelled mixture is worse than either alone.
   */
  return (
    heading(
      "Schedule reliability",
      `${r.monthLabel}${
        r.glpIssue ? ` · Global Liner Performance issue ${r.glpIssue}` : ""
      }. Published monthly and in arrears${
        r.carriedForward ? `, so these are not ${r.weekMonthLabel} figures` : ""
      } — unchanged since that issue, and identical in every weekly edition until the next one.${
        r.priorMonthLabel
          ? ` Changes are against ${r.priorMonthLabel}, not against last week.`
          : ""
      } Source: Sea-Intelligence.`
    ) + card(figures + alliances + note)
  );
}

function pressSection(edition: Edition): string {
  const { press } = edition.generated;

  const themeBlock = (t: (typeof press.themes)[number]) => `
    <tr><td style="padding:14px 0 6px;">
      <div style="font-family:${SANS};font-size:13.5px;font-weight:700;color:${C.ink};">${esc(
        t.theme
      )}</div>
    </td></tr>
    ${t.items
      .map(
        (item) => `
      <tr><td style="padding:0 0 12px;border-bottom:1px solid ${C.rule};">
        <div style="font-family:${SANS};font-size:13px;font-weight:700;line-height:1.4;margin-bottom:3px;">
          ${
            item.url
              ? `<a href="${esc(item.url)}" style="color:${C.indigo};text-decoration:none;">${esc(
                  item.headline
                )}</a>`
              : `<span style="color:${C.ink};">${esc(item.headline)}</span>`
          }
        </div>
        ${
          item.summary
            ? `<div style="font-family:${SANS};font-size:12.5px;line-height:1.55;color:${C.muted};margin-bottom:4px;">${esc(
                item.summary
              )}</div>`
            : ""
        }
        <div style="font-family:${MONO};font-size:10.5px;color:${C.dim};">${[
          item.media,
          item.publishedAt ? dayLabel(item.publishedAt) : null,
        ]
          .filter(Boolean)
          .map((part) => esc(part))
          .join(" &middot; ")}</div>
      </td></tr>`
      )
      .join("")}`;

  return (
    heading(
      "What moved in the press",
      `${press.shown} of ${press.candidates} coded article${
        press.candidates === 1 ? "" : "s"
      } published ${weekRangeLabel(edition.generated.week)}${
        edition.generated.partialWeek
          ? " so far — the week has not closed yet"
          : ", Monday to Sunday inclusive"
      }. Themes run busiest first; stories run newest first within a theme, at most ${PRESS_ITEMS_PER_THEME} each. An article carrying several themes appears once, under its busiest one.`
    ) +
    card(
      // A theme whose every candidate was toggled out or suppressed is carried
      // in the selection so the composer can still show those rows, but it must
      // never reach the email as a heading over nothing.
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;">${press.themes
        .filter((t) => t.items.length > 0)
        .map(themeBlock)
        .join("")}</table>`
    )
  );
}

/**
 * A written section with its own heading.
 *
 * ONE function for every prose section, because there is now one section shape.
 * The watch list used to be a structured card of risk/lanes/window/direction
 * and the actions a numbered list, each with its own renderer; both are prose
 * now, and the model writes one item per line. Lines survive as lines — see
 * paragraphs() — so a numbered list the model wrote still reads as one without
 * the curator having to learn any syntax to produce it.
 */
function proseSection(section: EditionSection): string {
  return heading(section.title) + card(paragraphs(section.body, 13.5));
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export type RenderOptions = {
  /**
   * Public app URL, for the link back to the Analysis panel. Omitted entirely
   * when absent rather than rendered as a dead relative link — an "explore"
   * button that goes nowhere is worse than no button.
   */
  baseUrl?: string | null;
};

export function renderEditionHtml(
  edition: Edition,
  options: RenderOptions = {}
): string {
  /**
   * The running order.
   *
   * A block appears only if it has something behind it — a data block with
   * figures, a written section with a body. Nothing is rendered as an empty
   * heading, a zero-filled chart or a "no data available" line; the edition is
   * simply shorter. The composer tells the curator what was left out and why,
   * and that line never travels with the email.
   *
   * `regional` and `reliability` are absent from this list because their prose
   * renders INSIDE their charts rather than as blocks of their own.
   */
  const written = (key: Parameters<typeof findSection>[1]) => {
    const section = findSection(edition.sections, key);
    return hasBody(section) ? proseSection(section!) : "";
  };

  const body = [
    written("headline"),
    blockPresent(edition.blocks, "glance") ? glanceSection(edition) : "",
    blockPresent(edition.blocks, "regional") ? regionSection(edition) : "",
    blockPresent(edition.blocks, "ports") ? portSection(edition) : "",
    blockPresent(edition.blocks, "fleet") ? fleetSection(edition) : "",
    blockPresent(edition.blocks, "reliability") ? reliabilitySection(edition) : "",
    blockPresent(edition.blocks, "press") ? pressSection(edition) : "",
    written("watch_list"),
    written("actions"),
    // Any section stored under a key this layout does not place goes last,
    // rather than vanishing — see renderableSections().
    renderableSections(edition.sections)
      .filter((s) => !["headline", "regional", "reliability", "watch_list", "actions"].includes(s.key))
      .map(proseSection)
      .join(""),
  ].join("");

  const explore = options.baseUrl
    ? `<div style="margin-top:10px;"><a href="${esc(
        options.baseUrl.replace(/\/+$/, "")
      )}/analysis?week=${esc(edition.generated.week.start)}" style="font-family:${SANS};font-size:12px;color:${C.teal};text-decoration:underline;">Explore this week in the Analysis panel</a></div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(subjectLine(edition.generated.week))}</title>
</head>
<body style="margin:0;padding:0;background:${C.pageBg};-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:${C.pageBg};">
    <tr><td align="center" style="padding:20px 8px 28px;">
      <!--[if mso]><table role="presentation" width="640" cellpadding="0" cellspacing="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;">

        <tr><td style="background:${C.navy};border-radius:12px 12px 0 0;padding:24px 20px 20px;">
          <div style="font-family:${MONO};font-size:10px;letter-spacing:2px;text-transform:uppercase;color:${C.teal};">Ocean Freight Update &middot; AOA</div>
          <!-- The date range, not a period name. A reader forwarding this six
               weeks later should not have to open it to know which week it
               covers. Sized down from 23px because "28 Dec 2026 – 3 Jan 2027"
               is more than twice the width a month name was, and the header is
               the one place where a wrap looks like a mistake. -->
          <div style="font-family:${SANS};font-size:20px;font-weight:700;color:#ffffff;margin-top:7px;line-height:1.3;">Week of ${esc(
            weekRangeLabel(edition.generated.week)
          )}</div>
          <div style="font-family:${SANS};font-size:12px;color:${C.dim};margin-top:5px;line-height:1.5;">Ocean Hub Desk &middot; Monday to Sunday &middot; weekly market and coverage read</div>
          ${
            // Said in the email, not only in the composer. If someone sends
            // before the week closes, the person reading it is the one who most
            // needs to know the counts are partial.
            edition.generated.partialWeek
              ? `<div style="font-family:${SANS};font-size:11.5px;color:${C.amber};margin-top:8px;line-height:1.5;">Sent before the week closed &mdash; this edition covers ${esc(
                  weekRangeLabel(edition.generated.week)
                )} up to the day it was prepared, not the full week.</div>`
              : ""
          }
        </td></tr>

        ${body}

        <tr><td style="padding:24px 16px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;"><tr>
            <td style="background:${C.navy};border-radius:12px;padding:18px 20px;">
              <div style="font-family:${SANS};font-size:13.5px;font-weight:700;color:#ffffff;">Ocean Hub Desk</div>
              <div style="font-family:${SANS};font-size:11.5px;color:${C.dim};margin-top:6px;line-height:1.6;">${esc(
                sourceLine(edition.generated)
              )}</div>
              ${explore}
            </td>
          </tr></table>
        </td></tr>

      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;
}

/** The subject line to paste alongside the body. */
export { subjectLine };
