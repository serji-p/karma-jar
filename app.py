"""Karma Jar - a tiny family chores & consequences app.

Single-file Flask backend with SQLite storage. Serves the static SPA from ./static.
"""
import os
import sqlite3
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import Flask, g, jsonify, request, session, send_from_directory, abort
from werkzeug.exceptions import HTTPException
from werkzeug.security import generate_password_hash, check_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("KARMA_DATA_DIR", os.path.join(BASE_DIR, "data"))
DB_PATH = os.path.join(DATA_DIR, "karma.db")
os.makedirs(DATA_DIR, exist_ok=True)


def _secret_key():
    env = os.environ.get("KARMA_SECRET_KEY")
    if env:
        return env
    path = os.path.join(DATA_DIR, "secret.key")
    if not os.path.exists(path):
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
    with open(path) as f:
        return f.read().strip()


app = Flask(__name__, static_folder=None)
app.config.update(
    SECRET_KEY=_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("KARMA_SECURE_COOKIES", "0") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=365),
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('parent','kid')),
    pin_hash TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#7C5CFF',
    jar_size_cents INTEGER NOT NULL DEFAULT 2000,
    goal_label TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chores (
    id INTEGER PRIMARY KEY,
    kid_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    value_cents INTEGER NOT NULL DEFAULT 0,
    due_at TEXT,
    repeat TEXT NOT NULL DEFAULT 'none',
    status TEXT NOT NULL DEFAULT 'todo',  -- todo | submitted | approved | denied | missed
    kid_note TEXT NOT NULL DEFAULT '',
    parent_note TEXT NOT NULL DEFAULT '',
    created_by INTEGER,
    created_at TEXT NOT NULL,
    submitted_at TEXT,
    decided_at TEXT,
    decided_by INTEGER,
    group_id INTEGER  -- "together" chores: one row per kid, same group_id
);
CREATE TABLE IF NOT EXISTS punishments (
    id INTEGER PRIMARY KEY,
    kid_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    fine_cents INTEGER NOT NULL DEFAULT 0,
    duration_minutes INTEGER NOT NULL DEFAULT 0,
    starts_at TEXT NOT NULL,
    ends_at TEXT,
    status TEXT NOT NULL DEFAULT 'active',  -- active | ended | cancelled
    created_by INTEGER,
    created_at TEXT NOT NULL,
    group_id INTEGER  -- "together" consequences: one row per kid, same group_id
);
CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY,
    kid_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount_cents INTEGER NOT NULL,
    kind TEXT NOT NULL,  -- chore | fine | refund | payout | bonus | adjust
    ref_id INTEGER,
    note TEXT NOT NULL DEFAULT '',
    created_by INTEGER,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chores_kid ON chores(kid_id, status);
