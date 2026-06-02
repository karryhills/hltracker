"use strict";

const REFRESH_MS = 5000;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const form = document.getElementById("lookup-form");
const input = document.getElementById("address-input");
const statusEl = document.getElementById("status");
const results = document.getElementById("results");

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

function renderPositions(positions) {
  const tbody = document.querySelector("#positions-table tbody");
  tbody.innerHTML = "";
  document.getElementById("positions-count").textContent =
    positions.length ? `(${positions.length})` : "";
  toggleEmpty("positions-table", positions.length === 0);

  for (const p of positions) {
    const row = el("tr", {}, [
      el("td", {}, p.coin),
      el("td", {}, [el("span", { class: "badge " + p.side }, p.side.toUpperCase())]),
      el("td", {}, fmtNum(p.size)),
      el("td", {}, fmtNum(p.entryPx)),
      el("td", {}, fmtNum(p.markPx)),
      el("td", {}, fmtUsd(p.positionValue)),
      el("td", { class: pnlClass(p.unrealizedPnl) }, fmtUsd(p.unrealizedPnl, { sign: true })),
      el("td", { class: pnlClass(p.returnOnEquity) }, fmtPct(p.returnOnEquity)),
      el("td", {}, p.leverage ? p.leverage + "x" : "-"),
      el("td", {}, p.liquidationPx ? fmtNum(p.liquidationPx) : "-"),
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
        el("td", {}, b.coin),
        el("td", {}, fmtNum(b.total, 6)),
        el("td", {}, b.usdValue ? fmtUsd(b.usdValue) : "-"),
        el("td", {}, b.entryNtl ? fmtUsd(b.entryNtl) : "-"),
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
        el("td", {}, fmtTime(f.time)),
        el("td", {}, f.coin),
        el("td", {}, [el("span", { class: "badge " + f.side }, f.side.toUpperCase())]),
        el("td", {}, fmtNum(f.px)),
        el("td", {}, fmtNum(f.sz)),
        el("td", { class: pnlClass(f.closedPnl) }, f.closedPnl ? fmtUsd(f.closedPnl, { sign: true }) : "-"),
        el("td", {}, fmtUsd(f.fee)),
        el("td", {}, f.dir || "-"),
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
    return;
  }
  currentAddress = address;
  input.value = address;
  if (window.location.hash.slice(1) !== address) {
    window.location.hash = address;
  }
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

// Load address from URL hash on first paint (shareable links).
const initial = window.location.hash.slice(1);
if (initial) track(initial);
