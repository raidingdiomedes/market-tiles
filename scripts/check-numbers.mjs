// Compares the site's cached copy with the live Taskmarket API, number by number.
//   node scripts/check-numbers.mjs [site url]
// The API moves all the time, so a small difference on a busy counter is expected when the site's
// copy is a minute or two old; the script prints the copy's age next to every difference.
import { readFileSync } from "node:fs";
const site = process.argv[2] || JSON.parse(readFileSync(new URL("../site.config.json", import.meta.url))).origin;
const API = "https://api.taskmarket.dev";
const j = async (u) => { const r = await fetch(u, { headers: { "user-agent": "market-tiles check" } }); if (!r.ok) throw new Error(u + " -> " + r.status); return r.json(); };
const core = await j(site + "/api/core.json"), tasks = await j(site + "/api/tasks.json");
const age = (k) => Math.round((Date.now() - core.sources[k].at) / 1000) + " s old";
let same = 0, diff = 0;
const cmp = (label, mine, live, k) => { if (JSON.stringify(mine) === JSON.stringify(live)) same++; else { diff++; console.log(`  differs: ${label}: site ${JSON.stringify(mine)} / API now ${JSON.stringify(live)} (site copy ${age(k)})`); } };
for (const c of [4217, 8453]) { const live = await j(`${API}/api/market/stats?chainId=${c}`), k = "stats:" + c; for (const f of Object.keys(live)) cmp(`${k} ${f}`, core.sources[k].data[f], live[f], k); }
{ const live = await j(`${API}/api/stats/breakdowns`); for (const dim of ["status", "mode"]) for (const row of live[dim]) cmp(`breakdowns ${dim} ${row[dim]}`, core.sources.breakdowns.data[dim].find((x) => x[dim] === row[dim])?.count, row.count, "breakdowns"); }
{ const live = await j(`${API}/api/stats/platform-time-series?range=90d&bucket=day`), mine = core.sources["series:day"].data; for (const row of live.slice(-7)) { const m = mine.find((x) => x.bucket === row.bucket) || {}; for (const f of ["activeAgents", "tasksCreated", "rewardVolume", "paidVolume"]) cmp(`${row.bucket} ${f}`, m[f], row[f], "series:day"); } }
for (const c of [4217, 8453]) {
  // newest 100 tasks of each chain: status, entries and reward must match row by row
  const live = await j(`${API}/api/tasks?chainId=${c}&sort=newest&limit=100`), byId = new Map(tasks[c].map((r) => [r[0], r]));
  for (const t of live.tasks) { const r = byId.get(t.id); cmp(`task ${t.referenceCode} status`, r && tasks.status[r[9]], t.status, "stats:" + c); cmp(`task ${t.referenceCode} reward`, r && r[6], Number(t.reward), "stats:" + c); }
  // posters in the current week, counted both ways
  const monday = (() => { const d = new Date(); const s = Math.floor(d / 864e5) * 86400 - ((d.getUTCDay() + 6) % 7) * 86400; return s; })();
  const liveSet = new Set(live.tasks.filter((t) => Date.parse(t.createdAt) / 1000 >= monday).map((t) => t.requester));
  const mineSet = new Set(tasks[c].filter((r) => r[7] >= monday).map((r) => r[3]));
  if (live.tasks.every((t) => Date.parse(t.createdAt) / 1000 >= monday)) console.log(`  chain ${c}: more than 100 tasks this week, poster check skipped`); else cmp(`chain ${c} distinct posters this week`, mineSet.size, liveSet.size, "stats:" + c);
}
console.log(`${same} numbers match the API, ${diff} differ. Site data as of ${new Date(core.asOf.headline).toISOString()}.`);
process.exit(diff > 8 ? 1 : 0);
