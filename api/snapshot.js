// /api/snapshot.js
// =============================================================================
//  BTC Live Snapshot v3 · Vercel Edge Function
// =============================================================================
//  Penambahan vs v2:
//   • Multi-timeframe klines (1h/4h/1d) untuk confluence higher-TF
//   • Open Interest history (24 candle 1h)
//   • Long/Short ratio (top trader + global retail) → smart money divergence
//   • Taker buy/sell volume (aggressor pressure)
//   • Pre-computed TA indicators: RSI, MACD, Bollinger, EMA, trend
//
//  Total endpoint fetch: 16 (semua paralel via Promise.allSettled)
//  Target latency: < 3 detik di Vercel Edge
// =============================================================================

export const config = { runtime: 'edge' };

// ─────────────────────────────────────────────────────────────────────────────
//  Fetch helpers (with timeout)
// ─────────────────────────────────────────────────────────────────────────────
const TIMEOUT_DEFAULT = 5000;
const TIMEOUT_SLOW    = 9000;   // ← untuk CoinGecko & sumber yang sering lambat

// ── Retry sekali untuk sumber yang sering transient-fail ─────────────────────
// Hanya retry untuk network error atau 5xx. Tidak retry 429 (rate limit sudah
// pasti gagal lagi) atau 404 (tidak ada data, retry sia-sia).
async function fetchJSONRetry(url, timeout = TIMEOUT_SLOW) {
  try {
    return await fetchJSON(url, timeout);
  } catch (e) {
    // Jangan retry kalau rate limited atau not found — buang waktu saja
    const status = e.message?.match(/HTTP (\d+)/)?.[1];
    if (status === '429' || status === '404' || status === '403') throw e;
    await new Promise(r => setTimeout(r, 800));
    return fetchJSON(url, timeout);
  }
}

async function fetchJSON(url, timeout = TIMEOUT_DEFAULT) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'accept': 'application/json', 'user-agent': 'btc-bandarmologi/3.0' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} · ${url.slice(0, 80)}`);
    return await r.json();
  } finally {
    clearTimeout(tid);
  }
}

async function fetchText(url, timeout = TIMEOUT_DEFAULT) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} · ${url.slice(0, 80)}`);
    return await r.text();
  } finally {
    clearTimeout(tid);
  }
}

// =============================================================================
//  TA INDICATOR COMPUTATIONS (pure functions)
// =============================================================================

/** Exponential Moving Average — array result */
function emaSeries(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  let e = values[0];
  const out = [e];
  for (let i = 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

/** EMA last value only */
function ema(values, period) {
  const s = emaSeries(values, period);
  return s.length ? s[s.length - 1] : null;
}

/** Relative Strength Index (Wilder's smoothing) */
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  // Initial averages from first `period` diffs
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += -d;
  }
  let avgG = gains / period;
  let avgL = losses / period;
  // Wilder smoothing for remaining
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - (100 / (1 + rs));
}

/** MACD(12,26,9) → { macd, signal, histogram, bullish } */
function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (closes.length < slow + signalPeriod) return null;
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const sigSeries = emaSeries(macdLine.slice(slow - 1), signalPeriod);
  const macdNow = macdLine[macdLine.length - 1];
  const sigNow = sigSeries[sigSeries.length - 1];
  const hist = macdNow - sigNow;
  // Previous hist untuk lihat momentum direction
  const prevSig = sigSeries[sigSeries.length - 2];
  const prevMacd = macdLine[macdLine.length - 2];
  const prevHist = prevMacd - prevSig;
  return {
    macd: macdNow,
    signal: sigNow,
    histogram: hist,
    bullish: hist > 0,
    momentum: hist > prevHist ? 'RISING' : 'FALLING',
  };
}

/** Bollinger Bands(20, 2σ) */
function bollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mean + mult * sd;
  const lower = mean - mult * sd;
  const current = closes[closes.length - 1];
  return {
    upper, middle: mean, lower,
    widthPct: ((upper - lower) / mean) * 100,  // squeeze: < 4% = sangat sempit
    position: (current - lower) / (upper - lower),  // 0 = at lower, 1 = at upper
  };
}

/** Trend classification dari EMA21/55/200 alignment */
function trendFromEMA(price, ema21, ema55, ema200) {
  if (ema21 == null || ema55 == null) return 'NEUTRAL';
  const bullStack = ema21 > ema55 && (ema200 == null || ema55 > ema200);
  const bearStack = ema21 < ema55 && (ema200 == null || ema55 < ema200);
  if (bullStack && price > ema21) return 'BULLISH';
  if (bearStack && price < ema21) return 'BEARISH';
  return 'NEUTRAL';
}

/** Compute semua indicator untuk satu timeframe (closes only — backward compat) */
function computeIndicators(closes) {
  if (!closes || closes.length < 30) return null;
  const last = closes[closes.length - 1];
  const ema21v = ema(closes, 21);
  const ema55v = ema(closes, 55);
  const ema200v = closes.length >= 200 ? ema(closes, 200) : null;
  return {
    rsi: rsi(closes, 14),
    macd: macd(closes),
    bb: bollinger(closes),
    ema21: ema21v,
    ema55: ema55v,
    ema200: ema200v,
    trend: trendFromEMA(last, ema21v, ema55v, ema200v),
  };
}

// =============================================================================
//  ADVANCED METRICS (v5.3) — ATR, VWAP, Volume, Swing S/R
//  Semua dihitung dari OHLCV Binance — no extra API, no rate limit
// =============================================================================

/** Average True Range — ukuran volatilitas untuk grounding SL/TP */
function atr(highs, lows, closes, period = 14) {
  if (highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  // Wilder smoothing
  let a = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    a = (a * (period - 1) + trs[i]) / period;
  }
  return a;
}

/** Rolling VWAP atas N candle terakhir (typical price × volume) */
function vwap(highs, lows, closes, volumes, period = 24) {
  const n = Math.min(period, closes.length);
  if (n < 2) return null;
  let pv = 0, vol = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const typical = (highs[i] + lows[i] + closes[i]) / 3;
    pv += typical * volumes[i];
    vol += volumes[i];
  }
  return vol > 0 ? pv / vol : null;
}

/** Analisis volume: tren naik/turun + spike detection */
function volumeAnalysis(volumes) {
  if (volumes.length < 20) return null;
  const recent = volumes.slice(-6);
  const earlier = volumes.slice(-24, -6);
  const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
  const earlierAvg = earlier.reduce((s, v) => s + v, 0) / (earlier.length || 1);
  const lastVol = volumes[volumes.length - 1];
  const baseAvg = volumes.slice(-20).reduce((s, v) => s + v, 0) / 20;
  return {
    trend: recentAvg > earlierAvg * 1.15 ? 'RISING'
         : recentAvg < earlierAvg * 0.85 ? 'FALLING' : 'STABLE',
    spike: lastVol > baseAvg * 1.8,           // candle terakhir volume spike?
    relativeToAvg: baseAvg > 0 ? lastVol / baseAvg : 1,
  };
}

/** Swing high/low (pivot points) untuk support/resistance riil dari price action */
function swingLevels(highs, lows, lookback = 2) {
  const resistances = [], supports = [];
  for (let i = lookback; i < highs.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) isHigh = false;
      if (lows[i]  >= lows[i - j]  || lows[i]  >= lows[i + j])  isLow = false;
    }
    if (isHigh) resistances.push(highs[i]);
    if (isLow) supports.push(lows[i]);
  }
  const lastPrice = lows[lows.length - 1];
  // Resistance terdekat di ATAS harga, support terdekat di BAWAH harga
  const nearestRes = resistances.filter(r => r > highs[highs.length - 1]).sort((a, b) => a - b)[0] || null;
  const nearestSup = supports.filter(s => s < lows[lows.length - 1]).sort((a, b) => b - a)[0] || null;
  return {
    nearestResistance: nearestRes,
    nearestSupport: nearestSup,
    recentHigh: Math.max(...highs),
    recentLow: Math.min(...lows),
  };
}

/** Compute indikator lanjutan dari OHLCV */
function computeAdvanced(ohlcv) {
  if (!ohlcv || ohlcv.closes.length < 20) return null;
  const { highs, lows, closes, volumes } = ohlcv;
  const atrVal = atr(highs, lows, closes);
  const last = closes[closes.length - 1];
  return {
    atr: atrVal,
    atrPct: atrVal && last ? (atrVal / last) * 100 : null,  // ATR sebagai % harga
    vwap: vwap(highs, lows, closes, volumes),
    volume: volumeAnalysis(volumes),
    swing: swingLevels(highs, lows),
  };
}

/**
 * Derive market stats dari daily klines (PENGGANTI CoinGecko coins endpoint
 * yang sering kena 429 di shared IP Vercel).
 */
function deriveMarketStats(d1ohlcv, currentPrice, circulatingSupply) {
  if (!d1ohlcv || d1ohlcv.closes.length < 8) return null;
  const closes = d1ohlcv.closes;
  const highs = d1ohlcv.highs;
  const n = closes.length;
  const price = currentPrice || closes[n - 1];

  const change7d = n >= 8 ? ((price - closes[n - 8]) / closes[n - 8]) * 100 : null;
  const change30d = n >= 31 ? ((price - closes[n - 31]) / closes[n - 31]) * 100 : null;

  // ATH proxy: high tertinggi dalam data yang ada (~100 hari = cycle high terkini)
  const cycleHigh = Math.max(...highs);
  const athDistance = cycleHigh ? ((price - cycleHigh) / cycleHigh) * 100 : null;

  // Market cap = harga × circulating supply (dari blockchain.info)
  const marketCap = circulatingSupply ? price * circulatingSupply : null;

  return {
    change7d, change30d,
    cycleHigh,
    athDistance,          // distance dari cycle high (proxy ATH untuk trading)
    marketCap,
    source: 'computed',   // tanda: dihitung lokal, bukan dari CoinGecko
  };
}


// =============================================================================
//  COIN CONFIG (v9) — semua identifier per-venue & feature flag per coin
//  Sumber yang tidak tersedia untuk sebuah coin di-skip via flag hasX,
//  ditandai notApplicable di sourceHealth (bukan error/degraded).
// =============================================================================
const COINS = {
  BTC: {
    symbol: 'BTC', name: 'Bitcoin',
    binance: 'BTCUSDT', okxSwap: 'BTC-USDT-SWAP', okxFamily: 'BTC-USDT', okxCtVal: 0.01,
    bitfinex: 'tBTCUSD', coinbase: 'BTC-USD', upbit: 'KRW-BTC', hl: 'BTC',
    deribit: 'BTC', yahooFut: 'BTC=F', soso: 'us-btc-spot', coinalyze: 'BTCUSDT_PERP.A',
    cotMarket: 'BITCOIN - CHICAGO MERCANTILE EXCHANGE', cm: 'btc', cryptopanic: 'BTC',
    pmSearch: /bitcoin|btc/i,
    hasNupl: true, hasMiner: true, hasNetwork: true, hasDvol: true, hasOptions: true,
  },
  ETH: {
    symbol: 'ETH', name: 'Ethereum',
    binance: 'ETHUSDT', okxSwap: 'ETH-USDT-SWAP', okxFamily: 'ETH-USDT', okxCtVal: 0.1,
    bitfinex: 'tETHUSD', coinbase: 'ETH-USD', upbit: 'KRW-ETH', hl: 'ETH',
    deribit: 'ETH', yahooFut: 'ETH=F', soso: 'us-eth-spot', coinalyze: 'ETHUSDT_PERP.A',
    cotMarket: 'ETHER CASH SETTLED - CHICAGO MERCANTILE EXCHANGE', cm: 'eth', cryptopanic: 'ETH',
    pmSearch: /ethereum|\beth\b/i,
    hasNupl: false, hasMiner: false, hasNetwork: false, hasDvol: true, hasOptions: true,
  },
  SOL: {
    symbol: 'SOL', name: 'Solana',
    binance: 'SOLUSDT', okxSwap: 'SOL-USDT-SWAP', okxFamily: 'SOL-USDT', okxCtVal: 1,
    bitfinex: 'tSOLUSD', coinbase: 'SOL-USD', upbit: 'KRW-SOL', hl: 'SOL',
    deribit: null, yahooFut: 'SOL=F', soso: 'us-sol-spot', coinalyze: 'SOLUSDT_PERP.A',
    cotMarket: 'SOL - CHICAGO MERCANTILE EXCHANGE', cm: 'sol', cryptopanic: 'SOL',
    pmSearch: /solana|\bsol\b/i,
    hasNupl: false, hasMiner: false, hasNetwork: false, hasDvol: false, hasOptions: false,
  },
  XRP: {
    symbol: 'XRP', name: 'XRP',
    binance: 'XRPUSDT', okxSwap: 'XRP-USDT-SWAP', okxFamily: 'XRP-USDT', okxCtVal: 100,
    bitfinex: 'tXRPUSD', coinbase: 'XRP-USD', upbit: 'KRW-XRP', hl: 'XRP',
    deribit: null, yahooFut: 'XRP=F', soso: 'us-xrp-spot', coinalyze: 'XRPUSDT_PERP.A',
    cotMarket: 'XRP - CHICAGO MERCANTILE EXCHANGE', cm: 'xrp', cryptopanic: 'XRP',
    pmSearch: /\bxrp\b|ripple/i,
    hasNupl: false, hasMiner: false, hasNetwork: false, hasDvol: false, hasOptions: false,
  },
};

// =============================================================================
//  DATA SOURCES
// =============================================================================

