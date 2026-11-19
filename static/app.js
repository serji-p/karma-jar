/* Karma Jar - frontend (no build step, plain JS) */
(() => {
  "use strict";

  // ------------------------------------------------------------ utils
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (c) => (c < 0 ? "-" : "") + "$" + (Math.abs(c) / 100).toFixed(2);
  const money0 = (c) => (c % 100 === 0 ? (c < 0 ? "-" : "") + "$" + Math.abs(c / 100) : money(c));
  const initial = (n) => esc((n || "?").trim().charAt(0).toUpperCase());
  // chores created through the API carry the token's name ("Home Assistant", "Claude Code", ...)
  const sourcePill = (c) => (c.source ? `<span class="pill">${/home|assistant|\bha\b/i.test(c.source) ? "🏠" : "🤖"} ${esc(c.source)}</span>` : "");
  const COLORS = ["#FF6B9A", "#4DA3FF", "#33C48D", "#FF9F43", "#9B6BFF", "#FF5E5E", "#14B8C4", "#5B4BDB"];

  let serverOffset = 0; // serverTime - localTime
  const nowMs = () => Date.now() + serverOffset;

  async function api(method, url, data) {
    const res = await fetch(url, {
      method,
      headers: data ? { "Content-Type": "application/json" } : {},
      body: data ? JSON.stringify(data) : undefined,
      credentials: "same-origin",
    });
    let json = {};
    try { json = await res.json(); } catch (_) { /* empty */ }
    if (!res.ok) {
      const err = new Error(json.error || `Error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  function toast(msg, kind = "") {
    const t = document.createElement("div");
    t.className = "toast " + kind;
    t.textContent = msg;
    $("#toast-root").appendChild(t);
    setTimeout(() => { t.style.transition = "opacity .3s"; t.style.opacity = 0; }, 2400);
    setTimeout(() => t.remove(), 2800);
  }

  function fmtDate(iso, opts = {}) {
    const d = new Date(iso);
    const today = new Date(nowMs());
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const same = (a, b) => a.toDateString() === b.toDateString();
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (same(d, today)) return (opts.noToday ? "" : "today ") + time;
    if (same(d, tomorrow)) return "tomorrow " + time;
    if (same(d, yesterday)) return "yesterday " + time;
    const diffDays = Math.abs(d - today) / 864e5;
    if (diffDays < 6) return d.toLocaleDateString([], { weekday: "short" }) + " " + time;
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
  }

  function fmtDur(ms) {
    if (ms <= 0) return "0s";
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d) return `${d}d ${h}h ${m}m`;
    if (h) return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
    return `${m}m ${String(sec).padStart(2, "0")}s`;
  }

  function fmtMinutes(min) {
    if (!min) return "";
    if (min % 10080 === 0) return `${min / 10080} week${min / 10080 > 1 ? "s" : ""}`;
    if (min % 1440 === 0) return `${min / 1440} day${min / 1440 > 1 ? "s" : ""}`;
    if (min % 60 === 0) return `${min / 60} hour${min / 60 > 1 ? "s" : ""}`;
    return `${min} min`;
  }

  function dueInfo(c) {
    if (!c.due_at) return null;
    const ms = new Date(c.due_at) - nowMs();
    const open = ["todo", "denied"].includes(c.status);
    if (open && ms < 0) return { cls: "bad", text: "⏰ Late · was due " + fmtDate(c.due_at) };
    if (open && ms < 3 * 3600e3) return { cls: "warn", text: "⏰ Due " + fmtDate(c.due_at) };
    return { cls: "", text: "📅 Due " + fmtDate(c.due_at) };
  }

  const toLocalInput = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

  // ------------------------------------------------------------ jar svg
  let jarSeq = 0;
  const BODY = "M36 34 C36 42 20 46 20 62 L20 124 Q20 142 38 142 L82 142 Q100 142 100 124 L100 62 C100 46 84 42 84 34 Z";
  const COINS = [
    [34, 134], [50, 136], [66, 135], [82, 134], [42, 127], [58, 128], [74, 127], [88, 126], [30, 120], [50, 120], [66, 119], [82, 119],
    [38, 112], [58, 111], [74, 112], [90, 110], [30, 103], [46, 103], [66, 103], [82, 102], [38, 95], [54, 94], [72, 95], [88, 94],
    [30, 86], [48, 86], [64, 86], [80, 86], [40, 78], [58, 77], [74, 78], [90, 77], [32, 69], [50, 69], [66, 68], [84, 69], [44, 61], [60, 60], [76, 61],
  ];
  // 142 = bottom, 54 = top of fill. Any positive balance shows at least the bottom row of coins
  // (otherwise a few dollars in a big jar hide behind the rounded bottom).
  const levelY = (frac) => (frac <= 0 ? 146 : 142 - (0.07 + 0.93 * Math.min(1, frac)) * 88);
  const jarMem = {}; // last rendered level per jar, so re-renders (polling) don't refill from empty

  function jarSVG(frac, color, size = 120, fromFrac = null, key = null) {
    const id = "jar" + ++jarSeq;
    if (key) {
      if ((fromFrac === null || fromFrac === 0) && key in jarMem) fromFrac = jarMem[key];
      jarMem[key] = frac;
    }
    const y = levelY(frac);
    const y0 = fromFrac === null ? y : levelY(fromFrac);
    const full = frac >= 1;
    // only coins that sit fully below the clip edge (level - 6); the higher of start/end level so a draining jar keeps its coins
    const yTop = Math.min(y, y0);
    const coins = COINS.filter(([, cy]) => cy >= yTop - 2.4).map(([x, cy]) => `<ellipse cx="${x}" cy="${cy}" rx="7.5" ry="3.6" fill="#E9A21A" stroke="#C47F06" stroke-width="1.2"/><ellipse cx="${x - 1.5}" cy="${cy - 1}" rx="3" ry="1.1" fill="#FFE39A" opacity=".8"/>`).join("");
    const wave = "M-120 4 Q-105 -1 -90 4 T-60 4 T-30 4 T0 4 T30 4 T60 4 T90 4 T120 4 T150 4 T180 4 V200 H-120 Z";
    return `<div class="jar" data-to="${y}" style="width:${size}px"><svg viewBox="0 0 120 150" width="${size}" height="${size * 1.25}" aria-hidden="true">
      <defs>
        <clipPath id="${id}c"><path d="${BODY}"/></clipPath>
        <clipPath id="${id}b" clipPathUnits="userSpaceOnUse"><rect x="-200" y="-6" width="500" height="300"/></clipPath>
        <linearGradient id="${id}g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#FFD66B"/><stop offset="1" stop-color="#F2A81E"/></linearGradient>
      </defs>
      <path d="${BODY}" fill="${frac < 0 ? "#FFE3E6" : "#FFFFFF"}" opacity=".85"/>
      <g clip-path="url(#${id}c)">
        <g class="level" style="transform:translateY(${y0}px)">
          <path class="wave2" d="${wave}" fill="#FFE7A3"/>
          <path class="wave" d="${wave}" transform="translate(0,2)" fill="url(#${id}g)"/>
          <g clip-path="url(#${id}b)"><g class="counter" style="transform:translateY(${-y0}px)">${coins}</g></g>
        </g>
      </g>
      <path d="M31 66 Q28 98 31 122" stroke="#fff" stroke-width="5" stroke-linecap="round" fill="none" opacity=".75"/>
      <path d="${BODY}" fill="none" stroke="#2B2340" stroke-opacity=".16" stroke-width="3"/>
      <rect x="30" y="25" width="60" height="11" rx="4" fill="${color}"/>
      <rect x="30" y="25" width="60" height="11" rx="4" fill="#000" opacity=".14"/>
      <rect x="33" y="12" width="54" height="15" rx="6" fill="${color}"/>
      <rect x="38" y="15" width="22" height="3.5" rx="1.75" fill="#fff" opacity=".45"/>
      ${full ? `<g fill="#FFC83D"><path class="sparkle" d="M10 40 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3z"/><path class="sparkle" d="M106 54 l2.5 5.5 5.5 2.5 -5.5 2.5 -2.5 5.5 -2.5 -5.5 -5.5 -2.5 5.5 -2.5z"/><path class="sparkle" d="M100 8 l2 4.5 4.5 2 -4.5 2 -2 4.5 -2 -4.5 -4.5 -2 4.5 -2z"/></g>` : ""}
    </svg></div>`;
  }

  // animate jars from their rendered level to their target level
  function settleJars(root = document) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      $$(".jar", root).forEach((j) => {
        const y = j.dataset.to;
        const lv = $(".level", j), ct = $(".counter", j);
        if (lv) lv.style.transform = `translateY(${y}px)`;
        if (ct) ct.style.transform = `translateY(${-y}px)`;
      });
    }));
  }

  function coinRain(n = 26) {
    const wrap = document.createElement("div");
    wrap.className = "coin-rain";
    for (let i = 0; i < n; i++) {
      const c = document.createElement("i");
      c.style.left = Math.random() * 100 + "vw";
      c.style.animationDuration = 1.4 + Math.random() * 1.4 + "s";
      c.style.animationDelay = Math.random() * 0.6 + "s";
      const s = 16 + Math.random() * 14;
      c.style.width = c.style.height = s + "px";
      wrap.appendChild(c);
    }
    document.body.appendChild(wrap);
    setTimeout(() => wrap.remove(), 3600);
  }

  function floatAmount(cents) {
    const el = document.createElement("div");
    el.className = "float-plus" + (cents < 0 ? " neg" : "");
    el.textContent = (cents > 0 ? "+" : "") + money(cents);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1900);
  }

  // ------------------------------------------------------------ sheet (modal)
  function sheet(title, html, onMount) {
    const root = $("#sheet-root");
    const bd = document.createElement("div");
    bd.className = "sheet-backdrop";
    bd.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>
      <div class="sheet-head"><h2>${title}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
      <div class="sheet-body">${html}</div></div>`;
    const close = () => { bd.remove(); };
    bd.addEventListener("click", (e) => { if (e.target === bd || e.target.closest("[data-close]")) close(); });
    root.appendChild(bd);
    if (onMount) onMount($(".sheet", bd), close);
    return close;
  }

  function confirmSheet(title, text, okLabel, okClass = "bad") {
    return new Promise((resolve) => {
      let done = false;
      const close = sheet(title, `<p class="muted">${text}</p><div class="sheet-actions"><button class="btn plain" data-close>Never mind</button><button class="btn ${okClass}" id="cf-ok">${okLabel}</button></div>`, (el, cl) => {
        $("#cf-ok", el).onclick = () => { done = true; cl(); resolve(true); };
      });
      const obs = new MutationObserver(() => { if (!document.body.contains($("#cf-ok"))) { obs.disconnect(); if (!done) resolve(false); } });
      obs.observe($("#sheet-root"), { childList: true });
      void close;
    });
  }

  // wire "chips" groups: data-group single/multi select
  function wireChips(el) {
    $$("[data-chips]", el).forEach((g) => {
      const multi = g.dataset.chips === "multi";
      g.addEventListener("click", (e) => {
        const c = e.target.closest(".chip");
        if (!c) return;
        if (multi) c.classList.toggle("on");
        else { $$(".chip", g).forEach((x) => x.classList.remove("on")); c.classList.add("on"); }
        g.dispatchEvent(new Event("change"));
      });
    });
  }
  const chipVals = (g) => $$(".chip.on", g).map((c) => c.dataset.v);

  async function guard(btn, fn) {
    if (btn) btn.disabled = true;
    try { return await fn(); }
    catch (e) { toast(e.message, "bad"); }
    finally { if (btn) btn.disabled = false; }
  }

  // ------------------------------------------------------------ app state
  const S = { me: null, data: null, tab: "home", kidFilter: "all", pollTimer: null };
  const app = $("#app");

  async function boot() {
    try {
      const st = await api("GET", "/api/state");
      if (st.setup_needed) return renderSetup();
      if (!st.me) return renderLogin();
      S.me = st.me;
      await refresh();
    } catch (e) {
      app.innerHTML = `<div class="center-wrap"><div class="card empty"><span class="big">🔌</span>Can't reach Karma Jar.<br><br><button class="btn" id="retry">Try again</button></div></div>`;
      $("#retry").onclick = boot;
    }
  }

  async function refresh() {
    try {
      const d = await api("GET", "/api/data");
      serverOffset = new Date(d.server_time) - Date.now();
      S.data = d;
      S.me = d.me;
      render();
    } catch (e) {
      if (e.status === 401) { S.me = null; return renderLogin(); }
      throw e;
    }
  }

  // Live refresh: every 3 s ask the server whether anything changed (a tiny request) and reload only
  // when it did, so a chore a parent adds shows up on the kid's tablet within seconds. A full reload
  // also happens about once a minute so "today / tomorrow" labels stay right. Never while a sheet is open.
  function startPolling() {
    clearInterval(S.pollTimer);
    let ticks = 0, busy = false;
    S.pollTimer = setInterval(async () => {
      if (busy || document.visibilityState !== "visible" || !S.me || $(".sheet-backdrop")) return;
      busy = true;
      try {
        const { rev } = await api("GET", "/api/rev");
        if (rev !== S.data?.rev || ++ticks % 20 === 0) await refresh();
      } catch (_) { /* offline: try again next tick */ } finally { busy = false; }
    }, 3000);
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.me) refresh().catch(() => {}); });

  // ticking countdowns
  setInterval(() => {
    $$("[data-ends]").forEach((el) => {
      const left = new Date(el.dataset.ends) - nowMs();
      el.textContent = left > 0 ? fmtDur(left) + " left" : "Done!";
      if (left <= 0 && !el.dataset.fired) { el.dataset.fired = 1; setTimeout(() => refresh().catch(() => {}), 1500); }
    });
  }, 1000);

  function render() {
    if (!S.data) return;
    if (S.data.role === "kid") renderKid();
    else renderParent();
    startPolling();
  }

  async function logout() {
    await api("POST", "/api/logout");
    S.me = null; S.data = null;
    clearInterval(S.pollTimer);
    renderLogin();
  }

  // ------------------------------------------------------------ setup
  function renderSetup() {
    const kidRow = (i) => `<div class="kid-setup" data-kid>
      <label class="field"><span>Kid's name</span><input class="input" data-k="name" placeholder="Name" maxlength="40"></label>
      <div class="swatches" data-k="color">${COLORS.slice(0, 6).map((c, j) => `<button type="button" class="swatch ${j === i % 6 ? "on" : ""}" style="background:${c}" data-v="${c}"></button>`).join("")}</div>
    </div>`;
    app.innerHTML = `<div class="center-wrap">
      <div class="brand-head">${jarSVG(0.7, "#5B4BDB", 90)}<h1>Karma <b>Jar</b></h1><div class="muted">Let's set up your family</div></div>
      <div class="card setup-card">
        <h3 style="margin-bottom:12px">👤 Parent</h3>
        <label class="field"><span>Your name</span><input class="input" id="p-name" placeholder="Mom, Dad…" maxlength="40"></label>
        <label class="field"><span>Parent PIN (4–8 digits, keep it secret!)</span><input class="input" id="p-pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8"></label>
        <h3 style="margin:22px 0 12px">🧒 Kids</h3>
        <div id="kids">${kidRow(0)}${kidRow(1)}</div>
        <button class="btn ghost sm" id="add-kid">+ Add another kid</button>
        <div class="error" id="err"></div>
        <button class="btn block xl" id="go">Create our jars</button>
        <p class="muted small">You can add another parent and change everything later in Settings.</p>
      </div></div>`;
    settleJars();
    const wireSw = () => $$(".swatches").forEach((g) => (g.onclick = (e) => { const s = e.target.closest(".swatch"); if (!s) return; $$(".swatch", g).forEach((x) => x.classList.remove("on")); s.classList.add("on"); }));
    wireSw();
    $("#add-kid").onclick = () => { $("#kids").insertAdjacentHTML("beforeend", kidRow($$("[data-kid]").length)); wireSw(); };
    $("#go").onclick = (e) => guard(e.currentTarget, async () => {
      const kids = $$("[data-kid]").map((k) => ({
        name: $('[data-k="name"]', k).value.trim(),
        color: ($(".swatch.on", k) || {}).dataset?.v,
      })).filter((k) => k.name);
      if (!kids.length) throw new Error("Add at least one kid");
      await api("POST", "/api/setup", { parent: { name: $("#p-name").value, pin: $("#p-pin").value }, kids });
      toast("All set! 🎉", "good");
      boot();
    }).catch(() => {});
  }

  // ------------------------------------------------------------ login
  async function renderLogin() {
    let profiles = [];
    try { profiles = await api("GET", "/api/profiles"); } catch (_) { /* ignore */ }
    const kids = profiles.filter((p) => p.role === "kid");
    const parents = profiles.filter((p) => p.role === "parent");
    const tile = (p) => `<button class="profile-tile" data-id="${p.id}" style="--c:${p.color}">
        ${p.role === "kid" ? jarSVG(0.55, p.color, 64) : `<div class="avatar lg" style="--c:${p.color}">${initial(p.name)}</div>`}
        <div class="name">${esc(p.name)}</div><div class="role">${p.role === "kid" ? "Kid" : "Parent"}</div></button>`;
    app.innerHTML = `<div class="center-wrap">
      <div class="brand-head">${jarSVG(0.7, "#5B4BDB", 80)}<h1>Karma <b>Jar</b></h1><div class="muted" style="font-weight:700">Who's here?</div></div>
      <div class="profiles">${kids.map(tile).join("")}</div>
      <div class="section-title" style="width:100%;max-width:620px">Parents</div>
      <div class="profiles">${parents.map(tile).join("")}</div>
    </div>`;
    settleJars();
    $$(".profile-tile").forEach((t) => (t.onclick = () => {
      const p = profiles.find((x) => x.id == t.dataset.id);
      if (p.role !== "kid") return pinPad(p);
      guard(t, async () => { await api("POST", "/api/login", { user_id: p.id }); S.me = p; await refresh(); });
    }));
  }

  function pinPad(p) {
    let pin = "";
    const keys = [1, 2, 3, 4, 5, 6, 7, 8, 9, "⌫", 0, "✓"];
    sheet(`Hi ${esc(p.name)}!`, `<div style="--c:${p.color}">
      <p class="muted" style="text-align:center;margin:0">Type your secret PIN</p>
      <div class="pin-dots" id="dots"></div>
      <div class="error" id="perr" style="text-align:center"></div>
      <div class="pinpad">${keys.map((k) => `<button data-k="${k}" class="${k === "✓" ? "ok" : ""}">${k}</button>`).join("")}</div></div>`, (el, close) => {
      const dots = $("#dots", el);
      const draw = () => { dots.innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<i class="${i < pin.length ? "on" : ""}"></i>`).join(""); };
      draw();
      let busy = false;
      const submit = async () => {
        if (pin.length < 4 || busy) return;
        busy = true;
        try {
          await api("POST", "/api/login", { user_id: p.id, pin });
          close();
          S.me = p;
          await refresh();
        } catch (e) {
          $("#perr", el).textContent = e.message;
          dots.classList.remove("shake"); void dots.offsetWidth; dots.classList.add("shake");
          pin = ""; draw();
        } finally { busy = false; }
      };
      $(".pinpad", el).onclick = (e) => {
        const b = e.target.closest("button"); if (!b) return;
        const k = b.dataset.k;
        if (k === "⌫") pin = pin.slice(0, -1);
        else if (k === "✓") return submit();
        else if (pin.length < 8) pin += k;
        $("#perr", el).textContent = "";
        draw();
      };
      const onKey = (e) => {
        if (!document.body.contains(el)) return document.removeEventListener("keydown", onKey);
        if (/^\d$/.test(e.key) && pin.length < 8) { pin += e.key; draw(); }
        else if (e.key === "Backspace") { pin = pin.slice(0, -1); draw(); }
        else if (e.key === "Enter") submit();
      };
      document.addEventListener("keydown", onKey);
    });
  }

  // ------------------------------------------------------------ KID VIEW
  const PUN_EMOJI = (t) => {
    const s = t.toLowerCase();
    if (/tablet|ipad|screen/.test(s)) return "📵";
    if (/tv|show|youtube/.test(s)) return "📺";
    if (/game|xbox|switch|playstation|roblox|minecraft/.test(s)) return "🎮";
    if (/phone/.test(s)) return "📱";
    if (/bed|sleep/.test(s)) return "🛏️";
    if (/sweet|candy|dessert|treat/.test(s)) return "🍬";
    if (/friend|play ?date|outside/.test(s)) return "🚪";
    return "⏳";
  };

  function renderKid() {
    const d = S.data, me = d.me;
    const frac = me.balance_cents / Math.max(me.jar_size_cents, 1);
    const key = "kj-last-bal-" + me.id;
    let lastBal = null;
    try { lastBal = localStorage.getItem(key); } catch (_) { /* storage blocked */ }
    const prevFrac = lastBal === null ? 0 : Number(lastBal) / Math.max(me.jar_size_cents, 1);
    const delta = lastBal === null ? 0 : me.balance_cents - Number(lastBal);
    try { localStorage.setItem(key, me.balance_cents); } catch (_) { /* storage blocked */ }

    const open = d.chores.filter((c) => ["todo", "denied"].includes(c.status));
    const waiting = d.chores.filter((c) => c.status === "submitted");
    const done = d.chores.filter((c) => ["approved", "missed"].includes(c.status)).slice(0, 8);
    const activeP = d.punishments.filter((p) => p.status === "active");
    const pastP = d.punishments.filter((p) => p.status !== "active").slice(0, 5);

    const mateNames = (c) => (c.mates || []).map((m) => esc(m.name)).join(" & ");
    const choreCard = (c) => {
      const due = dueInfo(c);
      const mates = c.mates || [];
      const first = c.group_mode === "first" && mates.length > 0;
      const notYet = first ? [] : mates.filter((m) => !["submitted", "approved"].includes(m.status));
      const withPill = first
        ? (["todo", "denied"].includes(c.status) ? `<span class="pill brand">🏃 First one gets it · ${mates.map((m) => esc(m.name)).join(" & ")} can too</span>` : "")
        : mates.length ? `<span class="pill brand">🤝 with ${mates.map((m) => esc(m.name) + (["submitted", "approved"].includes(m.status) ? " ✓" : "")).join(" & ")}</span>` : "";
      if (c.status === "submitted") return `<div class="card kid-chore waiting" style="--c:${me.color}">
          <div class="grow"><div class="title">${esc(c.title)}</div><div class="sub">${notYet.length
            ? `<span class="pill warn">⏳ Waiting for ${notYet.map((m) => esc(m.name)).join(" & ")} to finish too</span>`
            : `<span class="pill warn">⏳ Waiting for a parent to check</span>`}${withPill}</div></div>
          <div class="right">${c.value_cents ? `<div class="value">${money0(c.value_cents)}</div>` : ""}<button class="btn plain sm" data-undo="${c.id}">Oops, undo</button></div></div>`;
      if (c.status === "approved") return `<div class="card kid-chore done"><div class="grow"><div class="title">✅ ${esc(c.title)}</div>
          <div class="sub"><span class="pill good">Approved ${c.value_cents ? "· +" + money0(c.value_cents) : ""}</span>${c.parent_note ? `<span>“${esc(c.parent_note)}”</span>` : ""}</div></div></div>`;
      if (c.status === "missed") return `<div class="card kid-chore done" style="border-left-color:#ccc"><div class="grow"><div class="title">${esc(c.title)}</div><div class="sub"><span class="pill">Missed</span></div></div></div>`;
      return `<div class="card kid-chore ${c.status === "denied" ? "denied" : ""}" style="--c:${me.color}">
          <div class="grow"><div class="title">${esc(c.title)}</div>
          <div class="sub">${withPill}${sourcePill(c)}${due ? `<span class="pill ${due.cls}">${due.text}</span>` : ""}${c.repeat !== "none" ? `<span class="pill brand">🔁 ${c.repeat}</span>` : ""}</div>
          ${c.notes ? `<div class="muted" style="margin-top:6px">${esc(c.notes)}</div>` : ""}
          ${c.status === "denied" ? `<div class="pill bad" style="margin-top:8px;white-space:normal">↩️ Try again${c.parent_note ? ": " + esc(c.parent_note) : ""}</div>` : ""}</div>
          <div class="right">${c.value_cents ? `<div class="value">${money0(c.value_cents)}</div>` : ""}<button class="btn good" data-done="${c.id}">I did it! ✋</button></div></div>`;
    };

    const punCard = (p) => {
      const isActive = p.status === "active";
      return `<div class="card consequence ${isActive ? "" : "over"}">
        <div class="emoji">${PUN_EMOJI(p.title)}</div>
        <div class="grow"><div class="title">${esc(p.title)}</div>
          ${p.reason ? `<div class="muted">${esc(p.reason)}</div>` : ""}
          <div class="row" style="margin-top:6px;gap:6px;flex-wrap:wrap">${p.mates?.length ? `<span class="pill brand">🤝 with ${mateNames(p)}</span>` : ""}${p.status === "cancelled" ? `<span class="pill good">Cancelled${p.fine_cents ? " · " + money0(p.fine_cents) + " back in jar" : ""}</span>` : p.fine_cents ? `<span class="pill bad">−${money0(p.fine_cents)} from jar</span>` : ""}</div></div>
        ${p.duration_minutes && p.status !== "cancelled" ? (isActive ? `<div class="timer" data-ends="${p.ends_at}">${fmtDur(new Date(p.ends_at) - nowMs())} left</div>` : `<div class="timer">Over ✓</div>`) : ""}
      </div>`;
    };

    const ledgerIcon = { chore: "✅", fine: "⚠️", refund: "↩️", payout: "💵", bonus: "🎁", adjust: "✏️" };
    const goalText = me.goal_label ? `Saving for: <b>${esc(me.goal_label)}</b>` : `Jar holds ${money0(me.jar_size_cents)}`;

    app.innerHTML = `<div class="kid-app" style="--c:${me.color}">
      <div class="kid-top"><div class="avatar" style="--c:${me.color}">${initial(me.name)}</div><h1>Hi ${esc(me.name)}! 👋</h1><button class="btn plain sm" id="logout">Switch user</button></div>
      <div class="kid-grid">
        <div class="card kid-jar-card">
          <div style="display:flex;justify-content:center" id="bigjar">${jarSVG(frac, me.color, 210, delta ? prevFrac : 0, "big" + me.id)}</div>
          <div class="amt ${me.balance_cents < 0 ? "neg" : ""}">${money(me.balance_cents)}</div>
          <div class="goal">${me.balance_cents < 0 ? "Your jar is in the red. Do chores to fill it back up!" : frac >= 1 ? "🎉 Your jar is FULL!" : goalText}</div>
          <div class="progress"><i style="width:${Math.max(0, Math.min(100, frac * 100))}%"></i></div>
          <div class="muted small">${money0(Math.max(0, me.jar_size_cents - me.balance_cents))} to go · Earned ${money0(me.earned_cents)} so far</div>
        </div>
        <div>
          ${activeP.length ? `<div class="section-title" style="margin-top:4px">🚫 Right now</div><div class="list">${activeP.map(punCard).join("")}</div>` : ""}
          <div class="section-title" ${activeP.length ? "" : 'style="margin-top:4px"'}>🧹 My chores ${open.length ? `<span class="badge" style="background:${me.color}">${open.length}</span>` : ""}</div>
          <div class="list">${open.length ? open.map(choreCard).join("") : `<div class="card empty"><span class="big">🌟</span>All done! Nothing to do right now.</div>`}</div>
          ${waiting.length ? `<div class="section-title">⏳ Waiting for a check</div><div class="list">${waiting.map(choreCard).join("")}</div>` : ""}
          ${done.length ? `<div class="section-title">✅ Recently done</div><div class="list">${done.map(choreCard).join("")}</div>` : ""}
          ${pastP.length ? `<div class="section-title">Past consequences</div><div class="list">${pastP.map(punCard).join("")}</div>` : ""}
          <div class="section-title">🫙 Jar history</div>
          <div class="card">${d.ledger.length ? d.ledger.slice(0, 15).map((e) => `<div class="ledger-row"><div class="ico">${ledgerIcon[e.kind] || "•"}</div>
              <div class="grow"><div style="font-weight:700">${esc(e.note || e.kind)}</div><div class="muted small">${fmtDate(e.created_at)}</div></div>
              <div class="amt ${e.amount_cents >= 0 ? "pos" : "neg"}">${e.amount_cents >= 0 ? "+" : ""}${money(e.amount_cents)}</div></div>`).join("") : `<div class="empty">Your jar is waiting for its first coins!</div>`}</div>
        </div>
      </div></div>`;

    settleJars();
    if (delta > 0) { setTimeout(() => { floatAmount(delta); coinRain(); $("#bigjar .jar")?.classList.add("bump"); }, 300); }
    else if (delta < 0) setTimeout(() => floatAmount(delta), 300);

    $("#logout").onclick = logout;
    $$("[data-done]").forEach((b) => (b.onclick = () => {
      const c = d.chores.find((x) => x.id == b.dataset.done);
      sheet("Did you finish?", `<p style="font-size:1.15rem;font-weight:800;margin-top:0">${esc(c.title)}</p>
        <label class="field"><span>Anything to tell your parents? (optional)</span><textarea class="input" id="knote" maxlength="300" placeholder="I also cleaned under the bed!"></textarea></label>
        <div class="sheet-actions"><button class="btn plain" data-close>Not yet</button><button class="btn good xl" id="send">Yes, I did it! ✋</button></div>`, (el, close) => {
        $("#send", el).onclick = (e) => guard(e.currentTarget, async () => {
          await api("POST", `/api/chores/${c.id}/submit`, { note: $("#knote", el).value });
          close(); toast("Sent! A parent will check it soon 👍", "good"); await refresh();
        });
      });
    }));
    $$("[data-undo]").forEach((b) => (b.onclick = () => guard(b, async () => { await api("POST", `/api/chores/${b.dataset.undo}/undo`); await refresh(); })));
  }

  // ------------------------------------------------------------ PARENT VIEW
  const kidById = (id) => S.data.kids.find((k) => k.id === id) || { name: "?", color: "#ccc" };

  // "Together" chores/consequences are stored as one row per kid with a shared group_id.
  // The parent sees each group as ONE item ({...firstRow, rows: [...]}); actions on it act on all rows.
  function grouped(list) {
    const out = [], byGid = {};
    for (const x of list) {
      if (x.group_id && byGid[x.group_id]) { byGid[x.group_id].rows.push(x); continue; }
      const it = { ...x, rows: [x] };
      if (x.group_id) byGid[x.group_id] = it;
      out.push(it);
    }
    for (const it of out) if (it.rows.length > 1) it.status = groupStatus(it.rows.map((r) => r.status));
    return out;
  }
  function groupStatus(all) {
    const st = all.filter((x) => x !== "taken"); // "first one" chores: the others' rows don't count
    if (!st.length) return "approved";
    if (st.every((x) => x === st[0])) return st[0];
    if (st.includes("active")) return "active";
    if (st.includes("denied")) return "denied";
    return "todo"; // some kids marked it done, others not yet
  }
  const stripeStyle = (it) => it.rows.length > 1 ? `style="background:linear-gradient(${it.rows.map((r) => kidById(r.kid_id).color).join(",")})"` : "";
  const isFirst = (it) => it.rows.length > 1 && it.group_mode === "first";
  const each = (it) => (it.rows.length > 1 && !isFirst(it) ? " each" : "");
  const doer = (it) => it.rows.find((r) => ["submitted", "approved"].includes(r.status)); // who did a "first one" chore
  const payeeNames = (it) => (isFirst(it) ? [doer(it)].filter(Boolean) : it.rows).map((r) => kidById(r.kid_id).name).join(" & ");
  const CHORE_MODES = [["each", "Each on their own"], ["together", "🤝 Together, all must finish"], ["first", "🏃 First one to do it"]];

  function renderParent() {
    const d = S.data;
    S.items = { chores: grouped(d.chores), puns: grouped(d.punishments) };
    const pending = S.items.chores.filter((c) => c.status === "submitted");
    const tabs = [
      ["home", "🏠", "Home", pending.length],
      ["chores", "🧹", "Chores", 0],
      ["cons", "⏳", "Consequences", S.items.puns.filter((p) => p.status === "active").length],
      ["money", "🫙", "Jars", 0],
      ["settings", "⚙️", "Settings", 0],
    ];
    const titles = { home: "Karma Jar", chores: "Chores", cons: "Consequences", money: "Jars & money", settings: "Settings" };
    const body = { home: pHome, chores: pChores, cons: pCons, money: pMoney, settings: pSettings }[S.tab]();
    const fab = { home: "add", chores: "chore", cons: "cons" }[S.tab];
    app.innerHTML = `<div class="p-top"><h1>${S.tab === "home" ? jarSVG(0.7, "#5B4BDB", 26) : ""}${titles[S.tab]}</h1>
        <div class="avatar" style="--c:${d.me.color};width:34px;height:34px;font-size:.9rem" title="${esc(d.me.name)}">${initial(d.me.name)}</div></div>
      <div class="p-main">${body}</div>
      ${fab ? `<button class="fab" id="fab" aria-label="Add">+</button>` : ""}
      <nav class="tabbar">${tabs.map(([k, i, l, n]) => `<button data-tab="${k}" class="${S.tab === k ? "on" : ""}"><span class="ti">${i}</span>${l}${n ? `<span class="badge" ${k === "cons" ? 'style="background:var(--warn)"' : ""}>${n}</span>` : ""}</button>`).join("")}</nav>`;
    settleJars();
    $$(".tabbar button").forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; render(); window.scrollTo(0, 0); }));
    if (fab) $("#fab").onclick = () => (fab === "chore" ? choreForm() : fab === "cons" ? consForm() : addMenu());
    wireParent();
  }

  function addMenu() {
    sheet("Add something", `<div class="action-list">
      <button class="btn xl" id="m-chore" style="justify-content:flex-start">🧹 New chore</button>
      <button class="btn xl bad" id="m-cons" style="justify-content:flex-start">⏳ New consequence</button>
      <button class="btn xl soft-good" id="m-bonus" style="justify-content:flex-start">🎁 Bonus / adjust money</button></div>`, (el, close) => {
      $("#m-chore", el).onclick = () => { close(); choreForm(); };
      $("#m-cons", el).onclick = () => { close(); consForm(); };
      $("#m-bonus", el).onclick = () => { close(); adjustForm(); };
    });
  }

  // --- reusable item renderers
  function choreItem(c, { actions = true } = {}) {
    const due = dueInfo(c);
    const open = ["todo", "denied"].includes(c.status);
    const dd = isFirst(c) && doer(c);
    const who = isFirst(c)
      ? `<span class="pill brand">🏃 ${dd ? (dd.status === "submitted" ? "✓ " : "") + esc(kidById(dd.kid_id).name) : c.rows.map((r) => esc(kidById(r.kid_id).name)).join(" or ")}</span>`
      : c.rows.length > 1
      ? `<span class="pill brand">🤝 ${c.rows.map((r) => (open ? (r.status === "submitted" ? "✓ " : "⏳ ") : "") + esc(kidById(r.kid_id).name)).join(open ? " · " : " + ")}</span>`
      : `<b style="color:var(--ink)">${esc(kidById(c.kid_id).name)}</b>`;
    const kidNotes = c.rows.filter((r) => r.kid_note).map((r) => `<div class="note">💬 ${c.rows.length > 1 ? esc(kidById(r.kid_id).name) + ": " : ""}“${esc(r.kid_note)}”</div>`).join("");
    const st = {
      todo: `<span class="pill">To do</span>`, denied: `<span class="pill bad">Sent back</span>`, submitted: `<span class="pill warn">Needs review</span>`,
      approved: `<span class="pill good">Approved</span>`, missed: `<span class="pill">Missed</span>`,
    }[c.status];
    let act = "";
    if (actions && c.status === "submitted") act = `<div class="actions"><button class="btn good sm" data-approve="${c.id}">✓ Approve${c.value_cents ? " +" + money0(c.value_cents) + each(c) : ""}</button><button class="btn soft-bad sm" data-deny="${c.id}">✕ Send back</button></div>`;
    return `<div class="card item tap" data-chore="${c.id}" style="--c:${kidById(c.kid_id).color}"><div class="stripe" ${stripeStyle(c)}></div><div class="grow">
      <div class="row"><div class="title grow">${esc(c.title)}</div>${c.value_cents ? `<span class="pill money">${money0(c.value_cents)}${each(c)}</span>` : ""}</div>
      <div class="sub">${who}${st}${sourcePill(c)}${due ? `<span class="pill ${due.cls}">${due.text}</span>` : ""}${c.repeat !== "none" ? `<span class="pill brand">🔁 ${c.repeat}</span>` : ""}
        ${c.status === "submitted" && c.submitted_at ? `<span>done ${fmtDate(c.submitted_at)}</span>` : ""}</div>
      ${kidNotes}
      ${c.parent_note && c.status !== "submitted" ? `<div class="note">📝 ${esc(c.parent_note)}</div>` : ""}
      ${act}</div></div>`;
  }

  function punItem(p) {
    const active = p.status === "active";
    const who = p.rows.length > 1 ? `<span class="pill brand">🤝 ${p.rows.map((r) => esc(kidById(r.kid_id).name)).join(" + ")}</span>` : `<b style="color:var(--ink)">${esc(kidById(p.kid_id).name)}</b>`;
    return `<div class="card item tap" data-pun="${p.id}" style="--c:${kidById(p.kid_id).color}"><div class="stripe" ${stripeStyle(p)}></div><div class="grow">
      <div class="row"><div class="title grow">${PUN_EMOJI(p.title)} ${esc(p.title)}</div>${active ? `<span class="pill bad timer" data-ends="${p.ends_at}">${fmtDur(new Date(p.ends_at) - nowMs())} left</span>` : ""}</div>
      <div class="sub">${who}
        ${p.fine_cents ? (p.status === "cancelled" ? `<span class="pill good">${money0(p.fine_cents)}${each(p)} refunded</span>` : `<span class="pill bad">−${money0(p.fine_cents)}${each(p)}</span>`) : ""}
        ${p.duration_minutes ? `<span class="pill">⏱ ${fmtMinutes(p.duration_minutes)}</span>` : ""}
        ${p.status === "cancelled" ? `<span class="pill good">Cancelled</span>` : !active ? `<span class="pill">${p.duration_minutes ? "Ended" : "Applied"}</span>` : ""}
        <span>${fmtDate(p.created_at)}</span></div>
      ${p.reason ? `<div class="note">${esc(p.reason)}</div>` : ""}</div></div>`;
  }

  function kidCard(k) {
    const active = S.data.punishments.filter((p) => p.kid_id === k.id && p.status === "active").length;
    const pend = S.items.chores.filter((c) => c.status === "submitted" && c.rows.some((r) => r.kid_id === k.id)).length;
    const todo = S.data.chores.filter((c) => c.kid_id === k.id && ["todo", "denied"].includes(c.status)).length;
    return `<div class="card kid-card tap" data-kidcard="${k.id}" style="--c:${k.color}">
      ${jarSVG(k.balance_cents / Math.max(k.jar_size_cents, 1), k.color, 80, 0, "card" + k.id)}
      <div style="font-weight:800">${esc(k.name)}</div>
      <div class="amt ${k.balance_cents < 0 ? "neg" : ""}">${money(k.balance_cents)}</div>
      <div class="meta">${todo ? `<span class="pill">${todo} to do</span>` : ""}${pend ? `<span class="pill warn">${pend} to check</span>` : ""}${active ? `<span class="pill bad">${active} active</span>` : ""}</div></div>`;
  }

  // --- tabs
  function pHome() {
    const d = S.data;
    const pending = S.items.chores.filter((c) => c.status === "submitted");
    const late = S.items.chores.filter((c) => ["todo", "denied"].includes(c.status) && c.due_at && new Date(c.due_at) < nowMs());
    const active = S.items.puns.filter((p) => p.status === "active");
    return `<div class="kid-cards">${d.kids.map(kidCard).join("") || `<div class="card empty">No kids yet. Add them in Settings.</div>`}</div>
      <div class="section-title">Needs your review ${pending.length ? `<span class="badge">${pending.length}</span>` : ""}</div>
      <div class="list">${pending.length ? pending.map((c) => choreItem(c)).join("") : `<div class="card empty"><span class="big">☕</span>Nothing to review.</div>`}</div>
      ${late.length ? `<div class="section-title">Late</div><div class="list">${late.map((c) => choreItem(c)).join("")}</div>` : ""}
      ${active.length ? `<div class="section-title">Active consequences</div><div class="list">${active.map(punItem).join("")}</div>` : ""}`;
  }

  function kidFilterBar() {
    return `<div class="filter-bar" id="kf"><button class="chip ${S.kidFilter === "all" ? "on" : ""}" data-kf="all">Everyone</button>
      ${S.data.kids.map((k) => `<button class="chip kidchip ${S.kidFilter == k.id ? "on" : ""}" style="--c:${k.color}" data-kf="${k.id}"><span class="dot"></span>${esc(k.name)}</button>`).join("")}</div>`;
  }
  const byKid = (x) => S.kidFilter === "all" || x.rows.some((r) => r.kid_id == S.kidFilter);

  function pChores() {
    const cs = S.items.chores.filter(byKid);
    const groups = [
      ["Needs review", cs.filter((c) => c.status === "submitted")],
      ["To do", cs.filter((c) => ["todo", "denied"].includes(c.status))],
      ["Finished (last 30 days)", cs.filter((c) => ["approved", "missed"].includes(c.status))],
    ];
    return kidFilterBar() + (cs.length ? groups.filter(([, l]) => l.length).map(([t, l]) => `<div class="section-title">${t}</div><div class="list">${l.map((c) => choreItem(c)).join("")}</div>`).join("")
      : `<div class="card empty" style="margin-top:10px"><span class="big">🧹</span>No chores yet. Tap + to add one.</div>`);
  }

  function pCons() {
    const ps = S.items.puns.filter(byKid);
    const act = ps.filter((p) => p.status === "active"), past = ps.filter((p) => p.status !== "active");
    return kidFilterBar() + `<div class="section-title">Active now</div><div class="list">${act.length ? act.map(punItem).join("") : `<div class="card empty"><span class="big">😇</span>No active consequences.</div>`}</div>
      ${past.length ? `<div class="section-title">History (last 30 days)</div><div class="list">${past.map(punItem).join("")}</div>` : ""}`;
  }

  function pMoney() {
    const d = S.data;
    const icon = { chore: "✅", fine: "⚠️", refund: "↩️", payout: "💵", bonus: "🎁", adjust: "✏️" };
    return d.kids.map((k) => {
      const led = d.ledger.filter((e) => e.kid_id === k.id).slice(0, 12);
      return `<div class="card money-card" style="margin-bottom:14px;border-top:6px solid ${k.color}">
        <div class="row">${jarSVG(k.balance_cents / Math.max(k.jar_size_cents, 1), k.color, 64, 0, "money" + k.id)}<div class="grow"><div style="font-weight:800">${esc(k.name)}'s jar</div>
          <div class="big" style="color:${k.balance_cents < 0 ? "var(--bad)" : "var(--ink)"}">${money(k.balance_cents)}</div><div class="muted small">waiting to be paid${k.goal_label ? " · saving for " + esc(k.goal_label) : ""}</div></div></div>
        <div class="stats"><div><b>${money0(k.earned_cents)}</b><span>Earned</span></div><div><b>${money0(k.paid_cents)}</b><span>Paid out</span></div><div><b>${money0(k.fined_cents)}</b><span>Fines</span></div></div>
        <div class="row"><button class="btn good grow" data-pay="${k.id}" ${k.balance_cents <= 0 ? "disabled" : ""}>💵 Mark as paid</button><button class="btn plain" data-adjust="${k.id}">🎁 Bonus / adjust</button></div>
        ${led.length ? `<div style="margin-top:12px">${led.map((e) => `<div class="ledger-row"><div class="ico">${icon[e.kind] || "•"}</div><div class="grow"><div style="font-weight:700">${esc(e.note || e.kind)}</div><div class="muted small">${fmtDate(e.created_at)}</div></div>
          <div class="amt ${e.amount_cents >= 0 ? "pos" : "neg"}">${e.amount_cents >= 0 ? "+" : ""}${money(e.amount_cents)}</div>
          ${["payout", "bonus", "adjust"].includes(e.kind) ? `<button class="icon-btn" style="width:30px;height:30px;font-size:.8rem" data-delledger="${e.id}" title="Undo">↩</button>` : ""}</div>`).join("")}</div>` : ""}
      </div>`;
    }).join("") || `<div class="card empty">No kids yet.</div>`;
  }

  function pSettings() {
    const d = S.data;
    return `<div class="section-title">Kids</div><div class="list">${d.kids.map((k) => `<div class="card item tap" data-edituser="${k.id}"><div class="avatar" style="--c:${k.color}">${initial(k.name)}</div>
        <div class="grow"><div class="title">${esc(k.name)}</div><div class="sub">Jar size ${money0(k.jar_size_cents)}${k.goal_label ? " · " + esc(k.goal_label) : ""}</div></div><span class="muted">›</span></div>`).join("")}
        <button class="btn ghost" data-adduser="kid">+ Add kid</button></div>
      <div class="section-title">Parents</div><div class="list">${d.parents.map((p) => `<div class="card item tap" data-edituser="${p.id}"><div class="avatar" style="--c:${p.color}">${initial(p.name)}</div>
        <div class="grow"><div class="title">${esc(p.name)} ${p.id === d.me.id ? '<span class="pill brand">You</span>' : ""}</div><div class="sub">Change name or PIN</div></div><span class="muted">›</span></div>`).join("")}
        <button class="btn ghost" data-adduser="parent">+ Add parent</button></div>
      <div class="section-title">API tokens</div><div class="list">${(d.tokens || []).map((t) => `<div class="card item"><div class="avatar" style="--c:#5B4BDB">🔑</div>
        <div class="grow"><div class="title">${esc(t.name)}</div><div class="sub">${t.last_used_at ? "Last used " + fmtDate(t.last_used_at) : "Not used yet"}</div></div>
        <button class="btn soft-bad sm" data-revoke="${t.id}">Revoke</button></div>`).join("")}
        <button class="btn ghost" id="new-token">+ New token</button></div>
      <div class="section-title">This device</div>
      <div class="card"><p class="muted" style="margin-top:0">To install: open the browser menu and choose <b>Add to Home Screen</b> (iPhone/iPad: Share → Add to Home Screen).</p>
        <button class="btn soft-bad block" id="logout">Log out</button></div>
      <p class="muted small" style="text-align:center;margin-top:24px">Karma Jar 🫙 v1.0</p>`;
  }

  function wireParent() {
    const d = S.data;
    $$("[data-kf]").forEach((b) => (b.onclick = () => { S.kidFilter = b.dataset.kf; render(); }));
    const chore = (id) => S.items.chores.find((c) => c.id == id), pun = (id) => S.items.puns.find((p) => p.id == id);
    $$("[data-approve]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); approve(chore(b.dataset.approve), b); }));
    $$("[data-deny]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); denyForm(chore(b.dataset.deny)); }));
    $$("[data-chore]").forEach((el) => (el.onclick = () => choreActions(chore(el.dataset.chore))));
    $$("[data-pun]").forEach((el) => (el.onclick = () => punActions(pun(el.dataset.pun))));
    $$("[data-kidcard]").forEach((el) => (el.onclick = () => { S.tab = "money"; render(); }));
    $$("[data-pay]").forEach((b) => (b.onclick = () => payForm(kidById(Number(b.dataset.pay)))));
    $$("[data-adjust]").forEach((b) => (b.onclick = () => adjustForm(Number(b.dataset.adjust))));
    $$("[data-delledger]").forEach((b) => (b.onclick = async () => {
      if (await confirmSheet("Undo this entry?", "It will be removed from the jar history and the balance will be recalculated.", "Undo it")) guard(b, async () => { await api("DELETE", `/api/ledger/${b.dataset.delledger}`); await refresh(); });
    }));
    $$("[data-edituser]").forEach((el) => (el.onclick = () => userForm([...d.kids, ...d.parents].find((u) => u.id == el.dataset.edituser))));
    $$("[data-adduser]").forEach((b) => (b.onclick = () => userForm(null, b.dataset.adduser)));
    $$("[data-revoke]").forEach((b) => (b.onclick = async () => {
      const t = (d.tokens || []).find((x) => x.id == b.dataset.revoke);
      if (await confirmSheet(`Revoke ${esc(t.name)}?`, "Anything using this token stops working.", "Revoke"))
        guard(null, async () => { await api("DELETE", `/api/tokens/${t.id}`); await refresh(); });
    }));
    const nt = $("#new-token"); if (nt) nt.onclick = tokenForm;
    const lo = $("#logout"); if (lo) lo.onclick = logout;
  }

  // --- actions
  async function approve(c, btn) {
    await guard(btn, async () => {
      await api("POST", `/api/chores/${c.id}/approve`, {});
      toast(`Approved${c.value_cents ? " · +" + money0(c.value_cents) + " to " + payeeNames(c) : ""} ✓`, "good");
      await refresh();
    });
  }

  function denyForm(c) {
    sheet("Send back?", `<p style="margin-top:0"><b>${esc(c.title)}</b> · ${c.rows.map((r) => esc(kidById(r.kid_id).name)).join(" & ")}</p>
      <label class="field"><span>What still needs doing? (they'll see this)</span><textarea class="input" id="dn" maxlength="300" placeholder="Toys are still on the floor"></textarea></label>
      <div class="sheet-actions"><button class="btn plain" data-close>Cancel</button><button class="btn bad" id="go">Send back</button></div>`, (el, close) => {
      $("#go", el).onclick = (e) => guard(e.currentTarget, async () => { await api("POST", `/api/chores/${c.id}/deny`, { note: $("#dn", el).value }); close(); toast("Sent back"); await refresh(); });
    });
  }

  function choreActions(c) {
    if (!c) return;
    const open = ["todo", "denied", "submitted"].includes(c.status);
    sheet(esc(c.title), `${choreItem(c, { actions: false }).replace("tap", "")}
      <div class="action-list" style="margin-top:14px">
        ${open ? `<button class="btn good" id="a-ok">✓ Approve${c.value_cents ? " · +" + money0(c.value_cents) + each(c) : ""}</button>` : ""}
        ${c.status === "submitted" ? `<button class="btn soft-bad" id="a-deny">✕ Send back</button>` : ""}
        ${["todo", "denied"].includes(c.status) ? `<button class="btn plain" id="a-miss">🙈 Mark as missed${c.repeat !== "none" ? " (next one gets scheduled)" : ""}</button>` : ""}
        ${open ? `<button class="btn plain" id="a-edit">✏️ Edit</button>` : ""}
        <button class="btn plain" id="a-dup">📄 Duplicate</button>
        <button class="btn soft-bad" id="a-del">🗑 Delete${c.status === "approved" && c.value_cents ? " (takes back " + money0(c.value_cents) + each(c) + ")" : ""}</button>
      </div>`, (el, close) => {
      const on = (id, fn) => { const b = $(id, el); if (b) b.onclick = fn; };
      on("#a-ok", (e) => { close(); approve(c, e.currentTarget); });
      on("#a-deny", () => { close(); denyForm(c); });
      on("#a-miss", (e) => guard(e.currentTarget, async () => { await api("POST", `/api/chores/${c.id}/missed`, {}); close(); await refresh(); }));
      on("#a-edit", () => { close(); choreForm(c); });
      on("#a-dup", () => { close(); choreForm({ ...c, id: null, due_at: null }); });
      on("#a-del", async () => { close(); if (await confirmSheet("Delete chore?", "This can't be undone.", "Delete")) guard(null, async () => { await api("DELETE", `/api/chores/${c.id}`); await refresh(); }); });
    });
  }

  function kidChips(selected = []) {
    return `<div class="chips" data-chips="multi" id="kids">${S.data.kids.map((k) => `<button type="button" class="chip kidchip ${selected.includes(k.id) ? "on" : ""}" style="--c:${k.color}" data-v="${k.id}"><span class="dot"></span>${esc(k.name)}</button>`).join("")}</div>`;
  }

  // "Each on their own" / "Together" / "First one" chips, only shown when 2+ kids are picked
  function modeChips(opts, sel) {
    return `<div class="chips" data-chips="single" id="tog" style="margin:-6px 0 14px">${opts.map(([v, l]) => `<button type="button" class="chip ${v === sel ? "on" : ""}" data-v="${v}">${l}</button>`).join("")}</div>`;
  }
  function wireTogether(el) {
    const tog = $("#tog", el), kids = $("#kids", el);
    if (!tog || !kids) return;
    const sync = () => tog.classList.toggle("hidden", chipVals(kids).length < 2);
    kids.addEventListener("change", sync);
    sync();
  }
  const modeVal = (el) => { const t = $("#tog", el); return t && !t.classList.contains("hidden") ? chipVals(t)[0] || "each" : "each"; };

  function quickDue(kind) {
    const d = new Date(nowMs());
    if (kind === "tonight") { d.setHours(20, 0, 0, 0); if (d < nowMs()) d.setDate(d.getDate() + 1); }
    if (kind === "tomorrow") { d.setDate(d.getDate() + 1); d.setHours(18, 0, 0, 0); }
    if (kind === "weekend") { let add = (6 - d.getDay() + 7) % 7; if (!add && d.getHours() >= 12) add = 7; d.setDate(d.getDate() + add); d.setHours(12, 0, 0, 0); }
    if (kind === "week") { let add = (7 - d.getDay()) % 7; if (!add && d.getHours() >= 20) add = 7; d.setDate(d.getDate() + add); d.setHours(20, 0, 0, 0); }
    return toLocalInput(d.toISOString());
  }

  function choreForm(c = null) {
    const edit = c && c.id;
    const kidsSel = c ? (c.rows || [c]).map((r) => r.kid_id) : S.kidFilter !== "all" ? [Number(S.kidFilter)] : S.data.kids.length === 1 ? [S.data.kids[0].id] : [];
    const modeSel = c && c.rows && c.rows.length > 1 ? c.group_mode || "together" : "each";
    sheet(edit ? "Edit chore" : "New chore", `
      <label class="field"><span>What needs doing?</span><input class="input" id="t" maxlength="80" value="${esc(c?.title || "")}" placeholder="Clean your room"></label>
      <div class="chips" style="margin:-6px 0 14px" id="sugg">${["Make bed", "Clean room", "Dishes", "Take out trash", "Feed the cat", "Homework", "Vacuum", "Laundry"].map((s) => `<button type="button" class="chip" data-s="${s}">${s}</button>`).join("")}</div>
      ${edit ? "" : `<label class="field"><span>For who?</span>${kidChips(kidsSel)}</label>
        ${modeChips(CHORE_MODES, modeSel)}`}
      <label class="field"><span>Reward</span><div class="money-input"><input class="input" id="v" inputmode="decimal" value="${c ? (c.value_cents / 100).toFixed(2) : ""}" placeholder="0.00"></div></label>
      <div class="chips" style="margin:-6px 0 14px" id="vq">${[0.5, 1, 2, 5, 10].map((v) => `<button type="button" class="chip" data-v="${v}">$${v < 1 ? v.toFixed(2) : v}</button>`).join("")}</div>
      <label class="field"><span>Deadline</span><input class="input" id="due" type="datetime-local" value="${toLocalInput(c?.due_at)}"></label>
      <div class="chips" style="margin:-6px 0 14px" id="dq"><button type="button" class="chip" data-d="tonight">Tonight 8pm</button><button type="button" class="chip" data-d="tomorrow">Tomorrow</button><button type="button" class="chip" data-d="weekend">Saturday</button><button type="button" class="chip" data-d="week">Sunday night</button><button type="button" class="chip" data-d="">No deadline</button></div>
      <label class="field"><span>Repeat</span><div class="chips" data-chips="single" id="rep">${["none", "daily", "weekly"].map((r) => `<button type="button" class="chip ${(c?.repeat || "none") === r ? "on" : ""}" data-v="${r}">${{ none: "Just once", daily: "🔁 Every day", weekly: "🔁 Every week" }[r]}</button>`).join("")}</div></label>
      <label class="field"><span>Notes (optional)</span><textarea class="input" id="n" maxlength="500" placeholder="Details for the kids">${esc(c?.notes || "")}</textarea></label>
      <div class="sheet-actions"><button class="btn plain" data-close>Cancel</button><button class="btn" id="save">${edit ? "Save" : "Add chore"}</button></div>`, (el, close) => {
      wireChips(el);
      wireTogether(el);
      $("#sugg", el).onclick = (e) => { const b = e.target.closest("[data-s]"); if (b) $("#t", el).value = b.dataset.s; };
      $("#vq", el).onclick = (e) => { const b = e.target.closest("[data-v]"); if (b) $("#v", el).value = Number(b.dataset.v).toFixed(2); };
      $("#dq", el).onclick = (e) => { const b = e.target.closest("[data-d]"); if (b) $("#due", el).value = b.dataset.d ? quickDue(b.dataset.d) : ""; };
      $("#save", el).onclick = (e) => guard(e.currentTarget, async () => {
        const payload = { title: $("#t", el).value, value: $("#v", el).value || 0, due_at: fromLocalInput($("#due", el).value), repeat: chipVals($("#rep", el))[0] || "none", notes: $("#n", el).value };
        if (edit) await api("PUT", `/api/chores/${c.id}`, payload);
        else await api("POST", "/api/chores", { ...payload, kid_ids: chipVals($("#kids", el)).map(Number), mode: modeVal(el) });
        close(); toast(edit ? "Saved" : "Chore added 🧹", "good"); await refresh();
      });
    });
  }

  function consForm() {
    const kidsSel = S.kidFilter !== "all" ? [Number(S.kidFilter)] : S.data.kids.length === 1 ? [S.data.kids[0].id] : [];
    const durs = [[0, "No timer"], [60, "1 hour"], [180, "3 hours"], [1440, "1 day"], [4320, "3 days"], [10080, "1 week"], ["custom", "Custom…"]];
    sheet("New consequence", `
      <label class="field"><span>For who?</span>${kidChips(kidsSel)}</label>
      ${modeChips([["each", "Separately"], ["together", "🤝 Together"]], "together")}
      <label class="field"><span>What's the consequence?</span><input class="input" id="t" maxlength="80" placeholder="No tablet"></label>
      <div class="chips" style="margin:-6px 0 14px" id="sugg">${["No tablet", "No TV", "No video games", "No phone", "Early bedtime", "No sweets", "Fine only"].map((s) => `<button type="button" class="chip" data-s="${s}">${s}</button>`).join("")}</div>
      <label class="field"><span>Why? (they'll see this)</span><input class="input" id="r" maxlength="300" placeholder="Talked back at dinner"></label>
      <label class="field"><span>⏱ Timer</span><div class="chips" data-chips="single" id="dur">${durs.map(([v, l], i) => `<button type="button" class="chip ${i === 1 ? "on" : ""}" data-v="${v}">${l}</button>`).join("")}</div></label>
      <div class="row hidden" id="custom" style="margin:-4px 0 14px"><input class="input" id="cn" inputmode="numeric" value="2" style="width:90px"><select class="input" id="cu"><option value="1">minutes</option><option value="60" selected>hours</option><option value="1440">days</option><option value="10080">weeks</option></select></div>
      <label class="field"><span>💸 Take money from jar</span><div class="money-input"><input class="input" id="f" inputmode="decimal" placeholder="0.00"></div></label>
      <div class="chips" style="margin:-6px 0 14px" id="fq">${[0, 0.5, 1, 2, 5].map((v) => `<button type="button" class="chip" data-v="${v}">${v ? "−$" + (v < 1 ? v.toFixed(2) : v) : "None"}</button>`).join("")}</div>
      <div class="sheet-actions"><button class="btn plain" data-close>Cancel</button><button class="btn bad" id="save">Give consequence</button></div>`, (el, close) => {
      wireChips(el);
      wireTogether(el);
      $("#sugg", el).onclick = (e) => { const b = e.target.closest("[data-s]"); if (!b) return; $("#t", el).value = b.dataset.s; if (b.dataset.s === "Fine only") { $$("#dur .chip", el).forEach((c) => c.classList.toggle("on", c.dataset.v === "0")); $("#custom", el).classList.add("hidden"); } };
      $("#fq", el).onclick = (e) => { const b = e.target.closest("[data-v]"); if (b) $("#f", el).value = Number(b.dataset.v) ? Number(b.dataset.v).toFixed(2) : ""; };
      $("#dur", el).addEventListener("change", () => $("#custom", el).classList.toggle("hidden", chipVals($("#dur", el))[0] !== "custom"));
      $("#save", el).onclick = (e) => guard(e.currentTarget, async () => {
        let dv = chipVals($("#dur", el))[0] || "0";
        const minutes = dv === "custom" ? Math.round(Number($("#cn", el).value) * Number($("#cu", el).value)) : Number(dv);
        await api("POST", "/api/punishments", { kid_ids: chipVals($("#kids", el)).map(Number), title: $("#t", el).value, reason: $("#r", el).value, fine: $("#f", el).value || 0, duration_minutes: minutes, together: modeVal(el) === "together" });
        close(); toast("Consequence given"); await refresh();
      });
    });
  }

  function punActions(p) {
    if (!p) return;
    const active = p.status === "active";
    sheet(esc(p.title), `${punItem(p).replace("tap", "")}
      <div class="action-list" style="margin-top:14px">
        ${active ? `<div class="row" style="flex-wrap:wrap;gap:8px"><b class="grow">Add time:</b>${[[60, "+1h"], [1440, "+1 day"], [10080, "+1 week"]].map(([m, l]) => `<button class="btn plain sm" data-ext="${m}">${l}</button>`).join("")}</div>
          <div class="row" style="flex-wrap:wrap;gap:8px"><b class="grow">Take off:</b>${[[-30, "−30m"], [-60, "−1h"], [-1440, "−1 day"]].map(([m, l]) => `<button class="btn plain sm" data-ext="${m}">${l}</button>`).join("")}</div>
          <button class="btn good" id="a-end">✓ End it now (good behavior!)</button>` : ""}
        ${p.status !== "cancelled" ? `<button class="btn soft-bad" id="a-cancel">✕ Cancel it${p.fine_cents ? " & refund " + money0(p.fine_cents) + each(p) : ""}</button>` : ""}
      </div>`, (el, close) => {
      $$("[data-ext]", el).forEach((b) => (b.onclick = () => guard(b, async () => { await api("POST", `/api/punishments/${p.id}/extend`, { minutes: Number(b.dataset.ext) }); close(); await refresh(); })));
      const end = $("#a-end", el); if (end) end.onclick = () => guard(end, async () => { await api("POST", `/api/punishments/${p.id}/end`); close(); toast("Ended", "good"); await refresh(); });
      const can = $("#a-cancel", el); if (can) can.onclick = async () => { close(); if (await confirmSheet("Cancel this consequence?", `It will be marked cancelled${p.fine_cents ? " and " + money0(p.fine_cents) + " goes back into the jar" : ""}.`, "Yes, cancel")) guard(null, async () => { await api("DELETE", `/api/punishments/${p.id}`); await refresh(); }); };
    });
  }

  function payForm(k) {
    sheet(`Pay ${esc(k.name)}`, `<p class="muted" style="margin-top:0">Jar has <b style="color:var(--ink)">${money(k.balance_cents)}</b>. How much did you give?</p>
      <label class="field"><span>Amount paid</span><div class="money-input"><input class="input" id="a" inputmode="decimal" value="${(Math.max(0, k.balance_cents) / 100).toFixed(2)}"></div></label>
      <label class="field"><span>Note (optional)</span><input class="input" id="n" maxlength="120" placeholder="Cash, Venmo, savings account…"></label>
      <div class="sheet-actions"><button class="btn plain" data-close>Cancel</button><button class="btn good" id="go">💵 Mark as paid</button></div>`, (el, close) => {
      $("#go", el).onclick = (e) => guard(e.currentTarget, async () => { await api("POST", "/api/payouts", { kid_id: k.id, amount: $("#a", el).value, note: $("#n", el).value ? "Paid: " + $("#n", el).value : "" }); close(); toast("Marked as paid 💵", "good"); await refresh(); });
    });
  }

  function adjustForm(kidId) {
    sheet("Bonus or adjustment", `<label class="field"><span>For who?</span>${kidChips(kidId ? [kidId] : [])}</label>
      <label class="field"><span>Type</span><div class="chips" data-chips="single" id="sign"><button type="button" class="chip on" data-v="1">🎁 Add money</button><button type="button" class="chip" data-v="-1">✏️ Take money</button></div></label>
      <label class="field"><span>Amount</span><div class="money-input"><input class="input" id="a" inputmode="decimal" placeholder="1.00"></div></label>
      <label class="field"><span>Reason</span><input class="input" id="n" maxlength="120" placeholder="Great report card!"></label>
      <div class="sheet-actions"><button class="btn plain" data-close>Cancel</button><button class="btn" id="go">Save</button></div>`, (el, close) => {
      wireChips(el);
      $("#go", el).onclick = (e) => guard(e.currentTarget, async () => {
        const ids = chipVals($("#kids", el)).map(Number);
        if (!ids.length) throw new Error("Pick a kid");
        const amt = Math.abs(Number($("#a", el).value || 0)) * Number(chipVals($("#sign", el))[0]);
        for (const id of ids) await api("POST", "/api/adjust", { kid_id: id, amount: amt, note: $("#n", el).value });
        close(); toast("Saved", "good"); await refresh();
      });
    });
  }

  function tokenForm() {
    sheet("New API token", `<label class="field"><span>Name</span><input class="input" id="tn" maxlength="40" value="Home Assistant"></label>
      <div class="chips" style="margin:-6px 0 14px" id="tq">${["Home Assistant", "Claude Code", "Duet"].map((n) => `<button type="button" class="chip" data-n="${n}">${n}</button>`).join("")}</div>
      <div class="sheet-actions"><button class="btn plain" data-close>Cancel</button><button class="btn" id="go">Create</button></div>`, (el, close) => {
      $("#tq", el).onclick = (e) => { const b = e.target.closest("[data-n]"); if (b) $("#tn", el).value = b.dataset.n; };
      $("#go", el).onclick = (e) => guard(e.currentTarget, async () => {
        const r = await api("POST", "/api/tokens", { name: $("#tn", el).value });
        close();
        showToken(r);
      });
    });
  }

  function showToken(r) {
    const copyBtn = (id) => `<button type="button" class="btn plain sm" data-copy="${id}">Copy</button>`;
    sheet(`${esc(r.name)} token`, `<p class="muted" style="margin-top:0">Copy it now. It won't be shown again.</p>
      <label class="field"><span>Token</span><div class="row"><input class="input grow" id="tok" readonly value="${esc(r.token)}">${copyBtn("tok")}</div></label>
      <label class="field"><span>API address</span><div class="row"><input class="input grow" id="url" readonly value="${esc(location.origin)}/api/ext">${copyBtn("url")}</div></label>
      <div class="sheet-actions"><button class="btn" data-close>Done</button></div>`, (el) => {
      $$("[data-copy]", el).forEach((b) => (b.onclick = async () => {
        const inp = $("#" + b.dataset.copy, el);
        inp.select();
        try { await navigator.clipboard.writeText(inp.value); } catch (_) { document.execCommand("copy"); } // clipboard API needs HTTPS
        toast("Copied", "good");
      }));
    });
    refresh().catch(() => {});
  }

  function userForm(u, role) {
    const isKid = u ? u.role !== "parent" && S.data.kids.some((k) => k.id === u.id) : role === "kid";
    const color = u?.color || COLORS[(S.data.kids.length + S.data.parents.length) % COLORS.length];
    sheet(u ? `Edit ${esc(u.name)}` : isKid ? "Add kid" : "Add parent", `
      <label class="field"><span>Name</span><input class="input" id="nm" maxlength="40" value="${esc(u?.name || "")}"></label>
      ${isKid ? "" : `<label class="field"><span>${u ? "New PIN (leave empty to keep)" : "PIN (4–8 digits)"}</span><input class="input" id="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8"></label>`}
      <label class="field"><span>Color</span><div class="swatches" id="sw">${COLORS.map((c) => `<button type="button" class="swatch ${c === color ? "on" : ""}" style="background:${c}" data-v="${c}"></button>`).join("")}</div></label>
      ${isKid ? `<label class="field"><span>Jar size (full jar = this much)</span><div class="money-input"><input class="input" id="jar" inputmode="decimal" value="${((u?.jar_size_cents || 2000) / 100).toFixed(2)}"></div></label>
        <label class="field"><span>Saving for (optional)</span><input class="input" id="goal" maxlength="60" value="${esc(u?.goal_label || "")}" placeholder="New LEGO set"></label>` : ""}
      <div class="sheet-actions">${u ? `<button class="btn soft-bad" id="del">Remove</button>` : `<button class="btn plain" data-close>Cancel</button>`}<button class="btn" id="save">Save</button></div>`, (el, close) => {
      $("#sw", el).onclick = (e) => { const s = e.target.closest(".swatch"); if (!s) return; $$(".swatch", el).forEach((x) => x.classList.remove("on")); s.classList.add("on"); };
      $("#save", el).onclick = (e) => guard(e.currentTarget, async () => {
        const payload = { name: $("#nm", el).value, pin: $("#pin", el)?.value || "", color: $(".swatch.on", el)?.dataset.v };
        if (isKid) Object.assign(payload, { jar_size: $("#jar", el).value, goal_label: $("#goal", el).value });
        if (u) await api("PUT", `/api/users/${u.id}`, payload);
        else await api("POST", "/api/users", { ...payload, role: isKid ? "kid" : "parent" });
        close(); toast("Saved", "good"); await refresh();
      });
      const del = $("#del", el);
      if (del) del.onclick = async () => {
        close();
        if (await confirmSheet(`Remove ${esc(u.name)}?`, isKid ? "This deletes their jar, chores and history for good." : "They won't be able to log in anymore.", "Remove"))
          guard(null, async () => { await api("DELETE", `/api/users/${u.id}`); await refresh(); });
      };
    });
  }

  // ------------------------------------------------------------ PWA
  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  }

  boot();
})();
