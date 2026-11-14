# PROJECT_NOTES.md — Zarquant handover

_Last updated: 2026-11-14_

Handover notes for a new AI assistant (or developer) taking over the Zarquant project.
Read this before changing anything; it explains the pipeline, the files, the deployment and
the known constraints.

**خلاصه فارسی:** «زارکوانت» یک داشبورد استاتیک برای بازار سرمایه ایران (TSETMC) با ظاهر
تاریک و تختِ سبک تریدینگ‌ویو است: نمودار شمعی روان در مرکز و واچ‌لیست در سمت راست. اسکریپت
پایتون داده‌ها را از API رسمی TSETMC می‌گیرد و در `data.json` می‌نویسد؛ فرانت‌اند همان فایل را
می‌خواند و کندل‌های روزانه را یا از داده‌های همراهِ فایل و یا به‌صورت درخواستی از CDN می‌گیرد.
میزبانی روی GitHub Pages است و صفحه با StatiCrypt رمزدار می‌شود (رمز پیش‌فرض: `e19m_1iLL`).

---

## 1. Project overview

| Item | Value |
| --- | --- |
| Product name | **Zarquant** / زارکوانت |
| Purpose | Static market dashboard for the Tehran Stock Exchange (TSETMC) with a TradingView-style chart + watchlist |
| Live site | https://ichizenx.github.io/zarquant/ |
| Repository | local clone of `https://github.com/esmaillbeya/bayat.git` (GitHub redirects it to the renamed `Ichizenx/zarquant`, default branch `main`) |
| Stack | Python 3 standard library (scraper), vanilla HTML/CSS/JS (frontend), GitHub Pages + GitHub Actions |
| Build step | GitHub Actions only: `fetch_data.py` → `data.json`, then StatiCrypt → `index.html` |
| Data source | TSETMC JSON APIs on `cdn.tsetmc.com` (market watch + daily price history) |
| Language / direction | Persian (fa), RTL, dark theme, flat design (no gradients, no 3D) |
| Site password | `e19m_1iLL` (public fallback in the workflow; a `STATICRYPT_PASSWORD` secret overrides it) |

The dashboard opens on the most liquid stock and shows five instrument groups —
**Stocks (سهام)**, **Funds (صندوق‌ها)**, **Gold Funds (صندوق‌های طلا)**, **Options (اختیار معامله)**
and **Other (سایر اوراق)** — in a collapsible right-hand watchlist.

---

## 2. Architecture

```
TSETMC JSON APIs
   ├─ /api/ClosingPrice/GetMarketWatch              → every instrument, intraday snapshot
   └─ /api/ClosingPrice/GetClosingPriceDailyList    → daily OHLCV per insCode (CORS: *)
                    │
                    ▼
fetch_data.py ──► data.json (market watch + back-adjusted seed candles)
                    │
                    ▼
GitHub Pages serves the repo root
                    │
                    ▼
index.src.html ──(StatiCrypt in CI)──► index.html (password gate)
   + style.css + chart.js + script.js
                    │
                    ▼
browser: fetch("data.json") → render watchlist/pulse → chart paints seeds,
         and fetches history for any other symbol straight from TSETMC
```

No backend, no database, no bundler, no npm runtime dependency. Everything is static files
in the repository root.

### 2.1 The scraper (`fetch_data.py`)

Standard library only (`urllib`, `json`, `gzip`, `concurrent.futures`) — CI needs no
`pip install`.

* **Market watch:** `GET https://cdn.tsetmc.com/api/ClosingPrice/GetMarketWatch` with
  `market=0`, `paperTypes[0]=1`, `showTraded=true`, `withBestLimits=false`, `hEven=0`, `RefID=0`.
  Browser-like headers are required (`User-Agent`, `Referer: https://www.tsetmc.com/`).
* **History seeds:** `GET …/GetClosingPriceDailyList/{insCode}/{bars}` for the most liquid
  symbols of each displayed group (default 8 per group, 150 bars). The last path segment is
  the bar count, so responses stay small (~40 KB for 120 bars). Requests run in a thread pool.
