#!/bin/bash
# server.mjs runs this in its own process group and kills the group to stop
# the desktop. VNC listens on a socket in the runtime dir, the person's
# alone, and the X display takes a cookie kept there too, so nobody else on
# the box can watch or drive this desktop.
set -u

width="${DESKTOP_WIDTH:-1280}"
height="${DESKTOP_HEIGHT:-800}"
display="${DISPLAY:-:1}"
number="${display#:}"

mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
mkdir -p "$HOME/Desktop"
# A stale lock from a killed server would keep the display from starting.
rm -f "/tmp/.X${number}-lock" "/tmp/.X11-unix/X${number}"

# One fresh cookie per start: the X server only takes clients that show it,
# and only this user (and the box, acting as them) can read the file.
export XAUTHORITY="$XDG_RUNTIME_DIR/Xauthority"
rm -f "$XAUTHORITY"
xauth -q -f "$XAUTHORITY" add ":$number" MIT-MAGIC-COOKIE-1 "$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"

vncsock="$XDG_RUNTIME_DIR/vnc.sock"
rm -f "$vncsock"

Xtigervnc "$display" \
  -geometry "${width}x${height}" -depth 24 \
  -auth "$XAUTHORITY" \
  -rfbunixpath "$vncsock" -rfbunixmode 0600 -rfbport -1 -localhost yes \
  -SecurityTypes None -AlwaysShared -AcceptSetDesktopSize=0 \
  -AllowOverride desktop,AcceptPointerEvents,AcceptKeyEvents,AcceptCutText \
  -desktop "Gond" -nolisten tcp &
xpid=$!

cleanup() {
  kill "$xpid" 2>/dev/null
  wait "$xpid" 2>/dev/null
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 50); do
  [ -S "/tmp/.X11-unix/X${number}" ] && break
  kill -0 "$xpid" 2>/dev/null || { echo "[desktop] X server exited" >&2; exit 1; }
  sleep 0.2
done

# Xfce's window manager and desktop with a Plank dock, nothing else: no
# panel, no session manager, no lock screen or power manager in a box nobody
# logs into. The defaults (dark theme, wallpaper, no desktop icons) are in
# /etc/xdg; anything the person changes lands in their own ~/.config.
export XDG_SESSION_TYPE=x11
export XDG_CURRENT_DESKTOP=XFCE
export XDG_SESSION_DESKTOP=xfce
export NO_AT_BRIDGE=1
export GTK_A11Y=none
export TERM=xterm-256color
export COLORTERM=truecolor
export SHELL=/bin/bash
unset CI

# The dock's three launchers, written once, and its settings wherever the
# person hasn't set their own. It is always shown and keeps its strip of the
# screen, so a maximized window (the bots' Chrome always is) stops above it
# instead of hiding it. The image has dconf, not gsettings.
dock() {
  local launchers="$HOME/.config/plank/dock1/launchers"
  local dock1=/net/launchpad/plank/docks/dock1
  setting() {
    local now
    now="$(dconf read "$dock1/$1" 2>/dev/null)"
    # Docks set up before this hid behind any window over them.
    [ -z "$now" ] || { [ "$1" = hide-mode ] && [ "$now" = "'window-dodge'" ]; } && dconf write "$dock1/$1" "$2" 2>/dev/null
  }
  if [ ! -d "$launchers" ]; then
    mkdir -p "$launchers"
    local name entry items=()
    for pair in chrome:google-chrome.desktop chrome:chromium.desktop files:thunar.desktop files:org.xfce.thunar.desktop terminal:xfce4-terminal.desktop terminal:org.xfce.terminal.desktop; do
      name="${pair%%:*}"
      entry="/usr/share/applications/${pair#*:}"
      [ -f "$entry" ] && [ ! -f "$launchers/$name.dockitem" ] || continue
      printf '[PlankDockItemPreferences]\nLauncher=file://%s\n' "$entry" > "$launchers/$name.dockitem"
      items+=("'$name.dockitem'")
    done
    dconf write "$dock1/dock-items" "[$(IFS=,; echo "${items[*]}")]" 2>/dev/null
  fi
  setting hide-mode "'none'"
  setting icon-size 40
  setting theme "'Transparent'"
  setting show-dock-item false
}

session() {
  xset s off -dpms 2>/dev/null
  dock
  xfsettingsd --sm-client-disable --daemon
  xfdesktop --sm-client-disable &
  # A dock that crashes comes back, for as long as the display lives.
  (while xset q >/dev/null 2>&1; do plank; sleep 1; done) &
  # Plank stays where the bottom was when a viewer resizes the screen, so
  # it is started again at the new size.
  (
    size=""
    while xset q >/dev/null 2>&1; do
      now="$(xrandr --current 2>/dev/null | sed -n 's/.*current \([0-9]* x [0-9]*\).*/\1/p')"
      [ -n "$size" ] && [ -n "$now" ] && [ "$now" != "$size" ] && pkill -u "$(id -u)" -x plank
      size="$now"
      sleep 2
    done
  ) &
  # The window manager is the session: when it ends, so does the desktop.
  exec xfwm4 --sm-client-disable --compositor=on
}
export -f dock session

dbus-run-session -- bash -c session \
  > "$XDG_RUNTIME_DIR/desktop.log" 2>&1
status=$?
echo "[desktop] session ended with status $status" >&2
# server.mjs reports the last lines of stderr when the desktop dies
# unexpectedly; give it the session's own last words.
[ "$status" -ne 0 ] && tail -n 5 "$XDG_RUNTIME_DIR/desktop.log" >&2
exit "$status"
