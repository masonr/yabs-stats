"""
Simple Cloudflare GraphQL client for YABS statistics.

This module is intentionally tiny. It only knows how to execute a few
GraphQL queries and return plain Python dictionaries.

No ORM.
No database.
No framework.
"""

from __future__ import annotations
import os
from datetime import datetime
from typing import Any
import requests

GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql"

class CloudflareClient:
    """Tiny Cloudflare GraphQL client for the updater script."""

    def __init__(self) -> None:
        token = os.environ["CF_API_TOKEN"]
        self.zone = os.environ["CF_ZONE_ID"]
        self.session = requests.Session()
        self.session.headers.update(
            {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            }
        )

    def query(
        self,
        graphql: str,
        variables: dict[str, Any],
    ) -> dict[str, Any]:
        """Run one GraphQL query and return its data payload."""
        response = self.session.post(
            GRAPHQL_URL,
            json={
                "query": graphql,
                "variables": variables,
            },
            timeout=60,
        )

        response.raise_for_status()

        payload = response.json()

        if "errors" in payload:
            raise RuntimeError(payload["errors"])

        return payload["data"]

    def zone_groups(self, data: dict[str, Any], group_name: str) -> list[dict[str, Any]]:
        """Extract a zone group list from a Cloudflare GraphQL response."""
        zones = data["viewer"]["zones"]
        if not zones:
            raise RuntimeError(f"Cloudflare zone not found: {self.zone}")
        return zones[0][group_name]

    def daily(
        self,
        start: datetime,
        end: datetime,
    ) -> list[dict[str, Any]]:
        """Fetch daily request totals and country maps."""
        result = self.query(
            DAILY_QUERY,
            {
                "zoneTag": self.zone,
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
            },
        )

        return self.zone_groups(result, "httpRequests1dGroups")

    def hourly(
        self,
        start: datetime,
        end: datetime,
    ) -> list[dict[str, Any]]:
        """Fetch recent hourly request totals."""
        result = self.query(
            HOURLY_QUERY,
            {
                "zoneTag": self.zone,
                "start": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "end": end.strftime("%Y-%m-%dT%H:%M:%SZ"),
            },
        )

        return self.zone_groups(result, "httpRequests1hGroups")

    def activity(
        self,
        start: datetime,
        end: datetime,
    ) -> list[dict[str, Any]]:
        """Fetch recent request-source activity."""
        result = self.query(
            ACTIVITY_QUERY,
            {
                "zoneTag": self.zone,
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
            },
        )

        return self.zone_groups(result, "httpRequestsAdaptiveGroups")


DAILY_QUERY = r"""
query FetchDayStats($zoneTag: string, $start: Date, $end: Date) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequests1dGroups(
        orderBy: [date_ASC]
        limit: 10000
        filter: {
          date_geq: $start,
          date_lt: $end
        }
      ) {
        dimensions {
          date
        }

        sum {
          requests
          bytes

          countryMap {
            clientCountryName
            requests
          }
        }

        uniq {
          uniques
        }
      }
    }
  }
}
"""

HOURLY_QUERY = r"""
query FetchHourStats($zoneTag: string, $start: Time, $end: Time) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequests1hGroups(
        limit: 10000
        filter: {
          datetime_geq: $start,
          datetime_lt: $end
        }
      ) {
        dimensions {
          datetime
        }

        sum {
          requests
        }

        uniq {
          uniques
        }
      }
    }
  }
}
"""

ACTIVITY_QUERY = r"""
query FetchRequestSourceDay($zoneTag: string, $start: Date, $end: Date) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      httpRequestsAdaptiveGroups(
        orderBy: [count_DESC]
        limit: 100
        filter: {
          date_geq: $start,
          date_lt: $end
        }
      ) {
        count

        dimensions {
          requestSource
          date
        }
      }
    }
  }
}
"""
