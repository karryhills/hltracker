"""FastAPI app: serves the tracker UI and a JSON API that proxies Hyperliquid."""
from __future__ import annotations

import time
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import hyperliquid

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

# Small in-process cache to dedupe rapid auto-refresh polls and stay well under
# Hyperliquid's rate limits. address -> (timestamp, payload)
_CACHE: dict[str, tuple[float, dict]] = {}
_CACHE_TTL = 3.0


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await hyperliquid.aclose()


app = FastAPI(title="Hyperliquid Wallet Tracker", lifespan=lifespan)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


@app.get("/")
async def index():
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/api/wallet/{address}")
async def wallet(address: str):
    address = address.strip()
    if not hyperliquid.is_valid_address(address):
        return JSONResponse(
            status_code=400,
            content={"error": "Invalid wallet address. Expected 0x + 40 hex characters."},
        )

    key = address.lower()
    now = time.monotonic()
    cached = _CACHE.get(key)
    if cached and now - cached[0] < _CACHE_TTL:
        return cached[1]

    try:
        data = await hyperliquid.get_wallet(address)
    except httpx.HTTPStatusError as exc:
        return JSONResponse(
            status_code=502,
            content={"error": f"Hyperliquid API returned {exc.response.status_code}."},
        )
    except httpx.HTTPError as exc:
        return JSONResponse(
            status_code=502,
            content={"error": f"Could not reach Hyperliquid API: {exc}"},
        )

    _CACHE[key] = (now, data)
    return data
