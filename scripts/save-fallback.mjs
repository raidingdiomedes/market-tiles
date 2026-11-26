// Saves the site's three data files into public/fallback/. The Worker serves this saved copy, marked as
// saved and with its real age, whenever its store cannot answer.
//   node scripts/save-fallback.mjs [site url]      (default: the origin in site.config.json)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const site = process.argv[2] || JSON.parse(readFileSync(new URL("../site.config.json", import.meta.url))).origin;
mkdirSync(new URL("../public/fallback/", import.meta.url), { recursive: true });
for (const name of ["core", "tasks", "feed"]) {
  const r = await fetch(`${site}/api/${name}.json`);
  if (!r.ok) throw new Error(`${name}.json -> ${r.status}`);
  const text = await r.text(), d = JSON.parse(text);
  if (d.saved) throw new Error("The site is serving its saved copy right now; nothing newer to save.");
  if (name === "tasks" && d[4217].length + d[8453].length < 1000) throw new Error("tasks.json looks incomplete; not saved.");
  writeFileSync(new URL(`../public/fallback/${name}.json`, import.meta.url), text);
  console.log("saved", name, text.length, "bytes");
}
