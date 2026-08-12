/**
 * CSV export, shared by every chart on the Analysis panel.
 *
 * One function, one column-definition shape, one download path — because the
 * alternative is each chart hand-rolling its own quoting, and the first
 * headline containing a comma would silently shift every column to its right
 * in exactly one export. Chart data is small (tens to hundreds of rows), so
 * this builds the whole file in memory and hands it to the browser; nothing
 * here needs streaming.
 *
 * A column's `value` returns the RAW value, not a formatted one. Numbers stay
 * numbers so a spreadsheet treats them as numbers, and so the injection guard
 * below can tell a negative number from a string that starts with a minus.
 */

export type CsvValue = string | number | boolean | null | undefined;

export type CsvColumn<T> = {
  /** Header cell text. */
  header: string;
  value: (row: T) => CsvValue;
};

/**
 * Characters that make Excel/Sheets treat a cell as a formula rather than as
 * text. Article headlines, media names and keywords are all third-party text
 * that reaches this file unmodified, so a headline beginning "=" is not a
 * hypothetical — and an exported CSV is precisely the artefact someone opens
 * in a spreadsheet without thinking about it.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * RFC 4180 quoting, plus the formula guard.
 *
 * The guard applies to STRINGS only. A numeric -3 is a number and must stay
 * one; it is a string "-3 percent" that would need neutralising. Prefixing an
 * apostrophe is the conventional fix and is what a spreadsheet strips back off
 * on display, so the cell reads correctly to a human.
 */
function escapeCell(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    // NaN/Infinity would land in the file as literal text a spreadsheet cannot
    // parse; an empty cell is honest about the value being absent.
    return Number.isFinite(value) ? String(value) : "";
  }
  if (typeof value === "boolean") return value ? "true" : "false";

  const neutralised = FORMULA_LEAD.test(value);
  const guarded = neutralised ? `'${value}` : value;

  // Quote whenever a delimiter, quote, newline or edge whitespace is present —
  // edge whitespace because unquoted leading spaces are silently trimmed by
  // some readers.
  //
  // A neutralised cell is ALWAYS quoted as well. The apostrophe is what stops
  // the formula evaluating, and quoting does not add to that; it makes the
  // escape explicit so a reader that treats a bare leading apostrophe as a
  // quoting dialect of its own cannot strip it back off and re-arm the cell.
  if (neutralised || /[",\r\n]/.test(guarded) || guarded !== guarded.trim()) {
    return `"${guarded.replace(/"/g, '""')}"`;
  }
  return guarded;
}

/** Builds the CSV text. Exported separately so it can be checked without a DOM. */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((c) => escapeCell(c.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCell(c.value(row))).join(","));
  }
  // CRLF per RFC 4180. A trailing newline keeps the last row from being
  // concatenated onto whatever a tool appends next.
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Makes a filename safe and recognisable: "volume-2026-W33.csv".
 * Anything a filesystem might object to becomes a hyphen.
 */
export function csvFilename(base: string, weekLabel: string): string {
  const clean = `${base}-${weekLabel}`
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${clean || "export"}.csv`;
}

/**
 * Builds the CSV and triggers a browser download. Client-only.
 *
 * The leading BOM is what makes Excel read the file as UTF-8. Without it Excel
 * assumes the local codepage, and every non-ASCII character in a headline —
 * an en dash, a curly quote, an accented port name — arrives mangled.
 */
export function downloadCsv<T>(
  filename: string,
  rows: T[],
  columns: CsvColumn<T>[]
): void {
  const blob = new Blob(["﻿", toCsv(rows, columns)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can race the download in some browsers; a tick is
  // enough and the object is small.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
