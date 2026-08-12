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

/**
 * Font size from mention count.
 *
 * Square-root scaled, not linear. A week's mention counts are long-tailed — one
 * keyword at 400 against a tail at 5 — and a linear map would render the tail
 * unreadably small to make room for the head. sqrt compresses the top without
 * inverting any ordering, so a bigger word is still always a bigger number.
 */
function makeSizer(words: WordCloudWord[]) {
  const max = Math.max(1, ...words.map((w) => w.mentions));
  const min = Math.min(...words.map((w) => w.mentions), 0);
  const MIN_PX = 12;
  const MAX_PX = 64;

  return (word: { value: number }) => {
    const span = Math.sqrt(max) - Math.sqrt(min) || 1;
    const t = (Math.sqrt(word.value) - Math.sqrt(min)) / span;
    return MIN_PX + t * (MAX_PX - MIN_PX);
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
  const byText = useMemo(
    () => new Map(shown.map((w) => [w.keyword, w])),
    [shown]
  );

  const data = useMemo(
    () => shown.map((w) => ({ text: w.keyword, value: w.mentions })),
    [shown]
  );

  const fontSize = useMemo(() => makeSizer(shown), [shown]);
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
          width={880}
          height={420}
          fontSize={fontSize}
          font="var(--font-display)"
          padding={3}
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
                  fontWeight={600}
                  style={{ cursor: "default" }}
                >
                  {/* Native SVG tooltip: the numbers behind the colour, so a
                      reader can check a call rather than trust the hue. */}
                  <title>
                    {`${w.text} — ${meta?.mentions ?? 0} mentions across ${meta?.articles ?? 0} article(s)\n` +
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
