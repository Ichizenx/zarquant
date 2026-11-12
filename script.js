(() => {
  "use strict";

  const CATEGORIES = [
    { key: "stocks", label: "سهام" },
    { key: "funds", label: "صندوق‌ها" },
    { key: "goldFunds", label: "صندوق‌های طلا" },
    { key: "options", label: "اختیار معامله" },
  ];

  const PAGE_SIZE = 60;
  const nf = new Intl.NumberFormat("en-US");
  const nf1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const state = {
    data: null,
    query: "",
    collapsed: new Set(),
    limits: {},
    selected: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const el = {
    app: $("#app"),
    summary: $("#summary"),
    groups: $("#groups"),
    body: $("#wlBody"),
    search: $("#search"),
    count: $("#wlCount"),
    empty: $("#wlEmpty"),
    updated: $("#updated"),
    refresh: $("#refresh"),
    collapse: $("#collapseBtn"),
    open: $("#openBtn"),
    dSymbol: $("#dSymbol"),
    dName: $("#dName"),
    dBadge: $("#dBadge"),
    dPrice: $("#dPrice"),
    dStats: $("#dStats"),
  };

  const hemt = (rial) => rial / 1e13;

  const normalize = (value) =>
    String(value || "")
      .replace(/[يى]/g, "ی")
      .replace(/ك/g, "ک")
      .replace(/\u200c/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const escapeHtml = (value) =>
    String(value || "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));

  const changeClass = (value) => (value > 0 ? "up" : value < 0 ? "down" : "flat");

  // Daily change in rials, derived from the percent move against the previous close.
  const deltaOf = (item) => {
    if (!item.ch) return 0;
    return Math.round(item.p - item.p / (1 + item.ch / 100));
  };

  const signed = (value) => (value > 0 ? `+${nf.format(value)}` : nf.format(value));
  const signedPct = (value) =>
    value === null || value === undefined ? "—" : `${value > 0 ? "+" : ""}${nf1.format(value)}%`;

  function rowHtml(cat, index, item) {
    const delta = deltaOf(item);
    const cls = changeClass(item.ch);
    return `<button class="wl-row" type="button" data-cat="${cat}" data-index="${index}" data-sym="${escapeHtml(item.s)}">
      <span class="sym">${escapeHtml(item.s)}</span>
      <span class="last">${nf.format(item.p)}</span>
      <span class="chg ${cls}">${signed(delta)}</span>
      <span class="pct ${cls}">${signedPct(item.ch)}</span>
    </button>`;
  }

  function groupHtml(cat) {
    const items = state.data.categories[cat.key] || [];
    const q = normalize(state.query);
    let list = items.map((item, index) => ({ item, index }));
    if (q) {
      list = list.filter(({ item }) => normalize(item.s).includes(q) || normalize(item.n).includes(q));
    }
    if (!list.length && q) return "";

    const limit = state.limits[cat.key] || PAGE_SIZE;
    const open = q ? true : !state.collapsed.has(cat.key);
    const rows = list
      .slice(0, limit)
      .map(({ item, index }) => rowHtml(cat.key, index, item))
      .join("");
    const more =
      list.length > limit
        ? `<button class="wl-more" type="button" data-cat="${cat.key}">نمایش بیشتر (${nf.format(list.length - limit)})</button>`
        : "";

    return `<section class="wl-group" data-key="${cat.key}" data-open="${open}">
      <button class="wl-group-head" type="button" data-toggle="${cat.key}">
        <span class="chev">▾</span>
        <span>${cat.label}</span>
        <b>${nf.format(list.length)}</b>
      </button>
      <div class="wl-rows">${rows}</div>
      ${more}
    </section>`;
  }

  function renderWatchlist() {
    if (!state.data) return;
    const html = CATEGORIES.map(groupHtml).join("");
    el.body.innerHTML = html;

    const q = normalize(state.query);
    const shown = q
      ? CATEGORIES.reduce((sum, cat) => {
          const items = state.data.categories[cat.key] || [];
          return sum + items.filter((i) => normalize(i.s).includes(q) || normalize(i.n).includes(q)).length;
        }, 0)
      : Object.values(state.data.counts).reduce((a, b) => a + b, 0);

    el.count.textContent = nf.format(shown);
    el.empty.hidden = shown !== 0;
    markSelected();
  }

  function markSelected() {
    if (!state.selected) return;
    const selector = `.wl-row[data-cat="${state.selected.cat}"][data-index="${state.selected.index}"]`;
    const row = el.body.querySelector(selector);
    if (row) {
      row.classList.add("selected");
      row.scrollIntoView({ block: "nearest" });
    }
  }

  function renderSummary() {
    const data = state.data;
    const all = Object.values(data.categories).flat();
    const traded = all.filter((i) => i.v > 0);
    const best = all
      .filter((i) => typeof i.ch === "number" && i.ch > 0 && i.ch < 100 && i.v > 0)
      .sort((a, b) => b.ch - a.ch)[0];
    const richest = all.slice().sort((a, b) => b.val - a.val)[0];

    const cards = [
      { label: "نمادهای بازار", value: nf.format(all.length), sub: `${nf.format(traded.length)} معامله‌شده` },
      { label: "ارزش کل معاملات", value: `${nf1.format(hemt(data.totalValue || 0))} همت`, sub: "مجموع دسته‌ها" },
      best
        ? { label: "بیشترین رشد", value: escapeHtml(best.s), sub: `+${nf1.format(best.ch)}%`, cls: "up" }
        : null,
      richest
        ? { label: "پرگردش‌ترین", value: escapeHtml(richest.s), sub: `${nf1.format(hemt(richest.val))} همت` }
        : null,
    ].filter(Boolean);

    el.summary.innerHTML = cards
      .map(
        (c) => `<div class="sum-card"><span>${c.label}</span><b class="${c.cls || ""}">${c.value}</b>
        <span>${c.sub}</span></div>`
      )
      .join("");
  }

  function renderGroups() {
    const rows = CATEGORIES.map((cat) => {
      const items = state.data.categories[cat.key] || [];
      const total = items.reduce((sum, item) => sum + item.val, 0);
      return `<div><span>${cat.label}</span><b>${nf.format(items.length)} نماد · ${nf1.format(hemt(total))} همت</b></div>`;
    });
    el.groups.innerHTML = rows.join("");
  }

  function renderDetail(item) {
    if (!item) {
      el.dSymbol.textContent = "—";
      el.dName.textContent = "یک نماد را از واچ‌لیست انتخاب کنید";
      el.dPrice.textContent = "—";
      el.dBadge.textContent = "—";
      el.dBadge.className = "detail-badge";
      el.dStats.innerHTML = "";
      return;
    }
    const cls = changeClass(item.ch);
    el.dSymbol.textContent = item.s;
    el.dName.textContent = item.n;
    el.dPrice.textContent = nf.format(item.p);
    el.dBadge.textContent = signedPct(item.ch);
    el.dBadge.className = `detail-badge ${cls}`;

    const delta = deltaOf(item);
    const stats = [
      ["بسته", nf.format(item.c)],
      ["تغییر", signed(delta)],
      ["حجم", nf.format(item.v)],
      ["ارزش (همت)", nf2.format(hemt(item.val))],
      ["معاملات", nf.format(item.t)],
      ["شناسه", item.i || "—"],
    ];
    el.dStats.innerHTML = stats
      .map(([label, value]) => `<div><span>${label}</span><b>${escapeHtml(value)}</b></div>`)
      .join("");
  }

  function selectRow(catKey, index) {
    const item = (state.data.categories[catKey] || [])[index];
    if (!item) return;
    state.selected = { cat: catKey, index };
    renderDetail(item);
    markSelected();
  }

  function render() {
    renderSummary();
    renderGroups();
    renderWatchlist();
    if (!state.selected && state.data) {
      selectRow("stocks", 0);
    }
  }

  function renderUpdated() {
    const when = new Date(state.data.updated);
    el.updated.textContent = `به‌روزرسانی: ${new Intl.DateTimeFormat("fa-IR", {
      dateStyle: "short", timeStyle: "short", timeZone: "Asia/Tehran",
    }).format(when)}`;
  }

  async function load() {
    el.refresh.classList.add("spin");
    try {
      const res = await fetch(`data.json?v=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.data = await res.json();
      state.selected = null;
      renderUpdated();
      render();
    } catch (error) {
      el.updated.textContent = "خطا در دریافت داده";
      el.empty.hidden = false;
      el.empty.textContent = "داده‌ای دریافت نشد؛ اتصال را بررسی و دوباره تلاش کنید.";
    } finally {
      el.refresh.classList.remove("spin");
    }
  }

  el.body.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-toggle]");
    if (toggle) {
      const key = toggle.dataset.toggle;
      if (state.collapsed.has(key)) state.collapsed.delete(key);
      else state.collapsed.add(key);
      renderWatchlist();
      return;
    }

    const more = event.target.closest(".wl-more");
    if (more) {
      const key = more.dataset.cat;
      state.limits[key] = (state.limits[key] || PAGE_SIZE) + PAGE_SIZE;
      renderWatchlist();
      return;
    }

    const row = event.target.closest(".wl-row");
    if (row) {
      selectRow(row.dataset.cat, Number(row.dataset.index));
    }
  });

  let searchTimer;
  el.search.addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    const value = event.target.value;
    searchTimer = setTimeout(() => {
      state.query = value;
      renderWatchlist();
    }, 120);
  });

  el.refresh.addEventListener("click", load);

  el.collapse.addEventListener("click", () => {
    el.app.classList.add("collapsed");
    el.open.hidden = false;
  });

  el.open.addEventListener("click", () => {
    el.app.classList.remove("collapsed");
    el.open.hidden = true;
  });

  if (window.matchMedia("(max-width: 900px)").matches) {
    el.app.classList.add("collapsed");
    el.open.hidden = false;
  }

  load();
})();
