// Shell page: boots unkernel in this tab, mounts drupal.ext4 (lazy HTTP Range reads,
// copy-on-write overlay persisted in IndexedDB), runs php -S in the guest and
// answers the service worker's requests for Drupal URLs.
import { checkSupport, createKernel, resetHttpDisk } from "./unkernel/web.mjs";
import { guestHttp, startDrupal } from "./drupal-vm.mjs";

// The shell is served at whatever path the visitor opened; the iframe starts there.
const START = location.pathname + location.search + location.hash;
// "" at a domain root, "/<repo>" on GitHub Pages project sites.
const BASE = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const IMAGE = new URL("drupal.ext4", import.meta.url).href;
const DISK_NAME = "drupal-poc";
const JAR_KEY = "drupal-poc-cookies";
// Static assets Drupal serves are cached here and answered by sw.js without the guest.
// One cache per image version (its ETag), so a rebuilt image never serves stale files.
const ASSET_CACHE_PREFIX = "drupal-assets-";
const STATIC_ASSET = /\.(css|js|mjs|woff2?|ttf|otf|svg|png|jpe?g|gif|webp|avif|ico)$/i;
let assetCache; // Promise<Cache | null>
const LOG_LINES = 500;

const $ = (id) => document.getElementById(id);
const status = (text, state = "busy") => {
  $("status").textContent = text;
  $("status").dataset.state = state;
};
// Boot overlay: pct 0–100, text also goes to the header status.
const bootStart = performance.now();
const bootClock = setInterval(() => {
  $("boot-time").textContent = `${Math.round((performance.now() - bootStart) / 1000)} s`;
}, 250);
const step = (pct, text, detail = "") => {
  if (text) status(text);
  $("boot-step").textContent = text ?? $("boot-step").textContent;
  $("boot-detail").textContent = detail;
  $("boot-fill").style.width = `${pct}%`;
  $("boot-fill").parentElement.setAttribute("aria-valuenow", Math.round(pct));
};
const MB = (n) => (n / 2 ** 20).toFixed(1);
const log = (line) => {
  if (!line) return;
  const el = $("log");
  // Capped: a growing text node is re-laid out on every request.
  const lines = (el.textContent + line + "\n").split("\n");
  el.textContent = lines.slice(-LOG_LINES - 1).join("\n");
  el.scrollTop = el.scrollHeight;
};