* **Hardening:** `socket.setdefaulttimeout(20)`, 3 attempts with backoff, per-call budget,
  `Accept-Encoding: gzip`, and a `--insecure` flag for networks behind a TLS-inspecting proxy
  (never use it in CI).
* **Classification** (checked in this order) uses the codes carried in each row (`flow`, `csv`)
  plus name keywords:

| Rule | Group |
| --- | --- |
| Name contains `اختيار` (call/put contracts) | `options` |
| `flow == 3` (derivative board) | `other` |
| `csv == "68"` and `flow == 7` (commodity fund board) | `goldFunds` |
| `csv == "68"` (listed funds / ETFs) | `funds` |
| `flow == 6` or `flow == 7` | `other` |
| Debt keywords (`مرابحه`, `صكوك`, `مشاركت`, `اعتبارمولد`) | `other` |
| Everything else | `stocks` |

Each group is sorted by traded value (descending); gold funds keep only instruments that
traded today.

**Corporate-action adjustment.** `GetClosingPriceDailyList` returns *raw* prices, so a split or
capital increase appears as a cliff (e.g. فولاد drops −26 % on 2026-08-01). Every row carries
`priceYesterday`, the previous close restated in today's price basis; `build_bars()` walks the
rows newest→oldest and multiplies an accumulated factor (`priceYesterday / real previous close`)
into older OHLC values (and divides volume by it). The newest price is untouched, so the series
is continuous and matches today's quotes.

### 2.2 `data.json` schema

```json
{
  "updated": "2026-11-14T12:11:00+03:30",
  "source": "TSETMC market watch (cdn.tsetmc.com)",
  "counts": { "stocks": 812, "funds": 335, "goldFunds": 56, "options": 529, "other": 34 },
  "totalValue": 892000000000000,
  "history": { "bars": 150, "symbols": 32 },
  "categories": {
    "stocks": [ { "s": "فولاد", "n": "فولاد مبارکه اصفهان", "p": 5090, "c": 5010,
                  "ch": 2.83, "v": 3738000000, "val": 18700000000000, "t": 36574,
                  "i": "IRO1FOLD0001", "k": "46348559193224090",
                  "h": [[20260808, 2305, 2374, 2305, 2332, 8751481850], "…"] } ]
  }
}
```

| Key | Meaning |
| --- | --- |
| `s` | Symbol (نماد) |
| `n` | Company / instrument name |
| `p` | Last traded price, rials (live during the session) |
| `c` | Closing price, rials |
| `ch` | Change vs. previous close, percent |
| `v` | Volume, shares |
| `val` | Traded value, rials |
| `t` | Number of trades |
| `i` | ISIN |
| `k` | TSETMC `insCode` — required to fetch more history in the browser |
| `h` | Optional seed candles, oldest→newest: `[yyyymmdd, open, high, low, close, volume]`, already adjusted |

> Any change to these keys must be mirrored in `script.js` (`rowHtml`, `renderDetail`,
> `barsFromCompact`, `barsFromApi`, `renderPulse`).

### 2.3 The frontend

**`index.src.html`** — the plain template (edit this). Top bar (brand, daily/weekly/monthly,
sync time, refresh), chart panel (title, quote, OHLC legend, mode/tools toolbar, canvas,
footer stats), market pulse strip, watchlist aside, mobile drawer + scrim.

**`style.css`** — one file, one design system. Tokens live in `:root`:
`--bg #131722`, `--panel #1e222d`, `--panel-2 #181c27`, `--hover #2a2e39`, `--line #2a2e39`,
`--text #d1d4dc`, `--muted #787b86`, `--green #089981`, `--red #f23645`, `--blue #2962ff`.
Flat by rule: 1 px hairlines, solid fills, no gradients, no drop shadows (only the mobile
drawer has one). Layout is a CSS grid with areas `"topbar topbar" / "watchlist stage"`; the
watchlist is the first column, which puts it on the **right** in RTL.

