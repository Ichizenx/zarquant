#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_data.py

Pulls the TSETMC (Tehran Stock Exchange) market watch plus recent daily OHLC
history and writes data.json for the static dashboard.

TSETMC renders its tables with JavaScript, so the JSON APIs behind the website
are used directly:

    market watch : https://cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch
    daily bars   : https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceDailyList/{insCode}/{bars}

Categories
    stocks     - regular shares (TSE main board, Fara Bourse, base market)
    funds      - ETFs and listed mutual funds
    goldFunds  - gold / commodity funds that traded today, by traded value
    options    - call and put option contracts
    other      - futures, sukuk, bonds, commodity and capacity certificates

Only the standard library is used, so CI needs no pip install. Daily candles are
stored for the most liquid symbols of every displayed group ("seed" history) so
the chart paints instantly; the browser fetches history for any other symbol on
demand from the same public API (which sends Access-Control-Allow-Origin: *).

Usage:
    python fetch_data.py [-o data.json] [--bars 150] [--history 30]
                         [--insecure] [--no-history]
"""

import argparse
import concurrent.futures
import datetime as dt
import gzip
import json
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

MARKET_URL = "https://cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch"
HISTORY_URL = "https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceDailyList/{ins}/{bars}"
MARKET_PARAMS = {
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
    "Accept-Encoding": "gzip",
    "Referer": "https://www.tsetmc.com/",
    "Origin": "https://www.tsetmc.com",
}
TEHRAN_TZ = dt.timezone(dt.timedelta(hours=3, minutes=30))
socket.setdefaulttimeout(20)  # never hang on a silent network path

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

CATEGORY_KEYS = ("stocks", "funds", "goldFunds", "options", "other")


def num(value):
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


class HttpClient(object):
    """Tiny urllib wrapper: retries, gzip, hard timeout, optional TLS bypass."""

    def __init__(self, insecure=False):
        self.context = None
        if insecure:
            self.context = ssl.create_default_context()
            self.context.check_hostname = False
            self.context.verify_mode = ssl.CERT_NONE

    def get_json(self, url, attempts=3, pause=2.0, budget=90.0):
        started = time.monotonic()
        last_error = None
        for i in range(attempts):
            if time.monotonic() - started > budget:
                break
            try:
                request = urllib.request.Request(url, headers=HEADERS)
                with urllib.request.urlopen(request, timeout=30, context=self.context) as response:
                    body = response.read()
                if body[:2] == b"\x1f\x8b":
                    body = gzip.decompress(body)
                return json.loads(body)
            except Exception as exc:  # noqa: BLE001 - retried below
                last_error = exc
                if i + 1 < attempts:
                    time.sleep(pause * (i + 1))
        raise RuntimeError(str(last_error))


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


def build(rows):
    buckets = {k: [] for k in CATEGORY_KEYS}
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
                "k": (r.get("insCode") or "").strip(),
            }
        )

    for key, items in buckets.items():
        items.sort(key=lambda x: x["val"], reverse=True)
    # Gold funds: only those that actually traded today.
    buckets["goldFunds"] = [x for x in buckets["goldFunds"] if x["v"] > 0]
    return buckets


def to_bar(row):
    """One daily candle -> [yyyymmdd, open, high, low, close, volume]."""
    day = int(num(row.get("dEven")) or 0)
    if not day:
        return None
    o = num(row.get("priceFirst"))
    h = num(row.get("priceMax"))
    l = num(row.get("priceMin"))
    c = num(row.get("pClosing"))
    if c is None:
        c = num(row.get("pDrCotVal"))
    if not (o and h and l and c):
        return None
    v = num(row.get("qTotTran5J")) or 0.0
    return [day, round(o, 2), round(h, 2), round(l, 2), round(c, 2), int(v)]


def fetch_history(client, ins_code, bars):
    url = HISTORY_URL.format(ins=urllib.parse.quote(str(ins_code)), bars=bars)
    payload = client.get_json(url, attempts=2, pause=1.0, budget=40.0)
    return build_bars(payload.get("closingPriceDaily") or [], bars)


def build_bars(rows, limit):
    """Turn TSETMC daily rows (newest first) into back-adjusted candles.

    TSETMC serves raw, unadjusted prices: a capital increase or split shows up
    as a cliff in the chart. Every row carries `priceYesterday`, the previous
    close restated in *today's* price basis, so the ratio between that value and
    the real previous close is the corporate-action factor. Older bars are
    scaled by the accumulated factor (and volume by its inverse) so the series
    is continuous and the newest price stays untouched.
    """
    out = []  # newest -> oldest
    factor = 1.0
    for index, row in enumerate(rows):
        bar = to_bar(row)
        if bar:
            day, o, h, l, c, v = bar
            out.append(
                [
                    day,
                    round(o * factor, 2),
                    round(h * factor, 2),
                    round(l * factor, 2),
                    round(c * factor, 2),
                    int(v / factor) if factor else v,
                ]
            )
        prev_close = None
        if index + 1 < len(rows):
            older = rows[index + 1]
            prev_close = num(older.get("pClosing")) or num(older.get("pDrCotVal"))
        restated = num(row.get("priceYesterday"))
        if restated and prev_close and prev_close > 0:
            ratio = restated / prev_close
            if 0.01 <= ratio <= 100 and abs(ratio - 1) > 0.002:  # corporate action
                factor *= ratio
    out.reverse()  # oldest -> newest, what the chart expects
    return out[-limit:] if limit else out


def seed_history(client, buckets, top, bars, workers=4):
    """Attach a `h` array to the most liquid symbols of each displayed group."""
    picked = []
    for key in ("stocks", "funds", "goldFunds", "options"):
        for item in buckets[key][:top]:
            if item.get("k"):
                picked.append(item)
    if not picked:
        return 0

    def work(item):
        try:
            item["h"] = fetch_history(client, item["k"], bars)
            return bool(item["h"])
        except Exception as exc:  # noqa: BLE001 - seeds are best effort
            print("  history skip %s: %s" % (item.get("s"), exc), file=sys.stderr)
            return False

    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        for ok in pool.map(work, picked):
            done += 1 if ok else 0
    return done


def main(argv=None):
    parser = argparse.ArgumentParser(description="Write TSETMC market data to data.json.")
    parser.add_argument("-o", "--out", default="data.json", help="output file (default data.json)")
    parser.add_argument("--bars", type=int, default=150, help="daily candles kept per seed symbol")
    parser.add_argument(
        "--history",
        type=int,
        default=8,
        metavar="N",
        help="seed daily history for the N most liquid symbols of every group (0 = none)",
    )
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="skip TLS verification (only for networks with a TLS-inspecting proxy)",
    )
    parser.add_argument("--no-history", action="store_true", help="alias for --history 0")
    args = parser.parse_args(argv)

    bars = max(20, min(600, args.bars))
    seed_count = 0 if args.no_history else max(0, args.history)

    client = HttpClient(insecure=args.insecure)
    started = time.monotonic()
    url = MARKET_URL + "?" + urllib.parse.urlencode(MARKET_PARAMS)
    rows = client.get_json(url).get("marketwatch") or []
    if not rows:
        raise SystemExit("TSETMC returned an empty market watch")
    buckets = build(rows)

    seeded = 0
    if seed_count:
        seeded = seed_history(client, buckets, seed_count, bars)

    total_value = sum(item["val"] for items in buckets.values() for item in items)
    payload = {
        "updated": dt.datetime.now(TEHRAN_TZ).isoformat(timespec="seconds"),
        "source": "TSETMC market watch (cdn.tsetmc.com)",
        "counts": {k: len(v) for k, v in buckets.items()},
        "totalValue": total_value,
        "history": {"bars": bars, "symbols": seeded},
        "categories": buckets,
    }
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))

    print(
        "Wrote %s in %.1fs: %s | history seeds=%d"
        % (
            args.out,
            time.monotonic() - started,
            ", ".join("%s=%d" % (k, len(v)) for k, v in buckets.items()),
            seeded,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
