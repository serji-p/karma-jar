"""End-to-end API tests for Karma Jar. Run: python -m unittest -v test_app

Uses a throwaway data dir, so it never touches ./data.
"""
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

os.environ["KARMA_DATA_DIR"] = tempfile.mkdtemp(prefix="karma-test-")
import app as karma  # noqa: E402


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Flow(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.path.exists(karma.DB_PATH):
            os.remove(karma.DB_PATH)
        karma.init_db()
        cls.parent = karma.app.test_client()
        r = cls.parent.post("/api/setup", json={
            "parent": {"name": "Mom", "pin": "1234"},
            "kids": [{"name": "Ana", "pin": "1111"}, {"name": "Ben", "pin": "2222"}],
        })
        assert r.status_code == 200, r.json
        prof = cls.parent.get("/api/profiles").json
        cls.ana = next(p["id"] for p in prof if p["name"] == "Ana")
        cls.ben = next(p["id"] for p in prof if p["name"] == "Ben")
        cls.kid = karma.app.test_client()
        assert cls.kid.post("/api/login", json={"user_id": cls.ana, "pin": "1111"}).status_code == 200

    def sql(self, q, a=()):
        c = sqlite3.connect(karma.DB_PATH)
        c.row_factory = sqlite3.Row
        r = [dict(x) for x in c.execute(q, a).fetchall()]
        c.commit()
        c.close()
        return r

    def bal(self, kid_id):
        k = next(k for k in self.parent.get("/api/data").json["kids"] if k["id"] == kid_id)
        return k["balance_cents"]

    def chore(self, title, **kw):
        r = self.parent.post("/api/chores", json={"title": title, "kid_ids": [self.ana], "value": kw.pop("value", 1), **kw})
        self.assertEqual(r.status_code, 200, r.json)
        return self.sql("SELECT * FROM chores WHERE title=? ORDER BY id DESC", (title,))[0]

    def test_01_setup_only_once(self):
        r = self.parent.post("/api/setup", json={"parent": {"name": "X", "pin": "9999"}})
        self.assertEqual(r.status_code, 403)

    def test_02_chore_submit_approve_pay(self):
        start = self.bal(self.ana)
        c = self.chore("Dishes", value=2.5)
        self.assertEqual(self.kid.post(f"/api/chores/{c['id']}/submit", json={"note": "done!"}).status_code, 200)
        self.assertEqual(self.kid.post(f"/api/chores/{c['id']}/submit").status_code, 400)  # already sent
        self.assertEqual(self.kid.post(f"/api/chores/{c['id']}/undo").status_code, 200)
        self.kid.post(f"/api/chores/{c['id']}/submit")
        self.assertEqual(self.parent.post(f"/api/chores/{c['id']}/approve", json={}).status_code, 200)
        self.assertEqual(self.parent.post(f"/api/chores/{c['id']}/approve", json={}).status_code, 400)
        self.assertEqual(self.bal(self.ana), start + 250)
        kid_data = self.kid.get("/api/data").json
        self.assertEqual(kid_data["me"]["balance_cents"], start + 250)
        self.assertEqual(self.parent.post("/api/payouts", json={"kid_id": self.ana, "amount": "2.50"}).status_code, 200)
        self.assertEqual(self.bal(self.ana), start)

    def test_03_deny_then_resubmit(self):
        c = self.chore("Clean room")
        self.kid.post(f"/api/chores/{c['id']}/submit")
        self.parent.post(f"/api/chores/{c['id']}/deny", json={"note": "Toys on floor"})
        d = next(x for x in self.kid.get("/api/data").json["chores"] if x["id"] == c["id"])
        self.assertEqual((d["status"], d["parent_note"]), ("denied", "Toys on floor"))
        self.assertEqual(self.kid.post(f"/api/chores/{c['id']}/submit").status_code, 200)

    def test_04_kid_cannot_do_parent_things(self):
        self.assertEqual(self.kid.post("/api/chores", json={"title": "x", "kid_ids": [self.ana]}).status_code, 403)
        self.assertEqual(self.kid.post("/api/adjust", json={"kid_id": self.ana, "amount": 100}).status_code, 403)
        other = self.parent.post("/api/chores", json={"title": "Ben thing", "kid_ids": [self.ben]})
        cid = self.sql("SELECT id FROM chores WHERE title='Ben thing'")[0]["id"]
        self.assertEqual(self.kid.post(f"/api/chores/{cid}/submit").status_code, 403)
        self.assertEqual(other.status_code, 200)
        self.assertEqual(karma.app.test_client().get("/api/data").status_code, 401)

    def test_05_consequence_timer_expiry_and_cancel_refund(self):
        start = self.bal(self.ana)
        r = self.parent.post("/api/punishments", json={"kid_ids": [self.ana], "title": "No tablet", "fine": 1, "duration_minutes": 60})
        self.assertEqual(r.status_code, 200)
        p = self.sql("SELECT * FROM punishments WHERE title='No tablet' ORDER BY id DESC")[0]
        self.assertEqual(self.bal(self.ana), start - 100)
        self.parent.post(f"/api/punishments/{p['id']}/extend", json={"minutes": 30})
        p2 = self.sql("SELECT * FROM punishments WHERE id=?", (p["id"],))[0]
        self.assertGreater(p2["ends_at"], p["ends_at"])
        # let the timer run out
        self.sql("UPDATE punishments SET ends_at=? WHERE id=?", (iso(datetime.now(timezone.utc) - timedelta(seconds=1)), p["id"]))
        st = next(x for x in self.kid.get("/api/data").json["punishments"] if x["id"] == p["id"])["status"]
        self.assertEqual(st, "ended")
        self.assertEqual(self.parent.post(f"/api/punishments/{p['id']}/extend", json={"minutes": 60}).status_code, 400)
        # cancel refunds exactly once
        self.assertEqual(self.parent.delete(f"/api/punishments/{p['id']}").status_code, 200)
        self.assertEqual(self.parent.delete(f"/api/punishments/{p['id']}").status_code, 400)
        self.assertEqual(self.bal(self.ana), start)

    def test_06_shorten_past_now_ends_it(self):
        self.parent.post("/api/punishments", json={"kid_ids": [self.ana], "title": "No TV", "duration_minutes": 60})
        p = self.sql("SELECT * FROM punishments WHERE title='No TV'")[0]
        self.parent.post(f"/api/punishments/{p['id']}/extend", json={"minutes": -1440})
        self.assertEqual(self.sql("SELECT status FROM punishments WHERE id=?", (p["id"],))[0]["status"], "ended")

    def test_07_negative_balance(self):
        self.parent.post("/api/punishments", json={"kid_ids": [self.ben], "title": "Fine only", "fine": 50})
        self.assertLess(self.bal(self.ben), 0)
        self.assertEqual(self.parent.post("/api/punishments", json={"kid_ids": [self.ben], "title": "Nothing"}).status_code, 400)

    def test_08_repeat_spawns_once(self):
        due = datetime.now(timezone.utc) - timedelta(days=2, hours=1)
        c = self.chore("Feed the cat", repeat="daily", due_at=iso(due))
        self.parent.post(f"/api/chores/{c['id']}/missed")
        self.assertEqual(self.parent.post(f"/api/chores/{c['id']}/missed").status_code, 400)
        self.parent.post(f"/api/chores/{c['id']}/approve", json={})  # parent changes mind
        rows = self.sql("SELECT * FROM chores WHERE title='Feed the cat' ORDER BY id")
        self.assertEqual(len(rows), 2, "approve after missed must not spawn a second copy")
        nxt = datetime.fromisoformat(rows[1]["due_at"].replace("Z", "+00:00"))
        self.assertGreater(nxt, datetime.now(timezone.utc))
        self.assertLess(nxt, datetime.now(timezone.utc) + timedelta(days=1))
        self.assertEqual(nxt.time(), due.replace(microsecond=0).time(), "keeps the same time of day")

    def test_09_delete_approved_takes_money_back(self):
        start = self.bal(self.ana)
        c = self.chore("Vacuum", value=3)
        self.parent.post(f"/api/chores/{c['id']}/approve", json={})
        self.assertEqual(self.bal(self.ana), start + 300)
        self.parent.delete(f"/api/chores/{c['id']}")
        self.assertEqual(self.bal(self.ana), start)

    def test_10_ledger_undo_rules(self):
        self.parent.post("/api/adjust", json={"kid_id": self.ana, "amount": 5})
        bonus = self.sql("SELECT id FROM ledger WHERE kind='bonus' ORDER BY id DESC")[0]["id"]
        fine = self.sql("SELECT id FROM ledger WHERE kind='fine' ORDER BY id DESC")[0]["id"]
        self.assertEqual(self.parent.delete(f"/api/ledger/{bonus}").status_code, 200)
        self.assertEqual(self.parent.delete(f"/api/ledger/{fine}").status_code, 400)

    def test_11_timezone_roundtrip(self):
        # browser sends toISOString() (UTC, with ms); a +05:00 offset must also be normalised
        c = self.chore("TZ", due_at="2030-01-01T20:00:00.000Z")
        self.assertEqual(c["due_at"], "2030-01-01T20:00:00Z")
        c = self.chore("TZ2", due_at="2030-01-01T20:00:00+05:00")
        self.assertEqual(c["due_at"], "2030-01-01T15:00:00Z")
        self.assertEqual(self.parent.post("/api/chores", json={"title": "x", "kid_ids": [self.ana], "due_at": "nope"}).status_code, 400)

    def test_12_bad_input_is_400_json(self):
        r = self.parent.post("/api/chores", json={"title": "x", "kid_ids": ["abc"]})
        self.assertEqual(r.status_code, 400)
        self.assertIn("error", r.json)
        self.assertEqual(self.parent.post("/api/login", json={"user_id": "x"}).status_code, 400)
        self.assertEqual(self.parent.put("/api/state").status_code, 405)
        self.assertIn("error", self.parent.put("/api/state").json)

    def test_13_pin_lockout(self):
        c = karma.app.test_client()
        for _ in range(5):
            self.assertEqual(c.post("/api/login", json={"user_id": self.ben, "pin": "0000"}).status_code, 401)
        r = c.post("/api/login", json={"user_id": self.ben, "pin": "2222"})
        self.assertEqual(r.status_code, 429, "even the right PIN is refused while locked")
        karma._fails.clear()
        self.assertEqual(c.post("/api/login", json={"user_id": self.ben, "pin": "2222"}).status_code, 200)

    def test_13b_pin_lockout_parallel(self):
        """Parallel guesses must not get more than 5 real PIN checks before the lock kicks in."""
        from concurrent.futures import ThreadPoolExecutor
        karma._fails.clear()

        def guess(pin):
            return karma.app.test_client().post("/api/login", json={"user_id": self.ben, "pin": pin}).status_code

        with ThreadPoolExecutor(20) as ex:
            codes = list(ex.map(guess, [f"{i:04d}" for i in range(3000, 3040)]))
        self.assertLessEqual(codes.count(401), 5, codes)
        self.assertEqual(codes.count(401) + codes.count(429), 40)
        karma._fails.clear()

    def test_14_last_parent_protected(self):
        me = self.parent.get("/api/state").json["me"]["id"]
        self.assertEqual(self.parent.delete(f"/api/users/{me}").status_code, 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
