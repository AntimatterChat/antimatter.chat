#!/usr/bin/env bash
# Rebuilds an "extra app" not yet in the antimatter-next image (currently: com.antimatterchat.assistant, which has
# no release yet) and copies its tarball into src/demo/extra-apps/, where build_demo.py's extra-apps step picks it
# up next to the image's apps. Run again whenever the app changes; commit the updated tarball with the site.
#
#     tools/demo/refresh_extra_apps.sh [checkout-dir]
#         Defaults to ~/Projects/rematter/antimatter/antimatter-plugin-assistant.
#
# Builds through the machine's memory-capped queue (CLAUDE.md: never run go build/npm run build uncapped). Does NOT
# run npm install: the checkout's webapp/node_modules must already exist.
set -euo pipefail

APP_ID=com.antimatterchat.assistant
APP_DIR="${1:-$HOME/Projects/rematter/antimatter/antimatter-plugin-assistant}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="$ROOT/src/demo/extra-apps"
HEAVY="$HOME/.cache/amtest/heavy.sh"

if [ ! -d "$APP_DIR" ]; then
    echo "refresh_extra_apps: no checkout at $APP_DIR" >&2
    exit 1
fi
if [ ! -d "$APP_DIR/webapp/node_modules" ]; then
    echo "refresh_extra_apps: $APP_DIR/webapp/node_modules is missing; run npm install there once, by hand, first" >&2
    exit 1
fi

echo "refresh_extra_apps: building $APP_ID in $APP_DIR (via heavy.sh, MEMMB=3000)" >&2
( cd "$APP_DIR" && MEMMB=3000 "$HEAVY" make dist )

BUNDLE=$(cd "$APP_DIR" && ls -t dist/"$APP_ID"-*.tar.gz 2>/dev/null | head -1)
if [ -z "$BUNDLE" ]; then
    echo "refresh_extra_apps: make dist did not produce dist/$APP_ID-*.tar.gz" >&2
    exit 1
fi

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/$APP_ID"-*.tar.gz
cp "$APP_DIR/$BUNDLE" "$OUT_DIR/"
echo "refresh_extra_apps: copied $(basename "$BUNDLE") to $OUT_DIR/" >&2
echo "refresh_extra_apps: commit it with: git add $OUT_DIR/$(basename "$BUNDLE")" >&2