async function sourceTicker(cfg) {
  const d = await fetchJSON(`https://api.binance.com/api/v3/ticker/24hr?symbol=${cfg.binance}`);
  return {
    price: +d.lastPrice,
    change24h: +d.priceChangePercent,
    volume24h: +d.quoteVolume,
    high24h: +d.highPrice,
    low24h: +d.lowPrice,
  };
}

async function sourceOrderBook(cfg) {
  const d = await fetchJSON(`https://api.binance.com/api/v3/depth?symbol=${cfg.binance}&limit=500`);
  const toWall = arr => arr
    .map(r => ({ price: +r[0], qty: +r[1], total: +r[0] * +r[1] }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
  const bids = toWall(d.bids);
  const asks = toWall(d.asks);
  const bidWall = bids.reduce((s, b) => s + b.total, 0);
  const askWall = asks.reduce((s, a) => s + a.total, 0);
  return { bids, asks, bidWall, askWall, ratio: bidWall / (bidWall + askWall) };
}

async function sourceFunding(cfg) {
  const d = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${cfg.binance}`);
  return {
    fundingRate: +d.lastFundingRate * 100,
    markPrice: +d.markPrice,
    nextFundingTime: d.nextFundingTime,
  };
}

async function sourceKlinesMulti(cfg) {
  // Fetch 3 timeframe paralel
  const [r1h, r4h, r1d] = await Promise.all([
    fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${cfg.binance}&interval=1h&limit=200`),
    fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${cfg.binance}&interval=4h&limit=100`),
    fetchJSON(`https://api.binance.com/api/v3/klines?symbol=${cfg.binance}&interval=1d&limit=100`),
  ]);
  // Binance kline format: [openTime, open, high, low, close, volume, ...]
  const parse = r => ({
    opens:   r.map(k => +k[1]),
    highs:   r.map(k => +k[2]),
    lows:    r.map(k => +k[3]),
    closes:  r.map(k => +k[4]),
    volumes: r.map(k => +k[5]),
  });
  return {
    h1: parse(r1h),
    h4: parse(r4h),
    d1: parse(r1d),
  };
}

/** Circulating supply BTC dari blockchain.info (free, no rate limit shared IP) */
async function sourceSupply() {
  const txt = await fetchText('https://blockchain.info/q/totalbc');  // dalam satoshi
  const sats = +txt;
  return sats > 0 ? sats / 1e8 : null;  // konversi ke BTC
}

// ──────────────────────────────────────────────────────────────
//  NEW v3: Derivatives intelligence (Binance Futures public API)
// ──────────────────────────────────────────────────────────────

async function sourceOpenInterestHist(cfg) {
  const d = await fetchJSON(
    `https://fapi.binance.com/futures/data/openInterestHist?symbol=${cfg.binance}&period=1h&limit=24`
  );
  if (!d || !d.length) return null;
  // d[i] = { timestamp, sumOpenInterest, sumOpenInterestValue }
  const oiValues = d.map(x => +x.sumOpenInterestValue); // dalam USD
  const oiNow = oiValues[oiValues.length - 1];
  const oi24hAgo = oiValues[0];
  const changePct = ((oiNow - oi24hAgo) / oi24hAgo) * 100;
  return {
    current: oiNow,
    change24h: changePct,
    history: oiValues,                          // untuk visual nanti
    timestamps: d.map(x => +x.timestamp),
  };
}

