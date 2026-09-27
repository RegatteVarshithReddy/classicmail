#!/usr/bin/env bash
# Builds the ClassicMail .deb and AppImage on Ubuntu (22.04 / 24.04) and prints how to install them.
#   ./scripts/build-ubuntu.sh            build only
#   ./scripts/build-ubuntu.sh --test     run the unit/integration tests first
set -euo pipefail
cd "$(dirname "$0")/.."

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing '$1'. $2" >&2; exit 1; }; }
need node "Install Node 20 or newer, e.g. from https://nodejs.org or: sudo apt install nodejs npm"
need npm  "Install npm: sudo apt install npm"
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 20 ]; then echo "Node $major is too old; ClassicMail needs Node 20 or newer." >&2; exit 1; fi

echo "==> Installing dependencies"
if [ -f package-lock.json ]; then npm ci; else npm install; fi

if [ "${1:-}" = "--test" ]; then
  echo "==> Running tests (needs pymap: pip install pymap)"
  npm test
fi

echo "==> Building the .deb and AppImage (the first run downloads the fpm packaging tool)"
npm run dist

echo
ls -lh release/*.deb release/*.AppImage
echo
echo "Install:  sudo apt install ./release/classicmail_*_amd64.deb"
echo "Run:      classicmail"
