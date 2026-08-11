/**
 * Feed-classification checks.
 *
 *   npm run check:parser
 *
 * The distinction under test: "a feed that happens to be empty" is not the
 * same as "not a feed". Conflating them reported 11 valid-but-empty Google
 * Alerts feeds as broken sources. hasFeedRoot answers "is this a feed at all";
 * itemsSeen answers "did it have anything in it", and only the first decides
 * whether the source is misconfigured.
 */
import { parseFeed } from "@/lib/ingestion/fetch";

type Case = {
  name: string;
  xml: string;
  hasFeedRoot: boolean;
  itemsSeen: number;
  xmlErrorExpected: boolean;
};

/** An Atom feed with a <feed> root and no <entry> — the Google Alerts shape. */
const EMPTY_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Google Alert - "port strike"</title>
  <updated>2026-08-11T09:00:00Z</updated>
  <id>tag:google.com,2005:reader/user/alerts/123</id>
</feed>`;

const POPULATED_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Google Alert - "port congestion"</title>
  <entry>
    <title>Port congestion worsens at Rotterdam</title>
    <link href="https://example.com/a"/>
    <published>2026-08-10T09:00:00Z</published>
    <content type="html">Container shipping delays lengthened again this week.</content>
  </entry>
</feed>`;

const EMPTY_RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Quiet Publisher</title>
  <link>https://example.com</link>
  <description>Nothing published yet</description>
</channel></rss>`;

const POPULATED_RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Busy Publisher</title>
  <item>
    <title>Ocean freight rates climb</title>
    <link>https://example.com/b</link>
    <description>Container shipping spot rates rose for a third week.</description>
    <pubDate>Mon, 10 Aug 2026 09:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const EMPTY_RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/">
  <channel><title>RDF feed with nothing in it</title></channel>
</rdf:RDF>`;

/** What a newsroom landing page actually looks like: not well-formed XML. */
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Newsroom</title></head>
<body><div class=teaser><p>Latest updates<br>Read more</div></body></html>`;

/** Well-formed XML, but not a feed — the case XMLValidator alone would miss. */
const XML_NOT_A_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
</sitemapindex>`;

/**
 * No feed wrapper at all — the document root IS the item. Degenerate, but it
 * is exactly what extractEntries' last-resort branch was written for, and
 * finding an entry that way still proves the URL serves a feed of some kind.
 */
const LOOSE_ITEMS = `<?xml version="1.0"?>
<item><title>Port strike at Le Havre</title><description>Liner shipping disrupted.</description></item>`;

const CASES: Case[] = [
  { name: "Atom feed, zero entries (Google Alerts, nothing matched yet)", xml: EMPTY_ATOM, hasFeedRoot: true, itemsSeen: 0, xmlErrorExpected: false },
  { name: "Atom feed with an entry", xml: POPULATED_ATOM, hasFeedRoot: true, itemsSeen: 1, xmlErrorExpected: false },
  { name: "RSS 2.0 channel, zero items", xml: EMPTY_RSS, hasFeedRoot: true, itemsSeen: 0, xmlErrorExpected: false },
  { name: "RSS 2.0 with an item", xml: POPULATED_RSS, hasFeedRoot: true, itemsSeen: 1, xmlErrorExpected: false },
  { name: "RSS 1.0 / RDF, zero items", xml: EMPTY_RDF, hasFeedRoot: true, itemsSeen: 0, xmlErrorExpected: false },
  { name: "HTML page (not well-formed XML)", xml: HTML_PAGE, hasFeedRoot: false, itemsSeen: 0, xmlErrorExpected: true },
  { name: "valid XML but no feed root (sitemap)", xml: XML_NOT_A_FEED, hasFeedRoot: false, itemsSeen: 0, xmlErrorExpected: false },
  { name: "bare <item> as document root, no feed wrapper", xml: LOOSE_ITEMS, hasFeedRoot: true, itemsSeen: 1, xmlErrorExpected: false },
  { name: "empty response body", xml: "", hasFeedRoot: false, itemsSeen: 0, xmlErrorExpected: true },
];

let failures = 0;

for (const testCase of CASES) {
  const parsed = parseFeed(testCase.xml, null);
  const problems: string[] = [];

  if (parsed.hasFeedRoot !== testCase.hasFeedRoot) {
    problems.push(`hasFeedRoot ${parsed.hasFeedRoot}, want ${testCase.hasFeedRoot}`);
  }
  if (parsed.itemsSeen !== testCase.itemsSeen) {
    problems.push(`itemsSeen ${parsed.itemsSeen}, want ${testCase.itemsSeen}`);
  }
  if (testCase.xmlErrorExpected !== (parsed.xmlError !== null)) {
    problems.push(
      `xmlError ${parsed.xmlError === null ? "null" : `"${parsed.xmlError}"`}, want ${testCase.xmlErrorExpected ? "set" : "null"}`
    );
  }

  if (problems.length > 0) {
    failures += 1;
    console.log(`FAIL  ${testCase.name}\n        ${problems.join("\n        ")}`);
  } else {
    console.log(`PASS  ${testCase.name}`);
  }
}

console.log(`\n${CASES.length - failures}/${CASES.length} passed`);
process.exit(failures === 0 ? 0 : 1);
