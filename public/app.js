// Market Tiles: the page. Plain JavaScript, no libraries, no build step.
// It reads three files from this site's own server (which caches the public Taskmarket API):
//   /api/core.json  /api/tasks.json  /api/feed.json
// and draws every view from them. Every number on the page is computed in this file from those rows.
(() => {
  "use strict";

  // ---------- small helpers ----------------------------------------------------------------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const n0 = (x) => Math.round(x).toLocaleString("en-US");
  const usd = (micro) => { const v = micro / 1e6; return v > 0 && v < 0.01 ? "under 1¢" : "$" + (v >= 100 ? n0(v) : v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })); };
  const pct = (a, b) => (b ? Math.round((100 * a) / b) + "%" : "0%");
  const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const median = (arr) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const groupBy = (arr, f) => { const m = new Map(); for (const x of arr) { const k = f(x); (m.get(k) || m.set(k, []).get(k)).push(x); } return m; };
  const DAY = 86400, MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dmy = (sec) => { const d = new Date(sec * 1000); return d.getUTCDate() + " " + MON[d.getUTCMonth()]; };
  const hm = (ms) => { const d = new Date(ms); return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0"); };
  const weekStart = (sec) => { const d = new Date(sec * 1000); const dow = (d.getUTCDay() + 6) % 7; return Math.floor(sec / DAY) * DAY - dow * DAY; }; // Monday 00:00 UTC
  const ago = (ms) => { const m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago"; };
  const until = (sec) => { const h = (sec * 1000 - Date.now()) / 3600000; return h <= 0 ? "closed" : h < 1 ? Math.round(h * 60) + " min" : h < 48 ? Math.round(h) + " h" : Math.round(h / 24) + " d"; };

  const CHAIN = { tempo: 4217, base: 8453 }, CHAIN_NAME = { 4217: "Tempo", 8453: "Base" }, COIN = { 4217: "OUSD", 8453: "USDC" };
  const OUT = ["Paid", "Open", "Not settled yet", "Ended unpaid"];
  const OUT_HELP = ["the poster accepted a result and the reward was released", "still taking entries", "claimed by a worker, or past its deadline with no decision yet", "expired or cancelled with nobody paid"];
  const VIEWS = {
    board: { path: "/", title: "Tiles", h: (c) => `Every task, one <em>tile</em> each.` },
    flow: { path: "/flow/", h: () => `Where the money <em>went.</em>` },
    swarm: { path: "/swarm/", h: () => `What agents are working on <em>now.</em>` },
    pulse: { path: "/pulse/", h: () => `The market, day by <em>day.</em>` },
    methods: { path: "/methods/", h: () => `How every number is <em>made.</em>` },
  };

  // ---------- state (kept in the address bar so any view can be linked) --------------------
  const q = new URLSearchParams(location.search);
  const state = {
    view: document.body.dataset.view || "board",
    chain: ["tempo", "base"].includes(q.get("chain")) ? q.get("chain") : "all",
    range: ["7d", "30d", "90d", "all"].includes(q.get("range")) ? q.get("range") : "30d",
    group: ["week", "poster", "outcome"].includes(q.get("group")) ? q.get("group") : "week",
    heat: q.get("heat") === "mode" ? "mode" : "hourOfWeek",
    card: q.get("card") === "1",
  };
  const D = { core: null, tasks: null, feed: null };
  const main = $("#main"), tip = $("#tip");

  function url(view = state.view, over = {}) {
    const s = { ...state, ...over }, p = new URLSearchParams();
    if (s.chain !== "all") p.set("chain", s.chain);
    if (view === "pulse" && s.range !== "30d") p.set("range", s.range);
    if (view === "pulse" && s.heat !== "hourOfWeek") p.set("heat", s.heat);
    if (view === "board" && s.group !== "week") p.set("group", s.group);
    if (s.card) p.set("card", "1");
    const qs = p.toString();
    return VIEWS[view].path + (qs ? "?" + qs : "");
  }
  function go(view, over = {}, push = true) {
    Object.assign(state, over, { view });
    if (push) history.pushState(null, "", url());
    document.body.dataset.view = view;
    render();
    if (push && over.scroll !== false && view !== undefined && over.view !== "same") window.scrollTo({ top: 0 });
  }
  function set(over) {
    if (state.view === "board" && ("group" in over || "chain" in over)) { bdFrom = new Map(); document.querySelectorAll(".wall .t").forEach((el) => { const r = el.getBoundingClientRect(); bdFrom.set(el.dataset.t, [r.left + scrollX, r.top + scrollY]); }); }
    Object.assign(state, over); history.replaceState(null, "", url()); render();
  }

  // ---------- data ----------------------------------------------------------------------------
  async function get(name) {
    const r = await fetch(`/api/${name}.json`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(name + " " + r.status);
    return r.json();
  }
  function shapeTasks(raw) {
    const out = [];
    for (const chain of [4217, 8453]) for (const r of raw[chain] || []) {
      const status = raw.status[r[9]] ?? r[9], phase = raw.phase[r[11]] ?? r[11];
      const o = status === "completed" ? 0 : status === "expired" || status === "cancelled" ? 3 : phase === "active" && status === "open" ? 1 : 2;
      out.push({ id: r[0], ref: r[1], title: r[2], req: r[3], win: r[4], awards: r[5], reward: r[6], created: r[7], expiry: r[8], status, mode: raw.mode[r[10]] ?? r[10], phase, entries: r[12], chain, o });
    }
    out.sort((a, b) => b.created - a.created);
    return out;
  }
  const src = (k) => D.core?.sources?.[k]?.data;
  const tasks = () => (D.tasks ? (state.chain === "all" ? D.tasks : D.tasks.filter((t) => t.chain === CHAIN[state.chain])) : []);
  const chainWord = () => (state.chain === "all" ? "both chains" : CHAIN_NAME[CHAIN[state.chain]]);
  const taskUrl = (t) => `https://taskmarket.dev/tasks/${t.id}?chain=${t.chain}`;

  // ---------- chrome: nav, chain switch, "data as of" -------------------------------------
  function chrome() {
    document.querySelectorAll("[data-nav]").forEach((a) => {
      const v = a.dataset.nav;
      a.setAttribute("href", url(v));
      if (a.closest(".views")) v === state.view ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
    });
    document.querySelectorAll("[data-chain]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.chain === state.chain)));
    const t = D.core?.asOf;
    if (t?.headline) {
      $("#asof").innerHTML = `Data as of <b>${hm(t.headline)} UTC</b>, ${new Date(t.headline).getUTCDate()} ${MON[new Date(t.headline).getUTCMonth()]} ${new Date(t.headline).getUTCFullYear()} (${ago(t.headline)}). Fetched by this site's server from api.taskmarket.dev; refreshed every minute.`;
    }
  }
  document.addEventListener("click", (e) => {
    const a = e.target.closest("[data-nav]");
    if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); go(a.dataset.nav); return; }
    const c = e.target.closest("[data-chain]");
    if (c) { set({ chain: c.dataset.chain }); return; }
    const s = e.target.closest("[data-set]");
    if (s) { set(JSON.parse(s.dataset.set)); return; }
    const sh = e.target.closest(".share");
    if (sh) share(sh);
  });
  addEventListener("popstate", () => { const p = location.pathname.replace(/\/+$/, "") || "/"; const v = Object.keys(VIEWS).find((k) => (VIEWS[k].path.replace(/\/+$/, "") || "/") === p) || "board"; const qq = new URLSearchParams(location.search); state.chain = ["tempo", "base"].includes(qq.get("chain")) ? qq.get("chain") : "all"; go(v, {}, false); });

  async function share(btn) {
    const link = location.origin + url();
    try {
      if (navigator.share && matchMedia("(pointer:coarse)").matches) await navigator.share({ title: document.title, url: link });
      else { await navigator.clipboard.writeText(link); btn.textContent = "Link copied"; setTimeout(() => (btn.textContent = "Copy link to this view"), 1600); }
    } catch { prompt("Link to this view", link); }
  }

  // ---------- tooltip (one element, used by every chart) ----------------------------------
  let tipFor = null;
  function showTip(html, el) { tip.innerHTML = html; tip.hidden = false; tipFor?.classList.remove("on"); tipFor = el; el?.classList.add("on"); }
  function hideTip() { tip.hidden = true; tipFor?.classList.remove("on"); tipFor = null; }
  main.addEventListener("pointerover", (e) => {
    const el = e.target.closest("[data-tip],[data-t]");
    if (!el) return hideTip();
    if (el.dataset.t) { const t = D.tasks[+el.dataset.t]; showTip(taskTip(t), el); } else showTip(el.dataset.tip, el);
  });
  main.addEventListener("pointerleave", hideTip);
  const taskTip = (t) => `<b>${esc(t.title || t.ref)}</b><span>${t.ref} · ${CHAIN_NAME[t.chain]} · ${t.mode}</span><span>${usd(t.reward)} ${COIN[t.chain]} · ${n0(t.entries)} ${t.entries === 1 ? "entry" : "entries"}</span><span>${OUT[t.o]} · posted ${dmy(t.created)} by ${short(t.req)}</span>`;

  // ---------- shared pieces -------------------------------------------------------------------
  const seg = (key, opts, cur) => `<span class="seg" role="group">${opts.map(([v, l]) => `<button type="button" aria-pressed="${v === cur}" data-set='${JSON.stringify({ [key]: v })}'>${l}</button>`).join("")}</span>`;
  const head = (lede) => `<h1 class="headline">${VIEWS[state.view].h()}</h1><p class="lede">${lede}</p>`;
  const facts = (list) => `<div class="facts">${list.filter(Boolean).map(([v, p]) => `<div class="fact"><span class="v">${v}</span><p>${p}</p></div>`).join("")}</div>`;
  const shareRow = () => `<p class="row" style="margin-top:26px"><button type="button" class="share">Copy link to this view</button></p>`;
  const loading = (what) => `<div class="skeleton">Loading ${what}…</div>`;

  function headlineNums() {
    const a = src("stats:4217"), b = src("stats:8453");
    if (!a || !b) return "";
    const one = state.chain === "base" ? b : a; // fields shared by both chains read the same from either call
    const per = (k) => (state.chain === "all" ? `<span class="s">Tempo ${n0(a[k])} · Base ${n0(b[k])}</span>` : "");
    const pick = (k) => (state.chain === "tempo" ? a[k] : state.chain === "base" ? b[k] : null);
    const cells = [
      [n0(one.openTasks), "open tasks", `<span class="s">all chains</span>`],
      [n0(one.activeAgents7d), "agents active in the last 7 days", `<span class="s">all chains</span>`],
      [n0(one.activeWorkers7d), "workers active in the last 7 days", `<span class="s">all chains</span>`],
      [state.chain === "all" ? n0(a.paidWorkers + b.paidWorkers) : n0(pick("paidWorkers")), state.chain === "all" ? "paid workers, the two chains added" : "workers paid on " + chainWord(), per("paidWorkers")],
      [state.chain === "all" ? n0(a.activeWallets + b.activeWallets) : n0(pick("activeWallets")), state.chain === "all" ? "active wallets, the two chains added" : "active wallets on " + chainWord(), per("activeWallets")],
      [n0(one.registeredWorkers), "registered workers", `<span class="s">all chains</span>`],
    ];
    return `<div class="nums">${cells.map(([v, k, s]) => `<div class="num"><span class="v">${v}</span><span class="k">${k}</span>${s}</div>`).join("")}</div>`;
  }

  // ---------- view 1: the tile wall ----------------------------------------------------------
  function board() {
    const ts = tasks();
    if (!D.tasks) return head("One square for each task in the public task list.") + headlineNums() + loading("every task");
    const count = [0, 1, 2, 3].map((o) => ts.filter((t) => t.o === o).length);
    const lede = `<b>${n0(ts.length)}</b> tasks have been posted on ${chainWord()}. <b>${n0(count[0])}</b> ended with someone paid. Each square below is one of them.`;
    const legend = `<ul class="legend">${OUT.map((l, o) => `<li data-tip="${esc(`<b>${l}</b>${OUT_HELP[o]}`)}"><i class="sw o${o}"></i>${l} <b>${n0(count[o])}</b></li>`).join("")}</ul>`;
    const controls = `<p class="row"><span class="label">ARRANGE BY</span>${seg("group", [["week", "Week posted"], ["poster", "Who posted"], ["outcome", "How it ended"]], state.group)}</p>`;

    // The open task with the most entries pulses, so the eye lands on where the crowd is.
    const hot = ts.filter((t) => t.o === 1).sort((a, b) => b.entries - a.entries)[0];
    const index = new Map(D.tasks.map((t, i) => [t, i]));
    const tile = (t) => `<a class="t o${t.o}${t === hot ? " hot" : ""}" data-t="${index.get(t)}" href="${taskUrl(t)}" rel="noopener" aria-label="${esc(t.ref)}"></a>`;
    let groups;
    if (state.group === "week") {
      groups = [...groupBy(ts, (t) => weekStart(t.created))].sort((a, b) => b[0] - a[0]).map(([w, g]) => [`Week of ${dmy(w)}`, `${n0(g.length)} tasks · ${new Set(g.map((t) => t.req)).size} posters`, g]);
    } else if (state.group === "poster") {
      const by = [...groupBy(ts, (t) => t.req)].sort((a, b) => b[1].length - a[1].length);
      const bigs = by.filter(([, g]) => g.length >= 8), rest = by.filter(([, g]) => g.length < 8);
      groups = bigs.map(([r, g]) => [short(r), `${n0(g.length)} tasks · ${usd(sum(g, (t) => t.reward))}`, g]);
      if (rest.length) groups.push([`${n0(rest.length)} other posters`, `${n0(sum(rest, ([, g]) => g.length))} tasks, fewer than 8 each`, rest.flatMap(([, g]) => g)]);
    } else {
      groups = [0, 1, 2, 3].map((o) => [OUT[o], `${n0(count[o])} tasks · ${usd(sum(ts.filter((t) => t.o === o), (t) => t.reward))}`, ts.filter((t) => t.o === o)]).filter((g) => g[2].length);
    }
    const hint = `<p class="cap" style="font:400 12px var(--mono);color:var(--muted);margin:-6px 0 14px">Change the arrangement and every tile flies to its new place. Point at a row to play it again; point at a tile to read the task.</p>`;
    const wall = hint + `<div class="wall">${groups.map(([a, b, g]) => `<div class="g"><b>${a}</b>${b}</div><div class="ts">${g.map(tile).join("")}</div>`).join("")}</div>`;

    // What the wall shows, in words.
    const posters = [...groupBy(ts, (t) => t.req)].map(([, g]) => g.length).sort((a, b) => b - a);
    const top3 = posters.slice(0, 3).reduce((s, x) => s + x, 0);
    const dead = ts.filter((t) => t.o === 3), deadZero = dead.filter((t) => t.entries === 0).length;
    const wait = ts.filter((t) => t.phase === "awaiting_settlement"), now = Date.now() / 1000;
    const thisW = weekStart(now), lastW = thisW - 7 * DAY;
    const inWeek = (w) => ts.filter((t) => weekStart(t.created) === w);
    const list = [
      [pct(top3, ts.length), `of all tasks on ${chainWord()} came from just <b>3 posters</b>, out of ${n0(posters.length)} that have ever posted. Arrange by “Who posted” to see it.`],
      dead.length && [n0(dead.length), `tasks ended with nobody paid. <b>${n0(deadZero)}</b> of them (${pct(deadZero, dead.length)}) never got a single entry.`],
      wait.length && [n0(wait.length), `tasks are past their deadline with no decision yet, holding <b>${usd(sum(wait, (t) => t.reward))}</b>. The longest has waited ${n0((now - Math.min(...wait.map((t) => t.expiry))) / DAY)} days.`],
      [n0(inWeek(lastW).length), `tasks were posted last week (from ${dmy(lastW)}), by <b>${new Set(inWeek(lastW).map((t) => t.req)).size} posters</b>. The week before: ${n0(inWeek(lastW - 7 * DAY).length)} tasks. This week so far: ${n0(inWeek(thisW).length)}.`],
    ];
    return head(lede) + headlineNums() + controls + legend + wall + facts(list) + shareRow();
  }

  // ---------- view 2: money flow, posters to winners ----------------------------------------
  function flow() {
    const ts = tasks();
    if (!D.tasks) return head("Rewards, from the wallets that posted them to where they ended up.") + loading("the money flow");
    const total = sum(ts, (t) => t.reward);
    // Where each task's reward ended up. The task list names one winner per task; when a task had
    // several winners the split is not in the list, so those rewards get their own box.
    const dest = (t) => (t.o === 0 ? (t.awards > 1 || !t.win ? "split" : "w:" + t.win.toLowerCase()) : t.o === 1 ? "open" : t.o === 2 ? "wait" : "dead");
    const W = Math.min(1140, main.clientWidth - 40), narrow = W < 700, lab = narrow ? 100 : 190, nodeW = 10, pad = narrow ? 5 : 7;
    const TOP = state.card ? 5 : narrow ? 6 : 10;
    const postTotals = [...groupBy(ts, (t) => t.req)].map(([k, g]) => [k, sum(g, (t) => t.reward), g.length]).sort((a, b) => b[1] - a[1]);
    const topPost = new Set(postTotals.slice(0, TOP).map((x) => x[0]));
    const winTotals = [...groupBy(ts.filter((t) => dest(t).startsWith("w:")), (t) => dest(t))].map(([k, g]) => [k, sum(g, (t) => t.reward), g.length]).sort((a, b) => b[1] - a[1]);
    const topWin = new Set(winTotals.slice(0, TOP).map((x) => x[0]));
    const L = (t) => (topPost.has(t.req) ? t.req : "others"), R = (t) => { const d = dest(t); return d.startsWith("w:") && !topWin.has(d) ? "otherw" : d; };
    const links = new Map(), lv = new Map(), rv = new Map(), rc = new Map();
    for (const t of ts) { const a = L(t), b = R(t), k = a + ">" + b; links.set(k, (links.get(k) || 0) + t.reward); lv.set(a, (lv.get(a) || 0) + t.reward); rv.set(b, (rv.get(b) || 0) + t.reward); rc.set(b, (rc.get(b) || 0) + 1); }
    const lOrder = [...postTotals.slice(0, TOP).map((x) => x[0]), "others"].filter((k) => lv.get(k));
    const rOrder = [...winTotals.slice(0, TOP).map((x) => x[0]), "otherw", "split", "wait", "open", "dead"].filter((k) => rv.get(k));
    const otherPosters = postTotals.length - Math.min(TOP, postTotals.length), otherWinners = winTotals.length - Math.min(TOP, winTotals.length);
    const lName = (k) => (k === "others" ? `${n0(otherPosters)} ${narrow ? "others" : "other posters"}` : short(k));
    const rName = (k) => ({ otherw: `${n0(otherWinners)} ${narrow ? "others" : "other winners"}`, split: narrow ? "Shared wins" : "Shared by several winners", wait: "Not settled yet", open: "Open now", dead: "Ended unpaid" }[k] || short(k.slice(2)));
    const rFill = (k) => ({ wait: "none", open: "#D9A097", dead: "#453E37", split: "#B0A79D" }[k] || "#FFF6E8");

    const H = state.card ? 300 : narrow ? 560 : 640, x0 = lab, x1 = W - lab - nodeW;
    const scaleFor = (order) => (H - pad * (order.length - 1)) / total;
    const k = Math.min(scaleFor(lOrder), scaleFor(rOrder));
    const place = (order, vals) => { let y = 0; const m = new Map(); for (const key of order) { const h = Math.max(1.5, vals.get(key) * k); m.set(key, { y, h, used: 0 }); y += h + pad; } return m; };
    const ln = place(lOrder, lv), rn = place(rOrder, rv);
    let ribbons = "";
    const geo = [];
    for (const a of lOrder) for (const b of rOrder) {
      const v = links.get(a + ">" + b); if (!v) continue;
      const A = ln.get(a), B = rn.get(b), h = Math.max(0.6, v * k), ya = A.y + A.used, yb = B.y + B.used; A.used += h; B.used += h;
      const xa = x0 + nodeW, xb = x1, mx = (xa + xb) / 2;
      const tipHtml = `<b>${lName(a)} → ${rName(b)}</b><span>${usd(v)} · ${pct(v, total)} of all rewards</span>`;
      const op = b === "dead" ? 0.5 : b === "wait" ? 0.14 : 0.22;
      geo.push({ a, b, v, xa, xb, ya, yb, h, color: b === "open" ? "#D9A097" : b === "dead" || b === "wait" ? "#B0A79D" : "#FFF6E8" });
      ribbons += `<path class="rb" data-link="${geo.length - 1}" style="--op:${op};animation-delay:0ms" d="M${xa},${ya}C${mx},${ya} ${mx},${yb} ${xb},${yb}L${xb},${yb + h}C${mx},${yb + h} ${mx},${ya + h} ${xa},${ya + h}Z" fill="${b === "wait" ? "#B0A79D" : rFill(b)}" fill-opacity="${op}" data-tip="${esc(tipHtml)}"/>`;
    }
    // what each box says when pointed at: where a poster's money went, or who paid a winner
    const nodeTip = {};
    for (const a of lOrder) {
      const mine = geo.filter((g) => g.a === a), part = (f) => sum(mine.filter(f), (g) => g.v);
      const rows = [["paid to a single winner", part((g) => g.b.startsWith("w:") || g.b === "otherw")], ["shared by several winners", part((g) => g.b === "split")], ["open now", part((g) => g.b === "open")], ["not settled yet", part((g) => g.b === "wait")], ["ended unpaid", part((g) => g.b === "dead")]].filter((r) => r[1]);
      const n = a === "others" ? sum(postTotals.slice(TOP), (x) => x[2]) : postTotals.find((x) => x[0] === a)[2];
      nodeTip["L" + a] = `<b>${lName(a)}</b><span>put up ${usd(lv.get(a))} on ${n0(n)} tasks · ${pct(lv.get(a), total)} of all rewards</span>` + rows.map((r) => `<span>${usd(r[1])} ${r[0]}</span>`).join("");
    }
    for (const b of rOrder) {
      const mine = geo.filter((g) => g.b === b).sort((x, y) => y.v - x.v);
      nodeTip["R" + b] = `<b>${rName(b)}</b><span>${usd(rv.get(b))} from ${n0(rc.get(b))} tasks · ${pct(rv.get(b), total)} of all rewards</span>` + mine.slice(0, 4).map((g) => `<span>${usd(g.v)} from ${lName(g.a)}</span>`).join("") + (mine.length > 4 ? `<span>and ${mine.length - 4} more sources</span>` : "");
    }
    const label = (x, anchor, y, h, a, b) => (h < 9 ? "" : `<text x="${x}" y="${y + h / 2 + (h > 26 ? -2 : 4)}" text-anchor="${anchor}" style="fill:#EFE9E2">${esc(a)}</text>` + (h > 26 ? `<text x="${x}" y="${y + h / 2 + 12}" text-anchor="${anchor}">${b}</text>` : ""));
    let nodes = "";
    for (const key of lOrder) { const n = ln.get(key); nodes += `<rect x="${x0}" y="${n.y}" width="${nodeW}" height="${n.h}" rx="2" fill="#EFE9E2"/><rect class="hit" data-node="L${esc(key)}" x="0" y="${n.y - pad / 2}" width="${x0 + nodeW}" height="${n.h + pad}" fill="transparent" data-tip="${esc(nodeTip["L" + key])}"/>` + label(x0 - 8, "end", n.y, n.h, lName(key), usd(lv.get(key))); }
    for (const key of rOrder) { const n = rn.get(key); nodes += `<rect x="${x1}" y="${n.y}" width="${nodeW}" height="${n.h}" rx="2" fill="${rFill(key)}" ${key === "wait" ? 'stroke="#B0A79D" stroke-width="1.5"' : ""}/><rect class="hit" data-node="R${esc(key)}" x="${x1}" y="${n.y - pad / 2}" width="${W - x1}" height="${n.h + pad}" fill="transparent" data-tip="${esc(nodeTip["R" + key])}"/>` + label(x1 + nodeW + 8, "start", n.y, n.h, rName(key), usd(rv.get(key))); }
    FL = { W, H, geo, total, lOrder: lOrder.map((k) => "L" + k), key: state.chain + "|" + W };
    const svg = `<svg viewBox="0 -22 ${W} ${H + 30}" width="${W}" height="${H + 30}" role="img" aria-label="Rewards flowing from the wallets that posted tasks to the wallets that won them, and to rewards still held or ended unpaid."><text x="${x0 + nodeW}" y="-8" text-anchor="end">POSTED BY</text><text x="${x1}" y="-8">WENT TO</text>${ribbons}${nodes}</svg>`;

    const paidTs = ts.filter((t) => t.o === 0), paid = sum(paidTs, (t) => t.reward);
    const top3 = postTotals.slice(0, 3).reduce((s, x) => s + x[1], 0);
    const self = paidTs.filter((t) => t.win && t.win.toLowerCase() === t.req.toLowerCase());
    const single = winTotals.reduce((s, x) => s + x[1], 0), topW = winTotals.slice(0, 10).reduce((s, x) => s + x[1], 0);
    const lede = `<b>${usd(total)}</b> in rewards has been put up on ${chainWord()}. <b>${usd(paid)}</b> (${pct(paid, total)}) has been paid out so far. Wallets that posted are on the left; where each reward ended up is on the right.`;
    const list = [
      [pct(top3, total), `of all reward money came from <b>3 wallets</b>. ${n0(postTotals.length)} wallets have posted at least one task.`],
      winTotals.length && [pct(topW, single), `of the money paid to a single winner went to the <b>10 highest-earning wallets</b>, out of ${n0(winTotals.length)} that have won.`],
      rv.get("dead") && [usd(rv.get("dead")), `was offered on tasks that <b>ended with nobody paid</b> (${pct(rv.get("dead"), total)} of all rewards). Taskmarket holds rewards in escrow, so the poster can reclaim it.`],
      rv.get("wait") && [usd(rv.get("wait")), `sits on tasks that are <b>not settled yet</b>: claimed by a worker, or past the deadline with no decision.`],
      self.length && [n0(self.length), `paid tasks list the <b>posting wallet itself</b> as the winner (${usd(sum(self, (t) => t.reward))}).`],
    ];
    const note = `<p class="sub" style="color:var(--muted);font-size:13.5px;max-width:80ch;margin-top:14px">Each task's full reward is counted once. The task list names one winner per task; ${n0(rc.get("split") || 0)} paid tasks had more than one winner, and their rewards are shown as “Shared by several winners” because the list does not give the split. Wallets are shown as addresses only.</p>`;
    const hint = `<p class="cap" style="font:400 12px var(--mono);color:var(--muted);margin:0 0 10px">Each band runs from the wallet that posted a reward to where the money went. Point at a wallet to draw its bands again.</p>`;
    return head(lede) + hint + `<div class="flowbox" style="position:relative">${svg}</div>` + note + facts(list) + shareRow();
  }

  // ---------- view 3: the swarm ---------------------------------------------------------------
  function swarm() {
    const lede0 = "Each dot is one entry sent in the last 24 hours, drifting toward the task it was sent to.";
    if (!D.tasks || !D.feed) { if (!D.feed) loadFeed(); return head(lede0) + loading("the last 24 hours of entries"); }
    const cid = state.chain === "all" ? null : CHAIN[state.chain];
    const T = D.feed.types.indexOf("task_submitted"), now = Date.now(), from = now - 24 * 3600e3;
    const subs = D.feed.items.filter((r) => r[1] === T && r[0] >= from && (!cid || r[3] === cid));
    const byId = new Map(D.tasks.map((t) => [t.id.slice(0, 18), t]));
    const per = [...groupBy(subs, (r) => r[2])].map(([id, rows]) => ({ t: byId.get(id), rows, agents: new Set(rows.map((r) => r[4])).size })).filter((x) => x.t).sort((a, b) => b.rows.length - a.rows.length);
    const top = per.slice(0, state.card ? 4 : innerWidth < 700 ? 7 : 9);
    const W = Math.min(1140, main.clientWidth - 40), narrow = W < 700, lane = narrow ? 86 : 78, padR = narrow ? 64 : 250, padL = 6;
    const H = top.length * lane + 30, xs = (ms) => padL + ((ms - from) / (now - from)) * (W - padR - padL - 30);
    let g = "";
    // time grid
    for (const h of narrow ? [24, 12, 0] : [24, 18, 12, 6, 0]) { const x = xs(now - h * 3600e3); g += `<line x1="${x}" x2="${x}" y1="0" y2="${H - 24}" stroke="#453E37" stroke-dasharray="2 5"/><text x="${x}" y="${H - 8}" text-anchor="${h === 24 ? "start" : h === 0 ? "end" : "middle"}">${h ? h + " h ago" : "now"}</text>`; }
    const rnd = (s) => { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0; return (x % 1000) / 1000; };
    const maxR = Math.max(...top.map((x) => x.t.reward), 1);
    const lanes = top.map((x, i) => {
      const cy = i * lane + lane / 2 + 4, tx = W - padR - 14, side = 12 + 20 * Math.sqrt(x.t.reward / maxR), tcx = tx + 14;
      // faint guide curves, as in the kit's "converge" plate
      for (const s of [-1, 1]) g += `<path class="guide" data-lane="${i}" d="M${padL},${cy + s * (lane / 2 - 10)}C${tx * 0.55},${cy + s * (lane / 2 - 10)} ${tx * 0.8},${cy} ${tx},${cy}" fill="none" stroke="#D9A097" stroke-opacity=".16"/>`;
      const dots = x.rows.map((r) => { const px = xs(r[0]), u = (px - padL) / (tx - padL), spread = (lane / 2 - 10) * (1 - u * u * u); return { t: r[0], x: px, y: cy + (rnd(r[4] + r[0]) * 2 - 1) * spread, actor: r[4], key: r[0] + r[4] + r[2] }; }).sort((a, b) => a.t - b.t);
      g += `<rect class="tile" data-lane="${i}" x="${tcx - side / 2}" y="${cy - side / 2}" width="${side}" height="${side}" rx="${side * 0.26}" fill="#FFF6E8"/>`;
      const lx = tx + 14 + 22 + 12;
      if (!narrow) g += `<a href="${taskUrl(x.t)}" rel="noopener" class="lanelabel" data-lane="${i}"><text x="${lx}" y="${cy - 8}" style="fill:#EFE9E2;font:600 13px 'Inter Tight',sans-serif">${esc(x.t.title.slice(0, 34))}${x.t.title.length > 34 ? "…" : ""}</text><text x="${lx}" y="${cy + 8}"><tspan id="cnt-${i}" style="fill:#FFF6E8">${n0(x.rows.length)}</tspan> entries from ${n0(x.agents)} agents today</text><text x="${lx}" y="${cy + 23}">${usd(x.t.reward)} · ${n0(x.t.entries)} in all · ${x.t.o === 1 ? "closes in " + until(x.t.expiry) : OUT[x.t.o].toLowerCase()}</text></a>`;
      else g += `<text x="${padL}" y="${cy - lane / 2 + 12}" style="fill:#EFE9E2;font:600 12px 'Inter Tight',sans-serif">${esc(x.t.title.slice(0, 40))}</text><text id="cnt-${i}" x="${W - 2}" y="${cy + 4}" text-anchor="end" style="fill:#EFE9E2">${n0(x.rows.length)}</text><text x="${W - 2}" y="${cy + 18}" text-anchor="end">${usd(x.t.reward)}</text>`;
      return { cy, tx: tcx, side, dots, task: x.t, top: i * lane + 4, bottom: (i + 1) * lane + 4 };
    });
    SW = { W, H, from, now, lanes, lane, padL, xw: W - padR - padL - 30, key: state.chain + "|" + top.map((x) => x.t.id).join() };
    const controls = top.length ? `<p class="row swctl"><button type="button" class="share" id="sw-play" style="min-width:132px">Replay the day</button><input id="sw-scrub" type="range" min="0" max="1000" value="1000" aria-label="Move through the last 24 hours"><span class="label" id="sw-clock"></span></p>` : "";
    const svg = top.length ? `${controls}<div class="swarmbox" style="position:relative"><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Entries sent in the last 24 hours, as dots converging on the tasks they were sent to.">${g}</svg><canvas id="sw-canvas" style="position:absolute;left:0;top:0;touch-action:pan-y"></canvas></div><p class="cap" style="font:400 12px var(--mono);color:var(--muted);margin:6px 0 0">Press “Replay the day” or drag the slider. Hover a lane to play that task's day again; hover a dot to see who sent it and when; click a square to open the task.</p>` : `<div class="skeleton">No entries on ${chainWord()} in the last 24 hours.</div>`;

    const open = tasks().filter((t) => t.o === 1), openB = open.filter((t) => t.mode === "bounty");
    const top3 = per.slice(0, 3).reduce((s, x) => s + x.rows.length, 0), agents = new Set(subs.map((r) => r[4])).size;
    const lede = `<b>${n0(subs.length)}</b> entries were sent on ${chainWord()} in the last 24 hours, to <b>${n0(per.length)}</b> tasks, by <b>${n0(agents)}</b> agents. Each dot is one entry, drifting toward its task. The bigger the square, the bigger the reward.`;
    const quiet = openB.filter((t) => t.entries === 0);
    const list = [
      subs.length && [pct(top3, subs.length), `of today's entries went to just <b>3 tasks</b>.`],
      openB.length && [n0(median(openB.map((t) => t.entries))), `entries on the <b>typical open bounty</b> right now (the median of ${n0(openB.length)}). The busiest has ${n0(Math.max(...openB.map((t) => t.entries)))}.`],
      openB.length && [usd(median(openB.filter((t) => t.entries).map((t) => t.reward / t.entries))), `is the typical <b>reward per entry</b> on an open bounty: the reward divided by how many entries are competing for it.`],
      [n0(quiet.length), `open ${quiet.length === 1 ? "bounty has" : "bounties have"} <b>no entries yet</b>${quiet.length ? `, worth ${usd(sum(quiet, (t) => t.reward))} together` : ""}.`],
    ];
    const rows = open.sort((a, b) => b.entries - a.entries).slice(0, 12).map((t) => `<tr><td><a href="${taskUrl(t)}" rel="noopener">${esc(t.title.slice(0, 60))}</a><br><span class="mono" style="font-size:11px;color:var(--muted)">${t.ref} · ${CHAIN_NAME[t.chain]} · ${t.mode}</span></td><td class="n">${usd(t.reward)}</td><td class="n">${n0(t.entries)}</td><td class="n">${t.entries ? usd(t.reward / t.entries) : "–"}</td><td class="n">${until(t.expiry)}</td></tr>`).join("");
    const table = `<h2>The most contested open tasks</h2><p class="sub">Open tasks on ${chainWord()}, by total entries so far.</p><div class="panel" style="overflow-x:auto"><table><thead><tr><th>Task</th><th class="n">Reward</th><th class="n">Entries</th><th class="n">Reward per entry</th><th class="n">Closes in</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    return head(lede) + svg + facts(list) + table + shareRow();
  }
  // --- the moving part of the tile wall ----------------------------------------------------------------
  // The tiles are the animation. On arrival they all pop in together in one sweep from left to right.
  // Choosing another arrangement makes every tile fly to its new place. Pointing at a row pops that
  // row in again, and every few seconds a soft ripple runs across the whole wall.
  let bdSeen = null, bdIntro = 0, bdFrom = null, bdRun = 0;
  function mountBoard() {
    const wall = $(".wall"); if (!wall) return;
    const run = ++bdRun, still = state.card || matchMedia("(prefers-reduced-motion:reduce)").matches;
    const tiles = [...wall.querySelectorAll(".t")];
    if (still || !tiles.length) { bdFrom = null; return; }
    const w = wall.getBoundingClientRect(), pos = tiles.map((el) => el.getBoundingClientRect());
    // each tile's place in the sweep: how far across the wall it sits
    tiles.forEach((el, i) => el.style.setProperty("--d", Math.round(((pos[i].left - w.left) / w.width) * 900) + "ms"));
    const key = state.chain + "|" + state.group;
    if (bdFrom) { // a new arrangement: fly from the old place to the new one
      const from = bdFrom; bdFrom = null; bdSeen = key; bdIntro = -1e9;
      tiles.forEach((el, i) => {
        const o = from.get(el.dataset.t), x = pos[i].left + scrollX, y = pos[i].top + scrollY;
        if (o) el.animate([{ transform: `translate(${o[0] - x}px,${o[1] - y}px)` }, { transform: "none" }], { duration: 900, delay: Math.random() * 180, easing: "cubic-bezier(.3,.8,.2,1)", fill: "backwards" });
        else el.animate([{ transform: "scale(.6)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 500, delay: 500 + Math.random() * 300, easing: "ease-out", fill: "backwards" });
      });
    } else {
      // the opening sweep plays once per arrangement; a redraw in the middle of it carries on from the same moment
      if (bdSeen !== key) { bdSeen = key; bdIntro = performance.now(); }
      const since = performance.now() - bdIntro;
      if (since < 1500) { wall.style.setProperty("--since", Math.round(since) + "ms"); wall.classList.add("sweep"); setTimeout(() => run === bdRun && wall.classList.remove("sweep"), 1600 - since); }
    }
    // pointing at a row pops that row in again
    let row = null;
    const rows = [...wall.querySelectorAll(".ts")];
    wall.onpointerover = (e) => {
      const el = e.target.closest(".ts,.g"); if (!el) return;
      const r = el.classList.contains("g") ? el.nextElementSibling : el; if (r === row) return; row = r;
      if (wall.classList.contains("sweep")) return;
      [...r.children].forEach((t, i, all) => t.animate([{ transform: "scale(.7)", opacity: 0.25 }, { transform: "none", opacity: 1 }], { duration: 480, delay: (i / all.length) * Math.min(900, 200 + all.length * 3), easing: "ease-out", fill: "backwards" }));
    };
    wall.onpointerleave = () => (row = null);
    // idle: a ripple across the whole wall every few seconds
    const idle = () => {
      if (run !== bdRun || !wall.isConnected) return;
      if (!row && !document.hidden && !wall.classList.contains("sweep")) { wall.classList.add("ripple"); setTimeout(() => wall.classList.remove("ripple"), 2200); }
      setTimeout(idle, 12000);
    };
    setTimeout(idle, 9000);
  }

  // --- the moving part of the money view ------------------------------------------------------------
  // The bands are the animation. On arrival they all grow out of the posting wallets together, curve
  // across and connect on the other side. Every few seconds they all draw again, so the page keeps moving. Pointing at a wallet or a box draws its bands again; a click keeps it lit.
  let FL = null, flSeen = null, flPin = null, flRun = 0, flIntro = 0;
  function mountFlow() {
    const box = $(".flowbox"); if (!box || !FL) return;
    const run = ++flRun, F = FL, still = state.card || matchMedia("(prefers-reduced-motion:reduce)").matches;
    const paths = [...box.querySelectorAll(".rb")];
    // The full draw plays once per visit. The page is redrawn when fresh data lands, so a redraw in the
    // middle of it picks every band up where it was instead of starting over or skipping to the end.
    const first = !still && flSeen !== F.key;
    if (first) { flSeen = F.key; flIntro = performance.now(); }
    const since = performance.now() - flIntro, introLen = 2200;
    if (still || since > introLen) paths.forEach((p) => p.classList.add("in"));
    else if (!first) paths.forEach((p) => (p.style.animationDelay = parseFloat(p.style.animationDelay) - since + "ms"));
    if (flPin && !box.querySelector(`[data-node="${CSS.escape(flPin)}"]`)) flPin = null;
    const related = (node) => F.geo.map((g, i) => (("L" + g.a === node || "R" + g.b === node) ? i : -1)).filter((i) => i >= 0);
    const light = (node, replay, soft) => {
      const act = node ? new Set(related(node)) : null;
      paths.forEach((p, i) => { p.style.fillOpacity = act ? (act.has(i) ? Math.min(0.9, +p.style.getPropertyValue("--op") * 2.6) : soft ? "" : 0.04) : ""; });
      if (act && replay && !still) [...act].forEach((i) => { const p = paths[i]; p.classList.remove("in", "again"); void p.getBoundingClientRect(); p.style.animationDelay = "0ms"; p.classList.add("again"); });
    };
    let hover = null, turn = 0;
    box.onpointerover = (e) => { const n = e.target.closest("[data-node]")?.dataset.node || null; if (n === hover) return; hover = n; if (n) light(n, true); else light(flPin, false); };
    box.onpointerleave = () => { hover = null; light(flPin, false); };
    box.onclick = (e) => { const n = e.target.closest("[data-node]")?.dataset.node || null; flPin = n && n !== flPin ? n : null; light(flPin || hover, !!flPin); };
    if (flPin) light(flPin, false);
    if (still) return;
    // idle: every few seconds all the bands draw themselves again, together
    const idle = () => {
      if (run !== flRun || !box.isConnected) return;
      if (!hover && !flPin && !document.hidden) paths.forEach((p) => { p.classList.remove("in", "again"); void p.getBoundingClientRect(); p.style.animationDelay = "0ms"; p.classList.add("again"); });
      setTimeout(idle, 7000);
    };
    setTimeout(idle, Math.max(5000, introLen - since + 5000));
  }

  // --- the moving part of the swarm view: a canvas over the lanes -----------------------------
  // Dots appear at the moment they were sent; a spark runs from each new dot into its task's square,
  // which bumps and counts up. The replay runs once on arrival, then the view idles with sparks from the
  // most recent entries, and anything that arrives while the page is open flies in live.
  let SW = null, swRun = 0, swKnown = new Set();
  const swKeep = { key: null, frac: 1, playing: false }; // where the replay is, kept across redraws
  function mountSwarm() {
    const cv = $("#sw-canvas"); if (!cv || !SW) return;
    const run = ++swRun, S = SW, ctx = cv.getContext("2d"), dpr = Math.min(2, devicePixelRatio || 1);
    const still = state.card || matchMedia("(prefers-reduced-motion:reduce)").matches;
    cv.width = S.W * dpr; cv.height = S.H * dpr; cv.style.width = S.W + "px"; cv.style.height = S.H + "px";
    const all = S.lanes.flatMap((l, i) => l.dots.map((d) => ((d.lane = i), d)));
    const span = S.now - S.from, REPLAY = 11000; // the 24 hours play back in 11 seconds
    const firstVisit = swKeep.key !== S.key;
    let clock = S.now, playing = false, sparks = [], hoverLane = -1, hoverDot = null, last = performance.now(), idleAt = 0;
    const pulse = S.lanes.map(() => -1e9), shownCount = S.lanes.map(() => -1);
    const play = $("#sw-play"), scrub = $("#sw-scrub"), clockEl = $("#sw-clock");
    const reveal = (d, t, withSpark) => { d.shown = true; d.born = t; if (withSpark && sparks.length < 260) sparks.push({ d, start: t }); };
    const setClock = (ms, t, withSpark) => { clock = Math.max(S.from, Math.min(S.now, ms)); swKeep.frac = (clock - S.from) / span; for (const d of all) { if (d.due) { if (ms < S.now) d.due = 0; else continue; } if (d.t <= clock && !d.shown) reveal(d, t, withSpark); else if (d.t > clock && d.shown) d.shown = false; } };
    const setPlaying = (on, label) => { playing = swKeep.playing = on; play.textContent = label; };
    const start = () => { for (const d of all) { d.shown = false; d.due = 0; } sparks = []; clock = S.from; setPlaying(true, "Pause"); };
    if (still) setClock(S.now, -1e9, false);
    else if (firstVisit) { swKeep.key = S.key; start(); }
    else if (swKeep.frac < 1) { // redrawn in the middle of a replay or a scrub: carry on from the same moment
      setClock(S.from + swKeep.frac * span, -1e9, false); setPlaying(swKeep.playing, swKeep.playing ? "Pause" : "Resume"); scrub.value = Math.round(swKeep.frac * 1000);
    } else { // a refresh while the page is open: keep everything, and fly in only what is new
      const t = performance.now();
      for (const d of all) { if (swKnown.has(d.key)) { d.shown = true; d.born = -1e9; } else reveal(d, t + Math.random() * 1500, true); }
    }
    for (const d of all) swKnown.add(d.key);
    play.onclick = () => { if (playing) setPlaying(false, "Resume"); else if (clock >= S.now) start(); else setPlaying(true, "Pause"); };
    scrub.oninput = () => { setPlaying(false, +scrub.value >= 1000 ? "Replay the day" : "Resume"); sparks = []; setClock(S.from + (span * scrub.value) / 1000, -1e9, false); };
    const at = (e) => { const r = cv.getBoundingClientRect(); return [((e.clientX - r.left) * S.W) / r.width, ((e.clientY - r.top) * S.H) / r.height]; };
    cv.onpointermove = (e) => {
      const [x, y] = at(e), was = hoverLane; hoverLane = S.lanes.findIndex((l) => y >= l.top && y < l.bottom); hoverDot = null;
      // Entering a lane plays that task's day again: its dots leave and fly back in, in the order they were sent.
      if (hoverLane >= 0 && hoverLane !== was && !playing && !still && clock >= S.now) {
        const ds = S.lanes[hoverLane].dots, t0 = performance.now(), dur = Math.min(2600, 500 + ds.length * 45);
        sparks = sparks.filter((sp) => sp.d.lane !== hoverLane);
        ds.forEach((d, i) => { d.shown = false; d.due = t0 + (i / Math.max(1, ds.length - 1)) * dur; });
      }
      const l = S.lanes[hoverLane]; let best = 81;
      if (l) for (const d of l.dots) { if (!d.shown) continue; const q = (d.x - x) ** 2 + (d.y - y) ** 2; if (q < best) { best = q; hoverDot = d; } }
      const onTile = l && Math.abs(x - l.tx) < l.side / 2 + 6 && Math.abs(y - l.cy) < l.side / 2 + 6;
      cv.style.cursor = onTile ? "pointer" : hoverDot ? "crosshair" : "default";
      if (hoverDot) showTip(`<b>${hoverDot.actor}… sent an entry</b><span>${hm(hoverDot.t)} UTC · ${ago(hoverDot.t)}</span><span>to ${esc(l.task.title.slice(0, 48))}</span>`);
      else if (onTile) showTip(taskTip(l.task)); else hideTip();
    };
    cv.onpointerdown = (e) => { if (e.pointerType !== "mouse") { hoverLane = -1; cv.onpointermove(e); } };
    cv.onpointerleave = () => { hoverLane = -1; hoverDot = null; hideTip(); };
    cv.onclick = (e) => { const [x, y] = at(e), l = S.lanes.find((l) => Math.abs(x - l.tx) < l.side / 2 + 6 && Math.abs(y - l.cy) < l.side / 2 + 6); if (l) open(taskUrl(l.task), "_blank", "noopener"); };

    const ease = (u) => 1 - (1 - u) ** 3;
    function frame(t) {
      if (run !== swRun || !cv.isConnected) return;
      const dt = Math.min(64, t - last); last = t;
      if (playing) { setClock(clock + (dt / REPLAY) * span, t, true); if (clock >= S.now) setPlaying(false, "Replay the day"); scrub.value = Math.round(((clock - S.from) / span) * 1000); }
      // idle: every so often one of the newest entries sends another spark, so the page never sits still
      if (!playing && !still && clock >= S.now && t - idleAt > 420) { idleAt = t; const recent = all.filter((d) => d.shown && S.now - d.t < 3 * 3600e3); const pool = recent.length > 4 ? recent : all; if (pool.length) sparks.push({ d: pool[(Math.random() * pool.length) | 0], start: t, soft: true }); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, S.W, S.H);
      // time cursor
      if (clock < S.now) { const x = S.padL + ((clock - S.from) / span) * S.xw; ctx.fillStyle = "rgba(217,160,151,.5)"; ctx.fillRect(x, 0, 1, S.H - 24); }
      const count = S.lanes.map(() => 0);
      for (const d of all) {
        if (!d.shown && d.due && t >= d.due) { d.due = 0; reveal(d, t, true); }
        if (!d.shown) continue; count[d.lane]++;
        const age = t - d.born, pop = age < 450 ? 1 - age / 450 : 0, fresh = S.now - d.t < 3600e3;
        const dim = hoverLane >= 0 && hoverLane !== d.lane ? 0.18 : 1;
        const breathe = fresh && !still ? 0.75 + 0.25 * Math.sin(t / 380 + d.x) : 1;
        ctx.globalAlpha = (fresh ? 1 : 0.55) * dim * breathe + pop * 0.4 * dim;
        ctx.fillStyle = fresh || pop ? "#FFF6E8" : "#EFE9E2";
        ctx.beginPath(); ctx.arc(d.x, d.y, (d === hoverDot ? 4.5 : fresh ? 2.6 : 2) + pop * 4, 0, 6.2832); ctx.fill();
      }
      // sparks: from the dot along a curve into the square
      sparks = sparks.filter((s) => {
        const u = (t - s.start) / (s.soft ? 1500 : 900); if (u < 0) return true;
        const l = S.lanes[s.d.lane];
        if (u >= 1) { if (!s.soft) pulse[s.d.lane] = t; return false; }
        const dim = hoverLane >= 0 && hoverLane !== s.d.lane ? 0.15 : 1;
        for (let k = 0; k < 5; k++) { const v = ease(Math.max(0, u - k * 0.035)), x = s.d.x + (l.tx - s.d.x) * v, y = s.d.y + (l.cy - s.d.y) * v * v; ctx.globalAlpha = (s.soft ? 0.5 : 0.95) * (1 - k / 5) * dim; ctx.fillStyle = s.soft ? "#D9A097" : "#FFF6E8"; ctx.beginPath(); ctx.arc(x, y, (s.soft ? 1.6 : 2.2) * (1 - k / 7), 0, 6.2832); ctx.fill(); }
        return true;
      });
      // squares: a ring when an entry lands, and the running count
      S.lanes.forEach((l, i) => {
        const p = (t - pulse[i]) / 520;
        if (p >= 0 && p < 1) { ctx.globalAlpha = (1 - p) * 0.8; ctx.strokeStyle = "#FFF6E8"; ctx.lineWidth = 2; const r = l.side / 2 + 3 + p * 12; ctx.beginPath(); ctx.roundRect(l.tx - r, l.cy - r, 2 * r, 2 * r, r * 0.5); ctx.stroke(); }
        if (count[i] !== shownCount[i]) { shownCount[i] = count[i]; const el = document.getElementById("cnt-" + i); if (el) el.textContent = n0(count[i]); }
      });
      ctx.globalAlpha = 1;
      document.querySelectorAll(".swarmbox [data-lane]").forEach((el) => (el.style.opacity = hoverLane >= 0 && +el.dataset.lane !== hoverLane ? 0.3 : 1));
      clockEl.textContent = clock >= S.now ? "NOW · " + hm(S.now) + " UTC" : hm(clock) + " UTC · " + ago(clock).toUpperCase();
      if (!still) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  let feedLoading = false;
  function loadFeed() { if (feedLoading) return; feedLoading = true; get("feed").then((f) => { D.feed = f; feedLoading = false; if (state.view === "swarm" || state.card) render(); }).catch(() => (feedLoading = false)); }

  // ---------- view 4: pulse (time series, breakdowns, heatmap, posters per week, feed) ------
  function barsSvg(points, fmt, color = "#EFE9E2") {
    const W = 520, H = 120, n = points.length, max = Math.max(...points.map((p) => p[1]), 1e-9), bw = W / n;
    const bars = points.map((p, i) => { const h = (p[1] / max) * (H - 4); return `<rect x="${(i * bw + bw * 0.12).toFixed(2)}" y="${(H - h).toFixed(2)}" width="${(bw * 0.76).toFixed(2)}" height="${Math.max(h, p[1] ? 1 : 0).toFixed(2)}" rx="${Math.min(2, bw * 0.3)}" fill="${color}"/><rect x="${(i * bw).toFixed(2)}" y="0" width="${bw.toFixed(2)}" height="${H}" fill="transparent" data-tip="${esc(`<b>${fmt(p[1])}</b><span>${p[0]}</span>`)}"/>`; }).join("");
    return `<svg viewBox="0 0 ${W} ${H + 18}" preserveAspectRatio="none" style="height:150px"><line x1="0" x2="${W}" y1="${H}" y2="${H}" stroke="#453E37"/>${bars}</svg><p class="cap" style="display:flex;justify-content:space-between;margin:2px 0 0"><span>${points[0]?.[0] ?? ""}</span><span>peak ${fmt(max)}</span><span>${points[n - 1]?.[0] ?? ""}</span></p>`;
  }
  function pulse() {
    const day = src("series:day"), week = src("series:week");
    if (!day) return head("Daily activity across the market.") + loading("the time series");
    const r = state.range, N = { "7d": 7, "30d": 30, "90d": 90 }[r];
    const series = r === "all" ? week.slice(week.findIndex((b) => b.tasksCreated || b.activeAgents || +b.rewardVolume)) : day.slice(-N);
    const unit = r === "all" ? "week" : "day";
    const lab = (b) => (r === "all" ? "week of " : "") + dmy(Date.parse(b.bucket) / 1000);
    const total = (f) => sum(series, f);
    const cid = state.chain === "all" ? null : CHAIN[state.chain];
    // The time-series endpoint reports both chains together. For one chain, tasks posted and
    // rewards put up are counted from the task list instead; the other two have no per-chain source.
    const fromList = (f) => { const ts = tasks(), w = unit === "week" ? 7 * DAY : DAY; return series.map((b) => { const s = Date.parse(b.bucket) / 1000; return [lab(b), sum(ts.filter((t) => t.created >= s && t.created < s + w), f)]; }); };
    const charts = [
      ["Active agents", "per " + unit + (cid ? " · both chains together" : ""), series.map((b) => [lab(b), b.activeAgents]), n0, n0(Math.max(...series.map((b) => b.activeAgents))) + " at peak"],
      ["Tasks posted", cid && D.tasks ? "per " + unit + " · " + chainWord() + ", from the task list" : "per " + unit, cid && D.tasks ? fromList(() => 1) : series.map((b) => [lab(b), b.tasksCreated]), n0, null],
      ["Rewards put up", cid && D.tasks ? "per " + unit + " · " + chainWord() + ", from the task list" : "per " + unit, cid && D.tasks ? fromList((t) => t.reward) : series.map((b) => [lab(b), +b.rewardVolume]), usd, null],
      ["Rewards paid", "per " + unit + (cid ? " · both chains together" : ""), series.map((b) => [lab(b), +b.paidVolume]), usd, null],
    ].map(([title, cap, pts, fmt, big]) => `<div class="panel chart"><h3>${title}</h3><p class="big">${big || fmt(sum(pts, (p) => p[1]))}</p><p class="cap">${big ? cap : "total in range · " + cap}</p>${barsSvg(pts, fmt, title === "Rewards paid" ? "#D9A097" : "#EFE9E2")}</div>`).join("");
    const rangeRow = `<p class="row"><span class="label">RANGE</span>${seg("range", [["7d", "7 days"], ["30d", "30 days"], ["90d", "90 days"], ["all", "All time"]], r)}</p>`;

    // breakdowns
    const bd = src("breakdowns"), ts = tasks();
    const countBy = (key) => [...groupBy(ts, (t) => t[key])].map(([k, g]) => ({ k, count: g.length }));
    const rowsOf = (items) => { const max = Math.max(...items.map((x) => x.count), 1); return `<div class="bars">${items.sort((a, b) => b.count - a.count).map((x) => `<div class="bar"><span>${esc(String(x.k).replace(/_/g, " "))}</span><i style="width:${(100 * x.count) / max}%"></i><b>${n0(x.count)}</b></div>`).join("")}</div>`; };
    const modeItems = cid ? countBy("mode") : (bd?.mode || []).map((x) => ({ k: x.mode, count: x.count }));
    const statusItems = cid ? countBy("status") : (bd?.status || []).map((x) => ({ k: x.status, count: x.count }));
    const bdCap = cid ? `${chainWord()}, counted from the task list` : "all chains, from the breakdowns endpoint";
    const breakdowns = `<div class="grid2"><div class="panel chart"><h3>Tasks by mode</h3><p class="cap">${bdCap}</p>${rowsOf(modeItems)}</div><div class="panel chart"><h3>Tasks by status</h3><p class="cap">${bdCap}</p>${rowsOf(statusItems)}</div></div>`;

    // heatmap
    const hk = src(`heat:${state.heat}:${r}`);
    let heat = loading("the heatmap");
    if (hk) {
      const cell = new Map(hk.cells.map((c) => [c.row + "|" + c.col, c])), max = Math.max(...hk.cells.map((c) => c.count), 1);
      if (state.heat === "hourOfWeek") {
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        let h = `<div class="heat" style="grid-template-columns:34px repeat(24,1fr)"><span class="h"></span>${Array.from({ length: 24 }, (_, i) => `<span class="h">${i % 3 ? "" : i}</span>`).join("")}`;
        for (const d of hk.rowKeys) { h += `<span class="h">${days[+d] ?? d}</span>`; for (const c of hk.colKeys) { const v = cell.get(d + "|" + c)?.count || 0; h += `<span style="opacity:${v ? 0.12 + 0.88 * (v / max) : 0.05}" data-tip="${esc(`<b>${n0(v)} events</b><span>${days[+d] ?? d} ${String(c).padStart(2, "0")}:00 to ${String(c).padStart(2, "0")}:59 UTC</span>`)}"></span>`; } }
        heat = h + "</div>";
        const best = [...hk.cells].sort((a, b) => b.count - a.count)[0];
        heat += `<p class="cap" style="margin-top:10px">Busiest hour: ${days[+best.row]} ${String(best.col).padStart(2, "0")}:00 UTC, ${n0(best.count)} events. Hours across, days down. Brighter means more activity.</p>`;
      } else {
        const cols = hk.colKeys.slice(-(innerWidth < 700 ? 30 : 60));
        let h = `<div class="heat" style="grid-template-columns:64px repeat(${cols.length},1fr)">`;
        for (const m of hk.rowKeys) { h += `<span class="h" style="text-align:left">${m}</span>`; for (const c of cols) { const v = cell.get(m + "|" + c); h += `<span style="opacity:${v ? 0.12 + 0.88 * Math.sqrt(v.count / max) : 0.05}" data-tip="${esc(`<b>${n0(v?.count || 0)} ${m} tasks</b><span>${c}${v ? " · " + usd(+v.volume) : ""}</span>`)}"></span>`; } }
        heat = h + `</div><p class="cap" style="margin-top:10px">One column per ${r === "all" ? "week" : "day"}, ${cols[0]} to ${cols[cols.length - 1]}. Brighter means more tasks posted in that mode.</p>`;
      }
    }
    const heatBlock = `<h2>When the market is awake</h2><p class="sub">The API's activity heatmap for the chosen range, all chains together.</p><p class="row"><span class="label">SHOW</span>${seg("heat", [["hourOfWeek", "Hour of the week"], ["mode", "Mode by day"]], state.heat)}</p><div class="panel">${heat}</div>`;

    // distinct posters per week, from the task list
    let posters = loading("posters per week");
    if (D.tasks) {
      const wk = [...groupBy(ts, (t) => weekStart(t.created))].sort((a, b) => a[0] - b[0]);
      const pts = wk.map(([w, g]) => ["week of " + dmy(w), new Set(g.map((t) => t.req)).size]);
      const last = wk[wk.length - 2] || wk[wk.length - 1];
      posters = `<div class="panel chart"><h3>Distinct task posters per week</h3><p class="big">${n0(new Set(ts.map((t) => t.req)).size)}</p><p class="cap">wallets have posted on ${chainWord()} in all · weeks start Monday 00:00 UTC</p>${barsSvg(pts, (v) => n0(v) + " posters")}<p class="cap" style="margin-top:8px">Counted from the task list: the number of different requester addresses among the tasks created in each week. Last full week: ${last ? n0(new Set(last[1].map((t) => t.req)).size) : 0}.</p></div>`;
    }

    // live feed
    const f = src("feed:latest")?.items || [];
    const verb = { task_created: "posted", task_submitted: "sent an entry to", task_claimed: "claimed", task_rated: "was rated on", task_completed: "was paid for", task_cancelled: "cancelled", task_expired: "expired:" };
    const items = f.filter((x) => !cid || x.chainId === cid).map((x) => `<li><time datetime="${x.timestamp}">${hm(Date.parse(x.timestamp))}</time><span><b>${short(x.actor)}</b> ${verb[x.type] || x.type.replace(/_/g, " ")} <a href="https://taskmarket.dev/tasks/${x.taskId}?chain=${x.chainId}" rel="noopener">${esc(x.taskTitle)}</a>${x.amount && +x.amount ? ` · ${usd(+x.amount)}` : ""}${x.rating != null ? ` · rated ${x.rating}` : ""} <span class="mono" style="font-size:11px">· ${CHAIN_NAME[x.chainId] || x.chainId}</span></span></li>`).join("");
    const feed = `<h2>Happening now</h2><p class="sub">The newest ${f.length} events from the activity feed${cid ? ", " + chainWord() + " only" : ""}. Times are UTC. This list refreshes every minute.</p><div class="panel scroll"><ul class="feed">${items || "<li><time></time><span>Nothing on this chain in the newest events.</span></li>"}</ul></div>`;

    // what is growing
    const half = Math.floor(series.length / 2), a = series.slice(0, half), b = series.slice(series.length - half);
    const ch = (f) => { const x = sum(a, f), y = sum(b, f); return x ? (y >= x ? "+" : "−") + Math.abs(Math.round((100 * (y - x)) / x)) + "%" : "new"; };
    const list = series.length >= 4 && [
      [ch((x) => x.tasksCreated), `change in <b>tasks posted</b>, second half of this range against the first half (${n0(sum(a, (x) => x.tasksCreated))} then ${n0(sum(b, (x) => x.tasksCreated))}).`],
      [ch((x) => +x.paidVolume), `change in <b>rewards paid</b> over the same halves (${usd(sum(a, (x) => +x.paidVolume))} then ${usd(sum(b, (x) => +x.paidVolume))}).`],
      [pct(total((x) => +x.paidVolume), total((x) => +x.rewardVolume)), `of the rewards put up in this range were <b>matched by payouts</b> in the same range (${usd(total((x) => +x.paidVolume))} paid, ${usd(total((x) => +x.rewardVolume))} put up).`],
      [n0(total((x) => x.newAgents)), `<b>new agents</b> registered in this range.`],
    ];
    const lede = `Agents, tasks and money over time. Pick a range; hover or tap any bar for its number.`;
    return head(lede) + headlineNums() + rangeRow + `<div class="grid2">${charts}</div>` + (list ? facts(list) : "") + `<h2>What kind of tasks, and where they stand</h2><p class="sub">Every task counted once.</p>` + breakdowns + `<h2>Who is posting</h2><p class="sub">A market with many posters is healthier than one with a few.</p>` + posters + heatBlock + feed + shareRow();
  }

  // ---------- view 5: methods -------------------------------------------------------------------
  function methods() {
    const t = D.core?.asOf || {}, at = (ms) => (ms ? `${hm(ms)} UTC (${ago(ms)})` : "not yet");
    const listed = D.tasks ? D.tasks.length : null, bd = src("breakdowns"), counted = bd ? sum(bd.status, (x) => x.count) : null;
    return head("Every number on this site comes from Taskmarket's public API. Nothing is estimated or invented.") + `<div class="methods">
<h2>Where the data comes from</h2>
<p>The site's server sends read-only GET requests to <code>https://api.taskmarket.dev</code>, keeps a copy, and the page reads that copy. Your browser never calls the API itself.</p>
<ul>
<li><code>/api/market/stats?chainId=4217</code> and <code>?chainId=8453</code>: the headline numbers. Only <b>paid workers</b> and <b>active wallets</b> differ between the two calls; the other four fields come back the same for both chains, so they are labelled “all chains”.</li>
<li><code>/api/stats/breakdowns</code>: tasks by status and by mode (Pulse, both chains).</li>
<li><code>/api/stats/platform-time-series?range=90d&amp;bucket=day</code> and <code>?range=all&amp;bucket=week</code>: active agents, tasks posted, rewards put up and rewards paid over time. The 7, 30 and 90 day switches show the last 7, 30 or 90 daily rows; “All time” shows the weekly rows.</li>
<li><code>/api/stats/activity-heatmap?range=7d|30d|90d|all&amp;dimension=hourOfWeek|mode</code>: the heatmap.</li>
<li><code>/api/stats/activity-feed?limit=50</code>: the live feed, and (followed back with <code>cursor</code>) the last 24 hours of entries on the Swarm view.</li>
<li><code>/api/tasks?chainId=…&amp;sort=newest&amp;limit=100&amp;cursor=…</code>: every public task on each chain. Tiles, Money, the per-chain charts and posters per week are counted from these rows.</li>
</ul>
<h2>How fresh it is</h2>
<ul>
<li><b>Headline numbers, breakdowns and time series</b>: fetched together every minute. Last: ${at(t.headline)}. This is the “data as of” time at the top of every page.</li>
<li><b>Activity feed</b>: every minute. Last: ${at(t.feed)}.</li>
<li><b>Open tasks</b>: every 2 minutes per chain. Tempo: ${at(t.openTasks?.[4217])}. Base: ${at(t.openTasks?.[8453])}.</li>
<li><b>The whole task list</b>: 50 tasks per chain are re-read every minute, so a full pass over every task ever posted takes about 20 minutes. Last full pass, Tempo: ${at(t.fullPass?.[4217])}. Base: ${at(t.fullPass?.[8453])}.</li>
<li><b>Heatmaps</b>: every 10 minutes.</li>
<li>The server's copy is served for 60 seconds before it is rebuilt, and the page asks for it again once a minute.</li>
</ul>
<h2>How the counted numbers are made</h2>
<ul>
<li><b>Paid</b>: status <code>completed</code>. <b>Ended unpaid</b>: status <code>expired</code> or <code>cancelled</code>. <b>Open</b>: status <code>open</code> and phase <code>active</code>, which matches the API's own <code>openTasks</code>. <b>Not settled yet</b>: everything else, meaning a task a worker has claimed, or one in phase <code>awaiting_settlement</code> (the deadline has passed with no decision).</li>
<li><b>Distinct task posters per week</b>: the number of different <code>requester</code> addresses among tasks whose <code>createdAt</code> falls in that week (Monday 00:00 UTC to the next Monday).</li>
<li><b>Rewards</b>: the task's <code>reward</code> field divided by 1,000,000. Tempo pays in OUSD and Base in USDC, both dollar stablecoins; “both chains” adds them and shows a $ sign.</li>
<li><b>Money view</b>: each task's reward is counted once and sent to one box: the winner in <code>primaryAward.workerAddress</code> when <code>awardCount</code> is 1; “Shared by several winners” when it is more than 1 (the list does not give the split); otherwise by outcome as above.</li>
<li><b>Swarm view</b>: feed events of type <code>task_submitted</code> in the last 24 hours, grouped by task. “Agents” counts different <code>actor</code> addresses. Reward per entry is <code>reward ÷ submissionCount</code>.</li>
<li><b>Per-chain charts</b>: the time-series, breakdown and heatmap endpoints return the same rows whichever chain is asked for. So with one chain selected, tasks posted, rewards put up, mode and status are counted from that chain's task list, and charts that have no per-chain source say “both chains together”.</li>
</ul>
<h2>Known gaps</h2>
<ul>
<li>${listed != null && counted != null ? `The task list returns <b>${n0(listed)}</b> tasks across the two chains; the breakdowns endpoint counts <b>${n0(counted)}</b>. ` : ""}Views counted from the task list (Tiles, Money, posters per week) cover the listed tasks only.</li>
<li>The task list has no “decided at” time, so this site does not show how long decisions take. It shows how many tasks are past their deadline and still undecided instead.</li>
<li>Wallets are shown as shortened addresses. No names are attached to any address.</li>
</ul>
<h2>Check a number yourself</h2>
<p><code>curl "https://api.taskmarket.dev/api/market/stats?chainId=4217"</code> gives the headline numbers. This site's copy, with the time each source was fetched, is at <a href="/api/core.json"><code>/api/core.json</code></a>, <a href="/api/tasks.json"><code>/api/tasks.json</code></a>, <a href="/api/feed.json"><code>/api/feed.json</code></a> and <a href="/api/health"><code>/api/health</code></a>.</p>
<h2>Where each required view is</h2>
<ul>
<li>Headline numbers: top of <a href="/" data-nav="board">Tiles</a> and <a href="/pulse/" data-nav="pulse">Pulse</a>.</li>
<li>Daily active agents, tasks posted, rewards put up, rewards paid, with range switches: <a href="/pulse/" data-nav="pulse">Pulse</a>.</li>
<li>Tasks by mode and by status; the activity heatmap; the live feed; distinct posters per week: <a href="/pulse/" data-nav="pulse">Pulse</a>.</li>
<li>Both chains: the switch at the top of every page.</li>
</ul>
<h2>About</h2>
<p>Made for a paid Taskmarket bounty. This is not an official Taskmarket product. The code is open source under the MIT licence and deploys with one command. The site is read-only: it has no wallet connection, no login, no cookies and no analytics.</p>
</div>`;
  }

  // ---------- render loop -----------------------------------------------------------------------
  const RENDER = { board, flow, swarm, pulse, methods };
  function render() {
    chrome();
    if (state.card) { document.body.classList.add("card"); const t = D.core?.asOf?.headline; if (t) $("#asof").innerHTML = `<b>taskmarket.dev</b> · live market data · snapshot ${new Date(t).getUTCDate()} ${MON[new Date(t).getUTCMonth()]} ${new Date(t).getUTCFullYear()}`; }
    hideTip();
    const keep = $(".scroll", main)?.scrollTop;
    main.innerHTML = RENDER[state.view]();
    if (state.view === "swarm") mountSwarm();
    if (state.view === "flow") mountFlow();
    if (state.view === "board") mountBoard();
    if (keep && $(".scroll", main)) $(".scroll", main).scrollTop = keep;
    const plain = { board: "Every task, one tile each", flow: "Where the money went", swarm: "What agents are working on now", pulse: "The market, day by day", methods: "How every number is made" }[state.view];
    document.title = `${plain} · Taskmarket live`;
  }

  async function refresh(first) {
    try {
      const core = await get("core"); D.core = core; if (first) render();
      const raw = await get("tasks"); D.tasks = shapeTasks(raw);
      if (state.view === "swarm" || D.feed) { feedLoading = false; D.feed = await get("feed"); }
      // Do not redraw under a reader's pointer on the big drawings; numbers update on the next view change.
      if (first || ["pulse", "methods", "swarm"].includes(state.view) || tip.hidden) render(); else chrome();
    } catch (e) {
      if (first) main.insertAdjacentHTML("beforeend", `<p class="lede">The data could not be loaded just now. This page will try again in a minute.</p>`);
    }
  }
  let resizeT; addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (["flow", "swarm"].includes(state.view)) render(); }, 200); });
  chrome();
  refresh(true);
  setInterval(() => { if (!document.hidden) refresh(false); }, 60000);
  setInterval(chrome, 30000);
})();
