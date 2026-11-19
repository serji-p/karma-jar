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
            "kids": [{"name": "Ana"}, {"name": "Ben"}],
        })
        assert r.status_code == 200, r.json
        prof = cls.parent.get("/api/profiles").json
        cls.ana = next(p["id"] for p in prof if p["name"] == "Ana")
        cls.ben = next(p["id"] for p in prof if p["name"] == "Ben")
        assert cls.parent.post("/api/users", json={"role": "parent", "name": "Dad", "pin": "5678"}).status_code == 200
        cls.dad = next(p["id"] for p in cls.parent.get("/api/profiles").json if p["name"] == "Dad")
        cls.kid = karma.app.test_client()
        assert cls.kid.post("/api/login", json={"user_id": cls.ana}).status_code == 200  # kids need no PIN
        cls.kid2 = karma.app.test_client()
        assert cls.kid2.post("/api/login", json={"user_id": cls.ben}).status_code == 200

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
            self.assertEqual(c.post("/api/login", json={"user_id": self.dad, "pin": "0000"}).status_code, 401)
        r = c.post("/api/login", json={"user_id": self.dad, "pin": "5678"})
        self.assertEqual(r.status_code, 429, "even the right PIN is refused while locked")
        karma._fails.clear()
        self.assertEqual(c.post("/api/login", json={"user_id": self.dad, "pin": "5678"}).status_code, 200)

    def test_13b_pin_lockout_parallel(self):
        """Parallel guesses must not get more than 5 real PIN checks before the lock kicks in."""
        from concurrent.futures import ThreadPoolExecutor
        karma._fails.clear()

        def guess(pin):
            return karma.app.test_client().post("/api/login", json={"user_id": self.dad, "pin": pin}).status_code

        with ThreadPoolExecutor(20) as ex:
            codes = list(ex.map(guess, [f"{i:04d}" for i in range(3000, 3040)]))
        self.assertLessEqual(codes.count(401), 5, codes)
        self.assertEqual(codes.count(401) + codes.count(429), 40)
        karma._fails.clear()

    def test_15_kids_have_no_pin_parents_do(self):
        c = karma.app.test_client()
        self.assertEqual(c.post("/api/login", json={"user_id": self.dad}).status_code, 401)
        self.assertEqual(c.post("/api/login", json={"user_id": self.ben, "pin": "whatever"}).status_code, 200)
        self.assertEqual(self.parent.post("/api/users", json={"role": "kid", "name": "Cy"}).status_code, 200)
        self.assertEqual(self.parent.post("/api/users", json={"role": "parent", "name": "Gran"}).status_code, 400)

    def test_16_together_chore(self):
        r = self.parent.post("/api/chores", json={"title": "Tidy playroom", "kid_ids": [self.ana, self.ben], "value": 2, "together": True})
        self.assertEqual(r.status_code, 200)
        rows = self.sql("SELECT * FROM chores WHERE title='Tidy playroom' ORDER BY id")
        self.assertEqual(len(rows), 2)
        self.assertTrue(rows[0]["group_id"] and rows[0]["group_id"] == rows[1]["group_id"])
        a_bal, b_bal = self.bal(self.ana), self.bal(self.ben)
        ana_row = next(r for r in rows if r["kid_id"] == self.ana)
        self.kid.post(f"/api/chores/{ana_row['id']}/submit")
        mine = next(x for x in self.kid.get("/api/data").json["chores"] if x["id"] == ana_row["id"])
        self.assertEqual([(m["name"], m["status"]) for m in mine["mates"]], [("Ben", "todo")])
        ben_row = next(r for r in rows if r["kid_id"] == self.ben)
        self.kid2.post(f"/api/chores/{ben_row['id']}/submit")
        self.parent.post(f"/api/chores/{ana_row['id']}/approve", json={})
        self.assertEqual({r["status"] for r in self.sql("SELECT status FROM chores WHERE title='Tidy playroom'")}, {"approved"})
        self.assertEqual((self.bal(self.ana), self.bal(self.ben)), (a_bal + 200, b_bal + 200))
        # deleting the approved together chore takes the reward back from both
        self.parent.delete(f"/api/chores/{ben_row['id']}")
        self.assertEqual((self.bal(self.ana), self.bal(self.ben)), (a_bal, b_bal))
        self.assertEqual(self.sql("SELECT COUNT(*) n FROM chores WHERE title='Tidy playroom'")[0]["n"], 0)

    def test_17_together_chore_send_back_and_repeat(self):
        self.parent.post("/api/chores", json={"title": "Walk dog", "kid_ids": [self.ana, self.ben], "together": True, "repeat": "daily"})
        rows = self.sql("SELECT * FROM chores WHERE title='Walk dog' ORDER BY id")
        self.parent.post(f"/api/chores/{rows[0]['id']}/deny", json={"note": "both of you"})
        self.assertEqual({r["status"] for r in self.sql("SELECT status FROM chores WHERE title='Walk dog'")}, {"denied"})
        self.parent.post(f"/api/chores/{rows[1]['id']}/approve", json={})
        nxt = self.sql("SELECT * FROM chores WHERE title='Walk dog' AND status='todo' ORDER BY id")
        self.assertEqual(len(nxt), 2, "the next copy is created for both kids")
        self.assertTrue(nxt[0]["group_id"] and nxt[0]["group_id"] == nxt[1]["group_id"] != rows[0]["group_id"])
        self.parent.put(f"/api/chores/{nxt[0]['id']}", json={"title": "Walk the dog", "value": 1})
        self.assertEqual(self.sql("SELECT COUNT(*) n FROM chores WHERE title='Walk the dog'")[0]["n"], 2)

    def test_18_together_consequence(self):
        a_bal, b_bal = self.bal(self.ana), self.bal(self.ben)
        self.parent.post("/api/punishments", json={"kid_ids": [self.ana, self.ben], "title": "No TV together", "fine": 1,
                                                   "duration_minutes": 60, "together": True})
        ps = self.sql("SELECT * FROM punishments WHERE title='No TV together' ORDER BY id")
        self.assertEqual((len(ps), ps[0]["group_id"] == ps[1]["group_id"]), (2, True))
        self.assertEqual((self.bal(self.ana), self.bal(self.ben)), (a_bal - 100, b_bal - 100))
        mine = next(x for x in self.kid.get("/api/data").json["punishments"] if x["title"] == "No TV together")
        self.assertEqual([m["name"] for m in mine["mates"]], ["Ben"])
        self.parent.post(f"/api/punishments/{ps[0]['id']}/extend", json={"minutes": 30})
        ends = {r["ends_at"] for r in self.sql("SELECT ends_at FROM punishments WHERE title='No TV together'")}
        self.assertEqual(len(ends), 1, "both timers move together")
        self.assertGreater(ends.pop(), ps[0]["ends_at"])
        self.parent.delete(f"/api/punishments/{ps[1]['id']}")
        self.assertEqual((self.bal(self.ana), self.bal(self.ben)), (a_bal, b_bal))
        self.assertEqual({r["status"] for r in self.sql("SELECT status FROM punishments WHERE title='No TV together'")}, {"cancelled"})

    def test_19_rev_changes_on_writes_only(self):
        r0 = self.kid.get("/api/rev").json["rev"]
        self.kid.get("/api/data")
        self.assertEqual(self.kid.get("/api/rev").json["rev"], r0)
        self.parent.post("/api/adjust", json={"kid_id": self.ana, "amount": 1})
        self.assertGreater(self.kid.get("/api/rev").json["rev"], r0)
        r1 = self.kid.get("/api/rev").json["rev"]
        self.parent.post("/api/adjust", json={"kid_id": self.ana, "amount": 0})  # rejected -> no change
        self.assertEqual(self.kid.get("/api/rev").json["rev"], r1)
        self.assertEqual(self.kid.get("/api/data").json["rev"], r1)

    def test_99_last_parent_protected(self):
        self.assertEqual(self.parent.delete(f"/api/users/{self.dad}").status_code, 200)
        me = self.parent.get("/api/state").json["me"]["id"]
        self.assertEqual(self.parent.delete(f"/api/users/{me}").status_code, 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
