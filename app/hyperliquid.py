"""Async client for the Hyperliquid public Info API.

All data comes from the public Info endpoint, which requires no API key:
    POST https://api.hyperliquid.xyz/info  with body {"type": "...", "user": "0x..."}

This module fetches a wallet's perps state, spot balances, spot prices, and recent
fills, then normalizes everything into a single clean payload for the frontend.
"""
from __future__ import annotations

import asyncio
import re
from typing import Any

import httpx

INFO_URL = "https://api.hyperliquid.xyz/info"

_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")

# Reusable client; created lazily so import never does network work.
_client: httpx.AsyncClient | None = None


def is_valid_address(addr: str) -> bool:
    """True if `addr` looks like a 0x-prefixed 40-hex-char EVM address."""
    return bool(_ADDRESS_RE.match(addr or ""))


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=10.0)
    return _client


async def aclose() -> None:
    """Close the shared client (call on app shutdown)."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def _post(body: dict) -> Any:
    """POST a request body to the Info endpoint and return parsed JSON."""
    client = _get_client()
    resp = await client.post(INFO_URL, json=body)
    resp.raise_for_status()
    return resp.json()


async def _try_post(body: dict) -> Any:
    """Like _post, but return None on any HTTP error (for non-critical calls)."""
    try:
        return await _post(body)
    except httpx.HTTPError:
        return None


def _split_coin(coin: Any) -> tuple[str, str]:
    """Split a coin symbol into (dex, coin).

    HIP-3 perp assets are namespaced as "<dex>:<COIN>" (e.g. "xyz:SP500"). Native
    assets have no prefix. Returns ("", coin) for native.
    """
    text = str(coin if coin is not None else "?")
    if ":" in text:
        dex, name = text.split(":", 1)
        return dex, name
    return "", text


def _f(value: Any, default: float = 0.0) -> float:
    """Best-effort float cast for the API's numeric-string fields."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _iter_states(raw: Any) -> list[tuple[str, dict]]:
    """Yield (dex_name, state) pairs from a clearinghouseState response.

    A plain (single-DEX) request returns one state object. A `dex: "ALL_DEXES"`
    request fans out across the native DEX and every HIP-3 (builder-deployed) perp
    DEX — the shape there is keyed by DEX name (native DEX under "native"). This
    handles the single-object, keyed-dict, and list shapes defensively so equity
    perps (e.g. SPY, PLTR) deployed on HIP-3 DEXes are included.
    """
    def looks_like_state(obj: Any) -> bool:
        return isinstance(obj, dict) and ("assetPositions" in obj or "marginSummary" in obj)

    if isinstance(raw, dict):
        if looks_like_state(raw):
            return [("", raw)]
        out = []
        for name, value in raw.items():
            if looks_like_state(value):
                out.append((name, value))
        return out
    if isinstance(raw, list):
        out = []
        for item in raw:
            if looks_like_state(item):
                out.append(("", item))
            elif isinstance(item, dict) and looks_like_state(item.get("state")):
                out.append((item.get("dex", ""), item["state"]))
        return out
    return []


def _normalize_perps(raw: Any) -> tuple[dict, list[dict]]:
    """Turn a clearinghouseState response into (summary, positions).

    Aggregates across every perp DEX returned (native + HIP-3), so positions on
    builder-deployed DEXes show up alongside native ones.
    """
    summary = {
        "accountValue": 0.0,
        "totalNtlPos": 0.0,
        "totalMarginUsed": 0.0,
        "withdrawable": 0.0,
        "totalUnrealizedPnl": 0.0,
    }
    positions: list[dict] = []

    for dex_name, state in _iter_states(raw):
        is_native = dex_name in ("", "native")
        margin = state.get("marginSummary") or {}
        summary["accountValue"] += _f(margin.get("accountValue"))
        summary["totalNtlPos"] += _f(margin.get("totalNtlPos"))
        summary["totalMarginUsed"] += _f(margin.get("totalMarginUsed"))
        summary["withdrawable"] += _f(state.get("withdrawable"))

        for entry in state.get("assetPositions") or []:
            pos = (entry or {}).get("position") or {}
            szi = _f(pos.get("szi"))
            if szi == 0:
                continue
            position_value = _f(pos.get("positionValue"))
            size_abs = abs(szi)
            mark_px = position_value / size_abs if size_abs else 0.0
            unrealized = _f(pos.get("unrealizedPnl"))
            summary["totalUnrealizedPnl"] += unrealized
            leverage = pos.get("leverage") or {}
            # Prefer an explicit "dex:" prefix on the coin; otherwise use the DEX
            # this state came from.
            coin_dex, coin = _split_coin(pos.get("coin"))
            pos_dex = coin_dex or ("" if is_native else dex_name)
            positions.append(
                {
                    "coin": coin,
                    "dex": "" if pos_dex in ("", "native") else pos_dex,
                    "side": "long" if szi > 0 else "short",
                    "size": size_abs,
                    "entryPx": _f(pos.get("entryPx")),
                    "markPx": mark_px,
                    "positionValue": position_value,
                    "unrealizedPnl": unrealized,
                    "returnOnEquity": _f(pos.get("returnOnEquity")),
                    "leverage": _f(leverage.get("value")),
                    "liquidationPx": _f(pos.get("liquidationPx")),
                    "marginUsed": _f(pos.get("marginUsed")),
                }
            )

    positions.sort(key=lambda p: abs(p["positionValue"]), reverse=True)
    return summary, positions


