// Routes every same-origin request outside /_shell/ to Drupal: the shell page
// (/_shell/index.html, answered for every top-level page load) owns the VM and
// answers over a MessageChannel.
// "/" at a domain root, "/<repo>/" on GitHub Pages project sites.
const BASE = new URL(self.registration.scope).pathname;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith(BASE + "_shell/") || url.pathname === BASE + "sw.js") return;
  if (req.mode === "navigate" && req.destination === "document" && req.method === "GET") {
    e.respondWith(fetch(new URL(BASE + "_shell/index.html", location.origin)));
    return;
  }
  e.respondWith(toDrupal(req, url));
});

// The tab that owns the VM: remembered by id, else found by asking every top-level tab.
let ownerId;
async function shellClient() {
  const known = ownerId && (await self.clients.get(ownerId));
  if (known) return known;
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const probes = all.filter((c) => c.frameType === "top-level").map((c) => new Promise((ok) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = (m) => ok(m.data ? c : null);
    setTimeout(() => ok(null), 1000);
    c.postMessage({ type: "drupal-owner?" }, [port2]);
  }));
  const found = await new Promise((ok) => {
    let left = probes.length;
    if (!left) ok(null);
    for (const p of probes) p.then((c) => (c ? ok(c) : --left || ok(null)));
  });
  ownerId = found?.id;
  return found ?? undefined;
}

async function toDrupal(req, url) {
  const shell = await shellClient();
  if (!shell) return new Response("Drupal VM not running", { status: 503 });
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
