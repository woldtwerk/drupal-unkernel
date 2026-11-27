#!/usr/bin/env bash
# Install Drupal CMS (Mercury Demo site template) natively into db/drupal.sqlite.
# The template requires packages drupal/ no longer ships (ECA, Automatic Updates, ...), so it is
# installed in a throwaway copy that has them, those modules are uninstalled, and only the DB,
# settings.php and public files are kept.
set -euo pipefail
cd "$(dirname "$0")"

TEMPLATE=drupal/mercury_demo:1.1.1
# Core modules the site template enables that this PoC doesn't want
CORE_REMOVED="announcements_feed big_pipe dblog package_manager update"
WORK=build/install
GUEST_DB=/var/lib/drupal/drupal.sqlite # where run.mjs and the browser image put the DB

[ -d drupal/vendor ] || composer --working-dir=drupal install --no-interaction
[ -d "$WORK" ] && chmod -R u+w "$WORK"; rm -rf "$WORK"; mkdir -p "$WORK"
rsync -a --exclude=/web/sites/default/files/ --exclude=/web/sites/default/settings.php drupal/ "$WORK/"
# Keep the template a plain recipe in recipes/: unpacking would rewrite composer.json
composer --working-dir="$WORK" config --json extra.drupal-recipe-unpack.on-require false
composer --working-dir="$WORK" require --no-interaction "$TEMPLATE"

drush() { (cd "$WORK/web" && php -d memory_limit=1G ../vendor/drush/drush/drush.php "$@"); }
cp "$WORK/web/sites/default/default.settings.php" "$WORK/web/sites/default/settings.php"
# Relative DB path (to web/): SQLite paths over 128 characters are rejected
drush site:install ../recipes/mercury_demo -y --db-url=sqlite://localhost/../drupal.sqlite \
  --site-name="Drupal CMS on unkernel" --account-name=admin --account-pass=admin

# Uninstall the core modules above and every module whose code drupal/ doesn't have
remove=$CORE_REMOVED
for m in $(drush pm:list --status=enabled --type=module --field=name); do
  [ -n "$(find drupal/web -name "$m.info.yml" -print -quit)" ] || remove+=" $m"
done
drush php:eval '\Drupal::configFactory()->getEditable("mailsystem.settings")
  ->set("defaults.sender", "php_mail")->set("defaults.formatter", "php_mail")
  ->clear("modules.symfony_mailer_lite")->save();'
drush pm:uninstall -y $remove

# Pre-generate every image style derivative natively: in the guest each one takes seconds.
# Existing files are served directly (no itok check). Canvas's parametrized widths get the
# image_scale effect its route converter adds (ParametrizedImageStyleConverter::convert()).
# The guest's GD has no AVIF, so its URLs use the AVIF effects' fallback format: convert to
# that here too (in memory; deleteImageEffect() would save the style).
drush php:eval '
  use Drupal\canvas\Entity\ParametrizedImageStyle;
  use Drupal\canvas\Routing\ParametrizedImageStyleConverter as Widths;
  use Drupal\image\Entity\ImageStyle;
  $uris = \Drupal::database()->query("SELECT uri FROM {file_managed} WHERE filemime LIKE :img AND filemime <> :svg",
    [":img" => "image/%", ":svg" => "image/svg+xml"])->fetchCol();
  $styles = [];
  foreach (ImageStyle::loadMultiple() as $id => $style) {
    if ($id !== "canvas_parametrized_width") { $styles[] = $style; continue; }
    foreach (Widths::ALLOWED_WIDTHS as $w) {
      $s = ParametrizedImageStyle::loadWithParameters($id, ["width" => (string) $w]);
      $s->addImageEffect(["id" => "image_scale", "weight" => 0, "data" => ["width" => $w]]);
      $styles[] = $s;
    }
  }
  foreach ($styles as $s) foreach ($s->getEffects() as $uuid => $e) {
    if ($e->getPluginId() !== "image_convert_avif") continue;
    $c = $e->getConfiguration();
    $s->getEffects()->removeInstanceId($uuid);
    $s->addImageEffect(["id" => "image_convert", "weight" => $c["weight"], "data" => ["extension" => $c["data"]["extension"]]]);
  }
  $n = 0;
  foreach ($styles as $s) foreach ($uris as $uri) {
    $d = $s->buildUri($uri);
    if (file_exists($d) || $s->createDerivative($uri, $d)) $n++;
    else echo "failed: ", $s->id(), " ", $uri, "\n";
  }
  echo "image derivatives: $n (", count($styles), " styles x ", count($uris), " images)\n";'

# Fold the WAL into the DB and empty the caches: they hold this throwaway copy's paths
php -r '$db = new PDO("sqlite:" . $argv[1]);
  foreach ($db->query("SELECT name FROM sqlite_master WHERE type = \"table\" AND name LIKE \"cache%\"")->fetchAll(PDO::FETCH_COLUMN) as $t) $db->exec("DELETE FROM \"$t\"");
  $db->exec("PRAGMA wal_checkpoint(TRUNCATE)");' "$WORK/drupal.sqlite"

mkdir -p db
cp "$WORK/drupal.sqlite" db/drupal.sqlite
chmod u+w drupal/web/sites/default
sed "s#'database' => '../drupal.sqlite'#'database' => '$GUEST_DB'#" \
  "$WORK/web/sites/default/settings.php" > drupal/web/sites/default/settings.php
# Without php/: the compiled Twig templates are keyed to this copy's paths
rsync -a --delete --exclude=/php/ "$WORK/web/sites/default/files/" drupal/web/sites/default/files/
chmod -R u+w "$WORK"; rm -rf "$WORK"
echo "installed: db/drupal.sqlite (uninstalled:$remove)"

# Warm the caches in the guest (needs php-aarch64/php: pnpm build-php), at the image's paths
node run.mjs --warm
