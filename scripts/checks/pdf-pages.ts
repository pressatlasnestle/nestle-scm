/**
 * Renders a generated PDF's pages to PNGs so they can be opened and looked at.
 *
 *   npx tsx scripts/checks/pdf-pages.ts .harness/analysis.pdf
 *
 * This is the only check that separates a correct export from one that wrote
 * successfully and left blank rectangles where the charts should be. Every
 * cheaper signal — no exception thrown, a plausible byte count, the right page
 * count — reads identically in both cases.
 *
 * Runs in Node rather than in the browser harness on purpose. pdf.js drives its
 * render loop from requestAnimationFrame, which never fires in a page that is
 * not compositing, so browser-side rendering hangs indefinitely in a headless
 * or hidden pane. Node with @napi-rs/canvas has no such dependency.
 *
 * Also reports the ink coverage of each page: a page that renders as pure white
 * is the exact failure being guarded against, and it is worth failing loudly on
 * rather than leaving to the eye.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

/**
 * pdf.js substitutes a real font for the PDF's base-14 Helvetica, and outside a
 * browser there is nothing registered to substitute WITH — the glyphs then come
 * out scrambled. Registering a system sans-serif under the names pdf.js looks
 * for makes the rendered pages readable.
 *
 * Best-effort: if none of these exist, the pages still render and the images
 * are still verifiable, the text is just ugly. What the PDF actually CONTAINS
 * is proved by pdf-text.ts, which reads the text operators and does not depend
 * on any of this.
 */
function registerFallbackFonts(): string[] {
  const registered: string[] = [];
  const candidates = [
    ["C:/Windows/Fonts/arial.ttf", "Helvetica"],
    ["C:/Windows/Fonts/arialbd.ttf", "Helvetica-Bold"],
    ["/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", "Helvetica"],
    ["/System/Library/Fonts/Supplemental/Arial.ttf", "Helvetica"],
  ] as const;
  for (const [path, name] of candidates) {
    try {
      if (GlobalFonts.registerFromPath(path, name)) registered.push(name);
    } catch {
      // Absent on this machine; try the next.
    }
  }
  return registered;
}

/** Below this fraction of non-white pixels, a page is treated as blank. */
const MIN_INK = 0.005;

async function main() {
  const file = process.argv[2] ?? ".harness/analysis.pdf";
  const scale = Number(process.argv[3] ?? 1.5);
  const outDir = join(dirname(file), "pages");
  mkdirSync(outDir, { recursive: true });

  const fonts = registerFallbackFonts();
  if (fonts.length) console.log(`Registered fallback font(s): ${fonts.join(", ")}`);

  // The legacy build is the one that runs outside a browser.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const bytes = readFileSync(file);
  const data = new Uint8Array(bytes);

  const pdf = await pdfjs.getDocument({
    data,

    // Lets pdf.js substitute the fonts registered above for the PDF's
    // base-14 Helvetica. Without a substitute the text renders as scrambled
    // glyphs — a rendering artefact of this script, not of the document; what
    // the PDF contains is proved separately by pdf-text.ts.
    useSystemFonts: true,
  }).promise;

  // Length read before getDocument, which detaches the buffer it is handed.
  console.log(`${basename(file)} — ${pdf.numPages} page(s), ${bytes.length} bytes\n`);

  let failures = 0;

  for (let p = 1; p <= pdf.numPages; p += 1) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height)
    );
    const ctx = canvas.getContext("2d");
    // A PDF page is white; an unpainted canvas is transparent, and a
    // transparent page would score as "no ink" for the wrong reason.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;

    const png = canvas.toBuffer("image/png");
    const out = join(outDir, `page-${p}.png`);
    writeFileSync(out, png);

    // Ink coverage, sampled on a grid — a full per-pixel scan of five A4 pages
    // at 1.5x is a lot of work for a number that only needs one significant
    // figure.
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let inked = 0;
    let sampled = 0;
    for (let i = 0; i < img.data.length; i += 4 * 7) {
      sampled += 1;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      if (r < 245 || g < 245 || b < 245) inked += 1;
    }
    const coverage = inked / Math.max(1, sampled);
    const ok = coverage >= MIN_INK;
    if (!ok) failures += 1;

    console.log(
      `${ok ? "PASS" : "FAIL"}  page ${p}  ${canvas.width}x${canvas.height}  ` +
        `ink ${(coverage * 100).toFixed(1)}%  ${(png.length / 1024).toFixed(0)}KB  → ${out}`
    );
  }

  console.log(
    failures === 0
      ? "\nEvery page rendered with content."
      : `\n${failures} page(s) came out effectively blank.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
