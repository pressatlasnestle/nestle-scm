"use client";

import { useMemo } from "react";
// Root import only: the package's `exports` map exposes "." and nothing else,
// so a deep path like @visx/wordcloud/lib/Wordcloud fails to resolve.
import { Wordcloud } from "@visx/wordcloud";
import type { Week } from "@/lib/analysis/week-period";
import type { Polarity, WordCloudWord } from "@/lib/analysis/week-stats";
import { csvFilename, downloadCsv } from "@/lib/analysis/csv";
import { WORD_CLOUD_COLUMNS } from "@/lib/analysis/exports";
import { ChartCard } from "./ChartCard";

/**
 * Keyword word cloud, coloured by the dominant favourability of the coverage
 * each keyword appears in.
 *
 * WHY @visx/wordcloud.
 *
 * Recharts has no word-cloud primitive — it charts series against axes, and a
 * cloud is a text-packing problem, so this is the one chart on the panel that
 * needs something else.
 *
 * The layout algorithm everyone uses is Jason Davies' d3-cloud: it places words
 * largest-first along an Archimedean spiral out from the centre, which is
 * exactly the centre-out, biggest-in-the-middle arrangement wanted here. The
 * only real question was which wrapper.
 *
 *   react-wordcloud   the obvious search result, and unusable: it peers on
 *                     React ^16.13 against this project's React 19, and drags
 *                     in d3-selection/d3-transition/tippy/resize-observer-
 *                     polyfill. Installing it needs --legacy-peer-deps, which
 *                     is not a green light, it is a suppressed warning.
 *   @visx/wordcloud   peers on ^18 || ^19, so React 19 is declared-supported
 *                     rather than hoped-for, and installs with no peer
 *                     resolution warnings. Depends on d3-cloud and @visx/group
 *                     and nothing else.
 *   d3-cloud direct   also fine, and what both of the above wrap. Rejected
 *                     only because visx already provides the React lifecycle
 *                     around it while still handing back raw positioned words.
 *
 * visx renders through a child function, so every <text> below is ours: the
 * cloud themes with the same CSS variables and font stack as the Recharts
 * charts rather than arriving with a look of its own.
 *
 * WHY IT IS LOADED WITH ssr: false (see AnalysisView).
 *
 * d3-cloud measures text by writing to a <canvas> to get glyph widths. That is
 * browser-only, and "use client" does NOT mean client-only — Next.js still
 * server-renders client components to produce the initial HTML, so importing
 * this eagerly crashes the render with a document-is-not-defined. The dynamic
 * import with ssr:false is load-bearing, not a preference.
 */

/**
 * Weight the cloud is drawn at. Declared once because d3-cloud must MEASURE at
 * the same weight the SVG renders at — see resolveFontFamily().
 */
const FONT_WEIGHT = 600;

/**
 * The concrete font family to hand d3-cloud.
 *
 * d3-cloud measures every word by assigning a canvas font shorthand:
 *
 *   c.font = style + " " + weight + " " + size + "px " + font
 *
 * A CSS custom property cannot survive that. Passing font="var(--font-display)"
 * produces "normal 600 44px var(--font-display)", which is not a valid font
 * shorthand, so the canvas SILENTLY IGNORES the assignment and keeps its
 * default of 10px sans-serif. Every word then gets measured as though it were
 * 10px while the SVG renders it at up to 44px, the layout packs boxes a
 * quarter of the size it is about to draw, and the result is a pile of
 * overlapping text — which is exactly what the chart looked like.
 *
 * Nothing errors and nothing warns. It is only visible by looking at it.
 *
 * So the variable is resolved to its real value here and the concrete family
 * is passed through. Safe to read at render: this component is loaded with
 * ssr:false, so there is always a document.
 */
function resolveFontFamily(): string {
  if (typeof document === "undefined") return "sans-serif";
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--font-display")
    .trim();
  // Belt and braces: if the variable is ever itself defined in terms of
  // another var, fall back rather than feed canvas something it will reject.
  return v && !v.includes("var(") ? v : "sans-serif";
}

const COLOR: Record<Polarity, string> = {
  favourable: "var(--teal)",
  neutral: "var(--text-dim)",
  unfavourable: "var(--coral)",
};

const LABEL: Record<Polarity, string> = {
  favourable: "Favourable",
  neutral: "Neutral / mixed",
  unfavourable: "Unfavourable",
};

const CLOUD_WIDTH = 880;
const CLOUD_HEIGHT = 420;

/**
 * Smallest size anything is drawn at.
 *
 * A floor, not a target. The previous 12px let the tail render at a size no
 * one reads, which bought room for more words at the cost of the words being
 * words. If a term cannot be shown at 16px it should not be in the cloud at
 * all — that is the cap's job, not the scale's.
 */
const MIN_PX = 16;

/**
 * Largest size anything is drawn at.
 *
 * Down from 64. The top term is obvious at 44px against a 16px floor, and
 * every pixel above that is width the layout has to find for the longest
 * label rather than emphasis anyone needs.
 */
const MAX_PX = 44;

/** Fraction of the canvas the widest label may occupy. */
const MAX_LABEL_WIDTH_RATIO = 0.62;

/** Rough advance width per character, as a multiple of font size, for a bold sans. */
const CHAR_WIDTH_RATIO = 0.58;

