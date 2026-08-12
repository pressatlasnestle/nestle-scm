/**
 * Turning a rendered SVG chart into a PNG, in the browser.
 *
 * Shared by the PDF export and the visual harness, so there is exactly one
 * implementation of a job with several non-obvious failure modes. Both need
 * the same thing — a pixel-accurate copy of a chart that is already on screen
 * and already laid out — and a second implementation would drift from the
 * first in precisely the ways below.
 *
 * THE FAILURE MODES THIS EXISTS TO HANDLE.
 *
 * 1. CSS custom properties do not resolve inside an <img>. Every colour in
 *    this panel is a var(--teal)-style reference, and an SVG loaded as an
 *    image is a separate document with no access to the page's :root. Left
 *    alone, every chart rasterises as unstyled black-on-transparent. So every
 *    paint and text property is flattened to its computed value first.
 *
 * 2. The same applies to fonts. A font-family of var(--font-display) inside
 *    the serialised SVG renders as the browser default, silently changing
 *    every text metric.
 *
 * 3. An SVG with no background is transparent, and a transparent PNG placed
 *    on a white PDF page shows light text on white. The panel's surface colour
 *    is painted in explicitly.
 *
 * None of these throw. All of them produce a plausible-looking but wrong
 * image, which is why this is worth centralising rather than re-deriving.
 */

/**
 * Properties copied from the live element to the clone.
 *
 * Deliberately a fixed list rather than every computed property: copying the
 * full computed style would inline hundreds of declarations per node, inflate
 * the serialised document enormously, and drag in properties (transforms,
 * transitions) that fight the ones already set as attributes.
 */
const PAINT_PROPERTIES = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "opacity",
] as const;

export type RasterizeOptions = {
  /** Pixel density. 2 keeps chart text crisp when scaled into a PDF. */
  scale?: number;
  /** Painted behind the chart. Defaults to the nearest card's background. */
  background?: string;
};

export type Raster = {
  /** PNG data URL. */
  dataUrl: string;
  /** CSS-pixel dimensions, before `scale`. What to size it at downstream. */
  width: number;
  height: number;
};

/** The largest SVG inside `root` — the chart itself, not a legend swatch. */
export function findChartSvg(root: Element): SVGSVGElement | null {
  const svgs = [...root.querySelectorAll("svg")];
  if (svgs.length === 0) return null;
  return svgs.reduce((best, s) => {
    const a = s.getBoundingClientRect();
    const b = best.getBoundingClientRect();
    return a.width * a.height > b.width * b.height ? s : best;
  });
}

/**
 * Rasterises one on-screen SVG to a PNG data URL.
 *
 * Resolves only once the image has decoded, so a caller that awaits this can
 * rely on the result being complete rather than a half-painted canvas.
 */
export async function rasterizeSvg(
  svg: SVGSVGElement,
  options: RasterizeOptions = {}
): Promise<Raster> {
  const scale = options.scale ?? 2;
  const rect = svg.getBoundingClientRect();
  const width = Math.ceil(rect.width);
  const height = Math.ceil(rect.height);

  const clone = svg.cloneNode(true) as SVGSVGElement;

  // Walked in parallel: querySelectorAll returns the same document order for
  // the original and its clone, so index i is the same node in both.
  const source = svg.querySelectorAll("*");
  const target = clone.querySelectorAll("*");
  for (let i = 0; i < source.length; i += 1) {
    const computed = getComputedStyle(source[i]);
    const node = target[i] as SVGElement;
    for (const property of PAINT_PROPERTIES) {
      const value = computed.getPropertyValue(property);
      if (value) node.setAttribute(property, value);
    }
    // The inline style would otherwise re-introduce the var() references the
    // attributes above were just written to replace.
    node.removeAttribute("style");
  }

  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));

  const background =
    options.background ??
    getComputedStyle(svg.closest(".chart-card") ?? document.body)
      .backgroundColor;
  const backdrop = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "rect"
  );
  backdrop.setAttribute("width", String(width));
  backdrop.setAttribute("height", String(height));
  backdrop.setAttribute("fill", background || "#111b2e");
  clone.insertBefore(backdrop, clone.firstChild);

  const xml = new XMLSerializer().serializeToString(clone);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;

  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () =>
      reject(new Error("The chart could not be converted to an image."));
    image.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser did not provide a 2D canvas.");
  ctx.scale(scale, scale);
  ctx.drawImage(image, 0, 0, width, height);

  return { dataUrl: canvas.toDataURL("image/png"), width, height };
}

/**
 * Rasterises the chart inside the card whose <h3> matches `title`.
 *
 * Returns null when the card is absent — a week with nothing coded renders no
 * theme chart at all, and the export should omit that section rather than fail.
 */
export async function rasterizeCard(
  title: string,
  options?: RasterizeOptions
): Promise<Raster | null> {
  const card = [...document.querySelectorAll(".chart-card")].find(
    (c) => c.querySelector("h3")?.textContent?.trim() === title
  );
  if (!card) return null;
  const svg = findChartSvg(card);
  if (!svg) return null;
  return rasterizeSvg(svg, options);
}
