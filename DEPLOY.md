# Deploy — Centher voice server on Oracle Cloud Always Free ($0)

The voice server is a long-running Node.js process (socket.io + mediasoup).
Vercel serverless can't host it (no persistent sockets, no UDP media ports),
so it runs on an **Oracle Cloud Always Free VM** (4 ARM cores, 24 GB RAM,
real public IPv4 — genuinely $0), behind Caddy for automatic HTTPS.
This follows the proven Viva voice-service pattern.

**Do the steps in order.** Steps you do are marked 👉. Everything is
copy-paste. About 30 minutes, most of it waiting.

## Step 0 — What goes where

| Piece | Host | Why |
|---|---|---|
| Web app | Vercel (already live) | Next.js |
| Voice server (this repo) | Oracle Always Free VM ($0) | Persistent sockets + WebRTC UDP need a real server |
| Postgres | Neon (already live) | Voice server does read-only session lookups |

The browser page is HTTPS, so the voice server gets HTTPS too via Caddy.
You need a domain pointing at the VM — either one you own, or the free
`sslip.io` trick in Step 4 (no purchase needed).

## Step 1 — Oracle Cloud account 👉

1. Go to https://www.oracle.com/cloud/free/ → "Start for free".
2. Sign up (email + phone + credit card — verification only, Always Free
   resources aren't charged). Verification can take minutes to hours.

## Step 2 — Create the VM 👉

1. Log in at https://cloud.oracle.com → ☰ menu → **Compute → Instances** →
   **Create instance**.
2. Name: `centher-voice`. Keep your compartment.
3. **Image:** "Change image" → **Ubuntu** → **24.04 Minimal (aarch64)**.
4. **Shape:** "Change shape" → Instance type **Ampere** (ARM) →
   **VM.Standard.A1.Flex** → **4 OCPUs**, **24 GB RAM** (the Always Free
   limit — this whole VM is $0).
5. **Networking:** default VCN → **Assign a public IPv4 address: Yes**.
6. **Add SSH keys:** "Paste public key" → paste your `~/.ssh/id_ed25519.pub`
   (on your laptop: `cat ~/.ssh/id_ed25519.pub`; if none: `ssh-keygen -t ed25519`).
7. Boot volume: default (50 GB, inside the free 200 GB).
8. **Create.** Wait for Running, then **copy the Public IP**.

## Step 3 — Open the firewall (Oracle side) 👉

Instance page → **Virtual cloud network** → **Security lists** → default
security list → **Add ingress rules**:

| # | Source | Protocol | Port(s) | Purpose |
|---|---|---|---|---|
| 1 | `0.0.0.0/0` | TCP | 80 | Let's Encrypt + HTTP→HTTPS redirect |
| 2 | `0.0.0.0/0` | TCP | 443 | HTTPS (WSS to the voice server) |
| 3 | `0.0.0.0/0` | UDP | 40000–49999 | mediasoup audio/video media |

(SSH port 22 is already there — leave it.)

## Step 4 — Point a domain at the VM 👉

- **Option A — your own domain (recommended):** DNS **A record**, e.g.
  `voice` → `<VM public IP>`. Voice server lives at
  `https://voice.yourdomain.com`.
- **Option B — no domain (free trick):** IP `129.146.12.34` →
  `129-146-12-34.sslip.io` (resolves back to your IP, nothing to register).
  Let's Encrypt rate limits are shared across sslip.io users — issuance can
  rarely fail on a busy week; retry later or switch to Option A.

Note the full domain name — you need it below.

## Step 5 — SSH in, open the OS firewall, install Docker 👉

```bash
ssh -i ~/.ssh/id_ed25519 ubuntu@<VM_PUBLIC_IP>
```

On the VM, one block at a time:

```bash
# 1. OS firewall: Oracle's Ubuntu image blocks inbound by default
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT -p udp --dport 40000:49999 -j ACCEPT
sudo apt-get update && sudo apt-get install -y iptables-persistent
# (answer Yes if it asks to save the rules)

# 2. Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu
exit
```

Log back in so the docker group applies, then `docker --version` should
print a version without "permission denied".

## Step 6 — Build and run the voice server 👉

On the VM:

```bash
git clone https://github.com/irfansaeedkhan/centher-voice-server.git
cd centher-voice-server
docker compose build
# (takes several minutes the first time — mediasoup compiles its native
#  worker, that's normal)
```

Create the secrets file (paste your real values — never commit this file):

```bash
cat > ~/.centher-voice.env << 'EOF'
PORT=3001
ALLOWED_ORIGINS=https://centher-app.vercel.app,http://localhost:3000
DATABASE_URL=postgresql://user:password@ep-xxx.neon.tech/dbname?sslmode=require
MEDIASOUP_ANNOUNCED_IP=<VM_PUBLIC_IP>
MEDIASOUP_RTC_MIN_PORT=40000
MEDIASOUP_RTC_MAX_PORT=49999
EOF
chmod 600 ~/.centher-voice.env
```

Notes:
- `DATABASE_URL` must be the **non-pooled** Neon string (it says `-pooler`
  in the pooled one — don't use that). Same database the web app uses;
  the server only runs `SELECT` on the `session` table.
- `MEDIASOUP_ANNOUNCED_IP` is the VM's **public IPv4** — browsers need it
  in the ICE candidates to reach the UDP media ports.
- `ALLOWED_ORIGINS` must include your web app's exact origin, no trailing
  slash.

Run it:

```bash
docker compose up -d
```

`network_mode: host` is deliberate (see `docker-compose.yml`): mediasoup
picks UDP ports at runtime, and host networking lets them through directly.

Check it's up:

```bash
docker logs centher-voice --tail 20
# expect: "[mediasoup] 4 workers ready" and "[voice] listening on :3001"
curl -s http://localhost:3001/health
# expect: {"status":"ok","rooms":0,"uptime":...}
```

## Step 7 — HTTPS with Caddy 👉

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Put your domain from Step 4 in the Caddyfile:

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null << 'EOF'
<YOUR-DOMAIN> {
    reverse_proxy 127.0.0.1:3001
}
EOF
sudo systemctl reload caddy
```

Caddy fetches a free Let's Encrypt certificate automatically — give it a
minute, then `curl -s https://<YOUR-DOMAIN>/health` should return the JSON
above. (WebSocket upgrades are proxied transparently; no extra config.)

## Step 8 — Point the web app at it 👉

1. https://vercel.com → `centher-app` → **Settings → Environment Variables**.
2. Add **`NEXT_PUBLIC_GQL_URL_WEBSOCKET`** = `wss://<YOUR-DOMAIN>`
   (no trailing slash, no path).
3. **Redeploy** (Variables → redeploy, or push any commit) so the new
   `NEXT_PUBLIC_` value bakes into the client bundle.

## Step 9 — Test it 👉

1. Open https://centher-app.vercel.app → demo login → VoiSpace →
   **create a room**. It should connect (no more "Could not connect"
   error).
2. From a second browser/incognito window (or your phone), join the room.
   Talk — you should hear each other. That's the mediasoup SFU working.
3. If it connects but there's **no audio/video**: on the VM, check
   `docker logs centher-voice --tail 40` for ICE warnings and confirm the
   UDP firewall rules (Steps 3 + 5). The #1 cause is
   `MEDIASOUP_ANNOUNCED_IP` not being the VM's public IP.

## Troubleshooting

- `docker logs centher-voice --tail 50` — start here always.
- `docker compose restart` — picks up `.env` changes (edit the file first).
- `sudo journalctl -u caddy --no-pager | tail -20` — HTTPS/certificate issues.
- "origin not allowed" in the browser console → `ALLOWED_ORIGINS` doesn't
  match your Vercel URL exactly (no trailing slash).
- `unauthorized: invalid or expired session` → `DATABASE_URL` wrong DB or
  the user isn't logged in on the web app.
- Container keeps restarting → `docker logs centher-voice` shows why
  (usually a missing env var — the boot check names it).
- Rooms stuck after a crash → restart clears them (rooms are in-memory by
  design; the web app re-creates them).

## Updating

```bash
cd ~/centher-voice-server
git pull
docker compose up -d --build
```
