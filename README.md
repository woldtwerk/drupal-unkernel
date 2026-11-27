# Drupal CMS on unkernel (PoC)

Drupal CMS 2 (Drupal 11.4, **Mercury Demo** site template) running inside
[unkernel](https://github.com/pithings/unkernel), a Linux kernel compiled to WebAssembly, **in the browser** or
under Node. PHP 8.5 is a fully static aarch64 binary built with
[static-php-cli](https://github.com/crazywhalecc/static-php-cli): unkernel's CPU emulator (kwemu) runs aarch64
user programs, whatever the host CPU.

## Browser

```
tab: any URL, e.g. /node/1 (shell page, files in /_shell/)       service worker (scope /)
├─ unkernel.wasm (Linux 7.3, base shell, 1 CPU) in a Web Worker    top-level page loads → the shell page
│  ├─ /dev/wda = drupal.ext4, label kwdata → /data                 → postMessage to the shell page
│  │    lazy HTTP Range reads, copy-on-write overlay in IndexedDB  ← status, headers, body
│  ├─ /app, /opt/php: bind mounts of /data/app, /data/php
│  └─ php -S :8000  ← raw HTTP/1.0 over vm.connect() + cookie jar in the page
├─ Cache API: static assets (css/js/fonts/images) per image ETag     cached assets are answered here, no guest
└─ <iframe src="/node/1">  the Drupal site; its URL is mirrored into the address bar
```

```sh
pnpm install           # also fetches Node 24 for the scripts (devEngines.runtime)
pnpm install-site      # once: native Drupal CMS install + cache warm-up in the guest (~7 min)
pnpm build-image       # pack PHP + Drupal + DB into web/drupal.ext4 (sparse)
pnpm serve             # http://127.0.0.1:8787/  (Chromium 137+ / JSPI)
```

`install-site` installs the Mercury Demo template (pinned in `install-site.sh`) in a throwaway copy of `drupal/`
with the packages it requires, uninstalls every module `drupal/` doesn't ship (plus a few core ones), and keeps only
the DB, `settings.php` and public files: reproducible from a fresh clone. Every image style derivative is
generated natively there (~2.5 min, ~14 MB; in the guest each takes seconds), as WebP where a style asks for AVIF,
since the guest's GD has no AVIF. It then warms Drupal's caches in the
guest (`node run.mjs --warm`, at the image's `/app` paths): the browser's first page drops from ~2–3 min to ~30 s.

`install-site` and `build-image` need host `php` (pdo_sqlite), `composer`, `rsync` and `mke2fs` (e2fsprogs;
keg-only in Homebrew: add `$(brew --prefix e2fsprogs)/sbin` to `PATH`). `build-image` packs only what the site runs:
files matched by `.imageignore` (tests, docs, lockfiles, dev tooling, recipes), modules/themes not installed in
`db/drupal.sqlite` and Composer dev packages (Drush) stay out, so the browser's Extend page can't enable them.

Login: `admin` / `admin` (local throwaway only). "Reset site" drops the IndexedDB overlay and cookies.
Changes (content, config, logins) persist across reloads in IndexedDB.

## GitHub Pages

Works on a project site (`https://<user>.github.io/<repo>/`) or a domain root. The workflow's `BASE_PATH` defaults to
`/<repo>`: set it to `""` for a user site or custom domain. Settings → Pages → Source: GitHub Actions.
`web/drupal.ext4` (541 MB) is over git's limit and built from gitignored inputs, so build it locally and upload it as a
release asset. Warm it for the deploy host (Drupal's page cache is keyed by host):

```sh
BASE_PATH=/drupal-unkernel WARM_HOST=woldtwerk.github.io pnpm install-site   # BASE_PATH/WARM_HOST optional
pnpm build-image
gh release create image-$(date +%F) web/drupal.ext4   # or: gh release upload <tag> web/drupal.ext4 --clobber
```

Publishing a release (or pushing `main`) deploys the latest release's image (`.github/workflows/pages.yml`).
Range requests and the large file on Pages are untested. Local test of a subpath:
`BASE=/drupal-unkernel pnpm serve` → http://127.0.0.1:8787/drupal-unkernel/. Under a subpath the guest runs
`php -S` with its own router (`/srv/.router.php`), since Drupal's `.ht.router.php` forces base path `/`.

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

`pnpm build-php` runs these steps (needed once before `install-site`, or after changing `craft.yml`):

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
- **Also removed:** Announcements, Automatic Updates, Autosave Form, BigPipe, Dashboard, Database Logging,
  Symfony Mailer Lite, Drupical, Navigation Extra Tools, Package Manager, Project Browser, Redirect 404,
  Scheduler Content Moderation Integration, SEO Checklist (+ Checklist API), Trash, Update Status, View Password.
  Core modules are only uninstalled; contrib packages are `composer remove`d. Mail System now uses core's
  `php_mail` instead of `symfony_mailer_lite`.
- **ext4 image:** the Drupal CMS tree is ~51k files and directories; inode count is sized from the tree.
- **Speed (this machine):** install native 30 s vs. guest 480 s (~15×). Browser: shell boots in ~1 s, first
  page ~40 s cold, admin pages 15–45 s cold, warm cached pages ~50–90 ms. `php -S` serves one request at a time,
  so assets queue behind PHP requests on cold loads. Static assets are cached in the browser after their
  first fetch, so repeat views don't touch the guest for them.

## Licenses

unkernel npm package: MIT AND GPL-2.0-only (ships a Linux kernel and busybox). static-php-cli: MIT; the PHP
binary bundles PHP (PHP License) and libraries under their own licenses (`bin/spc dump-license`). Drupal, Drupal
CMS, Mercury: GPL-2.0-or-later. Get a license review before distributing the image or the page.
