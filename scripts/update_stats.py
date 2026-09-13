"""Generate the static JSON data file used by GitHub Pages.

Git is the database for this project. Each run downloads the recent window
Cloudflare exposes, merges daily history with the existing file, and writes one
small JSON document for the browser.
"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any, Callable

from cloudflare import CloudflareClient

ROOT = Path(__file__).parent.parent
DATA_DIR = ROOT / "docs" / "data"
STATS_PATH = DATA_DIR / "stats.json"
ENV_PATH = ROOT / ".env"

COUNTRY_WINDOW_DAYS = 30
# Cloudflare Free analytics rejects ranges wider than 52w1d1h. Since the query
# uses an exclusive end date of tomorrow to include today's partial data, start
# 364 days back for a 365-calendar-day fetch.
DAILY_WINDOW_DAYS = 364
# Cloudflare only exposes hourly data for about 3 days on this plan.
HOURLY_WINDOW_DAYS = 3
HOURLY_BATCH_DAYS = 3
# Cloudflare only exposes adaptive/request-source data for about 1 week here.
ACTIVITY_WINDOW_DAYS = 7
ACTIVITY_BATCH_DAYS = 1

# Traffic that is not a real run gets excluded from the stats. The yabs.sh
# edge redirect only serves the script when the user agent contains "curl"
# or "Wget" (case-sensitive); every other request lands on the GitHub repo
# page and can never be a run.
RUN_UA_LIKES = ("%curl%", "%Wget%")
# A single client IP making more than this many requests in a day is treated
# as a flood and excluded entirely, whatever user agent it claims. Real usage
# is a handful of runs per IP; even busy shared proxies stay well under this.
FLOOD_REQS_PER_DAY = 500
# Known-abusive client IPs. Excluded at any volume.
BLOCKED_IPS = frozenset(
    {
        "45.56.93.145",   # Linode, flood starting 2026-09-08
        "50.116.42.218",  # Linode, flood starting 2026-09-08
        "45.33.120.141",  # Linode, flood starting 2026-09-08
        "66.228.42.245",  # Linode, flood starting 2026-09-08
    }
)
# Exclusions are measured from adaptive data, which this plan keeps for about
# a week, in batches no wider than one day.
EXCLUSION_WINDOW_DAYS = 7

def load_dotenv() -> None:
    """Load local .env values without adding a dependency."""
    if not ENV_PATH.exists():
        return

    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))

def load_existing_stats() -> dict[str, Any]:
    """Load the current static database, if it exists."""
    if not STATS_PATH.exists():
        return {
            "generated": None,
            "summary": {},
            "history": [],
            "countries": [],
            "hourly": [],
            "activity": [],
        }

    return json.loads(STATS_PATH.read_text(encoding="utf-8"))

def daily_history(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert Cloudflare daily groups into the public history shape."""
    history = []

    for row in rows:
        dimensions = row.get("dimensions", {})
        totals = row.get("sum", {})
        unique = row.get("uniq", {})

        history.append(
            {
                "date": dimensions["date"],
                "requests": int(totals.get("requests", 0)),
                "unique_ips": int(unique.get("uniques", 0)),
                "bytes": int(totals.get("bytes", 0)),
                "countries": [
                    {
                        "country": country.get("clientCountryName") or "Unknown",
                        "requests": int(country.get("requests", 0)),
                    }
                    for country in totals.get("countryMap", [])
                ],
            }
        )

    return sorted(history, key=lambda item: item["date"])

