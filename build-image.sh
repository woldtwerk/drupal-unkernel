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
rsync -a --exclude-from=.imageignore drupal/ "$STAGE/app/"

# Drop modules/themes/profiles the site doesn't have installed (core.extension).
# Only these types: e.g. core's twig theme_engine never shows up in core.extension.
ENABLED=$(php -r '$d = unserialize((new PDO("sqlite:" . $argv[1]))
  ->query("SELECT data FROM config WHERE collection = \"\" AND name = \"core.extension\"")->fetchColumn());
  echo implode("\n", [...array_keys($d["module"]), ...array_keys($d["theme"]), $d["profile"] ?? ""]);' db/drupal.sqlite)
keep=() drop=()
while IFS= read -r info; do
  grep -qE "^type: *[\"']?(module|theme|profile)[\"']? *$" "$info" || continue
  if grep -qxF "$(basename "$info" .info.yml)" <<<"$ENABLED"; then keep+=("$(dirname "$info")/"); else drop+=("$(dirname "$info")/"); fi
done < <(find "$STAGE/app/web" -name '*.info.yml')
for d in "${drop[@]}"; do
  for k in "${keep[@]}"; do [[ $k == "$d"* ]] && continue 2; done # holds an installed submodule
  rm -rf "$d"
done

# Drop Composer dev packages (Drush) and rebuild the autoloader without them
php -r '$j = json_decode(file_get_contents($argv[1]), true);
  foreach ($j["packages"] as $p) if (in_array($p["name"], $j["dev-package-names"])) echo dirname($argv[1]), "/", $p["install-path"], "\n";' \
  "$STAGE/app/vendor/composer/installed.json" | xargs -r rm -rf
composer --working-dir="$STAGE/app" dump-autoload --no-dev --optimize --no-scripts --quiet
rm "$STAGE/app/composer.json"

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