**`chart.js`** — dependency-free canvas renderer (`window.ZChart.mount(canvas, { onHover, onLeave })`).

| Method | Effect |
| --- | --- |
| `setSeries(bars, {animate})` | New candles (`{t: Date, o,h,l,c,v}` ascending); triggers the draw-in animation |
| `setMode("candles" \| "line" \| "area")` | Chart type, flat colours only |
| `setWatermark(text)` | Faint symbol watermark in the middle of the plot |
| `setLivePrice(price)` | Blue dashed "current price" line when the live quote differs from the last daily close |
| `resetView(animate)` | Back to the default zoom |
| `resize()` / `destroy()` | Manual layout sync / teardown |

Rendering details worth knowing:

* Price scale on the right, time scale at the bottom, volume in the lower ~22 % of the plot.
* Zoom, pan and price-range changes are **damped** (lerped toward a target every frame), which
  is what makes wheel/drag feel smooth instead of jumpy; the entrance reveal is a left→right
  clip eased with `easeOutCubic` (skipped under `prefers-reduced-motion`).
* Crosshair with dashed axes, price badge and Persian date badge; the OHLC legend in
  `script.js` follows the hovered candle.
* Canvas is absolutely positioned inside `.chart-canvas` and sized from a `ResizeObserver`
  (`devicePixelRatio` capped at 2.5). Never set its CSS height from JS or the grid row grows.

**`script.js`** — one IIFE:

* `load()` fetches `data.json?v=<ts>` with `cache: "no-store"`.
* `selectRow(cat, index)` paints the seeded `h` candles immediately, then calls `loadHistory()`
  and repaints when the fuller series arrives (guarded by a sequence token).
* `loadHistory(item)` → `GetClosingPriceDailyList/{k}/300`, back-adjusted in `barsFromApi`,
  cached in memory and `sessionStorage` (`zq:h:<insCode>`), 9 s abort timeout. Because
  `cdn.tsetmc.com` answers `Access-Control-Allow-Origin: *`, this works for **every** symbol,
  not just the seeded ones. On failure the chart shows the "no history" state and the stats
  stay valid.
* `aggregate(bars, tf)` rolls daily candles into weekly (Monday-based) or monthly buckets.
* `renderWatchlist()` — collapsible groups (`state.collapsed`), search filter (`state.query`,
  debounced 110 ms), pagination at 80 rows (`state.limits`), `نمایش بیشتر` button.
* `renderPulse()` — instrument count, total traded value (همت), best gainer, highest turnover.
* `renderDetail()` — chart header + footer stats, including the date of the last candle
  (`statLastBar`) so the gap between the live quote and the daily series is explicit.
* Mobile drawer (`is-open` classes + scrim), fullscreen via the Fullscreen API.
* `window.Zarquant = { state, chart, select, reload }` is a deliberate debug handle.

---

## 3. File structure

| Path | Role |
| --- | --- |
| `index.src.html` | **Plain** page template — the only markup file you edit |
| `index.html` | Encrypted build artifact generated by StatiCrypt (never edit by hand) |
| `style.css` | Flat dark theme + responsive layout |
| `chart.js` | Canvas candlestick engine |
| `script.js` | Data loading, watchlist, search, selection, history cache |
| `data.json` | Generated dataset (~480 KB): market watch + seed history |
| `fetch_data.py` | Scraper: TSETMC → classified `data.json` |
| `.staticrypt.json` | StatiCrypt salt config — keeps local and CI ciphertext deterministic |
| `.github/workflows/update.yml` | Scheduled refresh, encryption, commit |
| `PROJECT_NOTES.md` | This document |
| `README.md` | Short public description |

---

## 4. Deployment

**GitHub Pages** — branch `main`, folder `/`, no build step. Every push triggers
`pages-build-deployment`; the site updates in ~30–90 s.
URLs: site → `https://ichizenx.github.io/zarquant/`, data → `…/data.json`.

**GitHub Actions — `.github/workflows/update.yml`**

* Triggers: `schedule` cron `"30 14 * * *"` (14:30 UTC = **18:00 Tehran**) and
  `workflow_dispatch`.
