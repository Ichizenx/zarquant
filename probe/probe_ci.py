"""One-off probe run on a GitHub runner: which path can reach TSETMC?

Writes probe-results.json so the results can be committed and inspected
without reading Actions logs.
"""

import concurrent.futures
import json
import re
import time

import requests
from requests.adapters import HTTPAdapter

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
TSETMC = (
    "https://cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch"
    "?market=0&paperTypes%5B0%5D=1&showTraded=true&withBestLimits=false&hEven=0&RefID=0"
)
HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "fa-IR,fa;q=0.9,en;q=0.8",
    "Referer": "https://www.tsetmc.com/",
    "Origin": "https://www.tsetmc.com",
}
IP_PORT = re.compile(r"(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})")

PROXY_LISTS = [
    "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/IR/data.txt",
    "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/IR/protocols/http.txt",
    "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/IR/protocols/https.txt",
    "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/IR/protocols/socks5.txt",
    "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
    "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=ir&proxy_format=ipport&format=text",
    "https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc&country=IR&protocols=http%2Chttps",
    "https://www.proxy-list.download/api/v1/get?type=http&country=IR",
]

RELAYS = {
    "allorigins": "https://api.allorigins.win/raw?url=" + requests.utils.quote(TSETMC, safe=""),
    "codetabs": "https://api.codetabs.com/v1/proxy?quest=" + requests.utils.quote(TSETMC, safe=""),
    "corsproxy": "https://corsproxy.io/?url=" + requests.utils.quote(TSETMC, safe=""),
    "jina": "https://r.jina.ai/" + TSETMC,
    "thingproxy": "https://thingproxy.freeboard.io/fetch/" + TSETMC,
    "corseu": "https://api.cors.lol/?url=" + requests.utils.quote(TSETMC, safe=""),
}

results = {"started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "direct": {}, "relays": {}, "proxies": {}}


def session():
    s = requests.Session()
    s.headers.update(HEADERS)
    s.mount("https://", HTTPAdapter(max_retries=0))
    return s


def check(url, proxies=None, timeout=(8, 20)):
    started = time.time()
    try:
        resp = session().get(url, proxies=proxies, timeout=timeout)
        elapsed = round(time.time() - started, 1)
        rows = None
        try:
            rows = len(resp.json().get("marketwatch") or [])
        except Exception:
            pass
        return {
            "status": resp.status_code,
            "bytes": len(resp.content),
            "rows": rows,
            "seconds": elapsed,
            "head": resp.text[:120].replace("\n", " "),
        }
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {str(exc)[:140]}", "seconds": round(time.time() - started, 1)}


def collect_proxies():
    found = {}
    for url in PROXY_LISTS:
        try:
            resp = session().get(url, timeout=25)
            text = resp.text
        except Exception as exc:  # noqa: BLE001
            results.setdefault("list_errors", []).append(f"{url.split('?')[0]}: {type(exc).__name__}")
            continue
        if "geonode" in url:
            try:
                for item in resp.json().get("data", []):
                    if item.get("ip") and item.get("port"):
                        found.setdefault(f"{item['ip']}:{item['port']}", "http")
            except Exception:
                pass
        else:
            for m in IP_PORT.finditer(text):
                proto = "socks5" if "socks5" in url else "http"
                found.setdefault(f"{m.group(1)}:{m.group(2)}", proto)
    return found


def test_proxy(item):
    addr, proto = item
    url = ("socks5h://" if proto == "socks5" else "http://") + addr
    out = check(TSETMC, proxies={"http": url, "https": url}, timeout=(7, 14))
    if out.get("rows"):
        out["proxy"] = addr
        out["proto"] = proto
        return out
    return None


def main():
    results["direct"] = check(TSETMC, timeout=(10, 30))
    results["direct_variants"] = {
        "www.tsetmc.com": check(
            "https://www.tsetmc.com/api/ClosingPrice/GetMarketWatch?market=0&showTraded=true",
            timeout=(10, 25),
        ),
        "cdn http": check(TSETMC.replace("https://", "http://"), timeout=(10, 25)),
        "old.tsetmc.com": check("https://old.tsetmc.com/tsev2/data/MarketWatchPlus.aspx", timeout=(10, 25)),
    }

    for name, url in RELAYS.items():
        results["relays"][name] = check(url, timeout=(10, 35))

    proxies = collect_proxies()
    results["collected"] = len(proxies)
    ordered = list(proxies.items())
    http_first = [p for p in ordered if p[1] == "http"] + [p for p in ordered if p[1] != "http"]
    sample = http_first[:160]
    working = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=28) as pool:
        for res in pool.map(test_proxy, sample):
            if res:
                working.append(res)
                print("OK", res["proxy"], res["proto"], res["rows"], res["seconds"], flush=True)
    working.sort(key=lambda r: r["seconds"])
    results["proxies"] = {"tested": len(sample), "working": working}
    results["finished"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    with open("probe-results.json", "w", encoding="utf-8") as fh:
        json.dump(results, fh, ensure_ascii=False, indent=1)
    print(json.dumps({k: results[k] for k in ("direct", "collected")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
