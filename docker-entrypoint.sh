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
export UPLOADS_ROOT=/data/uploads
export WEB_DIST=/app/apps/web/dist
# Preview's own dedicated origin — doubles as the second listener's internal
# bind port and the external tailscale serve --https= port below.
export PREVIEW_ORIGIN_PORT="${PREVIEW_ORIGIN_PORT:-8443}"
# Projects live under a root, not a single pinned path: the in-app picker owns
# creation and every directory under the root is a project. PROJECTS_ROOT is
# overridable, unlike the fixed paths above — on Fly everything (log, projects,
# tailscale state) shares the single /data mount (fly.toml sets
# PROJECTS_ROOT=/data/projects); on the VM/local it's the /projects bind mount,
# so the default holds. Unset any legacy PROJECT_PATH a dev /config/.env may
# carry — a host path that doesn't exist in here would fail config's boot check.
unset PROJECT_PATH
export PROJECTS_ROOT="${PROJECTS_ROOT:-/projects}"
mkdir -p "$PROJECTS_ROOT"

# The repos in /projects are bind-mounted from the host and were created by a
# different uid, so git refuses them as "dubious ownership". Inside a disposable
# single-user container, trusting them is correct and is what lets Claude commit
# and push. Without this, every git operation on a project fails.
git config --global --add safe.directory '*'

# Who Claude's commits are attributed to. GitHub attributes commits by EMAIL, so
# to show up as the real account (not a `node@hostname` the container invented) we
# derive the identity from `gh` — the account's login and its noreply address —
# unless GIT_AUTHOR_NAME/EMAIL explicitly override it. Config, not a secret: every
# commit makes it public. A future per-tenant control plane injects each user's
# identity the same way. See DECISIONS #13.
git_name="${GIT_AUTHOR_NAME:-}"
git_email="${GIT_AUTHOR_EMAIL:-}"

if [ -z "$git_name" ] || [ -z "$git_email" ]; then
  if [ -n "${GH_TOKEN:-}" ]; then
    # One call, tab-separated: name (falls back to login), login, numeric id.
    ident=$(gh api /user --jq '[.name // .login, .login, (.id|tostring)] | @tsv' 2>/dev/null || true)
    if [ -n "$ident" ]; then
      [ -z "$git_name" ] && git_name=$(printf '%s' "$ident" | cut -f1)
      gh_login=$(printf '%s' "$ident" | cut -f2)
      gh_id=$(printf '%s' "$ident" | cut -f3)
      [ -z "$git_email" ] && git_email="${gh_id}+${gh_login}@users.noreply.github.com"
    fi
  fi
fi

if [ -n "$git_name" ]; then git config --global user.name "$git_name"; fi
if [ -n "$git_email" ]; then git config --global user.email "$git_email"; fi
echo "git identity: $(git config --global user.name 2>/dev/null || echo '?') <$(git config --global user.email 2>/dev/null || echo '?')>" >&2

# With GH_TOKEN present, `gh` is already authenticated; this teaches plain `git`
# to use it too, so `git push` works without a credential prompt.
if [ -n "${GH_TOKEN:-}" ]; then
  gh auth setup-git >/dev/null 2>&1 || echo "warning: gh auth setup-git failed" >&2
fi

# A fresh volume just boots to an empty projects root — the picker fills it. No
# seed clone: it used to re-create a project named "app" on every deploy, which
# fought anyone who deleted it. Add projects through the app instead.

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

  # Second mapping, same tailnet hostname: the preview's own dedicated origin
  # (see DECISIONS — dropping the /preview/:projectId/ path-prefix scheme).
  tailscale --socket=/var/run/tailscale/tailscaled.sock serve --bg --https="$PREVIEW_ORIGIN_PORT" \
    "http://127.0.0.1:$PREVIEW_ORIGIN_PORT" || echo "warning: tailscale serve (preview origin) failed" >&2
fi

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "note: CLAUDE_CODE_OAUTH_TOKEN not set — the log and UI work, but no agent will start." >&2
fi

exec node --experimental-strip-types /app/apps/workspace-server/src/index.ts
