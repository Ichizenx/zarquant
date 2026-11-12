(() => {
  "use strict";

  const CATEGORIES = [
    { key: "stocks", label: "سهام" },
    { key: "funds", label: "صندوق‌ها" },
    { key: "goldFunds", label: "صندوق‌های طلا" },
    { key: "options", label: "اختیار معامله" },
  ];

  const MAX_ROWS = 300;
  const MAX_CARDS = 120;

  const state = {
    data: null,
    tab: "stocks",
    query: "",
    sortKey: "val",
    sortDir: "desc",
  };

  const nf = new Intl.NumberFormat("en-US");
  const nf1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const $ = (sel) => document.querySelector(sel);
  const el = {
    kpis: $("#kpis"),
    tabs: $("#tabs"),
    search: $("#search"),
    sort: $("#sort"),
    tbody: $("#tbody"),
    cards: $("#cards"),
    empty: $("#empty"),
    hint: $("#hint"),
    updated: $("#updated"),
    refresh: $("#refresh"),
  };

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

  const tomanBillion = (rial) => rial / 1e10; // میلیارد تومان
  const hemt = (rial) => rial / 1e13; // همت = هزار میلیارد تومان

  function changeBadge(change) {
    if (change === null || change === undefined) return '<span class="badge flat">—</span>';
    if (change > 0) return `<span class="badge up">+${nf1.format(change)}%</span>`;
    if (change < 0) return `<span class="badge down">${nf1.format(change)}%</span>`;
    return '<span class="badge flat">0%</span>';
  }

  function sortRows(rows) {
    const dir = state.sortDir === "asc" ? 1 : -1;
    const key = state.sortKey;
    return rows.slice().sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (typeof av === "string" || typeof bv === "string") {
        return String(av || "").localeCompare(String(bv || ""), "fa") * dir;
      }
      return ((av || 0) - (bv || 0)) * dir;
    });
  }

  function currentRows() {
    if (!state.data) return [];
    const rows = state.data.categories[state.tab] || [];
    const q = normalize(state.query);
    const filtered = q
      ? rows.filter((r) => normalize(r.s).includes(q) || normalize(r.n).includes(q))
      : rows;
    return sortRows(filtered);
  }

  function renderKpis() {
    const data = state.data;
    if (!data) return;
    const all = Object.values(data.categories).flat();
    const tradable = all.filter((r) => r.v > 0);
    // Newly listed instruments can report an enormous change off a nominal base
    // price; ignore those when picking the day's best performer.
    const best = all
      .filter((r) => typeof r.ch === "number" && r.ch > 0 && r.ch < 100 && r.v > 0)
      .sort((a, b) => b.ch - a.ch)[0];
    const richest = all.slice().sort((a, b) => b.val - a.val)[0];

    const cards = [
      `<div class="kpi"><span>نمادهای این دسته</span><strong>${nf.format(activeCount())}</strong><em>از ${nf.format(tradable.length)} نماد معامله‌شده بازار</em></div>`,
      `<div class="kpi"><span>ارزش کل معاملات</span><strong>${nf1.format(hemt(data.totalValue || 0))} همت</strong><em>مجموع همه دسته‌ها</em></div>`,
      best
        ? `<div class="kpi"><span>بیشترین رشد</span><strong>${escapeHtml(best.s)} <span class="badge up">+${nf1.format(best.ch)}٪</span></strong><em>${escapeHtml(best.n)}</em></div>`
        : "",
      richest
        ? `<div class="kpi gold"><span>پرگردش‌ترین نماد</span><strong>${escapeHtml(richest.s)}</strong><em>${nf1.format(hemt(richest.val))} همت</em></div>`
        : "",
    ];
    el.kpis.innerHTML = cards.join("");
  }

  function activeCount() {
    return state.data ? state.data.counts[state.tab] || 0 : 0;
  }

  function renderTabs() {
    if (!state.data) return;
    el.tabs.innerHTML = CATEGORIES.map((cat) => {
      const count = state.data.counts[cat.key] || 0;
      const selected = cat.key === state.tab;
      return `<button class="tab" role="tab" data-tab="${cat.key}" aria-selected="${selected}">
        ${cat.label}<b>${nf.format(count)}</b>
      </button>`;
    }).join("");
  }

  function renderTable(rows) {
    const shown = rows.slice(0, MAX_ROWS);
    el.tbody.innerHTML = shown
      .map((r, index) => `
        <tr>
          <td class="col-rank">${nf.format(index + 1)}</td>
          <td class="symbol">${escapeHtml(r.s)}</td>
          <td class="company" title="${escapeHtml(r.n)}">${escapeHtml(r.n)}</td>
          <td class="num">${nf.format(r.p)}</td>
          <td class="num">${changeBadge(r.ch)}</td>
          <td class="num">${nf.format(r.v)}</td>
          <td class="num" title="${nf.format(r.val)} ریال">${nf2.format(hemt(r.val))}</td>
          <td class="num">${nf.format(r.t)}</td>
        </tr>`)
      .join("");

    const shownCards = rows.slice(0, MAX_CARDS);
    el.cards.innerHTML = shownCards
      .map((r) => `
        <article class="card">
          <div class="card-top">
            <span class="symbol">${escapeHtml(r.s)}</span>
            ${changeBadge(r.ch)}
          </div>
          <p class="card-name">${escapeHtml(r.n)}</p>
          <div class="card-grid">
            <div><span>قیمت</span><b>${nf.format(r.p)}</b></div>
            <div><span>حجم</span><b>${nf.format(r.v)}</b></div>
            <div><span>ارزش (همت)</span><b>${nf2.format(hemt(r.val))}</b></div>
            <div><span>معاملات</span><b>${nf.format(r.t)}</b></div>
          </div>
        </article>`)
      .join("");

    const empty = rows.length === 0;
    el.empty.hidden = !empty;
    if (empty) el.empty.textContent = state.query ? "نمادی با این عبارت پیدا نشد." : "داده‌ای برای این دسته موجود نیست.";

    const truncated = rows.length > MAX_ROWS;
    el.hint.textContent = truncated
      ? `نمایش ${nf.format(Math.min(MAX_ROWS, rows.length))} مورد از ${nf.format(rows.length)} — برای دیدن بقیه جستجو کنید.`
      : `${nf.format(rows.length)} مورد`;
  }

  function renderHeaderState() {
    document.querySelectorAll("th.sortable").forEach((th) => {
      const active = th.dataset.key === state.sortKey;
      th.dataset.active = String(active);
      const arrow = th.querySelector(".arrow");
      if (arrow) arrow.remove();
      if (active) {
        const span = document.createElement("span");
        span.className = "arrow";
        span.textContent = state.sortDir === "asc" ? "▲" : "▼";
        th.appendChild(span);
      }
    });
  }

  function render() {
    renderTabs();
    renderKpis();
    const rows = currentRows();
    renderTable(rows);
    renderHeaderState();
  }

  function renderUpdated() {
    if (!state.data) return;
    const when = new Date(state.data.updated);
    const label = new Intl.DateTimeFormat("fa-IR", {
      dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tehran",
    }).format(when);
    el.updated.textContent = `به‌روزرسانی: ${label}`;
  }

  async function load() {
    el.refresh.classList.add("spin");
    try {
      const response = await fetch(`data.json?v=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      state.data = await response.json();
      renderUpdated();
      render();
    } catch (error) {
      el.updated.textContent = "خطا در دریافت داده";
      el.empty.hidden = false;
      el.empty.textContent = "داده‌ای دریافت نشد. اتصال اینترنت را بررسی و دوباره تلاش کنید.";
    } finally {
      el.refresh.classList.remove("spin");
    }
  }

  el.tabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-tab]");
    if (!button) return;
    state.tab = button.dataset.tab;
    state.query = "";
    el.search.value = "";
    render();
  });

  document.querySelector("thead").addEventListener("click", (event) => {
    const th = event.target.closest("th.sortable");
    if (!th) return;
    const key = th.dataset.key;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
    } else {
      state.sortKey = key;
      state.sortDir = key === "s" || key === "n" ? "asc" : "desc";
    }
    el.sort.value = ["val", "v", "ch", "p", "s"].includes(key) ? key : state.sortKey;
    render();
  });

  let searchTimer;
  el.search.addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    const value = event.target.value;
    searchTimer = setTimeout(() => {
      state.query = value;
      render();
    }, 120);
  });

  el.sort.addEventListener("change", (event) => {
    state.sortKey = event.target.value;
    state.sortDir = state.sortKey === "s" ? "asc" : "desc";
    render();
  });

  el.refresh.addEventListener("click", load);

  load();
})();

