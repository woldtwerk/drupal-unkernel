// Drupal on unkernel PoC: boots the unkernel base shell (Linux in wasm), mounts a
// static aarch64 PHP and the Drupal codebase over 9p, runs PHP's built-in web
// server inside the guest and forwards http://127.0.0.1:$PORT to it.
//
//   node run.mjs            serve db/drupal.sqlite (install it with ./install-site.sh)
//   node run.mjs --warm     fill the site's caches, save the DB and exit (install-site.sh's last step)
//   BASE_PATH=/x            serve (and warm) the site under a subpath, e.g. GitHub Pages /<repo>; WARM_HOST: Host for --warm
import { createServer } from "node:net";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { checkSupport, createKernel, nodeFs } from "unkernel";
import { guestHttp, phpServer } from "./web/drupal-vm.mjs";

const HOST_PORT = Number(process.env.PORT ?? 8888);
const GUEST_PORT = 8000;
const BASE_PATH = process.env.BASE_PATH ?? "";
const PHP_DIR = resolve(process.env.PHP_DIR ?? "php-aarch64");
const DRUPAL_DIR = resolve("drupal");
const DB_DIR = resolve("db");
mkdirSync(DB_DIR, { recursive: true });

if (!existsSync(`${PHP_DIR}/php`)) throw new Error(`no static aarch64 php in ${PHP_DIR}`);
const support = await checkSupport();
if (!support.ok) throw new Error(`unkernel unsupported here (use Node 24+):\n${support.problems.join("\n")}`);

const t0 = Date.now();
const vm = await createKernel({
  memoryMiB: Number(process.env.MEM ?? 1024),
  mounts: {
    "/opt/php": { fs: nodeFs(PHP_DIR), readOnly: true },
    "/app": nodeFs(DRUPAL_DIR),
    "/db": nodeFs(DB_DIR),
  },
});
console.log(`[poc] kernel booted in ${Date.now() - t0} ms`);

const php = ["/opt/php/php", "-c", "/opt/php/php.ini"];
const run = async (args, opts = {}) => {
  const r = await vm.exec(args[0], args.slice(1), { cwd: "/app", ...opts });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  if (r.exitCode !== 0) throw new Error(`${args.join(" ")} exited ${r.exitCode}`);
  return r;
};

await run([...php, "-v"]);

// SQLite needs POSIX locks, which the 9p mount lacks ("disk I/O error"), so the
// DB lives on the guest's own filesystem and is copied from/to the host's db/.
const DB = "/var/lib/drupal/drupal.sqlite";
// Drupal runs SQLite in WAL mode: checkpoint the WAL into the main file first, or
// recent commits stay behind in drupal.sqlite-wal. Then write a temp file and
// rename: overwriting in place over 9p fails in busybox cp.
const saveDb = async () => {
  await run([...php, "-r", `(new PDO("sqlite:${DB}"))->exec("PRAGMA wal_checkpoint(TRUNCATE)");`]);
  await run(["sh", "-c",
    `rm -f /db/drupal.sqlite.tmp && cp ${DB} /db/drupal.sqlite.tmp && mv -f /db/drupal.sqlite.tmp /db/drupal.sqlite`]);
};
await run(["mkdir", "-p", "/var/lib/drupal"]);
if ((await vm.exec("test", ["-f", "/db/drupal.sqlite"])).exitCode === 0) {
  await run(["cp", "/db/drupal.sqlite", DB]);
}

// php -S runs until the VM stops; wait until it listens before accepting host connections.
const server = await phpServer(vm, { base: BASE_PATH, log: (l) => l && console.log(l) });

// --warm (install-site.sh): fill Drupal's caches and the compiled Twig templates in the guest
// (same /app paths as the image), save and exit. The cold front page takes ~3 min otherwise.
// Not the image style derivatives: 16 widths per image at 10–20 s each.
if (process.argv.includes("--warm")) {
  const get = async (path) => {
    const t = Date.now();
    // Host: what the browser page sends (WARM_HOST = the deploy host), so the front page is also in Drupal's page cache
    const r = await guestHttp(vm, { method: "GET", path, headers: [["Host", process.env.WARM_HOST ?? "127.0.0.1:8787"]], body: null });
    console.log(`[poc] warm ${path} → ${r.status} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
    if (r.status >= 500) throw new Error(`warming ${path} failed with ${r.status}`);
  };
  await get(`${BASE_PATH}/`);
  await get(`${BASE_PATH}/user/login`);
  await saveDb();
  await vm.sync().catch(() => {});
  process.exit(0);
}

// Host TCP -> guest TCP (same approach as unkernel's CLI --forward).
async function forward(sock) {
  sock.on("error", () => {});
  let gs;
  try {
    gs = await vm.connect(GUEST_PORT);
  } catch (e) {
    console.error(`[poc] connect to guest: ${e.message}`);
    sock.resetAndDestroy();
    return;
  }
  const writer = gs.writable.getWriter();
  const reader = gs.readable.getReader();
  sock.on("close", (hadError) => (hadError ? writer.abort() : gs.close()).catch(() => {}));
  sock.on("data", (chunk) => {
    sock.pause();
    writer.write(new Uint8Array(chunk)).then(() => sock.resume(), () => sock.destroy());
  });
  sock.on("end", () => void writer.close().catch(() => {}));
  sock.resume();
  try {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      if (!sock.write(r.value)) await new Promise((ok) => sock.once("drain", ok).once("close", ok));
    }
    sock.end();
  } catch {
    sock.resetAndDestroy();
  }
}

createServer({ allowHalfOpen: true, pauseOnConnect: true }, forward)
  .listen(HOST_PORT, "127.0.0.1", () => console.log(`[poc] Drupal: http://127.0.0.1:${HOST_PORT}/  (Ctrl-C to stop)`));

process.once("SIGINT", async () => {
  process.on("SIGINT", () => {}); // the package manager forwards Ctrl-C too: save only once
  await saveDb().then(() => console.log("[poc] database saved to db/drupal.sqlite"), (e) => console.error(e.message));
  await vm.sync().catch(() => {});
  vm.write("poweroff\n");
  setTimeout(() => process.exit(0), 3000).unref();
  await vm.exited;
  process.exit(0);
});
