// Routes every same-origin request outside /_poc/ to Drupal: the shell page
// (/_poc/) owns the VM and answers over a MessageChannel.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith("/_poc/") || url.pathname === "/sw.js") return;
  e.respondWith(toDrupal(e.request, url));
});

async function shellClient() {
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return all.find((c) => new URL(c.url).pathname.startsWith("/_poc/"));
}

async function toDrupal(req, url) {
  const shell = await shellClient();
  if (!shell) {
    // No VM running anywhere: open the shell page instead.
    return req.mode === "navigate"
      ? Response.redirect(new URL("/_poc/", location.origin), 302)
      : new Response("Drupal VM not running: open /_poc/", { status: 503 });
  }
  // Static assets the shell page cached earlier (see cacheAsset in app.mjs)
  if (req.method === "GET") {
    const hit = await caches.match(url.href);
    if (hit) return hit;
  }
  const body = ["GET", "HEAD"].includes(req.method) ? null : new Uint8Array(await req.arrayBuffer());
  const { port1, port2 } = new MessageChannel();
  const reply = new Promise((ok) => (port1.onmessage = (m) => ok(m.data)));
  shell.postMessage({
    type: "drupal-http",
    method: req.method,
    path: url.pathname + url.search,
    headers: [...req.headers],
    body,
  }, [port2]);
  const r = await reply;
  const noBody = req.method === "HEAD" || [101, 103, 204, 205, 304].includes(r.status);
  return new Response(noBody ? null : r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
}
