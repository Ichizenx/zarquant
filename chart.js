/* ============================================================================
   Zarquant chart — flat canvas candlestick / line / area renderer.
   No dependencies, no 3D, no gradients: hairlines, solid fills and damped
   animations for a smooth TradingView-like feel.
   ========================================================================== */
(function (global) {
  "use strict";

  var PAD = { top: 12, right: 62, bottom: 24, left: 8 };
  var COLORS = {
    bg: "#131722",
    grid: "rgba(42, 46, 57, 0.75)",
    gridSoft: "rgba(42, 46, 57, 0.4)",
    axisText: "#787b86",
    text: "#d1d4dc",
    muted: "#787b86",
    up: "#089981",
    down: "#f23645",
    flat: "#787b86",
    line: "#2962ff",
    cross: "#4a4d57",
    badge: "#363a45",
    watermark: "rgba(209, 212, 220, 0.045)",
  };

  var PRICE_FMT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
  var TIME_FMT = new Intl.DateTimeFormat("fa-IR", { month: "2-digit", day: "2-digit" });
  var TIME_FMT_LONG = new Intl.DateTimeFormat("fa-IR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }
  function fmtPrice(v) {
    if (!isFinite(v)) return "—";
    if (v >= 1000) return PRICE_FMT.format(Math.round(v));
    if (v >= 10) return PRICE_FMT.format(Math.round(v * 10) / 10);
    return PRICE_FMT.format(Math.round(v * 100) / 100);
  }
  function fmtVolume(v) {
    if (!isFinite(v) || v <= 0) return "0";
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return String(Math.round(v));
  }
  function niceStep(range, target) {
    if (!(range > 0)) return 1;
    var raw = range / Math.max(1, target);
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 2.5) step = 2.5;
    else if (norm <= 5) step = 5;
    else step = 10;
    return step * mag;
  }

  function mount(canvas, options) {
    var opts = options || {};
    var ctx = canvas.getContext("2d");
    var host = canvas.parentElement;

    var bars = [];
    var mode = "candles";
    var watermark = "";
    var livePrice = null;
    var hover = { on: false, x: 0, y: 0, index: -1 };
    var dpr = 1;
    var W = 0;
    var H = 0;

    var view = { end: 0, span: 60, tEnd: 0, tSpan: 60 };
    var range = { lo: 0, hi: 1, tLo: 0, tHi: 1, ready: false };

    var reveal = { t0: 0, active: false, key: 0 };
    var dirty = true;
    var raf = 0;
    var dragging = null;
    var pinch = null;

    var layout = { left: 0, right: 0, top: 0, bottom: 0, priceBottom: 0, volTop: 0, barW: 8 };

    /* ------------------------------------------------------------- sizing */
    function resize() {
      var rect = host.getBoundingClientRect();
      W = Math.max(120, Math.round(rect.width));
      H = Math.max(120, Math.round(rect.height));
      dpr = Math.min(2.5, global.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      layout.left = PAD.left;
      layout.right = W - PAD.right;
      layout.top = PAD.top;
      layout.bottom = H - PAD.bottom;
      var plotH = layout.bottom - layout.top;
      layout.priceBottom = layout.top + Math.round(plotH * 0.78);
      layout.volTop = layout.priceBottom + 8;
      dirty = true;
    }

    function defaultSpan() {
      var plotW = Math.max(80, layout.right - layout.left);
      return clamp(Math.round(plotW / 9), 24, 180);
    }

    /* ------------------------------------------------------------- series */
    function setSeries(next, settings) {
      settings = settings || {};
      bars = Array.isArray(next) ? next : [];
      var len = bars.length;
      view.span = view.tSpan = len ? clamp(defaultSpan(), 8, Math.max(8, len)) : 60;
      view.end = view.tEnd = Math.max(0, len - 1);
      range.ready = false;
      if (settings.animate !== false && len) startReveal();
      else reveal.active = false;
      dirty = true;
      tick();
    }

    function startReveal() {
      if (global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        reveal.active = false;
        dirty = true;
        return;
      }
      reveal.active = true;
      reveal.t0 = performance.now();
      reveal.key += 1;
      dirty = true;
    }

    function setLivePrice(price) {
      var next = typeof price === "number" && isFinite(price) && price > 0 ? price : null;
      if (next === livePrice) return;
      livePrice = next;
      dirty = true;
      tick();
    }

    function setMode(next) {
      mode = next;
      startReveal();
      dirty = true;
    }

    function setWatermark(text) {
      watermark = text || "";
      dirty = true;
    }

    function resetView(animate) {
      if (!bars.length) return;
      view.tSpan = clamp(defaultSpan(), 8, Math.max(8, bars.length));
      view.tEnd = bars.length - 1;
      if (!animate) {
        view.span = view.tSpan;
        view.end = view.tEnd;
      }
      startReveal();
      dirty = true;
      tick();
    }

    /* ------------------------------------------------------------- helpers */
    function barW() {
      return (layout.right - layout.left) / Math.max(1, view.span);
    }

    function xOf(i) {
      var first = view.end - view.span + 1;
      return layout.left + (i - first + 0.5) * barW();
    }

    function visibleBounds() {
      var first = view.end - view.span + 1;
      return {
        i0: Math.max(0, Math.floor(first)),
        i1: Math.min(bars.length - 1, Math.ceil(view.end)),
      };
    }

    function computeRange() {
      var b = visibleBounds();
      var lo = Infinity;
      var hi = -Infinity;
      for (var i = b.i0; i <= b.i1; i += 1) {
        var bar = bars[i];
        if (!bar) continue;
        if (bar.h > hi) hi = bar.h;
        if (bar.l < lo) lo = bar.l;
      }
      if (!isFinite(lo) || !isFinite(hi)) {
        lo = 0;
        hi = 1;
      }
      if (hi === lo) {
        hi = lo + Math.max(Math.abs(lo) * 0.01, 1);
        lo = lo - Math.max(Math.abs(lo) * 0.01, 1);
      }
      var pad = (hi - lo) * 0.08;
      return { lo: lo - pad, hi: hi + pad };
    }

    function maxVolume() {
      var b = visibleBounds();
      var max = 0;
      for (var i = b.i0; i <= b.i1; i += 1) {
        var bar = bars[i];
        if (bar && bar.v > max) max = bar.v;
      }
      return max || 1;
    }

    function yOf(price) {
      var span = range.hi - range.lo || 1;
      return layout.top + (range.hi - price) / span * (layout.priceBottom - layout.top);
    }

    function timeLabel(index, long) {
      var bar = bars[index];
      if (!bar) return "";
      var date = bar.t instanceof Date ? bar.t : new Date(bar.t);
      return (long ? TIME_FMT_LONG : TIME_FMT).format(date);
    }

    /* ------------------------------------------------------------- drawing */
    function drawGrid() {
      ctx.save();
      ctx.lineWidth = 1;
      ctx.font = '11px "Vazirmatn", "Segoe UI", Tahoma, sans-serif';
      var step = niceStep(range.hi - range.lo, 6);
      var start = Math.ceil(range.lo / step) * step;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      for (var p = start; p <= range.hi; p += step) {
        var y = Math.round(yOf(p)) + 0.5;
        ctx.strokeStyle = COLORS.grid;
        ctx.beginPath();
        ctx.moveTo(layout.left, y);
        ctx.lineTo(layout.right, y);
        ctx.stroke();
        ctx.fillStyle = COLORS.axisText;
        ctx.fillText(fmtPrice(p), W - 8, y);
      }

      // vertical grid + time labels, spaced so labels never collide
      var bw = barW();
      var stepBars = Math.max(1, Math.ceil(76 / bw));
      var b = visibleBounds();
      var first = view.end - view.span + 1;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (var i = b.i0; i <= b.i1; i += 1) {
        if ((i - Math.round(first)) % stepBars !== 0) continue;
        var x = Math.round(xOf(i)) + 0.5;
        ctx.strokeStyle = COLORS.gridSoft;
        ctx.beginPath();
        ctx.moveTo(x, layout.top);
        ctx.lineTo(x, layout.bottom);
        ctx.stroke();
        ctx.fillStyle = COLORS.axisText;
        ctx.fillText(timeLabel(i, false), x, H - 10);
      }
      ctx.restore();
    }

    function drawWatermark() {
      if (!watermark) return;
      ctx.save();
      ctx.fillStyle = COLORS.watermark;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      var size = Math.min(64, Math.max(28, (layout.right - layout.left) / 9));
      ctx.font = "700 " + size + 'px "Vazirmatn", "Segoe UI", sans-serif';
      ctx.fillText(watermark, (layout.left + layout.right) / 2, (layout.top + layout.priceBottom) / 2);
      ctx.restore();
    }

    function drawCandles(clipW) {
      var b = visibleBounds();
      var bw = barW();
      var bodyW = Math.max(1, Math.min(22, bw * 0.64));
      var wickW = Math.max(1, Math.round(bodyW / 8));
      ctx.save();
      if (clipW < 1) {
        ctx.beginPath();
        ctx.rect(layout.left, layout.top - 2, (layout.right - layout.left) * clipW, layout.bottom - layout.top + 4);
        ctx.clip();
      }
      for (var i = b.i0; i <= b.i1; i += 1) {
        var bar = bars[i];
        if (!bar) continue;
        var x = xOf(i);
        var up = bar.c >= bar.o;
        var color = bar.c === bar.o ? COLORS.flat : up ? COLORS.up : COLORS.down;
        var yH = yOf(bar.h);
        var yL = yOf(bar.l);
        var yO = yOf(bar.o);
        var yC = yOf(bar.c);
        var top = Math.min(yO, yC);
        var height = Math.max(1, Math.abs(yC - yO));
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(x - wickW / 2), Math.round(yH), wickW, Math.max(1, Math.round(yL - yH)));
        ctx.fillRect(Math.round(x - bodyW / 2), Math.round(top), Math.round(bodyW), Math.round(height));
      }
      ctx.restore();
    }

    function drawLine(clipW, area) {
      var b = visibleBounds();
      if (b.i1 < b.i0) return;
      ctx.save();
      if (clipW < 1) {
        ctx.beginPath();
        ctx.rect(layout.left, layout.top - 2, (layout.right - layout.left) * clipW, layout.bottom - layout.top + 4);
        ctx.clip();
      }
      var points = [];
      for (var i = b.i0; i <= b.i1; i += 1) {
        var bar = bars[i];
        if (!bar) continue;
        points.push([xOf(i), yOf(bar.c)]);
      }
      if (points.length > 1) {
        if (area) {
          ctx.beginPath();
          ctx.moveTo(points[0][0], layout.priceBottom);
          for (var p = 0; p < points.length; p += 1) ctx.lineTo(points[p][0], points[p][1]);
          ctx.lineTo(points[points.length - 1][0], layout.priceBottom);
          ctx.closePath();
          ctx.fillStyle = "rgba(41, 98, 255, 0.12)";
          ctx.fill();
        }
        ctx.beginPath();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = COLORS.line;
        ctx.lineJoin = "round";
        for (var q = 0; q < points.length; q += 1) {
          if (q === 0) ctx.moveTo(points[q][0], points[q][1]);
          else ctx.lineTo(points[q][0], points[q][1]);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawVolume() {
      var b = visibleBounds();
      var bw = barW();
      var width = Math.max(1, Math.min(22, bw * 0.64));
      var maxV = maxVolume();
      var h = layout.bottom - layout.volTop;
      ctx.save();
      for (var i = b.i0; i <= b.i1; i += 1) {
        var bar = bars[i];
        if (!bar) continue;
        var up = bar.c >= bar.o;
        ctx.fillStyle = up ? "rgba(8, 153, 129, 0.45)" : "rgba(242, 54, 69, 0.45)";
        var vh = Math.max(1, (bar.v / maxV) * h);
        ctx.fillRect(Math.round(xOf(i) - width / 2), Math.round(layout.bottom - vh), Math.round(width), Math.round(vh));
      }
      ctx.restore();
      ctx.save();
      ctx.fillStyle = COLORS.muted;
      ctx.font = '10px "Vazirmatn", "Segoe UI", sans-serif';
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText("حجم", layout.left + 2, layout.volTop + 2);
      ctx.restore();
    }

    function drawLastPrice() {
      var bar = bars[bars.length - 1];
      if (!bar) return;
      // A live (intraday) price that has moved away from the last daily close is
      // drawn in blue, TradingView-style, instead of a second green/red line.
      var session = livePrice && Math.abs(livePrice / bar.c - 1) > 0.0005 ? livePrice : null;
      var price = session || bar.c;
      var y = yOf(price);
      if (!isFinite(y)) return;
      if (y < layout.top || y > layout.bottom) return;
      var up = session ? true : bar.c >= bar.o;
      var color = session ? COLORS.line : up ? COLORS.up : COLORS.down;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = session ? 0.8 : 0.55;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(layout.left, Math.round(y) + 0.5);
      ctx.lineTo(layout.right, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.restore();

      var label = fmtPrice(price);
      ctx.save();
      ctx.font = '600 11px "Vazirmatn", "Segoe UI", sans-serif';
      var w = ctx.measureText(label).width + 12;
      ctx.fillStyle = color;
      ctx.fillRect(W - w - 1, Math.round(y) - 9, w, 18);
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, W - w / 2 - 1, Math.round(y));
      ctx.restore();
    }

    function drawCrosshair() {
      if (!hover.on || hover.index < 0) return;
      var x = Math.round(xOf(hover.index)) + 0.5;
      var bar = bars[hover.index];
      if (!bar) return;
      var y = clamp(hover.y, layout.top, layout.bottom);
      ctx.save();
      ctx.strokeStyle = COLORS.cross;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, layout.top);
      ctx.lineTo(x, layout.bottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(layout.left, Math.round(y) + 0.5);
      ctx.lineTo(layout.right, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.restore();

      // y label
      var yPrice = range.hi - (y - layout.top) / (layout.priceBottom - layout.top) * (range.hi - range.lo);
      var yText = fmtPrice(yPrice);
      ctx.save();
      ctx.font = '11px "Vazirmatn", "Segoe UI", sans-serif';
      var yw = ctx.measureText(yText).width + 12;
      ctx.fillStyle = COLORS.badge;
      ctx.fillRect(W - yw - 1, y - 9, yw, 18);
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(yText, W - yw / 2 - 1, y);
      ctx.restore();

      // x label
      var xText = timeLabel(hover.index, true);
      ctx.save();
      ctx.font = '11px "Vazirmatn", "Segoe UI", sans-serif';
      var xw = ctx.measureText(xText).width + 14;
      ctx.fillStyle = COLORS.badge;
      ctx.fillRect(x - xw / 2, layout.bottom + 1, xw, 20);
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(xText, x, layout.bottom + 11);
      ctx.restore();
    }

    function drawAxesBase() {
      ctx.save();
      ctx.strokeStyle = "#22262f";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(layout.right + 0.5, layout.top);
      ctx.lineTo(layout.right + 0.5, layout.bottom);
      ctx.moveTo(layout.left, layout.bottom + 0.5);
      ctx.lineTo(layout.right, layout.bottom + 0.5);
      ctx.stroke();
      ctx.restore();
    }

    function render() {
      if (!W || !H) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, W, H);
      layout.left = PAD.left;
      layout.right = W - PAD.right;
      layout.top = PAD.top;
      layout.bottom = H - PAD.bottom;
      var plotH = layout.bottom - layout.top;
      layout.priceBottom = layout.top + Math.round(plotH * 0.78);
      layout.volTop = layout.priceBottom + 8;

      if (!bars.length) {
        drawAxesBase();
        return;
      }

      var target = computeRange();
      if (!range.ready) {
        range.lo = target.lo;
        range.hi = target.hi;
        range.ready = true;
      }
      drawWatermark();
      drawGrid();

      var revealT = 1;
      if (reveal.active) {
        var elapsed = performance.now() - reveal.t0;
        revealT = easeOutCubic(clamp(elapsed / 480, 0, 1));
        if (elapsed >= 480) reveal.active = false;
      }

      if (mode === "candles") drawCandles(revealT);
      else drawLine(revealT, mode === "area");

      drawVolume();
      drawAxesBase();
      drawLastPrice();
      drawCrosshair();
    }

    /* ------------------------------------------------------------- animation */
    function step() {
      raf = 0;
      if (!bars.length) {
        render();
        return;
      }
      var moved = false;

      // damped zoom / pan so wheel and drag feel smooth instead of jumpy
      var dSpan = view.tSpan - view.span;
      var dEnd = view.tEnd - view.end;
      if (Math.abs(dSpan) > 0.01 || Math.abs(dEnd) > 0.01) {
        view.span += dSpan * 0.24;
        view.end += dEnd * 0.24;
        moved = true;
      } else {
        view.span = view.tSpan;
        view.end = view.tEnd;
      }

      var target = computeRange();
      var dyLo = target.lo - range.lo;
      var dyHi = target.hi - range.hi;
      if (Math.abs(dyLo) > Math.abs(range.hi - range.lo) * 0.0008 || Math.abs(dyHi) > Math.abs(range.hi - range.lo) * 0.0008) {
        range.lo += dyLo * 0.35;
        range.hi += dyHi * 0.35;
        moved = true;
      } else {
        range.lo = target.lo;
        range.hi = target.hi;
      }

      render();

      if (moved || reveal.active) raf = requestAnimationFrame(step);
      else dirty = false;
    }

    function tick() {
      if (!raf) raf = requestAnimationFrame(step);
    }

    /* ------------------------------------------------------------- input */
    function pointerX(evt) {
      var rect = canvas.getBoundingClientRect();
      return evt.clientX - rect.left;
    }
    function pointerY(evt) {
      var rect = canvas.getBoundingClientRect();
      return evt.clientY - rect.top;
    }
    function indexAt(x) {
      var first = view.end - view.span + 1;
      return clamp(Math.round(first + (x - layout.left) / barW() - 0.5), 0, bars.length - 1);
    }

    function onPointerMove(evt) {
      var x = pointerX(evt);
      var y = pointerY(evt);
      if (dragging) {
        var dx = x - dragging.x;
        view.tEnd = clamp(dragging.end - dx / barW(), view.span - 1, bars.length - 1);
        dirty = true;
        tick();
        return;
      }
      var inside = x >= layout.left && x <= layout.right && y >= layout.top && y <= layout.bottom;
      hover.on = inside;
      if (inside) {
        hover.x = x;
        hover.y = y;
        var index = indexAt(x);
        if (index !== hover.index) hover.index = index;
        if (opts.onHover) opts.onHover(bars[hover.index] || null, hover.index);
      } else if (opts.onLeave) {
        opts.onLeave();
      }
      dirty = true;
      tick();
    }

    function onPointerDown(evt) {
      if (!bars.length) return;
      if (evt.button !== undefined && evt.button !== 0) return;
      canvas.setPointerCapture(evt.pointerId);
      dragging = { x: pointerX(evt), end: view.tEnd, id: evt.pointerId };
      canvas.style.cursor = "grabbing";
    }

    function onPointerUp(evt) {
      if (dragging && dragging.id === evt.pointerId) {
        dragging = null;
        canvas.style.cursor = "crosshair";
      }
    }

    function onPointerLeave() {
      if (dragging) return;
      hover.on = false;
      if (opts.onLeave) opts.onLeave();
      dirty = true;
      tick();
    }

    function onWheel(evt) {
      if (!bars.length) return;
      evt.preventDefault();
      var plotW = layout.right - layout.left;
      var x = pointerX(evt);
      var frac = clamp((x - layout.left) / plotW, 0, 1);
      var anchor = indexAt(x);
      var factor = Math.exp(-evt.deltaY * 0.0016);
      var maxSpan = Math.min(400, bars.length);
      var next = clamp(view.tSpan * factor, 10, maxSpan);
      view.tSpan = next;
      view.tEnd = clamp(anchor + next - 0.5 - frac * next, next - 1, bars.length - 1);
      dirty = true;
      tick();
    }

    function onDoubleClick() {
      resetView(true);
    }

    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", onDoubleClick);

    var ro = null;
    if (global.ResizeObserver) {
      ro = new ResizeObserver(function () {
        resize();
        tick();
      });
      ro.observe(host);
    } else {
      global.addEventListener("resize", function () {
        resize();
        tick();
      });
    }

    resize();

    return {
      setSeries: setSeries,
      setMode: setMode,
      setWatermark: setWatermark,
      setLivePrice: setLivePrice,
      resetView: resetView,
      resize: function () {
        resize();
        tick();
      },
      destroy: function () {
        if (ro) ro.disconnect();
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointerleave", onPointerLeave);
        canvas.removeEventListener("wheel", onWheel);
        canvas.removeEventListener("dblclick", onDoubleClick);
        if (raf) cancelAnimationFrame(raf);
      },
      timeLabel: timeLabel,
      fmtPrice: fmtPrice,
      fmtVolume: fmtVolume,
    };
  }

  global.ZChart = { mount: mount, fmtPrice: fmtPrice, fmtVolume: fmtVolume };
})(window);