def merge_history(
    existing: list[dict[str, Any]],
    fresh: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Merge daily history by date without discarding older local records."""
    by_date = {row["date"]: row for row in existing if "date" in row}
    by_date.update({row["date"]: row for row in fresh})
    return [by_date[key] for key in sorted(by_date)]

def country_totals(
    history: list[dict[str, Any]],
    today: date,
    days: int,
) -> list[dict[str, Any]]:
    """Aggregate country usage from daily history."""
    cutoff = today - timedelta(days=days - 1)
    totals: defaultdict[str, int] = defaultdict(int)

    for row in history:
        row_date = date.fromisoformat(row["date"])
        if row_date < cutoff:
            continue

        for country in row.get("countries", []):
            name = country.get("country") or "Unknown"
            totals[name] += int(country.get("requests", 0))

    return [
        {
            "country": country,
            "country_code": country,
            "requests": requests,
        }
        for country, requests in sorted(
            totals.items(),
            key=lambda item: item[1],
            reverse=True,
        )
    ]

def hourly_history(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert Cloudflare hourly groups into a rolling hourly series."""
    points = []

    for row in rows:
        dimensions = row.get("dimensions", {})
        totals = row.get("sum", {})
        unique = row.get("uniq", {})

        points.append(
            {
                "datetime": dimensions["datetime"],
                "requests": int(totals.get("requests", 0)),
                "unique_ips": int(unique.get("uniques", 0)),
            }
        )

    return sorted(points, key=lambda item: item["datetime"])

def activity_summary(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Aggregate recent request source activity."""
    totals: defaultdict[str, int] = defaultdict(int)

    for row in rows:
        source = row.get("dimensions", {}).get("requestSource") or "unknown"
        totals[source] += int(row.get("count", 0))

    return [
        {"source": source, "requests": requests}
        for source, requests in sorted(
            totals.items(),
            key=lambda item: item[1],
            reverse=True,
        )
    ]

def run_ua_filter() -> dict[str, Any]:
    """GraphQL filter matching requests that would receive the script."""
    return {"OR": [{"userAgent_like": ua} for ua in RUN_UA_LIKES]}

def daily_exclusions(
    client: CloudflareClient,
    today: date,
) -> tuple[dict[str, dict[str, Any]], set[str]]:
    """Measure non-run traffic per day from adaptive analytics.

    A request counts as a run when its user agent would get the script at
    the edge and its client IP is not flagged. Returns (exclusions,
    flagged_ips) where exclusions maps an ISO date string to {"requests",
    "bytes", "countries", "ips"} and flagged_ips is every client IP flagged
    as a flood or on the blocklist during the window.
    """
    exclusions: dict[str, dict[str, Any]] = {}
    flagged_ips: set[str] = set(BLOCKED_IPS)

    for back in range(EXCLUSION_WINDOW_DAYS - 1, -1, -1):
        day = today - timedelta(days=back)
        window = {
            "date_geq": day.isoformat(),
            "date_lt": (day + timedelta(days=1)).isoformat(),
        }

        groups = client.adaptive_groups(["clientIP", "clientCountryName"], window)

        per_ip: defaultdict[str, int] = defaultdict(int)
        totals = {"requests": 0, "bytes": 0, "countries": defaultdict(int)}
        for group in groups:
            dims = group["dimensions"]
            count = int(group["count"])
            per_ip[dims["clientIP"]] += count
            totals["requests"] += count
            totals["bytes"] += int(group["sum"].get("edgeResponseBytes") or 0)
            country = dims.get("clientCountryName") or "Unknown"
            totals["countries"][country] += count

        flagged_ips |= {
            ip for ip, requests in per_ip.items() if requests > FLOOD_REQS_PER_DAY
        }

        run_groups = client.adaptive_groups(
            ["clientCountryName"],
            {
                **window,
                **run_ua_filter(),
                "clientIP_notin": sorted(flagged_ips),
            },
        )
        kept = {"requests": 0, "bytes": 0, "countries": defaultdict(int)}
        for group in run_groups:
            country = group["dimensions"].get("clientCountryName") or "Unknown"
            kept["requests"] += int(group["count"])
            kept["bytes"] += int(group["sum"].get("edgeResponseBytes") or 0)
            kept["countries"][country] += int(group["count"])

        entry = {
            "requests": max(0, totals["requests"] - kept["requests"]),
            "bytes": max(0, totals["bytes"] - kept["bytes"]),
            "countries": {
                country: max(0, count - kept["countries"].get(country, 0))
                for country, count in totals["countries"].items()
            },
            "ips": {ip for ip in flagged_ips if ip in per_ip},
        }
        if entry["requests"]:
            exclusions[day.isoformat()] = entry

    return exclusions, flagged_ips

def hourly_exclusions(
    client: CloudflareClient,
    today: date,
    flagged_ips: set[str],
) -> dict[str, dict[str, Any]]:
    """Measure kept requests and flagged-IP traffic per hour.

    Returns {"kept": {hour: requests}, "flagged": {hour: {"requests",
    "ips"}}} where hour is a "YYYY-MM-DDTHH" prefix. Rollup values are then
    replaced with the kept count, which absorbs non-run user agents and
    floods alike.
    """
    kept: dict[str, int] = {}
    flagged: dict[str, dict[str, Any]] = {}
    since = (today - timedelta(days=HOURLY_WINDOW_DAYS)).isoformat()[:10]

    # The rolling 72h hourly window touches four calendar days.
    for back in range(HOURLY_WINDOW_DAYS, -1, -1):
        day = today - timedelta(days=back)
        window = {
            "datetime_geq": f"{day.isoformat()}T00:00:00Z",
            "datetime_lt": f"{(day + timedelta(days=1)).isoformat()}T00:00:00Z",
        }

        for group in client.adaptive_groups(
            ["datetimeHour"],
            {
                **window,
                **run_ua_filter(),
                "clientIP_notin": sorted(flagged_ips) or ["0.0.0.0"],
            },
        ):
            hour = group["dimensions"]["datetimeHour"][:13]
            kept[hour] = kept.get(hour, 0) + int(group["count"])

        if flagged_ips:
            for group in client.adaptive_groups(
                ["datetimeHour", "clientIP"],
                {**window, "clientIP_in": sorted(flagged_ips)},
            ):
                hour = group["dimensions"]["datetimeHour"][:13]
                entry = flagged.setdefault(hour, {"requests": 0, "ips": set()})
                entry["requests"] += int(group["count"])
                entry["ips"].add(group["dimensions"]["clientIP"])

    return {"kept": kept, "flagged": flagged, "since": since}

def apply_daily_exclusions(
    history: list[dict[str, Any]],
    exclusions: dict[str, dict[str, Any]],
) -> None:
    """Subtract measured non-run traffic from merged daily history."""
    for row in history:
        entry = exclusions.get(row.get("date", ""))
        if not entry:
            continue

        row["requests"] = max(0, int(row["requests"]) - entry["requests"])
        row["bytes"] = max(0, int(row.get("bytes", 0)) - entry["bytes"])
        row["unique_ips"] = max(0, int(row.get("unique_ips", 0)) - len(entry["ips"]))

        for country in row.get("countries", []):
            removed = entry["countries"].get(country.get("country"), 0)
            country["requests"] = max(0, int(country["requests"]) - removed)

def apply_hourly_exclusions(
    points: list[dict[str, Any]],
    exclusions: dict[str, dict[str, Any]],
) -> None:
    """Replace hourly rollup counts with measured run counts."""
    kept = exclusions["kept"]
    flagged = exclusions["flagged"]

    for row in points:
        hour = str(row.get("datetime", ""))[:13]
        # Only correct hours inside the queried window. Within it, a missing
        # hour means no run-UA requests were sampled.
        if hour < f"{exclusions['since']}T00":
            continue

        row["requests"] = min(int(row["requests"]), kept.get(hour, 0))
        row["unique_ips"] = max(
            0, int(row.get("unique_ips", 0)) - len(flagged.get(hour, {}).get("ips", ()))
        )

def sum_since(history: list[dict[str, Any]], today: date, days: int) -> int:
    """Sum request counts for a trailing day window including today."""
    cutoff = today - timedelta(days=days - 1)
    return sum(
        int(row.get("requests", 0))
        for row in history
        if date.fromisoformat(row["date"]) >= cutoff
    )

def build_summary(
    history: list[dict[str, Any]],
    now: datetime,
) -> dict[str, Any]:
    """Compute headline counters from merged daily history."""
    today = now.date()
    today_key = today.isoformat()

    return {
        "all_time": sum(int(row.get("requests", 0)) for row in history),
        "today": sum(
            int(row.get("requests", 0))
            for row in history
            if row.get("date") == today_key
        ),
        "last7": sum_since(history, today, 7),
        "last30": sum_since(history, today, 30),
        "since": history[0]["date"] if history else None,
        "updated": now.isoformat().replace("+00:00", "Z"),
    }

def save_stats(stats: dict[str, Any]) -> bool:
    """Write stats.json only when the serialized content changed."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    content = json.dumps(stats, indent=2) + "\n"

    if STATS_PATH.exists() and STATS_PATH.read_text(encoding="utf-8") == content:
        return False

    STATS_PATH.write_text(content, encoding="utf-8")
    return True

def build_stats(
    existing: dict[str, Any],
    daily_rows: list[dict[str, Any]],
    hourly_rows: list[dict[str, Any]],
    activity_rows: list[dict[str, Any]],
    daily_excl: dict[str, dict[str, Any]],
    hourly_excl: dict[str, dict[str, Any]],
    flagged_ips: set[str],
    now: datetime,
) -> dict[str, Any]:
    """Build the complete static data document."""
    history = merge_history(
        existing.get("history", []),
        daily_history(daily_rows),
    )
    apply_daily_exclusions(history, daily_excl)

    hourly = hourly_history(hourly_rows)
    apply_hourly_exclusions(hourly, hourly_excl)

    return {
        "generated": now.isoformat().replace("+00:00", "Z"),
        "summary": build_summary(history, now),
        "history": history,
        "countries": country_totals(history, now.date(), COUNTRY_WINDOW_DAYS),
        "hourly": hourly,
        "activity": activity_summary(activity_rows),
        "excluded": {
            "daily": {
                day: entry["requests"] for day, entry in sorted(daily_excl.items())
            },
            "flagged_ips": sorted(flagged_ips),
        },
    }

def fetch_in_batches(
    label: str,
    fetch: Callable[[datetime, datetime], list[dict[str, Any]]],
    start: datetime,
    end: datetime,
    batch_size: timedelta,
) -> list[dict[str, Any]]:
    """Fetch a Cloudflare time range in quota-safe chunks."""
    rows: list[dict[str, Any]] = []
    cursor = start

    while cursor < end:
        batch_end = min(cursor + batch_size, end)
        print(f"Fetching {label}: {cursor.isoformat()} to {batch_end.isoformat()}")
        rows.extend(fetch(cursor, batch_end))
        cursor = batch_end

    return rows

def main() -> None:
    load_dotenv()

    now = datetime.now(UTC).replace(microsecond=0)
    tomorrow = now + timedelta(days=1)
    print(f"Fetching statistics at {now.isoformat()}")

    client = CloudflareClient()
    daily_rows = client.daily(now - timedelta(days=DAILY_WINDOW_DAYS), tomorrow)
    hourly_rows = fetch_in_batches(
        "hourly",
        client.hourly,
        now - timedelta(days=HOURLY_WINDOW_DAYS),
        now,
        timedelta(days=HOURLY_BATCH_DAYS),
    )
    activity_rows = fetch_in_batches(
        "activity",
        client.activity,
        now - timedelta(days=ACTIVITY_WINDOW_DAYS),
        tomorrow,
        timedelta(days=ACTIVITY_BATCH_DAYS),
    )

    print(f"Downloaded {len(daily_rows)} daily rows")
    print(f"Downloaded {len(hourly_rows)} hourly rows")
    print(f"Downloaded {len(activity_rows)} activity rows")

    daily_excl, flagged_ips = daily_exclusions(client, now.date())
    hourly_excl = hourly_exclusions(client, now.date(), flagged_ips)
    excluded_total = sum(entry["requests"] for entry in daily_excl.values())
    print(
        f"Excluded {excluded_total} non-run requests across "
        f"{len(daily_excl)} days ({len(flagged_ips)} flagged IPs)"
    )

    stats = build_stats(
        load_existing_stats(),
        daily_rows,
        hourly_rows,
        activity_rows,
        daily_excl,
        hourly_excl,
        flagged_ips,
        now,
    )

    if save_stats(stats):
        print(f"Wrote {STATS_PATH.relative_to(ROOT)}")
    else:
        print("No data changes.")

if __name__ == "__main__":
    main()
