# Karma Jar 🫙

A small family web app for kids' chores and consequences. Kids tick off chores on a tablet,
parents approve them from their phones, and each kid's jar of coins fills up (or drains) as they
earn money or get fined.

- **Backend:** one Python file (`app.py`, Flask + SQLite)
- **Frontend:** plain JavaScript in `static/`, no build step
- **Data:** `data/karma.db` plus `data/secret.key`, created on first start

On first start the app shows a setup wizard where you create one parent and the kids.
**Only parents have a PIN (4–8 digits).** Kids just tap their own profile. Devices stay logged in
for a year, and "Switch user" goes back to the profile picker.

**Together:** pick two or more kids and choose 🤝 Together.
- A **together chore** only goes to the parent for review once every kid in it has tapped
  "I did it!". Each kid sees whether the others are done yet. Approving it pays every kid the
  reward, and sending it back, marking it missed, editing or deleting it applies to all of them.
  A repeating together chore schedules its next copy for everyone.
- A **together consequence** is a single item for the parent: extending, shortening, ending or
  cancelling it acts on all the kids, and cancelling refunds every kid's fine.

**Live updates:** every screen checks for changes every 3 seconds with a tiny request, and only
reloads when something changed. A chore a parent adds shows up on the kid's tablet within a few
seconds, with no need to tap anything.

---

## 1. Run it on the Proxmox VM with Docker (recommended)

Any small Linux VM works (Debian 12 or Ubuntu 24.04; 1 vCPU, 512 MB RAM and 4 GB disk is plenty).
On a **Proxmox LXC** container, Docker needs `nesting=1` (Options → Features). A VM is simpler.

```bash
# on the VM, as a user in the docker group
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER      # log out and back in after this

# copy the project folder to the VM (git clone, scp, or unzip), then:
cd ~/karma-jar
nano docker-compose.yml            # set TZ to your time zone, e.g. Europe/London
docker compose up -d --build
```

Open `http://<vm-ip>:8080` from a phone on the home Wi-Fi and run the setup wizard.

- Give the VM a **fixed IP** (a DHCP reservation in your router), so the home-screen icons keep working.
- The `TZ` setting only affects the server's log timestamps. All times are stored in UTC, and each
  device shows them in its own local time.
- Update after changing the code: `docker compose up -d --build`
- Logs: `docker compose logs -f`

> **Keep it to one gunicorn worker** (the Dockerfile already does this with `-w 1 --threads 8`).
> The PIN lockout lives in memory, and SQLite prefers a single writer process.

## 2. Alternative: systemd and a virtualenv (no Docker)

**Quick way:** from a checkout on your PC, run

```bash
./deploy/deploy.sh root@192.168.1.110
```

