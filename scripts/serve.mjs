// Local preview server for dist/ on 127.0.0.1 (default port 4417; never 8095/8096, which belong to the Drawbridge stack).
// Sends the same security headers as production and answers the demo form's placeholder endpoint
// with 202 without storing anything.
import { createServer } from "node:http";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const PORT = Number(process.env.PORT || 4417);
if (PORT === 8095 || PORT === 8096) throw new Error("Ports 8095/8096 belong to the Drawbridge stack. Pick another.");
const HOST = "127.0.0.1";
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json", ".json": "application/json",
};
// Re-read on every request so a rebuild (new stylesheet hash) never needs a server restart.
const csp = () => (existsSync(join(ROOT, "csp.txt")) ? readFileSync(join(ROOT, "csp.txt"), "utf8").trim().replace("; upgrade-insecure-requests", "") : "");
const baseHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === "/api/demo-request") {
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); return res.end(); }
    // Placeholder: read and discard the body; nothing is logged or stored.
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(202, { "Content-Type": "application/json", "Content-Security-Policy": csp(), ...baseHeaders });
      res.end(JSON.stringify({ ok: true, placeholder: true }));
    });
    return;
  }
  let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  let file = join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(400); return res.end(); }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  let status = 200;
  if (!existsSync(file)) {
    if (!url.pathname.endsWith("/") && existsSync(join(ROOT, p, "index.html"))) {
      res.writeHead(301, { Location: url.pathname + "/" }); return res.end();
    }
    file = join(ROOT, "404.html"); status = 404;
  }
  const type = TYPES[extname(file)] || "application/octet-stream";
  const cache = url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  let body = readFileSync(file);
  const headers = { "Content-Type": type, "Cache-Control": cache, Vary: "Accept-Encoding", "Content-Security-Policy": csp(), ...baseHeaders };
  const ae = String(req.headers["accept-encoding"] || "");
  if (/^(text|application\/(xml|json|manifest)|image\/svg)/.test(type) && body.length > 512) {
    if (/\bbr\b/.test(ae)) { body = brotliCompressSync(body); headers["Content-Encoding"] = "br"; }
    else if (/\bgzip\b/.test(ae)) { body = gzipSync(body); headers["Content-Encoding"] = "gzip"; }
  }
  res.writeHead(status, headers);
  res.end(body);
}).listen(PORT, HOST, () => console.log(`Drawbridge site: http://${HOST}:${PORT}/`));
