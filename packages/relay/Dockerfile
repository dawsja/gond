# gond-relay, self-hosted: one Bun process and one SQLite file in /data.
# The relay itself has no dependencies; @hpke/core is only for Gond's side (client.ts).
FROM oven/bun:1.4.4-alpine
WORKDIR /app
COPY src/protocol.ts src/mailbox.ts src/server.ts ./src/
ENV GOND_RELAY_PORT=8791 GOND_RELAY_DATA_DIR=/data
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data
EXPOSE 8791
USER bun
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8791/healthz || exit 1
CMD ["bun", "run", "src/server.ts"]