CREATE INDEX IF NOT EXISTS idx_ledger_kid ON ledger(kid_id);
CREATE INDEX IF NOT EXISTS idx_pun_kid ON punishments(kid_id, status);
"""

REPEATS = {"none": None, "daily": timedelta(days=1), "weekly": timedelta(days=7)}
COLORS = ["#FF6B9A", "#4DA3FF", "#33C48D", "#FF9F43", "#9B6BFF", "#FF5E5E"]


# ---------------------------------------------------------------- helpers
def now():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if dt else None


def parse_dt(s):
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        abort(400, "Bad date")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def db():
    if "db" not in g:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        g.db = conn
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    for table in ("chores", "punishments"):  # migrate databases created before "together" existed
        if "group_id" not in [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN group_id INTEGER")
        conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{table}_group ON {table}(group_id)")
    conn.commit()
    conn.close()


def rows(sql, args=()):
    return [dict(r) for r in db().execute(sql, args).fetchall()]


def one(sql, args=()):
    r = db().execute(sql, args).fetchone()
    return dict(r) if r else None


def body():
    return request.get_json(silent=True) or {}


def cents(value, allow_negative=False):
    try:
        c = int(round(float(value or 0) * 100))
    except (TypeError, ValueError):
        abort(400, "Bad amount")
    if c < 0 and not allow_negative:
        abort(400, "Amount must be positive")
    if abs(c) > 100_000_00:
        abort(400, "Amount too large")
    return c


def clean(s, maxlen=200):
    return str(s or "").strip()[:maxlen]


def valid_pin(pin):
    pin = str(pin or "")
    if not (pin.isdigit() and 4 <= len(pin) <= 8):
        abort(400, "PIN must be 4-8 digits")
    return pin


def public_user(u):
    return {k: u[k] for k in ("id", "name", "role", "color", "jar_size_cents", "goal_label")}


def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    return one("SELECT * FROM users WHERE id = ?", (uid,))


def require(role=None):
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            u = current_user()
            if not u:
                abort(401)
            if role and u["role"] != role:
                abort(403)
            g.user = u
            return fn(*a, **kw)
        return wrapper
    return deco


def ledger_add(kid_id, amount, kind, note="", ref_id=None):
    db().execute(
        "INSERT INTO ledger (kid_id, amount_cents, kind, ref_id, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)",
        (kid_id, amount, kind, ref_id, note, g.user["id"] if "user" in g else None, iso(now())),
    )


def get_kid(kid_id):
    kid = one("SELECT * FROM users WHERE id = ? AND role = 'kid'", (kid_id,))
    if not kid:
        abort(404, "Kid not found")
    return kid


def expire_punishments():
    db().execute(
        "UPDATE punishments SET status='ended' WHERE status='active' AND ends_at IS NOT NULL AND ends_at <= ?",
        (iso(now()),),
    )
    db().commit()


def kid_summary(kid):
    k = public_user(kid)
    s = one(
        """SELECT COALESCE(SUM(amount_cents),0) AS balance,
                  COALESCE(SUM(CASE WHEN kind='chore' THEN amount_cents ELSE 0 END),0) AS earned,
                  COALESCE(SUM(CASE WHEN kind='payout' THEN -amount_cents ELSE 0 END),0) AS paid,
                  COALESCE(SUM(CASE WHEN kind IN ('fine','refund') THEN -amount_cents ELSE 0 END),0) AS fined
           FROM ledger WHERE kid_id = ?""",
        (kid["id"],),
    )
    k.update(balance_cents=s["balance"], earned_cents=s["earned"], paid_cents=s["paid"], fined_cents=s["fined"])
    return k


# lightweight brute-force protection for PINs (per user, in memory - hence ONE gunicorn worker).
# Every attempt is counted *before* the slow hash check, under a lock, so parallel requests
# can't slip past the limit. A correct PIN clears the counter.
_fails = {}
_fails_lock = threading.Lock()


def claim_attempt(uid):
    with _fails_lock:
        f = _fails.setdefault(uid, {"count": 0, "until": 0})
        if f["until"] > time.time():
            abort(429, f"Too many tries. Wait {int(f['until'] - time.time()) + 1}s")
        f["count"] += 1
        if f["count"] >= 5:
            f["until"] = time.time() + 30 * (2 ** min(f["count"] - 5, 5))


# Change counter for cheap live refresh: every successful write bumps it, clients poll /api/rev
# every few seconds and only reload data when it changed. In memory is fine with ONE worker; a
# restart starts from a new value, which simply makes every client reload once.
_rev = {"n": int(time.time())}
_rev_lock = threading.Lock()


@app.after_request
def bump_rev(resp):
    if (request.method in ("POST", "PUT", "DELETE") and request.path.startswith("/api/")
            and request.path not in ("/api/login", "/api/logout") and resp.status_code < 400):
        with _rev_lock:
            _rev["n"] += 1
    return resp


@app.get("/api/rev")
def rev():
    resp = jsonify(rev=_rev["n"])
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.errorhandler(HTTPException)
def json_error(e):
    if request.path.startswith("/api/"):
        return jsonify(error=e.description or e.name), e.code
    return e


@app.errorhandler(Exception)
def json_crash(e):
    app.logger.exception("Unhandled error")
    if request.path.startswith("/api/"):
        return jsonify(error="Something went wrong"), 500
    return "Internal error", 500


def to_int(v, what="id"):
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        abort(400, f"Bad {what}")


def id_list(v):
    if not isinstance(v, list):
        abort(400, "Pick at least one kid")
    return list(dict.fromkeys(to_int(x) for x in v))


# ---------------------------------------------------------------- auth / setup
@app.get("/api/state")
def state():
    setup_needed = one("SELECT COUNT(*) AS n FROM users WHERE role='parent'")["n"] == 0
    u = current_user()
    return jsonify(setup_needed=setup_needed, me=public_user(u) if u else None)


@app.post("/api/setup")
def setup():
    if one("SELECT COUNT(*) AS n FROM users WHERE role='parent'")["n"] > 0:
        abort(403, "Already set up")
    b = body()
    parent = b.get("parent") or {}
    kids = b.get("kids") or []
    pname = clean(parent.get("name"), 40) or "Parent"
    pin = valid_pin(parent.get("pin"))
    t = iso(now())
    cur = db().execute(
        "INSERT INTO users (name, role, pin_hash, color, created_at) VALUES (?,?,?,?,?)",
        (pname, "parent", generate_password_hash(pin), "#5B4BDB", t),
    )
    for i, k in enumerate(kids[:8]):
        name = clean(k.get("name"), 40)
        if not name:
            continue
        db().execute(
            "INSERT INTO users (name, role, pin_hash, color, created_at) VALUES (?,?,?,?,?)",
            (name, "kid", "", clean(k.get("color"), 9) or COLORS[i % len(COLORS)], t),  # kids have no PIN
        )
    db().commit()
    session.permanent = True
    session["uid"] = cur.lastrowid
    return jsonify(ok=True)


@app.get("/api/profiles")
def profiles():
    return jsonify(rows("SELECT id, name, role, color FROM users ORDER BY role DESC, id"))


@app.post("/api/login")
def login():
    b = body()
    uid = to_int(b.get("user_id"))
    u = one("SELECT * FROM users WHERE id = ?", (uid,))
    if not (u and u["role"] == "kid"):  # kids just tap their profile; only parents need a PIN
        claim_attempt(uid)
        if not u or not check_password_hash(u["pin_hash"], str(b.get("pin") or "")):
            abort(401, "Wrong PIN")
        with _fails_lock:
            _fails.pop(uid, None)
    session.permanent = True
    session["uid"] = u["id"]
    return jsonify(me=public_user(u))


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


# ---------------------------------------------------------------- data
@app.get("/api/data")
@require()
def data():
    expire_punishments()
    u = g.user
    cutoff = iso(now() - timedelta(days=30))
    if u["role"] == "kid":
        kid = kid_summary(u)
        return jsonify(
            role="kid",
            server_time=iso(now()),
            me=kid,
            rev=_rev["n"],
            chores=with_mates("chores", rows(
                "SELECT * FROM chores WHERE kid_id=? AND (status IN ('todo','submitted','denied') OR decided_at >= ?) ORDER BY "
                "CASE status WHEN 'denied' THEN 0 WHEN 'todo' THEN 1 WHEN 'submitted' THEN 2 ELSE 3 END, due_at IS NULL, due_at, id",
                (u["id"], cutoff),
            )),
            punishments=with_mates("punishments", rows(
                "SELECT * FROM punishments WHERE kid_id=? AND (status='active' OR created_at >= ?) ORDER BY status='active' DESC, created_at DESC",
                (u["id"], cutoff),
            )),
            ledger=rows("SELECT * FROM ledger WHERE kid_id=? ORDER BY id DESC LIMIT 40", (u["id"],)),
        )
    kids = [kid_summary(k) for k in rows("SELECT * FROM users WHERE role='kid' ORDER BY id")]
    return jsonify(
        role="parent",
        server_time=iso(now()),
        rev=_rev["n"],
        me=public_user(u),
        kids=kids,
        parents=rows("SELECT id, name, color FROM users WHERE role='parent' ORDER BY id"),
        chores=rows(
            "SELECT * FROM chores WHERE status IN ('todo','submitted','denied') OR decided_at >= ? ORDER BY "
            "CASE status WHEN 'submitted' THEN 0 WHEN 'todo' THEN 1 WHEN 'denied' THEN 1 ELSE 2 END, due_at IS NULL, due_at, id",
            (cutoff,),
        ),
        punishments=rows(
            "SELECT * FROM punishments WHERE status='active' OR created_at >= ? ORDER BY status='active' DESC, created_at DESC",
            (cutoff,),
        ),
        ledger=rows("SELECT * FROM ledger ORDER BY id DESC LIMIT 100"),
    )


# ---------------------------------------------------------------- groups ("together")
def group_of(table, item):
    """All rows that belong together with item (just [item] for a solo chore/consequence)."""
    if item.get("group_id"):
        return rows(f"SELECT * FROM {table} WHERE group_id=? ORDER BY id", (item["group_id"],))
    return [item]


def link_group(table, ids):
    """Give rows a shared group_id (the first row's id)."""
    if len(ids) > 1:
        db().execute(f"UPDATE {table} SET group_id=? WHERE id IN ({','.join('?' * len(ids))})", (ids[0], *ids))


def with_mates(table, items):
    """For a kid's view: add 'mates' (the other kids in each together item) with their status."""
    gids = sorted({i["group_id"] for i in items if i.get("group_id")})
    if not gids:
        return items
    mates = rows(
        f"SELECT t.group_id, t.kid_id, t.status, u.name, u.color FROM {table} t JOIN users u ON u.id = t.kid_id "
        f"WHERE t.group_id IN ({','.join('?' * len(gids))}) ORDER BY t.id", gids)
    for i in items:
        i["mates"] = [m for m in mates if i.get("group_id") and m["group_id"] == i["group_id"] and m["kid_id"] != i["kid_id"]]
    return items


# ---------------------------------------------------------------- chores
def chore_or_404(cid):
    c = one("SELECT * FROM chores WHERE id=?", (cid,))
    if not c:
        abort(404, "Chore not found")
    return c


@app.post("/api/chores")
@require("parent")
def create_chore():
    b = body()
    title = clean(b.get("title"), 80)
    if not title:
        abort(400, "Title required")
    kid_ids = id_list(b.get("kid_ids") or [])
    if not kid_ids:
        abort(400, "Pick at least one kid")
    repeat = b.get("repeat") if b.get("repeat") in REPEATS else "none"
    due = parse_dt(b.get("due_at"))
    value = cents(b.get("value"))
    t = iso(now())
    ids = []
    for kid_id in kid_ids:
        get_kid(kid_id)
        ids.append(db().execute(
            "INSERT INTO chores (kid_id, title, notes, value_cents, due_at, repeat, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (kid_id, title, clean(b.get("notes"), 500), value, iso(due), repeat, g.user["id"], t),
        ).lastrowid)
    if b.get("together"):  # done together: only counts once every kid has marked it done
        link_group("chores", ids)
    db().commit()
    return jsonify(ok=True)


@app.put("/api/chores/<int:cid>")
@require("parent")
def edit_chore(cid):
    c = chore_or_404(cid)
    b = body()
    title = clean(b.get("title"), 80) or c["title"]
    repeat = b.get("repeat") if b.get("repeat") in REPEATS else c["repeat"]
    db().execute(
        "UPDATE chores SET title=?, notes=?, value_cents=?, due_at=?, repeat=? WHERE id=? OR (group_id IS NOT NULL AND group_id=?)",
        (title, clean(b.get("notes"), 500), cents(b.get("value")), iso(parse_dt(b.get("due_at"))), repeat, cid, c["group_id"]),
    )
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/chores/<int:cid>")
@require("parent")
def delete_chore(cid):
    for r in group_of("chores", chore_or_404(cid)):
        if r["status"] == "approved":
            # undo the money too
            db().execute("DELETE FROM ledger WHERE kind='chore' AND ref_id=?", (r["id"],))
        db().execute("DELETE FROM chores WHERE id=?", (r["id"],))
    db().commit()
    return jsonify(ok=True)


@app.post("/api/chores/<int:cid>/submit")
@require("kid")
def submit_chore(cid):
    c = chore_or_404(cid)
    if c["kid_id"] != g.user["id"]:
        abort(403)
    if c["status"] not in ("todo", "denied"):
        abort(400, "Already sent")
    db().execute(
        "UPDATE chores SET status='submitted', submitted_at=?, kid_note=? WHERE id=?",
        (iso(now()), clean(body().get("note"), 300), cid),
    )
    db().commit()
    return jsonify(ok=True)


@app.post("/api/chores/<int:cid>/undo")
@require("kid")
def unsubmit_chore(cid):
    c = chore_or_404(cid)
    if c["kid_id"] != g.user["id"] or c["status"] != "submitted":
        abort(400, "Can't undo")
    db().execute("UPDATE chores SET status='todo', submitted_at=NULL WHERE id=?", (cid,))
    db().commit()
    return jsonify(ok=True)


def spawn_next(grp):
    """Schedule the next copy of a repeating chore (for every kid of a together chore)."""
    c = grp[0]
    step = REPEATS.get(c["repeat"])
    if not step:
        return
    base = parse_dt(c["due_at"]) or now()
    nxt = base + step
    while nxt < now():
        nxt += step
    ids = [db().execute(
        "INSERT INTO chores (kid_id, title, notes, value_cents, due_at, repeat, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)",
        (r["kid_id"], r["title"], r["notes"], r["value_cents"], iso(nxt), r["repeat"], r["created_by"], iso(now())),
    ).lastrowid for r in grp]
    if c["group_id"]:
        link_group("chores", ids)


@app.post("/api/chores/<int:cid>/approve")
@require("parent")
def approve_chore(cid):
    c = chore_or_404(cid)
    grp = group_of("chores", c)
    if all(r["status"] == "approved" for r in grp):
        abort(400, "Already approved")
    b = body()
    value = cents(b["value"]) if "value" in b else c["value_cents"]
    for r in grp:  # a together chore pays every kid in it
        if r["status"] == "approved":
            continue
        db().execute(
            "UPDATE chores SET status='approved', decided_at=?, decided_by=?, parent_note=?, value_cents=? WHERE id=?",
            (iso(now()), g.user["id"], clean(b.get("note"), 300), value, r["id"]),
        )
        if value:
            ledger_add(r["kid_id"], value, "chore", r["title"], r["id"])
    if c["status"] != "missed":  # "missed" already scheduled the next copy
        spawn_next(grp)
    db().commit()
    return jsonify(ok=True)


@app.post("/api/chores/<int:cid>/deny")
@require("parent")
def deny_chore(cid):
    c = chore_or_404(cid)
    if c["status"] not in ("todo", "submitted", "denied"):
        abort(400, "This chore is already finished")
    db().execute(
        "UPDATE chores SET status='denied', decided_at=?, decided_by=?, parent_note=? "
        "WHERE (id=? OR (group_id IS NOT NULL AND group_id=?)) AND status IN ('todo','submitted','denied')",
        (iso(now()), g.user["id"], clean(body().get("note"), 300), cid, c["group_id"]),
    )
    db().commit()
    return jsonify(ok=True)


@app.post("/api/chores/<int:cid>/missed")
@require("parent")
def missed_chore(cid):
    c = chore_or_404(cid)
    if c["status"] not in ("todo", "submitted", "denied"):
        abort(400, "This chore is already finished")
    grp = group_of("chores", c)
    db().execute(
        "UPDATE chores SET status='missed', decided_at=?, decided_by=?, parent_note=? "
        "WHERE (id=? OR (group_id IS NOT NULL AND group_id=?)) AND status IN ('todo','submitted','denied')",
        (iso(now()), g.user["id"], clean(body().get("note"), 300), cid, c["group_id"]),
    )
    spawn_next(grp)
    db().commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------- punishments
def pun_or_404(pid):
    p = one("SELECT * FROM punishments WHERE id=?", (pid,))
    if not p:
        abort(404, "Not found")
    return p


@app.post("/api/punishments")
@require("parent")
def create_punishment():
    b = body()
    title = clean(b.get("title"), 80)
    if not title:
        abort(400, "Title required")
    kid_ids = id_list(b.get("kid_ids") or [])
    if not kid_ids:
        abort(400, "Pick at least one kid")
    fine = cents(b.get("fine"))
    try:
        minutes = max(0, min(int(b.get("duration_minutes") or 0), 60 * 24 * 365))
    except (TypeError, ValueError):
        abort(400, "Bad duration")
    if not fine and not minutes:
        abort(400, "Set a fine, a timer, or both")
    start = parse_dt(b.get("starts_at")) or now()
    end = start + timedelta(minutes=minutes) if minutes else None
    status = "active" if minutes else "ended"
    ids = []
    for kid_id in kid_ids:
        get_kid(kid_id)
        cur = db().execute(
            "INSERT INTO punishments (kid_id, title, reason, fine_cents, duration_minutes, starts_at, ends_at, status, created_by, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (kid_id, title, clean(b.get("reason"), 300), fine, minutes, iso(start), iso(end), status, g.user["id"], iso(now())),
        )
        ids.append(cur.lastrowid)
        if fine:
            ledger_add(kid_id, -fine, "fine", title, cur.lastrowid)
    if b.get("together"):  # one shared consequence: ending, extending or cancelling it acts on all kids
        link_group("punishments", ids)
    db().commit()
    return jsonify(ok=True)


@app.post("/api/punishments/<int:pid>/end")
@require("parent")
def end_punishment(pid):
    grp = [p for p in group_of("punishments", pun_or_404(pid)) if p["status"] == "active"]
    if not grp:
        abort(400, "It's not active")
    for p in grp:
        db().execute("UPDATE punishments SET status='ended', ends_at=? WHERE id=?", (iso(now()), p["id"]))
    db().commit()
    return jsonify(ok=True)


@app.post("/api/punishments/<int:pid>/extend")
@require("parent")
def extend_punishment(pid):
    grp = [p for p in group_of("punishments", pun_or_404(pid)) if p["status"] == "active" and p["ends_at"]]
    if not grp:
        abort(400, "It's not active")
    minutes = to_int(body().get("minutes"), "minutes")
    for p in grp:
        new_end = parse_dt(p["ends_at"]) + timedelta(minutes=minutes)
        if new_end <= now():
            db().execute("UPDATE punishments SET status='ended', ends_at=? WHERE id=?", (iso(now()), p["id"]))
        else:
            db().execute(
                "UPDATE punishments SET status='active', ends_at=?, duration_minutes=duration_minutes+? WHERE id=?",
                (iso(new_end), minutes, p["id"]),
            )
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/punishments/<int:pid>")
@require("parent")
def cancel_punishment(pid):
    """Cancel = it never happened: removes it and refunds the fine."""
    grp = [p for p in group_of("punishments", pun_or_404(pid)) if p["status"] != "cancelled"]
    if not grp:
        abort(400, "Already cancelled")
    for p in grp:
        if p["fine_cents"]:
            ledger_add(p["kid_id"], p["fine_cents"], "refund", f"Cancelled: {p['title']}", p["id"])
        db().execute("UPDATE punishments SET status='cancelled', ends_at=COALESCE(ends_at, ?) WHERE id=?", (iso(now()), p["id"]))
    db().commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------- money
@app.post("/api/payouts")
@require("parent")
def payout():
    b = body()
    kid = get_kid(to_int(b.get("kid_id")))
    amount = cents(b.get("amount"))
    if not amount:
        abort(400, "Nothing to pay")
    ledger_add(kid["id"], -amount, "payout", clean(b.get("note"), 120) or "Paid out")
    db().commit()
    return jsonify(ok=True)


@app.post("/api/adjust")
@require("parent")
def adjust():
    b = body()
    kid = get_kid(to_int(b.get("kid_id")))
    amount = cents(b.get("amount"), allow_negative=True)
    if not amount:
        abort(400, "Amount required")
    ledger_add(kid["id"], amount, "bonus" if amount > 0 else "adjust", clean(b.get("note"), 120) or ("Bonus" if amount > 0 else "Adjustment"))
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/ledger/<int:lid>")
@require("parent")
def delete_ledger(lid):
    e = one("SELECT * FROM ledger WHERE id=?", (lid,))
    if not e:
        abort(404)
    if e["kind"] not in ("payout", "bonus", "adjust"):
        abort(400, "Undo the chore or consequence instead")
    db().execute("DELETE FROM ledger WHERE id=?", (lid,))
    db().commit()
    return jsonify(ok=True)


# ---------------------------------------------------------------- people
@app.post("/api/users")
@require("parent")
def add_user():
    b = body()
    role = "parent" if b.get("role") == "parent" else "kid"
    name = clean(b.get("name"), 40)
    if not name:
        abort(400, "Name required")
    n = one("SELECT COUNT(*) AS n FROM users")["n"]
    pin_hash = generate_password_hash(valid_pin(b.get("pin"))) if role == "parent" else ""
    db().execute(
        "INSERT INTO users (name, role, pin_hash, color, jar_size_cents, goal_label, created_at) VALUES (?,?,?,?,?,?,?)",
        (name, role, pin_hash, clean(b.get("color"), 9) or COLORS[n % len(COLORS)],
         cents(b.get("jar_size") or 20) or 2000, clean(b.get("goal_label"), 60), iso(now())),
    )
    db().commit()
    return jsonify(ok=True)


@app.put("/api/users/<int:uid>")
@require("parent")
def edit_user(uid):
    u = one("SELECT * FROM users WHERE id=?", (uid,))
    if not u:
        abort(404)
    b = body()
    name = clean(b.get("name"), 40) or u["name"]
    color = clean(b.get("color"), 9) or u["color"]
    jar = cents(b["jar_size"]) if b.get("jar_size") not in (None, "") else u["jar_size_cents"]
    goal = clean(b.get("goal_label"), 60) if "goal_label" in b else u["goal_label"]
    db().execute("UPDATE users SET name=?, color=?, jar_size_cents=?, goal_label=? WHERE id=?",
                 (name, color, max(jar, 100), goal, uid))
    if b.get("pin") and u["role"] == "parent":
        db().execute("UPDATE users SET pin_hash=? WHERE id=?", (generate_password_hash(valid_pin(b["pin"])), uid))
    db().commit()
    return jsonify(ok=True)


@app.delete("/api/users/<int:uid>")
@require("parent")
def delete_user(uid):
    u = one("SELECT * FROM users WHERE id=?", (uid,))
    if not u:
        abort(404)
    if u["role"] == "parent" and one("SELECT COUNT(*) AS n FROM users WHERE role='parent'")["n"] <= 1:
        abort(400, "Keep at least one parent")
    db().execute("DELETE FROM users WHERE id=?", (uid,))
    db().commit()
    if uid == g.user["id"]:
        session.clear()
    return jsonify(ok=True)


# ---------------------------------------------------------------- static
STATIC = os.path.join(BASE_DIR, "static")


@app.get("/")
def index():
    resp = send_from_directory(STATIC, "index.html")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/sw.js")
def sw():
    resp = send_from_directory(STATIC, "sw.js")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["Service-Worker-Allowed"] = "/"
    return resp


@app.get("/<path:path>")
def static_files(path):
    if path.startswith("api/"):
        abort(404)
    full = os.path.join(STATIC, path)
    if os.path.isfile(full):
        resp = send_from_directory(STATIC, path)
        resp.headers["Cache-Control"] = "no-cache"
        return resp
    return index()


init_db()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)), debug=os.environ.get("KARMA_DEBUG") == "1")
