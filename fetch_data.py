#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_data.py

Pulls the full TSETMC (Tehran Stock Exchange) market watch and writes data.json
for the static dashboard. TSETMC renders its tables with JavaScript, so the
JSON API behind the website is used directly:

    https://cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch

Categories
    stocks     - regular shares (TSE main board, Fara Bourse, base market)
    funds      - ETFs and listed mutual funds
    goldFunds  - gold / commodity funds that traded today, by traded value
    options    - call and put option contracts
    other      - futures, sukuk, bonds, commodity and capacity certificates

Usage:
    python fetch_data.py [-o data.json]
"""

import argparse
import datetime as dt
import json
import socket
import sys
import time

import requests

JSON_URL = "https://cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch"
JSON_PARAMS = {
    "market": "0",
    "paperTypes[0]": "1",
    "showTraded": "true",
    "withBestLimits": "false",
    "hEven": "0",
    "RefID": "0",
}
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "fa-IR,fa;q=0.9,en;q=0.8",
    "Referer": "https://www.tsetmc.com/",
    "Origin": "https://www.tsetmc.com",
}
TEHRAN_TZ = dt.timezone(dt.timedelta(hours=3, minutes=30))
socket.setdefaulttimeout(20)  # never hang on a silent network path

SUMMARY_LIMIT = 3  # how many top rows each category keeps in the "top" arrays

FLOW_DERIVATIVES = 3
FLOW_CAPACITY = 6
FLOW_COMMODITY_FUNDS = 7
FUND_SECTOR = "68"
DEBT_KEYWORDS = (
    "\u0645\u0631\u0627\u0628\u062d\u0647",          # مرابحه
    "\u0635\u0643\u0648\u0643",                      # صكوك
    "\u0635\u06a9\u0648\u06a9",                      # صکوک
    "\u0645\u0634\u0627\u0631\u0643\u062a",          # مشاركت
    "\u0645\u0634\u0627\u0631\u06a9\u062a",          # مشارکت
    "\u0627\u0639\u062a\u0628\u0627\u0631\u0645\u0648\u0644\u062f",  # اعتبارمولد
)


def num(value):
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def classify(name, sector, flow):
    name = name or ""
    sector = (sector or "").strip()
    if "\u0627\u062e\u062a\u064a\u0627\u0631" in name:  # اختيارخ / اختيارف
        return "options"
    if flow == FLOW_DERIVATIVES:
        return "other"
    if sector == FUND_SECTOR:
        return "goldFunds" if flow == FLOW_COMMODITY_FUNDS else "funds"
    if flow in (FLOW_CAPACITY, FLOW_COMMODITY_FUNDS):
        return "other"
    if any(k in name for k in DEBT_KEYWORDS):
        return "other"
    return "stocks"


def fetch(session, attempts=3, pause=2.0, budget=150.0):
    """Fetch the market watch, giving up after a hard time budget."""
    started = time.monotonic()
    last_error = None
    for i in range(attempts):
        if time.monotonic() - started > budget:
            break
        try:
            resp = session.get(JSON_URL, params=JSON_PARAMS, timeout=(10, 35))
            resp.raise_for_status()
            rows = resp.json().get("marketwatch") or []
            if rows:
                return rows
            last_error = RuntimeError("empty 'marketwatch' array")
        except Exception as exc:  # noqa: BLE001 - retried below
            last_error = exc
        if i + 1 < attempts:
            time.sleep(pause * (i + 1))
    raise SystemExit("TSETMC request failed after %.0fs: %s" % (time.monotonic() - started, last_error))


def build(rows):
    buckets = {k: [] for k in ("stocks", "funds", "goldFunds", "options", "other")}
    for r in rows:
        symbol = (r.get("lva") or "").strip()
        if not symbol:
            continue
        name = (r.get("lvc") or "").strip()
        last = num(r.get("pdv")) or 0.0
        close = num(r.get("pcl")) or last
        prev = num(r.get("py"))
        change = round((last - prev) / prev * 100.0, 2) if (prev and last) else None
        volume = num(r.get("qtj")) or 0.0
        value = num(r.get("qtc")) or 0.0
        trades = num(r.get("ztt")) or 0.0
        bucket = classify(name, r.get("csv"), num(r.get("flow")))
        buckets[bucket].append(
            {
                "s": symbol,
                "n": name,
                "p": round(last, 2),
                "c": round(close, 2),
                "ch": change,
                "v": int(volume),
                "val": int(value),
                "t": int(trades),
                "i": (r.get("insID") or "").strip(),
            }
        )

    for key, items in buckets.items():
        items.sort(key=lambda x: x["val"], reverse=True)
    # Gold funds: only those that actually traded today.
    buckets["goldFunds"] = [x for x in buckets["goldFunds"] if x["v"] > 0]
    return buckets


def main(argv=None):
    parser = argparse.ArgumentParser(description="Write TSETMC market data to data.json.")
    parser.add_argument("-o", "--out", default="data.json", help="output file (default data.json)")
    args = parser.parse_args(argv)

    session = requests.Session()
    session.headers.update(HEADERS)
    rows = fetch(session)
    buckets = build(rows)

    total_value = sum(item["val"] for items in buckets.values() for item in items)
    payload = {
        "updated": dt.datetime.now(TEHRAN_TZ).isoformat(timespec="seconds"),
        "source": "TSETMC market watch (cdn.tsetmc.com)",
        "counts": {k: len(v) for k, v in buckets.items()},
        "totalValue": total_value,
        "categories": buckets,
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))

    print("Wrote %s: %s" % (args.out, ", ".join("%s=%d" % (k, len(v)) for k, v in buckets.items())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
