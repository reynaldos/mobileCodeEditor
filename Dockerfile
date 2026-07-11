# The container is the unit of everything. It holds the repos, runs the dev
# servers, and hosts the agent — because Claude's Read/Edit/Bash tools are local
# filesystem operations and must sit next to the code. See DECISIONS #4.

FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------- build
FROM base AS build

# Copy manifests first so `pnpm install` caches independently of source edits.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/protocol/package.json        packages/protocol/
COPY apps/web/package.json                 apps/web/
COPY apps/workspace-server/package.json    apps/workspace-server/

# better-sqlite3 is a native module. It normally resolves a prebuilt binary, but
# on an architecture without one it falls back to node-gyp and needs a compiler.
# Present here and absent from the runtime stage, which is the whole point.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter web build

# -------------------------------------------------------------- runtime
FROM base AS runtime

# git and ripgrep are what Claude reaches for. gh is how it talks to GitHub —
# `gh auth setup-git` at boot makes plain `git push` work too. See DECISIONS #17.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Tailscale, for hosts that have no separate machine to run it on — Fly, where
# the container IS the unit. Runs in userspace mode (no /dev/net/tun, no root),
# gated on TS_AUTHKEY so it stays dormant locally and on a VM. See the entrypoint
# and DECISIONS #12: Tailscale is the perimeter on every host, not just dev.
COPY --from=tailscale/tailscale:stable /usr/local/bin/tailscaled /usr/local/bin/tailscaled
COPY --from=tailscale/tailscale:stable /usr/local/bin/tailscale  /usr/local/bin/tailscale

# The full workspace, dev dependencies included. Larger image, one less thing to
# reason about, and the only user is you. Prune it when that stops being true.
COPY --from=build /app /app

# Volumes. The container is disposable; these are not.
#   /projects  repos and dev servers
#   /data      events.db — the log, the only durable state (+ tailscale state)
#   /config    secrets, 0600 (VM/local only; Fly injects secrets as env)
RUN mkdir -p /projects /data /config /var/run/tailscale \
 && chown -R node:node /projects /data /config /app /var/run/tailscale

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/events.db \
    UPLOADS_ROOT=/data/uploads \
    WEB_DIST=/app/apps/web/dist \
    PROJECT_PATH=/projects/app

# Run as uid 1000. A root-owned /projects volume you cannot edit from the host is
# a genuinely annoying afternoon. Match this to your own uid if it differs.
USER node

COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
