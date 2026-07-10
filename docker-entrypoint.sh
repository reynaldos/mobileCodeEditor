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
export PROJECT_PATH=/projects/app

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

if [ ! -d "$PROJECT_PATH" ]; then
  echo "PROJECT_PATH $PROJECT_PATH does not exist inside the container." >&2
  echo "Clone a repo into the /projects volume on the host first:" >&2
  echo "  git clone <url> projects/app" >&2
  exit 1
fi

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "note: CLAUDE_CODE_OAUTH_TOKEN not set — the log and UI work, but no agent will start." >&2
fi

exec node --experimental-strip-types /app/apps/workspace-server/src/index.ts
