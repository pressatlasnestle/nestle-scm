/**
 * Static server for the visual harness (see scripts/checks/visual-harness.ts).
 *
 *   node scripts/harness-server.js     → http://localhost:4173
 *
 * Deliberately not part of the app: the harness must render the chart
 * components WITHOUT the Next.js middleware, auth or layout around them, so
 * that what is being looked at is the chart and nothing else. Serving it from
 * the app would put it behind the login redirect for no benefit.
 *
 * Localhost only, static only, no directory traversal.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", ".harness");
const PORT = Number(process.env.HARNESS_PORT || 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".pdf": "application/pdf",
};

http
  .createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    // Matched on the exact pathname, never a prefix. "/save-pdf" begins with
    // "/save", so a startsWith() check silently routed PDFs into the PNG
    // handler, which base64-decoded binary as if it were a data URL and wrote
    // a 11KB fragment of a 385KB file. It looked like a working download.
    const route = url.pathname;

    const saveName = (fallback) =>
      (url.searchParams.get("name") || fallback).replace(/[^a-zA-Z0-9._-]/g, "-");

    // POST /save?name=x.png — the page rasterises its own SVG to a data URL and
    // posts it here, so the rendered result lands on disk as an image that can
    // be opened and looked at. Needed because this environment cannot take
    // browser screenshots, and "does it render legibly" is not a question the
    // DOM can be asked directly.
    if (req.method === "POST" && route === "/save") {
      const name = saveName("shot.png");
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const b64 = body.replace(/^data:image\/png;base64,/, "");
        fs.writeFileSync(path.join(ROOT, name), Buffer.from(b64, "base64"));
        res.writeHead(200).end(name);
      });
      return;
    }

    // POST /save-pdf?name=x.pdf — raw binary body, written straight through.
    // Buffers are collected and concatenated rather than string-appended:
    // coercing binary chunks to a string corrupts every byte above 0x7f.
    if (req.method === "POST" && route === "/save-pdf") {
      const name = saveName("out.pdf");
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        fs.writeFileSync(path.join(ROOT, name), Buffer.concat(chunks));
        res.writeHead(200).end(name);
      });
      return;
    }

    const rel = decodeURIComponent(route);
    const file = path.join(ROOT, rel === "/" ? "index.html" : rel);

    // Never serve outside .harness, whatever the request says.
    if (!path.resolve(file).startsWith(path.resolve(ROOT))) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(buf);
    });
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`harness on http://localhost:${PORT}`);
  });