* Permissions `contents: write`; concurrency group `update-market-data`; `timeout-minutes: 15`.
* Steps: checkout → Python 3.11 → `timeout 300 python fetch_data.py -o data.json --bars 150
  --history 8` → Node 20 → `npm install -g staticrypt@3` → encrypt → commit `data.json` +
  `index.html` → fail the job if the fetch step failed (the encryption still runs).
* Secrets: optional `TSETMC_PROXY` (HTTP proxy for the fetch step) and optional
  `STATICRYPT_PASSWORD` (overrides the built-in password).

### 4.1 Password protection (StatiCrypt)

1. CI copies `index.src.html` to `index.html`.
2. `staticrypt index.html -p "$STATICRYPT_PASSWORD" -d .staticrypt-build` produces the
   self-contained encrypted page (crypto bundle inlined).
3. The result replaces `index.html`, is sanity-checked (`grep -qi staticrypt`, and the plain
   watchlist marker must be gone) and committed, so Pages always serves the locked version.
4. **Edit `index.src.html`, never the generated `index.html`** — the next CI run overwrites it.

The password used when the secret is absent is `e19m_1iLL`, set in the workflow as
`${{ secrets.STATICRYPT_PASSWORD || 'e19m_1iLL' }}`. It is a **public** password by design:
client-side encryption only keeps casual visitors out. `.staticrypt.json` (the salt) is
committed so repeated encryptions are byte-stable and CI does not produce a commit every run.

Local encryption, for a manual build:

```powershell
npm install -g staticrypt@3
copy index.src.html index.html
staticrypt index.html -p "e19m_1iLL" -d .staticrypt-build --short --remember 30 `
  --template-title "Zarquant | زارکوانت" `
  --template-instructions "برای دیدن داشبورد، رمز عبور را وارد کنید." `
  --template-button "ورود" --template-placeholder "رمز عبور" `
  --template-remember "مرا به خاطر بسپار" --template-error "رمز عبور نادرست است." `
  --template-color-primary "#089981" --template-color-secondary "#131722"
copy .staticrypt-build\index.html index.html
```

Limitations to remember:

* StatiCrypt encrypts the HTML shell only. `style.css`, `chart.js`, `script.js` and — most
  importantly — `data.json` stay publicly readable. The password hides the interface, not the data.
* Anyone with repository write access can push a plain `index.html` and bypass the lock.
* Round-trip check (proves the ciphertext is valid): `staticrypt index.html --decrypt -p … `
  must reproduce `index.src.html` byte for byte.

### ⚠️ Known limitation — TSETMC geo-blocking

GitHub-hosted runners execute in the United States; TSETMC frequently refuses or drops requests
from non-Iranian networks, so the scheduled job can fail at the "Fetch TSETMC data" step. The
site does not break (it keeps the last `data.json` and is still re-encrypted), it just goes
stale. Fixes: set the `TSETMC_PROXY` secret, run `fetch_data.py` from an Iranian connection, or
use a self-hosted runner. This machine (Iran) reaches the API in ~10 s; the network here
intercepts TLS with a self-signed chain, hence `--insecure` for local runs.

---

## 5. Instructions for the next AI assistant

### 5.1 Preview locally

```powershell
cd <repo>
python -m http.server 8765 --bind 127.0.0.1
# open http://127.0.0.1:8765/index.src.html   (plain template, no password)
```

`file://` will not work: `fetch()` of `data.json` needs HTTP. For a headless visual check
(Chrome here needs broader file permissions because it uses named pipes):

```powershell
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
& $chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars `
  --user-data-dir="$env:TEMP\zq-prof" --window-size=1440,900 `
  --virtual-time-budget=12000 --screenshot="$PWD\shot.png" `
  "http://127.0.0.1:8765/index.src.html"
