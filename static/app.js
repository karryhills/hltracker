"use strict";

const REFRESH_MS = 5000;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const WATCHLIST_KEY = "hl_watchlist";

const form = document.getElementById("lookup-form");
const input = document.getElementById("address-input");
const statusEl = document.getElementById("status");
const results = document.getElementById("results");
const saveBtn = document.getElementById("save-btn");
const watchlistEl = document.getElementById("watchlist");

let currentAddress = null;
let refreshTimer = null;

// ---- formatting helpers -------------------------------------------------

function fmtUsd(n, opts = {}) {
  const { sign = false } = opts;
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  const s = n.toLocaleString("en-US", { style: "currency", currency: "USD" });
  return sign && n > 0 ? "+" + s : s;
}

function fmtNum(n, maxFrac = 4) {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  return n.toLocaleString("en-US", { maximumFractionDigits: maxFrac });
}

function fmtPct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  const v = n * 100;
  return (v > 0 ? "+" : "") + v.toFixed(2) + "%";
}

function fmtTime(ms) {
  if (!ms) return "-";
  const d = new Date(ms);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function pnlClass(n) {
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return "";
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function shortenAddress(addr) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

// ---- watchlist (browser localStorage) ----------------------------------

function loadWatchlist() {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveWatchlist(list) {
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable (e.g. private mode) — ignore */
  }
}

function isSaved(address) {
  const addr = address.toLowerCase();
  return loadWatchlist().some((w) => w.address.toLowerCase() === addr);
}

function addToWatchlist(address, label) {
  const list = loadWatchlist();
  if (list.some((w) => w.address.toLowerCase() === address.toLowerCase())) return;
  list.push({ address, label: (label || "").trim() });
  saveWatchlist(list);
}

function removeFromWatchlist(address) {
  const addr = address.toLowerCase();
  saveWatchlist(loadWatchlist().filter((w) => w.address.toLowerCase() !== addr));
}

function renderWatchlist() {
  const list = loadWatchlist();
  watchlistEl.innerHTML = "";
  watchlistEl.classList.toggle("hidden", list.length === 0);

  for (const item of list) {
    const isActive = currentAddress && item.address.toLowerCase() === currentAddress.toLowerCase();
    const labelText = item.label || shortenAddress(item.address);

    const mainBtn = el("button", { class: "chip-main", type: "button", title: item.address }, labelText);
    mainBtn.addEventListener("click", () => track(item.address));

    const removeBtn = el("button", { class: "chip-remove", type: "button", title: "Remove", "aria-label": "Remove" }, "×");
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeFromWatchlist(item.address);
      renderWatchlist();
      updateSaveButton();
    });

    watchlistEl.appendChild(el("div", { class: "chip" + (isActive ? " active" : "") }, [mainBtn, removeBtn]));
  }
}

function updateSaveButton() {
  const saved = currentAddress && isSaved(currentAddress);
  saveBtn.classList.toggle("saved", !!saved);
  saveBtn.title = saved ? "Remove from watchlist" : "Save to watchlist";
}

// ---- rendering ----------------------------------------------------------

function renderSummary(s) {
  const grid = document.getElementById("summary-grid");
  grid.innerHTML = "";
  const cards = [
    { label: "Account Value", value: fmtUsd(s.accountValue) },
    { label: "Unrealized PnL", value: fmtUsd(s.totalUnrealizedPnl, { sign: true }), cls: pnlClass(s.totalUnrealizedPnl) },
    { label: "Margin Used", value: fmtUsd(s.totalMarginUsed) },
    { label: "Total Position", value: fmtUsd(s.totalNtlPos) },
    { label: "Withdrawable", value: fmtUsd(s.withdrawable) },
  ];
  for (const c of cards) {
    grid.appendChild(
      el("div", { class: "summary-card" }, [
        el("div", { class: "label" }, c.label),
        el("div", { class: "value " + (c.cls || "") }, c.value),
      ])
    );
  }
}

function toggleEmpty(tableId, isEmpty) {
  const table = document.getElementById(tableId);
  const msg = document.querySelector(`[data-empty-for="${tableId}"]`);
  table.classList.toggle("hidden", isEmpty);
  msg.classList.toggle("hidden", !isEmpty);
}

// Build a <td> carrying a data-label (shown as the field name in the mobile
// card layout). `content` may be a string or a DOM node.
function cell(label, content, cls = "") {
  return el("td", { class: cls, "data-label": label }, [content]);
}

function coinCell(coin, dex) {
  const children = [el("span", { class: "coin-name" }, coin)];
  if (dex) children.push(el("span", { class: "dex-tag", title: "HIP-3 DEX: " + dex }, dex));
  return el("td", { "data-label": "Coin", class: "coin-cell" }, children);
}

// Sticky left column for a position: coin + leverage on top, side below.
function symCell(p) {
  const top = el("div", { class: "sym-top" }, [el("span", { class: "coin-name" }, p.coin)]);
  if (p.leverage) top.appendChild(el("span", { class: "lev-tag" }, p.leverage + "x"));
  if (p.dex) top.appendChild(el("span", { class: "dex-tag", title: "HIP-3 DEX: " + p.dex }, p.dex));
  const sub = el("div", { class: "sym-side " + p.side }, p.side.toUpperCase());
  return el("td", { class: "sym-cell", "data-label": "Position" }, [top, sub]);
}

