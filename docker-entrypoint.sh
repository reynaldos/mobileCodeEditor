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

# With GH_TOKEN present, `gh` is already authenticated; this teaches plain `git`
# to use it too, so `git push` works without a credential prompt.
if [ -n "${GH_TOKEN:-}" ]; then
  gh auth setup-git >/dev/null 2>&1 || echo "warning: gh auth setup-git failed" >&2
fi

if [ ! -d "${PROJECT_PATH:-/projects/app}" ]; then
  echo "PROJECT_PATH ${PROJECT_PATH:-/projects/app} does not exist." >&2
  echo "Clone a repo into the /projects volume first. See docs/PHASE-0.md." >&2
  exit 1
fi

exec node --experimental-strip-types /app/apps/workspace-server/src/index.ts
