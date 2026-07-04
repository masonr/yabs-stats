# [yabs-stats](https://stats.yabs.sh/)

Static usage statistics for [YABS](https://github.com/masonr/yet-another-bench-script), generated from Cloudflare Analytics and published with GitHub Pages.

Dashboard: https://stats.yabs.sh/

YABS is commonly run with:

```sh
curl -sL yabs.sh | bash
```

This repository tracks public aggregate usage for `yabs.sh` without running any application servers, databases, containers, schedulers, or API backends.

## How It Works

The whole system is intentionally small:

```text
GitHub Actions
  -> Cloudflare GraphQL API
  -> scripts/update_stats.py
  -> docs/data/stats.json
  -> Git commit
  -> GitHub Pages
  -> Browser
```

The browser only downloads `docs/data/stats.json`. There is no REST API and no server-side dashboard process.

Git history is the persistent store. Each update loads the existing JSON file, merges newly fetched Cloudflare data, writes the file only if it changed, and commits it back to the repository.

## Repository Layout

```text
.github/workflows/update.yml  Scheduled stats updater
docs/index.html               GitHub Pages entrypoint
docs/app.js                   Dashboard JavaScript
docs/style.css                Dashboard styles
docs/data/stats.json          Static JSON data consumed by the browser
scripts/cloudflare.py         Tiny Cloudflare GraphQL client
scripts/update_stats.py       Stats fetch, merge, and generation script
requirements.txt              Python dependencies
```

## Data

`docs/data/stats.json` contains:

- `summary`: headline counters such as all-time, today, last 7 days, and last 30 days
- `history`: daily request history, including daily unique IPs and country breakdowns
- `countries`: recent country totals for compatibility and initial display
- `hourly`: recent rolling hourly data
- `activity`: recent Cloudflare request-source totals

Cloudflare plan limits control how far back each API can read. Daily history has the longest retention; hourly and request-source data are short rolling windows. Once daily history is written to `stats.json`, future runs preserve it even after Cloudflare no longer exposes that day.

## Local Updates

Create a local `.env` file:

```env
CF_API_TOKEN=your_cloudflare_token
CF_ZONE_TAG=your_cloudflare_zone_id
```

The token needs Cloudflare `Zone:Analytics:Read` permission for the `yabs.sh` zone.

Then run:

```sh
pip install -r requirements.txt
python scripts/update_stats.py
```

If data changed, the script updates `docs/data/stats.json`.

## GitHub Actions

The updater workflow runs on a schedule and can also be started manually from GitHub Actions. It expects these repository secrets:

- `CF_API_TOKEN`
- `CF_ZONE_ID`

GitHub Pages should be configured as:

```text
Deploy from branch
main
/docs
```

There is intentionally no Pages deployment workflow.

## License

WTFPL. See [LICENSE](LICENSE).
