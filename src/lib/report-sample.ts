import type { ReportData } from "./report-template";

/**
 * Fixture styled after the Ocean Freight sample digest, used by the newsletter
 * preview when the `reports` table is still empty (no ingestion/mailer yet).
 * Purely for design sign-off — clearly labelled as a sample in the UI.
 */
export const SAMPLE_REPORT: ReportData = {
  week_of: "2026-08-04",
  article_count: 47,
  source_count: 9,
  sentiment: { positive: 12, neutral: 26, negative: 9 },
  top_stories: [
    {
      headline: "Red Sea diversions push Asia–Europe transit times past 40 days",
      media: "Lloyd's List",
      published_at: "2026-08-06",
      sentiment: "negative",
      summary:
        "Carriers continue routing around the Cape of Good Hope, adding roughly two weeks to headhaul schedules and squeezing equipment availability at origin. Shippers are advised to rebuild safety stock assumptions for Q4.",
      url: "https://lloydslist.com/rss",
      keywords: ["Suez Canal", "schedule reliability"],
    },
    {
      headline: "Spot rates on the transpacific ease 6% as new capacity lands",
      media: "TradeWinds",
      published_at: "2026-08-05",
      sentiment: "positive",
      summary:
        "A wave of newbuild deliveries is loosening space on the transpacific, with FEU spot rates softening for a third consecutive week. Analysts expect the downward drift to hold into the shoulder season.",
      url: "https://tradewindsnews.com/rss",
      keywords: ["container rates", "ocean freight"],
    },
    {
      headline: "Panama Canal lifts daily transit slots as reservoir levels recover",
      media: "Reuters — Shipping",
      published_at: "2026-08-05",
      sentiment: "positive",
      summary:
        "The Canal Authority raised its booking allowance after above-average rainfall, restoring a key shortcut for US Gulf–Asia flows and reducing pressure on already-stretched alternatives.",
      url: "https://reuters.com/business/shipping",
      keywords: ["Panama Canal drought"],
    },
    {
      headline: "Port congestion builds at North European hubs amid barge delays",
      media: "Splash247",
      published_at: "2026-08-04",
      sentiment: "negative",
      summary:
        "Yard density at Rotterdam and Antwerp is climbing as low-water levels on the Rhine slow barge evacuation of import boxes, lengthening dwell times for hinterland cargo.",
      url: "https://splash247.com/feed",
      keywords: ["port congestion"],
    },
    {
      headline: "Carriers trial slow-steaming to offset diversion fuel costs",
      media: "gCaptain",
      published_at: "2026-08-04",
      sentiment: "neutral",
      summary:
        "Several alliances are quietly extending schedules to absorb the added bunker burden of longer routings, a move that trades transit time for cost stability on core services.",
      url: "https://gcaptain.com/feed",
      keywords: ["ocean freight", "schedule reliability"],
    },
  ],
  media_breakdown: [
    { media: "Lloyd's List", count: 11 },
    { media: "TradeWinds", count: 9 },
    { media: "Splash247", count: 8 },
    { media: "Reuters — Shipping", count: 7 },
    { media: "gCaptain", count: 6 },
    { media: "Other", count: 6 },
  ],
  top_keywords: [
    { keyword: "ocean freight", count: 18 },
    { keyword: "port congestion", count: 12 },
    { keyword: "schedule reliability", count: 9 },
    { keyword: "Suez Canal", count: 7 },
    { keyword: "container rates", count: 6 },
    { keyword: "Panama Canal drought", count: 4 },
  ],
};