function renderPositions(positions) {
  const tbody = document.querySelector("#positions-table tbody");
  tbody.innerHTML = "";
  document.getElementById("positions-count").textContent =
    positions.length ? `(${positions.length})` : "";
  toggleEmpty("positions-table", positions.length === 0);

  for (const p of positions) {
    const row = el("tr", {}, [
      symCell(p),
      cell("ROE", fmtPct(p.returnOnEquity), pnlClass(p.returnOnEquity)),
      cell("Unrealized PnL", fmtUsd(p.unrealizedPnl, { sign: true }), pnlClass(p.unrealizedPnl)),
      cell("Margin", fmtUsd(p.marginUsed)),
      cell("24h", p.change24h == null ? "-" : fmtPct(p.change24h), pnlClass(p.change24h)),
      cell("Price", fmtNum(p.markPx)),
      cell("Liq. Px", p.liquidationPx ? fmtNum(p.liquidationPx) : "-"),
      cell("Entry", fmtNum(p.entryPx)),
      cell("Size", fmtNum(p.size)),
      cell("Value", fmtUsd(p.positionValue)),
    ]);
    tbody.appendChild(row);
  }
}

function renderSpot(spot) {
  const tbody = document.querySelector("#spot-table tbody");
  tbody.innerHTML = "";
  document.getElementById("spot-count").textContent = spot.length ? `(${spot.length})` : "";
  toggleEmpty("spot-table", spot.length === 0);

  for (const b of spot) {
    tbody.appendChild(
      el("tr", {}, [
        cell("Coin", el("span", { class: "coin-name" }, b.coin), "coin-cell"),
        cell("USD Value", b.usdValue ? fmtUsd(b.usdValue) : "-"),
        cell("Amount", fmtNum(b.total, 6)),
        cell("Entry Notional", b.entryNtl ? fmtUsd(b.entryNtl) : "-"),
      ])
    );
  }
}

function renderFills(fills) {
  const tbody = document.querySelector("#fills-table tbody");
  tbody.innerHTML = "";
  toggleEmpty("fills-table", fills.length === 0);

  for (const f of fills) {
    tbody.appendChild(
      el("tr", {}, [
        coinCell(f.coin, f.dex),
        cell("Side", el("span", { class: "badge " + f.side }, f.side.toUpperCase())),
        cell("Price", fmtNum(f.px)),
        cell("Size", fmtNum(f.sz)),
        cell("Closed PnL", f.closedPnl ? fmtUsd(f.closedPnl, { sign: true }) : "-", pnlClass(f.closedPnl)),
        cell("Fee", fmtUsd(f.fee)),
        cell("Time", fmtTime(f.time)),
        cell("Direction", f.dir || "-"),
      ])
    );
  }
}

function render(data) {
  renderSummary(data.summary);
  renderPositions(data.positions);
  renderSpot(data.spot);
  renderFills(data.fills);
  results.classList.remove("hidden");
}

// ---- data fetching + auto-refresh --------------------------------------

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

async function fetchWallet(address, { silent = false } = {}) {
  if (!silent) setStatus("Loading…");
  try {
    const resp = await fetch(`/api/wallet/${address}`);
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || `Request failed (${resp.status})`);
    }
    render(data);
    setStatus(`Updated ${new Date().toLocaleTimeString("en-US")} · ${address}`);
  } catch (err) {
    if (!silent) {
      setStatus(err.message, true);
      results.classList.add("hidden");
    } else {
      setStatus(`${err.message} (retrying)`, true);
    }
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    if (document.hidden || !currentAddress) return;
    fetchWallet(currentAddress, { silent: true });
  }, REFRESH_MS);
}

function stopAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

async function track(address) {
  address = address.trim();
  if (!ADDRESS_RE.test(address)) {
    setStatus("Invalid address. Expected 0x followed by 40 hex characters.", true);
    results.classList.add("hidden");
    stopAutoRefresh();
    currentAddress = null;
    updateSaveButton();
    renderWatchlist();
    return;
  }
  currentAddress = address;
  input.value = address;
  if (window.location.hash.slice(1) !== address) {
    window.location.hash = address;
  }
  updateSaveButton();
  renderWatchlist();
  await fetchWallet(address);
  startAutoRefresh();
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  track(input.value);
});

window.addEventListener("hashchange", () => {
  const addr = window.location.hash.slice(1);
  if (addr && addr !== currentAddress) track(addr);
});

// Refresh immediately when the tab becomes visible again.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && currentAddress) fetchWallet(currentAddress, { silent: true });
});

// Save / unsave the current (or typed) address to the watchlist.
saveBtn.addEventListener("click", () => {
  const addr = (currentAddress || input.value).trim();
  if (!ADDRESS_RE.test(addr)) {
    setStatus("Enter a valid address before saving.", true);
    return;
  }
  if (isSaved(addr)) {
    removeFromWatchlist(addr);
  } else {
    const label = window.prompt("Nickname for this wallet (optional):", "");
    if (label === null) return; // user cancelled
    addToWatchlist(addr, label);
  }
  renderWatchlist();
  updateSaveButton();
});

// Render the saved watchlist on first paint.
renderWatchlist();
updateSaveButton();

// Load address from URL hash on first paint (shareable links).
const initial = window.location.hash.slice(1);
if (initial) track(initial);
