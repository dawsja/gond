# syntax=docker/dockerfile:1

# The full (not slim) Node image brings git, Python 3 and a C toolchain.
FROM oven/bun:1.4.2 AS bun

FROM node:24-bookworm
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ripgrep jq \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1001 --user-group agent \
 && mkdir -p /home/agent/.bots /home/agent/.cache /home/agent/.claude /home/agent/.codex /home/agent/.grok /state \
 && chown agent:agent /home/agent/.bots /home/agent/.cache /home/agent/.claude /home/agent/.codex /home/agent/.grok

# A light Xfce desktop (its window manager, desktop, Thunar and terminal)
# with a Plank dock; no 3D acceleration needed. The desktop needs no ports:
# VNC listens on a unix socket in the person's runtime dir, bridged by
# server.mjs. xdotool and scrot are a bot's hands and eyes on it, xclip its
# clipboard; xauth keeps the display theirs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tigervnc-standalone-server xfonts-base dbus-x11 xauth xdotool xclip scrot imagemagick x11-xserver-utils \
      xfwm4 xfdesktop4 xfce4-settings xfconf thunar xfce4-terminal mousepad plank \
      adwaita-icon-theme gnome-themes-extra librsvg2-common fonts-dejavu-core fonts-cantarell \
      fonts-noto-color-emoji fonts-wqy-microhei \
      dconf-cli dconf-service \
 && rm -rf /var/lib/apt/lists/*
COPY xfce/xfconf/ /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/
COPY xfce/wallpaper.svg /usr/share/backgrounds/gond/wallpaper.svg

# Google builds Chrome for amd64 only, so arm64 gets Debian's Chromium; both
# answer to `google-chrome`.
ARG TARGETARCH
RUN set -eux; \
    if [ "${TARGETARCH:-amd64}" = "amd64" ]; then \
      curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
        | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg; \
      echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
        > /etc/apt/sources.list.d/google-chrome.list; \
      apt-get update; \
      apt-get install -y --no-install-recommends google-chrome-stable; \
    else \
      apt-get update; \
      apt-get install -y --no-install-recommends chromium; \
      ln -sf /usr/bin/chromium /usr/bin/google-chrome; \
      ln -sf /usr/bin/chromium /usr/bin/google-chrome-stable; \
    fi; \
    rm -rf /var/lib/apt/lists/*

# Chrome's sandbox cannot start in the box: Docker's seccomp profile denies
# the user namespaces it asks for, and no-new-privileges disables its setuid
# helper. The container and its unprivileged user are the isolation here, so
# a wrapper (google-chrome.sh) passes --no-sandbox for every way Chrome gets
# launched, and opens the bots' profile for a window the person opens. The
# policy file turns off what flags don't reach; Chrome and Chromium read
# policies from different directories, so both get it.
COPY chrome-policy.json /etc/opt/chrome/policies/managed/gond.json
COPY chrome-policy.json /etc/chromium/policies/managed/gond.json
COPY google-chrome.sh /usr/local/bin/google-chrome
RUN set -eux; \
    chmod 755 /usr/local/bin/google-chrome; \
    ln -s google-chrome /usr/local/bin/google-chrome-stable; \
    for entry in /usr/share/applications/google-chrome.desktop \
                 /usr/share/applications/com.google.Chrome.desktop \
                 /usr/share/applications/chromium.desktop; do \
      if [ -f "$entry" ]; then \
        sed -i -E 's#^Exec=/usr/bin/(google-chrome-stable|chromium)#Exec=/usr/local/bin/google-chrome#' "$entry"; \
      fi; \
    done

RUN mkdir -p /srv/gond/skills && chmod 755 /srv/gond/skills

ENV PORT=8787 \
    AGENT_HOME=/home/agent \
    HOMES_DIR=/home \
    SKILLS_DIR=/srv/gond/skills \
    BOTS_DIR=/home/agent/.bots \
    CACHE_DIR=/home/agent/.cache \
    CLAUDE_CONFIG_DIR=/home/agent/.claude \
    CODEX_HOME=/home/agent/.codex \
    GROK_HOME=/home/agent/.grok \
    GROK_DISABLE_AUTOUPDATER=1 \
    STATE_DIR=/state \
    DESKTOP_DISPLAY=1 \
    CHROME_BIN=/usr/local/bin/google-chrome \
    CHROME_PATH=/usr/local/bin/google-chrome

WORKDIR /box
COPY package.json bun.lock* ./
RUN bun install --production && rm -rf /root/.bun/install/cache
# Every module at the root: named one by one, a new one is forgotten until the box won't start.
COPY *.mjs desktop.sh update.sh ./
RUN chmod 755 desktop.sh update.sh

# The box is not a throwaway: /home/agent as a whole is a volume, so what the
# admin's bots install for themselves is still there after a restart or a new
# image. docker-compose.yml mounts /home for everyone else's homes; /state
# keeps the API token and the register of accounts.
VOLUME ["/state", "/home/agent", "/home/agent/.bots", "/home/agent/.cache", "/home/agent/.claude"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# tini reaps processes a timeout killed. Root only to run commands as the
# agent user; see server.mjs.
ENTRYPOINT ["tini", "--"]
CMD ["node", "/box/server.mjs"]