async function sourceLongShortRatios(cfg) {
  // Dua endpoint paralel: top trader vs global retail
  const [top, global] = await Promise.all([
    fetchJSON(`https://fapi.binance.com/futures/data/topLongShortAccountRatio?symbol=${cfg.binance}&period=1h&limit=24`),
    fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${cfg.binance}&period=1h&limit=24`),
  ]);
  if (!top?.length || !global?.length) return null;
  const lastTop    = +top[top.length - 1].longShortRatio;
  const lastGlobal = +global[global.length - 1].longShortRatio;
  const prevTop    = +top[0].longShortRatio;
  const prevGlobal = +global[0].longShortRatio;

  // Divergence absolut (untuk kompatibilitas)
  const divergence = lastTop - lastGlobal;

  // Z-score divergence: lebih robust dari threshold absolut.
  // Bandingkan divergence sekarang vs distribusi 24 jam terakhir.
  const topHistory    = top.map(x => +x.longShortRatio);
  const globalHistory = global.map(x => +x.longShortRatio);
  const divHistory    = topHistory.map((v, i) => v - (globalHistory[i] || v));
  const divMean = divHistory.reduce((a, b) => a + b, 0) / divHistory.length;
  const divStd  = Math.sqrt(divHistory.reduce((s, v) => s + (v - divMean) ** 2, 0) / divHistory.length) || 0.01;
  const divZScore = (divergence - divMean) / divStd;

  // Bias berbasis z-score (>1.5 sigma lebih reliable dari threshold absolut)
  let smartMoneyBias = 'NEUTRAL';
  if (divZScore > 1.5)       smartMoneyBias = 'SMART_LONG_RETAIL_SHORT';
  else if (divZScore < -1.5) smartMoneyBias = 'SMART_SHORT_RETAIL_LONG';
  else if (lastTop > lastGlobal * 1.3 && lastTop > 1.2) smartMoneyBias = 'LONG';
  else if (lastTop < lastGlobal * 0.75 && lastGlobal > 1.0) smartMoneyBias = 'SHORT';

  return {
    topTrader: { current: lastTop, prev24h: prevTop, trend: lastTop > prevTop ? 'RISING' : 'FALLING' },
    global:    { current: lastGlobal, prev24h: prevGlobal, trend: lastGlobal > prevGlobal ? 'RISING' : 'FALLING' },
    divergence,
    divZScore: +divZScore.toFixed(2),
    smartMoneyBias,
    topHistory,
    globalHistory,
  };
}

async function sourceTakerVolume(cfg) {
  const d = await fetchJSON(
    `https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${cfg.binance}&period=1h&limit=24`
  );
  if (!d || !d.length) return null;
  // d[i] = { buySellRatio, buyVol, sellVol, timestamp }
  const ratios = d.map(x => +x.buySellRatio);
  const ratioNow = ratios[ratios.length - 1];
  const avg24h = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  // Trend: rata-rata 6 jam terakhir vs 18 jam sebelumnya
  const recent6 = ratios.slice(-6).reduce((a, b) => a + b, 0) / 6;
  const earlier18 = ratios.slice(0, -6).reduce((a, b) => a + b, 0) / Math.max(ratios.length - 6, 1);
  let trend = 'NEUTRAL';
  if (recent6 > earlier18 * 1.05 && recent6 > 1) trend = 'RISING_BUY';
  else if (recent6 < earlier18 * 0.95 && recent6 < 1) trend = 'RISING_SELL';
  return {
    current: ratioNow,
    avg24h,
    trend,
    history: ratios,
  };
}

async function sourceFearGreed() {
  const d = await fetchJSON('https://api.alternative.me/fng/?limit=30');
  return {
    value: +d.data[0].value,
    label: d.data[0].value_classification,
    history: d.data.slice().reverse().map(x => ({ ts: +x.timestamp * 1000, v: +x.value })),
  };
}

// sourceCoinGecko dihapus (dead code — sudah keluar dari SOURCES sejak v5.3,
// market stats dihitung dari Binance klines).

// CoinGecko global — best effort untuk BTC dominance (non-kritis).
async function sourceGlobal(cfg) {
  const d = await fetchJSON('https://api.coingecko.com/api/v3/global', 7000);
  return {
    btcDominance: d.data.market_cap_percentage.btc,
    // v9: dominance coin aktif (CoinGecko punya btc/eth/sol/xrp di top-10)
    coinDominance: d.data.market_cap_percentage[cfg.cm] ?? null,
    totalMcap: d.data.total_market_cap.usd,
  };
}

async function sourceMempool() {
  return fetchJSON('https://mempool.space/api/v1/fees/recommended');
}

async function sourceNetwork() {
  const [hashrate, difficulty, height] = await Promise.all([
    fetchText('https://blockchain.info/q/hashrate'),
    fetchText('https://blockchain.info/q/getdifficulty'),
    fetchText('https://blockchain.info/q/getblockcount'),
  ]);
  return { hashrate: +hashrate, difficulty: +difficulty, blockHeight: +height };
}

// News: CryptoCompare tanpa key makin di-throttle di shared IP.
// Strategi: coba CryptoCompare dulu, fallback ke CoinDesk RSS kalau gagal.
async function sourceNews() {
  // Primary: CryptoCompare
  try {
    const d = await fetchJSON(
      'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=BTC&sortOrder=popular&limit=8',
      6000
    );
    if (d?.Data?.length) {
      return d.Data.slice(0, 8).map(n => ({
        title: n.title,
        source: n.source_info?.name || n.source || 'unknown',
        ts: n.published_on * 1000,
        url: n.url,
      }));
    }
    throw new Error('empty');
  } catch (_) {
    // Fallback: CoinDesk RSS (gratis, no key, no rate limit)
    const xml = await fetchText('https://www.coindesk.com/arc/outboundfeeds/rss/', 6000);
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) && items.length < 8) {
      const block = m[1];
      const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
      const link  = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
      const date  = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
      if (title) {
        items.push({
          title: title.trim(),
          source: 'CoinDesk',
          ts: date ? new Date(date).getTime() : Date.now(),
          url: link.trim(),
        });
      }
    }
    return items;
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  NEW v4: Options flow (Deribit public API)
// ──────────────────────────────────────────────────────────────────────────

async function sourceDeribitOptions(cfg) {
  // Deribit returns ALL options summary untuk satu currency dalam satu call
  const d = await fetchJSON(
    `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${cfg.deribit}&kind=option`,
    6000
  );
  if (!d?.result?.length) return null;
  const opts = d.result;

  // Parse instrument_name: "BTC-25APR25-90000-C" / "ETH-..." → expiry, strike, type
  const parsed = opts.map(o => {
    const parts = o.instrument_name.split('-');
    if (parts.length !== 4) return null;
    const [, expiryStr, strikeStr, typeChar] = parts;
    const strike = +strikeStr;
    const type = typeChar; // 'C' or 'P'
    // Parse expiry like "25APR25" → date
    const m = expiryStr.match(/^(\d+)([A-Z]+)(\d+)$/);
    if (!m) return null;
    const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
    const monthNum = months[m[2]];
    if (monthNum === undefined) return null;
    const day = +m[1];
    const year = 2000 + +m[3];
    const expiry = new Date(Date.UTC(year, monthNum, day, 8, 0, 0)).getTime();
    return {
      strike,
      type,
      expiry,
      volume: +o.volume || 0,             // 24h volume
      openInterest: +o.open_interest || 0,// OI in contracts
      markPrice: +o.mark_price || 0,
      underlying: +o.underlying_price || 0,
    };
  }).filter(Boolean);

  if (!parsed.length) return null;
  const underlying = parsed[0].underlying;

  // ── Aggregate PCR (volume + OI) ───────────────────────────────────────
  let callVol = 0, putVol = 0, callOI = 0, putOI = 0;
  for (const o of parsed) {
    if (o.type === 'C') { callVol += o.volume; callOI += o.openInterest; }
    else                { putVol  += o.volume; putOI  += o.openInterest; }
  }
  const pcrVolume = callVol > 0 ? putVol / callVol : null;
  const pcrOI     = callOI > 0 ? putOI / callOI : null;

  // ── Max pain untuk expiry terdekat ────────────────────────────────────
  // Group by expiry, ambil expiry terdekat dari now
  const now = Date.now();
  const futureExpiries = [...new Set(parsed.map(o => o.expiry))].filter(e => e > now).sort();
  const nearestExpiry = futureExpiries[0];
  const nearExpiryOpts = parsed.filter(o => o.expiry === nearestExpiry && o.openInterest > 0);

  let maxPain = null, maxPainStrikes = null;
  if (nearExpiryOpts.length > 5) {
    const strikes = [...new Set(nearExpiryOpts.map(o => o.strike))].sort((a, b) => a - b);
    // Untuk tiap strike candidate, hitung total dollar loss ke option holders
    // (= total cash payout dari penjual ke pembeli kalau settle di strike itu)
    let bestStrike = strikes[0], minLoss = Infinity;
    for (const s of strikes) {
      let loss = 0;
      for (const o of nearExpiryOpts) {
        if (o.type === 'C' && s > o.strike) loss += (s - o.strike) * o.openInterest;
        else if (o.type === 'P' && s < o.strike) loss += (o.strike - s) * o.openInterest;
      }
      if (loss < minLoss) { minLoss = loss; bestStrike = s; }
    }
    maxPain = bestStrike;
    maxPainStrikes = strikes.length;
  }

  // ── Bias signals ──────────────────────────────────────────────────────
  let pcrSignal = 'NEUTRAL';
  if (pcrOI != null) {
    if (pcrOI > 1.0) pcrSignal = 'BEARISH_HEAVY';   // too many puts vs calls
    else if (pcrOI > 0.7) pcrSignal = 'BEARISH';
    else if (pcrOI < 0.5) pcrSignal = 'BULLISH';    // calls dominant
    else if (pcrOI < 0.35) pcrSignal = 'BULLISH_HEAVY'; // extreme bullish (contrarian)
  }

  // Max pain magnetism: berapa % jarak harga sekarang vs max pain
  const maxPainGap = maxPain && underlying
    ? ((maxPain - underlying) / underlying) * 100
    : null;

  return {
    pcrVolume,
    pcrOI,
    pcrSignal,
    maxPain,
    maxPainGap,            // % gap dari spot
    nearestExpiry,
    callVol, putVol,
    callOI, putOI,
    underlying,
    optionsCount: parsed.length,
  };
}

// ──────────────────────────────────────────────────────────────────────────
//  NEW v4: On-chain metrics (CoinMetrics Community API - free, no key)
// ──────────────────────────────────────────────────────────────────────────

async function sourceCoinMetrics(cfg) {
  // Free Community API — daily data, last 30 days for context
  const url = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics'
    + `?assets=${cfg.cm}`
    + '&metrics=CapMVRVCur,SplyCur,PriceUSD'
    + '&page_size=30&pretty=false';
  const d = await fetchJSON(url, 6000);
  if (!d?.data?.length) return null;

  const rows = d.data.map(r => ({
    date: r.time,
    mvrv: r.CapMVRVCur ? +r.CapMVRVCur : null,
    price: r.PriceUSD ? +r.PriceUSD : null,
    supply: r.SplyCur ? +r.SplyCur : null,
  })).filter(r => r.mvrv != null);

  if (!rows.length) return null;

  const latest = rows[rows.length - 1];
  // Realized price approximation: market price / MVRV
  const realizedPrice = latest.price && latest.mvrv ? latest.price / latest.mvrv : null;

  // Historical context: persentil current MVRV terhadap last 30 days
  const mvrvValues = rows.map(r => r.mvrv).sort((a, b) => a - b);
  const idx = mvrvValues.findIndex(v => v >= latest.mvrv);
  const mvrvPercentile = idx === -1 ? 100 : (idx / mvrvValues.length) * 100;

  // MVRV signal classification (berdasarkan historical thresholds)
  let mvrvSignal = 'NEUTRAL';
  if (latest.mvrv >= 3.5)       mvrvSignal = 'CYCLE_TOP';     // historically overvalued
  else if (latest.mvrv >= 2.5)  mvrvSignal = 'OVERVALUED';
  else if (latest.mvrv >= 1.5)  mvrvSignal = 'BULLISH';
  else if (latest.mvrv >= 1.0)  mvrvSignal = 'FAIR_VALUE';
  else if (latest.mvrv >= 0.8)  mvrvSignal = 'UNDERVALUED';
  else                          mvrvSignal = 'CYCLE_BOTTOM';  // historically rare buy zone

  return {
    mvrv: latest.mvrv,
    realizedPrice,
    mvrvSignal,
    mvrvPercentile30d: mvrvPercentile,
    history: rows.map(r => ({ date: r.date, mvrv: r.mvrv, price: r.price })),
  };
}

// ──────────────────────────────────────────────────────────────────────────
//  NEW v4: Macro context (Stooq CSV - free, no key)
// ──────────────────────────────────────────────────────────────────────────

function parseStooqCsv(text) {
  // Format: "Symbol,Date,Time,Open,High,Low,Close,Volume"
  const lines = text.trim().split('\n');
  if (lines.length < 2) return null;
  const row = lines[1].split(',');
  if (row.length < 7) return null;
  return {
    date: row[1],
    open: +row[3],
    close: +row[6],
    changePct: row[3] && row[6] ? ((+row[6] - +row[3]) / +row[3]) * 100 : null,
  };
}

// Yahoo Finance chart API (unofficial tapi jauh lebih stabil dari Stooq di
// shared IP Vercel). Return { close, changePct } atau null.
async function yahooQuote(symbol) {
  const d = await fetchJSON(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
    6000
  );
  const res = d?.chart?.result?.[0];
  if (!res) return null;
  const meta = res.meta || {};
  const closes = (res.indicators?.quote?.[0]?.close || []).filter(v => v != null);
  const price = meta.regularMarketPrice ?? closes[closes.length - 1] ?? null;
  const prev  = meta.chartPreviousClose ?? closes[closes.length - 2] ?? null;
  if (price == null) return null;
  return {
    close: +price,
    changePct: prev ? ((price - prev) / prev) * 100 : null,
  };
}

// Macro v8: Yahoo primary (no key), Stooq fallback (sering throttle).
async function sourceMacro() {
  let [dxy, gold, spx] = await Promise.all([
    yahooQuote('DX-Y.NYB').catch(() => null),
    yahooQuote('GC=F').catch(() => null),
    yahooQuote('^GSPC').catch(() => null),
  ]);
  let source = 'yahoo';

  if (!dxy && !gold && !spx) {
    // Fallback: Stooq CSV
    const [dxyTxt, goldTxt, spxTxt] = await Promise.all([
      fetchText('https://stooq.com/q/l/?s=dx.f&f=sd2t2ohlcv&h&e=csv', 5000).catch(() => null),
      fetchText('https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv', 5000).catch(() => null),
      fetchText('https://stooq.com/q/l/?s=^spx&f=sd2t2ohlcv&h&e=csv',   5000).catch(() => null),
    ]);
    dxy  = dxyTxt  ? parseStooqCsv(dxyTxt)  : null;
    gold = goldTxt ? parseStooqCsv(goldTxt) : null;
    spx  = spxTxt  ? parseStooqCsv(spxTxt)  : null;
    source = 'stooq';
  }
  if (!dxy && !gold && !spx) return null;

  // Risk environment classification
  // - DXY naik tajam (>0.5%) + SPX turun = risk-off (BTC tends to drop)
  // - DXY turun + SPX naik = risk-on (BTC tends to pump)
  let riskRegime = 'NEUTRAL';
  if (dxy && spx) {
    if (dxy.changePct > 0.3 && spx.changePct < -0.3)      riskRegime = 'RISK_OFF';
    else if (dxy.changePct < -0.3 && spx.changePct > 0.3) riskRegime = 'RISK_ON';
    else if (dxy.changePct > 0.5)                          riskRegime = 'DOLLAR_STRENGTH';
    else if (dxy.changePct < -0.5)                         riskRegime = 'DOLLAR_WEAKNESS';
  }

  return {
    dxy,
    gold,
    spx,
    riskRegime,
    source,
  };
}

// =============================================================================
//  NEW v6: Institutional & cross-exchange flow (bandarmologi penguat)
// =============================================================================

// ── Stablecoin supply (DefiLlama, free no key) — "dry powder" likuiditas ────
async function sourceStablecoins() {
  const d = await fetchJSON('https://stablecoins.llama.fi/stablecoins?includePrices=false', 7000);
  if (!d?.peggedAssets?.length) return null;
  // Ambil USD-pegged terbesar (USDT, USDC, DAI, dst)
  let totalNow = 0, totalPrevDay = 0, totalPrevWeek = 0;
  const top = [];
  for (const a of d.peggedAssets) {
    const circ = a.circulating?.peggedUSD || 0;
    const prevDay = a.circulatingPrevDay?.peggedUSD || circ;
    const prevWeek = a.circulatingPrevWeek?.peggedUSD || circ;
    if (circ > 0) {
      totalNow += circ;
      totalPrevDay += prevDay;
      totalPrevWeek += prevWeek;
      if (top.length < 4) top.push({ symbol: a.symbol, circulating: circ });
    }
  }
  if (totalNow === 0) return null;
  const change24h = totalPrevDay ? ((totalNow - totalPrevDay) / totalPrevDay) * 100 : null;
  const change7d  = totalPrevWeek ? ((totalNow - totalPrevWeek) / totalPrevWeek) * 100 : null;
  // Interpretasi: supply naik = dry powder bertambah (bullish liquidity)
  let liquiditySignal = 'NEUTRAL';
  if (change7d != null) {
    // Threshold diturunkan dari 1% ke 0.4% — pertumbuhan stablecoin normal 0.3-0.7%/minggu
    if (change7d > 0.4) liquiditySignal = 'EXPANDING';
    else if (change7d < -0.4) liquiditySignal = 'CONTRACTING';
  }
  return { total: totalNow, change24h, change7d, liquiditySignal, top };
}

// ── Bitcoin ETF flows (SoSoValue Open API — BUTUH FREE KEY) ──────────────────
// Endpoint lama sosovalue.xyz/api/... TIDAK PERNAH ADA (dead code v6) — diganti
// Open API resmi. Daftar gratis di sosovalue.com → API key, kirim via header
// 'x-soso-key' dari browser (pola BYOK seperti Coinalyze).
async function sourceEtfFlows(apiKey, cfg) {
  if (!apiKey) return null;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch('https://openapi.sosovalue.com/openapi/v2/etf/historicalInflowChart', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'x-soso-api-key': apiKey, 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({ type: cfg.soso }),
    });
    if (!r.ok) throw new Error(`SoSoValue HTTP ${r.status}`);
    const d = await r.json();
    // Struktur: { code:0, data: [...] } atau { data: { list: [...] } }
    let list = Array.isArray(d?.data) ? d.data : (d?.data?.list || d?.list || []);
    if (!Array.isArray(list) || !list.length) return null;
    // Normalisasi: { date, flow } — field flow bisa bernama totalNetInflow/netInflow
    const rows = list.map(e => ({
      date: e.date || e.dataDate || e.day || null,
      flow: +(e.totalNetInflow ?? e.netInflow ?? e.flow ?? NaN),
    })).filter(e => e.date && !Number.isNaN(e.flow));
    if (!rows.length) return null;
    rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const last5 = rows.slice(-5);
    const flowUsd = rows[rows.length - 1].flow;
    const flow5dSum = last5.reduce((s, e) => s + e.flow, 0);
    // Streak: berapa hari berturut-turut flow searah (dari hari terakhir mundur)
    let streak = 0;
    const dir = Math.sign(flowUsd);
    for (let i = rows.length - 1; i >= 0 && Math.sign(rows[i].flow) === dir && dir !== 0; i--) streak++;

    return {
      netFlow24h: flowUsd,                 // kompat dgn smartMoneyScore & UI lama
      flow5dSum,
      streak,
      streakDirection: dir > 0 ? 'INFLOW' : dir < 0 ? 'OUTFLOW' : 'FLAT',
      lastDate: rows[rows.length - 1].date,
      signal: flowUsd > 0 ? 'INFLOW' : flowUsd < 0 ? 'OUTFLOW' : 'FLAT',
      source: 'sosovalue-openapi',
    };
  } finally {
    clearTimeout(tid);
  }
}

// ── CVD (Cumulative Volume Delta) dari Binance FUTURES aggTrades — order flow ─
// Menggunakan futures (fapi) bukan spot, karena 75-85% volume BTC ada di futures.
// Ambil 1000 trade terakhir dari FUTURES untuk sinyal order flow yang representatif.
async function sourceCVD(cfg) {
  const d = await fetchJSON(`https://fapi.binance.com/fapi/v1/aggTrades?symbol=${cfg.binance}&limit=1000`);
  if (!Array.isArray(d) || !d.length) return null;
  let buyVol = 0, sellVol = 0;
  for (const t of d) {
    const qty = +t.q;
    // m=true → maker adalah buyer → trade ini adalah SELL aggressor
    if (t.m) sellVol += qty; else buyVol += qty;
  }
  const cvd = buyVol - sellVol;
  const total = buyVol + sellVol;
  const delta = total > 0 ? (cvd / total) * 100 : 0;
  return {
    buyVol, sellVol,
    cvd,
    deltaPct: delta,
    signal: delta > 10 ? 'STRONG_BUY' : delta > 3 ? 'BUY' : delta < -10 ? 'STRONG_SELL' : delta < -3 ? 'SELL' : 'BALANCED',
    source: 'futures',  // bukan spot — lebih representatif
  };
}

// ── Spot-Perp basis dihitung di handler (butuh ticker + funding markPrice) ──

// =============================================================================
//  NEW v7: Bandarmologi lanjutan — OKX Flow, Bybit Liquidations, Basis Premium
// =============================================================================

// ── OKX Taker Buy/Sell Flow Agregat (free, no key) ──────────────────────────
// OKX = ~20% volume futures global → konfirmasi sinyal Binance CVD secara ortogonal.
async function sourceOkxFlow(cfg) {
  const d = await fetchJSON(
    `https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader?instId=${cfg.okxSwap}&period=1H`,
    7000
  ).catch(() => null);
  // Jika endpoint contracts gagal, coba taker volume proxy dari mark price endpoint
  if (!d?.data?.length) return null;
  // Endpoint ini mengembalikan array [{ts, longShortRatio}]
  // Ambil 2 item terakhir untuk trend direction
  const arr = d.data;
  const latest = arr[arr.length - 1];
  const prev   = arr.length > 1 ? arr[arr.length - 2] : null;
  const ratio  = parseFloat(latest?.[1] || latest?.longShortRatio || 1);
  const prevRatio = prev ? parseFloat(prev?.[1] || prev?.longShortRatio || ratio) : ratio;
  if (!ratio || isNaN(ratio)) return null;
  return {
    longShortRatio: +ratio.toFixed(4),
    trend: ratio > prevRatio ? 'RISING_LONG' : ratio < prevRatio ? 'FALLING_LONG' : 'STABLE',
    bias: ratio > 1.05 ? 'LONG_DOMINANT' : ratio < 0.95 ? 'SHORT_DOMINANT' : 'NEUTRAL',
    source: 'OKX top trader L/S 1H',
  };
}

// ── Bybit Liquidation History — real cascade data (free, no key) ─────────────
// Lebih akurat dari estimasi: menunjukkan liquidasi yang sudah terjadi.
async function sourceBybitLiquidations(cfg) {
  const d = await fetchJSON(
    `https://api.bybit.com/v5/market/liquidation?category=linear&symbol=${cfg.binance}&limit=200`,
    7000
  ).catch(() => null);
  if (!d) return null;
  const list = d?.result?.list || [];
  // Bybit returns empty list saat tidak ada liquidation event — tetap return data bermakna
  if (!list.length) return {
    longLiqCount: 0, shortLiqCount: 0,
    longLiqValueM: 0, shortLiqValueM: 0,
    momentum: 'NEUTRAL', recentBurst: false, burstDirection: null,
    washoutSignal: 'NONE', source: 'Bybit linear — no recent events',
  };

  const now = Date.now();
  const recent30m = list.filter(l => now - parseInt(l.updatedTime || l.time || 0) < 30 * 60 * 1000);

  // side=Buy → posisi LONG yang dilikuidasi (harga turun → long kena)
  // side=Sell → posisi SHORT yang dilikuidasi (harga naik → short kena)
  const longLiq  = list.filter(l => l.side === 'Buy');
  const shortLiq = list.filter(l => l.side === 'Sell');
  const recLong  = recent30m.filter(l => l.side === 'Buy');
  const recShort = recent30m.filter(l => l.side === 'Sell');

  const longValM  = longLiq.reduce((s, l)  => s + parseFloat(l.size || 0) * parseFloat(l.price || 0), 0) / 1e6;
  const shortValM = shortLiq.reduce((s, l) => s + parseFloat(l.size || 0) * parseFloat(l.price || 0), 0) / 1e6;

  const burst = recLong.length > 15 || recShort.length > 15;
  const burstDir = recLong.length > recShort.length ? 'LONG_LIQUIDATED' : 'SHORT_LIQUIDATED';

  let momentum = 'NEUTRAL';
  if (longValM > shortValM * 1.5)  momentum = 'LONGS_DOMINATED';   // banyak long kena → bearish
  else if (shortValM > longValM * 1.5) momentum = 'SHORTS_DOMINATED'; // banyak short kena → bullish

  // Washout signal: burst long liquidation = kapitulasi → potensi reversal bullish
  let washoutSignal = 'NONE';
  if (burst && burstDir === 'LONG_LIQUIDATED' && recLong.length > recShort.length * 2) {
    washoutSignal = 'LONG_WASHOUT'; // capitulation — bullish contrarian
  } else if (burst && burstDir === 'SHORT_LIQUIDATED') {
    washoutSignal = 'SHORT_SQUEEZE'; // short squeeze sedang berlangsung
  }

  return {
    longLiqCount:  longLiq.length,
    shortLiqCount: shortLiq.length,
    longLiqValueM:  +longValM.toFixed(2),
    shortLiqValueM: +shortValM.toFixed(2),
    momentum,
    recentBurst: burst,
    burstDirection: burst ? burstDir : null,
    washoutSignal,
    source: 'Bybit linear 200 events',
  };
}

// ── Futures Basis Premium (Binance perp mark vs index) ───────────────────────
// Basis = premium/discount perp terhadap index. Basis tinggi = long crowded (bearish).
async function sourceFuturesBasis(cfg) {
  const d = await fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${cfg.binance}`, 5000);
  if (!d?.markPrice || !d?.indexPrice) return null;

  const mark  = parseFloat(d.markPrice);
  const index = parseFloat(d.indexPrice);
  if (!mark || !index) return null;

  const basisPct = ((mark - index) / index) * 100;
  // Annualize: basis 1h * 24h * 365d (simple annualization proxy)
  const annualizedPct = basisPct * 24 * 365;

  let regime = 'NEUTRAL';
  if (basisPct > 0.05)       regime = 'CONTANGO_BULLISH';
  else if (basisPct > 0.01)  regime = 'SLIGHT_CONTANGO';
  else if (basisPct > -0.01) regime = 'FLAT';
  else if (basisPct > -0.05) regime = 'SLIGHT_BACKWARDATION';
  else                       regime = 'BACKWARDATION_BEARISH';

  return {
    markPrice:     +mark.toFixed(2),
    indexPrice:    +index.toFixed(2),
    basisPct:      +basisPct.toFixed(4),
    annualizedPct: +annualizedPct.toFixed(1),
    regime,
  };
}

// ── CoinMetrics Extended — Exchange Flow + Active Addresses (free community API) ─
// NVTAdj90/SoprFree/CapNuvtUsd dikunci di plan berbayar CoinMetrics.
// Pakai metric free yang tersedia: FlowInExUSD, FlowOutExUSD, AdrActCnt.
// Net flow negatif = lebih banyak BTC keluar exchange = akumulasi (bullish).
// Active addresses naik = network growing (bullish on-chain demand).
async function sourceCoinMetricsExtended(cfg) {
  const url = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics'
    + `?assets=${cfg.cm}`
    + '&metrics=FlowInExUSD,FlowOutExUSD,AdrActCnt'
    + '&page_size=7&pretty=false';
  const d = await fetchJSON(url, 8000).catch(() => null);
  if (!d?.data?.length) return null;

  const rows = d.data.filter(r => r.FlowInExUSD != null || r.FlowOutExUSD != null);
  if (!rows.length) return null;
  const latest = rows[rows.length - 1];

  const flowIn  = latest.FlowInExUSD  ? +parseFloat(latest.FlowInExUSD).toFixed(0)  : null;
  const flowOut = latest.FlowOutExUSD ? +parseFloat(latest.FlowOutExUSD).toFixed(0) : null;
  const adrAct  = latest.AdrActCnt   ? +parseInt(latest.AdrActCnt)                  : null;

  // Net flow: negatif = lebih banyak keluar exchange = akumulasi (bullish)
  const netFlow = (flowIn != null && flowOut != null) ? flowOut - flowIn : null;
  const netFlowM = netFlow != null ? +(netFlow / 1e6).toFixed(1) : null;

  // 7-hari context: trend active addresses
  let adrTrend = null;
  if (rows.length >= 4 && adrAct != null) {
    const prev = rows.slice(-4, -1).map(r => parseInt(r.AdrActCnt || 0)).filter(v => v > 0);
    if (prev.length) {
      const prevAvg = prev.reduce((a, b) => a + b, 0) / prev.length;
      adrTrend = adrAct > prevAvg * 1.05 ? 'RISING' : adrAct < prevAvg * 0.95 ? 'FALLING' : 'STABLE';
    }
  }

  let exchangeFlowSignal = 'NEUTRAL';
  if (netFlowM != null) {
    // Net positif besar = banyak masuk exchange = tekanan jual (bearish)
    // Net negatif besar = banyak keluar exchange = akumulasi (bullish)
    if (netFlowM < -100)       exchangeFlowSignal = 'ACCUMULATION';   // banyak tarik dari exchange
    else if (netFlowM < -30)   exchangeFlowSignal = 'SLIGHT_ACCUM';
    else if (netFlowM > 100)   exchangeFlowSignal = 'DISTRIBUTION';   // banyak deposit ke exchange
    else if (netFlowM > 30)    exchangeFlowSignal = 'SLIGHT_DISTRIB';
  }

  return {
    flowInExUsd:  flowIn,
    flowOutExUsd: flowOut,
    netFlowM,
    exchangeFlowSignal,
    activeAddresses: adrAct,
    adrTrend,
    date: latest.time?.slice(0, 10) || null,
    source: 'CoinMetrics community',
  };
}

// ── Multi-exchange funding (Bybit + OKX, free no key) ───────────────────────
async function sourceMultiFunding(cfg) {
  const [bybit, okx] = await Promise.all([
    fetchJSON(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${cfg.binance}`, 6000).catch(() => null),
    fetchJSON(`https://www.okx.com/api/v5/public/funding-rate?instId=${cfg.okxSwap}`, 6000).catch(() => null),
  ]);
  const result = {};
  if (bybit?.result?.list?.[0]?.fundingRate != null) {
    result.bybit = +bybit.result.list[0].fundingRate * 100;
  }
  if (okx?.data?.[0]?.fundingRate != null) {
    result.okx = +okx.data[0].fundingRate * 100;
  }
  if (!Object.keys(result).length) return null;
  return result;
}

