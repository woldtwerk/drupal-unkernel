// Run Drush inside the unkernel guest against db/drupal.sqlite, then save the DB back.
//   pnpm drush pm:uninstall eca -y
import { resolve } from "node:path";
import { createKernel, nodeFs } from "unkernel";

const args = process.argv.slice(2);
if (!args.length) throw new Error("usage: pnpm drush <command> [args]");

const DB = "/var/lib/drupal/drupal.sqlite"; // the path settings.php was installed with
const php = ["/opt/php/php", "-c", "/opt/php/php.ini", "-d", "memory_limit=1G"];

const vm = await createKernel({
  memoryMiB: 1024,
  mounts: {
    "/opt/php": { fs: nodeFs(resolve("php-aarch64")), readOnly: true },
    "/app": nodeFs(resolve("drupal")),
    "/db": nodeFs(resolve("db")),
  },
});
const sh = async (script) => {
  const r = await vm.exec("sh", ["-c", script]);
  if (r.exitCode !== 0) throw new Error(`guest: ${script}\n${r.stdout}${r.stderr}`);
};

// SQLite can't live on 9p (no locks): work on a guest-local copy.
await sh(`test -f /db/drupal.sqlite && mkdir -p /var/lib/drupal && cp /db/drupal.sqlite ${DB}`);

const drush = await vm.spawn(php[0], [...php.slice(1), "/app/vendor/drush/drush/drush.php", ...args],
  { pty: false, cwd: "/app/web" });
await Promise.all([
  drush.stdout.pipeTo(new WritableStream({ write: (b) => process.stdout.write(b) })),
  drush.stderr.pipeTo(new WritableStream({ write: (b) => process.stderr.write(b) })),
]);
const ended = await drush.ended;
const code = ended.code ?? 1;

if (code === 0) {
  // WAL mode: checkpoint into the main file, then temp file + rename (in-place cp fails over 9p).
  const r = await vm.exec(php[0], [...php.slice(1), "-r", `(new PDO("sqlite:${DB}"))->exec("PRAGMA wal_checkpoint(TRUNCATE)");`]);
  if (r.exitCode !== 0) throw new Error(`checkpoint failed: ${r.stderr}`);
  await sh(`rm -f /db/drupal.sqlite.tmp && cp ${DB} /db/drupal.sqlite.tmp && mv -f /db/drupal.sqlite.tmp /db/drupal.sqlite`);
  console.error("[drush] database saved to db/drupal.sqlite");
} else {
  console.error(`[drush] exited ${code}; db/drupal.sqlite left unchanged`);
}
vm.write("poweroff\n");
await vm.exited;
process.exit(code);
