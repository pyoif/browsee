#!/usr/bin/env bash
# Launch the browsee stdio server.
#
# Node (fetched by nub) needs libatomic from the pixi GTK env, so we prepend it
# to LD_LIBRARY_PATH. The camoufox launch inside the server additionally points
# LD_LIBRARY_PATH at the same GTK lib dir for the Firefox binary.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
GTK_LIB="$HOME/camoufox/.pixi/envs/default/lib"
export LD_LIBRARY_PATH="${GTK_LIB}:${LD_LIBRARY_PATH:-}"
exec nub "$HERE/dist/server.js"
