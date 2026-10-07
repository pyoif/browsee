#!/usr/bin/env bash
# Launch the browsee stdio server.
#
# The spacebotX Wolfi runtime image ships the GTK/X11 stack (libgtk-3, libudev,
# libatomic, xvfb) natively, so there is no library shim to wire up here anymore.
# run.sh now only resolves the GTK lib dir for the camoufox/firefox launch, with
# a fall back to a workspace-local pixi env and then the system, so the server
# still starts when the client passes a different HOME than the one the env was
# provisioned under. See the container commits 368ec8fc/ad8592b5/c1d62c46.
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
export LD_LIBRARY_PATH="${GTK_LIB}:${LD_LIBRARY_PATH:-}"
exec nub "$HERE/dist/server.js"

