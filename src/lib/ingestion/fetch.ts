import { XMLParser, XMLValidator } from "fast-xml-parser";
import type {
  FeedItem,
  IngestionClient,
  IngestionWindow,
  SourceRow,
} from "./types";

/**
 * Phase 1 — core RSS fetch. One source in, one parsed+windowed item list out.
 * This is the atomic unit every run type calls (backfill, scheduled,
 * source_added, google_news_sweep); nothing else talks to the network.
 */

const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "nestle-scm-ingestion/1.0 (+media monitoring; contact via site admin)";

export type FetchStatus = "ok" | "error" | "no_new_items";

export type FetchSourceResult = {
  sourceId: string;
  sourceName: string;
  status: FetchStatus;
  /** Items inside the window, usable. */
  items: FeedItem[];
  /** Entries present in the feed at all, before windowing or skipping. */
  itemsSeen: number;
  /** Unparseable or paywalled entries — never stored as stubs. */
  skippedPaywall: number;
  error: string | null;
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Feed values are text, not data — "07" must stay "07", not become 7, and a
  // numeric-looking headline must stay a string.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // Namespace prefixes are kept (dc:creator, content:encoded) and read by name.
  removeNSPrefix: false,
});

/** XML/HTML entity decode for the handful that survive the XML parse. */
function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#8217;|&rsquo;/gi, "’")
    .replace(/&#8216;|&lsquo;/gi, "‘")
    .replace(/&#8220;|&ldquo;/gi, "“")
    .replace(/&#8221;|&rdquo;/gi, "”")
    .replace(/&#8211;|&ndash;/gi, "–")
    .replace(/&#8212;|&mdash;/gi, "—")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code))
    );
}

/** HTML → plain text. Feed bodies are routinely HTML fragments. */
function toPlainText(value: unknown): string {
  if (value == null) return "";
  const raw = typeof value === "string" ? value : String(value);
  return decodeEntities(
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function countWords(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

/** Reads a node that may be a string, an object with #text, or an array. */
function textOf(node: unknown): string {
  if (node == null) return "";
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === "object") {
    const rec = node as Record<string, unknown>;
    if ("#text" in rec) return toPlainText(rec["#text"]);
    return "";
  }
  return toPlainText(node);
}

/** Atom <link> is attribute-based and often repeated with different rels. */
function linkOf(node: unknown): string | null {
  if (node == null) return null;
  if (Array.isArray(node)) {
    const alternate = node.find(
      (l) =>
        typeof l === "object" &&
        l !== null &&
        ((l as Record<string, unknown>)["@_rel"] === "alternate" ||
          (l as Record<string, unknown>)["@_rel"] === undefined)
    );
    return linkOf(alternate ?? node[0]);
  }
  if (typeof node === "object") {
    const rec = node as Record<string, unknown>;
    const href = rec["@_href"];
    if (typeof href === "string" && href.trim()) return href.trim();
    if (typeof rec["#text"] === "string" && rec["#text"].trim()) {
      return (rec["#text"] as string).trim();
    }
    return null;
  }
  const s = String(node).trim();
  return s || null;
}

function parseDate(...candidates: unknown[]): Date | null {
  for (const candidate of candidates) {
    const raw = textOf(candidate);
    if (!raw) continue;
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function firstNonEmpty(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const text = textOf(candidate);
    if (text) return text;
  }
  return "";
}

/**
 * Paywall / stub detection. Pragmatic v1: a marker phrase in the body, or a
 * body that is empty once HTML is stripped. Both mean there is nothing to
 * match on beyond the headline, and the contract is to skip rather than store
 * a stub row.
 */
const PAYWALL_MARKERS =
  /\b(subscribe (?:now )?to (?:continue )?read|subscribers only|subscriber-only|sign in to (?:continue )?read|log in to (?:continue )?read|this (?:article|content) is (?:for|available to) (?:subscribers|members)|premium (?:article|content)|register to (?:continue )?read|to continue reading)\b/i;

export function looksPaywalled(body: string): boolean {
  return PAYWALL_MARKERS.test(body);
}

type ParsedNode = Record<string, unknown>;

/**
 * Pulls the item array out of RSS 2.0, RSS 1.0/RDF or Atom, whichever it is.
 *
 * `hasFeedRoot` is the difference between "this is a feed that happens to be
 * empty right now" and "this is not a feed". A standing Google Alerts search
 * that has matched nothing yet serves a perfectly valid Atom document with a
 * <feed> root and no <entry> children; a newsroom HTML page has neither. Only
 * the second is a misconfigured source.
 */
function extractEntries(doc: ParsedNode): {
  entries: ParsedNode[];
  feedTitle: string;
  hasFeedRoot: boolean;
} {
  const rss = doc["rss"] as ParsedNode | undefined;
  if (rss) {
    const channel = (rss["channel"] ?? {}) as ParsedNode;
    return {
      entries: asArray(channel["item"]),
      feedTitle: firstNonEmpty(channel["title"]),
      hasFeedRoot: true,
    };
  }

  const rdf = (doc["rdf:RDF"] ?? doc["RDF"]) as ParsedNode | undefined;
  if (rdf) {
    const channel = (rdf["channel"] ?? {}) as ParsedNode;
    return {
      entries: asArray(rdf["item"]),
      feedTitle: firstNonEmpty(channel["title"]),
      hasFeedRoot: true,
    };
  }

  const feed = doc["feed"] as ParsedNode | undefined;
  if (feed) {
    return {
      entries: asArray(feed["entry"]),
      feedTitle: firstNonEmpty(feed["title"]),
      hasFeedRoot: true,
    };
  }

  // Some feeds omit the wrapper or use an unexpected root; fall back to any
  // top-level item/entry collection rather than failing the whole source.
  // Finding entries this way still proves it is a feed — finding none proves
  // nothing either way, so the root is reported as unrecognised.
  const loose = asArray(doc["item"] ?? doc["entry"]);
  return {
    entries: loose,
    feedTitle: "",
    hasFeedRoot: loose.length > 0,
  };
}

function asArray(node: unknown): ParsedNode[] {
  if (node == null) return [];
  if (Array.isArray(node)) return node as ParsedNode[];
  return [node as ParsedNode];
}

export type ParseOutcome = {
  items: FeedItem[];
  itemsSeen: number;
  skippedPaywall: number;
  /**
   * The document parsed as XML and had a recognisable feed root. False means
   * the URL is not a feed at all; it does NOT mean the feed was empty.
   */
  hasFeedRoot: boolean;
  /** Set when the response is not well-formed XML, so cannot be a feed. */
  xmlError: string | null;
};

/**
 * Parses feed XML into FeedItems. Shared by the per-source fetch and the
 * Google News sweep — Google News RSS is ordinary RSS 2.0 whose items carry a
 * per-item <source> naming the real publisher, which `mediaFallback` must not
 * override.
 */
export function parseFeed(xml: string, mediaFallback: string | null): ParseOutcome {
  // XMLValidator first, because the parser is deliberately lenient: handed an
  // HTML page it returns a shrug of an object rather than throwing, and the
  // caller could not otherwise tell that apart from a valid empty feed.
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: true });
  if (validation !== true) {
    return {
      items: [],
      itemsSeen: 0,
      skippedPaywall: 0,
      hasFeedRoot: false,
      xmlError: validation.err.msg,
    };
  }

  const doc = parser.parse(xml) as ParsedNode;
  const { entries, feedTitle, hasFeedRoot } = extractEntries(doc);

  const items: FeedItem[] = [];
  let skippedPaywall = 0;

  for (const entry of entries) {
    const headline = firstNonEmpty(entry["title"]);

    const body = firstNonEmpty(
      entry["content:encoded"],
      entry["content"],
      entry["description"],
      entry["summary"],
      entry["dc:description"]
    );

    // Unparseable (no headline) or a paywalled/empty stub: skipped, never
    // stored. Both roll up into articles_skipped_paywall on the run.
    if (!headline || !body || looksPaywalled(body)) {
      skippedPaywall += 1;
      continue;
    }

    const authorNode = entry["author"];
    const byline =
      firstNonEmpty(
        entry["dc:creator"],
        typeof authorNode === "object" && authorNode !== null
          ? (authorNode as ParsedNode)["name"]
          : authorNode,
        entry["creator"]
      ) || null;

    // Per-item <source> wins over the feed title: this is what makes the
    // Google News sweep attribute items to the actual publisher.
    const itemSource = firstNonEmpty(entry["source"]);
    const media = itemSource || feedTitle || mediaFallback;

    items.push({
      headline,
      url: linkOf(entry["link"]) ?? linkOf(entry["guid"]),
      byline,
      media: media || null,
      publishedAt: parseDate(
        entry["pubDate"],
        entry["published"],
        entry["dc:date"],
        entry["updated"]
      ),
      body,
      wordCount: countWords(body),
    });
  }

  return {
    items,
    itemsSeen: entries.length,
    skippedPaywall,
    hasFeedRoot,
    xmlError: null,
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export async function fetchFeedXml(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Items with no usable date are kept — see FeedItem.publishedAt. */
export function withinWindow(item: FeedItem, window: IngestionWindow): boolean {
  if (!item.publishedAt) return true;
  const t = item.publishedAt.getTime();
  return t >= window.start.getTime() && t <= window.end.getTime();
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.name === "AbortError"
      ? `Timed out after ${FETCH_TIMEOUT_MS}ms`
      : err.message;
  }
  return String(err);
}

/**
 * Fetches and parses one source, then records the outcome on the source row.
 * The `sources.last_fetch_*` write happens on every call regardless of run
 * type or outcome — the Media Universe panel's health column is only useful if
 * it reflects the last attempt, not the last success.
 */
export async function fetchSource(
  client: IngestionClient,
  source: Pick<SourceRow, "id" | "name" | "rss_url">,
  window: IngestionWindow
): Promise<FetchSourceResult> {
  const base = { sourceId: source.id, sourceName: source.name };

  if (!source.rss_url || !source.rss_url.trim()) {
    const result: FetchSourceResult = {
      ...base,
      status: "error",
      items: [],
      itemsSeen: 0,
      skippedPaywall: 0,
      error: "No RSS URL configured.",
    };
    await recordFetchOutcome(client, source.id, result);
    return result;
  }

  let result: FetchSourceResult;
  try {
    const xml = await fetchFeedXml(source.rss_url.trim());
    const parsed = parseFeed(xml, source.name);
    const items = parsed.items.filter((item) => withinWindow(item, window));

    // Two different failures used to be reported as one, and the wrong one
    // won. Several rows in the imported taxonomy point at an HTML newsroom
    // page rather than a feed — that is a permanently broken source and must
    // not hide behind a healthy-looking status. But a standing Google Alerts
    // search that has matched nothing yet serves a valid Atom document with a
    // <feed> root and no <entry> children, and treating that as broken raised
    // a false alarm on 11 alert feeds at once.
    //
    // So the question is no longer "were there entries" but "is this a feed":
    //   not well-formed XML, or no recognisable feed root → error
    //   a real feed with zero entries                     → no_new_items
    result = !parsed.hasFeedRoot
      ? {
          ...base,
          status: "error",
          items: [],
          itemsSeen: 0,
          skippedPaywall: 0,
          error: parsed.xmlError
            ? `Response is not well-formed XML (${parsed.xmlError}) — URL is probably an HTML page, not an RSS/Atom feed.`
            : "No <rss>, <rdf:RDF> or <feed> root element — URL is probably an HTML page, not an RSS/Atom feed.",
        }
      : {
          ...base,
          status: items.length > 0 ? "ok" : "no_new_items",
          items,
          itemsSeen: parsed.itemsSeen,
          skippedPaywall: parsed.skippedPaywall,
          error: null,
        };
  } catch (err) {
    result = {
      ...base,
      status: "error",
      items: [],
      itemsSeen: 0,
      skippedPaywall: 0,
      error: errorMessage(err).slice(0, 500),
    };
  }

  await recordFetchOutcome(client, source.id, result);
  return result;
}

async function recordFetchOutcome(
  client: IngestionClient,
  sourceId: string,
  result: FetchSourceResult
): Promise<void> {
  await client
    .from("sources")
    .update({
      last_fetched_at: new Date().toISOString(),
      last_fetch_status: result.status,
      last_fetch_error: result.error,
    })
    .eq("id", sourceId);
}
