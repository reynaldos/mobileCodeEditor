#!/bin/sh
set -e

# Secrets live at /config/.env with mode 0600, never in the image and never in
# the event log. See DECISIONS #12 and redact.ts.
if [ -f /config/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /config/.env
  set +a
fi

# Re-pin the container's own paths and runtime AFTER sourcing, so a stray
# PROJECT_PATH or DB_PATH in /config/.env — e.g. a host path copied straight from
# the dev .env — cannot break the container. The secrets file is for secrets;
# the filesystem layout belongs to the image.
export NODE_ENV=production
export HOST=0.0.0.0
export PORT="${PORT:-3000}"
export DB_PATH=/data/events.db
export WEB_DIST=/app/apps/web/dist
# PROJECT_PATH is overridable, unlike the fixed paths above. Fly Machines allow
# only one volume, so on Fly everything (log, projects, tailscale state) lives
# under the single /data mount and fly.toml sets PROJECT_PATH=/data/projects/app.
# On the VM/local it's a separate /projects mount, so the default holds.
export PROJECT_PATH="${PROJECT_PATH:-/projects/app}"

# The repos in /projects are bind-mounted from the host and were created by a
# different uid, so git refuses them as "dubious ownership". Inside a disposable
# single-user container, trusting them is correct and is what lets Claude commit
# and push. Without this, every git operation on a project fails.
git config --global --add safe.directory '*'

# Who Claude's commits are attributed to. Config, not a secret — a name and email
# are public in every commit. Driven by env so it is one value to change, and so
# a future per-tenant control plane injects each user's identity (from their
# GitHub profile) exactly the way it injects everything else. See DECISIONS #13.
if [ -n "${GIT_AUTHOR_NAME:-}" ]; then
  git config --global user.name "$GIT_AUTHOR_NAME"
fi
if [ -n "${GIT_AUTHOR_EMAIL:-}" ]; then
  git config --global user.email "$GIT_AUTHOR_EMAIL"
fi

# With GH_TOKEN present, `gh` is already authenticated; this teaches plain `git`
# to use it too, so `git push` works without a credential prompt.
if [ -n "${GH_TOKEN:-}" ]; then
  gh auth setup-git >/dev/null 2>&1 || echo "warning: gh auth setup-git failed" >&2
fi

# On a fresh volume (Fly's first boot) /projects/app doesn't exist yet. If a
# PROJECT_REPO is configured, clone it. On the VM/local the repo is already there
# and PROJECT_REPO is unset, so this is a no-op.
if [ ! -d "$PROJECT_PATH" ] && [ -n "${PROJECT_REPO:-}" ]; then
  echo "cloning $PROJECT_REPO into $PROJECT_PATH ..." >&2
  mkdir -p "$(dirname "$PROJECT_PATH")"
  git clone "$PROJECT_REPO" "$PROJECT_PATH" || echo "warning: clone failed" >&2
fi

if [ ! -d "$PROJECT_PATH" ]; then
  echo "PROJECT_PATH $PROJECT_PATH does not exist inside the container." >&2
  echo "Set PROJECT_REPO to auto-clone it, or mount a repo at /projects/app." >&2
  exit 1
fi

# Tailscale, in-container. For hosts with no separate machine to run it on (Fly),
# where the container IS the unit. Userspace networking — no /dev/net/tun, no
# root. State lives on the /data volume so the node keeps its identity and serve
# config across restarts; TS_AUTHKEY provisions it the first time. Dormant unless
# TS_AUTHKEY is set, so local and VM runs (Tailscale on the host) are unaffected.
# See DECISIONS #12: Tailscale is the perimeter on every host, not just dev.
if [ -n "${TS_AUTHKEY:-}" ]; then
  mkdir -p /data/tailscale
  tailscaled \
    --tun=userspace-networking \
    --state=/data/tailscale/tailscaled.state \
    --socket=/var/run/tailscale/tailscaled.sock \
    >/data/tailscale/tailscaled.log 2>&1 &

  i=0
  until tailscale --socket=/var/run/tailscale/tailscaled.sock status >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 40 ] && { echo "warning: tailscaled did not come up in 20s" >&2; break; }
    sleep 0.5
  done

  tailscale --socket=/var/run/tailscale/tailscaled.sock up \
    --authkey="$TS_AUTHKEY" --hostname="${TS_HOSTNAME:-mce}" --accept-dns=false \
    || echo "warning: tailscale up failed" >&2

  # Proxy the tailnet HTTPS endpoint to the local server. Idempotent on restart.
  tailscale --socket=/var/run/tailscale/tailscaled.sock serve --bg \
    "http://127.0.0.1:${PORT}" || echo "warning: tailscale serve failed" >&2
fi

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "note: CLAUDE_CODE_OAUTH_TOKEN not set — the log and UI work, but no agent will start." >&2
fi

exec node --experimental-strip-types /app/apps/workspace-server/src/index.ts
