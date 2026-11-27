#!/usr/bin/env bash
# Build the static aarch64 PHP for the guest with static-php-cli (config: php-aarch64/craft.yml).
set -euo pipefail
cd "$(dirname "$0")"

SPC=vendor-src/static-php-cli
[ -d "$SPC" ] || git clone https://github.com/crazywhalecc/static-php-cli.git "$SPC"
composer --working-dir="$SPC" install --no-dev
(cd "$SPC" && bin/spc craft ../../php-aarch64/craft.yml)
cp "$SPC/buildroot/bin/php" php-aarch64/php
file php-aarch64/php