// --- cookies: the service worker can't see Cookie or emit Set-Cookie, so the jar lives here.
const jar = new Map(loadJar());
function loadJar() {
  try {
    return JSON.parse(localStorage.getItem(JAR_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function saveJar() {
  try {
    localStorage.setItem(JAR_KEY, JSON.stringify([...jar]));
  } catch {}
}
function storeCookie(setCookie) {
  const [pair, ...attrs] = setCookie.split(";");
  const eq = pair.indexOf("=");
  if (eq < 1) return;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  const expired = attrs.some((a) => {
    const [k, v = ""] = a.trim().split("=");
    return (/^max-age$/i.test(k) && Number(v) <= 0) || (/^expires$/i.test(k) && Date.parse(v) < Date.now());
  });
  if (expired || value === "deleted") jar.delete(name);
  else jar.set(name, value);
  saveJar();
}

async function openAssetCache() {
  try {
    const head = await fetch(IMAGE, { method: "HEAD", cache: "no-store" });
    const name = ASSET_CACHE_PREFIX + (head.headers.get("etag") ?? "").replace(/\W/g, "");
    for (const key of await caches.keys()) if (key.startsWith(ASSET_CACHE_PREFIX) && key !== name) await caches.delete(key);
    return await caches.open(name);
  } catch (err) {
    log(`asset cache off: ${err.message}`);
    return null;
  }
}
async function clearAssetCaches() {
  for (const key of await caches.keys()) if (key.startsWith(ASSET_CACHE_PREFIX)) await caches.delete(key);
}
function cacheAsset(method, path, r) {
  if (method !== "GET" || r.status !== 200 || !STATIC_ASSET.test(path.split("?")[0]) || path.startsWith(BASE + "/system/files/")) return;
  if (r.headers.some(([k, v]) => /^set-cookie$/i.test(k) || (/^cache-control$/i.test(k) && /no-store|private/i.test(v)))) return;
  const res = new Response(r.body.slice(), { status: 200, headers: r.headers.filter(([k]) => !DROP_RESPONSE.test(k)) });
  assetCache?.then((c) => c?.put(new Request(location.origin + path), res)).catch(() => {});
}

// --- VM
let vm;
let markReady;
const ready = new Promise((ok) => (markReady = ok));
let syncTimer;
let inflight = 0; // Drupal requests from the service worker not answered yet
const scheduleSync = () => {
  clearTimeout(syncTimer);
  // Only while no request runs: GETs write too (caches), and a save cut short by a reload
  // leaves a torn SQLite file in the overlay ("database disk image is malformed").
  syncTimer = setTimeout(() => (inflight ? scheduleSync() : vm.sync().catch((e) => log(`sync: ${e.message}`))), 1000);
};

const DROP_REQUEST = /^(host|cookie|connection|content-length|accept-encoding|keep-alive|transfer-encoding)$/i;
const DROP_RESPONSE = /^(set-cookie|connection|transfer-encoding|keep-alive)$/i;

// One tab owns the VM (and the IndexedDB overlay); sw.js asks which one before routing to it.
let owner = false;
navigator.serviceWorker.addEventListener("message", async (e) => {
  if (e.data?.type === "drupal-owner?") return e.ports[0].postMessage(owner);
  if (e.data?.type !== "drupal-http") return;
  const port = e.ports[0];
  const { method, path, headers, body } = e.data;
  const t0 = performance.now();
  inflight++;
  try {
    await ready;
    const h = headers.filter(([k]) => !DROP_REQUEST.test(k));
    h.push(["Host", location.host]);
    if (jar.size) h.push(["Cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; ")]);
    const r = await guestHttp(vm, { method, path, headers: h, body });
    for (const [k, v] of r.headers) if (/^set-cookie$/i.test(k)) storeCookie(v);
    cacheAsset(method, path, r);
    const out = r.body.slice().buffer;
    port.postMessage({
      status: r.status,
      statusText: r.statusText,
      headers: r.headers.filter(([k]) => !DROP_RESPONSE.test(k)),
      body: out,
    }, [out]);
    log(`${method} ${path} → ${r.status} (${Math.round(performance.now() - t0)} ms)`);
    scheduleSync();
  } catch (err) {
    log(`${method} ${path} failed: ${err.message}`);
    port.postMessage({ status: 502, statusText: "Bad Gateway", headers: [["content-type", "text/plain"]], body: `guest: ${err.message}` });
  } finally {
    inflight--;
  }
});
navigator.serviceWorker.startMessages();

$("reset").addEventListener("click", async () => {
  if (!confirm("Discard all changes to the site (content, users, config) and start from the image?")) return;
  status("Resetting…");
  await vm?.stop().catch(() => {});
  await resetHttpDisk(DISK_NAME);
  await clearAssetCaches().catch(() => {});
  jar.clear();
  saveJar();
  location.reload();
});
$("go").addEventListener("submit", (e) => {
  e.preventDefault();
  const p = $("path").value || "/";
  $("site").src = p.startsWith(BASE + "/") ? p : BASE + p;
});
$("site").addEventListener("load", () => {
  try {
    const l = $("site").contentWindow.location;
    if (l.href === "about:blank") return;
    // Theme templates (Mercury's logo) hardcode href="/", which would leave the service worker's scope.
    if (BASE) {
      const doc = $("site").contentDocument;
      const fix = (a) => a.setAttribute("href", BASE + "/");
      doc.querySelectorAll('a[href="/"]').forEach(fix);
      doc.addEventListener("click", (e) => {
        const a = e.target.closest?.('a[href="/"]');
        if (a) fix(a);
      }, true);
    }
    $("path").value = l.pathname + l.search;
    history.replaceState(null, "", l.pathname + l.search + l.hash);
  } catch {}
});
$("toggle-log").addEventListener("click", () => document.body.classList.toggle("show-log"));

async function boot() {
  const support = await checkSupport();
  if (!support.ok) throw new Error(`This browser can't run unkernel:\n${support.problems.join("\n")}`);

  step(2, "Registering service worker…");
  await navigator.serviceWorker.register(BASE + "/sw.js", { scope: BASE + "/" });
  await navigator.serviceWorker.ready;

  const t0 = performance.now();
  assetCache = openAssetCache();
  step(10, "Loading Linux…");
  // In a Web Worker: on this thread the CPU emulation would compete with the site's rendering
  // and with answering the service worker. The overlay is the same IndexedDB store as before.
  vm = await createKernel({
    worker: true,
    disks: [{ kind: "http", url: IMAGE, persist: DISK_NAME }],
    memoryMiB: 1024,
    memoryFallbackMiB: [768, 512],
    onProgress: (p) => {
      if (p.stage === "download") {
        if (p.total) step(10 + 30 * (p.loaded / p.total), "Downloading Linux…", `${MB(p.loaded)} / ${MB(p.total)} MB`);
        return;
      }
      log(`[boot] ${p.stage}`);
      const stages = { compile: [42, "Compiling Linux…"], memory: [50, "Booting Linux…"], instantiate: [52], start: [55] };
      if (stages[p.stage]) step(...stages[p.stage]);
    },
  });
  log(`[boot] kernel up in ${Math.round(performance.now() - t0)} ms`);
  vm.exited.then(({ code, reason }) => status(`Linux exited (${reason ?? code})`, "error"));

  step(60, "Starting PHP…");
  await startDrupal(vm, log, BASE);
  log(`[boot] php -S ready after ${Math.round(performance.now() - t0)} ms`);
  markReady();

  // The first page has no measurable progress (cold PHP and Drupal caches, a minute or more):
  // creep from 75 % towards 98 % until its HTML is parsed. Not the iframe's load event: that
  // also waits for images, and every cold image style derivative takes many seconds.
  const t1 = performance.now();
  const detail = () => (inflight ? `${inflight} request${inflight > 1 ? "s" : ""} in flight` : "");
  step(75, "Loading the first page (cold caches, can take a minute or more)…", detail());
  $("site").src = START;
  const creep = setInterval(() => {
    const doc = $("site").contentDocument;
    if (doc && doc.URL !== "about:blank" && doc.readyState !== "loading") {
      clearInterval(creep);
      clearInterval(bootClock);
      step(100, "Running");
      status("Running", "ok");
      $("boot").classList.add("done");
      return;
    }
    step(75 + 23 * (1 - Math.exp(-(performance.now() - t1) / 30000)), null, detail());
  }, 250);
  addEventListener("pagehide", () => inflight || vm.sync());
}

// Hold the lock for the page's lifetime once booted; a failed boot releases it for another tab.
step(0, "Drupal is running in another tab: close it, or use that tab");
navigator.locks.request("drupal-vm", async () => {
  owner = true;
  step(0, "Loading…");
  await boot();
  await new Promise(() => {});
}).catch((err) => {
  owner = false;
  console.error(err);
  status(err.message, "error");
  clearInterval(bootClock);
  $("boot").classList.add("error");
  $("boot-step").textContent = err.message;
  log(err.stack ?? String(err));
  document.body.classList.add("show-log");
});
