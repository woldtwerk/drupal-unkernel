#!/usr/bin/env bash
# Pack static PHP + Drupal + its SQLite DB into an ext4 image for the browser.
# Label "kwdata": unkernel's init mounts it at /data automatically.
set -euo pipefail
cd "$(dirname "$0")"

[ -f db/drupal.sqlite ] || { echo "no db/drupal.sqlite: run 'pnpm install-site' first" >&2; exit 1; }

STAGE=build/rootfs
OUT=web/drupal.ext4
[ -d build ] && chmod -R u+w build; rm -rf build
mkdir -p "$STAGE/app" "$STAGE/php" "$STAGE/db"
cp -a --reflink=auto drupal/. "$STAGE/app/"
cp php-aarch64/php php-aarch64/php.ini "$STAGE/php/"
cp db/drupal.sqlite "$STAGE/db/"

# content + 256 MiB headroom for uploads, caches and the DB growing
SIZE_MB=$(( $(du -sm "$STAGE" | cut -f1) + 256 ))
# Drupal CMS is many small files: size inodes from the real count (x2 for caches/uploads)
INODES=$(( $(find "$STAGE" | wc -l) * 2 + 10000 ))
rm -f "$OUT"
mke2fs -q -t ext4 -L kwdata -b 4096 -N "$INODES" -d "$STAGE" -F "$OUT" "${SIZE_MB}M"
[ -d build ] && chmod -R u+w build; rm -rf build
echo "built $OUT (${SIZE_MB} MiB, sparse: $(du -h "$OUT" | cut -f1) on disk)"
