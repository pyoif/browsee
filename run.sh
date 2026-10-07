#!/usr/bin/env bash
# Launch the browsee stdio server.
#
# Node (fetched by nub) needs libatomic from the pixi GTK env, so we prepend it
# to LD_LIBRARY_PATH. The camoufox launch inside the server additionally points
# LD_LIBRARY_PATH at the same GTK lib dir for the Firefox binary.
#
# Bundled Chromium (browser_spawn with stealth=false) links against
# libudev.so.1, which is NOT present in the Wolfi image and /usr/lib is
# read-only. We therefore ship libudev in the persistent workspace at
# $HOME/.local/lib/udev and add it to LD_LIBRARY_PATH here, so every browser
# launched by the server inherits it. See notes/chromium-playwright-install.md.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GTK_LIB="$HOME/camoufox/.pixi/envs/default/lib"
UDEV_LIB="$HOME/.local/lib/udev"
export LD_LIBRARY_PATH="${UDEV_LIB}:${GTK_LIB}:${LD_LIBRARY_PATH:-}"
exec nub "$HERE/dist/server.js"
