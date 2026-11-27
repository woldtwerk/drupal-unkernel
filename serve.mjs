// Static server for the browser PoC. Range requests are required: unkernel reads
// drupal.ext4 lazily with HTTP Range (206 + Content-Range + ETag).
//   /sw.js            the service worker (scope "/": every Drupal URL)
//   /_shell/unkernel/*  node_modules/unkernel/dist/*
//   /_shell/*           web/*
//   anything else       the shell page (200, like Pages' 404.html: a first visit before the service worker)
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

const PORT = Number(process.env.PORT ?? 8787);
const WEB = resolve("web");
const UNKERNEL = resolve("node_modules/unkernel/dist");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
};

function resolveFile(pathname) {
  if (pathname === "/sw.js") return resolve(WEB, "sw.js");
  if (pathname.startsWith("/_shell/unkernel/")) return inside(UNKERNEL, pathname.slice("/_shell/unkernel/".length));
  if (pathname.startsWith("/_shell/")) return inside(WEB, pathname.slice("/_shell/".length) || "index.html");
  return resolve(WEB, "index.html");
}
function inside(base, rel) {
  const file = resolve(base, decodeURIComponent(rel));
  return file.startsWith(base + sep) ? file : undefined;
}

createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  const file = resolveFile(pathname);
  let st;
  try {
    st = file && statSync(file);
  } catch {}
  if (!st?.isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  const headers = {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "ETag": `"${st.size}-${Math.trunc(st.mtimeMs)}"`,
    "Last-Modified": st.mtime.toUTCString(),
    "Cache-Control": "no-cache",
  };
  if (pathname === "/sw.js") headers["Service-Worker-Allowed"] = "/";

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  let start = 0;
  let end = st.size - 1;
  if (range) {
    start = range[1] === "" ? Math.max(0, st.size - Number(range[2])) : Number(range[1]);
    end = range[1] !== "" && range[2] !== "" ? Math.min(Number(range[2]), st.size - 1) : end;
    if (start > end || start >= st.size) {
      res.writeHead(416, { "Content-Range": `bytes */${st.size}` }).end();
      return;
    }
    headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
  }
  headers["Content-Length"] = end - start + 1;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD") res.end();
  else createReadStream(file, { start, end }).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log(`Drupal on unkernel (browser): http://127.0.0.1:${PORT}/`));