```

Use a **fresh** `--user-data-dir` after CSS/JS edits, otherwise the profile cache serves the old
files. `--dump-dom` returns the rendered DOM, which is the quickest way to assert that the
watchlist and stats really rendered (`class="wl-row"`, `id="cSymbol"`, …). Note that headless
`--window-size` is not exactly the CSS viewport (the dump-dom path loses ~95 px of height), so
measure boxes in-page instead of trusting screenshot pixels.

### 5.2 Smoke-test the interactions

The pattern used during development: generate a temporary copy of `index.src.html` with a script
that drives the UI and writes `RESULT {…}` into a `<pre>` (then `--dump-dom` and read it), and
delete the file afterwards. What matters: click a watchlist row, switch `1W`/`1M`, toggle
`line`/`area`, type in the search box, collapse a group, open an options row (exercises the
on-demand TSETMC fetch), wheel-zoom and drag the canvas — with zero entries in
`window.onerror` / `unhandledrejection`.

### 5.3 Publish an update

```powershell
git -C <repo> status
git -C <repo> add -- index.src.html style.css chart.js script.js data.json
# index.html only when you re-encrypted it locally; CI rebuilds it anyway
git -C <repo> commit -m "feat: …"
git -C <repo> push origin main
```

* Remote: `https://github.com/esmaillbeya/bayat.git` (redirects to `Ichizenx/zarquant`).
* Wait ~1 minute, then confirm the Pages URL returns 200.
* **Never** stage `README.md` naively: the repository historically contained `README.md`,
  `readme.md` and `READE.md`, which collide on Windows. That collision was cleaned up
  (single `README.md`); do not reintroduce mixed-case duplicates.

### 5.4 Changing the UI

* Keep the design tokens in `:root` of `style.css`; never hardcode colours in `script.js`.
* Layout contract: `.app` is a grid with areas `"topbar topbar" / "watchlist stage"`; the
  watchlist is the first column (right in RTL). Below 900 px it becomes a fixed drawer.
* Watchlist row grid: `symbol | last | change | change%` — keep `.wl-cols` and `.wl-row`
  column templates in sync.
* Numeric cells use `direction: ltr` with `tabular-nums`; keep them isolated so RTL text and
  Latin digits do not mix badly.
* Do not stack shadows/gradients — the flat look is a product requirement.
* After UI edits: screenshot desktop (1440×900) and narrow (500×950), check the console, and
  confirm the chart still fills its row (no canvas overflow).

### 5.5 Changing the scraper

* Endpoint and parameters live at the top of `fetch_data.py`; parsing in `build()` /
  `to_bar()` / `build_bars()`; grouping in `classify()`.
* If you add or rename JSON fields, update the matching rendering code in `script.js` **and**
  section 2.2 of this file.
* Verify classification against real rows before reordering the rules — the order is:
  options → derivatives → gold funds → funds → certificates → debt keywords → stocks.
* Keep `data.json` deterministic in structure; the frontend assumes every category exists
  (even if empty). An empty group is legitimate on holidays.
* Newly listed symbols report enormous `ch`; the "best gainer" card ignores moves above 100 %.

### 5.6 Constraints and gotchas

* The repository is public: no tokens, proxy credentials or private data in commits.
* GitHub Pages has no server logic — anything dynamic lives in `script.js` or in `data.json`.
* The daily list usually starts at today's bar only after the session, so during the session
  the chart's last candle is the previous day while the header shows the live quote. That is
  why the chart draws the blue live-price line and the footer shows `کندل آخر`.
* `sessionStorage` history cache is per tab; it is capped by browser quota, failures are silent.
* Automated refreshes only work where TSETMC is reachable (see §4).

---

## 6. Quick checklist for a new session

1. `git status` — confirm you are on `main` and the tree is clean.
2. Read `fetch_data.py`, `chart.js` and `script.js` before touching anything.
3. Serve over HTTP and screenshot before/after any UI change (desktop + narrow).
4. Run a smoke test for clicks, timeframes, chart modes, search and zoom.
5. Commit only the intended paths; push to `main`; verify the Pages URL after ~1 minute.
6. If the daily refresh matters, check the last Actions run, `TSETMC_PROXY` and the
   `STATICRYPT_PASSWORD` secret.
