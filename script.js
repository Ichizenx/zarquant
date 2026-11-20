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
    drawMode: null,
    drawings: [],
    favorites: {},
    sort: { key: null, dir: "asc" },
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
    drawToolbar: $("#drawToolbar"),
    drawCanvas: $("#drawCanvas"),
    dMenu: $("#dMenu"),
    dTrendline: $("#dTrendline"),
    wlCols: $(".wl-cols"),
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
    pointerBlocked: function () { return state.drawMode !== null && state.drawMode !== "crosshair"; },
    onResize: function (W, H, dpr) {
      var c = el.drawCanvas;
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      var ctx = c.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderDrawings();
    },
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
    if (typeof window.ZarquantDrawing !== "undefined") {
      window.ZarquantDrawing.series(state.series);
    }
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
    state.drawings = [];
    chart.setDrawings([]);

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
    var out = [];
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      if (!q || normalize(item.s).indexOf(q) >= 0 || normalize(item.n).indexOf(q) >= 0) {
        out.push({ item: item, index: i });
      }
    }
    if (state.sort.key) {
      var asc = state.sort.dir === "asc";
      out.sort(function (a, b) {
        var av = state.sort.key === "ch" ? (a.item.ch || 0) : normalize(a.item.s);
        var bv = state.sort.key === "ch" ? (b.item.ch || 0) : normalize(b.item.s);
        if (av < bv) return asc ? -1 : 1;
        if (av > bv) return asc ? 1 : -1;
        return 0;
      });
    }
    return out;
  }

  function rowHtml(catKey, index, item) {
    var cls = changeClass(item.ch);
    var closeCls = changeClass(item.c - item.p);
    return (
      '<button type="button" class="wl-row" data-cat="' + catKey + '" data-index="' + index +
      '" data-sym="' + escapeHtml(item.s) + '" title="' + escapeHtml(item.n) + '">' +
      '<span class="sym">' + escapeHtml(item.s) + "</span>" +
      '<span class="last">' + priceText(item.p) + "</span>" +
<<<<<<< HEAD
      '<span class="close">' + priceText(item.c) + "</span>" +
      '<span class="vol">' + window.ZChart.fmtVolume(item.v) + "</span>" +
=======
      '<span class="close ' + closeCls + '">' + priceText(item.c) + "</span>" +
      '<span class="volume">' + window.ZChart.fmtVolume(item.v) + "</span>" +
>>>>>>> ad7232b74f7cc527c0a7f987082018e73d3398f4
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
<<<<<<< HEAD
    renderSortArrows();
  }

  function renderSortArrows() {
    document.querySelectorAll(".wl-col-sort").forEach(function (btn) {
      var active = state.sort.key === btn.dataset.key;
      btn.setAttribute("aria-sort", active ? state.sort.dir : "none");
      var arrow = btn.querySelector(".wl-sort-arrow");
      if (arrow) arrow.textContent = active ? (state.sort.dir === "asc" ? "▲" : "▼") : "";
    });
  }

  /* ------------------------------------------------------------- drawing toolbar */
  function setDrawMode(mode) {
    cancelDrag();
    state.drawMode = mode;
    document.querySelectorAll(".d-btn").forEach(function (b) {
      var on = b.dataset.mode === mode;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    closeDrawMenu();
    el.drawCanvas.style.pointerEvents = mode && mode !== "crosshair" ? "auto" : "none";
  }
  function openDrawMenu() {
    var rect = el.dTrendline.getBoundingClientRect();
    var m = el.dMenu;
    m.style.left = Math.floor(rect.right + 6) + "px";
    m.style.top = Math.floor(rect.top) + "px";
    m.hidden = false;
    renderDrawMenu();
  }
  function closeDrawMenu() { el.dMenu.hidden = true; }
  function renderDrawMenu() {
    var items = [
      { mode: "trendline", label: "خط روند" },
      { mode: "trendangle", label: "زاویه خط روند" },
      { mode: "horizline", label: "خط افقی" },
      { mode: "horizray", label: "شعاع افقی" },
      { mode: "vertline", label: "خط عمودی" },
      { mode: "arrow", label: "فلش" },
      { mode: "ray", label: "شعاع" },
      { mode: "extendedline", label: "خط پیموده" },
      { mode: "parallelchannel", label: "کانال مساوی" },
      { mode: "flattopbottom", label: "سقف/کف مسطح" },
    ];
    el.dMenu.innerHTML = items.map(function (it) {
      var on = state.drawMode === it.mode;
      var star = state.favorites[it.mode] ? "★" : "☆";
      return (
        '<button type="button" class="d-menu-item' + (on ? " is-active" : "") +
        '" data-mode="' + it.mode + '"><span>' + escapeHtml(it.label) +
        '</span><span class="d-star" data-fav="' + escapeHtml(it.mode) + '">' + star + "</span></button>"
      );
    }).join("");
  }

  function overlayPoint(evt) {
    var rect = el.drawCanvas.getBoundingClientRect();
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }
  function chartCoordOf(pt) {
    return { i: chart.coordinateToIndex(pt.x), price: chart.coordinateToPrice(pt.y) };
  }
  function addDrawing(d) {
    d.id = Date.now() + Math.random();
    d.color = d.color || "#2962ff";
    state.drawings.push(d);
    renderDrawings();
  }
  function renderDrawings() {
    var c = el.drawCanvas;
    var ctx = c.getContext("2d");
    var W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    if (!state.series.length) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (var k = 0; k < state.drawings.length; k += 1) {
      var d = state.drawings[k];
      if (!isFinite(d.i1) || !isFinite(d.i2)) continue;
      var x1 = chart.indexToCoordinate(d.i1);
      var y1 = chart.priceToCoordinate(d.p1);
      var x2 = chart.indexToCoordinate(d.i2);
      var y2 = chart.priceToCoordinate(d.p2);
      if (!isFinite(x1) || !isFinite(y1) || !isFinite(x2) || !isFinite(y2)) continue;
      ctx.strokeStyle = d.color || "#2962ff";
      ctx.lineWidth = 1.5;
      ctx.setLineDash(d.dash || []);
      ctx.beginPath();
      if (d.type === "horizline") {
        ctx.moveTo(0, y1);
        ctx.lineTo(W, y1);
      } else if (d.type === "vertline") {
        ctx.moveTo(x1, 0);
        ctx.lineTo(x1, H);
      } else {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();
    }
    if (state.drag && state.drawMode === "trendline" && state.series.length && isFinite(state.drag.endI)) {
      var x1 = chart.indexToCoordinate(state.drag.startI);
      var y1 = chart.priceToCoordinate(state.drag.startP);
      var x2 = chart.indexToCoordinate(state.drag.endI);
      var y2 = chart.priceToCoordinate(state.drag.endP);
      if (isFinite(x1) && isFinite(y1) && isFinite(x2) && isFinite(y2)) {
        ctx.strokeStyle = "#2962ff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  function commitTempDrawing() {
    if (!state.drag || state.series.length === 0) return;
    var s = chartCoordOf(state.drag.start);
    var c = chartCoordOf(state.drag.current);
    if (isFinite(s.price) && isFinite(c.price)) {
      state.drag.endI = c.i;
      state.drag.endP = c.price;
    }
    renderDrawings();
  }
  function finalizeDrag() {
    if (!state.drag) return;
    var c = chartCoordOf(state.drag.current);
    if (isFinite(c.price)) {
      state.drawings.push({
        type: "trendline",
        i1: state.drag.startI, p1: state.drag.startP,
        i2: c.i, p2: c.price, color: "#2962ff"
      });
    }
    renderDrawings();
    state.drag = null;
  }
  function cancelDrag() {
    if (!state.drag) return;
    state.drag = null;
    renderDrawings();
=======
    refreshWatchlistResizers();
>>>>>>> ad7232b74f7cc527c0a7f987082018e73d3398f4
  }

  /* ------------------------------------------------------------- watchlist column resizers */
  var wlColWidths = { last: 76, close: 70, volume: 64, pct: 60 }; // px; symbol takes the rest
  var wlResizers = [];

  function createWatchlistResizers() {
    var body = el.body;
    if (body.querySelector(".wl-resizer")) return;
    wlResizers = [];
    for (var i = 0; i < 4; i += 1) {
      var r = document.createElement("div");
      r.className = "wl-resizer";
      r.dataset.col = i;
      body.appendChild(r);
      wlResizers.push(r);
    }
  }

  function watchlistGridCss() {
    // symbol column takes the remaining space; fixed columns follow.
    var sym = "1fr";
    return sym + " " + wlColWidths.last + "px " + wlColWidths.close + "px " +
      wlColWidths.volume + "px " + wlColWidths.pct + "px";
  }

  function applyWatchlistGrid() {
    var css = watchlistGridCss();
    el.watchlist.style.setProperty("--wl-cols", css);
    var rows = el.body.querySelectorAll(".wl-row, .wl-cols");
    for (var i = 0; i < rows.length; i += 1) {
      rows[i].style.setProperty("grid-template-columns", css);
    }
    placeWatchlistResizers();
  }

  function placeWatchlistResizers() {
    if (wlResizers.length === 0) return;
    var header = document.querySelector(".wl-cols");
    if (!header) return;
    var hRect = header.getBoundingClientRect();
    var bRect = el.body.getBoundingClientRect();
    var offsetX = hRect.left - bRect.left;
    var cells = header.children;
    var acc = 0;
    var boundaries = [];
    for (var i = 0; i < cells.length; i += 1) {
      var cell = cells[i];
      if (i === cells.length - 1) break;
      acc += cell.getBoundingClientRect().width + 4; // + gap
      boundaries.push(acc);
    }
    wlResizers.forEach(function (r, i) {
      var x = boundaries[i];
      if (x == null) return;
      r.style.left = Math.round(x - offsetX) + "px";
      r.style.top = "0";
      r.style.bottom = "0";
      r.style.width = "6px";
      r.style.position = "absolute";
      r.style.cursor = "col-resize";
      r.style.zIndex = "5";
      r.style.background = "rgba(41, 98, 255, 0.35)";
      r.style.opacity = "0.6";
    });
  }

  function refreshWatchlistResizers() {
    createWatchlistResizers();
    applyWatchlistGrid();
  }

  // Drag a watchlist column resizer
  el.body.addEventListener("mousedown", function (evt) {
    var r = evt.target.closest(".wl-resizer");
    if (!r) return;
    var col = Number(r.dataset.col);
    var keys = ["last", "close", "volume", "pct"];
    var key = keys[col];
    var rect = el.body.getBoundingClientRect();
    var startX = evt.clientX - rect.left;
    var startWidth = wlColWidths[key];
    var dragging = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(e) {
      if (!dragging) return;
      var dx = (e.clientX - rect.left) - startX;
      var next = clamp(startWidth + dx, 40, 200);
      wlColWidths[key] = next;
      applyWatchlistGrid();
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    evt.preventDefault();
  });

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

  /* ------------------------------------------------------------- drawing toolbar events */
  el.drawToolbar.addEventListener("click", function (event) {
    var btn = event.target.closest(".d-btn");
    if (!btn) return;
    if (btn.id === "dTrendline") {
      event.stopPropagation();
      if (!el.dMenu.hidden) { closeDrawMenu(); return; }
      setDrawMode("trendline");
      openDrawMenu();
      return;
    }
    closeDrawMenu();
    setDrawMode(btn.dataset.mode);
  });

  el.dMenu.addEventListener("click", function (event) {
    var item = event.target.closest(".d-menu-item");
    if (item) {
      setDrawMode(item.dataset.mode);
      return;
    }
    var star = event.target.closest(".d-star");
    if (star) {
      event.stopPropagation();
      var key = star.dataset.fav;
      state.favorites[key] = !state.favorites[key];
      renderDrawMenu();
      return;
    }
    closeDrawMenu();
  });

  document.addEventListener("click", function (event) {
    if (!el.dMenu.hidden && !el.drawToolbar.contains(event.target) && !el.dMenu.contains(event.target)) {
      closeDrawMenu();
    }
  });

  el.drawCanvas.addEventListener("mousedown", function (event) {
    if (state.drawMode === null || state.drawMode === "crosshair") return;
    if (state.series.length === 0) return;
    var pt = overlayPoint(event);
    if (state.drawMode === "trendline") {
      var s = chartCoordOf(pt);
      if (!isFinite(s.price)) return;
      state.drag = { start: pt, current: pt, startI: s.i, startP: s.price };
      commitTempDrawing();
      return;
    }
    if (state.drawMode === "horizline") {
      var price = chart.coordinateToPrice(pt.y);
      if (!isFinite(price)) return;
      addDrawing({ type: "horizline", i1: 0, i2: 0, p1: price, p2: price });
      return;
    }
    if (state.drawMode === "vertline") {
      var i = chart.coordinateToIndex(pt.x);
      addDrawing({ type: "vertline", i1: i, i2: i, p1: 0, p2: 0 });
      return;
    }
  });

  el.drawCanvas.addEventListener("mousemove", function (event) {
    if (!state.drag) return;
    state.drag.current = overlayPoint(event);
    commitTempDrawing();
  });
  el.drawCanvas.addEventListener("mouseleave", cancelDrag);
  window.addEventListener("mouseup", finalizeDrag);

  el.wlCols.addEventListener("click", function (event) {
    var btn = event.target.closest(".wl-col-sort");
    if (!btn) return;
    var key = btn.dataset.key;
    if (state.sort.key === key) {
      state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
    } else {
      state.sort.key = key;
      state.sort.dir = "asc";
    }
    renderSortArrows();
    renderWatchlist();
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

  /* ============================================================================
     Chart pane resizer — drag the handle between the price pane and volume pane
     to change their height ratio.
     ============================================================================ */
  (function initChartResizer() {
    var handle = $("#chartResizer");
    var chartCanvas = $("#chartCanvas");
    if (!handle || !chartCanvas || !chart) return;

    var dragging = false;

    function placeHandle() {
      var rect = chartCanvas.getBoundingClientRect();
      var r = chart.getPriceRatio ? chart.getPriceRatio() : 0.78;
      var plotH = rect.bottom - rect.top;
      handle.style.top = (rect.top + Math.round(r * plotH) - 4) + "px";
      handle.style.left = rect.left + "px";
      handle.style.width = Math.round(rect.width) + "px";
    }

    function updateFromY(y) {
      var rect = chartCanvas.getBoundingClientRect();
      var plotH = rect.bottom - rect.top;
      if (plotH <= 0) return;
      var ratio = (y - rect.top) / plotH;
      chart.setPriceRatio(ratio);
      placeHandle();
    }

    handle.addEventListener("mousedown", function (evt) {
      dragging = true;
      handle.classList.add("is-dragging");
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
      placeHandle();
      evt.preventDefault();
    });

    document.addEventListener("mousemove", function (evt) {
      if (!dragging) return;
      updateFromY(evt.clientY);
    });

    document.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove("is-dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });

    if (window.ResizeObserver) {
      new ResizeObserver(placeHandle).observe(chartCanvas);
    }
    placeHandle();
  })();

  /* ============================================================================
     Drawing toolbar + canvas overlay
     ============================================================================ */
  (function initDrawing() {
    var drawCanvas = $("#drawCanvas");
    var ctx = drawCanvas.getContext("2d");
    var chartCanvas = $("#chartCanvas");

    var state = {
      tool: "crosshair",
      active: false,
      start: { x: 0, y: 0 },
      current: { x: 0, y: 0 },
      drawings: [], // { type, x1, y1, x2, y2, px1, px2, ... }
    };

    // Resize the overlay canvas to match the chart container
    function resizeDrawCanvas() {
      var rect = chartCanvas.getBoundingClientRect();
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      drawCanvas.width = Math.round(rect.width * dpr);
      drawCanvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    }

    // Map screen coordinates -> chart price/time coordinates
    function screenToChart(x, y) {
      // Use ZChart internals via the public API surface where possible.
      // We fall back to reading the canvas layout from the DOM.
      var barCanvas = $("#candles");
      var bRect = barCanvas.getBoundingClientRect();
      var cx = x - bRect.left;
      var cy = y - bRect.top;

      var bars = state.series || [];
      if (!bars.length) return null;

      // Recompute the same layout chart.js uses (PAD constants)
      var PAD = { top: 12, right: 62, bottom: 24, left: 8 };
      var W = Math.max(120, Math.round(bRect.width));
      var H = Math.max(120, Math.round(bRect.height));
      var layoutLeft = PAD.left;
      var layoutRight = W - PAD.right;
      var layoutTop = PAD.top;
      var layoutBottom = H - PAD.bottom;
      var priceBottom = layoutTop + Math.round((layoutBottom - layoutTop) * 0.78);

      // Clamp to plot area
      cx = clamp(cx, layoutLeft, layoutRight);
      cy = clamp(cy, layoutTop, layoutBottom);

      // Determine visible bar range from chart state — mirror of chart.js view
      var span = 60; // default, but we need actual from chart
      // Use the chart's visible range by approximating from x position
      var first = Math.max(0, bars.length - span);
      var barW = (layoutRight - layoutLeft) / Math.max(1, span);
      var index = Math.round(first + (cx - layoutLeft) / barW - 0.5);
      index = clamp(index, 0, bars.length - 1);

      // Price from y coordinate — need price range
      // Approximate range from visible bars
      var visible = bars.slice(first, Math.min(bars.length, first + span));
      var lo = Math.min.apply(null, visible.map(function (b) { return b.l; }));
      var hi = Math.max.apply(null, visible.map(function (b) { return b.h; }));
      var pad = (hi - lo) * 0.08;
      lo -= pad; hi += pad;

      var price = hi - (cy - layoutTop) / (priceBottom - layoutTop) * (hi - lo);

      return { x: cx, y: cy, index: index, price: price, time: bars[index] ? bars[index].t : null };
    }

    function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

    function redraw() {
      ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
      ctx.save();
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#2962ff";
      ctx.fillStyle = "#2962ff";

      state.drawings.forEach(function (d) {
        ctx.beginPath();
        if (d.type === "line" || d.type === "trendline") {
          ctx.moveTo(d.x1, d.y1);
          ctx.lineTo(d.x2, d.y2);
        } else if (d.type === "horizline") {
          ctx.moveTo(0, d.y);
          ctx.lineTo(drawCanvas.width / (Math.min(2, window.devicePixelRatio || 1)), d.y);
        } else if (d.type === "vertline") {
          ctx.moveTo(d.x, 0);
          ctx.lineTo(d.x, drawCanvas.height / (Math.min(2, window.devicePixelRatio || 1)));
        }
        ctx.stroke();
      });

      // Draw in-progress line
      if (state.active && (state.tool === "line" || state.tool === "trendline")) {
        ctx.beginPath();
        ctx.moveTo(state.start.x, state.start.y);
        ctx.lineTo(state.current.x, state.current.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    function addDrawing(type, p1, p2) {
      state.drawings.push({ type: type, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
      redraw();
    }

    // Distance from point (x,y) to line segment (x1,y1)-(x2,y2)
    function distToSegment(x, y, x1, y1, x2, y2) {
      var dx = x2 - x1;
      var dy = y2 - y1;
      var len2 = dx * dx + dy * dy;
      var t = 0;
      if (len2 > 0) {
        t = ((x - x1) * dx + (y - y1) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
      }
      var px = x1 + t * dx;
      var py = y1 + t * dy;
      return Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
    }

    // Remove the drawing nearest to (x,y) if it's within the hit threshold.
    function deleteHit(x, y) {
      var hit = -1;
      var best = 10; // px tolerance
      state.drawings.forEach(function (d, i) {
        var d1;
        if (d.type === "line" || d.type === "trendline") {
          d1 = distToSegment(x, y, d.x1, d.y1, d.x2, d.y2);
        } else if (d.type === "horizline") {
          d1 = Math.abs(y - d.y);
          // only count if x is within the drawn horizontal span (full width)
          if (d1 > best) d1 = Infinity;
        } else if (d.type === "vertline") {
          d1 = Math.abs(x - d.x);
          if (d1 > best) d1 = Infinity;
        } else {
          d1 = Infinity;
        }
        if (d1 < best) { best = d1; hit = i; }
      });
      if (hit >= 0) {
        state.drawings.splice(hit, 1);
        redraw();
        return true;
      }
      return false;
    }

    // Mouse events on the overlay canvas
    drawCanvas.addEventListener("mousedown", function (evt) {
      if (state.tool === "crosshair") return;
      var rect = drawCanvas.getBoundingClientRect();
      var x = evt.clientX - rect.left;
      var y = evt.clientY - rect.top;

      // Delete / Eraser tool: click on a drawn line to remove it
      if (state.tool === "delete") {
        deleteHit(x, y);
        return;
      }

      state.active = true;
      state.start = { x: x, y: y };
      state.current = { x: x, y: y };

      if (state.tool === "horizline") {
        addDrawing("horizline", { x: 0, y: y }, { x: 0, y: y });
        state.active = false;
      } else if (state.tool === "vertline") {
        addDrawing("vertline", { x: x, y: 0 }, { x: x, y: 0 });
        state.active = false;
      }
    });

    drawCanvas.addEventListener("mousemove", function (evt) {
      if (!state.active) return;
      var rect = drawCanvas.getBoundingClientRect();
      state.current = {
        x: evt.clientX - rect.left,
        y: evt.clientY - rect.top
      };
      if (state.tool === "line" || state.tool === "trendline") {
        redraw();
      }
    });

    drawCanvas.addEventListener("mouseup", function () {
      if (!state.active) return;
      if (state.tool === "line" || state.tool === "trendline") {
        addDrawing("line", state.start, state.current);
      }
      state.active = false;
    });

    drawCanvas.addEventListener("mouseleave", function () {
      state.active = false;
    });

    // Expose for toolbar
    window.ZarquantDrawing = {
      setTool: function (tool) {
        state.tool = tool;
        // Only capture pointer events on the overlay while a real drawing tool
        // is active; in crosshair mode let events pass through to the chart
        // canvas so crosshair / pan / zoom / hover keep working.
        drawCanvas.style.pointerEvents = tool !== "crosshair" ? "auto" : "none";
        redraw();
      },
      getTool: function () { return state.tool; },
      resize: resizeDrawCanvas,
      series: function (s) { state.series = s; },
      deleteHit: function (x, y) { return deleteHit(x, y); },
    };

    // Wire up resize
    if (window.ResizeObserver) {
      new ResizeObserver(resizeDrawCanvas).observe(chartCanvas);
    } else {
      window.addEventListener("resize", resizeDrawCanvas);
    }
    resizeDrawCanvas();
  })();

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

  /* ============================================================================
     Toolbar button handlers
     ============================================================================ */
  var toolbarBtns = document.querySelectorAll(".tb-btn");
  var trendlineBtn = document.querySelector('[data-tool="trendline"]');
  var dropdownMenu = $("#trendlineMenu");
  var activeToolBtn = document.querySelector(".tb-btn.is-active");

  toolbarBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var tool = btn.dataset.tool;

      // Trend line opens the dropdown instead of directly selecting
      if (tool === "trendline") {
        var isOpen = !dropdownMenu.classList.contains("hidden");
        if (isOpen) {
          dropdownMenu.classList.add("hidden");
        } else {
          // Position dropdown next to the button
          var rect = btn.getBoundingClientRect();
          dropdownMenu.style.top = (rect.bottom + 4) + "px";
          dropdownMenu.style.left = (rect.left - 10) + "px";
          dropdownMenu.classList.remove("hidden");
        }
        return;
      }

      // Close dropdown if open
      dropdownMenu.classList.add("hidden");

      // Update active state
      toolbarBtns.forEach(function (b) {
        b.classList.remove("is-active");
        b.setAttribute("aria-pressed", "false");
      });
      btn.classList.add("is-active");
      btn.setAttribute("aria-pressed", "true");

      if (typeof window.ZarquantDrawing !== "undefined") {
        window.ZarquantDrawing.setTool(tool);
      }
    });
  });

  // Dropdown item selection
  dropdownMenu.addEventListener("click", function (event) {
    var item = event.target.closest(".dropdown-item");
    if (!item) return;
    var drawType = item.dataset.draw;

    dropdownMenu.classList.add("hidden");

    // Update active button to trendline (parent) and set drawing sub-tool
    toolbarBtns.forEach(function (b) {
      b.classList.remove("is-active");
      b.setAttribute("aria-pressed", "false");
    });
    trendlineBtn.classList.add("is-active");
    trendlineBtn.setAttribute("aria-pressed", "true");

    if (typeof window.ZarquantDrawing !== "undefined") {
      window.ZarquantDrawing.setTool(drawType);
    }
  });

  // Close dropdown when clicking outside
  document.addEventListener("click", function (event) {
    if (!trendlineBtn.contains(event.target) && !dropdownMenu.contains(event.target)) {
      dropdownMenu.classList.add("hidden");
    }
  });

  /* ============================================================================
     Watchlist column sorting
     ============================================================================ */
  var sortCols = document.querySelectorAll(".sort-col");
  var sortState = {}; // column -> "asc" | "desc"

  sortCols.forEach(function (col) {
    col.addEventListener("click", function () {
      var key = col.dataset.sort;
      var dir = sortState[key] === "asc" ? "desc" : "asc";
      sortState = {}; // clear others
      sortState[key] = dir;

      // Update arrows
      sortCols.forEach(function (c) {
        var arrow = c.querySelector(".sort-arrow");
        if (c.dataset.sort === key) {
          arrow.className = "sort-arrow " + (dir === "asc" ? "asc" : "desc");
        } else {
          arrow.className = "sort-arrow";
        }
      });

      applyWatchlistSort(key, dir);
    });
  });

  function applyWatchlistSort(key, dir) {
    if (!state.data) return;
    var multiplier = dir === "asc" ? 1 : -1;

    Object.keys(state.data.categories).forEach(function (catKey) {
      var group = state.data.categories[catKey];
      if (!Array.isArray(group)) return;
      group.sort(function (a, b) {
        var av, bv;
        switch (key) {
          case "symbol": av = (a.s || "").toLowerCase(); bv = (b.s || "").toLowerCase(); break;
          case "last": av = a.p || 0; bv = b.p || 0; break;
          case "close": av = a.c || 0; bv = b.c || 0; break;
          case "volume": av = a.v || 0; bv = b.v || 0; break;
          case "change": av = a.ch || 0; bv = b.ch || 0; break;
          default: av = 0; bv = 0;
        }
        if (av < bv) return -1 * multiplier;
        if (av > bv) return 1 * multiplier;
        return 0;
      });
    });

    // Re-render and keep current selection
    var keep = state.selected;
    renderWatchlist();
    if (keep && (state.data.categories[keep.cat] || [])[keep.index]) {
      selectRow(keep.cat, keep.index);
    }
  }

  /* ------------------------------------------------------------- boot */
  renderSkeleton();
  load();

  // Small debug handle (handy in devtools and for the smoke test).
  window.Zarquant = { state: state, chart: chart, select: selectRow, reload: load };
})();
