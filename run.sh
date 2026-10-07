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
# GTK/X11 libs: prefer the documented pixi env under $HOME, but fall back to a
# workspace-local pixi env and then the system, so the server still starts when
# the client passes a different HOME than the one the env was provisioned under.
GTK_CANDIDATES=(
  "${BROWSEE_GTK_LIB_DIR:-}"
  "$HOME/camoufox/.pixi/envs/default/lib"
  "$PWD/camoufox/.pixi/envs/default/lib"
  "/usr/lib"
  "/lib"
)
GTK_LIB=""
for cand in "${GTK_CANDIDATES[@]}"; do
  if [ -n "$cand" ] && [ -e "$cand/libgtk-3.so.0" ]; then
    GTK_LIB="$cand"
    break
  fi
done
UDEV_LIB="$HOME/.local/lib/udev"
export LD_LIBRARY_PATH="${UDEV_LIB}:${GTK_LIB}:${LD_LIBRARY_PATH:-}"
exec nub "$HERE/dist/server.js"
