// Market Tiles: server side.
//
// The Taskmarket API does not allow browser requests from other sites, so this Worker fetches it,
// keeps a compact copy in one Durable Object, and serves that copy to the page as two JSON files:
//   /api/core.json   headline numbers, breakdowns, time series, heatmaps, newest activity
//   /api/feed.json   the last 24 hours of activity, one short row each
//   /api/tasks.json  every public task on both chains, one short row each
//   /api/health      when each source was last fetched
// It only ever sends GET requests to the endpoints listed in SOURCES below. No keys, no wallet, no writes.
//
// Free-plan budget: each run does one or two small fetches so it stays inside 10 ms of CPU.
//
// Storage budget: the Durable Object is put to sleep between runs and reloads its copy every time it
// wakes (several times a minute), and the free plan allows 5 million rows read a day. So tasks are
// stored a week per row and the feed an hour per row: a wake reads a few dozen rows, not thousands.
// If the store cannot answer at all, the Worker serves the saved copy in public/fallback/, marked as saved.

import { DurableObject } from "cloudflare:workers";

const API = "https://api.taskmarket.dev";
const CHAINS = [4217, 8453]; // Tempo, Base
const UA = "market-tiles (read-only dashboard cache)";

// Small endpoints, stored exactly as the API returns them (never parsed here, so never altered).
const SMALL = {
  "stats:4217": "/api/market/stats?chainId=4217",
  "stats:8453": "/api/market/stats?chainId=8453",
  breakdowns: "/api/stats/breakdowns",
  "series:day": "/api/stats/platform-time-series?range=90d&bucket=day",
  "series:week": "/api/stats/platform-time-series?range=all&bucket=week",
  "heat:hourOfWeek:7d": "/api/stats/activity-heatmap?range=7d&dimension=hourOfWeek",
  "heat:hourOfWeek:30d": "/api/stats/activity-heatmap?range=30d&dimension=hourOfWeek",
  "heat:hourOfWeek:90d": "/api/stats/activity-heatmap?range=90d&dimension=hourOfWeek",
  "heat:hourOfWeek:all": "/api/stats/activity-heatmap?range=all&dimension=hourOfWeek",
  "heat:mode:7d": "/api/stats/activity-heatmap?range=7d&dimension=mode",
  "heat:mode:30d": "/api/stats/activity-heatmap?range=30d&dimension=mode",
  "heat:mode:90d": "/api/stats/activity-heatmap?range=90d&dimension=mode",
  "heat:mode:all": "/api/stats/activity-heatmap?range=all&dimension=mode",
};
const HEADLINE = ["stats:4217", "stats:8453", "breakdowns", "series:day", "series:week"];
const HEAT = Object.keys(SMALL).filter((k) => k.startsWith("heat:"));

const STATUS = ["open", "claimed", "worker_selected", "pending_approval", "completed", "expired", "cancelled"];
const MODE = ["bounty", "claim", "pitch", "benchmark", "auction"];
const PHASE = ["active", "in_review", "awaiting_settlement", "resolved"];
const FEED_TYPES = ["task_created", "task_submitted", "task_claimed", "task_completed", "task_rated", "task_cancelled", "task_expired"];
const FEED_HOURS = 24; // the swarm view looks back this far
const FEED_MAX = 4000;
const SNAPSHOT_TTL = 60_000; // the served copy is rebuilt at most once a minute
const TASK_BUCKET = 7 * 86400; // tasks are stored one row per chain and week of creation
const HOUR = 3600_000; // the feed is stored one row per hour

const idx = (list, v) => { const i = list.indexOf(v); return i < 0 ? v : i; };
const secs = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : 0);

// One task from the API becomes one short row. Order matters: the page reads rows by position.
function compact(t) {
  const title = String(t.description || "").split("\n")[0].replace(/\s+/g, " ").trim().slice(0, 72);
  return JSON.stringify([
    t.id, t.referenceCode, title, t.requester,
    t.primaryAward ? t.primaryAward.workerAddress : null,
    t.awardCount || 0, Number(t.reward) || 0, secs(t.createdAt), secs(t.expiryTime),
    idx(STATUS, t.status), idx(MODE, t.mode), idx(PHASE, t.phase), t.submissionCount || 0,
  ]);
}

