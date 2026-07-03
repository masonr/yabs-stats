"""Generate the static JSON data file used by GitHub Pages.

Git is the database for this project. Each run downloads the recent window
Cloudflare exposes, merges daily history with the existing file, and writes one
small JSON document for the browser.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

from cloudflare import CloudflareClient

ROOT = Path(__file__).parent.parent
DATA_DIR = ROOT / "docs" / "data"
STATS_PATH = DATA_DIR / "stats.json"

COUNTRY_WINDOW_DAYS = 30
DAILY_WINDOW_DAYS = 365
HOURLY_WINDOW_DAYS = 14
ACTIVITY_WINDOW_DAYS = 30

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

def recent_countries(
    daily_rows: list[dict[str, Any]],
    today: date,
) -> list[dict[str, Any]]:
    """Aggregate country usage from the recent daily Cloudflare window."""
    cutoff = today - timedelta(days=COUNTRY_WINDOW_DAYS - 1)
    totals: defaultdict[str, int] = defaultdict(int)

    for row in daily_rows:
        row_date = date.fromisoformat(row["dimensions"]["date"])
        if row_date < cutoff:
            continue

        for country in row.get("sum", {}).get("countryMap", []):
            name = country.get("clientCountryName") or "Unknown"
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
    now: datetime,
) -> dict[str, Any]:
    """Build the complete static data document."""
    history = merge_history(
        existing.get("history", []),
        daily_history(daily_rows),
    )

    return {
        "generated": now.isoformat().replace("+00:00", "Z"),
        "summary": build_summary(history, now),
        "history": history,
        "countries": recent_countries(daily_rows, now.date()),
        "hourly": hourly_history(hourly_rows),
        "activity": activity_summary(activity_rows),
    }

def main() -> None:
    now = datetime.now(UTC).replace(microsecond=0)
    tomorrow = now + timedelta(days=1)
    print(f"Fetching statistics at {now.isoformat()}")

    client = CloudflareClient()
    daily_rows = client.daily(now - timedelta(days=DAILY_WINDOW_DAYS), tomorrow)
    hourly_rows = client.hourly(now - timedelta(days=HOURLY_WINDOW_DAYS), now)
    activity_rows = client.activity(now - timedelta(days=ACTIVITY_WINDOW_DAYS), tomorrow)

    print(f"Downloaded {len(daily_rows)} daily rows")
    print(f"Downloaded {len(hourly_rows)} hourly rows")
    print(f"Downloaded {len(activity_rows)} activity rows")

    stats = build_stats(load_existing_stats(), daily_rows, hourly_rows, activity_rows, now)

    if save_stats(stats):
        print(f"Wrote {STATS_PATH.relative_to(ROOT)}")
    else:
        print("No data changes.")

if __name__ == "__main__":
    main()