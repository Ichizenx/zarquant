# PROJECT_NOTES.md — Zarquant handover

_Last updated: 2026-11-12_

Handover notes for a new AI assistant (or developer) taking over the Zarquant project.
Read this file before changing anything; it explains the pipeline, the files, the deployment and the known constraints.

**خلاصه فارسی:** «زارکوانت» یک داشبورد استاتیک برای بازار سرمایه ایران (TSETMC) است. یک اسکریپت پایتون داده‌ها را از API رسمی TSETMC می‌گیرد و در `data.json` می‌نویسد؛ فرانت‌اند استاتیک (HTML/CSS/JS) همان فایل را می‌خواند و در قالب واچ‌لیست سبک TradingView نشان می‌دهد. میزبانی روی GitHub Pages است و یک GitHub Action روزانه ساعت ۱۸ به‌وقت تهران سعی می‌کند `data.json` را به‌روز کند.

---

## 1. Project overview

| Item | Value |
| --- | --- |
| Product name | **Zarquant** / زارکوانت |
| Purpose | Static market dashboard for the Tehran Stock Exchange (TSETMC) with a TradingView-style watchlist UI |
| Live site | https://ichizenx.github.io/zarquant/ |
| Repository | https://github.com/Ichizenx/zarquant (default branch `main`) |
| Legacy remote | https://github.com/esmaillbeya/bayat — the repository was renamed; GitHub redirects this URL to the current one |
| Stack | Python 3 + `requests` (scraper), vanilla HTML/CSS/JS (frontend), GitHub Pages + GitHub Actions |
| Build step | None — the site is served as-is from the repository root |
| Data source | TSETMC market watch JSON API (`https://cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch`) |
| Language / direction | Persian (fa), RTL, dark theme |

The dashboard shows four instrument groups — **Stocks (سهام)**, **Funds (صندوق‌ها)**, **Gold Funds (صندوق‌های طلا)** and **Options (اختیار معامله)** — in a collapsible right-hand watchlist, plus a detail panel for the selected symbol.

---

## 2. Architecture

```
TSETMC JSON API
      │  (HTTPS, requests)
      ▼
fetch_data.py ──► writes data.json (committed to git)
      │
      ▼
GitHub Pages serves the repo root
      │
      ▼
index.html + style.css + script.js ──► fetch("data.json") ──► render watchlist + detail panel
```

There is **no backend, no database, no bundler and no npm dependency**. Everything is static files in the repository root.

### 2.1 The scraper (`fetch_data.py`)

* Calls the JSON endpoint the TSETMC website itself uses:
  `GET https://cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch`
  with `market=0`, `paperTypes[0]=1`, `showTraded=true`, `withBestLimits=false`, `hEven=0`, `RefID=0`.
* Sends browser-like headers (`User-Agent`, `Referer: https://www.tsetmc.com/`) because the CDN rejects bare clients.
* Network hardening: `socket.setdefaulttimeout(20)`, per-request timeout `(10, 35)`, 3 attempts with backoff, overall budget of 150 s. It fails fast instead of hanging.
* Classification into groups uses TSETMC codes carried in each row (`flow`, `csv` sector code) plus name keywords:

| Rule (checked in this order) | Group |
| --- | --- |
| Name contains `اختيار` (call/put contracts) | `options` |
| `flow == 3` (derivative board: futures, sukuk, participation papers) | `other` |
| `csv == "68"` and `flow == 7` (commodity fund board) | `goldFunds` |
| `csv == "68"` (ETFs / listed funds) | `funds` |
| `flow == 6` or `flow == 7` (capacity & commodity certificates) | `other` |
| Name contains a debt keyword (`مرابحه`, `صكوك`, `مشاركت`, `اعتبارمولد`) | `other` |
| Everything else | `stocks` |

* Gold funds are further filtered to instruments with **volume > 0 today** and sorted by traded value.
* Each group is sorted by traded value (descending) before it is written.

### 2.2 `data.json` schema

```json
{
  "updated": "2026-11-12T03:52:35+03:30",
  "source": "TSETMC market watch (cdn.tsetmc.com)",
  "counts": { "stocks": 1198, "funds": 383, "goldFunds": 71, "options": 619, "other": 55 },
  "totalValue": 1453000000000000,
  "categories": {
    "stocks":   [ { "s": "فملي", "n": "ملي صنايع مس ايران", "p": 28280, "c": 28540,
                    "ch": -2.98, "v": 788411433, "val": 22501833512630, "t": 69005,
                    "i": "IRO1MSMI0001" } ],
    "funds":    [ ... ], "goldFunds": [ ... ], "options": [ ... ], "other": [ ... ]
  }
}
```

Field keys (short on purpose, keeps the file small):

