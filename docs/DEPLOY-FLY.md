# Deploy to Fly.io

Run the container on Fly — no capacity lottery, and Fly builds the image fresh for
its own architecture so the arm-vs-amd concern from the VM path disappears.

**Not free.** Fly retired its free tier; a small always-on machine is roughly **$5–15/mo**
depending on RAM. If free is the requirement, Oracle A1 (with an auto-retry script) is the
only real option — see the earlier discussion. This runbook assumes you've accepted the cost.

**How Fly differs from the VM:**
- Secrets go through `fly secrets`, not `config/.env`.
- Storage is Fly Volumes (`/data`, `/projects`), created with `fly volumes`.
- **Tailscale runs inside the container** (there's no host to run it on). The image and
  entrypoint already handle this, gated on `TS_AUTHKEY`. Nothing is exposed on `*.fly.dev`.

Result: the app at `https://mce.taile5fddb.ts.net`, always on, independent of your Mac.

---

## Phase 0 — flyctl + account

```bash
# Install the CLI (macOS)
brew install flyctl

# Sign up (needs a card) or log in
fly auth signup      # or: fly auth login
```

---

## Phase 1 — Create the app

Run from the repo root (where `fly.toml` is):

```bash
# Reuses the committed fly.toml. If "mce-workspace" is taken, it'll prompt for a
# new name — accept, and it rewrites the app name in fly.toml.
fly apps create mce-workspace
```

---

## Phase 2 — Volumes (persistent storage)

Same region as `primary_region` in fly.toml (`iad`). The event log is tiny; projects need
room for a repo + node_modules.

```bash
fly volumes create mce_data     --size 1 --region iad --yes
fly volumes create mce_projects --size 3 --region iad --yes
```

---

## Phase 3 — Secrets

Two groups. The first reads straight from your local `.env` so the values never get printed;
run it from the repo root:

```bash
fly secrets set \
  CLAUDE_CODE_OAUTH_TOKEN="$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' .env | cut -d= -f2-)" \
  GH_TOKEN="$(grep '^GH_TOKEN=' .env | cut -d= -f2-)" \
  VAPID_PUBLIC_KEY="$(grep '^VAPID_PUBLIC_KEY=' .env | cut -d= -f2-)" \
  VAPID_PRIVATE_KEY="$(grep '^VAPID_PRIVATE_KEY=' .env | cut -d= -f2-)" \
  VAPID_SUBJECT="$(grep '^VAPID_SUBJECT=' .env | cut -d= -f2-)"
```

The second is the **Tailscale auth key**, which provisions the in-container node:

1. Go to **login.tailscale.com/admin/settings/keys → Generate auth key**.
2. Make it **Reusable**, **non-ephemeral** (so the node keeps its identity), 90-day expiry is
   fine. Copy it (`tskey-auth-...`).
3. Set it:

```bash
fly secrets set TS_AUTHKEY="tskey-auth-xxxxxxxxxxxx"
```

---

## Phase 4 — Deploy

```bash
fly deploy
```

Fly builds the Dockerfile remotely (a few minutes the first time) and starts one machine with
both volumes attached.

---

## Phase 5 — Verify

```bash
# Watch boot: expect the clone, then tailscaled up, then "workspace server ready".
fly logs

# Health, from inside the machine (nothing is public, so curl it internally):
fly ssh console -C "curl -s http://127.0.0.1:3000/api/health"
#   expect agentReady:true, pushReady:true

# Is the node on your tailnet?
fly ssh console -C "tailscale --socket=/var/run/tailscale/tailscaled.sock status"
```

You should also see `mce` appear at **login.tailscale.com/admin/machines**.

---

## Phase 6 — Phone

The box is a **new origin** (`mce.…`, not your Mac's), so the phone treats it as a fresh app:

1. Open `https://mce.taile5fddb.ts.net` in Safari on your phone.
2. Share → **Add to Home Screen**.
3. Open it from the home screen, tap **🔔 Enable** — a new push subscription registers for
   this origin.
4. Prompt, lock the phone, get the buzz. Now it works with your Mac closed.

---

## Cutover

Retire the Mac copy once the Fly box is confirmed:

```bash
# On the Mac:
docker compose down
tailscale serve reset
```

---

## Updating later

```bash
fly deploy      # rebuilds and rolls the machine
```

Code changes ship on `fly deploy` — no rsync, no SSH. Fly rebuilds from the Dockerfile each
time.

---

## The parts most likely to need a second look

Everything except the in-container Tailscale is well-trodden. Tailscale-in-userspace is the
one piece I couldn't test locally, so check `fly logs` for these:

- **`tailscale serve` syntax** — CLI syntax has shifted across versions. If you see a serve
  usage error, the fix is a one-line tweak in `docker-entrypoint.sh` (the `serve --bg` call).
  Paste the error and it's a two-minute fix.
- **`tailscaled` as non-root** — it runs as uid 1000 in userspace mode, which should need no
  privileges. If the daemon complains, we either grant a cap in fly.toml or run it as root.
- **Cert on first serve** — HTTPS must be enabled in the tailnet admin (it is, tenant-wide
  from your Mac setup). A cert error there is that toggle, not the code.
- **OOM** — if the machine dies under a build + dev server, `fly scale memory 4096`.
