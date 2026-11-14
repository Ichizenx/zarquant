/* ============================================================================
   Zarquant app — data loading, watchlist, selection, history cache, chrome.
   The chart itself lives in chart.js (window.ZChart).
   ========================================================================== */
(function () {
  "use strict";

  var CATEGORIES = [
    { key: "stocks", label: "سهام" },
    { key: "funds", label: "صندوق‌ها" },
    { key: "goldFunds", label: "صندوق‌های طلا" },
    { key: "options", label: "اختیار معامله" },
    { key: "other", label: "سایر اوراق" },
  ];

  var GROUP_LABEL = {};
  CATEGORIES.forEach(function (c) { GROUP_LABEL[c.key] = c.label; });

  var PAGE_SIZE = 80;
  var HISTORY_URL = function (ins, bars) {
    return (
      "https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceDailyList/" +
      encodeURIComponent(ins) + "/" + (bars || 300)
    );
  };

  var nf = new Intl.NumberFormat("en-US");
  var nf1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  var nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var faDate = new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Tehran",
  });
  var faDay = new Intl.DateTimeFormat("fa-IR", { dateStyle: "short" });

  var state = {
    data: null,
    query: "",
    collapsed: new Set(["other"]),
    limits: {},
    selected: null,
    tf: "1D",
    mode: "candles",
    seq: 0,
    series: [],
  };

  var histCache = new Map();

  function $(sel) { return document.querySelector(sel); }

  var el = {
    app: $("#app"),
    sync: $("#sync"),
    refresh: $("#refresh"),
    wlToggle: $("#wlToggle"),
    wlClose: $("#wlClose"),
    watchlist: $("#watchlist"),
    scrim: $("#scrim"),
    body: $("#wlBody"),
    search: $("#search"),
    count: $("#wlCount"),
    empty: $("#wlEmpty"),
    cSymbol: $("#cSymbol"),
    cGroup: $("#cGroup"),
    cName: $("#cName"),
    cPrice: $("#cPrice"),
    cDelta: $("#cDelta"),
    lgO: $("#lgO"),
    lgH: $("#lgH"),
    lgL: $("#lgL"),
    lgC: $("#lgC"),
    lgChg: $("#lgChg"),
    stats: $("#cStats"),
    pulse: $("#pulse"),
    chartState: $("#chartState"),
    chartStateTitle: $("#chartStateTitle"),
    chartStateSub: $("#chartStateSub"),
    chartPanel: $("#chartPanel"),
    resetView: $("#resetView"),
    expand: $("#expand"),
    canvas: $("#candles"),
  };

  /* ---------------------------------------------------------------- utils */
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function normalize(value) {
    return String(value || "")
      .replace(/[يى]/g, "ی")
      .replace(/ك/g, "ک")
      .replace(/\u200c/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function hemt(rial) { return (rial || 0) / 1e13; }

  function changeClass(value) {
    return value > 0 ? "up" : value < 0 ? "down" : "flat";
  }

  function deltaOf(item) {
    if (!item || !item.ch) return 0;
    return Math.round(item.p - item.p / (1 + item.ch / 100));
  }

  function signed(value) {
    return value > 0 ? "+" + nf.format(value) : nf.format(value);
  }

  function signedPct(value) {
    if (value === null || value === undefined) return "—";
    return (value > 0 ? "+" : "") + nf2.format(value) + "%";
  }

  function priceText(value) {
    if (!value && value !== 0) return "—";
    return nf.format(Math.round(value));
  }

  function whenText(iso) {
    try { return faDate.format(new Date(iso)); } catch (err) { return iso || "—"; }
  }

  function dateFromInt(d) {
    var y = Math.floor(d / 10000);
    var m = Math.floor(d / 100) % 100;
    var day = d % 100;
    return new Date(Date.UTC(y, m - 1, day));
  }

  function barsFromCompact(rows) {
    var out = [];
    if (!Array.isArray(rows)) return out;
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      if (!r || r.length < 5) continue;
      var o = +r[1];
      var h = +r[2];
      var l = +r[3];
      var c = +r[4];
      if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
      out.push({ t: dateFromInt(+r[0]), o: o, h: h, l: l, c: c, v: +r[5] || 0 });
    }
    return out;
  }

  function barsFromApi(rows) {
    var out = [];
    var factor = 1; // back-adjustment for splits / capital increases
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i] || {};
      var d = +row.dEven;
      var o = +row.priceFirst;
      var h = +row.priceMax;
      var l = +row.priceMin;
      var c = +row.pClosing || +row.pDrCotVal;
      if (d && o > 0 && h > 0 && l > 0 && c > 0) {
        out.push({
          t: dateFromInt(d),
          o: o * factor,
          h: h * factor,
          l: l * factor,
          c: c * factor,
          v: Math.round((+row.qTotTran5J || 0) / factor),
        });
      }
      if (i + 1 < rows.length) {
        var older = rows[i + 1] || {};
        var prevClose = +older.pClosing || +older.pDrCotVal;
        var restated = +row.priceYesterday;
        if (restated > 0 && prevClose > 0) {
          var ratio = restated / prevClose;
          if (ratio >= 0.01 && ratio <= 100 && Math.abs(ratio - 1) > 0.002) factor *= ratio;
        }
      }
    }
    out.reverse(); // API sends newest first
    return out;
  }

  /* ------------------------------------------------------- timeframe rollup */
  function weekKey(date) {
    var t = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    var dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
    return Math.floor((t - dow * 86400000) / 604800000);
  }

  function aggregate(bars, tf) {
    if (tf === "1D" || !bars.length) return bars;
    var out = [];
    var key = null;
    var cur = null;
    for (var i = 0; i < bars.length; i += 1) {
      var b = bars[i];
      var k = tf === "1W" ? weekKey(b.t) : b.t.getUTCFullYear() * 100 + b.t.getUTCMonth();
      if (k !== key) {
        key = k;
        cur = { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
        out.push(cur);
      } else {
        if (b.h > cur.h) cur.h = b.h;
        if (b.l < cur.l) cur.l = b.l;
        cur.c = b.c;
        cur.v += b.v;
      }
    }
    return out;
  }

  /* ---------------------------------------------------------------- chart */
  var chart = window.ZChart.mount(el.canvas, {
    onHover: function (bar) { renderLegend(bar); },
    onLeave: function () { renderLegend(state.series[state.series.length - 1] || null); },
  });

  function applySeries(bars, reset) {
    state.series = bars || [];
    var rolled = aggregate(state.series, state.tf);
    chart.setSeries(rolled, { animate: true });
    if (reset) chart.resetView(false);
    renderLegend(rolled[rolled.length - 1] || null);
    var node = document.getElementById("statLastBar");
    var last = rolled[rolled.length - 1];
    if (node) node.textContent = last ? faDay.format(last.t) : "—";
  }

  function renderLegend(bar) {
    if (!bar) {
      el.lgO.textContent = el.lgH.textContent = el.lgL.textContent = el.lgC.textContent = "—";
      el.lgChg.textContent = "—";
      el.lgChg.className = "lg lg-chg";
      return;
    }
    el.lgO.textContent = priceText(bar.o);
    el.lgH.textContent = priceText(bar.h);
    el.lgL.textContent = priceText(bar.l);
    el.lgC.textContent = priceText(bar.c);
    var diff = bar.c - bar.o;
    var pct = bar.o ? (diff / bar.o) * 100 : 0;
    el.lgChg.textContent = (diff >= 0 ? "+" : "") + nf2.format(pct) + "%";
    el.lgChg.className = "lg lg-chg " + changeClass(diff);
  }

  /* ------------------------------------------------------------- history */
  function sessionGet(key) {
    try {
      var raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) { return null; }
  }

  function sessionSet(key, value) {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* quota */ }
  }

  function loadHistory(item) {
    if (!item || !item.k) return Promise.resolve(null);
    if (histCache.has(item.k)) return Promise.resolve(histCache.get(item.k));
    var cached = sessionGet("zq:h:" + item.k);
    if (cached && cached.length) {
      histCache.set(item.k, cached);
      return Promise.resolve(cached);
    }
    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = null;
    if (controller) timer = setTimeout(function () { controller.abort(); }, 9000);
    return fetch(HISTORY_URL(item.k, 300), {
      mode: "cors",
      credentials: "omit",
      signal: controller ? controller.signal : undefined,
    })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (json) {
        var bars = barsFromApi((json && json.closingPriceDaily) || []);
        if (bars.length) {
          histCache.set(item.k, bars);
          sessionSet("zq:h:" + item.k, bars);
        }
        return bars.length ? bars : null;
      })
      .catch(function () { return null; })
      .then(function (bars) {
        if (timer) clearTimeout(timer);
        return bars;
      });
  }

  /* ------------------------------------------------------------- header */
  function renderDetail(item) {
    if (!item) {
      el.cSymbol.textContent = "—";
      el.cName.textContent = "یک نماد را از واچ‌لیست انتخاب کنید";
      el.cGroup.hidden = true;
      el.cPrice.textContent = "—";
      el.cDelta.textContent = "—";
      el.cDelta.className = "quote-delta";
      el.stats.innerHTML = "";
      chart.setWatermark("");
      chart.setLivePrice(null);
      return;
    }
    var cls = changeClass(item.ch);
    el.cSymbol.textContent = item.s;
    el.cName.textContent = item.n || "—";
    el.cGroup.hidden = !state.selected;
    el.cGroup.textContent = state.selected ? GROUP_LABEL[state.selected.cat] || "" : "";
    el.cPrice.textContent = priceText(item.p);
    el.cDelta.textContent = signedPct(item.ch);
    el.cDelta.className = "quote-delta " + cls;
    chart.setWatermark(item.s);
    chart.setLivePrice(item.p);

    var delta = deltaOf(item);
    var stats = [
      { label: "آخرین", value: priceText(item.p), cls: "" },
      { label: "قیمت پایانی", value: priceText(item.c), cls: "" },
      { label: "تغییر", value: signed(delta), cls: cls },
      { label: "حجم", value: window.ZChart.fmtVolume(item.v), cls: "" },
      { label: "ارزش (همت)", value: nf2.format(hemt(item.val)), cls: "" },
      { label: "معاملات", value: nf.format(item.t), cls: "" },
      { label: "کندل آخر", value: "—", cls: "", id: "statLastBar" },
      { label: "شناسه", value: item.i || "—", cls: "" },
    ];
    var html = stats
      .map(function (s) {
        return (
          '<div class="stat"><span>' + s.label + '</span><b' +
          (s.id ? ' id="' + s.id + '"' : "") + ' class="' + s.cls + '">' +
          escapeHtml(s.value) + "</b></div>"
        );
      })
      .join("");
    html +=
      '<div class="stat is-grow"><span>منبع</span><b>TSETMC · به‌روزرسانی ' +
      escapeHtml(whenText(state.data ? state.data.updated : "")) + "</b></div>";
    el.stats.innerHTML = html;
  }

  function showChartState(kind) {
    if (!kind) {
      el.chartState.hidden = true;
      return;
    }
    var copy = {
      loading: ["در حال دریافت تاریخچه قیمت…", "کندل‌ها از TSETMC خوانده می‌شوند."],
      empty: [
        "تاریخچه قیمتی برای این نماد در دسترس نیست",
        "این نماد در بازه اخیر معامله نشده یا دسترسی به TSETMC از شبکه شما مسدود است؛ آمار پایین صفحه معتبر است.",
      ],
      error: ["داده‌های بازار دریافت نشد", "اتصال شبکه را بررسی کنید و دکمه به‌روزرسانی را بزنید."],
    }[kind] || ["", ""];
    el.chartStateTitle.textContent = copy[0];
    el.chartStateSub.textContent = copy[1];
    el.chartState.hidden = false;
  }

  /* ------------------------------------------------------------- selection */
  function selectRow(cat, index) {
    var items = (state.data && state.data.categories[cat]) || [];
    var item = items[index];
    if (!item) return;
    state.selected = { cat: cat, index: index };
    var token = ++state.seq;

    renderDetail(item);
    markSelected();

    var seeded = barsFromCompact(item.h);
    if (seeded.length > 12) {
      showChartState(null);
      applySeries(seeded, true);
    } else {
      showChartState("loading");
      chart.setSeries([]);
    }

    loadHistory(item).then(function (bars) {
      if (token !== state.seq || !bars) {
        if (token === state.seq && !bars && seeded.length <= 12) showChartState("empty");
        return;
      }
      showChartState(null);
      applySeries(bars, seeded.length <= 12);
    });
  }

  function markSelected() {
    var previous = el.body.querySelector(".wl-row.is-selected");
    if (previous) previous.classList.remove("is-selected");
    if (!state.selected) return;
    var row = el.body.querySelector(
      '.wl-row[data-cat="' + state.selected.cat + '"][data-index="' + state.selected.index + '"]'
    );
    if (row) {
      row.classList.add("is-selected");
      row.scrollIntoView({ block: "nearest" });
    }
  }

  /* ------------------------------------------------------------- watchlist */
  function filtered(cat) {
    var items = (state.data && state.data.categories[cat.key]) || [];
    var q = normalize(state.query);
    if (!q) return items.map(function (item, index) { return { item: item, index: index }; });
    var out = [];
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      if (normalize(item.s).indexOf(q) >= 0 || normalize(item.n).indexOf(q) >= 0) {
        out.push({ item: item, index: i });
      }
    }
    return out;
  }

  function rowHtml(catKey, index, item) {
    var cls = changeClass(item.ch);
    return (
      '<button type="button" class="wl-row" data-cat="' + catKey + '" data-index="' + index +
      '" data-sym="' + escapeHtml(item.s) + '" title="' + escapeHtml(item.n) + '">' +
      '<span class="sym">' + escapeHtml(item.s) + "</span>" +
      '<span class="last">' + priceText(item.p) + "</span>" +
      '<span class="chg ' + cls + '">' + signed(deltaOf(item)) + "</span>" +
      '<span class="pct ' + cls + '">' + signedPct(item.ch) + "</span>" +
      "</button>"
    );
  }

  function groupHtml(cat) {
    var list = filtered(cat);
    if (!list.length && state.query) return "";
    var isSearch = !!normalize(state.query);
    var open = isSearch || !state.collapsed.has(cat.key);
    var limit = state.limits[cat.key] || PAGE_SIZE;
    var rows = "";
    var upto = Math.min(list.length, limit);
    for (var i = 0; i < upto; i += 1) rows += rowHtml(cat.key, list[i].index, list[i].item);
    var more =
      list.length > limit
        ? '<button type="button" class="wl-more" data-cat="' + cat.key + '">نمایش بیشتر (' +
          nf.format(list.length - limit) + ")</button>"
        : "";
    return (
      '<section class="wl-group" data-key="' + cat.key + '" data-open="' + open + '">' +
      '<button type="button" class="wl-group-head" data-toggle="' + cat.key + '">' +
      '<svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>' +
      "<span>" + cat.label + "</span><b>" + nf.format(list.length) + "</b></button>" +
      '<div class="wl-rows">' + rows + "</div>" + more + "</section>"
    );
  }

  function renderWatchlist() {
    if (!state.data) return;
    var html = CATEGORIES.map(groupHtml).join("");
    el.body.innerHTML = html || "";
    var shown = 0;
    CATEGORIES.forEach(function (cat) { shown += filtered(cat).length; });
    el.count.textContent = nf.format(shown);
    el.empty.hidden = shown !== 0;
    markSelected();
  }

  /* ------------------------------------------------------------- pulse */
  function renderPulse() {
    var data = state.data;
    if (!data) return;
    var all = [];
    Object.keys(data.categories).forEach(function (k) {
      data.categories[k].forEach(function (item) { all.push(item); });
    });
    var traded = all.filter(function (i) { return i.v > 0; });
    var best = all
      .filter(function (i) { return typeof i.ch === "number" && i.ch > 0 && i.ch < 100 && i.v > 0; })
      .sort(function (a, b) { return b.ch - a.ch; })[0];
    var richest = all.slice().sort(function (a, b) { return b.val - a.val; })[0];

    var cells = [
      { label: "نمادهای بازار", value: nf.format(all.length), sub: nf.format(traded.length) + " معامله‌شده" },
      { label: "ارزش کل معاملات", value: nf1.format(hemt(data.totalValue)) + " همت", sub: "مجموع همه دسته‌ها" },
      best
        ? { label: "بیشترین رشد", value: best.s, sub: signedPct(best.ch), cls: "up" }
        : { label: "بیشترین رشد", value: "—", sub: "—" },
      richest
        ? { label: "پرگردش‌ترین", value: richest.s, sub: nf1.format(hemt(richest.val)) + " همت" }
        : { label: "پرگردش‌ترین", value: "—", sub: "—" },
    ];

    el.pulse.innerHTML = cells
      .map(function (c) {
        return (
          '<div class="pulse-cell"><span>' + c.label + '</span><b class="' + (c.cls || "") + '">' +
          escapeHtml(c.value) + "</b><small>" + escapeHtml(c.sub) + "</small></div>"
        );
      })
      .join("");
  }

  /* ------------------------------------------------------------- loading */
  function renderSkeleton() {
    var rows = "";
    for (var i = 0; i < 14; i += 1) {
      rows +=
        '<div class="wl-row"><span class="sym"><i class="sk" style="width:' +
        (38 + ((i * 13) % 40)) + '%"></i></span><span class="last"><i class="sk" style="width:80%"></i></span>' +
        '<span class="chg"><i class="sk" style="width:70%"></i></span><span class="pct"><i class="sk" style="width:60%"></i></span></div>';
    }
    el.body.innerHTML = rows;
  }

  function load() {
    el.refresh.classList.add("is-spinning");
    showChartState("loading");
    return fetch("data.json?v=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        state.data = data;
        state.limits = {};
        el.sync.classList.remove("is-error");
        el.sync.textContent = "به‌روزرسانی: " + whenText(data.updated);
        renderPulse();
        renderWatchlist();
        var keep = state.selected;
        if (keep && (data.categories[keep.cat] || [])[keep.index]) {
          selectRow(keep.cat, keep.index);
        } else {
          var first = (data.categories.stocks || [])[0];
          if (first) selectRow("stocks", 0);
          else showChartState("empty");
        }
      })
      .catch(function () {
        el.sync.classList.add("is-error");
        el.sync.textContent = "خطا در دریافت داده";
        showChartState("error");
        el.empty.hidden = false;
        el.empty.textContent = "داده‌ای دریافت نشد؛ اتصال را بررسی و دوباره تلاش کنید.";
      })
      .then(function () {
        el.refresh.classList.remove("is-spinning");
      });
  }

  /* ------------------------------------------------------------- events */
  el.body.addEventListener("click", function (event) {
    var toggle = event.target.closest("[data-toggle]");
    if (toggle) {
      var key = toggle.dataset.toggle;
      var group = toggle.closest(".wl-group");
      if (state.collapsed.has(key)) state.collapsed.delete(key);
      else state.collapsed.add(key);
      if (group) group.setAttribute("data-open", state.collapsed.has(key) ? "false" : "true");
      return;
    }
    var more = event.target.closest(".wl-more");
    if (more) {
      var cat = more.dataset.cat;
      state.limits[cat] = (state.limits[cat] || PAGE_SIZE) + PAGE_SIZE;
      renderWatchlist();
      return;
    }
    var row = event.target.closest(".wl-row");
    if (row && row.dataset.index) {
      selectRow(row.dataset.cat, Number(row.dataset.index));
    }
  });

  var searchTimer = 0;
  el.search.addEventListener("input", function (event) {
    var value = event.target.value;
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(function () {
      state.query = value;
      state.limits = {};
      renderWatchlist();
    }, 110);
  });

  document.querySelectorAll(".tf").forEach(function (btn) {
    btn.addEventListener("click", function () {
      if (btn.dataset.tf === state.tf) return;
      state.tf = btn.dataset.tf;
      document.querySelectorAll(".tf").forEach(function (b) {
        var on = b.dataset.tf === state.tf;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      if (state.series.length) applySeries(state.series, false);
    });
  });

  document.querySelectorAll(".seg-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      state.mode = btn.dataset.mode;
      document.querySelectorAll(".seg-btn").forEach(function (b) {
        var on = b.dataset.mode === state.mode;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
      chart.setMode(state.mode);
    });
  });

  el.resetView.addEventListener("click", function () { chart.resetView(true); });

  el.refresh.addEventListener("click", function () { load(); });

  el.expand.addEventListener("click", function () {
    if (!document.fullscreenElement) {
      if (el.chartPanel.requestFullscreen) el.chartPanel.requestFullscreen().catch(function () {});
    } else if (document.exitFullscreen) {
      document.exitFullscreen().catch(function () {});
    }
  });

  document.addEventListener("fullscreenchange", function () {
    window.setTimeout(function () { chart.resize(); }, 60);
  });

  function openWatchlist() {
    el.watchlist.classList.add("is-open");
    el.scrim.hidden = false;
    window.requestAnimationFrame(function () { el.scrim.classList.add("is-open"); });
  }
  function closeWatchlist() {
    el.watchlist.classList.remove("is-open");
    el.scrim.classList.remove("is-open");
    window.setTimeout(function () {
      if (!el.watchlist.classList.contains("is-open")) el.scrim.hidden = true;
    }, 220);
  }

  el.wlToggle.addEventListener("click", openWatchlist);
  el.wlClose.addEventListener("click", closeWatchlist);
  el.scrim.addEventListener("click", closeWatchlist);
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") closeWatchlist();
  });

  /* ------------------------------------------------------------- boot */
  renderSkeleton();
  load();

  // Small debug handle (handy in devtools and for the smoke test).
  window.Zarquant = { state: state, chart: chart, select: selectRow, reload: load };
})();