// ── Coinalyze (BUTUH API KEY GRATIS — daftar di coinalyze.net) ──────────────
//    Alternatif GRATIS untuk CoinGlass. Liquidation + OI agregat lintas bursa.
//    Key dikirim browser via header 'x-coinalyze-key'. Kalau tidak ada → skip.
//    Rate limit 40 call/menit. Symbol perp aggregate: '{SYM}USDT_PERP.A'
async function sourceCoinalyze(apiKey, cfg) {
  if (!apiKey) return null;
  const base = 'https://api.coinalyze.net/v1';
  const headers = { 'api_key': apiKey, 'accept': 'application/json' };
  const get = async (path) => {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 7000);
    try {
      const r = await fetch(`${base}${path}`, { signal: ctrl.signal, headers });
      if (!r.ok) throw new Error(`Coinalyze HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(tid); }
  };
  // Liquidation history 24h (1 candle harian) + current OI agregat
  const now = Math.floor(Date.now() / 1000);
  const from = now - 26 * 3600;
  const sym = cfg.coinalyze;   // .A = aggregated across exchanges
  const [liq, oi] = await Promise.all([
    get(`/liquidation-history?symbols=${sym}&interval=daily&from=${from}&to=${now}&convert_to_usd=true`).catch(() => null),
    get(`/open-interest?symbols=${sym}&convert_to_usd=true`).catch(() => null),
  ]);
  const out = {};
  // Liquidation history: array of { symbol, history: [{ t, l (long liq), s (short liq) }] }
  const liqHist = liq?.[0]?.history;
  if (liqHist?.length) {
    const last = liqHist[liqHist.length - 1];
    out.longLiquidation = +last.l || 0;   // long liquidated (USD)
    out.shortLiquidation = +last.s || 0;  // short liquidated (USD)
    if (out.longLiquidation || out.shortLiquidation) {
      out.liqBias = out.longLiquidation > out.shortLiquidation * 1.3 ? 'LONGS_REKT'
                  : out.shortLiquidation > out.longLiquidation * 1.3 ? 'SHORTS_REKT'
                  : 'BALANCED';
    }
  }
  // Open interest agregat lintas bursa
  const oiVal = oi?.[0]?.value;
  if (oiVal != null) out.aggregatedOI = +oiVal;
  return Object.keys(out).length ? out : null;
}

// =============================================================================
//  NEW v8: Positioning whale & institusi lintas venue (KEBUTUHAN_SINYAL §3-5)
//  Semua TANPA KEY kecuali yang ditandai. Semua optional + timeout ≤ 8s.
// =============================================================================

// ── §3.2 Hyperliquid — perp DEX terbesar (TANPA KEY) ─────────────────────────
// Funding per JAM → ×8 untuk dibanding funding 8h CEX. Sinyal ortogonal:
// positioning whale DEX vs retail CEX.
async function sourceHyperliquid(cfg) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 7000);
  try {
    const r = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    });
    if (!r.ok) throw new Error(`Hyperliquid HTTP ${r.status}`);
    const d = await r.json();
    const universe = d?.[0]?.universe;
    const ctxs = d?.[1];
    if (!Array.isArray(universe) || !Array.isArray(ctxs)) return null;
    const i = universe.findIndex(u => u?.name === cfg.hl);
    if (i < 0 || !ctxs[i]) return null;
    const c = ctxs[i];
    const funding1h = parseFloat(c.funding) * 100;          // % per jam
    const markPx = parseFloat(c.markPx);
    const oiBtc = parseFloat(c.openInterest);
    if (Number.isNaN(funding1h) || Number.isNaN(markPx)) return null;
    return {
      funding1hPct: +funding1h.toFixed(6),
      funding8hPct: +(funding1h * 8).toFixed(4),            // setara funding 8h CEX
      openInterestBtc: Number.isNaN(oiBtc) ? null : oiBtc,
      openInterestUsd: Number.isNaN(oiBtc) ? null : Math.round(oiBtc * markPx),
      markPx,
      oraclePx: c.oraclePx != null ? parseFloat(c.oraclePx) : null,
      premiumPct: c.premium != null ? +(parseFloat(c.premium) * 100).toFixed(4) : null,
      dayVolumeUsd: c.dayNtlVlm != null ? Math.round(parseFloat(c.dayNtlVlm)) : null,
    };
  } finally {
    clearTimeout(tid);
  }
}

// ── §3.3 Bitfinex — margin long/short positions aktual (TANPA KEY) ───────────
// Satu-satunya bursa besar yang publikasi JUMLAH posisi margin (bukan rasio
// akun). Whale-watching klasik. Delta 24h = sinyal akumulasi/build-up.
async function sourceBitfinexMargin(cfg) {
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const sym = cfg.bitfinex;
  const [longNow, shortNow, longPrev, shortPrev] = await Promise.all([
    fetchJSON(`https://api-pub.bitfinex.com/v2/stats1/pos.size:1m:${sym}:long/last`, 6000),
    fetchJSON(`https://api-pub.bitfinex.com/v2/stats1/pos.size:1m:${sym}:short/last`, 6000),
    fetchJSON(`https://api-pub.bitfinex.com/v2/stats1/pos.size:1m:${sym}:long/hist?limit=1&start=${dayAgo}&sort=1`, 6000).catch(() => null),
    fetchJSON(`https://api-pub.bitfinex.com/v2/stats1/pos.size:1m:${sym}:short/hist?limit=1&start=${dayAgo}&sort=1`, 6000).catch(() => null),
  ]);
  const long  = Array.isArray(longNow)  ? +longNow[1]  : null;   // [ts, value] dalam unit coin
  const short = Array.isArray(shortNow) ? +shortNow[1] : null;
  if (long == null || short == null) return null;
  const longAgo  = Array.isArray(longPrev?.[0])  ? +longPrev[0][1]  : null;
  const shortAgo = Array.isArray(shortPrev?.[0]) ? +shortPrev[0][1] : null;
  const longDelta24hPct  = longAgo  ? ((long - longAgo) / longAgo) * 100   : null;
  const shortDelta24hPct = shortAgo ? ((short - shortAgo) / shortAgo) * 100 : null;

  // Bias whale dari perubahan posisi (bukan level absolut — long Bitfinex
  // struktural selalu jauh lebih besar dari short)
  let signal = 'NEUTRAL';
  if (longDelta24hPct != null && shortDelta24hPct != null) {
    if (longDelta24hPct > 2 && shortDelta24hPct <= 0.5)  signal = 'WHALE_LONG_BUILDUP';
    else if (shortDelta24hPct > 3)                       signal = 'SHORT_BUILDUP';   // bahan squeeze
    else if (longDelta24hPct < -2)                       signal = 'LONG_UNWIND';
  }
  return {
    longBtc: long, shortBtc: short,
    ratio: short > 0 ? +(long / short).toFixed(2) : null,
    longDelta24hPct:  longDelta24hPct  != null ? +longDelta24hPct.toFixed(2)  : null,
    shortDelta24hPct: shortDelta24hPct != null ? +shortDelta24hPct.toFixed(2) : null,
    signal,
  };
}