async function getText(path) {
  const r = await fetch(API + path, { headers: { accept: "application/json", "user-agent": UA } });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.text();
}

export class Store extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS small (k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    // Task rows, packed: one stored row per chain and week ("4217:2950"), task rows inside joined by newlines.
    this.sql.exec("CREATE TABLE IF NOT EXISTS taskweek (k TEXT PRIMARY KEY, body TEXT NOT NULL)");
    // Feed rows, packed the same way: one stored row per hour.
    this.sql.exec("CREATE TABLE IF NOT EXISTS feedhour (h INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    this.tasks = { 4217: new Map(), 8453: new Map() };
    this.weekIds = new Map(); this.weekOf = new Map(); this.weekDirty = new Set();
    this.openNow = {}; this.openBefore = {}; this.left = []; // tasks that have just left the open list
    for (const r of this.sql.exec("SELECT k, body FROM taskweek")) {
      const chain = Number(r.k.split(":")[0]), map = this.tasks[chain], ids = new Set();
      if (!map) continue;
      for (const row of r.body.split("\n")) if (row) { const id = row.slice(2, row.indexOf('"', 2)); map.set(id, row); ids.add(id); this.weekOf.set(id, r.k); }
      this.weekIds.set(r.k, ids);
    }
    this.meta = {};
    for (const r of this.sql.exec("SELECT k, v FROM meta")) this.meta[r.k] = JSON.parse(r.v);
    this.feedRows = []; this.feedDirty = new Set();
    const cut = Date.now() - FEED_HOURS * HOUR;
    for (const r of this.sql.exec("SELECT body FROM feedhour WHERE h >= ?", Math.floor(cut / HOUR)))
      for (const row of r.body.split("\n")) if (row) { const ts = Number(row.slice(1, row.indexOf(","))); if (ts >= cut) this.feedRows.push([ts, row]); }
    this.feedSeen = new Set(this.feedRows.map((r) => r[1]));
    this.cache = {};
    this.moveOldTables(cut);
  }

  // One time, after the deploy that introduced packed rows: copy the old one-row-per-item tables across.
  moveOldTables(cut) {
    const old = new Set([...this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('task', 'feed')")].map((r) => r.name));
    if (old.has("task")) {
      for (const r of this.sql.exec("SELECT id, chain, created, row FROM task")) if (this.tasks[r.chain] && !this.tasks[r.chain].has(r.id)) this.putTask(r.chain, r.id, r.created, r.row);
      this.flushTasks();
      this.sql.exec("DROP TABLE task");
    }
    if (old.has("feed")) {
      for (const r of this.sql.exec("SELECT ts, row FROM feed WHERE ts >= ?", cut)) if (!this.feedSeen.has(r.row)) this.addFeed(r.ts, r.row);
      this.flushFeed();
      this.sql.exec("DROP TABLE feed");
    }
  }

  // Keep one task row in memory and note which stored week has to be written again.
  putTask(chain, id, created, row) {
    this.tasks[chain].set(id, row);
    const k = chain + ":" + Math.floor(created / TASK_BUCKET), was = this.weekOf.get(id);
    if (was && was !== k) { this.weekIds.get(was)?.delete(id); this.weekDirty.add(was); }
    if (!this.weekIds.has(k)) this.weekIds.set(k, new Set());
    this.weekIds.get(k).add(id); this.weekOf.set(id, k); this.weekDirty.add(k);
  }
  flushTasks() {
    for (const k of this.weekDirty) {
      const map = this.tasks[Number(k.split(":")[0])];
      const body = [...this.weekIds.get(k)].map((id) => map.get(id)).join("\n");
      this.sql.exec("INSERT INTO taskweek (k, body) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET body = excluded.body", k, body);
    }
    this.weekDirty.clear();
  }
  addFeed(ts, row) {
    this.feedSeen.add(row); this.feedRows.push([ts, row]); this.feedDirty.add(Math.floor(ts / HOUR));
  }
  flushFeed() {
    for (const h of this.feedDirty) {
      const body = this.feedRows.filter((r) => Math.floor(r[0] / HOUR) === h).map((r) => r[1]).join("\n");
      this.sql.exec("INSERT INTO feedhour (h, body) VALUES (?, ?) ON CONFLICT(h) DO UPDATE SET body = excluded.body", h, body);
    }
    this.feedDirty.clear();
  }

  setMeta(k, v) {
    this.meta[k] = v;
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v));
  }
  putSmall(k, v, at) {
    this.sql.exec("INSERT INTO small (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at", k, v, at);
  }

  // --- fetching -----------------------------------------------------------------------------

  async fetchSmall(keys) {
    const at = Date.now();
    const got = await Promise.all(keys.map((k) => getText(SMALL[k]).then((v) => [k, v], () => null)));
    for (const g of got) if (g && (g[1][0] === "{" || g[1][0] === "[")) this.putSmall(g[0], g[1], at);
    return got.every(Boolean);
  }

  // Activity feed. The newest page is kept exactly as the API returned it (for the live feed);
  // a compact 24-hour log of the same items feeds the swarm view. Only new rows are written.
  async fetchFeed(cursor) {
    const text = await getText("/api/stats/activity-feed?limit=50" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    const d = JSON.parse(text);
    const at = Date.now();
    if (!cursor) this.putSmall("feed:latest", text, at);
    for (const x of d.items) {
      const ts = Date.parse(x.timestamp);
      const row = JSON.stringify([ts, idx(FEED_TYPES, x.type), x.taskId.slice(0, 18), x.chainId, String(x.actor || "").slice(0, 10), x.amount == null ? null : Number(x.amount), x.rating]);
      if (!this.feedSeen.has(row)) this.addFeed(ts, row);
    }
    this.flushFeed();
    if (!cursor) {
      this.setMeta("feedAt", at);
      // Once an hour, drop rows older than the window.
      if (at - (this.feedTrimmed || 0) > 3600_000) {
        this.feedTrimmed = at;
        const cut = at - FEED_HOURS * HOUR;
        this.sql.exec("DELETE FROM feedhour WHERE h < ?", Math.floor(cut / HOUR));
        this.feedRows = this.feedRows.filter((r) => r[0] >= cut);
        this.feedSeen = new Set(this.feedRows.map((r) => r[1]));
      }
    }
    return d;
  }

  // After a deploy: walk the feed back until it covers the last 24 hours, one page per call.
  async backfillFeed() {
    const b = this.meta.feedBackfill2 || { cursor: null, pages: 0, done: false };
    if (b.done) return;
    const d = await this.fetchFeed(b.cursor || undefined);
    const last = d.items[d.items.length - 1];
    const reached = !last || Date.parse(last.timestamp) < Date.now() - FEED_HOURS * HOUR;
    this.setMeta("feedBackfill2", { cursor: d.nextCursor || null, pages: b.pages + 1, done: reached || !d.nextCursor || b.pages + 1 >= 80 });
  }

  // Store one page of the task list. Only rows that changed are written.
  async fetchTasks(chain, query) {
    const d = JSON.parse(await getText(`/api/tasks?chainId=${chain}&limit=${this.ready() ? 50 : 100}&${query}`));
    const map = this.tasks[chain];
    for (const t of d.tasks) {
      const row = compact(t);
      if (map.get(t.id) !== row) this.putTask(chain, t.id, secs(t.createdAt), row);
    }
    this.flushTasks();
    return d;
  }

  // Walk the whole task list, newest to oldest, one page per call. A full pass re-reads every task.
  async sweep(chain) {
    const s = this.meta["sweep:" + chain] || {};
    const d = await this.fetchTasks(chain, "sort=newest" + (s.cursor ? "&cursor=" + encodeURIComponent(s.cursor) : ""));
    if (d.hasMore && d.nextCursor) this.setMeta("sweep:" + chain, { ...s, cursor: d.nextCursor });
    else this.setMeta("sweep:" + chain, { cursor: null, doneAt: Date.now(), passes: (s.passes || 0) + 1 });
  }

  ready() { return CHAINS.every((c) => this.meta["sweep:" + c]?.doneAt) && !!this.meta.feedBackfill2?.done; }

  // Called every minute by the cron trigger. Each call is a small slice of work.
  async tick() {
    const n = (this.meta.tick || 0) + 1;
    this.setMeta("tick", n);
    const jobs = [];
    if (!this.ready()) {
      // First run after a deploy: fill the cache quickly, one page per call, then carry on by alarm.
      const chain = CHAINS.find((c) => !this.meta["sweep:" + c]?.doneAt);
      if (chain) jobs.push(this.sweep(chain));
      else jobs.push(this.backfillFeed());
      if (n % 4 === 1) jobs.push(this.fetchSmall(HEADLINE).then((ok) => ok && this.setMeta("headlineAt", Date.now())));
      if (n % 4 === 2) jobs.push(this.fetchSmall(HEAT));
      if (n % 4 === 3 && chain) jobs.push(this.backfillFeed());
      await this.ctx.storage.setAlarm(Date.now() + 3000);
    } else {
      // Steady state. The minute's work is cut into four small steps, 14 seconds apart, so that each
      // one stays inside the free plan's 10 ms of CPU: this step, then three more run by alarm().
      // Step 0: activity feed, plus the headline numbers, breakdowns and time series (stored as text,
      // never parsed) in the same moment.
      jobs.push(this.fetchFeed(), this.fetchSmall(HEADLINE).then((ok) => ok && this.setMeta("headlineAt", Date.now())));
      if (n % 10 === 4) jobs.push(this.fetchSmall(HEAT));
      this.setMeta("step", 1);
      await this.ctx.storage.setAlarm(Date.now() + 14_000);
    }
    const res = await Promise.allSettled(jobs);
    const err = res.find((r) => r.status === "rejected");
    this.setMeta("lastRun", { at: Date.now(), ok: !err, error: err ? String(err.reason).slice(0, 200) : null });
    return { tick: n, ready: this.ready() };
  }

  // Steps 1 to 3 of each minute: open tasks of one chain, then one page of the full pass per chain.
  async alarm() {
    if (!this.ready()) return void (await this.tick());
    const step = this.meta.step || 0, n = this.meta.tick || 0;
    if (step < 1 || step > 3) return;
    this.setMeta("step", step + 1);
    if (step < 3) await this.ctx.storage.setAlarm(Date.now() + 14_000);
    try {
      if (step === 1) await this.openPage(CHAINS[n % 2]);
      else await this.sweep(CHAINS[step - 2]);
      if (this.left.length) await this.rereadLeft();
    } catch (e) {
      this.setMeta("lastRun", { at: Date.now(), ok: false, error: String(e).slice(0, 200) });
    }
  }

  // Open tasks of one chain, 50 at a time; when there are more than 50 the next call continues.
  // A task that was open on the last pass and is missing from this one has just been decided, expired
  // or cancelled. Those are re-read one by one straight away instead of waiting for the full pass.
  async openPage(chain) {
    const c = this.meta["openCursor:" + chain];
    if (!c) this.openNow[chain] = new Set();
    const d = await this.fetchTasks(chain, "status=open&sort=newest" + (c ? "&cursor=" + encodeURIComponent(c) : ""));
    const now = this.openNow[chain];
    if (now) for (const t of d.tasks) now.add(t.id);
    if (d.hasMore && d.nextCursor) return this.setMeta("openCursor:" + chain, d.nextCursor);
    this.setMeta("openCursor:" + chain, null); this.setMeta("open:" + chain, Date.now());
    const before = this.openBefore[chain];
    if (now && before) for (const id of before) if (!now.has(id) && this.left.length < 60) this.left.push([chain, id]);
    if (now) this.openBefore[chain] = now;
    this.openNow[chain] = null;
  }

  // Re-read up to three tasks that have just left the open list.
  async rereadLeft() {
    for (const [chain, id] of this.left.splice(0, 3)) {
      const t = JSON.parse(await getText(`/api/tasks/${id}?chainId=${chain}`));
      if (!t || t.id !== id) continue;
      const row = compact(t);
      if (this.tasks[chain].get(id) !== row) this.putTask(chain, id, secs(t.createdAt), row);
    }
    this.flushTasks();
  }

  // --- serving ------------------------------------------------------------------------------

  times() {
    const m = this.meta;
    return {
      headline: m.headlineAt || null,
      feed: m.feedAt || null,
      openTasks: { 4217: m["open:4217"] || null, 8453: m["open:8453"] || null },
      fullPass: { 4217: m["sweep:4217"]?.doneAt || null, 8453: m["sweep:8453"]?.doneAt || null },
      lastRun: m.lastRun || null,
    };
  }

  feedItems() {
    const cut = Date.now() - FEED_HOURS * HOUR;
    return this.feedRows.filter((r) => r[0] >= cut).sort((a, b) => b[0] - a[0]).slice(0, FEED_MAX).map((r) => r[1]).join(",");
  }

  build(name) {
    if (name === "tasks") {
      const part = (c) => `"${c}":[${[...this.tasks[c].values()].join(",")}]`;
      return `{"asOf":${JSON.stringify(this.times())},"ready":${this.ready()},"columns":["id","ref","title","requester","winner","awards","reward","created","expiry","status","mode","phase","entries"],"status":${JSON.stringify(STATUS)},"mode":${JSON.stringify(MODE)},"phase":${JSON.stringify(PHASE)},${part(4217)},${part(8453)}}`;
    }
    const parts = [];
    for (const r of this.sql.exec("SELECT k, v, at FROM small")) parts.push(`${JSON.stringify(r.k)}:{"at":${r.at},"data":${r.v}}`);
    if (name === "feed") return `{"asOf":${JSON.stringify(this.times())},"hours":${FEED_HOURS},"columns":["time","type","taskId","chainId","actor","amount","rating"],"types":${JSON.stringify(FEED_TYPES)},"items":[${this.feedItems()}]}`;
    return `{"asOf":${JSON.stringify(this.times())},"ready":${this.ready()},"sources":{${parts.join(",")}}}`;
  }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/tick") return Response.json(await this.tick());
    if (path === "/api/health") return Response.json({ ok: true, ready: this.ready(), asOf: this.times(), tasks: { 4217: this.tasks[4217].size, 8453: this.tasks[8453].size } });
    const name = { "/api/core.json": "core", "/api/tasks.json": "tasks", "/api/feed.json": "feed" }[path];
    if (!name) return new Response("not found", { status: 404 });
    const now = Date.now();
    // Safety net: if the every-minute schedule is late (it can be, just after a deploy), a page view starts the next slice.
    if (now - (this.meta.lastRun?.at || 0) > 150_000 && now - (this.kick || 0) > 60_000) { this.kick = now; this.ctx.waitUntil(this.tick().catch(() => {})); }
    let c = this.cache[name];
    if (!c || now - c.at > SNAPSHOT_TTL) c = this.cache[name] = { at: now, body: this.build(name) };
    return new Response(c.body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=60",
        "x-snapshot-built": new Date(c.at).toISOString(),
      },
    });
  }
}

// The store could not answer (for example the plan's daily storage allowance is used up): serve the
// copy saved in public/fallback/ instead, marked "saved" so the page says so and shows its real age.
async function saved(url, env) {
  const name = { "/api/core.json": "core", "/api/tasks.json": "tasks", "/api/feed.json": "feed" }[url.pathname];
  const r = name && (await env.ASSETS.fetch(new URL(`/fallback/${name}.json`, url)));
  if (!r || !r.ok) return Response.json({ ok: false, saved: true, note: "The live store is not answering; the data files are being served from a saved copy." }, { status: 503 });
  return new Response('{"saved":true,' + (await r.text()).slice(1), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=60", "x-served": "saved-copy" },
  });
}

export default {
  async fetch(req, env) {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("read-only", { status: 405 });
    const url = new URL(req.url);
    if (url.pathname === "/tick") return new Response("not found", { status: 404 });
    try {
      const r = await env.STORE.get(env.STORE.idFromName("main")).fetch(req);
      if (r.status < 500) return r;
    } catch {}
    return saved(url, env);
  },
  async scheduled(event, env, ctx) {
    const store = env.STORE.get(env.STORE.idFromName("main"));
    ctx.waitUntil(store.fetch("https://store/tick"));
  },
};
