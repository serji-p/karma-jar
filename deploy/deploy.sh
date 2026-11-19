#!/usr/bin/env bash
# Deploy the committed HEAD to a Debian/Ubuntu host (VM or LXC) as a systemd service.
#   ./deploy/deploy.sh root@192.168.1.110
# Safe to re-run: it updates the code, keeps /var/lib/karma-jar (the database) untouched.
set -euo pipefail
HOST="${1:?usage: deploy.sh user@host}"
cd "$(dirname "$0")/.."

git archive --format=tar HEAD app.py requirements.txt static deploy/karma-jar.service |
  ssh "$HOST" 'rm -rf /tmp/karma-deploy && mkdir -p /tmp/karma-deploy && tar -x -C /tmp/karma-deploy'
ssh "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v sqlite3 >/dev/null || ! python3 -c 'import ensurepip' 2>/dev/null; then
  apt-get update -qq && apt-get install -y -qq python3-venv sqlite3 >/dev/null
fi
id karma >/dev/null 2>&1 || useradd --system --home /opt/karma-jar --shell /usr/sbin/nologin karma
mkdir -p /opt/karma-jar /var/lib/karma-jar /var/backups/karma-jar
chown karma:karma /var/lib/karma-jar
chmod 700 /var/lib/karma-jar

tmp=/tmp/karma-deploy
rm -rf /opt/karma-jar/static
cp -r "$tmp/app.py" "$tmp/requirements.txt" "$tmp/static" /opt/karma-jar/
install -m 644 "$tmp/deploy/karma-jar.service" /etc/systemd/system/karma-jar.service
rm -rf "$tmp"

[ -x /opt/karma-jar/.venv/bin/python ] || python3 -m venv /opt/karma-jar/.venv
/opt/karma-jar/.venv/bin/pip install -q --disable-pip-version-check -r /opt/karma-jar/requirements.txt

# nightly backup at 03:15, keep 30 days (sqlite .backup is safe while the app runs)
cat > /etc/cron.d/karma-jar-backup <<'CRON'
15 3 * * * root sqlite3 /var/lib/karma-jar/karma.db ".backup '/var/backups/karma-jar/karma-$(date +\%F).db'" && find /var/backups/karma-jar -name 'karma-*.db' -mtime +30 -delete
CRON

systemctl daemon-reload
systemctl enable -q karma-jar
systemctl restart karma-jar
sleep 2
systemctl is-active karma-jar
python3 -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8080/api/state').read().decode())"
REMOTE
