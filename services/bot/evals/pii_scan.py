"""Fails if synthetic PII appears in container logs or Phoenix traces. Run after `make eval` (`make pii-scan`).

Looks for the seed's full account numbers and CBUs, its customer and beneficiary names, every email address, and
the personal data the red-team prompts type in (`pii_markers` in redteam.yaml). Masked forms such as `****4521`
or `[cuenta]` are fine.
"""

import json
import re
import subprocess
import sys
from collections import Counter
from collections.abc import Iterator
from pathlib import Path

import httpx

from evals.redteam import load_suite

REPO = Path(__file__).resolve().parents[3]
SEED = REPO / "data" / "seed" / "002_seed.sql"
COMPOSE = ["docker", "compose", "-f", str(REPO / "infra" / "docker-compose.yml"), "--env-file", str(REPO / ".env")]
PHOENIX_SPANS = "http://localhost:6006/v1/projects/default/spans"
PAGE_SIZE = 1000
MAX_PAGES = 500
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b")


# Full names: the second value of a `customers` row, the third of a `beneficiaries` row.
CUSTOMER_ROW = re.compile(r"^\s*\('[\w-]+',\s*'([^']+)'\)", re.MULTILINE)
BENEFICIARY_ROW = re.compile(r"^\s*\('[\w-]+',\s*'[\w-]+',\s*'([^']+)'", re.MULTILINE)


def _insert_block(sql: str, table: str) -> str:
    match = re.search(rf"INSERT INTO {table} \(.*?;", sql, re.DOTALL)
    return match.group(0) if match else ""


def seed_names(sql: str) -> set[str]:
    customers = CUSTOMER_ROW.findall(_insert_block(sql, "customers"))
    return set(customers) | set(BENEFICIARY_ROW.findall(_insert_block(sql, "beneficiaries")))


def seed_markers() -> set[str]:
    sql = SEED.read_text(encoding="utf-8")
    numbers = set(re.findall(r"'(\d{4}-\d{4}-\d{4})'", sql)) | set(re.findall(r"'(\d{22})'", sql))
    return numbers | set(EMAIL.findall(sql)) | seed_names(sql)


def compose_logs() -> str:
    run = subprocess.run([*COMPOSE, "logs", "--no-color"], capture_output=True, text=True, check=True)  # noqa: S603
    return run.stdout + run.stderr


def phoenix_pages() -> Iterator[str]:
    cursor: str | None = None
    with httpx.Client(timeout=60) as http:
        for _ in range(MAX_PAGES):
            params: dict[str, str | int] = {"limit": PAGE_SIZE} | ({"cursor": cursor} if cursor else {})
            page = http.get(PHOENIX_SPANS, params=params).raise_for_status().json()
            yield json.dumps(page["data"], ensure_ascii=False)
            cursor = page.get("next_cursor")
            if not cursor:
                return


def findings(source: str, text: str, markers: set[str]) -> Counter[str]:
    found: Counter[str] = Counter({marker: text.count(marker) for marker in markers if marker in text})
    found.update(e for e in EMAIL.findall(text) if e not in markers)
    return Counter({f"{source}: {marker}": count for marker, count in found.items()})


def main() -> int:
    markers = seed_markers() | set(load_suite().pii_markers)
    logs = compose_logs()
    spans = list(phoenix_pages())
    found = findings("logs", logs, markers) + findings("traces", "\n".join(spans), markers)
    print(f"Scanned {len(logs.splitlines())} log lines and {len(spans)} span pages for {len(markers)} markers.")
    for where, count in sorted(found.items()):
        print(f"  FOUND {count}x {where}")
    print("pii-scan: clean" if not found else f"pii-scan: {sum(found.values())} unredacted value(s)")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