// ── §3.1 CFTC COT — posisi CME Bitcoin Futures (TANPA KEY, mingguan) ─────────
// Satu-satunya data posisi institusi yang diaudit regulator. Snapshot Selasa,
// rilis Jumat → sinyal LAMBAT, bobot untuk swing, bukan scalp.
async function sourceCftcCot(cfg) {
  const where = encodeURIComponent(`market_and_exchange_names like '${cfg.cotMarket}%'`);
  const order = encodeURIComponent('report_date_as_yyyy_mm_dd DESC');
  const d = await fetchJSON(
    `https://publicreporting.cftc.gov/resource/gpe5-46if.json?$limit=4&$order=${order}&$where=${where}`,
    8000
  );
  if (!Array.isArray(d) || !d.length) return null;

  // Field Socrata bisa bernama persis atau dengan suffix _all → cari defensif
  const pick = (row, base) => {
    if (row[base] != null) return +row[base];
    if (row[base + '_all'] != null) return +row[base + '_all'];
    const k = Object.keys(row).find(x => x.startsWith(base));
    return k != null ? +row[k] : null;
  };
  const parseRow = (row) => ({
    date: row.report_date_as_yyyy_mm_dd?.slice(0, 10) || null,
    levLong:  pick(row, 'lev_money_positions_long'),
    levShort: pick(row, 'lev_money_positions_short'),
    amLong:   pick(row, 'asset_mgr_positions_long'),
    amShort:  pick(row, 'asset_mgr_positions_short'),
    openInterest: pick(row, 'open_interest'),
  });
  const latest = parseRow(d[0]);
  const prev   = d.length > 1 ? parseRow(d[1]) : null;
  if (latest.levLong == null && latest.amLong == null) return null;

  const levNet = (latest.levLong ?? 0) - (latest.levShort ?? 0);
  const amNet  = (latest.amLong ?? 0)  - (latest.amShort ?? 0);
  const levNetPrev = prev ? (prev.levLong ?? 0) - (prev.levShort ?? 0) : null;
  const amNetPrev  = prev ? (prev.amLong ?? 0)  - (prev.amShort ?? 0) : null;

  return {
    reportDate: latest.date,
    leveragedFunds: { long: latest.levLong, short: latest.levShort, net: levNet,
                      netDeltaWoW: levNetPrev != null ? levNet - levNetPrev : null },
    assetManagers:  { long: latest.amLong, short: latest.amShort, net: amNet,
                      netDeltaWoW: amNetPrev != null ? amNet - amNetPrev : null },
    openInterest: latest.openInterest,
    // Hedge fund net short ekstrem = sering basis trade, tapi PERUBAHAN mingguan informatif
    levSignal: levNetPrev == null ? 'N/A'
      : levNet - levNetPrev > 0 ? 'HEDGE_FUNDS_COVERING' : 'HEDGE_FUNDS_ADDING_SHORT',
    amSignal: amNetPrev == null ? 'N/A'
      : amNet - amNetPrev > 0 ? 'INSTITUSI_AKUMULASI' : 'INSTITUSI_DISTRIBUSI',
  };
}

// ── §3.4 Deribit DVOL — implied volatility index (TANPA KEY) ─────────────────
async function sourceDvol(cfg) {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  const d = await fetchJSON(
    `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${cfg.deribit}&start_timestamp=${weekAgo}&end_timestamp=${now}&resolution=3600`,
    7000
  );
  const data = d?.result?.data;
  if (!Array.isArray(data) || data.length < 10) return null;
  // Tiap row: [ts, open, high, low, close]
  const closes = data.map(r => +r[4]).filter(v => !Number.isNaN(v));
  const current = closes[closes.length - 1];
  const min7d = Math.min(...closes);
  const max7d = Math.max(...closes);
  const avg7d = closes.reduce((a, b) => a + b, 0) / closes.length;
  const range = max7d - min7d || 1;
  const positionPct = ((current - min7d) / range) * 100;   // posisi dalam range 7d

  let signal = 'NORMAL';
  if (current < avg7d * 0.92 && positionPct < 20)      signal = 'VOL_COMPRESSED';  // komplasen → breakout menunggu
  else if (current > avg7d * 1.15 && positionPct > 85) signal = 'VOL_SPIKE';        // panik → sering dekat bottom lokal

  return {
    current: +current.toFixed(2),
    avg7d: +avg7d.toFixed(2),
    min7d: +min7d.toFixed(2),
    max7d: +max7d.toFixed(2),
    positionPct: +positionPct.toFixed(0),
    signal,
  };
}

// ── §3.5 OKX liquidation orders (TANPA KEY) — pelengkap Bybit ────────────────
async function sourceOkxLiquidations(cfg) {
  const d = await fetchJSON(
    `https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&instFamily=${cfg.okxFamily}&state=filled&limit=100`,
    7000
  );
  const details = d?.data?.[0]?.details;
  if (!Array.isArray(details) || !details.length) return null;
  const now = Date.now();
  const CT_VAL = cfg.okxCtVal;   // nilai 1 kontrak: BTC 0.01, ETH 0.1, SOL 1, XRP 100
  let longCount = 0, shortCount = 0, longUsd = 0, shortUsd = 0;
  let recentLong = 0, recentShort = 0;
  for (const ev of details) {
    const isLong = ev.posSide === 'long';
    const usd = (parseFloat(ev.sz) || 0) * CT_VAL * (parseFloat(ev.bkPx) || 0);
    const recent = now - (+ev.ts || 0) < 30 * 60 * 1000;
    if (isLong) { longCount++; longUsd += usd; if (recent) recentLong++; }
    else        { shortCount++; shortUsd += usd; if (recent) recentShort++; }
  }
  const burst = recentLong > 10 || recentShort > 10;
  return {
    longLiqCount: longCount,
    shortLiqCount: shortCount,
    longLiqValueM:  +(longUsd / 1e6).toFixed(2),
    shortLiqValueM: +(shortUsd / 1e6).toFixed(2),
    recentBurst: burst,
    burstDirection: burst ? (recentLong > recentShort ? 'LONG_LIQUIDATED' : 'SHORT_LIQUIDATED') : null,
    source: `OKX SWAP ${cfg.okxFamily} 100 events`,
  };
}

// ── §4.1 Coinbase Premium — institusi & retail US (TANPA KEY) ────────────────
// Primary: Coinbase Exchange API. Fallback: Coinbase Advanced Trade (CDP) public.
async function sourceCoinbaseTicker(cfg) {
  // Primary: exchange.coinbase.com
  try {
    const d = await fetchJSON(`https://api.exchange.coinbase.com/products/${cfg.coinbase}/ticker`, 6000);
    const price = parseFloat(d?.price);
    if (price > 0) return { price };
  } catch (_) {}
  // Fallback: api.coinbase.com Advanced Trade best_bid_ask (public, no auth)
  try {
    const d = await fetchJSON(
      `https://api.coinbase.com/api/v3/brokerage/market/best_bid_ask?product_ids=${cfg.coinbase}`,
      6000
    );
    const entry = d?.pricebooks?.[0];
    const bid = parseFloat(entry?.bids?.[0]?.price);
    const ask = parseFloat(entry?.asks?.[0]?.price);
    if (bid > 0 && ask > 0) return { price: (bid + ask) / 2 };
  } catch (_) {}
  return null;
}

// ── §4.2 Kimchi Premium — retail Asia (TANPA KEY) ────────────────────────────
async function sourceKimchi(cfg) {
  const [upbit, fx] = await Promise.all([
    fetchJSON(`https://api.upbit.com/v1/ticker?markets=${cfg.upbit}`, 6000),
    fetchJSON('https://open.er-api.com/v6/latest/USD', 6000),
  ]);
  const krwPrice = upbit?.[0]?.trade_price;
  const usdkrw = fx?.rates?.KRW;
  if (!krwPrice || !usdkrw) return null;
  return { upbitUsd: krwPrice / usdkrw, usdkrw };
}

// ── §4.3 CME Gap — magnet harga weekend (TANPA KEY via Yahoo futures CME) ────
async function sourceCmeGap(cfg) {
  const d = await fetchJSON(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cfg.yahooFut)}?interval=1d&range=10d`,
    6000
  );
  const res = d?.chart?.result?.[0];
  const q = res?.indicators?.quote?.[0];
  const ts = res?.timestamp;
  if (!q?.close || !ts) return null;
  // Filter baris valid
  const rows = ts.map((t, i) => ({
    t: t * 1000, open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i],
  })).filter(r => r.open != null && r.close != null);
  if (rows.length < 3) return null;

  const spot = res?.meta?.regularMarketPrice ?? rows[rows.length - 1].close;
  // Cari gap terbaru yang BELUM tertutup: open sesi i ≠ close sesi i-1
  for (let i = rows.length - 1; i >= 1; i--) {
    const prevClose = rows[i - 1].close;
    const open = rows[i].open;
    const gapPct = ((open - prevClose) / prevClose) * 100;
    if (Math.abs(gapPct) < 0.3) continue;   // gap kecil, abaikan
    // Gap terisi kalau ada candle SETELAHNYA yang menyentuh level prevClose
    let filled = false;
    for (let j = i; j < rows.length; j++) {
      if (rows[j].low != null && rows[j].high != null
          && rows[j].low <= prevClose && rows[j].high >= prevClose) { filled = true; break; }
    }
    if (!filled) {
      return {
        level: Math.round(prevClose),
        gapPct: +gapPct.toFixed(2),
        direction: spot > prevClose ? 'BELOW_PRICE' : 'ABOVE_PRICE',   // posisi magnet vs harga
        ageDays: Math.round((Date.now() - rows[i].t) / 86400000),
        note: 'Gap CME yang belum tertutup — historis sangat sering di-fill (magnet harga)',
      };
    }
  }
  return { level: null, note: 'Tidak ada gap CME terbuka saat ini' };
}

// ── §5.3 Polymarket — prediction market odds (TANPA KEY, eksperimental) ──────
async function sourcePolymarket(cfg) {
  // Primary: Gamma API. Fallback: CLOB API (struktur berbeda tapi sama-sama public).
  let d = null;
  try {
    d = await fetchJSON(
      'https://gamma-api.polymarket.com/markets?closed=false&limit=40&order=volume24hr&ascending=false',
      7000
    );
  } catch (_) {}
  if (!Array.isArray(d)) {
    try {
      const clob = await fetchJSON(
        'https://clob.polymarket.com/markets?closed=false&limit=40',
        7000
      );
      d = Array.isArray(clob?.data) ? clob.data : null;
    } catch (_) {}
  }
  if (!Array.isArray(d)) return null;
  const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch (_) { return null; } };
  const btcMarkets = d
    .filter(m => cfg.pmSearch.test(m?.question || ''))
    .slice(0, 3)
    .map(m => {
      const outcomes = parse(m.outcomes) || [];
      const prices = parse(m.outcomePrices) || [];
      const yesIdx = outcomes.findIndex(o => /^yes$/i.test(o));
      const yesProb = yesIdx >= 0 && prices[yesIdx] != null ? +(+prices[yesIdx] * 100).toFixed(1) : null;
      return { question: m.question, yesProbPct: yesProb, volume24h: m.volume24hr != null ? Math.round(+m.volume24hr) : null };
    })
    .filter(m => m.yesProbPct != null);
  return btcMarkets.length ? { markets: btcMarkets } : null;
}

// ── §5.4 Miner pressure proxy — blockchain.info charts (TANPA KEY) ───────────
async function sourceMinerPressure() {
  const [hash, rev] = await Promise.all([
    fetchJSON('https://api.blockchain.info/charts/hash-rate?timespan=30days&format=json&cors=true', 7000).catch(() => null),
    fetchJSON('https://api.blockchain.info/charts/miners-revenue?timespan=30days&format=json&cors=true', 7000).catch(() => null),
  ]);
  const hv = hash?.values?.map(v => +v.y).filter(v => v > 0);
  const rv = rev?.values?.map(v => +v.y).filter(v => v > 0);
  if (!hv?.length) return null;
  const hashNow = hv[hv.length - 1];
  const hashPeak30d = Math.max(...hv);
  const hashFromPeakPct = ((hashNow - hashPeak30d) / hashPeak30d) * 100;
  let revFromPeakPct = null;
  if (rv?.length) {
    const revNow = rv[rv.length - 1];
    revFromPeakPct = ((revNow - Math.max(...rv)) / Math.max(...rv)) * 100;
  }
  let signal = 'NORMAL';
  if (hashFromPeakPct < -10 && (revFromPeakPct == null || revFromPeakPct < -15)) signal = 'MINER_STRESS';      // tekanan jual miner
  else if (hashFromPeakPct > -2)                                                 signal = 'HASHRATE_STRONG';   // sehat
  return {
    hashFromPeak30dPct: +hashFromPeakPct.toFixed(1),
    revFromPeak30dPct: revFromPeakPct != null ? +revFromPeakPct.toFixed(1) : null,
    signal,
  };
}

// =============================================================================
//  NEW v8: FREE-KEY sources (BYOK via header — key tidak pernah di repo)
// =============================================================================

// ── §2.4 FRED — makro resmi (FREE KEY: x-fred-key) ───────────────────────────
async function sourceFred(apiKey) {
  if (!apiKey) return null;
  const get = async (series) => {
    const d = await fetchJSON(
      `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=5`,
      7000
    ).catch(() => null);
    const obs = d?.observations?.find(o => o.value !== '.');
    return obs ? { value: +obs.value, date: obs.date } : null;
  };
  const [vix, us10y, dxyBroad] = await Promise.all([get('VIXCLS'), get('DGS10'), get('DTWEXBGS')]);
  if (!vix && !us10y && !dxyBroad) return null;
  return { vix, us10y, dxyBroad };
}

// ── §5.2 CryptoPanic — news + voting bullish/bearish (FREE KEY) ──────────────
async function sourceCryptoPanic(apiKey, cfg) {
  if (!apiKey) return null;
  const d = await fetchJSON(
    `https://cryptopanic.com/api/v1/posts/?auth_token=${apiKey}&currencies=${cfg.cryptopanic}&filter=hot&public=true`,
    7000
  );
  if (!d?.results?.length) return null;
  return d.results.slice(0, 8).map(p => ({
    title: p.title,
    source: p.source?.title || 'CryptoPanic',
    ts: p.published_at ? new Date(p.published_at).getTime() : Date.now(),
    url: p.url,
    bullishVotes: p.votes?.positive ?? null,
    bearishVotes: p.votes?.negative ?? null,
  }));
}