/**
 * Font size from mention count, clamped so the label still fits.
 *
 * Square-root scaled, not linear. A week's mention counts are long-tailed —
 * one keyword at 129 against a tail at 4 — and a linear map would render the
 * tail at the floor while the head takes all the room. sqrt compresses the top
 * without inverting any ordering, so a bigger word is still a bigger number.
 *
 * The width clamp is the part that matters. d3-cloud will happily lay out a
 * word wider than the canvas: it simply fails to place it, or places it
 * overflowing the edges, and either way the words after it get pushed into the
 * overlap. Deriving a per-word ceiling from its own character count means a
 * long label shrinks to fit instead of breaking the layout for everything
 * else. It never goes below MIN_PX — at that point the cap has already decided
 * the word earns its place.
 */
function makeSizer(words: WordCloudWord[]) {
  const max = Math.max(1, ...words.map((w) => w.mentions));
  const min = Math.min(...words.map((w) => w.mentions), 0);
  const span = Math.sqrt(max) - Math.sqrt(min) || 1;

  return (word: { text: string; value: number }) => {
    const t = (Math.sqrt(word.value) - Math.sqrt(min)) / span;
    const wanted = MIN_PX + t * (MAX_PX - MIN_PX);

    const budget =
      (CLOUD_WIDTH * MAX_LABEL_WIDTH_RATIO) /
      Math.max(1, word.text.length * CHAR_WIDTH_RATIO);

    return Math.max(MIN_PX, Math.min(wanted, budget));
  };
}

export function WordCloud({
  week,
  words,
  shown,
}: {
  week: Week;
  /** Full set — exported. */
  words: WordCloudWord[];
  /** Trimmed set — plotted. */
  shown: WordCloudWord[];
}) {
  // Keyed by the DRAWN label, since that is what comes back from the layout.
  const byText = useMemo(
    () => new Map(shown.map((w) => [w.label, w])),
    [shown]
  );

  const data = useMemo(
    () => shown.map((w) => ({ text: w.label, value: w.mentions })),
    [shown]
  );

  const fontSize = useMemo(() => makeSizer(shown), [shown]);
  const fontFamily = useMemo(resolveFontFamily, []);
  const hidden = words.length - shown.length;

  function exportCsv() {
    downloadCsv(csvFilename("keywords", week.isoLabel), words, WORD_CLOUD_COLUMNS);
  }

  return (
    <ChartCard
      title="Keywords this week"
      hint={
        <>
          Every tracked term that appeared in the week&apos;s coded articles.
          Size is total mentions; colour is the dominant favourability of the
          coverage it appeared in — weighted by mentions, with an exact tie
          shown as neutral.
          {hidden > 0 && (
            <>
              {" "}
              <strong>{hidden}</strong> smaller term{hidden === 1 ? "" : "s"} are
              not drawn; the CSV has all {words.length}.
            </>
          )}
        </>
      }
      onExport={exportCsv}
      empty={
        words.length === 0
          ? "No coded article in this week has a matched keyword."
          : undefined
      }
    >
      <div style={{ display: "flex", justifyContent: "center" }}>
        <Wordcloud
          words={data}
          width={CLOUD_WIDTH}
          height={CLOUD_HEIGHT}
          fontSize={fontSize}
          // Concrete family and matching weight, so what is measured is what is
          // drawn. Both matter: measuring at the default weight while drawing
          // at 600 under-measures every word by a few percent.
          font={fontFamily}
          fontWeight={FONT_WEIGHT}
          padding={4}
          spiral="archimedean"
          // Deterministic placement. d3-cloud defaults to Math.random for its
          // start angle, which would reshuffle the whole cloud on every render
          // — including on an unrelated week change — and make the chart look
          // like it was reporting different data.
          random={() => 0.5}
          rotate={0}
        >
          {(cloudWords) =>
            cloudWords.map((w) => {
              const meta = byText.get(w.text ?? "");
              const polarity = meta?.sentiment ?? "neutral";
              return (
                <text
                  key={w.text}
                  fill={COLOR[polarity]}
                  textAnchor="middle"
                  transform={`translate(${w.x}, ${w.y})`}
                  fontSize={w.size}
                  fontFamily={w.font}
                  fontWeight={FONT_WEIGHT}
                  style={{ cursor: "default" }}
                >
                  {/* Native SVG tooltip. Carries the FULL taxonomy term, not
                      the abbreviated label — this is where "DP World +5" is
                      spelled back out — plus the numbers behind the colour, so
                      a reader can check a call rather than trust the hue. */}
                  <title>
                    {`${meta?.keyword ?? w.text}\n` +
                      `${meta?.mentions ?? 0} mentions across ${meta?.articles ?? 0} article(s)\n` +
                      `${LABEL[polarity]} (favourable ${meta?.weights.favourable ?? 0} / neutral ${meta?.weights.neutral ?? 0} / unfavourable ${meta?.weights.unfavourable ?? 0} by mention weight)`}
                  </title>
                  {w.text}
                </text>
              );
            })
          }
        </Wordcloud>
      </div>

      <div
        style={{
          display: "flex",
          gap: 18,
          justifyContent: "center",
          paddingBottom: 6,
          fontSize: 12,
          color: "var(--text-muted)",
        }}
      >
        {(["favourable", "neutral", "unfavourable"] as Polarity[]).map((p) => (
          <span key={p} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: COLOR[p],
                display: "inline-block",
              }}
            />
            {LABEL[p]}
          </span>
        ))}
      </div>
    </ChartCard>
  );
}
