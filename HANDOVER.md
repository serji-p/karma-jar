# Karma Jar — handover for Claude Code

You are taking over a small, partly built family web app called **Karma Jar**. The code in this folder is a first draft: it has been written and passes syntax checks, but it has **never been run or tested**. Your job is to get it working end to end, fix bugs, polish it, and make it ready to deploy.

## What the app is
It's a local web app where kids track home chores and parents hand out consequences. The "jar" is the main metaphor: an SVG jar of gold coins that fills up as a kid earns money and drains when money is taken away.

- **Users:** parents (1 or more) and kids (currently 2). Each has a name, a color and a 4–8 digit PIN. The login screen is a "Who's here?" profile picker followed by a PIN pad. Sessions last a long time (365 days) so devices stay logged in.
- **Kid view** (used on a tablet; large touch targets, playful look):
  - a big jar showing the current balance, a jar-size/goal progress bar and an optional "Saving for" label
  - a chore list with an "I did it!" button and an optional note to parents
  - a "Waiting for a check" state with an undo option
  - chores that were sent back show the parent's reason, and the kid can resubmit
  - active consequences with a live countdown timer
  - jar history (ledger)
  - a coin-rain / "+$X" animation when the balance goes up since the kid last viewed it
- **Parent view** (used on a phone; bottom tab bar: Home, Chores, Consequences, Jars, Settings):
  - Create chores: title, one or more kids, reward in $, deadline (date and time, with quick picks), repeat (none/daily/weekly), notes. Edit, duplicate, delete, mark as missed.
  - Approve a chore (adds the reward to the jar; a repeating chore schedules its next copy) or send it back with a reason.
  - Create consequences: one or more kids, title (quick picks such as "No tablet"), a reason, an optional timer (1h, 3h, 1 day, 3 days, 1 week, custom) and/or a fine taken from the jar. Parents can extend or shorten the timer, end it early, or cancel it (cancelling refunds the fine).
  - Jars: per-kid balance, earned / paid out / fines totals, "Mark as paid" (records a payout, which reduces the jar), bonus or adjustment, ledger with undo for payouts and bonuses.
  - Settings: add or edit kids (name, color, PIN, jar size, goal) and parents, log out.
- **Money model:** a single `ledger` table (amounts in cents, signed). Balance = sum of ledger entries. Entry kinds: chore, fine, refund, payout, bonus, adjust. The balance can go negative, and the jar then shows as "in the red".

## Stack and files
- `app.py`: Flask + SQLite (stdlib `sqlite3`) JSON API, which also serves `static/`. Data lives in `$KARMA_DATA_DIR` (default `./data`): `karma.db` and an auto-generated `secret.key`. PINs are hashed with werkzeug, and there is an in-memory lockout after 5 wrong PINs.
- `static/index.html`, `static/styles.css`, `static/app.js`: a single-page app in vanilla JS with no build step. `jarSVG()` draws the animated jar.
- `static/manifest.webmanifest`, `static/sw.js` (network-first, never caches `/api`), and `static/icons/*` (SVG plus PNGs generated with rsvg-convert): for installing as a PWA.
- `Dockerfile` and `docker-compose.yml`: gunicorn with 1 worker and threads. Keep it to **one worker**, because the PIN lockout is in-memory and the app uses SQLite.
- API overview: `/api/state`, `/api/setup` (first-run wizard), `/api/profiles`, `/api/login`, `/api/logout`, `/api/data` (returns data shaped for the logged-in role), `/api/chores[/<id>/submit|undo|approve|deny|missed]`, `/api/punishments[/<id>/end|extend]`, `DELETE /api/punishments/<id>` (cancel with refund), `/api/payouts`, `/api/adjust`, `DELETE /api/ledger/<id>`, `/api/users`.

## Deployment target
The app runs on a **Proxmox (PVE) VM** on the home LAN. Kids use it on a tablet and parents use it on their phones, over home Wi-Fi. It should be installable on device home screens as a persistent web app.
- Note: service workers and the full "Install app" prompt on Android Chrome need **HTTPS** (or localhost). iOS "Add to Home Screen" works over plain HTTP. Document an HTTPS option for the README: for example a Caddy reverse proxy with `tls internal` (the Caddy CA must then be trusted on each device), an existing Nginx Proxy Manager or Traefik with a real domain and a DNS challenge, or Tailscale. When served over HTTPS, set `KARMA_SECURE_COOKIES=1`.
- Also provide a non-Docker option: a systemd unit plus a venv.

## What to do
1. Run it locally (`pip install flask` then `python app.py`, port 8080). Go through the whole flow: setup wizard → log in as a parent → create chores and consequences → log in as a kid → submit a chore → approve it as the parent → check the balance and jar → mark as paid → let a timer expire → cancel a consequence and confirm the refund. Fix any bugs you find.
2. Check it visually at phone size (about 390px wide) and tablet size (about 1024px wide, landscape and portrait), for example with Playwright screenshots. Polish the layout, and make sure the jar's fill animation and coin clipping look right.
3. Check edge cases: a negative balance, a jar overflowing past full, deadlines and time zones (the server stores UTC and the browser shows local time), repeating chores, deleting an approved chore (its reward should be taken back), and PIN lockout.
4. Write `README.md` covering: Docker setup on the PVE VM, the systemd alternative, HTTPS options, how to install on iPad/iPhone/Android, backups (copy `data/karma.db`), and how to reset (delete the data folder).
5. Optional nice-to-haves (ask the user before adding anything big): a parent notification when a kid submits a chore (for example ntfy), a weekly summary, and an option to automatically fine a kid for a missed deadline.

Keep it simple: one Python file, plain JS with no build step, SQLite. These are deliberate choices.
