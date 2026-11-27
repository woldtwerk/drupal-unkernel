// Shell page: boots unkernel in this tab, mounts drupal.ext4 (lazy HTTP Range reads,
// copy-on-write overlay persisted in IndexedDB), runs php -S in the guest and
// answers the service worker's requests for Drupal URLs.
import { checkSupport, createKernel, openHttpDisk, resetHttpDisk } from "./unkernel/web.mjs";
import { guestHttp, startDrupal } from "./drupal-vm.mjs";

const IMAGE = new URL("drupal.ext4", import.meta.url).href;
const DISK_NAME = "drupal-poc";
const JAR_KEY = "drupal-poc-cookies";

const $ = (id) => document.getElementById(id);
const status = (text, state = "busy") => {
  $("status").textContent = text;
  $("status").dataset.state = state;
};
const log = (line) => {
  if (!line) return;
  const el = $("log");
  el.textContent += line + "\n";
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

// --- VM
let vm;
let markReady;
const ready = new Promise((ok) => (markReady = ok));
let syncTimer;
const scheduleSync = () => {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => vm.sync().catch((e) => log(`sync: ${e.message}`)), 1000);
};

const DROP_REQUEST = /^(host|cookie|connection|content-length|accept-encoding|keep-alive|transfer-encoding)$/i;
const DROP_RESPONSE = /^(set-cookie|connection|transfer-encoding|keep-alive)$/i;

navigator.serviceWorker.addEventListener("message", async (e) => {
  if (e.data?.type !== "drupal-http") return;
  const port = e.ports[0];
  const { method, path, headers, body } = e.data;
  const t0 = performance.now();
  try {
    await ready;
    const h = headers.filter(([k]) => !DROP_REQUEST.test(k));
    h.push(["Host", location.host]);
    if (jar.size) h.push(["Cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; ")]);
    const r = await guestHttp(vm, { method, path, headers: h, body });
    for (const [k, v] of r.headers) if (/^set-cookie$/i.test(k)) storeCookie(v);
    const out = r.body.slice().buffer;
    port.postMessage({
      status: r.status,
      statusText: r.statusText,
      headers: r.headers.filter(([k]) => !DROP_RESPONSE.test(k)),
      body: out,
    }, [out]);
    log(`${method} ${path} → ${r.status} (${Math.round(performance.now() - t0)} ms)`);
    if (!["GET", "HEAD"].includes(method)) scheduleSync();
  } catch (err) {
    log(`${method} ${path} failed: ${err.message}`);
    port.postMessage({ status: 502, statusText: "Bad Gateway", headers: [["content-type", "text/plain"]], body: `guest: ${err.message}` });
  }
});
navigator.serviceWorker.startMessages();

$("reset").addEventListener("click", async () => {
  if (!confirm("Discard all changes to the site (content, users, config) and start from the image?")) return;
  status("Resetting…");
  await vm?.stop().catch(() => {});
  await resetHttpDisk(DISK_NAME);
  jar.clear();
  saveJar();
  location.reload();
});
$("go").addEventListener("submit", (e) => {
  e.preventDefault();
  $("site").src = $("path").value || "/";
});
$("site").addEventListener("load", () => {
  try {
    const l = $("site").contentWindow.location;
    $("path").value = l.pathname + l.search;
  } catch {}
});
$("toggle-log").addEventListener("click", () => document.body.classList.toggle("show-log"));

async function boot() {
  const support = await checkSupport();
  if (!support.ok) throw new Error(`This browser can't run unkernel:\n${support.problems.join("\n")}`);

  status("Registering service worker…");
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;

  const t0 = performance.now();
  status("Opening disk image…");
  const disk = await openHttpDisk(IMAGE, { name: DISK_NAME });
  status("Booting Linux…");
  vm = await createKernel({
    disks: [disk],
    memoryMiB: 1024,
    memoryFallbackMiB: [768, 512],
    onProgress: (p) => log(`[boot] ${p.stage}`),
  });
  log(`[boot] kernel up in ${Math.round(performance.now() - t0)} ms`);
  vm.exited.then(({ code, reason }) => status(`Linux exited (${reason ?? code})`, "error"));

  status("Starting PHP…");
  await startDrupal(vm, log);
  log(`[boot] php -S ready after ${Math.round(performance.now() - t0)} ms`);
  markReady();

  status("Running", "ok");
  $("site").src = "/";
  addEventListener("pagehide", () => vm.sync());
}

boot().catch((err) => {
  console.error(err);
  status(err.message, "error");
  log(err.stack ?? String(err));
  document.body.classList.add("show-log");
});