| Key | Meaning |
| --- | --- |
| `s` | Symbol (نماد) |
| `n` | Company / instrument name |
| `p` | Last traded price, rials |
| `c` | Closing price, rials |
| `ch` | Change vs. previous close, percent (may be extreme for newly listed symbols) |
| `v` | Volume, shares |
| `val` | Traded value, rials |
| `t` | Number of trades |
| `i` | ISIN |

> Any change to these keys must be mirrored in `script.js` (`rowHtml`, `renderDetail`, `renderSummary`, `renderGroups`).

### 2.3 The frontend

* `index.html` — static shell: top bar, summary cards, detail panel, category summary, watchlist `<aside>`, floating “open watchlist” button on mobile.
* `style.css` — all styling. TradingView-like palette in `:root` (`--bg #131722`, `--panel #1e222d`, `--line #2a2e39`, `--green #089981`, `--red #f23645`). Layout is a CSS grid: `grid-template-areas: "topbar topbar" / "watchlist stage"` so the watchlist sits on the **right** in RTL.
* `script.js` — one IIFE:
  * `load()` fetches `data.json?v=<timestamp>` with `cache: "no-store"`.
  * `renderSummary()` — market KPIs (instrument count, total traded value, best gainer, highest turnover).
  * `renderGroups()` — per-category counts and traded value.
  * `renderWatchlist()` — builds collapsible groups (`state.collapsed`), applies the search filter (`state.query`), paginates at 60 rows per group with a “نمایش بیشتر” button (`state.limits`).
  * `selectRow()` / `renderDetail()` — clicking a watchlist row updates the detail panel.
  * `deltaOf(item)` — daily change in rials derived from `ch` (`p - p/(1+ch/100)`); `ch` alone is the percentage.
  * Sidebar collapse/expand is a CSS class on `.app` (`collapsed`), with a mobile drawer (`transform: translateX(100%)`).

---

## 3. File structure

| Path | Role |
| --- | --- |
| `index.html` | Page shell and watchlist markup |
| `style.css` | Full dark theme + responsive layout (desktop grid / mobile drawer) |
| `script.js` | Data loading, watchlist rendering, search, collapse, detail panel |
| `data.json` | Generated dataset (~350 KB, ~2,300 instruments) — committed so Pages can serve it |
| `fetch_data.py` | Scraper: TSETMC → classified `data.json` |
| `.github/workflows/update.yml` | Scheduled refresh + commit of `data.json` |
| `PROJECT_NOTES.md` | This handover document |
| `README.md`, `readme.md`, `READE.md`, `test.txt` | Leftovers from early experiments — safe to delete in a cleanup commit |

Local-only helpers (outside the repository, not deployed):

| Path | Role |
| --- | --- |
| `C:\Users\ichimoku\.dsh\state\superagent\tse\tse_top10.py` | Legacy Excel exporter (top-10 / full market → `.xlsx`), local only |
| `C:\Users\ichimoku\.dsh\state\superagent\tse\run.bat` | Windows launcher for the Excel exporter |
| `C:\Users\ichimoku\.dsh\state\superagent\tse\tse_all_market.xlsx` | Last Excel export |

---

## 4. Deployment

**GitHub Pages**

* Source: branch `main`, folder `/` (repo root). Configured through the Pages API; no build step.
* Every push to `main` triggers `pages-build-deployment`; the site updates in roughly 30–90 seconds.
* URLs: site → `https://ichizenx.github.io/zarquant/`, data → `https://ichizenx.github.io/zarquant/data.json`.

**GitHub Actions — `.github/workflows/update.yml`**

* Triggers: `schedule` cron `"30 14 * * *"` (14:30 UTC = **18:00 Tehran**, UTC+03:30) and `workflow_dispatch` (manual “Run workflow”).
* Permissions: `contents: write` (needed to push `data.json`); concurrency group `update-market-data`; `timeout-minutes: 12`.
* Steps: checkout → Python 3.11 → `pip install requests` → `timeout 240 python fetch_data.py -o data.json` → commit and push `data.json` only if it changed (author `github-actions[bot]`).
* Optional secret `TSETMC_PROXY`: when set, it is exported as `HTTP_PROXY`/`HTTPS_PROXY` for the fetch step.

### ⚠️ Known limitation — TSETMC geo-blocking

GitHub-hosted runners execute in the United States. TSETMC frequently refuses or silently drops requests from non-Iranian networks, so the scheduled job currently **fails at the “Fetch TSETMC data” step** (the same request completes in ~2 seconds from an Iranian connection).

Consequences and options:

1. The site keeps serving the last committed `data.json` — it does not break, it just goes stale.
2. Add an HTTP proxy URL as the `TSETMC_PROXY` repository secret (workflow already supports it) and the schedule starts working.
3. Or run `fetch_data.py` on a machine with Iranian connectivity (e.g. a Windows Task Scheduler job) and push `data.json`; or register that machine as a self-hosted runner.