// ── §5.1 bitcoin-data.com (BGeometrics) — NUPL (rate limit KETAT 8 req/jam) ──
// HANYA di-fetch kalau browser kirim header 'x-fetch-nupl: 1' (cache client
// stale > 24 jam). Key opsional via 'x-btcdata-key'.
async function sourceNupl(apiKey) {
  const headers = { 'accept': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch('https://bitcoin-data.com/v1/nupl/last', { signal: ctrl.signal, headers });
    if (!r.ok) throw new Error(`bitcoin-data HTTP ${r.status}`);
    const d = await r.json();
    const nupl = parseFloat(d?.nupl ?? d?.value);
    if (Number.isNaN(nupl)) return null;
    let signal = 'NEUTRAL';
    if (nupl >= 0.75)      signal = 'EUPHORIA';        // bias distribusi/SHORT swing
    else if (nupl >= 0.5)  signal = 'BELIEF_GREED';
    else if (nupl >= 0.25) signal = 'OPTIMISM';
    else if (nupl >= 0)    signal = 'HOPE_FEAR';
    else                   signal = 'CAPITULATION';    // akumulasi/LONG swing
    return { nupl: +nupl.toFixed(3), date: d?.d || null, signal };
  } finally {
    clearTimeout(tid);
  }
}

// =============================================================================
//  COMPUTED SIGNALS — dihitung dari data existing, tanpa API tambahan
// =============================================================================

// ── §6.1 Regime Matrix: Price × OI × Funding — siapa penggerak harga? ────────
function computeMarketRegime(snapshot) {
  const dPrice = snapshot.ticker?.change24h;
  const dOI = snapshot.openInterest?.change24h;
  const funding = snapshot.funding?.fundingRate;
  if (dPrice == null || dOI == null || funding == null) return null;

  const pUp = dPrice > 0.3, pDown = dPrice < -0.3;
  const oiUp = dOI > 1, oiDown = dOI < -1;
  const fHigh = funding > 0.01, fNeg = funding < -0.005;

  let label, drivenBy, healthScore, note;
  if (pUp && oiUp && fHigh) {
    label = 'LEVERAGED_RALLY'; drivenBy = 'LEVERAGE_LONG'; healthScore = 55;
    note = 'Long baru masuk pakai leverage — LONG valid tapi rawan squeeze jika funding makin ekstrem';
  } else if (pUp && oiUp) {
    label = 'SPOT_LED_RALLY'; drivenBy = 'SPOT'; healthScore = 85;
    note = 'Rally paling sehat — OI naik tapi funding flat/negatif berarti spot buying yang dorong';
  } else if (pUp && oiDown) {
    label = 'SHORT_COVERING'; drivenBy = 'SHORT_COVER'; healthScore = 35;
    note = 'Rally lemah — naik karena short tutup posisi, bukan demand baru. Jangan kejar, tunggu OI naik';
  } else if (pDown && oiUp) {
    label = 'NEW_SHORTS_AGGRESSIVE'; drivenBy = 'LEVERAGE_SHORT'; healthScore = 40;
    note = 'Short baru agresif masuk — SHORT valid tapi waspada crowded short (bahan squeeze)';
  } else if (pDown && oiDown && fHigh) {
    label = 'LONG_LIQUIDATION'; drivenBy = 'DELEVERAGING'; healthScore = 25;
    note = 'Long dipaksa keluar (deleveraging) — tunggu washout selesai, sering disusul reversal LONG';
  } else if (pDown && oiDown) {
    label = 'POSITION_CLOSING'; drivenBy = 'DELEVERAGING'; healthScore = 30;
    note = 'Posisi ditutup, minat hilang — WAIT sampai ada arah baru';
  } else {
    label = 'RANGING'; drivenBy = 'NEUTRAL'; healthScore = 50;
    note = 'Tidak ada penggerak dominan — pasar ranging';
  }
  return { label, drivenBy, healthScore, note,
           inputs: { priceChange24h: dPrice, oiChange24h: dOI, fundingPct: funding } };
}

// ── §6.2 Cross-Venue Positioning Matrix — confluence bandarmologi riil ───────
function computeCrossVenue(snapshot) {
  const rows = [];
  const add = (venue, cohort, bias, detail) => rows.push({ venue, cohort, bias, detail });

  const ls = snapshot.longShort;
  if (ls?.topTrader?.current != null) {
    const v = ls.topTrader.current;
    add('Binance top traders', 'Whale CEX',
        v > 1.05 ? 'LONG' : v < 0.95 ? 'SHORT' : 'NEUTRAL', `L/S ${v.toFixed(2)}`);
  }
  const okx = snapshot.okxFlow;
  if (okx?.longShortRatio != null) {
    add('OKX top traders', 'Whale CEX Asia',
        okx.bias === 'LONG_DOMINANT' ? 'LONG' : okx.bias === 'SHORT_DOMINANT' ? 'SHORT' : 'NEUTRAL',
        `L/S ${okx.longShortRatio}`);
  }
  const bfx = snapshot.bitfinexMargin;
  if (bfx) {
    const ld = bfx.longDelta24hPct, sd = bfx.shortDelta24hPct;
    let bias = 'NEUTRAL';
    if (ld != null && sd != null) {
      if (ld - sd > 1)       bias = 'LONG';
      else if (sd - ld > 1)  bias = 'SHORT';
    }
    add('Bitfinex margin', 'Whale legacy', bias,
        `Δ24h long ${ld != null ? ld + '%' : '—'} / short ${sd != null ? sd + '%' : '—'}`);
  }
  const hl = snapshot.hyperliquid;
  if (hl?.funding8hPct != null) {
    add('Hyperliquid', 'Whale DEX',
        hl.funding8hPct > 0.005 ? 'LONG' : hl.funding8hPct < -0.005 ? 'SHORT' : 'NEUTRAL',
        `funding 8h-eq ${hl.funding8hPct}%`);
  }
  const cot = snapshot.cftcCot;
  if (cot?.leveragedFunds?.netDeltaWoW != null) {
    add('CME lev funds (COT)', 'Hedge funds',
        cot.leveragedFunds.netDeltaWoW > 0 ? 'LONG' : 'SHORT',
        `ΔWoW net ${cot.leveragedFunds.netDeltaWoW} kontrak (mingguan)`);
  }
  if (cot?.assetManagers?.netDeltaWoW != null) {
    add('CME asset mgr (COT)', 'Institusi long-only',
        cot.assetManagers.netDeltaWoW > 0 ? 'LONG' : 'SHORT',
        `ΔWoW net ${cot.assetManagers.netDeltaWoW} kontrak (mingguan)`);
  }

  if (rows.length < 3) return null;
  const long = rows.filter(r => r.bias === 'LONG').length;
  const short = rows.filter(r => r.bias === 'SHORT').length;
  const total = rows.length;
  const dominant = long > short ? 'LONG' : short > long ? 'SHORT' : 'SPLIT';
  const maxSide = Math.max(long, short);
  return {
    rows,
    venueAgreement: { long, short, neutral: total - long - short, total,
                      verdict: `${maxSide}/${total} ${dominant}` },
    confluence: dominant === 'SPLIT' ? 'SPLIT'
      : (maxSide >= 4 && maxSide / total >= 0.7) ? 'STRONG'
      : maxSide >= Math.ceil(total / 2) + 1 ? 'MODERATE' : 'WEAK',
    dominant,
  };
}

// ── §6.3 Squeeze Fuel Indicator — bedakan "bearish" vs "bahan squeeze" ───────
function computeSqueezeFuel(snapshot) {
  let shortSqueezePts = 0, longSqueezePts = 0;
  const components = [];

  const funding = snapshot.funding?.fundingRate;
  if (funding != null) {
    if (funding <= -0.03) { shortSqueezePts += 25; components.push('funding negatif ekstrem (short crowded)'); }
    else if (funding >= 0.05) { longSqueezePts += 25; components.push('funding positif ekstrem (long crowded)'); }
  }
  const fb = snapshot.futuresBasis;
  if (fb) {
    if (fb.regime === 'BACKWARDATION_BEARISH') { shortSqueezePts += 15; components.push('basis backwardation (hedging berat)'); }
    else if (fb.regime === 'CONTANGO_BULLISH') { longSqueezePts += 15; components.push('basis contango tinggi (long premium)'); }
  }
  const lm = snapshot.liqMagnets;
  const price = snapshot.ticker?.price;
  if (lm && price) {
    if (Math.abs(price - lm.upMagnet.from) / price < 0.015)   { shortSqueezePts += 20; components.push('klaster short-liq < 1.5% di atas harga'); }
    if (Math.abs(price - lm.downMagnet.to) / price < 0.015)   { longSqueezePts += 20; components.push('klaster long-liq < 1.5% di bawah harga'); }
  }
  const bfx = snapshot.bitfinexMargin;
  if (bfx) {
    if (bfx.shortDelta24hPct != null && bfx.shortDelta24hPct > 3) { shortSqueezePts += 20; components.push('Bitfinex short build-up 24h'); }
    if (bfx.longDelta24hPct != null && bfx.longDelta24hPct > 3)   { longSqueezePts += 20; components.push('Bitfinex long build-up 24h'); }
  }
  const hl = snapshot.hyperliquid;
  if (hl?.funding8hPct != null) {
    if (hl.funding8hPct <= -0.03)     { shortSqueezePts += 10; components.push('Hyperliquid funding negatif (whale DEX short)'); }
    else if (hl.funding8hPct >= 0.05) { longSqueezePts += 10; components.push('Hyperliquid funding tinggi (whale DEX long)'); }
  }

  const score = Math.min(Math.max(shortSqueezePts, longSqueezePts), 100);
  if (score < 20) return { direction: 'NONE', score, components: [] };
  return {
    // SHORT_SQUEEZE = bahan bakar naik menumpuk (jangan SHORT sembarangan)
    // LONG_SQUEEZE = bahan bakar turun menumpuk (jangan LONG sembarangan)
    direction: shortSqueezePts >= longSqueezePts ? 'SHORT_SQUEEZE' : 'LONG_SQUEEZE',
    score,
    components,
  };
}

// ── Agregat likuidasi lintas bursa (Bybit + OKX) — §3.5 ──────────────────────
function computeAggregateLiquidations(snapshot) {
  const by = snapshot.bybitLiquidations;
  const ok = snapshot.okxLiquidations;
  if (!by && !ok) return null;
  const longM  = (by?.longLiqValueM ?? 0)  + (ok?.longLiqValueM ?? 0);
  const shortM = (by?.shortLiqValueM ?? 0) + (ok?.shortLiqValueM ?? 0);
  const bothBurst = !!(by?.recentBurst && ok?.recentBurst);
  const sameDirection = bothBurst && by.burstDirection === ok.burstDirection;
  return {
    venues: [by ? 'Bybit' : null, ok ? 'OKX' : null].filter(Boolean),
    totalLongLiqM: +longM.toFixed(2),
    totalShortLiqM: +shortM.toFixed(2),
    // Burst serentak 2 bursa = washout/squeeze JAUH lebih meyakinkan dari 1 bursa
    crossVenueBurst: sameDirection ? by.burstDirection : null,
    signal: sameDirection
      ? (by.burstDirection === 'LONG_LIQUIDATED' ? 'CONFIRMED_LONG_WASHOUT' : 'CONFIRMED_SHORT_SQUEEZE')
      : 'NO_CROSS_CONFIRMATION',
  };
}