def _spot_price_map(spot_meta_ctxs: Any) -> dict[str, float]:
    """Build {coin: usdPrice} from a spotMetaAndAssetCtxs response.

    The response is [meta, assetCtxs]. meta.tokens names tokens; meta.universe lists
    trading pairs (each has `tokens: [baseIndex, quoteIndex]` and a name like "@1").
    assetCtxs is parallel to universe and carries midPx for each pair. We map each
    base token to its USD mid (pairs are quoted in USDC == $1).
    """
    prices: dict[str, float] = {}
    if not (isinstance(spot_meta_ctxs, list) and len(spot_meta_ctxs) == 2):
        return prices
    meta, ctxs = spot_meta_ctxs
    if not isinstance(meta, dict) or not isinstance(ctxs, list):
        return prices

    tokens = meta.get("tokens") or []
    universe = meta.get("universe") or []
    for pair, ctx in zip(universe, ctxs):
        token_idxs = (pair or {}).get("tokens") or []
        if not token_idxs:
            continue
        base_idx = token_idxs[0]
        if base_idx >= len(tokens):
            continue
        base_name = (tokens[base_idx] or {}).get("name")
        mid = ctx.get("midPx") if isinstance(ctx, dict) else None
        if base_name and mid is not None:
            prices[base_name] = _f(mid)
    return prices


def _normalize_spot(spot_state: Any, prices: dict[str, float]) -> list[dict]:
    """Turn a spotClearinghouseState response into a list of balances with USD value."""
    out: list[dict] = []
    if not isinstance(spot_state, dict):
        return out
    for bal in spot_state.get("balances") or []:
        coin = (bal or {}).get("coin", "?")
        total = _f(bal.get("total"))
        if total == 0:
            continue
        # USDC is the dollar quote token; everything else uses the spot mid price.
        price = 1.0 if coin in ("USDC", "USD") else prices.get(coin, 0.0)
        out.append(
            {
                "coin": coin,
                "total": total,
                "usdValue": total * price,
                "entryNtl": _f(bal.get("entryNtl")),
            }
        )
    out.sort(key=lambda b: b["usdValue"], reverse=True)
    return out


def _normalize_fills(fills: Any, limit: int = 30) -> list[dict]:
    """Turn a userFills response into a trimmed list of recent trades."""
    out: list[dict] = []
    if not isinstance(fills, list):
        return out
    # API returns most-recent-first already, but sort defensively by time desc.
    fills_sorted = sorted(fills, key=lambda f: f.get("time", 0), reverse=True)
    for fill in fills_sorted[:limit]:
        dex, coin = _split_coin(fill.get("coin"))
        out.append(
            {
                "coin": coin,
                "dex": dex,
                "side": "buy" if fill.get("side") == "B" else "sell",
                "px": _f(fill.get("px")),
                "sz": _f(fill.get("sz")),
                "time": fill.get("time", 0),
                "closedPnl": _f(fill.get("closedPnl")),
                "dir": fill.get("dir", ""),
                "fee": _f(fill.get("fee")),
            }
        )
    return out


def _perp_dex_names(perp_dexs_raw: Any) -> list[str]:
    """Extract HIP-3 perp DEX short names from a perpDexs response.

    perpDexs returns a list whose first entry is null (the native DEX) and whose
    remaining entries are objects with a "name" field.
    """
    names: list[str] = []
    if isinstance(perp_dexs_raw, list):
        for dex in perp_dexs_raw:
            if isinstance(dex, dict) and dex.get("name"):
                names.append(dex["name"])
    return names


async def _fetch_perp_states(address: str, dex_names: list[str]) -> dict[str, Any]:
    """Fetch clearinghouseState for each DEX concurrently.

    `dex_names` is a list where "" means the native DEX. Returns a dict keyed by
    DEX name (native under "native") containing only the states that responded, so
    one failing DEX doesn't sink the rest.
    """
    async def one(name: str) -> tuple[str, Any]:
        body = {"type": "clearinghouseState", "user": address}
        if name:
            body["dex"] = name
        return name, await _try_post(body)

    pairs = await asyncio.gather(*[one(n) for n in dex_names])
    return {
        ("native" if name == "" else name): state
        for name, state in pairs
        if state is not None
    }


async def get_wallet(address: str) -> dict:
    """Fetch and normalize a wallet's full Hyperliquid state.

    Positions are gathered across every perp DEX the wallet might use — the native
    DEX plus all HIP-3 builder-deployed DEXes (e.g. equity perps like SP500, PLTR) —
    by enumerating DEXes from `perpDexs` and from the DEX prefixes seen in the
    wallet's fills, then querying each DEX's clearinghouseState directly.
    """
    perp_dexs_raw, spot_raw, spot_meta_raw, fills_raw = await asyncio.gather(
        _try_post({"type": "perpDexs"}),
        _post({"type": "spotClearinghouseState", "user": address}),
        _post({"type": "spotMetaAndAssetCtxs"}),
        _post({"type": "userFills", "user": address}),
    )

    fills = _normalize_fills(fills_raw)

    # Native DEX ("") + every HIP-3 DEX from perpDexs + any DEX seen in the fills.
    dex_names = {""}
    dex_names.update(_perp_dex_names(perp_dexs_raw))
    dex_names.update(f["dex"] for f in fills if f.get("dex"))

    states = await _fetch_perp_states(address, sorted(dex_names))
    summary, positions = _normalize_perps(states)
    prices = _spot_price_map(spot_meta_raw)
    spot = _normalize_spot(spot_raw, prices)

    return {
        "address": address,
        "summary": summary,
        "positions": positions,
        "spot": spot,
        "fills": fills,
    }
