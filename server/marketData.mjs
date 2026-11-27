/**
 * Dual-source market data fetcher:
 * - Primary: Twelve Data Spot API via Fly.io Sprites Custom Connector (zero-key) or local TWELVEDATA_API_KEY
 *   Uses 2 requests per symbol (15m x 600 resampled to 1H/4H + 1d x 210) -> 6 reqs total (< 8 req/min free cap!).
 * - Fallback & US Oil (WTI): Yahoo Finance v8 Chart API (zero API key).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adx, atr, classicPivots, emaLast, resampleBars, rsi, sma } from "./indicators.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SPRITE_GATEWAY_LIST = "https://api.sprites.dev/v1/gateway/list";

const INSTRUMENTS = [
  { symbol: "XAUUSD", name: "Gold", tdSymbol: "XAU/USD", yahooTicker: "GC=F", digits: 2 },
  { symbol: "USDJPY", name: "USD / Yen", tdSymbol: "USD/JPY", yahooTicker: "JPY=X", digits: 3 },
  { symbol: "GBPUSD", name: "GBP / USD", tdSymbol: "GBP/USD", yahooTicker: "GBPUSD=X", digits: 4 },
  { symbol: "USOIL", name: "US Oil (WTI)", tdSymbol: null, yahooTicker: "CL=F", digits: 2 },
];

const CACHE_TTL_MS = 180_000; // 3 minutes
let snapshotCache = { ts: 0, data: null };

export function readEnvKey(keyName) {
  if (process.env[keyName]) return process.env[keyName].trim();
  const candidates = [
    path.join(REPO_ROOT, ".env"),
    path.join(os.homedir(), ".omp", "agent", ".env"),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line.startsWith(`${keyName}=`)) {
        return line.slice(keyName.length + 1).trim().replace(/^["']|["']$/g, "");
      }
    }
  }
  return "";
}

async function discoverTwelveDataConfig() {
  // 1. Prefer Fly.io Sprites zero-key Custom API Connector ("Twelve Data")
  try {
    const resp = await fetch(SPRITE_GATEWAY_LIST, { signal: AbortSignal.timeout(2500) });
    if (resp.ok) {
      const data = await resp.json();
      for (const c of data.connections || []) {
        const label = `${c.provider || ""} ${c.display_name || ""} ${c.provider_account_name || ""}`.toLowerCase();
        if (label.includes("twelve") && c.gateway_base_url) {
          return { baseUrl: c.gateway_base_url.replace(/\/$/, ""), apiKey: null, source: "Twelve Data (Sprite)" };
        }
      }
    }
  } catch {
    // Not on Sprite or gateway unavailable
  }

  // 2. Local .env fallback
  const key = readEnvKey("TWELVEDATA_API_KEY");
  if (key) {
    return { baseUrl: "https://api.twelvedata.com", apiKey: key, source: "Twelve Data Spot" };
  }
  return null;
}

async function fetchTwelveDataBars(tdCfg, tdSymbol, interval, outputsize) {
  const qs = new URLSearchParams({
    symbol: tdSymbol,
    interval,
    outputsize: String(outputsize),
    timezone: "UTC",
  });
  const headers = { "User-Agent": "market-brief/1.0" };
  if (tdCfg.apiKey) {
    headers.Authorization = `apikey ${tdCfg.apiKey}`;
  }
  const resp = await fetch(`${tdCfg.baseUrl}/time_series?${qs.toString()}`, {
    headers,
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`TwelveData HTTP ${resp.status}`);
  const data = await resp.json();
  if (!Array.isArray(data.values) || data.values.length === 0) {
    throw new Error(data.message || "TwelveData empty values");
  }
  const bars = [];
  for (const row of data.values) {
    const dtStr = row.datetime.includes(" ") ? `${row.datetime.replace(" ", "T")}Z` : `${row.datetime}T00:00:00Z`;
    const timeMs = Date.parse(dtStr);
    const open = Number(row.open);
    const high = Number(row.high);
    const low = Number(row.low);
    const close = Number(row.close);
    if (!Number.isFinite(timeMs) || !Number.isFinite(close) || close <= 0) continue;
    bars.push({ timeMs, open, high, low, close, volume: Number(row.volume || 0) });
  }
  bars.sort((a, b) => a.timeMs - b.timeMs);
  return bars;
}

async function fetchYahooBars(ticker, interval, rng) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${rng}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`Yahoo HTTP ${resp.status}`);
  const payload = await resp.json();
  const res = payload?.chart?.result?.[0];
  const timestamps = res?.timestamp || [];
  const q = res?.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null || o <= 0 || h < l) continue;
    bars.push({
      timeMs: timestamps[i] * 1000,
      open: Number(o),
      high: Number(h),
      low: Number(l),
      close: Number(c),
      volume: Number(q.volume?.[i] || 0),
    });
  }
  bars.sort((a, b) => a.timeMs - b.timeMs);
  return bars;
}

function analyzeTf(bars) {
  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1];
  const e20 = emaLast(closes, 20);
  const e50 = emaLast(closes, 50);
  const r14 = rsi(closes, 14);
  const a14 = adx(bars, 14);
  const atr14 = atr(bars, 14);

  let bias = "Neutral";
  if (e20 != null && e50 != null) {
    if (last > e20 && e20 > e50) bias = "Bullish";
    else if (last < e20 && e20 < e50) bias = "Bearish";
    else if (last > e50) bias = "Bullish (pullback)";
    else if (last < e50) bias = "Bearish (bounce)";
  } else if (e20 != null) {
    bias = last > e20 ? "Bullish" : "Bearish";
  }

  let regime = "Moderate trend";
  if (a14 != null && a14 < 18) regime = "Sideways";
  else if (a14 != null && a14 >= 28) regime = "Strong trend";

  return { bias, regime, ema20: e20, ema50: e50, rsi14: r14, adx14: a14, atr14 };
}

function roundOpt(v, digits) {
  return v == null || !Number.isFinite(v) ? null : Number(v.toFixed(digits));
}

async function analyzeInstrument(inst, tdCfg) {
  let bars15m, bars1h, bars4h, bars1d;
  let feedSource = "Yahoo Finance";

  if (tdCfg && inst.tdSymbol) {
    try {
      // Only 2 Twelve Data calls per symbol (6 total across 3 symbols -> under 8/min free cap!)
      const [b15, b1d] = await Promise.all([
        fetchTwelveDataBars(tdCfg, inst.tdSymbol, "15min", 600),
        fetchTwelveDataBars(tdCfg, inst.tdSymbol, "1day", 210),
      ]);
      bars15m = b15;
      bars1h = resampleBars(b15, 60);
      bars4h = resampleBars(b15, 240);
      bars1d = b1d;
      feedSource = tdCfg.source;
    } catch {
      // Fall back cleanly to Yahoo Finance
    }
  }

  if (!bars15m) {
    const [b15, b1h, b1d] = await Promise.all([
      fetchYahooBars(inst.yahooTicker, "15m", "5d"),
      fetchYahooBars(inst.yahooTicker, "1h", "1mo"),
      fetchYahooBars(inst.yahooTicker, "1d", "1y"),
    ]);
    bars15m = b15;
    bars1h = b1h;
    bars4h = resampleBars(b1h, 240);
    bars1d = b1d;
    feedSource = inst.yahooTicker.endsWith("=F") ? `Yahoo Futures (${inst.yahooTicker})` : `Yahoo (${inst.yahooTicker})`;
  }

  const d = inst.digits;
  const livePrice = bars15m[bars15m.length - 1].close;
  const prevDay = bars1d.length >= 2 ? bars1d[bars1d.length - 2] : bars1d[bars1d.length - 1];
  const todayBar = bars1d[bars1d.length - 1];
  const changePct = prevDay.close ? ((livePrice - prevDay.close) / prevDay.close) * 100 : 0;

  const tf15m = analyzeTf(bars15m);
  const tf1h = analyzeTf(bars1h);
  const tf4h = analyzeTf(bars4h);
  const pivots = classicPivots(prevDay);
  const sma200 = sma(bars1d.map((b) => b.close), 200);

  const recent1h = bars1h.slice(-20);
  const res1h = Math.max(...recent1h.map((b) => b.high));
  const sup1h = Math.min(...recent1h.map((b) => b.low));

  return {
    symbol: inst.symbol,
    name: inst.name,
    source: feedSource,
    digits: d,
    price: Number(livePrice.toFixed(d)),
    changePct: Number(changePct.toFixed(2)),
    todayHigh: Number(todayBar.high.toFixed(d)),
    todayLow: Number(todayBar.low.toFixed(d)),
    sma200_1d: roundOpt(sma200, d),
    pivots: {
      P: Number(pivots.P.toFixed(d)),
      R1: Number(pivots.R1.toFixed(d)),
      R2: Number(pivots.R2.toFixed(d)),
      S1: Number(pivots.S1.toFixed(d)),
      S2: Number(pivots.S2.toFixed(d)),
    },
    intradayRes1h: Number(res1h.toFixed(d)),
    intradaySup1h: Number(sup1h.toFixed(d)),
    tf15m: { bias: tf15m.bias, rsi14: roundOpt(tf15m.rsi14, 1) },
    tf1h: {
      bias: tf1h.bias,
      regime: tf1h.regime,
      ema20: roundOpt(tf1h.ema20, d),
      ema50: roundOpt(tf1h.ema50, d),
      rsi14: roundOpt(tf1h.rsi14, 1),
      adx14: roundOpt(tf1h.adx14, 1),
      atr14: roundOpt(tf1h.atr14, d),
    },
    tf4h: {
      bias: tf4h.bias,
      regime: tf4h.regime,
      rsi14: roundOpt(tf4h.rsi14, 1),
      adx14: roundOpt(tf4h.adx14, 1),
      atr14: roundOpt(tf4h.atr14, d),
    },
  };
}

function getTodayMacroAlerts(now) {
  const alerts = [];
  const utcDay = now.getUTCDay();
  const utcDate = now.getUTCDate();
  if (utcDay === 3) {
    alerts.push({ timeWib: "22:30 WIB", event: "US EIA Crude Oil Inventories (dampak tinggi ke USOIL)" });
  }
  if (utcDay === 5 && utcDate <= 7) {
    alerts.push({ timeWib: "20:30 WIB", event: "US Non-Farm Payrolls (NFP) — volatilitas tinggi Gold, USDJPY, GBPUSD" });
  }
  return alerts;
}

export async function getMarketSnapshot(forceRefresh = false) {
  const nowMs = Date.now();
  if (!forceRefresh && snapshotCache.data && nowMs - snapshotCache.ts < CACHE_TTL_MS) {
    return snapshotCache.data;
  }

  const tdCfg = await discoverTwelveDataConfig();
  const settled = await Promise.allSettled(INSTRUMENTS.map((inst) => analyzeInstrument(inst, tdCfg)));

  const assets = [];
  const errors = [];
  settled.forEach((r, idx) => {
    if (r.status === "fulfilled") assets.push(r.value);
    else errors.push(`${INSTRUMENTS[idx].symbol}: ${r.reason?.message || r.reason}`);
  });

  const now = new Date();
  const wibStr = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(now) + " WIB";

  const payload = {
    updatedWib: wibStr,
    updatedUtc: now.toISOString().slice(0, 16).replace("T", " ") + " UTC",
    assets,
    macroAlerts: getTodayMacroAlerts(now),
    errors,
  };
  snapshotCache = { ts: nowMs, data: payload };
  return payload;
}