/** Funding Rate Divergence Score: seberapa "tidak kompak" exchange soal arah funding */
function computeFundingDivergence(binanceFunding, multiFunding) {
  const rates = [];
  if (binanceFunding?.fundingRate != null) rates.push(binanceFunding.fundingRate);
  if (multiFunding?.bybit != null) rates.push(multiFunding.bybit);
  if (multiFunding?.okx  != null) rates.push(multiFunding.okx);
  if (rates.length < 2) return null;

  const mean    = rates.reduce((a, b) => a + b, 0) / rates.length;
  const std     = Math.sqrt(rates.reduce((s, v) => s + (v - mean) ** 2, 0) / rates.length);
  const meanAbs = rates.map(Math.abs).reduce((a, b) => a + b, 0) / rates.length;
  const score   = meanAbs > 0.0001 ? +(std / meanAbs).toFixed(3) : 0;

  return {
    score,
    consensus: score < 0.3 ? 'STRONG' : score < 1.0 ? 'MODERATE' : 'WEAK',
    rates: { binance: rates[0], bybit: multiFunding?.bybit ?? null, okx: multiFunding?.okx ?? null },
    interpretation: score > 1.5
      ? 'Divergensi tinggi — kemungkinan manipulasi/arbitrase aktif, sinyal arah tidak reliable'
      : score < 0.3
      ? 'Konsensus kuat — semua exchange sepakat, sinyal funding lebih bisa dipercaya'
      : 'Divergensi moderat',
  };
}

/** Smart Money Conviction Score 0–100: agregat semua bandarmologi signal */
function computeSmartMoneyScore(snapshot) {
  let bullPts = 0, bearPts = 0, totalWeight = 0;

  // CVD taker flow (bobot 25%)
  const cvd = snapshot.cvd;
  if (cvd?.deltaPct != null) {
    const w = 25;
    const strength = Math.min(Math.abs(cvd.deltaPct) / 15, 1); // normalize 0-15% → 0-1
    if (cvd.deltaPct > 0) bullPts += strength * w; else bearPts += strength * w;
    totalWeight += w;
  }

  // L/S Z-score divergence (bobot 20%)
  const ls = snapshot.longShort;
  if (ls?.divZScore != null) {
    const w = 20;
    const z = ls.divZScore;
    if (z > 1.5)       { bullPts += w; }
    else if (z < -1.5) { bearPts += w; }
    else               { bullPts += w * 0.5; bearPts += w * 0.5; }
    totalWeight += w;
  }

  // OI change direction (bobot 15%)
  const oi = snapshot.openInterest;
  if (oi?.change24h != null) {
    const w = 15;
    const strength = Math.min(Math.abs(oi.change24h) / 5, 1);
    if (oi.change24h > 0 && (snapshot.ticker?.change24h ?? 0) > 0) bullPts += strength * w;
    else if (oi.change24h < 0 && (snapshot.ticker?.change24h ?? 0) < 0) bearPts += strength * w;
    else { bullPts += w * 0.3; bearPts += w * 0.3; }
    totalWeight += w;
  }

  // ETF flows (bobot 15%)
  const etf = snapshot.etfFlows;
  if (etf?.netFlow24h != null) {
    const w = 15;
    if      (etf.netFlow24h > 200e6)  bullPts += w;
    else if (etf.netFlow24h > 50e6)   bullPts += w * 0.7;
    else if (etf.netFlow24h < -200e6) bearPts += w;
    else if (etf.netFlow24h < -50e6)  bearPts += w * 0.7;
    else { bullPts += w * 0.4; bearPts += w * 0.4; }
    totalWeight += w;
  }

  // Bybit washout signal (bobot 10%) — contrarian: long washout = buy signal
  const bbl = snapshot.bybitLiquidations;
  if (bbl?.washoutSignal) {
    const w = 10;
    if (bbl.washoutSignal === 'LONG_WASHOUT')   bullPts += w;  // kapitulasi → contrarian bullish
    else if (bbl.washoutSignal === 'SHORT_SQUEEZE') bullPts += w * 0.8;
    else if (bbl.momentum === 'SHORTS_DOMINATED') bearPts += w * 0.5; // short squeeze done?
    totalWeight += w;
  }

  // OKX L/S (bobot 10%)
  const okxF = snapshot.okxFlow;
  if (okxF?.longShortRatio != null) {
    const w = 10;
    const r = okxF.longShortRatio;
    if (r > 1.1)      bullPts += w;
    else if (r < 0.9) bearPts += w;
    else              { bullPts += w * 0.5; bearPts += w * 0.5; }
    totalWeight += w;
  }

  // Stablecoin liquidity (bobot 5%)
  const sc = snapshot.stablecoins;
  if (sc?.liquiditySignal) {
    const w = 5;
    if (sc.liquiditySignal === 'EXPANDING')   bullPts += w;
    else if (sc.liquiditySignal === 'CONTRACTING') bearPts += w;
    else { bullPts += w * 0.5; bearPts += w * 0.5; }
    totalWeight += w;
  }

  // v8: Cross-venue positioning matrix (bobot 15%) — confluence bandarmologi
  // sesungguhnya: Binance/OKX/Bitfinex/Hyperliquid/CME searah atau split?
  const cv = snapshot.crossVenue;
  if (cv?.venueAgreement) {
    const w = 15;
    const { long, short, total } = cv.venueAgreement;
    if (cv.confluence === 'STRONG') {
      if (cv.dominant === 'LONG') bullPts += w; else if (cv.dominant === 'SHORT') bearPts += w;
    } else if (total > 0) {
      bullPts += w * (long / total);
      bearPts += w * (short / total);
    }
    totalWeight += w;
  }

  if (totalWeight === 0) return null;

  const score = Math.round((bullPts / totalWeight) * 100);
  const delta = Math.abs(score - 50);

  return {
    score,
    direction:  score > 60 ? 'LONG' : score < 40 ? 'SHORT' : 'NEUTRAL',
    conviction: delta > 30 ? 'VERY_HIGH' : delta > 20 ? 'HIGH' : delta > 10 ? 'MODERATE' : 'CONFLICTED',
    bullPts: +bullPts.toFixed(1),
    bearPts: +bearPts.toFixed(1),
    totalWeight,
  };
}

/** Liquidation Cascade Probability: seberapa tinggi risiko cascade likuidasi */
function computeCascadeProbability(snapshot) {
  let score = 0;

  const oiChange = snapshot.openInterest?.change24h || 0;
  const change1h = snapshot.openInterest?.change1h  || 0;
  const price    = snapshot.ticker?.price || 0;

  // OI surge dalam 1 jam
  if (Math.abs(change1h) > 3)   score += 30;
  else if (Math.abs(change1h) > 1.5) score += 15;

  // Proximity ke liquidation magnet
  const lm = snapshot.liqMagnets;
  if (lm && price) {
    const nearDown = Math.abs(price - lm.downMagnet.to)   / price < 0.015;
    const nearUp   = Math.abs(price - lm.upMagnet.from)   / price < 0.015;
    if (nearDown || nearUp) score += 25;
  }

  // Extreme funding (semua exchange searah ekstrem)
  const fd = snapshot.fundingDivergence;
  const binFr = Math.abs(snapshot.funding?.fundingRate || 0);
  if (binFr > 0.1)      score += 25;
  else if (binFr > 0.05) score += 12;
  // Konsensus kuat + funding ekstrem = lebih berbahaya
  if (fd?.consensus === 'STRONG' && binFr > 0.05) score += 10;

  // CVD vs OI diverge = posisi tidak ter-cover → cascade lebih mudah terpicu
  const cvdDelta = snapshot.cvd?.deltaPct || 0;
  if (Math.sign(cvdDelta) !== Math.sign(oiChange) && Math.abs(oiChange) > 1) score += 15;

  // Bybit burst sudah terjadi → cascade mungkin sudah mulai
  if (snapshot.bybitLiquidations?.recentBurst) score += 10;

  return {
    probability: Math.min(score, 100),
    riskLevel: score > 65 ? 'HIGH' : score > 35 ? 'MEDIUM' : 'LOW',
    likelyCascadeDirection: change1h > 0 ? 'DOWN' : 'UP',
    note: score > 65
      ? 'Kondisi berisiko tinggi untuk cascade — hindari posisi terbuka besar sementara ini'
      : score > 35
      ? 'Risiko moderat — gunakan SL lebih ketat dari biasa'
      : 'Risiko cascade rendah saat ini',
  };
}

/**
 * Estimasi LEVEL MAGNET LIKUIDASI (computed, no key).
 * Liquidation heatmap intinya menunjukkan di mana posisi leverage akan
 * terlikuidasi = level yang sering "diburu" harga (magnet). Kita hitung dari
 * harga current + tier leverage umum. Long liq di BAWAH, short liq di ATAS.
 */
function computeLiquidationMagnets(price) {
  if (!price) return null;
  // Maintenance margin buffer ~0.4% (likuidasi terjadi sedikit sebelum 1/L penuh)
  const mm = 0.004;
  const tiers = [100, 50, 25, 10];
  const longLiqs = tiers.map(lev => ({
    leverage: lev + 'x',
    price: Math.round(price * (1 - (1 / lev) + mm)),
    distancePct: -(((1 / lev) - mm) * 100),
  }));
  const shortLiqs = tiers.map(lev => ({
    leverage: lev + 'x',
    price: Math.round(price * (1 + (1 / lev) - mm)),
    distancePct: ((1 / lev) - mm) * 100,
  }));
  // Zona magnet utama = klaster leverage tinggi (25x-100x) yang paling ramai & sering kena
  return {
    longLiqs,    // di bawah harga — kalau tembus, cascade TURUN
    shortLiqs,   // di atas harga — kalau tembus, cascade NAIK (squeeze)
    downMagnet: { from: Math.round(price * (1 - 0.04)), to: Math.round(price * (1 - 0.01)) },
    upMagnet:   { from: Math.round(price * (1 + 0.01)), to: Math.round(price * (1 + 0.04)) },
  };
}

// Format: [label, fn, optional, flag]
// optional=true → kalau gagal, TIDAK dianggap error (datanya sudah dihitung dari
// sumber lain, atau memang non-kritis). Tidak ditampilkan sebagai error menakutkan.
// flag (v9) → nama feature-flag di COINS; bila cfg[flag] === false sumber
// di-skip untuk coin itu (notApplicable, bukan degraded).
const SOURCES = [
  ['ticker',           sourceTicker,               false],
  ['orderBook',        sourceOrderBook,            false],
  ['funding',          sourceFunding,              false],
  ['klinesMulti',      sourceKlinesMulti,          false],  // inti TA + market stats
  ['supply',           sourceSupply,               true,  'hasNetwork'],  // blockchain.info = BTC only
  ['openInterest',     sourceOpenInterestHist,     false],
  ['longShort',        sourceLongShortRatios,      false],
  ['takerVolume',      sourceTakerVolume,          false],
  ['cvd',              sourceCVD,                  true],   // v6: Binance futures order flow
  ['options',          sourceDeribitOptions,       true,  'hasOptions'],  // PCR/max pain — BTC/ETH
  ['onChain',          sourceCoinMetrics,          true],   // MVRV (coverage sol/xrp terbatas — biarkan null)
  ['onChainExt',       sourceCoinMetricsExtended,  true],   // v7: exchange flow + active addresses
  ['stablecoins',      sourceStablecoins,          true],   // v6: dry powder
  ['multiFunding',     sourceMultiFunding,         true],   // v6: cross-exchange funding
  ['okxFlow',          sourceOkxFlow,              true],   // v7: OKX top trader L/S
  ['bybitLiquidations',sourceBybitLiquidations,    true],   // v7: real liquidation events
  ['futuresBasis',     sourceFuturesBasis,         true],   // v7: perp mark vs index basis
  // ── v8: positioning whale & institusi (KEBUTUHAN_SINYAL §3-5) ─────────────
  ['hyperliquid',      sourceHyperliquid,          true],   // §3.2 perp DEX whale
  ['bitfinexMargin',   sourceBitfinexMargin,       true],   // §3.3 margin positions
  ['cftcCot',          sourceCftcCot,              true],   // §3.1 CME COT mingguan
  ['dvol',             sourceDvol,                 true,  'hasDvol'],     // §3.4 — BTC/ETH only
  ['okxLiquidations',  sourceOkxLiquidations,      true],   // §3.5 pelengkap Bybit
  ['coinbaseTicker',   sourceCoinbaseTicker,       true],   // §4.1 premium dihitung di handler
  ['kimchiRaw',        sourceKimchi,               true],   // §4.2 premium dihitung di handler
  ['cmeGap',           sourceCmeGap,               true],   // §4.3 magnet gap CME
  ['polymarket',       sourcePolymarket,           true],   // §5.3 eksperimental
  ['minerPressure',    sourceMinerPressure,        true,  'hasMiner'],    // §5.4 — BTC only
  ['macro',            sourceMacro,                true],   // v8: Yahoo primary, Stooq fallback
  ['fearGreed',        sourceFearGreed,            false],
  ['global',           sourceGlobal,               true],
  ['mempool',          sourceMempool,              true,  'hasNetwork'],  // BTC only
  ['network',          sourceNetwork,              true,  'hasNetwork'],  // BTC only
  ['news',             sourceNews,                 true],
];

