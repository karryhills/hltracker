# ⚡ Hyperliquid Wallet Tracker

A small web app to track any Hyperliquid wallet. Enter an address and see its open
perpetual positions, gain/loss stats, account summary, spot balances, and recent trades —
auto-refreshing every few seconds.

Built with **FastAPI** (Python) + a lightweight HTML/JS/CSS frontend. No API key required;
all data comes from the public [Hyperliquid Info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint).

## Features

- **Perps positions & PnL** — coin, long/short, size, entry, mark price, unrealized PnL,
  ROE, leverage, liquidation price.
- **Account summary** — account value, unrealized PnL, margin used, total position,
  withdrawable.
- **Spot balances** — token amounts and USD value.
- **Recent trades** — latest fills with closed PnL and fees.
- **Auto-refresh** — polls every 5s while the tab is open (pauses when hidden).
- **Shareable links** — the address lives in the URL hash (`/#0x...`).

## Run locally

Requires Python 3.10+.

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open http://localhost:8000 and paste a wallet address (e.g. `0x` + 40 hex chars).

## Deploy to Railway

1. Push this repo to GitHub.
2. In [Railway](https://railway.app): **New Project → Deploy from GitHub repo** and pick
   this repository.
3. Railway auto-detects Python via Nixpacks and uses the included `railway.json`
   (start command `uvicorn app.main:app --host 0.0.0.0 --port $PORT`, health check
   `/healthz`). `$PORT` is provided by Railway automatically.
4. No environment variables or API keys are needed. Once the build finishes, open the
   generated public URL.

The `Procfile` is also included, so the app works on any Procfile-based host (Heroku,
Render, etc.) as well.

## How it works

The backend (`app/main.py`) exposes:

- `GET /` — the single-page UI.
- `GET /api/wallet/{address}` — validates the address, then concurrently calls four
  Hyperliquid Info endpoints (`clearinghouseState`, `spotClearinghouseState`,
  `spotMetaAndAssetCtxs`, `userFills`), normalizes them, and returns one JSON payload.
  Responses are briefly cached (~3s) to dedupe rapid auto-refresh polls and respect
  Hyperliquid's rate limits.
- `GET /healthz` — health check.

`app/hyperliquid.py` holds the async API client and all response-normalization logic.

## Notes

- This is a **read-only** tracker — it never asks for private keys or signs anything.
- Mark price for each position is derived as `positionValue / |size|`.
- Spot USD values use the current spot mid price (USDC = $1).
