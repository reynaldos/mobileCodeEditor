# Deploy to Oracle Cloud (Always Free arm64)

Move the container to a box that never sleeps. Same image, same `config/.env`, same
`tailscale serve` — the only new work is provisioning the box. See DECISIONS #12 (Tailscale
is the perimeter) and #13 (the container is the portable unit).

Result: the app reachable from your phone at `https://mce.taile5fddb.ts.net`, up whether or
not your Mac is.

Placeholders: `<BOX_IP>` is the instance's public IP; the SSH key is `~/.ssh/key`.

---

## Phase 1 — Create the instance (Oracle console, one-time)

1. Sign up at **cloud.oracle.com**. Needs email, phone, and a card (identity only — Always
   Free resources aren't charged). Pick a **home region** close to you; it's permanent and
   affects arm capacity.

2. Console → **Compute → Instances → Create instance**.
   - **Name:** `mce`
   - **Image:** change to **Canonical Ubuntu 22.04** (or 24.04). Both are arm64-capable.
   - **Shape:** click Change shape → **Ampere** → `VM.Standard.A1.Flex` →
     **2 OCPUs, 12 GB** (Always Free allows up to 4 OCPU / 24 GB total; 2/12 is plenty and
     often schedules more easily).
   - **SSH keys:** upload your public key. On the Mac: `pbcopy < ~/.ssh/key.pub`, paste it.
   - **Networking:** leave defaults — it creates a VCN with a public subnet and assigns a
     public IPv4. Nothing else to change.
   - **Create.**

3. **If you see "Out of host capacity"** (the one real Oracle annoyance): the free arm hosts
   are rationed. Try a different **Availability Domain** in the create dialog, or retry in a
   few minutes/hours. Smaller shapes schedule more easily.

4. When it's Running, copy its **Public IP address** → this is `<BOX_IP>`.

> Note: we open **no public ports** beyond SSH. Tailscale carries all app traffic privately,
> which also sidesteps Oracle's double-firewall (cloud security lists + host iptables).

---

## Phase 2 — First SSH + system prep

```bash
# From your Mac. Default user on Ubuntu images is `ubuntu`.
ssh -i ~/.ssh/key ubuntu@<BOX_IP>

# On the box:
sudo apt update && sudo apt upgrade -y
sudo apt install -y git
```

---

## Phase 3 — Install Docker + Tailscale (on the box)

```bash
# Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu       # run docker without sudo
newgrp docker                        # apply the group now (or log out/in)
docker --version                     # confirm

# Tailscale
curl -fsSL https://tailscale.com/install.sh | sudo sh
sudo tailscale up --hostname mce     # prints a URL — open it, approve the machine
tailscale status                     # should show this machine + your others
```

> HTTPS certificates and MagicDNS must be enabled in the tailnet admin console (Settings →
> Keys / DNS). You already turned these on for the Mac, so they apply tailnet-wide — nothing
> to redo. If `tailscale serve` later errors on a cert, that toggle is why.

---

## Phase 4 — Ship the code + secrets to the box (from your Mac)

`rsync` sends the source and both env files over SSH — secrets travel encrypted, never touch
GitHub. `node_modules`, `dist`, `projects`, `data`, and `.git` are excluded; the container
rebuilds those.

```bash
# Run on your Mac, from anywhere:
rsync -av -e "ssh -i ~/.ssh/key" \
  --exclude node_modules --exclude .git --exclude projects \
  --exclude data --exclude dist --exclude '*.tsbuildinfo' \
  ~/Documents/mobileCodeEditor/ ubuntu@<BOX_IP>:~/mce/
```

Then, back on the box, clone the project into the `/projects` volume (public repo, no auth
needed to clone):

```bash
cd ~/mce
git clone https://github.com/reynaldos/fitnessTracker.git projects/app
```

---

## Phase 5 — Build and run (on the box)

```bash
cd ~/mce
docker compose up -d --build          # first build is a few minutes on 2 OCPU
curl -s localhost:3000/api/health     # expect agentReady:true, pushReady:true
docker compose logs --tail 20
```

---

## Phase 6 — Expose over Tailscale (on the box)

```bash
sudo tailscale serve --bg https / http://127.0.0.1:3000
tailscale serve status                # shows https://mce.<tailnet>.ts.net -> 3000
```

The app is now at **`https://mce.taile5fddb.ts.net`** from any device on your tailnet.

---

## Phase 7 — Phone

The box is a **new origin** (`mce.…` not `reys-macbook-pro.…`), so the phone treats it as a
fresh install:

1. Open `https://mce.taile5fddb.ts.net` in Safari on your phone.
2. Share → **Add to Home Screen**.
3. Open it from the home screen, tap **🔔 Enable** — a new push subscription registers
   against this origin. (The Mac's old subscription is separate and harmless.)
4. Test: prompt, lock the phone, get the buzz. Now it works with your Mac closed.

---

## Cutover

Once the box is confirmed working, retire the Mac copy so you're not pointing at two:

```bash
# On the Mac:
docker compose down
tailscale serve reset          # drop the Mac's serve config
```

Your phone's home-screen icon now points at the box. Done.

---

## Updating later

Two commands whenever you change the code:

```bash
# Mac: push changes up
rsync -av -e "ssh -i ~/.ssh/key" --exclude node_modules --exclude .git \
  --exclude projects --exclude data --exclude dist \
  ~/Documents/mobileCodeEditor/ ubuntu@<BOX_IP>:~/mce/

# Box: rebuild
cd ~/mce && docker compose up -d --build
```

A cleaner long-term path is pushing `mobileCodeEditor` to a private GitHub repo and
`git pull`ing on the box — worth doing once you're iterating often. rsync is fine to start.

---

## If the phone can't reach it

- `tailscale status` on the box — is `mce` online and are your devices listed?
- Cert error on `tailscale serve`? → HTTPS not enabled in the tailnet admin (Phase 3 note).
- Reaches but blank/500? → `docker compose logs`; check `agentReady`/`pushReady` in health.
- Rare: Oracle's Ubuntu iptables dropping tailnet input. Tailscale usually manages this; if
  not, allow the `tailscale0` interface in the INPUT chain. Ask before hand-editing iptables.