---

## 5. Instructions for the next AI assistant

### 5.1 Run the scraper locally

```powershell
cd C:\Users\ichimoku\.dsh\state\superagent\site   # working copy; the git clone is ..\bayat
py -3.9 fetch_data.py -o data.json
```

* Requires Python 3 and `requests` (`py -3.9 -m pip install requests`).
* Expected output: `Wrote data.json: stocks=…, funds=…, goldFunds=…, options=…, other=…`.
* Sanity check: `counts` should total ~2,326 instruments on a normal trading day.

### 5.2 Serve the site locally

```powershell
cd C:\Users\ichimoku\.dsh\state\superagent\site
py -3.9 -m http.server 8765 --bind 127.0.0.1
# open http://127.0.0.1:8765/
```

Opening `index.html` directly with `file://` fails because `fetch()` needs HTTP. A headless screenshot for visual checks:

```powershell
& 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' --headless --disable-gpu --no-sandbox `
  --hide-scrollbars --user-data-dir=$env:TEMP\zq-prof --window-size=1400,900 `
  --virtual-time-budget=25000 --screenshot="$PWD\shot.png" "http://127.0.0.1:8765/"
```

> Headless limitation: the old headless mode clamps the window to ~500 px, so “mobile” screenshots are taken at `--window-size=500,950` (the `max-width: 900px` breakpoint still applies). Always check for horizontal overflow.

### 5.3 Publish an update

```powershell
git -C C:\Users\ichimoku\.dsh\state\superagent\bayat status
# stage only the files you changed, e.g.
git -C C:\Users\ichimoku\.dsh\state\superagent\bayat add -- index.html style.css script.js data.json
git -C C:\Users\ichimoku\.dsh\state\superagent\bayat commit -m "feat: …"
git -C C:\Users\ichimoku\.dsh\state\superagent\bayat push origin main
```

* Remote: `https://github.com/Ichizenx/zarquant.git` (the clone also exists at `…\superagent\bayat`).
* Wait ~1 minute, then confirm `https://ichizenx.github.io/zarquant/` returns 200 and contains your change (Pages caches for a few seconds).
* **Never** stage `README.md` blindly: the repository contains `README.md` and `readme.md`, which collide on Windows; a naive `git add -A` silently records a deletion of one of them.

### 5.4 Changing the UI

* Keep the design tokens in `:root` of `style.css`; do not hardcode colours in `script.js`.
* Layout contract: `.app` is a grid with areas `"topbar topbar" / "watchlist stage"`; the watchlist is the first column, which puts it on the right in RTL. `.app.collapsed` shrinks it to `0px`; on screens ≤900 px the aside becomes a fixed drawer.
* Watchlist row grid: `symbol | last | change | change%` — keep the column count in `.wl-cols` and `.wl-row` in sync.
* Persian text: use `dir="rtl"` at the document level; keep `dir="ltr"` on numeric cells (`.last`, `.chg`, `.pct` use `direction: ltr`).
* After UI edits: regenerate a screenshot, verify both desktop (1400×900) and narrow (500×950) layouts, and check the browser console for JS errors.

### 5.5 Changing the scraper

* Endpoint and query parameters live at the top of `fetch_data.py`; parsing lives in `build()`; grouping in `classify()`.
* If you add or rename JSON fields, update the matching rendering code in `script.js` (and section 2.2 of this file).
* If TSETMC changes its payload (e.g. new sector codes for funds), verify against real rows before changing the classification order — the current order is: options → derivatives → gold funds → funds → certificates → debt keywords → stocks.
* Newly listed symbols report an enormous `ch` because their base price is nominal; the “best gainer” card ignores percentages above 100 %.

### 5.6 Constraints and gotchas

* The repository is public: never commit proxy credentials, tokens or private data. Use repository secrets.
* GitHub Pages has no server-side logic — any dynamic behaviour must live in `script.js` or be pre-generated into `data.json`.
* Automated refreshes only work where TSETMC is reachable (see §4).
* Keep `data.json` deterministic in structure; the frontend assumes every category exists (even if empty).
* The Excel exporter (`tse_top10.py`, `run.bat`, `.xlsx`) is a local side tool and is intentionally **not** in the repository.

---

## 6. Quick checklist for a new session

1. `git -C …\bayat status` and `gh auth status` — confirm you are on `main` and authenticated.
2. Read `fetch_data.py` and `script.js` before touching either.
3. Run the scraper locally; confirm `data.json` counts look sane.
4. Serve locally over HTTP and screenshot before/after any UI change.
5. Commit only the intended paths; push to `main`; verify the Pages URL after ~1 minute.
6. If the daily refresh matters, check the last Actions run and the `TSETMC_PROXY` secret.
