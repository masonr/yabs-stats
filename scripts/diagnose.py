"""Print a per-day breakdown of yabs.sh traffic sources.

Shows which client IPs and user agents Cloudflare saw, how many requests
update_stats.py would exclude as non-runs (non-curl/Wget user agents,
per-IP floods, blocklisted IPs), and what the corrected daily total is.

Usage:

    python scripts/diagnose.py [days]

Reads CF_API_TOKEN and CF_ZONE_TAG (or CF_ZONE_ID) from the environment or
the repository .env file. Read-only: never touches stats.json.
"""

from __future__ import annotations

import sys
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from cloudflare import CloudflareClient
from update_stats import (
    BLOCKED_IPS,
    FLOOD_REQS_PER_DAY,
    RUN_UA_LIKES,
    load_dotenv,
    run_ua_filter,
)

DAYS = int(sys.argv[1]) if len(sys.argv) > 1 else 7
TOP = 12


def day_range(day: date) -> dict[str, str]:
    return {"date_geq": day.isoformat(), "date_lt": (day + timedelta(days=1)).isoformat()}


def main() -> None:
    load_dotenv()
    client = CloudflareClient()
    today = datetime.now(UTC).date()
    flagged: set[str] = set(BLOCKED_IPS)

    for back in range(DAYS - 1, -1, -1):
        day = today - timedelta(days=back)
        window = day_range(day)

        clients = client.adaptive_groups(["clientIP", "clientCountryName"], window)
        total = sum(g["count"] for g in clients)

        per_ip: defaultdict[str, int] = defaultdict(int)
        for g in clients:
            per_ip[g["dimensions"]["clientIP"]] += g["count"]

        flagged |= {ip for ip, n in per_ip.items() if n > FLOOD_REQS_PER_DAY}
        active_flagged = flagged & set(per_ip)
        flood_reqs = sum(per_ip[ip] for ip in active_flagged)

        runs = client.adaptive_groups(
            ["clientDeviceType"],
            {**window, **run_ua_filter(), "clientIP_notin": sorted(flagged)},
        )
        run_reqs = sum(g["count"] for g in runs)

        print(f"\n=== {day} ===")
        print(
            f"  total={total}  runs={run_reqs}  excluded={total - run_reqs} "
            f"(flagged IPs: {flood_reqs} from {len(active_flagged)}, "
            f"other non-run UAs: {total - run_reqs - flood_reqs})"
        )

        print(f"  top {TOP} IPs:")
        top = sorted(per_ip.items(), key=lambda kv: kv[1], reverse=True)[:TOP]
        for ip, n in top:
            mark = "  <-- FLOOD" if per_ip[ip] > FLOOD_REQS_PER_DAY else ""
            mark = mark or ("  <-- blocked" if ip in BLOCKED_IPS else "")
            print(f"    {n:>8}  {ip}{mark}")

        agents = client.adaptive_groups(["userAgent"], window, limit=TOP)
        print(f"  top {TOP} user agents:")
        for g in agents:
            ua = (g["dimensions"]["userAgent"] or "(empty)")[:100]
            run = any(ua.find(k.strip('%')) >= 0 for k in RUN_UA_LIKES)
            print(f"    {g['count']:>8}  {'run' if run else '   '}  {ua}")


if __name__ == "__main__":
    main()
