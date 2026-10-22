#!/bin/sh
# Every way Chrome starts on the box comes through here: the dock, the menu,
# CHROME_BIN and the `google-chrome` on PATH.
# The box denies the namespaces and setuid helper the sandbox needs; the
# container and its unprivileged user are the isolation.
# A window the person opens uses the browser profile of the bot whose screen it
# is on (the screen sets GOND_BROWSER_PROFILE), so what they sign in to there,
# that bot is signed in to. A headless run or one that names its own profile is
# left alone.
case " $* " in
  *" --user-data-dir="* | *" --headless"*) ;;
  *)
    profile="${GOND_BROWSER_PROFILE:-$HOME/.config/gond-browser}"
    # A lock from before the box's container was made again names its old
    # hostname; Chrome can't check it and refuses the profile, so it goes.
    lock=$(readlink "$profile/SingletonLock" 2>/dev/null)
    if [ -n "$lock" ] && [ "${lock%-*}" != "$(cat /proc/sys/kernel/hostname)" ]; then
      rm -f "$profile/SingletonLock" "$profile/SingletonSocket" "$profile/SingletonCookie"
    fi
    set -- --user-data-dir="$profile" --start-maximized "$@"
    ;;
esac
# A profile of its own changes Chrome's window class, and the dock would
# show a second icon; this keeps the one its launcher expects.
class=google-chrome
[ -d /opt/google/chrome ] || class=chromium
exec /usr/bin/google-chrome --no-sandbox --no-first-run --no-default-browser-check \
  --password-store=basic --disable-dev-shm-usage --hide-crash-restore-bubble --class="$class" "$@"
