// Screenshots of the site for checking and for the share cards.
//   node scripts/shoot.mjs <base url> <out dir> <WxH> [--full] name=/path ...
// Needs puppeteer (npm i -D puppeteer) or PUPPETEER_FROM=<folder that has it in node_modules>.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const puppeteer = createRequire(path.join(process.env.PUPPETEER_FROM || process.cwd(), "x.js"))("puppeteer");
const [base, outDir, size, ...rest] = process.argv.slice(2);
const full = rest.includes("--full");
const [W, H] = size.split("x").map(Number);
fs.mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ["--no-sandbox", "--hide-scrollbars"] });
for (const [name, p] of rest.filter((a) => a !== "--full").map((a) => a.split(/=(.*)/s))) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setViewport({ width: W, height: H, deviceScaleFactor: W < 500 ? 2 : 1, isMobile: W < 500 });
  await page.goto(base + p, { waitUntil: "networkidle0", timeout: 45000 });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 900));
  const file = path.join(outDir, name + (name.endsWith(".png") ? "" : ".jpg"));
  await page.screenshot({ path: file, fullPage: full, ...(file.endsWith(".jpg") ? { type: "jpeg", quality: 82 } : {}) });
  console.log(errors.length ? "ERRORS " + errors.join(" | ").slice(0, 300) : "ok", name);
  await page.close();
}
await browser.close();
