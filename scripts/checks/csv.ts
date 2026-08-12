/**
 * CSV export checks.
 *
 *   npm run check:csv
 *
 * toCsv() is the single place every Analysis export passes through, and the
 * failure it must not have is the silent one: a headline containing a comma
 * that shifts every column to its right by one, in one row, in one export, in
 * a file somebody has already sent to a client. That is not a crash and no
 * amount of "it downloaded fine" testing would catch it — so the quoting rules
 * are pinned here character by character.
 *
 * The formula-injection cases are here for the same reason. Headlines, media
 * names and keywords are third-party text that reaches the file unmodified,
 * and an exported CSV is exactly the artefact someone double-clicks open in
 * Excel without thinking about it.
 */
import { csvFilename, toCsv, type CsvColumn } from "../../src/lib/analysis/csv";

type Row = { a: unknown; b: unknown };

const COLS: CsvColumn<Row>[] = [
  { header: "a", value: (r) => r.a as string },
  { header: "b", value: (r) => r.b as string },
];

type Case = { name: string; rows: Row[]; expect: string };

const CRLF = "\r\n";

const CASES: Case[] = [
  {
    name: "plain values are unquoted",
    rows: [{ a: "hello", b: "world" }],
    expect: `a,b${CRLF}hello,world${CRLF}`,
  },
  {
    name: "a comma forces quoting — the column-shift bug",
    rows: [{ a: "Maersk, MSC cut capacity", b: 3 }],
    expect: `a,b${CRLF}"Maersk, MSC cut capacity",3${CRLF}`,
  },
  {
    name: "embedded quotes are doubled, not dropped",
    rows: [{ a: 'He said "no"', b: 1 }],
    expect: `a,b${CRLF}"He said ""no""",1${CRLF}`,
  },
  {
    name: "newlines stay inside one quoted field",
    rows: [{ a: "line one\nline two", b: 1 }],
    expect: `a,b${CRLF}"line one\nline two",1${CRLF}`,
  },
  {
    name: "carriage returns are quoted too",
    rows: [{ a: "a\r\nb", b: 1 }],
    expect: `a,b${CRLF}"a\r\nb",1${CRLF}`,
  },
  {
    name: "edge whitespace is preserved by quoting",
    rows: [{ a: "  padded  ", b: 1 }],
    expect: `a,b${CRLF}"  padded  ",1${CRLF}`,
  },
  {
    name: "null and undefined are empty cells, not the text 'null'",
    rows: [{ a: null, b: undefined }],
    expect: `a,b${CRLF},${CRLF}`,
  },
  {
    name: "zero is a zero, not an empty cell",
    rows: [{ a: 0, b: 0 }],
    expect: `a,b${CRLF}0,0${CRLF}`,
  },
  {
    name: "empty string stays empty",
    rows: [{ a: "", b: "x" }],
    expect: `a,b${CRLF},x${CRLF}`,
  },
  {
    name: "negative NUMBERS are untouched — the guard must not mangle them",
    rows: [{ a: -12.5, b: -3 }],
    expect: `a,b${CRLF}-12.5,-3${CRLF}`,
  },
  {
    name: "NaN/Infinity become empty rather than unparseable text",
    rows: [{ a: NaN, b: Infinity }],
    expect: `a,b${CRLF},${CRLF}`,
  },
  {
    name: "booleans render as true/false",
    rows: [{ a: true, b: false }],
    expect: `a,b${CRLF}true,false${CRLF}`,
  },
  {
    name: "header row alone when there are no rows",
    rows: [],
    expect: `a,b${CRLF}`,
  },

  // --- Formula injection ---------------------------------------------------
  {
    name: "a leading = is neutralised",
    rows: [{ a: "=1+1", b: 1 }],
    expect: `a,b${CRLF}"'=1+1",1${CRLF}`,
  },
  {
    name: "a leading + is neutralised",
    rows: [{ a: "+44 shipping update", b: 1 }],
    expect: `a,b${CRLF}"'+44 shipping update",1${CRLF}`,
  },
  {
    name: "a leading @ is neutralised",
    rows: [{ a: "@SUM(A1:A9)", b: 1 }],
    expect: `a,b${CRLF}"'@SUM(A1:A9)",1${CRLF}`,
  },
  {
    name: "a STRING starting with - is neutralised",
    rows: [{ a: "-5% on the Asia-Europe leg", b: 1 }],
    expect: `a,b${CRLF}"'-5% on the Asia-Europe leg",1${CRLF}`,
  },
  {
    name: "the classic DDE payload cannot execute",
    rows: [{ a: '=cmd|" /C calc"!A0', b: 1 }],
    expect: `a,b${CRLF}"'=cmd|"" /C calc""!A0",1${CRLF}`,
  },
  {
    name: "an = in the MIDDLE is left alone",
    rows: [{ a: "rates = up", b: 1 }],
    expect: `a,b${CRLF}rates = up,1${CRLF}`,
  },
];

function main() {
  let failures = 0;
  const show = (s: string) =>
    s.replace(/\r/g, "\\r").replace(/\n/g, "\\n");

  for (const c of CASES) {
    const got = toCsv(c.rows, COLS);
    const ok = got === c.expect;
    if (!ok) failures += 1;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${c.name}` +
        (ok ? "" : `\n        got      ${show(got)}\n        expected ${show(c.expect)}`)
    );
  }

  // Every data row must have exactly as many fields as the header. Parsed
  // properly (respecting quotes) rather than by splitting on commas, because
  // splitting on commas is the very bug this is checking for.
  const messy = toCsv(
    [
      { a: "a,b,c", b: 'quote " and, comma' },
      { a: "line\nbreak", b: "plain" },
    ],
    COLS
  );
  const fieldCounts = parseCsv(messy).map((r) => r.length);
  const shapeOk = fieldCounts.every((n) => n === 2) && fieldCounts.length === 3;
  if (!shapeOk) failures += 1;
  console.log(
    `${shapeOk ? "PASS" : "FAIL"}  round-trips to a 2-column table (rows: ${fieldCounts.join(",")})`
  );

  // ...and the values must survive the trip unchanged.
  const roundTripped = parseCsv(messy);
  const valuesOk =
    roundTripped[1][0] === "a,b,c" &&
    roundTripped[1][1] === 'quote " and, comma' &&
    roundTripped[2][0] === "line\nbreak";
  if (!valuesOk) failures += 1;
  console.log(
    `${valuesOk ? "PASS" : "FAIL"}  values survive the round trip unchanged`
  );

  const fname = csvFilename("keywords", "2026-W33");
  const fnameOk = fname === "keywords-2026-W33.csv";
  if (!fnameOk) failures += 1;
  console.log(`${fnameOk ? "PASS" : "FAIL"}  csvFilename → ${fname}`);

  const dirty = csvFilename("theme / sentiment", "Aug 10 – Aug 16, 2026");
  const dirtyOk = !/[/\\:*?"<>|]/.test(dirty) && dirty.endsWith(".csv");
  if (!dirtyOk) failures += 1;
  console.log(
    `${dirtyOk ? "PASS" : "FAIL"}  csvFilename strips path-hostile characters → ${dirty}`
  );

  const total = CASES.length + 4;
  console.log(`\n${total - failures}/${total} passed`);
  process.exit(failures === 0 ? 0 : 1);
}

/** A minimal RFC 4180 reader, so the check does not trust the writer's own rules. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 2;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

main();
