#!/bin/bash
# Every step reports and the next one still runs, so one unreachable mirror
# doesn't stop the rest.
set -u
export DEBIAN_FRONTEND=noninteractive
failed=0

step() {
  printf '\n== %s\n' "$1"
}

finish() {
  if [ "$1" -eq 0 ]; then printf -- '-- ok\n'; else printf -- '-- failed (%s)\n' "$1"; failed=1; fi
}

step "Debian packages"
apt-get update -qq 2>&1 && apt-get upgrade -y -qq --no-install-recommends 2>&1 && apt-get autoremove -y -qq 2>&1
finish $?
rm -rf /var/lib/apt/lists/*

# What a bot's hands on the desktop need (xdotool, scrot), the display's
# cookie (xauth) and ImageMagick for model-sized copies of pictures people
# send: new on this box, or already there and skipped.
step "Desktop tools"
apt-get update -qq 2>&1 && apt-get install -y -qq --no-install-recommends xdotool scrot xauth imagemagick 2>&1
finish $?
rm -rf /var/lib/apt/lists/*

step "Bun"
before=$(bun --version 2>/dev/null || echo "?")
bun upgrade 2>&1
finish $?
printf 'bun %s -> %s\n' "$before" "$(bun --version 2>/dev/null || echo "?")"

step "Node"
printf 'node %s (from the image)\n' "$(node --version)"

if [ "$failed" -eq 0 ]; then
  printf '\nAll patched.\n'
else
  printf '\nFinished with a failed step; see above.\n'
  exit 1
fi
