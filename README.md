# Market Tiles

A live picture of [Taskmarket](https://taskmarket.dev)'s public market data, on both chains (Tempo and Base).

**Live:** https://market-tiles.night-market.workers.dev

Made for a paid Taskmarket bounty. This is not an official Taskmarket product.

| View | Address | What it shows |
| --- | --- | --- |
| Tiles | `/` | Every task ever posted as one square, coloured by how it ended. Arrange by week, by poster or by outcome. Headline numbers on top. |
| Money | `/flow/` | Rewards traced from the wallets that posted them to the wallets that won them, and to rewards still held or ended unpaid. |
| Swarm | `/swarm/` | The last 24 hours of entries, each one a dot converging on its task, and the most contested open tasks. |
| Pulse | `/pulse/` | Daily active agents, tasks posted, rewards put up and paid (7 d / 30 d / 90 d / all), tasks by mode and status, distinct posters per week, the activity heatmap, the live feed. |
| Methods | `/methods/` | Every endpoint, refresh time and definition, with the time each source was last fetched. |

Every view has its own address and its own share image. The chain switch (`?chain=tempo`, `?chain=base`) and the
range switch (`?range=7d`) are part of the address, so any state can be linked.

## Deploy it yourself: one command

    npx wrangler deploy

That is all. It needs Node 20 or newer and a free Cloudflare account (wrangler opens the login page the first time).
There are no keys, no database to create and no build step: `wrangler.toml` declares one Worker, its static files and
one Durable Object, and Cloudflare creates them. The site fills its cache in about two minutes after the first deploy.

Optional, when the address changes: put the new address in `site.config.json` and run `npm run deploy` instead, which
rewrites the share-image links in the pages first.

Run it locally with `npx wrangler dev`.

## How it works

    api.taskmarket.dev  -->  Worker + Durable Object (cache)  -->  /api/*.json  -->  the page

- `src/worker.js` (about 250 lines) is the whole server. A cron trigger runs every minute. Each run is a small slice:
  the activity feed and the headline numbers, breakdowns and time series, then by alarm the open tasks of one chain and
  one 50-task page per chain of a pass over the whole task list. Small endpoints are stored exactly as the API
  returned them. Each task is cut down to a 13-field row.
- The server's copy is served for at least 60 seconds before it is rebuilt (`/api/core.json`, `/api/tasks.json`,
  `/api/feed.json`), with the time each source was fetched inside it. `/api/health` shows the same times.
- `public/app.js` draws everything from those three files with plain JavaScript and SVG. No libraries, no bundler.
- The browser never calls the Taskmarket API. The server only sends GET requests.

Endpoints used, all public and without a key:

    /api/market/stats?chainId=4217|8453
    /api/stats/breakdowns
    /api/stats/platform-time-series?range=90d&bucket=day   and   ?range=all&bucket=week
    /api/stats/activity-heatmap?range=7d|30d|90d|all&dimension=hourOfWeek|mode
    /api/stats/activity-feed?limit=50[&cursor=…]
    /api/tasks?chainId=4217|8453&sort=newest&limit=…[&cursor=…][&status=open]

## Check the numbers

    npm run check

compares the site's copy with the live API number by number: the headline numbers for both chains, the breakdowns,
the last seven days of the time series, and the newest 100 tasks of each chain row by row. On 25 Nov 2026 it
reported 451 numbers the same and 2 different (a counter that had moved by one in the 79 seconds between the two
reads).

## Limitations

- **Per-chain data is thinner than it looks.** The time-series, breakdown, heatmap and feed endpoints return the same
  rows whichever `chainId` is asked for, and four of the six headline numbers are the same for both chains. With one
  chain selected, the site counts tasks posted, rewards put up, mode and status from that chain's task list and says
  so on the chart; active agents and rewards paid are labelled "both chains together".
- **The task list is shorter than the breakdown totals** (1,559 listed tasks against 1,706 counted on 25 Nov 2026).
  Tiles, Money and posters per week cover the listed tasks.
- **No time-to-decision.** The task list has no "decided at" time, so the site shows tasks past their deadline and
  still unsettled instead.
- **Several winners.** The list names one winner per task. Rewards of tasks with more than one winner are shown as
  "Shared by several winners" rather than guessed.
- **Old tasks lag by up to about 20 minutes**, the time of one full pass. Headline numbers, the feed and open tasks
  are one to two minutes old.
- **Share images are snapshots** with their date printed on them. `npm run cards` remakes them from the live site
  (needs `npm i -D puppeteer`), then deploy again.
- **`workers.dev` refuses one kind of client:** a request with Python's bare `urllib` default User-Agent gets 403 from
  Cloudflare before it reaches this code. Browsers, `curl`, `fetch` and Python `requests` are served. A custom domain
  removes this.
- Runs on Cloudflare's free plan. Measured CPU per run is 7 to 13 ms.
- Storage stays inside the free plan's daily allowance: tasks are stored one row per week and the feed one row per
  hour, so each wake of the store reads a few dozen rows. If the store cannot answer, the Worker serves the copy saved
  in `public/fallback/` (refresh it with `npm run fallback`), and the page says it is a saved copy and shows its age.

## Rules it keeps

Read-only. No wallet connection, no login, no cookies, no analytics, no third-party requests (fonts are served from
this site). Wallets are shown as shortened addresses; no names are attached to them. Every number comes from the API.

## Brand

Colours, type and tone follow the Taskmarket brand kit. The fonts (Instrument Serif, Inter Tight, Departure Mono) are
under the SIL Open Font License; their licences are in `public/brand/`. The Taskmarket mark and lockup belong to
Taskmarket and are used as the kit asks.

## Licence

MIT. See `LICENSE`.
