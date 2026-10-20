#!/bin/sh
set -e

if [ "$(id -u)" != 0 ]; then
  exec "$@"
fi

# Starts as root only to join the Docker socket's group, whatever its id on this host, then runs as bun.
sock="${GOND_DOCKER_SOCK:-${KRU_DOCKER_SOCK:-/var/run/docker.sock}}"
if [ -S "$sock" ]; then
  exec setpriv --reuid=bun --regid=bun --groups="$(stat -c %g "$sock")" --inh-caps=-all --bounding-set=-all -- "$@"
fi
exec setpriv --reuid=bun --regid=bun --clear-groups --inh-caps=-all --bounding-set=-all -- "$@"
