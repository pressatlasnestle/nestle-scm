/**
 * Extracts the text of a generated PDF, page by page.
 *
 *   npx tsx scripts/checks/pdf-text.ts .harness/analysis.pdf
 *
 * Complements pdf-pages.ts. That one rasterises, and its output depends on
 * whether pdf.js can find substitute fonts for the base-14 set — when it
 * cannot, glyphs come out scrambled even though the document is correct. This
 * reads the text operators directly, so it says what the PDF actually
 * CONTAINS regardless of how it draws in any particular viewer.
 *
 * Between the two: this proves the words are right, the other proves the
 * pictures are there.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

async function main() {
  const file = process.argv[2] ?? ".harness/analysis.pdf";
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const data = new Uint8Array(readFileSync(file));
  const pdf = await pdfjs.getDocument({ data }).promise;

  console.log(`${basename(file)} — ${pdf.numPages} page(s)\n`);

  for (let p = 1; p <= pdf.numPages; p += 1) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const text = content.items
      .map((i) => ("str" in i ? i.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    // Images carry no text, so a chart-only page is legitimately short. The
    // count is printed rather than asserted for that reason.
    console.log(`--- page ${p} (${text.length} chars) ---`);
    console.log(text.slice(0, 1400));
    console.log();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