// Keyed sources (BYOK via header) — [label, headerFn, flag]
// etfFlows pindah ke sini (SoSoValue Open API butuh free key, endpoint lama mati)
const KEYED_SOURCES = [
  ['coinalyze', (h, cfg) => { const k = h('x-coinalyze-key'); return k ? sourceCoinalyze(k, cfg) : null; }],
  ['etfFlows',  (h, cfg) => { const k = h('x-soso-key');      return k ? sourceEtfFlows(k, cfg) : null; }],
  ['fred',      (h) => { const k = h('x-fred-key');      return k ? sourceFred(k) : null; }],
  ['newsCp',    (h, cfg) => { const k = h('x-cryptopanic-key'); return k ? sourceCryptoPanic(k, cfg) : null; }],
  // NUPL: rate limit brutal (8 req/jam) → hanya fetch kalau browser minta
  // eksplisit (cache localStorage-nya stale > 24 jam). BTC only.
  ['nupl',      (h) => h('x-fetch-nupl') === '1' ? sourceNupl(h('x-btcdata-key') || '') : null, 'hasNupl'],
];

export default async function handler(request) {
  const t0 = Date.now();

  // Header reader — semua FREE KEY dikirim browser via header (pola BYOK,
  // key tidak pernah hardcoded di repo)
  const getHeader = (name) => {
    try { return request?.headers?.get?.(name) || ''; } catch (_) { return ''; }
  };

  // v9: coin aktif dari ?symbol= (default BTC)
  let cfg = COINS.BTC;
  try {
    const sym = (new URL(request.url).searchParams.get('symbol') || 'BTC').toUpperCase();
    if (COINS[sym]) cfg = COINS[sym];
  } catch (_) {}

  // Jalankan semua source (no-key + keyed) paralel; skip yang tidak berlaku
  // untuk coin ini (feature flag di COINS)
  const skipped = (flag) => flag && cfg[flag] === false;
  const sourcePromises = SOURCES.map(([, fn, , flag]) =>
    skipped(flag) ? Promise.resolve(null) : fn(cfg));
  const keyedPromises = KEYED_SOURCES.map(([, fn, flag]) => {
    if (skipped(flag)) return Promise.resolve(null);
    const p = fn(getHeader, cfg);
    return p == null ? Promise.resolve(null) : p;
  });

  const results = await Promise.allSettled([...sourcePromises, ...keyedPromises]);

  const snapshot = { ts: Date.now(), version: 9, symbol: cfg.symbol, coinName: cfg.name };
  const errors = [];      // sumber KRITIS yang gagal (perlu perhatian)
  const degraded = [];    // sumber OPSIONAL yang gagal (tidak masalah)

  // Proses source utama
  SOURCES.forEach(([label, , optional], i) => {
    const r = results[i];
    if (r.status === 'fulfilled') {
      if (r.value != null) snapshot[label] = r.value;
    } else {
      const msg = String(r.reason?.message || r.reason || 'unknown').slice(0, 200);
      if (optional) degraded.push({ source: label, msg });
      else          errors.push({ source: label, msg });
    }
  });

  // Proses keyed sources
  KEYED_SOURCES.forEach(([label], j) => {
    const r = results[SOURCES.length + j];
    if (r.status === 'fulfilled') {
      if (r.value != null) snapshot[label] = r.value;
    } else {
      degraded.push({ source: label, msg: String(r.reason?.message || 'no data / key invalid').slice(0, 150) });
    }
  });

  // CryptoPanic (JSON + votes bullish/bearish) menggantikan news RSS bila ada
  if (snapshot.newsCp?.length) {
    snapshot.news = snapshot.newsCp;
    snapshot.newsSource = 'cryptopanic';
    delete snapshot.newsCp;
  }

  // ─── v7: Fix realized price — gunakan harga Binance realtime (bukan harga CoinMetrics stale 24h)
  if (snapshot.onChain?.realizedPrice && snapshot.ticker?.price) {
    snapshot.onChain.currentPremium =
      ((snapshot.ticker.price - snapshot.onChain.realizedPrice) / snapshot.onChain.realizedPrice) * 100;
  }

  // ─── v8 §4.1: Coinbase Premium — tekanan beli US (institusi + ETF creation)
  if (snapshot.coinbaseTicker?.price && snapshot.ticker?.price) {
    const premiumPct = ((snapshot.coinbaseTicker.price - snapshot.ticker.price) / snapshot.ticker.price) * 100;
    snapshot.coinbasePremium = {
      coinbasePrice: snapshot.coinbaseTicker.price,
      binancePrice: snapshot.ticker.price,
      premiumPct: +premiumPct.toFixed(4),
      // Nilai absolut kecil (±0.0x%) — deviasi yang penting
      signal: premiumPct > 0.05 ? 'US_BUYING' : premiumPct < -0.05 ? 'US_SELLING' : 'NEUTRAL',
    };
    delete snapshot.coinbaseTicker;
  }

  // ─── v8 §4.2: Kimchi Premium — euforia/ketakutan retail Asia ──────────────
  if (snapshot.kimchiRaw?.upbitUsd && snapshot.ticker?.price) {
    const kimchiPct = ((snapshot.kimchiRaw.upbitUsd - snapshot.ticker.price) / snapshot.ticker.price) * 100;
    snapshot.kimchiPremium = {
      upbitUsd: +snapshot.kimchiRaw.upbitUsd.toFixed(0),
      premiumPct: +kimchiPct.toFixed(2),
      signal: kimchiPct > 3 ? 'ASIA_EUPHORIA'        // historis dekat top lokal (kontrarian SHORT)
            : kimchiPct < -1 ? 'ASIA_FEAR'           // sering dekat bottom
            : 'NEUTRAL',
    };
    delete snapshot.kimchiRaw;
  }

  // ─── v8 §3.2: Funding divergence CEX vs DEX (Hyperliquid) ─────────────────
  if (snapshot.hyperliquid?.funding8hPct != null) {
    const cexRates = [
      snapshot.funding?.fundingRate,
      snapshot.multiFunding?.bybit,
      snapshot.multiFunding?.okx,
    ].filter(v => v != null);
    if (cexRates.length) {
      const cexAvg = cexRates.reduce((a, b) => a + b, 0) / cexRates.length;
      const div = snapshot.hyperliquid.funding8hPct - cexAvg;
      snapshot.hyperliquid.cexFundingAvg = +cexAvg.toFixed(4);
      snapshot.hyperliquid.fundingDivergence = +div.toFixed(4);
      // Divergen besar = whale DEX positioning beda dari retail CEX → kontrarian
      snapshot.hyperliquid.divergenceSignal =
        div > 0.02 ? 'DEX_MORE_BULLISH' : div < -0.02 ? 'DEX_MORE_BEARISH' : 'ALIGNED';
    }
  }

  // ─── v6: Estimasi level magnet likuidasi (computed, selalu ada) ──────────
  if (snapshot.ticker?.price) {
    snapshot.liqMagnets = computeLiquidationMagnets(snapshot.ticker.price);
  }

  // ─── v8: Sinyal komposit (KEBUTUHAN_SINYAL §6) — urutan penting ──────────
  snapshot.marketRegime          = computeMarketRegime(snapshot);          // §6.1
  snapshot.crossVenue            = computeCrossVenue(snapshot);            // §6.2
  snapshot.squeezeFuel           = computeSqueezeFuel(snapshot);           // §6.3 (butuh liqMagnets)
  snapshot.aggregateLiquidations = computeAggregateLiquidations(snapshot); // §3.5

  // ─── v7: Computed bandarmologi signals (smartMoneyScore butuh crossVenue) ─
  snapshot.fundingDivergence  = computeFundingDivergence(snapshot.funding, snapshot.multiFunding);
  snapshot.smartMoneyScore    = computeSmartMoneyScore(snapshot);

  // ─── v7: Cascade probability (butuh liqMagnets dari atas) ────────────────
  snapshot.cascadeProbability = computeCascadeProbability(snapshot);

  // ─── v6: Spot-Perp basis (dari ticker spot + funding markPrice) ──────────
  if (snapshot.ticker?.price && snapshot.funding?.markPrice) {
    const spot = snapshot.ticker.price;
    const perp = snapshot.funding.markPrice;
    const basisPct = ((perp - spot) / spot) * 100;
    snapshot.basis = {
      spot, perp,
      basisPct,
      // Perp premium tinggi = leverage long crowded (potensi long squeeze)
      // Perp discount = bearish/hedging
      signal: basisPct > 0.1 ? 'PERP_PREMIUM' : basisPct < -0.1 ? 'PERP_DISCOUNT' : 'NEUTRAL',
    };
  }

  // ─── Backwards compat: simpan klines lama (sparkline pakai closes array) ──
  if (snapshot.klinesMulti?.h1?.closes) {
    snapshot.klines = snapshot.klinesMulti.h1.closes.slice(-168);
  }

  // ─── Compute TA indicators per timeframe ─────────────────────────────────
  if (snapshot.klinesMulti) {
    const km = snapshot.klinesMulti;
    snapshot.indicators = {
      h1: computeIndicators(km.h1.closes),
      h4: computeIndicators(km.h4.closes),
      d1: computeIndicators(km.d1.closes),
    };

    // v5.3: Advanced metrics (ATR, VWAP, volume, swing S/R) per TF
    snapshot.advanced = {
      h1: computeAdvanced(km.h1),
      h4: computeAdvanced(km.h4),
      d1: computeAdvanced(km.d1),
    };

    // Higher-timeframe confluence
    const trends = ['h1', 'h4', 'd1'].map(k => snapshot.indicators[k]?.trend).filter(Boolean);
    const bullCount = trends.filter(t => t === 'BULLISH').length;
    const bearCount = trends.filter(t => t === 'BEARISH').length;
    snapshot.confluence = {
      bullish: bullCount,
      bearish: bearCount,
      neutral: 3 - bullCount - bearCount,
      alignment: bullCount === 3 ? 'STRONG_BULL'
              : bearCount === 3 ? 'STRONG_BEAR'
              : bullCount === 2 ? 'BULL'
              : bearCount === 2 ? 'BEAR'
              : 'MIXED',
    };

    // v5.3: Derive market stats dari d1 klines (PENGGANTI CoinGecko coins)
    const computed = deriveMarketStats(km.d1, snapshot.ticker?.price, snapshot.supply);
    if (computed) {
      // Merge: pakai computed sebagai sumber utama, CoinGecko sebagai cross-check
      snapshot.marketStats = {
        change7d:    computed.change7d  ?? snapshot.coingecko?.change7d,
        change30d:   computed.change30d ?? snapshot.coingecko?.change30d,
        marketCap:   computed.marketCap ?? snapshot.coingecko?.marketCap,
        athDistance: computed.athDistance,         // distance dari cycle high
        cycleHigh:   computed.cycleHigh,
        athAbsolute: snapshot.coingecko?.ath,      // ATH absolut (kalau CoinGecko ok)
        btcDominance: snapshot.global?.btcDominance,
        coinDominance: snapshot.global?.coinDominance,   // v9: dominance coin aktif
        source: snapshot.coingecko ? 'computed+coingecko' : 'computed',
      };
    }
  }

  // ─── Trim klinesMulti payload (keep secukupnya untuk visual) ─────────────
  if (snapshot.klinesMulti) {
    const trim = (tf, n) => {
      const k = snapshot.klinesMulti[tf];
      if (!k) return;
      ['opens', 'highs', 'lows', 'closes', 'volumes'].forEach(key => {
        if (k[key]) k[key] = k[key].slice(-n);
      });
    };
    trim('h1', 50); trim('h4', 50); trim('d1', 30);
  }

  // ─── v8: Source health — supaya endpoint mati KETAHUAN, tidak senyap ──────
  // (pelajaran dari kasus ETF DefiLlama yang dead-code berbulan-bulan)
  const KEY_HEADER = { coinalyze: 'x-coinalyze-key', etfFlows: 'x-soso-key', fred: 'x-fred-key', newsCp: 'x-cryptopanic-key', nupl: 'x-fetch-nupl' };
  // coinbaseTicker/kimchiRaw sudah diubah jadi field premium → cek field turunannya
  const DERIVED_FIELD = { coinbaseTicker: 'coinbasePremium', kimchiRaw: 'kimchiPremium' };
  snapshot.sourceHealth = [
    ...SOURCES.map(([label, , optional, flag]) => ({
      source: label,
      ok: snapshot[DERIVED_FIELD[label] || label] != null,
      optional,
      ...(skipped(flag) ? { notApplicable: true } : {}),
    })),
    ...KEYED_SOURCES.map(([label, , flag]) => ({
      source: label === 'newsCp' ? 'cryptopanic' : label,
      ok: (label === 'newsCp' ? snapshot.newsSource === 'cryptopanic' : snapshot[label] != null),
      optional: true,
      needsKey: !getHeader(KEY_HEADER[label]),
      ...(skipped(flag) ? { notApplicable: true } : {}),
    })),
  ];

  snapshot.errors = errors;
  snapshot.degraded = degraded;
  snapshot.fetchMs = Date.now() - t0;

  return new Response(JSON.stringify(snapshot), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 's-maxage=10, stale-while-revalidate=30',
      'access-control-allow-origin': '*',
    },
  });
}
