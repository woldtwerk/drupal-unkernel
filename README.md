# Drupal CMS on unkernel (PoC)

Drupal CMS 2 (Drupal 11.4, **Mercury Demo** site template) running inside
[unkernel](https://github.com/pithings/unkernel), a Linux kernel compiled to WebAssembly, **in the browser** or
under Node. PHP 8.5 is a fully static aarch64 binary built with
[static-php-cli](https://github.com/crazywhalecc/static-php-cli): unkernel's CPU emulator (kwemu) runs aarch64
user programs, whatever the host CPU.

## Browser

```
tab: /_poc/ (shell page)                                         service worker (scope /)
├─ unkernel.wasm (Linux 7.3, base shell, 1 CPU)                    every same-origin URL outside /_poc/
│  ├─ /dev/wda = drupal.ext4, label kwdata → /data                 → postMessage to the shell page
│  │    lazy HTTP Range reads, copy-on-write overlay in IndexedDB  ← status, headers, body
│  ├─ /app, /opt/php: bind mounts of /data/app, /data/php
│  └─ php -S :8000  ← raw HTTP/1.0 over vm.connect() + cookie jar in the page
└─ <iframe src="/">  the Drupal site
```

```sh
pnpm install           # also fetches Node 24 for the scripts (devEngines.runtime)
pnpm install-site      # once: Drupal CMS install inside the guest under Node (~8 min), writes db/drupal.sqlite
pnpm build-image       # pack PHP + Drupal + DB into web/drupal.ext4 (sparse, ~690 MiB / ~490 MB data)
pnpm serve             # http://127.0.0.1:8787/_poc/  (Chromium 137+ / JSPI)
```

Login: `admin` / `admin` (local throwaway only). "Reset site" drops the IndexedDB overlay and cookies.
Changes (content, config, logins) persist across reloads in IndexedDB.

## Node

```sh
pnpm start             # serve db/drupal.sqlite at http://127.0.0.1:8888/ (Ctrl-C saves the DB)
```

Mounts `php-aarch64/` and `drupal/` over 9p. Needs Node 24+ (JSPI): `pnpm install` provides it via `devEngines.runtime`, whatever the system Node.

```sh
pnpm drush pm:uninstall <module> -y   # Drush inside the guest against db/drupal.sqlite (saved on success)
```

To remove a module for good: uninstall it with Drush, `composer remove` it in `drupal/`, `pnpm drush cr`,
then `pnpm build-image` (browsers drop their old overlay when the image changes).

## Rebuild PHP

```sh
git clone https://github.com/crazywhalecc/static-php-cli.git vendor-src/static-php-cli
cd vendor-src/static-php-cli && composer install --no-dev
bin/spc craft ../../php-aarch64/craft.yml   # PHP 8.5, SPC_TARGET=aarch64-linux-musl (zig cross-compile, ~2–6 min)
cp buildroot/bin/php ../../php-aarch64/php
```

Extensions: bcmath ctype curl dom fileinfo filter gd(jpeg/webp/freetype) iconv mbstring opcache openssl
pdo_sqlite phar posix session simplexml sodium sqlite3 tokenizer xml xmlreader xmlwriter zip zlib.

## Findings

- **Cookies:** a service worker can't read `Cookie` or emit `Set-Cookie`, and unkernel's `vm.fetch` drops both
  in browsers (forbidden headers). The page talks raw HTTP/1.0 to `php -S` over `vm.connect()` and keeps the jar.
- **SQLite needs real locks:** on the 9p mount it fails (`disk I/O error`); on the ext4 image it works.
  Drupal uses WAL mode, so the Node runner checkpoints before copying the DB out.
- **`output_buffering`:** the CLI SAPI (`php -S`) forces it to 0 over php.ini; set with `-d` on the command line.
- **Drupal 11.4:** core's `standard` recipe ships no content types any more; Drupal CMS site templates
  (`drupal/mercury_demo`, `drupal/drupal_cms_starter`) are composer-required recipes installed with `drush si recipes/<name>`.
- **ECA is removed** (`eca`, `modeler`, `modeler_api`; 12 Drupal CMS automations gone). In Drupal CMS, ECA's
  `define_breakpoints` model provides the `custom` breakpoint group, so uninstalling it deleted all 29 responsive
  image styles and disabled `field_media_image` on the media image displays: media images won't render in those
  displays until breakpoints and responsive styles are recreated.
- **ext4 image:** the Drupal CMS tree is ~51k files and directories; inode count is sized from the tree.
- **Speed (this machine):** install native 30 s vs. guest 480 s (~15×). Browser: shell boots in ~1 s, first
  page ~40 s cold, admin pages 15–45 s cold, warm cached pages ~50–90 ms. `php -S` serves one request at a time,
  so assets queue behind PHP requests on cold loads.

## Licenses

unkernel npm package: MIT AND GPL-2.0-only (ships a Linux kernel and busybox). static-php-cli: MIT; the PHP
binary bundles PHP (PHP License) and libraries under their own licenses (`bin/spc dump-license`). Drupal, Drupal
CMS, Mercury: GPL-2.0-or-later. Get a license review before distributing the image or the page.
