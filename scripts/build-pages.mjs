// Writes one small HTML file per view from templates/page.html, so every view has its own address,
// title and share image. Run: node scripts/build-pages.mjs  (also run by `npm run build`).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const cfg = JSON.parse(readFileSync(new URL("../site.config.json", import.meta.url)));
const tpl = readFileSync(new URL("../templates/page.html", import.meta.url), "utf8");
const views = [
  { view: "board", path: "/", file: "index.html", title: "Every task, one tile each · Taskmarket live", headlineHtml: "Every task, one <em>tile</em> each.", description: "A live wall of every task posted on Taskmarket, one square each: paid, open, waiting on a decision, or ended unpaid. Tempo and Base.", imageAlt: "A wall of small squares, one per Taskmarket task, coloured by how each task ended." },
  { view: "flow", path: "/flow/", file: "flow/index.html", title: "Where the money went · Taskmarket live", headlineHtml: "Where the money <em>went.</em>", description: "Taskmarket rewards, traced from the wallets that posted them to the wallets that won them, live from the public API.", imageAlt: "Ribbons of reward money flowing from posters on the left to winners on the right." },
  { view: "swarm", path: "/swarm/", file: "swarm/index.html", title: "What agents are working on now · Taskmarket live", headlineHtml: "What agents are working on <em>now.</em>", description: "The last 24 hours of entries on Taskmarket, each one a dot converging on the task it was sent to.", imageAlt: "Dots streaming toward squares: entries converging on the most contested tasks." },
  { view: "pulse", path: "/pulse/", file: "pulse/index.html", title: "The market, day by day · Taskmarket live", headlineHtml: "The market, day by <em>day.</em>", description: "Daily active agents, tasks posted, rewards put up and paid, tasks by mode and status, the activity heatmap and a live feed for Taskmarket.", imageAlt: "Bar charts of daily Taskmarket activity." },
  { view: "methods", path: "/methods/", file: "methods/index.html", title: "How every number is made · Taskmarket live", headlineHtml: "How every number is <em>made.</em>", description: "The endpoints, refresh times and definitions behind every number on this Taskmarket market visualizer.", imageAlt: "A wall of small squares, one per Taskmarket task." },
];
for (const v of views) {
  const vars = { ...v, card: v.view === "methods" ? "board" : v.view, origin: cfg.origin, repo: cfg.repo, lede: v.description };
  const html = tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
  const out = new URL("../public/" + v.file, import.meta.url);
  mkdirSync(new URL(".", out), { recursive: true });
  writeFileSync(out, html);
}
writeFileSync(new URL("../public/404.html", import.meta.url), tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => ({ ...views[0], card: "board", origin: cfg.origin, repo: cfg.repo, lede: "That page does not exist. The views are in the menu above.", title: "Not found · Taskmarket live" }[k] ?? "")));
console.log("wrote", views.length + 1, "pages for", cfg.origin);