It needs SSH key access to a Debian/Ubuntu VM or LXC container, and you can re-run it for every
update. It installs `python3-venv` and `sqlite3`, creates a `karma` system user, copies the committed
code to `/opt/karma-jar`, and installs `deploy/karma-jar.service`. The database lives in
`/var/lib/karma-jar` and is never touched by redeploys. The script also adds a nightly backup to
`/var/backups/karma-jar` that keeps 30 days (03:15 in the container's time zone, UTC by default).
Extra settings such as `KARMA_SECURE_COOKIES=1` go in `/etc/default/karma-jar`.

Manual steps, if you prefer to do it by hand:

```bash
sudo apt install -y python3 python3-venv
sudo useradd --system --home /opt/karma-jar --shell /usr/sbin/nologin karma
sudo mkdir -p /opt/karma-jar /var/lib/karma-jar
sudo cp -r app.py requirements.txt static /opt/karma-jar/
sudo python3 -m venv /opt/karma-jar/.venv
sudo /opt/karma-jar/.venv/bin/pip install -r /opt/karma-jar/requirements.txt
sudo chown -R karma:karma /var/lib/karma-jar
```

`/etc/systemd/system/karma-jar.service`:

```ini
[Unit]
Description=Karma Jar
After=network-online.target
Wants=network-online.target

[Service]
User=karma
Group=karma
WorkingDirectory=/opt/karma-jar
Environment=KARMA_DATA_DIR=/var/lib/karma-jar
# Environment=KARMA_SECURE_COOKIES=1   # once served over HTTPS
ExecStart=/opt/karma-jar/.venv/bin/gunicorn -w 1 --threads 8 -b 0.0.0.0:8080 app:app
Restart=always
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/karma-jar
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now karma-jar
journalctl -u karma-jar -f
```

## 3. HTTPS (for a proper installable app)

Plain `http://192.168.x.x:8080` works, but the browser treats it as an ordinary website:

| | Plain HTTP on the LAN | HTTPS |
|---|---|---|
| iPhone / iPad "Add to Home Screen", full-screen app | ✅ | ✅ |
| Offline app shell (service worker) | ❌ | ✅ |
| Android Chrome "Install app" (real app, no browser bar) | ❌ (shortcut only) | ✅ |

Choose **one** of the options below. Afterwards, set `KARMA_SECURE_COOKIES=1` (in
`docker-compose.yml` or the systemd unit) and restart. That makes the login cookie HTTPS-only.

### Option A: Caddy with its own local CA (no domain needed)

Run Caddy on the same VM in front of the app. It issues certificates from its own private CA.

`Caddyfile`:

```
karma.home.arpa, 192.168.1.50 {
    tls internal
    reverse_proxy 127.0.0.1:8080
}
```

(Use your own VM IP. If you use a name, add it to your router's or Pi-hole's local DNS.)
Change the compose `ports:` to `"127.0.0.1:8080:8080"` so only Caddy can reach the app.

Each device must then **trust Caddy's root certificate** once. The file is at
`/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt` (Caddy as a service) or
`/data/caddy/pki/authorities/local/root.crt` (Caddy in Docker).

- **iPhone/iPad:** AirDrop or email the `root.crt` to the device, then go to Settings → *Profile Downloaded* → Install.
  Then go to Settings → General → About → **Certificate Trust Settings** and switch it on.
- **Android:** Settings → Security → *Encryption & credentials* → Install a certificate → **CA certificate**.

### Option B: a real domain with an existing reverse proxy (Nginx Proxy Manager or Traefik)

If you already run NPM or Traefik and own a domain, add a proxy host such as
`karma.yourdomain.com` that points to `http://<vm-ip>:8080`. Get a Let's Encrypt certificate with a
**DNS challenge** (Cloudflare, etc.), so nothing has to be opened to the internet. Point the name at
the proxy's LAN IP in local DNS. With a public certificate, devices need no extra setup.

### Option C: Tailscale

Install Tailscale on the VM and on each device, then run `tailscale serve --bg 8080` on the VM.
The app is then at `https://<vm-name>.<tailnet>.ts.net` with a valid certificate, and also works
away from home. Every phone and tablet needs the Tailscale app logged in to your tailnet.

## 4. Install it on the devices

Open the app's address in the browser first, then:

- **iPad / iPhone (Safari):** Share button → **Add to Home Screen** → Add. It opens full-screen
  with the jar icon. Use Safari, because other iOS browsers may not offer this.
- **Android (Chrome):** ⋮ menu → **Install app** (over HTTPS) or **Add to Home screen** (over HTTP).
- **Kids' tablet tip:** log in as the kid once, and the tablet stays logged in. On iPad, Guided Access
  (Settings → Accessibility) can lock the tablet to Karma Jar.

## 5. Backups

All data is in one SQLite file. The app runs SQLite in WAL mode, so copy it with SQLite's own
backup command (safe while the app is running) instead of copying the file directly:

```bash
sudo apt install -y sqlite3
sqlite3 ~/karma-jar/data/karma.db ".backup '/backups/karma-$(date +%F).db'"
```

A nightly cron job (`crontab -e`) that keeps 30 days:

```
15 3 * * * sqlite3 /home/USER/karma-jar/data/karma.db ".backup '/backups/karma-$(date +\%F).db'" && find /backups -name 'karma-*.db' -mtime +30 -delete
```

Also keep a copy of `data/secret.key`. Without it, everyone just has to log in again; no data is lost.
Proxmox VM backups (vzdump / PBS) of the whole VM work too.

**Restore:** stop the app, copy the backup over `data/karma.db`, delete any `karma.db-wal`/`karma.db-shm`
next to it, and start the app again.

## 6. Reset

To start over completely: stop the app, delete the data folder, and start it again. The setup
wizard then comes back.

```bash
docker compose down && rm -rf data && docker compose up -d
```

(With systemd: `systemctl stop karma-jar`, then `rm -rf /var/lib/karma-jar/*`, then start it again.)
If a parent forgets their PIN, another parent can set a new one under Settings.

## 7. API: Home Assistant and AI agents

Home Assistant automations and agents such as Claude Code or Duet can add chores through a small
JSON API.

**Get a token:** Settings → **API tokens** → **+ New token**. Give each caller its own token
(e.g. "Home Assistant", "Claude Code"). The token is shown **once**, so copy it right away. Chores
it creates show that name to kids and parents (🏠 for Home Assistant, 🤖 for anything else). Revoke
a token from the same list at any time.

A token can **only** read kids and open chores, create chores, and delete a still-open chore that
it created itself. It can't touch money, consequences, approvals or users. Send it as
`Authorization: Bearer kj_...` (or `X-Api-Key: kj_...`). The app is only reachable on your home
network, so callers have to be at home (or on Tailscale, see section 3).

| Call | What it does |
|---|---|
| `GET /api/ext` | Short self-description of the API (handy for agents) |
| `GET /api/ext/kids` | Kids with jar balance, open chores and active consequences |
| `GET /api/ext/chores` | Open chores; optional `?key=...` or `?kid=Ana` |
| `POST /api/ext/chores` | Create a chore (body below) |
| `DELETE /api/ext/chores/<id>` | Delete a chore this token created, while it's still to do |

`POST /api/ext/chores` body (JSON). Only `title` is required.

```json
{
  "title": "Refill the robot vacuum's clean water tank",
  "kids": "Ana",
  "reward": 0.5,
  "due_in_minutes": 120,
  "notes": "The tank is the one on the dock",
  "together": false,
  "key": "vacuum-clean-water"
}
```

- `kids`: a name (any case), a list like `["Ana", "Ben"]`, `"Ana,Ben"`, or `"all"` (the default).
  `together: true` makes it one shared chore that only counts once every kid has done it.
- `due_in_minutes` sets a deadline from now. `due_at` takes an exact ISO 8601 time instead.
- **`key` prevents duplicates.** While a chore with the same key is still open (to do, waiting
  for a check, or sent back), the call creates nothing and returns the existing chore with
  `"created": false`. After a parent approves it or marks it missed, the next call creates a new one.
  That makes it safe for an automation to fire again and again.

Quick test from any machine at home:

```bash
curl -s -X POST http://192.168.1.110:8080/api/ext/chores \
  -H "Authorization: Bearer kj_YOUR_TOKEN" -H "Content-Type: application/json" \
  -d '{"title": "Feed the cat", "kids": "Ben", "reward": 0.5, "due_in_minutes": 60}'
```

### Home Assistant: robot vacuum water tanks

`configuration.yaml`:

```yaml
rest_command:
  karma_jar_chore:
    url: "http://192.168.1.110:8080/api/ext/chores"
    method: post
    headers:
      Authorization: !secret karma_jar_auth
    content_type: "application/json"
    payload: >-
      {"title": {{ title | tojson }},
       "kids": {{ kids | default('all') | tojson }},
       "reward": {{ reward | default(0) }},
       "due_in_minutes": {{ due_in_minutes | default(120) }},
       "together": {{ together | default(false) | tojson }},
       "key": {{ key | default('') | tojson }}}
```

`secrets.yaml`:

```yaml
karma_jar_auth: "Bearer kj_YOUR_TOKEN"
```

Automations (Settings → Automations → ⋮ → Edit in YAML). Replace the entity IDs with your
vacuum's: find them under Developer tools → States by searching for "water". Each integration
names them differently, for example `..._water_shortage`, `..._water_box`, `..._dirty_water_box`
or `..._mop_drying`.

```yaml
- alias: "Karma Jar: vacuum clean water tank empty"
  triggers:
    - trigger: state
      entity_id: binary_sensor.robot_vacuum_water_shortage
      to: "on"
      for: "00:05:00"
  actions:
    - action: rest_command.karma_jar_chore
      data:
        title: "Refill the robot vacuum's clean water tank"
        kids: "Ana"
        reward: 0.5
        due_in_minutes: 120
        key: vacuum-clean-water

- alias: "Karma Jar: vacuum dirty water tank full"
  triggers:
    - trigger: state
      entity_id: binary_sensor.robot_vacuum_dirty_water_box_full
      to: "on"
      for: "00:05:00"
  actions:
    - action: rest_command.karma_jar_chore
      data:
        title: "Empty and rinse the robot vacuum's dirty water tank"
        kids: "Ben"
        reward: 0.5
        due_in_minutes: 120
        key: vacuum-dirty-water
```

Optional: a sensor showing how many chores are open, for a dashboard card.

```yaml
rest:
  - resource: "http://192.168.1.110:8080/api/ext/chores"
    headers:
      Authorization: !secret karma_jar_auth
    scan_interval: 300
    sensor:
      - name: "Karma Jar open chores"
        value_template: "{{ value_json.count }}"
```

### AI agents (Claude Code, Duet, ...)

Create a token named after the agent and give it to the agent as environment variables, for
example `KARMA_JAR_URL=http://192.168.1.110:8080` and `KARMA_JAR_TOKEN=kj_...`. Then add this to the
agent's instructions (for Claude Code, a `CLAUDE.md` or a skill):

> To give the kids a chore in Karma Jar, call the API at `$KARMA_JAR_URL` with header
> `Authorization: Bearer $KARMA_JAR_TOKEN`. Run `GET /api/ext` first to see the endpoints, and
> `GET /api/ext/kids` for the kids' names. Create chores with `POST /api/ext/chores`
> (`title`, `kids`, optional `reward` in dollars, `due_in_minutes`, `notes`, `together`). Use a
> `key` when the same request might be repeated, and use `DELETE /api/ext/chores/<id>` to undo a
> mistake. Keep titles short and kid-friendly. Parents approve the chores and handle money; the API
> can't.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `KARMA_DATA_DIR` | `./data` (`/data` in Docker) | where `karma.db` and `secret.key` live |
| `KARMA_SECURE_COOKIES` | `0` | set to `1` when served over HTTPS |
| `KARMA_SECRET_KEY` | generated in `secret.key` | override the session signing key |
| `PORT` | `8080` | port for `python app.py` (dev only) |

## Development

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt   # Windows: .venv\Scripts\
python app.py                       # http://localhost:8080
python -m unittest -v test_app      # API flow and edge-case tests (uses a temp data dir)
```

Money is stored as signed integer cents in a single `ledger` table, and a balance is the sum of its
entries. A balance can go negative (the jar is "in the red"), or go over the jar size (the jar shows
as full with sparkles).
