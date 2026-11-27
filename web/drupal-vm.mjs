// Shared by the browser page and the Node image test: guest setup for the
// drupal.ext4 image, and a minimal HTTP/1.0 client over vm.connect().
// (vm.fetch can't carry Cookie / Set-Cookie in browsers: forbidden headers.)

export const GUEST_PORT = 8000;
const PHP = ["/opt/php/php", "-c", "/opt/php/php.ini"];

async function sh(vm, script) {
  const r = await vm.exec("sh", ["-c", script]);
  if (r.exitCode !== 0) throw new Error(`guest: ${script}\n${r.stdout}${r.stderr}`);
  return r.stdout;
}

/** Mount the image's trees at the paths the site was installed with, start php -S, wait for it. */
export async function startDrupal(vm, log = () => {}) {
  // The image (label kwdata) is mounted at /data by unkernel's init.
  await sh(vm, [
    "mountpoint -q /data || { echo 'drupal image not mounted at /data' >&2; exit 1; }",
    "mkdir -p /app /opt/php /var/lib",
    "mountpoint -q /app || mount --bind /data/app /app",
    "mountpoint -q /opt/php || mount --bind /data/php /opt/php",
    "ln -sfn /data/db /var/lib/drupal",
  ].join(" && "));
  log((await vm.exec(PHP[0], [...PHP.slice(1), "-v"])).stdout.split("\n")[0]);

  // -d: the CLI SAPI forces output_buffering=0 over php.ini; Drupal wants it on.
  const server = await vm.spawn(PHP[0], [...PHP.slice(1), "-d", "output_buffering=4096", "-S", `0.0.0.0:${GUEST_PORT}`,
    "-t", "/app/web", "/app/web/.ht.router.php"], { pty: false, cwd: "/app/web" });
  const dec = new TextDecoder();
  server.stdout.pipeTo(new WritableStream({ write: (b) => log(dec.decode(b).trimEnd()) })).catch(() => {});
  server.stderr.pipeTo(new WritableStream({ write: (b) => log(dec.decode(b).trimEnd()) })).catch(() => {});

  for (;;) {
    try {
      await (await vm.connect(GUEST_PORT)).close();
      return server;
    } catch {
      await new Promise((ok) => setTimeout(ok, 200));
    }
  }
}

const enc = new TextEncoder();

/**
 * One HTTP/1.0 request to php -S in the guest (HTTP/1.0: no chunking, server closes when done).
 * headers: [[name, value], ...]; body: Uint8Array | null.
 * Returns { status, statusText, headers: [[name, value], ...], body: Uint8Array }.
 */
export async function guestHttp(vm, { method, path, headers, body }) {
  const conn = await vm.connect(GUEST_PORT);
  let head = `${method} ${path} HTTP/1.0\r\n`;
  for (const [k, v] of headers) head += `${k}: ${String(v).replace(/[\r\n]/g, " ")}\r\n`;
  if (body?.length || !["GET", "HEAD"].includes(method)) head += `Content-Length: ${body?.length ?? 0}\r\n`;
  head += "\r\n";

  const writer = conn.writable.getWriter();
  await writer.write(enc.encode(head));
  if (body?.length) await writer.write(body);
  await writer.close();
  const raw = new Uint8Array(await new Response(conn.readable).arrayBuffer());

  let end = -1;
  for (let i = 0; i + 3 < raw.length; i++) {
    if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) { end = i; break; }
  }
  if (end < 0) throw new Error(`malformed response from guest (${raw.length} bytes)`);
  const [statusLine, ...lines] = new TextDecoder().decode(raw.subarray(0, end)).split("\r\n");
  const m = /^HTTP\/1\.\d (\d{3}) ?(.*)$/.exec(statusLine);
  if (!m) throw new Error(`bad status line from guest: ${statusLine}`);
  const respHeaders = lines.map((l) => {
    const i = l.indexOf(":");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  });
  return { status: Number(m[1]), statusText: m[2], headers: respHeaders, body: raw.subarray(end + 4) };
}
