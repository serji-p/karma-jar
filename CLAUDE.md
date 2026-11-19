# karma-jar

## Learned User Preferences

- Keep the design decisions as they are: one Python file (`app.py`, Flask + SQLite), a plain-JS frontend in `static/` with no framework and no build step, SQLite storage, and a single gunicorn worker. Ask the user before adding anything big.
- Product decisions made by the user: only parents have PINs (kids just tap their profile), chores and consequences can be "together" (a together chore completes only when both kids mark it done, and a parent can assign a consequence to both), and the kids' view refreshes live (polling about every 3 seconds) with no manual action.
- Feature work goes on a branch with a PR. Merge and deploy only after the user explicitly approves that specific PR; approval for one PR does not carry over to the next.

## Learned Workspace Facts

- The repo is private on GitHub at `serji-p/karma-jar` (remote `origin`).
- The app is deployed to a Proxmox LXC at `root@192.168.1.110` (Ubuntu, 512 MB RAM, no Docker) as the systemd service `karma-jar`. It runs gunicorn from a venv in `/opt/karma-jar`, with data in `/var/lib/karma-jar`, which redeploys never touch. Deploy with `./deploy/deploy.sh root@192.168.1.110` from Git Bash on the Windows PC. The script ships the committed HEAD of the current branch via `git archive`, so commit, merge to `main` and switch to `main` before deploying. A nightly sqlite backup goes to `/var/backups/karma-jar` and is kept 30 days.
- A token-protected external API under `/api/ext` (self-describing `GET /api/ext`) lets Home Assistant and AI agents create chores. Parents create named tokens in Settings; each is shown once and stored as a sha256 hash. Tokens can only list kids and open chores, create chores, and delete open chores they created; a `key` field dedupes repeated calls. README section 7 documents the Home Assistant and agent setup.
- Local dev uses the uv-created `.venv` (`uv venv --python 3.12`), because system Python is not available. Run tests with `python -m unittest test_app` from that venv.
- UI checks use Playwright with `channel: "chrome"`, because the bundled Playwright browsers don't match the installed library version.
- In node patch scripts, use a replacer function (`s.replace(a, () => b)`). A plain replacement string turns `$$` into `$`, which once silently broke the frontend's `$$(...)` calls.
- Don't kill Python processes broadly, since other Python agents run on this PC. Stop only your own dev servers, by task or PID.
