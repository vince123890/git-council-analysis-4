// =============================================================================
//  BTC BANDARMOLOGI DASHBOARD · Gemini-only edition
// =============================================================================
//
//  Arsitektur (vs versi lama):
//    Lama: Browser → Vercel proxy → Anthropic/Gemini → balik
//          (sering 504 karena Vercel Hobby 60s + cold start dari Indonesia)
//    Baru: Browser → Gemini API langsung (Gemini support CORS)
//          + Vercel cuma untuk snapshot data (Binance dll yang block CORS)
//
//  Keuntungan:
//    • Tidak ada Vercel timeout — browser hold connection sendiri
//    • Latency lebih rendah (1 hop, bukan 2)
//    • Struktur JSON pasti valid (responseMimeType + responseSchema)
//    • Code 60% lebih ringkas (no Claude branch, no proxy parsing)
// =============================================================================

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'btc_bandarmologi_gemini_key';
const STORAGE_MODEL = 'btc_bandarmologi_gemini_model';
const STORAGE_GROUNDING = 'btc_bandarmologi_gemini_grounding';
const STORAGE_MODE = 'btc_bandarmologi_analysis_mode';
const STORAGE_CGKEY = 'btc_bandarmologi_coinalyze_key';
// v8: FREE KEY tambahan (semua opsional & gratis — pola BYOK seperti Coinalyze)
const STORAGE_DATAKEYS = 'btc_bandarmologi_data_keys';     // JSON {soso, fred, cryptopanic, btcdata}
// v8: cache client-side untuk sumber lambat/rate-limit ketat (Edge tetap stateless)
const SLOW_CACHE_KEY = 'btc_bandarmologi_slow_cache';      // JSON {nupl:{ts,data}, etf:{ts,data}}
const TTL_NUPL_MS = 24 * 3600 * 1000;   // bitcoin-data.com: 8 req/jam, 15/hari → 1×/hari cukup (data harian)
const TTL_ETF_MS  = 4 * 3600 * 1000;    // ETF flow update harian → 4 jam aman
// v9: multi-coin
const STORAGE_SYMBOL = 'btc_bandarmologi_symbol';
const COIN_LIST = ['BTC', 'ETH', 'SOL', 'XRP'];
const COIN_NAMES = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', XRP: 'XRP' };

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Model pilihan (urut dari paling efisien)
const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    cost: '~$0.001', latency: '5-12s',
    badge: 'Fast',
    badgeColor: 'text-blue-400',
    desc: 'Cepat & efisien. Cocok untuk Quick mode & Council harian.',
    default: true },
  { id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    cost: '~$0.01',  latency: '25-60s',
    badge: '★ Council Pro',
    badgeColor: 'text-purple-400',
    desc: 'Reasoning terdalam. Direkomendasikan untuk Agent Council — hasil lebih akurat.',
    default: false },
  { id: 'gemini-2.0-flash',
    label: 'Gemini 2.0 Flash',
    cost: '~$0.0005', latency: '4-10s',
    badge: 'Hemat',
    badgeColor: 'text-zinc-400',
    desc: 'Paling murah & cepat. Cocok untuk Quick mode saja.',
    default: false },
];

// Timeout di browser (tidak ada batas Vercel di sini!)
const ANALYZE_TIMEOUT_MS = 90_000;   // 90 detik
const TEST_TIMEOUT_MS    = 20_000;   // 20 detik

// ─────────────────────────────────────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  // Data
  snapshot: null,
  analysis: null,
  // v9: multi-coin — coin aktif + cache snapshot/analisis per coin
  symbol: 'BTC',
  snapshotByCoin: {},
  analysisByCoin: {},
  lastFetchByCoin: {},
  lastAnalyzeByCoin: {},
  // UX
  loading: false,
  analyzing: false,
  error: null,
  analyzeError: null,
  analyzeHint: null,
  // Timestamps
  lastFetch: null,
  lastAnalyze: null,
  // Config
  apiKey: '',
  model: 'gemini-2.5-flash',
  grounding: false,             // ← v4: Google Search grounding (off by default)
  analysisMode: 'council',      // ← v5: 'quick' (1 call) | 'council' (multi-agent)
  councilPhase: null,           // ← v5: 'debate' | 'judge' | 'final' | null
  coinalyzeKey: '',             // ← v6: Coinalyze API key (opsional, GRATIS, terpisah dari Gemini)
  dataKeys: { soso: '', fred: '', cryptopanic: '', btcdata: '' },  // ← v8: FREE KEY opsional
  // Settings panel
  showSettings: false,
  showKeyValue: false,
  testResult: null,
  testing: false,
  // Transient draft — preserve input value across re-renders
  // (null = pakai state.apiKey; string = user lagi ngetik)
  keyDraft: null,
};

// Hydrate dari localStorage
try {
  state.apiKey = localStorage.getItem(STORAGE_KEY) || '';
  state.model = localStorage.getItem(STORAGE_MODEL) || 'gemini-2.5-flash';
  state.grounding = localStorage.getItem(STORAGE_GROUNDING) === 'true';
  state.analysisMode = localStorage.getItem(STORAGE_MODE) || 'council';
  state.coinalyzeKey = localStorage.getItem(STORAGE_CGKEY) || '';
  const dk = JSON.parse(localStorage.getItem(STORAGE_DATAKEYS) || '{}');
  state.dataKeys = { soso: dk.soso || '', fred: dk.fred || '', cryptopanic: dk.cryptopanic || '', btcdata: dk.btcdata || '' };
  const sym = localStorage.getItem(STORAGE_SYMBOL) || 'BTC';
  if (COIN_LIST.includes(sym)) state.symbol = sym;
} catch (_) { /* localStorage blocked → in-memory only */ }

// ── v8: cache client-side untuk sumber lambat (NUPL 24h, ETF 4h) ─────────────
function readSlowCache() {
  try { return JSON.parse(localStorage.getItem(SLOW_CACHE_KEY) || '{}'); } catch (_) { return {}; }
}
function writeSlowCache(cache) {
  try { localStorage.setItem(SLOW_CACHE_KEY, JSON.stringify(cache)); } catch (_) {}
}
const cacheStale = (entry, ttl) => !entry?.ts || (Date.now() - entry.ts) > ttl;

// ─────────────────────────────────────────────────────────────────────────────
//  Formatters
// ─────────────────────────────────────────────────────────────────────────────
const fmt = {
  usd: (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }),
  pct: (n) => n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%',
  ago: (n) => {
    if (!n) return '';
    const s = Math.floor((Date.now() - n) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  },
  maskKey: (k) => {
    if (!k) return '';
    if (k.length < 12) return '••••';
    return k.slice(0, 6) + '••••••••' + k.slice(-4);
  },
};

const pctFrom = (from, to) => (!from || !to) ? null : ((to - from) / from) * 100;

// ─────────────────────────────────────────────────────────────────────────────
//  HTML escape (cegah XSS dari snapshot/AI output)
// ─────────────────────────────────────────────────────────────────────────────
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render teks agent yang mengandung markdown sederhana (**bold**, \n).
 * Aman: esc() dulu baru convert ** → <strong>.
 */
function renderMd(s) {
  if (s == null) return '';
  return esc(s)
    // **bold** → <strong>
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-white font-medium">$1</strong>')
    // *italic* → <em>
    .replace(/\*([^*\n]+?)\*/g, '<em class="text-zinc-200">$1</em>')
    // newline → <br>
    .replace(/\n/g, '<br>');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Gemini API client (DIRECT dari browser, no Vercel proxy)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schema untuk structured JSON output — Gemini akan memaksa output sesuai
 * format ini. Tidak perlu lagi parsing regex/markdown.
 */
const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    tradeAction: {
      type: 'object',
      properties: {
        direction:          { type: 'string', enum: ['LONG', 'SHORT', 'WAIT'] },
        horizon:            { type: 'string' },
        confidence:         { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        entryLow:           { type: 'number' },
        entryHigh:          { type: 'number' },
        stopLoss:           { type: 'number' },
        takeProfit1:        { type: 'number' },
        takeProfit2:        { type: 'number' },
        riskRewardRatio:    { type: 'number' },
        positionSize:       { type: 'string' },
        invalidationReason: { type: 'string' },
        actionReasoning:    { type: 'string' },
      },
      required: ['direction', 'horizon', 'confidence', 'entryLow', 'entryHigh',
                 'stopLoss', 'takeProfit1', 'takeProfit2', 'riskRewardRatio',
                 'positionSize', 'invalidationReason', 'actionReasoning'],
    },
    signal:           { type: 'string', enum: ['STRONG_BUY', 'BUY', 'NEUTRAL', 'CAUTION', 'AVOID'] },
    signalReasoning:  { type: 'array', items: { type: 'string' } },
    supportLevel:     { type: 'number' },
    resistanceLevel:  { type: 'number' },
    whaleSummary:     { type: 'string' },
    newsHeadlines:    { type: 'array', items: { type: 'string' } },
    riskWarning:      { type: 'string' },

    // ─── v3 additions ────────────────────────────────────────────────────
    derivativesView: { type: 'string' },   // 1-2 kalimat: apa kata OI/LS/taker
    technicalView:   { type: 'string' },   // 1-2 kalimat: apa kata RSI/MACD/BB
    timeframeAlignment: {
      type: 'object',
      properties: {
        h1: { type: 'string', enum: ['BULLISH', 'BEARISH', 'NEUTRAL'] },
        h4: { type: 'string', enum: ['BULLISH', 'BEARISH', 'NEUTRAL'] },
        d1: { type: 'string', enum: ['BULLISH', 'BEARISH', 'NEUTRAL'] },
      },
      required: ['h1', 'h4', 'd1'],
    },

    // ─── v4 additions ────────────────────────────────────────────────────
    optionsView:   { type: 'string' },   // PCR + max pain interpretation
    onChainView:   { type: 'string' },   // MVRV cycle context
    macroView:     { type: 'string' },   // DXY/Gold/SPX correlation
    cycleStage:    { type: 'string', enum: ['ACCUMULATION', 'MARKUP', 'DISTRIBUTION', 'MARKDOWN', 'UNCLEAR'] },
    // ─── v6 addition ─────────────────────────────────────────────────────
    flowView:      { type: 'string' },   // ETF/stablecoin/CVD/basis/liquidation interpretation
  },
  required: ['tradeAction', 'signal', 'signalReasoning', 'supportLevel',
             'resistanceLevel', 'whaleSummary', 'newsHeadlines', 'riskWarning',
             'derivativesView', 'technicalView', 'timeframeAlignment',
             'optionsView', 'onChainView', 'macroView', 'cycleStage', 'flowView'],
};

/**
 * Build prompt yang concise tapi lengkap. Tidak perlu ulangi struktur JSON
 * di prompt karena responseSchema sudah memaksa output.
 */
/**
 * Build data section saja (dipakai bersama oleh quick mode & semua agent council).
 * Mengembalikan blok teks berisi seluruh snapshot data terformat.
 */
function buildDataSection(s) {
  // v9: coin aktif (snapshot membawa symbol/coinName dari server)
  const sym = s.symbol || 'BTC';
  const coinName = s.coinName || COIN_NAMES[sym] || sym;
  const num = (v, decimals = 2) => v == null ? 'N/A' : Number(v).toFixed(decimals);
  const big = (v, divisor = 1e9, suffix = 'B') =>
    v == null ? 'N/A' : '$' + (v / divisor).toFixed(2) + suffix;
  // sf = safe toFixed — tidak pernah throw meski v null/NaN/undefined
  const sf = (v, d = 2) => (v != null && !Number.isNaN(+v)) ? Number(v).toFixed(d) : '—';

  // v8: CryptoPanic menambah voting bullish/bearish per berita
  const newsLines = (s.news && s.news.length > 0)
    ? s.news.slice(0, 8).map((n, i) => {
        const votes = (n.bullishVotes != null || n.bearishVotes != null)
          ? ` (votes: ${n.bullishVotes ?? 0} bullish / ${n.bearishVotes ?? 0} bearish)` : '';
        return `${i + 1}. [${n.source}] ${n.title}${votes}`;
      }).join('\n')
    : '(berita tidak tersedia)';

  const oi = s.openInterest, ls = s.longShort, tv = s.takerVolume;

  const oiLine = oi
    ? `• Open Interest: ${big(oi.current, 1e9)} (${num(oi.change24h)}% 24h) ${
        oi.change24h > 2 && s.ticker?.change24h > 0 ? '→ NEW MONEY masuk (trend valid)' :
        oi.change24h < -2 && s.ticker?.change24h > 0 ? '→ SHORT COVER rally (lemah)' :
        oi.change24h > 2 && s.ticker?.change24h < 0 ? '→ NEW SHORTS open (bearish confirm)' :
        oi.change24h < -2 && s.ticker?.change24h < 0 ? '→ LONG capitulation (selling pressure)' :
        '→ neutral flow'
      }`
    : '• Open Interest: data tidak tersedia';

  const lsLine = ls
    ? `• Long/Short ratio TOP TRADER (smart money): ${num(ls.topTrader.current, 2)} (24h ago ${num(ls.topTrader.prev24h, 2)}, ${ls.topTrader.trend})
• Long/Short ratio RETAIL (global): ${num(ls.global.current, 2)} (24h ago ${num(ls.global.prev24h, 2)}, ${ls.global.trend})
• Smart money bias: ${ls.smartMoneyBias}${ls.smartMoneyBias.includes('SMART_LONG_RETAIL_SHORT') ? ' ⚠ contrarian setup' : ls.smartMoneyBias.includes('SMART_SHORT_RETAIL_LONG') ? ' ⚠ contrarian setup' : ''}`
    : '• Long/Short: data tidak tersedia';

  const tvLine = tv
    ? `• Taker buy/sell ratio: ${num(tv.current, 2)} (24h avg ${num(tv.avg24h, 2)}, trend ${tv.trend}) ${
        tv.current > 1.1 ? '→ buyer aggression' : tv.current < 0.9 ? '→ seller aggression' : '→ balanced'
      }`
    : '• Taker volume: data tidak tersedia';

  const ind = s.indicators || {};
  const conf = s.confluence;

  const fmtInd = (tf, label) => {
    const i = ind[tf];
    if (!i) return `• ${label}: data tidak tersedia`;
    const rsiTag = i.rsi == null ? '' :
      i.rsi >= 70 ? ' (OVERBOUGHT)' :
      i.rsi <= 30 ? ' (OVERSOLD)' :
      i.rsi >= 60 ? ' (bullish bias)' :
      i.rsi <= 40 ? ' (bearish bias)' : ' (neutral)';
    const macdTag = i.macd ? `MACD ${i.macd.bullish ? 'BULL' : 'BEAR'} (${i.macd.momentum.toLowerCase()})` : 'MACD N/A';
    const bbTag = i.bb ? `BB pos ${sf(i.bb.position != null ? i.bb.position * 100 : null, 0)}%${(i.bb.widthPct ?? 99) < 4 ? ' (SQUEEZE)' : ''}` : 'BB N/A';
    return `• ${label}: trend ${i.trend} · RSI ${num(i.rsi, 1)}${rsiTag} · ${macdTag} · ${bbTag} · EMA21 ${num(i.ema21, 0)} / EMA55 ${num(i.ema55, 0)}${i.ema200 ? ' / EMA200 ' + num(i.ema200, 0) : ''}`;
  };

  const confluenceLine = conf
    ? `• Multi-TF confluence: 1h+4h+1d → ${conf.alignment} (${conf.bullish} bull, ${conf.bearish} bear, ${conf.neutral} neutral)`
    : '';

  const opt = s.options;
  const optBlock = opt ? `
═══ OPTIONS FLOW (Deribit) ═══
• Put/Call Ratio (OI): ${num(opt.pcrOI, 2)} → ${opt.pcrSignal.replace('_', ' ')}
• Put/Call Ratio (24h vol): ${num(opt.pcrVolume, 2)}
• Max Pain (nearest expiry ${opt.nearestExpiry ? new Date(opt.nearestExpiry).toISOString().slice(0,10) : '—'}): $${opt.maxPain ? Number(opt.maxPain).toLocaleString() : '—'} (${opt.maxPainGap != null ? (opt.maxPainGap >= 0 ? '+' : '') + sf(opt.maxPainGap, 2) + '% from spot' : '—'})
• Total Call OI: ${big(opt.callOI, 1000, 'K contracts')} | Put OI: ${big(opt.putOI, 1000, 'K contracts')}` : '';

  const oc = s.onChain;
  const onChainBlock = oc ? `
═══ ON-CHAIN CYCLE (CoinMetrics) ═══
• MVRV ratio: ${num(oc.mvrv, 2)} → ${oc.mvrvSignal.replace('_', ' ')}
• Realized Price (cost basis): $${oc.realizedPrice ? Number(oc.realizedPrice).toLocaleString(undefined, {maximumFractionDigits: 0}) : '—'}  (current premium vs realtime: ${oc.currentPremium != null ? (oc.currentPremium >= 0 ? '+' : '') + sf(oc.currentPremium, 1) + '%' : oc.realizedPrice && s.ticker?.price ? (oc.currentPremium >= 0 ? '+' : '') + sf(((s.ticker.price - oc.realizedPrice) / oc.realizedPrice) * 100, 1) + '%' : '—'})
• MVRV percentile (30d): ${num(oc.mvrvPercentile30d, 0)}%` : '';

  const mc = s.macro;
  const fred = s.fred;
  const macroBlock = (mc || fred) ? `
═══ MACRO CONTEXT (${mc?.source === 'yahoo' ? 'Yahoo Finance' : mc?.source === 'stooq' ? 'Stooq fallback' : '—'}${fred ? ' + FRED' : ''}) ═══
• DXY: ${mc?.dxy?.close != null ? sf(mc.dxy.close, 2) + ' (' + (mc.dxy.changePct >= 0 ? '+' : '') + sf(mc.dxy.changePct, 2) + '%)' : 'N/A'}
• Gold: ${mc?.gold?.close != null ? '$' + sf(mc.gold.close, 0) + ' (' + (mc.gold.changePct >= 0 ? '+' : '') + sf(mc.gold.changePct, 2) + '%)' : 'N/A'}
• S&P 500: ${mc?.spx?.close != null ? sf(mc.spx.close, 0) + ' (' + (mc.spx.changePct >= 0 ? '+' : '') + sf(mc.spx.changePct, 2) + '%)' : 'N/A'}${fred?.vix ? `
• VIX (FRED, ${fred.vix.date}): ${sf(fred.vix.value, 1)} ${fred.vix.value > 25 ? '(fear tinggi — risk-off)' : fred.vix.value < 15 ? '(komplasen)' : '(normal)'}` : ''}${fred?.us10y ? `
• US 10Y yield (FRED, ${fred.us10y.date}): ${sf(fred.us10y.value, 2)}%` : ''}${fred?.dxyBroad ? `
• DXY broad/resmi (FRED, ${fred.dxyBroad.date}): ${sf(fred.dxyBroad.value, 1)}` : ''}
• Risk regime: ${mc?.riskRegime?.replace('_', ' ') ?? 'N/A'}` : '';

  // v5.3: Advanced metrics block (ATR, VWAP, volume, swing S/R)
  const adv = s.advanced || {};
  const advLine = (tf, label) => {
    const a = adv[tf];
    if (!a) return `• ${label}: data tidak tersedia`;
    const price = s.ticker?.price;
    const vwapTag = a.vwap && price
      ? (price > a.vwap ? `harga DI ATAS VWAP $${sf(a.vwap, 0)} (bullish)` : `harga DI BAWAH VWAP $${sf(a.vwap, 0)} (bearish)`)
      : 'VWAP N/A';
    const volTag = a.volume ? `volume ${a.volume.trend}${a.volume.spike ? ' + SPIKE' : ''}` : '';
    const swingTag = a.swing
      ? `swing R $${a.swing.nearestResistance ? sf(a.swing.nearestResistance, 0) : '—'} / S $${a.swing.nearestSupport ? sf(a.swing.nearestSupport, 0) : '—'}`
      : '';
    return `• ${label}: ATR ${a.atr ? '$' + sf(a.atr, 0) : '—'} (${a.atrPct ? sf(a.atrPct, 2) + '%' : '—'} volatilitas) · ${vwapTag} · ${volTag} · ${swingTag}`;
  };
  const advancedBlock = (adv.h1 || adv.h4 || adv.d1) ? `
═══ VOLATILITY · VWAP · VOLUME · SWING S/R (computed) ═══
${advLine('h1', '1H')}
${advLine('h4', '4H')}
${advLine('d1', '1D')}
PENTING untuk SL/TP: gunakan ATR sebagai basis. SL minimal 1.5× ATR dari entry, TP minimal 2-3× ATR. Jangan set SL/TP lebih sempit dari ATR (akan kena noise).` : '';

  // v5.3: Pakai marketStats (computed) sebagai sumber utama, fallback coingecko
  const ms = s.marketStats || {};
  const change7d  = ms.change7d  ?? s.coingecko?.change7d;
  const change30d = ms.change30d ?? s.coingecko?.change30d;
  const mcap      = ms.marketCap ?? s.coingecko?.marketCap;
  const athDist   = ms.athDistance ?? s.coingecko?.athDistance;
  const dominance = ms.btcDominance ?? s.global?.btcDominance;

  // ── v6: Institutional & cross-exchange flow ──────────────────────────────
  const etf  = s.etfFlows;
  const sc   = s.stablecoins;
  const cvd  = s.cvd;
  const basis = s.basis;
  const mf   = s.multiFunding;
  const cg   = s.coinalyze;

  // ── v7: Bandarmologi lanjutan ─────────────────────────────────────────────
  const sms  = s.smartMoneyScore;
  const bbl  = s.bybitLiquidations;
  const okxF = s.okxFlow;
  const fb   = s.futuresBasis;
  const fd   = s.fundingDivergence;
  const cp   = s.cascadeProbability;
  const oe   = s.onChainExt;

  // ── v8: KEBUTUHAN_SINYAL — positioning whale/institusi & sinyal komposit ──
  const mr   = s.marketRegime;
  const cv   = s.crossVenue;
  const sq   = s.squeezeFuel;
  const hl   = s.hyperliquid;
  const bfx  = s.bitfinexMargin;
  const cot  = s.cftcCot;
  const dvol = s.dvol;
  const cbp  = s.coinbasePremium;
  const kim  = s.kimchiPremium;
  const cmeG = s.cmeGap;
  const nupl = s.nupl;
  const miner = s.minerPressure;
  const pm   = s.polymarket;
  const aggL = s.aggregateLiquidations;

  // ── Smart Money Score block (sinyal agregat paling penting) ───────────────
  const smsBlock = sms ? `
═══ SMART MONEY CONVICTION SCORE (v8 — agregat bandarmologi) ═══
• Score: ${sms.score}/100 → arah ${sms.direction}, conviction ${sms.conviction}
  (${sms.score >= 70 ? '🟢 BULLISH KUAT — smart money mayoritas akumulasi' : sms.score >= 60 ? '🟡 BULLISH MODERAT' : sms.score <= 30 ? '🔴 BEARISH KUAT — smart money mayoritas distribusi' : sms.score <= 40 ? '🟠 BEARISH MODERAT' : '⚪ CONFLICTED — sinyal bertentangan, tunggu konfirmasi'})
• Bull pts: ${sms.bullPts} | Bear pts: ${sms.bearPts} (dari total bobot ${sms.totalWeight})
${cp ? `• Cascade probability: ${cp.probability}% risiko — ${cp.riskLevel} — ${cp.note}` : ''}` : '';

  // ── v8 §6.1: Market Regime — SIAPA yang menggerakkan harga ────────────────
  const regimeBlock = mr ? `
═══ MARKET REGIME — Price × OI × Funding (§6.1, KONTEKS UTAMA) ═══
• Regime: ${mr.label} | digerakkan oleh: ${mr.drivenBy} | health score: ${mr.healthScore}/100
• Input: Δprice 24h ${sf(mr.inputs.priceChange24h)}% · ΔOI 24h ${sf(mr.inputs.oiChange24h)}% · funding ${sf(mr.inputs.fundingPct, 4)}%
• Artinya: ${mr.note}` : '';

  // ── v8 §6.2: Cross-Venue Positioning Matrix ───────────────────────────────
  const cvBlock = cv ? `
═══ CROSS-VENUE POSITIONING MATRIX (§6.2 — confluence bandarmologi riil) ═══
${cv.rows.map(r => `• ${r.venue} (${r.cohort}): ${r.bias} — ${r.detail}`).join('\n')}
• VENUE AGREEMENT: ${cv.venueAgreement.verdict} (long ${cv.venueAgreement.long} / short ${cv.venueAgreement.short} / neutral ${cv.venueAgreement.neutral} dari ${cv.venueAgreement.total} venue) → confluence ${cv.confluence}
• ATURAN: ≥4 venue searah + confluence STRONG → boleh HIGH confidence. SPLIT → paksa WAIT/LOW.` : '';

  // ── v8 §6.3: Squeeze Fuel — "bearish" vs "jangan short, bahan squeeze" ────
  const sqBlock = (sq && sq.direction !== 'NONE') ? `
═══ SQUEEZE FUEL INDICATOR (§6.3) ═══
• Arah: ${sq.direction} | score: ${sq.score}/100
• Komponen: ${sq.components.join('; ')}
• Artinya: ${sq.direction === 'SHORT_SQUEEZE' ? 'bahan bakar squeeze NAIK menumpuk — JANGAN SHORT sembarangan meski sinyal bearish' : 'bahan bakar squeeze TURUN menumpuk — JANGAN LONG sembarangan meski sinyal bullish'}` : '';

  // ── v8 §3: Whale & institusi lintas venue (detail) ────────────────────────
  const whaleLines = [];
  if (hl) {
    whaleLines.push(`• Hyperliquid (perp DEX whale): funding 8h-eq ${sf(hl.funding8hPct, 4)}% vs rata2 CEX ${hl.cexFundingAvg != null ? sf(hl.cexFundingAvg, 4) + '%' : '—'} → divergence ${hl.fundingDivergence != null ? sf(hl.fundingDivergence, 4) + '%' : '—'} (${hl.divergenceSignal || '—'}${hl.divergenceSignal === 'DEX_MORE_BULLISH' ? ' — whale DEX lebih bullish dari retail CEX, kontrarian' : hl.divergenceSignal === 'DEX_MORE_BEARISH' ? ' — whale DEX lebih bearish, hati-hati' : ''}) · OI $${hl.openInterestUsd ? (hl.openInterestUsd / 1e9).toFixed(2) + 'B' : '—'}`);
  }
  if (bfx) {
    whaleLines.push(`• Bitfinex margin (whale legacy): long ${sf(bfx.longBtc, 0)} ${sym} (Δ24h ${bfx.longDelta24hPct != null ? sf(bfx.longDelta24hPct) + '%' : '—'}) vs short ${sf(bfx.shortBtc, 0)} ${sym} (Δ24h ${bfx.shortDelta24hPct != null ? sf(bfx.shortDelta24hPct) + '%' : '—'}) → ${bfx.signal}${bfx.signal === 'WHALE_LONG_BUILDUP' ? ' (whale akumulasi — bias LONG)' : bfx.signal === 'SHORT_BUILDUP' ? ' (short menumpuk — bahan squeeze naik)' : ''}`);
  }
  if (cot) {
    whaleLines.push(`• CFTC COT CME (mingguan, report ${cot.reportDate || '—'}; SINYAL LAMBAT — bobot swing, bukan scalp):`);
    whaleLines.push(`  - Hedge funds (lev money): net ${cot.leveragedFunds.net} kontrak (ΔWoW ${cot.leveragedFunds.netDeltaWoW ?? '—'}) → ${cot.levSignal}${cot.levSignal === 'HEDGE_FUNDS_COVERING' ? ' (short ditutup — bullish marginal)' : ''}`);
    whaleLines.push(`  - Asset managers (institusi): net ${cot.assetManagers.net} kontrak (ΔWoW ${cot.assetManagers.netDeltaWoW ?? '—'}) → ${cot.amSignal}`);
  }
  if (aggL) {
    whaleLines.push(`• Likuidasi agregat ${aggL.venues.join('+')}: long $${aggL.totalLongLiqM}M vs short $${aggL.totalShortLiqM}M → ${aggL.signal}${aggL.signal === 'CONFIRMED_LONG_WASHOUT' ? ' ⚡ washout 2 bursa serentak — reversal LONG lebih kuat!' : aggL.signal === 'CONFIRMED_SHORT_SQUEEZE' ? ' ⚡ squeeze 2 bursa serentak!' : ''}`);
  }
  const whaleBlock = whaleLines.length ? `
═══ WHALE & INSTITUSI LINTAS VENUE (§3 — inti bandarmologi) ═══
${whaleLines.join('\n')}` : '';

  // ── v8 §4: Premium / arbitrase ────────────────────────────────────────────
  const premLines = [];
  if (cbp) {
    premLines.push(`• Coinbase Premium (US): ${cbp.premiumPct >= 0 ? '+' : ''}${sf(cbp.premiumPct, 4)}% → ${cbp.signal}${cbp.signal === 'US_BUYING' ? ' (tekanan beli US — institusi/ETF, bias LONG)' : cbp.signal === 'US_SELLING' ? ' (diskon US — distribusi, bias SHORT)' : ''}`);
  }
  if (kim) {
    premLines.push(`• Kimchi Premium (Asia): ${kim.premiumPct >= 0 ? '+' : ''}${sf(kim.premiumPct)}% → ${kim.signal}${kim.signal === 'ASIA_EUPHORIA' ? ' (euforia retail Asia >3% — historis dekat TOP lokal, kontrarian SHORT)' : kim.signal === 'ASIA_FEAR' ? ' (negatif — ketakutan/apatis, sering dekat bottom)' : ''}`);
  }
  if (cmeG?.level) {
    premLines.push(`• CME Gap belum tertutup: $${cmeG.level.toLocaleString()} (${cmeG.direction === 'BELOW_PRICE' ? 'di BAWAH harga' : 'di ATAS harga'}, gap ${sf(cmeG.gapPct)}%, umur ${cmeG.ageDays} hari) → magnet harga, sangat sering di-fill — pakai sebagai level TP/SL tambahan`);
  }
  const premiumBlock = premLines.length ? `
═══ PREMIUM & ARBITRASE (§4 — computed) ═══
${premLines.join('\n')}` : '';

  // ── v8 §3.4: DVOL — implied volatility ────────────────────────────────────
  const dvolBlock = dvol ? `
═══ IMPLIED VOLATILITY — Deribit DVOL (§3.4) ═══
• DVOL: ${sf(dvol.current, 1)} (avg 7d ${sf(dvol.avg7d, 1)}, range ${sf(dvol.min7d, 1)}–${sf(dvol.max7d, 1)}, posisi ${dvol.positionPct}% dari range) → ${dvol.signal}
${dvol.signal === 'VOL_COMPRESSED' ? '• Artinya: kompresi vol — market komplasen, BREAKOUT BESAR menunggu (arah ambil dari sinyal lain)' : dvol.signal === 'VOL_SPIKE' ? '• Artinya: vol spike — panik; jika harga turun bersamaan, sering dekat bottom lokal (kontrarian LONG)' : '• Artinya: volatilitas normal'}` : '';

  // ── v8 §5: NUPL + miner + prediction market ───────────────────────────────
  const extraOnchainLines = [];
  if (nupl) {
    extraOnchainLines.push(`• NUPL (bitcoin-data.com${nupl.cached ? ', cache <24h' : ''}, ${nupl.date || '—'}): ${sf(nupl.nupl, 3)} → ${nupl.signal}${nupl.signal === 'EUPHORIA' ? ' (>0.75 — euforia, bias distribusi/SHORT swing)' : nupl.signal === 'CAPITULATION' ? ' (<0 — kapitulasi, zona akumulasi/LONG swing)' : ''}`);
  }
  if (miner) {
    extraOnchainLines.push(`• Miner pressure: hashrate ${sf(miner.hashFromPeak30dPct, 1)}% dari peak 30d, revenue ${miner.revFromPeak30dPct != null ? sf(miner.revFromPeak30dPct, 1) + '%' : '—'} → ${miner.signal}${miner.signal === 'MINER_STRESS' ? ' (tekanan jual miner — bias SHORT pelan)' : ''}`);
  }
  if (pm?.markets?.length) {
    extraOnchainLines.push(`• Polymarket (prediction market, eksperimental — bobot kecil):`);
    pm.markets.forEach(m => extraOnchainLines.push(`  - "${m.question}" → YES ${m.yesProbPct}%${m.volume24h ? ` (vol 24h $${m.volume24h.toLocaleString()})` : ''}`));
  }
  const extraOnchainBlock = extraOnchainLines.length ? `
═══ ON-CHAIN CYCLE EXTRA & SENTIMEN PASAR BERDUIT (§5) ═══
${extraOnchainLines.join('\n')}` : '';

  const instLines = [];

  if (etf) {
    instLines.push(`• Bitcoin ETF net flow harian terakhir (${etf.lastDate || '—'}${etf.cached ? ', cache' : ''}): ${etf.netFlow24h >= 0 ? '+' : ''}$${(etf.netFlow24h / 1e6).toFixed(1)}M → ${etf.signal} ${etf.signal === 'INFLOW' ? '(institusi AKUMULASI — bullish kuat)' : etf.signal === 'OUTFLOW' ? '(institusi DISTRIBUSI — bearish)' : ''}${etf.flow5dSum != null ? ` · 5d sum ${etf.flow5dSum >= 0 ? '+' : ''}$${(etf.flow5dSum / 1e6).toFixed(0)}M` : ''}${etf.streak ? ` · streak ${etf.streak} hari ${etf.streakDirection}${etf.streakDirection === 'OUTFLOW' && etf.streak >= 3 ? ' ⚠ outflow ≥3 hari = bias SHORT institusi' : ''}` : ''}`);
  }
  if (sc) {
    instLines.push(`• Stablecoin supply: $${(sc.total / 1e9).toFixed(1)}B (7d ${sc.change7d >= 0 ? '+' : ''}${num(sc.change7d)}%) → ${sc.liquiditySignal} ${sc.liquiditySignal === 'EXPANDING' ? '(dry powder bertambah — amunisi beli)' : sc.liquiditySignal === 'CONTRACTING' ? '(likuiditas keluar)' : ''}`);
  }
  if (cvd) {
    instLines.push(`• CVD Binance Futures (1000 trade terakhir): delta ${cvd.deltaPct >= 0 ? '+' : ''}${num(cvd.deltaPct)}% → ${cvd.signal} ${cvd.signal.includes('BUY') ? '(agresor beli dominan)' : cvd.signal.includes('SELL') ? '(agresor jual dominan)' : ''}`);
  }
  if (okxF) {
    instLines.push(`• OKX top trader L/S: ratio ${num(okxF.longShortRatio, 4)} → ${okxF.bias} (trend: ${okxF.trend}) ${okxF.bias === 'LONG_DOMINANT' ? '(smart money OKX net long)' : okxF.bias === 'SHORT_DOMINANT' ? '(smart money OKX net short)' : ''}`);
  }
  if (bbl) {
    const washoutTag = bbl.washoutSignal !== 'NONE'
      ? ` ⚡ ${bbl.washoutSignal === 'LONG_WASHOUT' ? 'LONG WASHOUT — kapitulasi, contrarian bullish!' : 'SHORT SQUEEZE — sedang berlangsung!'}`
      : '';
    instLines.push(`• Bybit liquidations: long liq ${num(bbl.longLiqValueM)}M$ (${bbl.longLiqCount} events) vs short liq ${num(bbl.shortLiqValueM)}M$ (${bbl.shortLiqCount} events) → ${bbl.momentum}${washoutTag}`);
  }
  if (fb) {
    instLines.push(`• Futures basis (mark vs index): ${fb.basisPct >= 0 ? '+' : ''}${num(fb.basisPct, 4)}% (≈${num(fb.annualizedPct, 1)}% annualized) → ${fb.regime} ${fb.regime.includes('CONTANGO') ? '(long premium — bullish bias)' : fb.regime.includes('BACKWARDATION') ? '(discount — bearish/panic)' : ''}`);
  }
  if (basis) {
    instLines.push(`• Spot-Perp basis (spot vs mark): ${basis.basisPct >= 0 ? '+' : ''}${num(basis.basisPct, 3)}% → ${basis.signal} ${basis.signal === 'PERP_PREMIUM' ? '(perp di atas spot — long crowded)' : basis.signal === 'PERP_DISCOUNT' ? '(perp di bawah spot — bearish/hedging)' : ''}`);
  }
  if (fd) {
    instLines.push(`• Funding divergence score: ${num(fd.score, 3)} → consensus ${fd.consensus} — ${fd.interpretation}`);
  }
  if (mf) {
    const parts = [];
    if (mf.bybit != null) parts.push(`Bybit ${num(mf.bybit, 4)}%`);
    if (mf.okx   != null) parts.push(`OKX ${num(mf.okx, 4)}%`);
    if (parts.length) instLines.push(`• Funding lintas bursa: Binance ${num(s.funding?.fundingRate, 4)}% · ${parts.join(' · ')}`);
  }
  if (cg) {
    const cgParts = [];
    if (cg.aggregatedOI != null) cgParts.push(`OI agregat $${(cg.aggregatedOI / 1e9).toFixed(2)}B`);
    if (cg.liqBias) cgParts.push(`liquidation 24h: ${cg.liqBias}${cg.longLiquidation != null ? ` (long $${(cg.longLiquidation/1e6).toFixed(1)}M vs short $${(cg.shortLiquidation/1e6).toFixed(1)}M)` : ''}`);
    if (cgParts.length) instLines.push(`• Coinalyze (lintas bursa): ${cgParts.join(' · ')}`);
  }
  // Liquidation magnet levels (computed) — selalu ada
  const lm = s.liqMagnets;
  if (lm) {
    instLines.push(`• Liquidation MAGNET [ESTIMASI KASAR ±2-5%]:`);
    instLines.push(`  - Zona BAWAH (long liq): $${lm.downMagnet.from.toLocaleString()}–$${lm.downMagnet.to.toLocaleString()} | est. 25x $${lm.longLiqs[2].price.toLocaleString()}, 50x $${lm.longLiqs[1].price.toLocaleString()}`);
    instLines.push(`  - Zona ATAS (short liq/squeeze): $${lm.upMagnet.from.toLocaleString()}–$${lm.upMagnet.to.toLocaleString()} | est. 25x $${lm.shortLiqs[2].price.toLocaleString()}, 50x $${lm.shortLiqs[1].price.toLocaleString()}`);
  }
  const institutionalBlock = instLines.length ? `
═══ INSTITUTIONAL & CROSS-EXCHANGE FLOW (v7 — bandarmologi inti) ═══
${instLines.join('\n')}` : '';

  // ── v7: On-chain extended (Exchange Flow + Active Addresses) ──────────────
  const onChainExtBlock = oe ? `
═══ ON-CHAIN EXTENDED (CoinMetrics Community) ═══
• Exchange Net Flow: ${oe.netFlowM != null ? (oe.netFlowM >= 0 ? '+' : '') + sf(oe.netFlowM, 0) + 'M USD' : 'N/A'} → ${oe.exchangeFlowSignal || 'N/A'} ${oe.exchangeFlowSignal === 'ACCUMULATION' ? '(banyak BTC keluar exchange — akumulasi, bullish)' : oe.exchangeFlowSignal === 'DISTRIBUTION' ? '(banyak BTC masuk exchange — tekanan jual, bearish)' : ''}
• Active Addresses: ${oe.activeAddresses != null ? Number(oe.activeAddresses).toLocaleString() : 'N/A'}${oe.adrTrend ? ' → ' + oe.adrTrend + (oe.adrTrend === 'RISING' ? ' (demand jaringan naik, bullish)' : oe.adrTrend === 'FALLING' ? ' (aktivitas melemah)' : '') : ''}` : '';

  return `═══ HARGA & MARKET — ${coinName} (${sym}) ═══
• ${sym}/USDT spot: $${num(s.ticker?.price, 2)}
• 24h change: ${num(s.ticker?.change24h)}% | High/Low: $${num(s.ticker?.high24h, 0)} / $${num(s.ticker?.low24h, 0)}
• 7d / 30d: ${num(change7d)}% / ${num(change30d)}%
• Market cap: ${big(mcap, 1e12, 'T')}
• 24h volume: ${big(s.ticker?.volume24h)}
• ${sym} dominance: ${num(sym === 'BTC' ? dominance : (s.marketStats?.coinDominance ?? s.global?.coinDominance))}%${sym !== 'BTC' ? ` (BTC dominance: ${num(dominance)}%)` : ''}
• Distance dari cycle high: ${num(athDist)}%${ms.cycleHigh ? ` (cycle high $${Number(ms.cycleHigh).toLocaleString(undefined,{maximumFractionDigits:0})})` : ''}
${smsBlock}${regimeBlock}${cvBlock}${sqBlock}
═══ ORDER BOOK (spot) ═══
• Top bid walls: ${big(s.orderBook?.bidWall, 1e6, 'M')}
• Top ask walls: ${big(s.orderBook?.askWall, 1e6, 'M')}
• Bid dominance: ${s.orderBook?.ratio ? (s.orderBook.ratio * 100).toFixed(1) + '%' : 'N/A'}
• Best bid: $${num(s.orderBook?.bids?.[0]?.price, 0)} | Best ask: $${num(s.orderBook?.asks?.[0]?.price, 0)}

═══ DERIVATIVES INTELLIGENCE (Binance Futures) ═══
• Funding rate (perp): ${num(s.funding?.fundingRate, 4)}%  ${(s.funding?.fundingRate ?? 0) > 0.01 ? '(longs crowded — pay shorts)' : (s.funding?.fundingRate ?? 0) < -0.01 ? '(shorts crowded — pay longs)' : '(neutral)'}
${oiLine}
${lsLine}
${tvLine}${institutionalBlock}${whaleBlock}${premiumBlock}${dvolBlock}${onChainExtBlock}${extraOnchainBlock}

═══ TECHNICAL ANALYSIS (multi-timeframe, pre-computed) ═══
${fmtInd('h1', '1H')}
${fmtInd('h4', '4H')}
${fmtInd('d1', '1D')}
${confluenceLine}${advancedBlock}${optBlock}${onChainBlock}${macroBlock}

═══ SENTIMENT & NETWORK ═══
• Fear & Greed: ${s.fearGreed?.value ?? 'N/A'} (${s.fearGreed?.label ?? 'N/A'})
• Hashrate: ${s.network?.hashrate ? (s.network.hashrate / 1e9).toFixed(2) + ' EH/s' : 'N/A'}
• Mempool fast fee: ${s.mempool?.fastestFee ?? 'N/A'} sat/vB

═══ BERITA TERKINI ═══
${newsLines}`;
}

/**
 * QUICK MODE prompt (single-call, sama seperti v4). Reuse buildDataSection.
 */
function buildPrompt(s) {
  const num = (v, decimals = 2) => v == null ? 'N/A' : Number(v).toFixed(decimals);
  const big = (v, divisor = 1e9, suffix = 'B') =>
    v == null ? 'N/A' : '$' + (v / divisor).toFixed(2) + suffix;

  const coinName = s.coinName || COIN_NAMES[s.symbol] || s.symbol || 'Bitcoin';
  const symP = s.symbol || 'BTC';
  return `Kamu adalah ${coinName} (${symP}) bandarmologi trader senior dengan 10+ tahun pengalaman membaca order flow, derivatives positioning, dan smart money behavior.

Analisis snapshot REAL-TIME berikut, lalu berikan trade action plan terstruktur.

${buildDataSection(s)}

TUGAS:
Analisis dengan kaidah bandarmologi PLUS confluence multi-timeframe.
Berikan trade action plan untuk horizon 1-3 hari (atau lebih sesuai kondisi).

KAIDAH BACA DATA (gunakan untuk reasoning):
1. CONFIRMATION dari Open Interest:
   - OI naik + harga naik = trend valid (HIGH confidence LONG)
   - OI turun + harga naik = short squeeze saja (LOW confidence, rentan reverse)
   - OI naik + harga turun = real selling (HIGH confidence SHORT)
2. SMART MONEY vs RETAIL:
   - Top trader long, retail short = bullish setup (smart money positioned)
   - Top trader short, retail long = bearish setup (retail jadi exit liquidity)
3. TAKER pressure:
   - Taker buy ratio > 1.1 dengan harga naik = real demand
   - Taker buy < 0.9 dengan harga turun = real distribution
4. MULTI-TF CONFLUENCE:
   - 3 TF aligned (STRONG_BULL/BEAR) = HIGH confidence
   - 2 TF aligned = MEDIUM confidence  
   - Mixed = LOW / WAIT
5. RSI extreme + diverge dari TF lain = sinyal reversal
6. BB squeeze (widthPct < 4%) = volatility expansion incoming
7. Funding extreme (>0.05% atau <-0.05%) = mean reversion likely
8. OPTIONS FLOW (v4):
   - PCR OI > 1.0 = puts dominant (BEARISH sentiment, atau contrarian bullish kalau extreme)
   - PCR OI < 0.5 = calls dominant (BULLISH, atau contrarian bearish kalau extreme < 0.35)
   - Max pain efek magnet: harga sering bergerak ke max pain menjelang expiry (terutama 3-7 hari sebelumnya)
9. ON-CHAIN MVRV (v4):
   - MVRV > 3.5 = CYCLE TOP territory (historical sell zone) — caution untuk LONG
   - MVRV 1.5-3.5 = healthy bull range
   - MVRV < 1.0 = CYCLE BOTTOM (historical buy zone)
   - Realized Price = cost basis market — sering jadi support psikologis kuat
10. MACRO (v4):
   - DXY rally + SPX fall = RISK_OFF → crypto kemungkinan ikut turun
   - DXY weak + SPX rally = RISK_ON → crypto tailwind
   - Jangan paksa direction ${symP} kalau macro lawan arah (kecuali ada sinyal idiosyncratic kuat dari derivatives/on-chain)
11. ATR · VWAP · VOLUME · SWING (v5.3 — PENTING untuk presisi):
   - ATR = volatilitas riil. SL HARUS minimal 1.5× ATR dari entry (kalau lebih sempit, kena noise/wick). TP1 minimal 2× ATR, TP2 minimal 3× ATR.
   - VWAP = level institusi. Harga di atas VWAP = bias bullish, di bawah = bearish. Entry LONG lebih bagus dekat/di atas VWAP.
   - Volume RISING konfirmasi move; volume FALLING saat harga naik = momentum melemah (waspada). Volume SPIKE = sering titik reversal/exhaustion.
   - Swing S/R = level riil dari price action. Pakai swing support sebagai basis SL untuk LONG, swing resistance sebagai TP. Lebih akurat dari order book walls.
12. BANDARMOLOGI v7 — SMART MONEY SIGNALS (PRIORITAS TERTINGGI):
   - SMART MONEY SCORE (0-100): angka agregat dari semua sinyal bandarmologi. Score >70 = mayoritas sinyal akumulasi → LONG. Score <30 = distribusi → SHORT. Score 40-60 = CONFLICTED → WAIT atau posisi kecil.
   - CASCADE PROBABILITY: jika >65% → HINDARI ENTRY, risiko cascade tinggi. Jika <35% → kondisi aman untuk posisi.
   - Bybit Liquidations: LONG_WASHOUT = kapitulasi masif, contrarian BULLISH — bottom lokal lebih mungkin. SHORT_SQUEEZE = short cover massal, harga terpaksa naik. Gunakan sebagai timing entry.
   - OKX Top Trader L/S: konfirmasi independen dari Binance. Jika Binance smart money bullish + OKX bullish = double confirmation LONG.
   - Futures Basis (mark vs index): CONTANGO_BULLISH = pasar bullish tapi waspadai crowding. BACKWARDATION_BEARISH = panik/panic — kontrarian bullish jangka pendek.
   - Funding Divergence Score: WEAK consensus (>1.0) → sinyal funding tidak reliable, jangan terlalu percaya. STRONG consensus (<0.3) → arah funding riil.
   - ETF net INFLOW = institusi akumulasi langsung (bullish confirm terkuat). OUTFLOW = distribusi institusi (bearish). Ini bobot tinggi — duit institusi riil.
   - Stablecoin supply EXPANDING = dry powder bertambah, amunisi beli menunggu (bullish lingkungan). CONTRACTING = likuiditas keluar (bearish).
   - CVD Binance Futures positif (agresor beli) konfirmasi demand riil; CVD negatif = distribusi. Cocokkan dengan OKX flow.
   - Spot-Perp basis: PERP_PREMIUM tinggi = long leverage crowded → rentan long squeeze (hati2 LONG). PERP_DISCOUNT = bearish tapi bisa jadi setup reversal.
   - Funding lintas bursa: kalau SEMUA bursa funding tinggi positif = long sangat crowded (mean reversion turun lebih mungkin).
   - LIQUIDATION MAGNET (ESTIMASI KASAR ±2-5% dari level nyata): pakai ZONA bukan angka spesifik sebagai area waspada.
   - PRIORITAS: Smart Money Score + Bybit liquidation + ETF flow + CVD multi-exchange = confluence bandarmologi terkuat → boleh HIGH confidence.
   - ON-CHAIN EXTENDED (NVT, SOPR): NVT >150 = bubble zone (hati2 LONG). SOPR <1 = capitulation = zona beli fundamental terbaik.
13. MARKET REGIME v8 (KONTEKS PALING PENTING — baca duluan):
   - SPOT_LED_RALLY = rally paling sehat → LONG conviction tinggi. SHORT_COVERING = rally lemah, JANGAN kejar.
   - LONG_LIQUIDATION/DELEVERAGING = tunggu washout selesai → setelahnya sering reversal LONG.
   - Regime menjawab: harga naik karena spot buying sehat, atau leverage rapuh? Sesuaikan confidence.
14. CROSS-VENUE MATRIX v8 (confluence bandarmologi sesungguhnya):
   - ≥4 venue searah (Binance/OKX/Bitfinex/Hyperliquid/CME) + STRONG → boleh HIGH confidence ke arah itu.
   - SPLIT → WAJIB WAIT atau LOW confidence, jangan paksa direction.
   - COT CME = sinyal MINGGUAN (lambat) — bobot untuk swing/posisi, bukan timing scalp.
   - Hyperliquid divergence: whale DEX beda arah dari retail CEX = sinyal kontrarian, beri perhatian.
15. SQUEEZE FUEL v8: jika SHORT_SQUEEZE score tinggi → JANGAN SHORT meski bearish (bahan bakar naik menumpuk). LONG_SQUEEZE tinggi → jangan LONG agresif. Ini pembeda "bearish" vs "berbahaya untuk short".
16. PREMIUM v8:
   - Coinbase premium positif persisten = institusi US beli (bias LONG); diskon dalam = distribusi US.
   - Kimchi premium >3% = euforia retail Asia → kontrarian SHORT dekat top; negatif = dekat bottom.
   - CME gap belum tertutup = magnet harga yang sangat sering di-fill → masukkan ke pertimbangan TP/SL.
17. VOLATILITAS & CYCLE v8:
   - DVOL VOL_COMPRESSED = breakout besar menunggu — perketat entry, siapkan kedua skenario. VOL_SPIKE + harga turun = sering bottom lokal (kontrarian LONG).
   - NUPL >0.75 = euphoria (distribusi/SHORT swing), <0 = capitulation (akumulasi/LONG swing).
   - Miner MINER_STRESS = tekanan jual struktural pelan (bias bearish lemah).
   - ETF outflow streak ≥3 hari = bias SHORT institusi; inflow >$100M/hari = bias LONG institusi.
   - News votes CryptoPanic & Polymarket odds = konfirmasi sentimen, bobot kecil.

ATURAN KETAT (PASTI DIPATUHI):
• LONG → stopLoss < entryLow < entryHigh < takeProfit1 < takeProfit2
• SHORT → takeProfit2 < takeProfit1 < entryLow < entryHigh < stopLoss
• WAIT → semua harga ≈ harga current
• SL/TP HARUS berbasis ATR: jarak SL ≥ 1.5× ATR(1H atau 4H), TP1 ≥ 2× ATR, TP2 ≥ 3× ATR. Sejajarkan dengan swing S/R terdekat bila ada.
• riskRewardRatio minimum 1.5 untuk LONG/SHORT (kalau tidak tercapai → WAIT)
• Mixed/kontra signal → WAIT (jangan paksa direction)
• signalReasoning: tepat 3 poin singkat (cite specific data dari LAYER yang berbeda — misal: 1 dari TA, 1 dari derivatives, 1 dari on-chain/macro)
• newsHeadlines: top 3 headline relevan
• derivativesView: 1-2 kalimat — apa kata data OI+L/S+taker
• technicalView: 1-2 kalimat — apa kata RSI+MACD+BB+ATR/VWAP/volume multi-TF
• optionsView: 1-2 kalimat — apa kata PCR + max pain (kosongkan kalau data N/A)
• onChainView: 1-2 kalimat — apa kata MVRV cycle context (kosongkan kalau data N/A)
• macroView: 1-2 kalimat — apa kata DXY/Gold/SPX (kosongkan kalau data N/A)
• flowView: 1-2 kalimat — apa kata Smart Money Score + ETF flow + CVD + Bybit liq + OKX flow + basis (kosongkan kalau semua N/A)
• cycleStage: klasifikasi fase pasar saat ini — ACCUMULATION (low MVRV, sideways), MARKUP (rising MVRV, bullish trend), DISTRIBUTION (high MVRV, sideways/topping), MARKDOWN (falling, decreasing MVRV), atau UNCLEAR
• timeframeAlignment: harus konsisten dengan data multi-TF di atas
• HIGH confidence hanya jika MIN 2 TF aligned + derivatives confirm + macro tidak lawan arah
• Bahasa Indonesia untuk semua field text.`;
}

/**
 * Inti: panggil Gemini API langsung dari browser dengan structured output.
 *
 * @param {string} apiKey  - User's Gemini API key
 * @param {string} modelId - Model ID (e.g. 'gemini-2.5-flash')
 * @param {string} prompt  - The analysis prompt
 * @param {AbortSignal} signal - For cancellation
 * @returns {Promise<{ parsed: object, raw: string, usage: object, elapsed: number }>}
 */
async function callGemini(apiKey, modelId, prompt, signal, grounding = false) {
  const url = `${GEMINI_BASE}/${modelId}:generateContent`;
  const t0 = Date.now();

  // Grounding ⇄ responseSchema incompatible. Pakai schema enforcement kalau OFF,
  // pakai prompt-only JSON instruction + manual parse kalau ON.
  const body = {
    contents: [{ parts: [{ text: prompt + (grounding ? '\n\nPENTING: OUTPUT HARUS HANYA JSON valid sesuai schema yang disebutkan, tanpa markdown wrapper, tanpa preamble.' : '') }] }],
    generationConfig: {
      // Temperature rendah (0.35) untuk structured JSON output — mencegah model
      // "berkreasi" melanggar constraint harga (SL < entry < TP).
      // callAgentText (Bull/Bear) tetap 0.8 karena membutuhkan variasi argumen.
      temperature: 0.35,
      topP: 0.95,
      maxOutputTokens: 8192,
      ...(grounding
        ? {} // no schema/mime when grounding
        : { responseMimeType: 'application/json', responseSchema: ANALYSIS_SCHEMA }),
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
    ...(grounding ? { tools: [{ google_search: {} }] } : {}),
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  const elapsed = Date.now() - t0;

  // ── Handle HTTP error ─────────────────────────────────────────────────────
  if (!res.ok) {
    const errText = await res.text();
    let detail = errText, gStatus = '';
    try {
      const j = JSON.parse(errText);
      detail = j.error?.message || errText;
      gStatus = j.error?.status || '';
    } catch (_) {}
    const err = new Error((gStatus ? `[${gStatus}] ` : '') + detail.slice(0, 400));
    err.status = res.status;
    err.gStatus = gStatus;
    err.elapsed = elapsed;
    throw err;
  }

  const data = await res.json();

  // ── Handle blocked / no candidate ─────────────────────────────────────────
  if (data.promptFeedback?.blockReason) {
    const err = new Error(`Prompt blocked: ${data.promptFeedback.blockReason}`);
    err.status = 502;
    throw err;
  }
  const cand = data.candidates?.[0];
  if (!cand) {
    const err = new Error('No candidate in Gemini response');
    err.status = 502;
    throw err;
  }
  if (cand.finishReason === 'SAFETY' || cand.finishReason === 'RECITATION') {
    const err = new Error(`Stopped by Gemini: ${cand.finishReason}`);
    err.status = 502;
    throw err;
  }
  if (cand.finishReason === 'MAX_TOKENS') {
    const err = new Error('Response truncated (MAX_TOKENS) — coba ulang atau pakai model Pro');
    err.status = 502;
    throw err;
  }

  // ── Extract text — filter thinking parts (Gemini 2.5 Pro/Flash) ────────────
  const allParts = (cand.content?.parts || []);
  const responseParts = allParts.filter(p => !p.thought);
  const raw = (responseParts.length > 0 ? responseParts : allParts)
    .map(p => p.text || '').filter(Boolean).join('\n').trim();

  if (!raw) {
    const err = new Error(`Empty response from Gemini (finishReason: ${cand.finishReason})`);
    err.status = 502;
    throw err;
  }

  // ── Parse (responseMimeType=application/json sudah jamin JSON valid) ─────
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Fallback: strip markdown fences, extract {…}
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      const err = new Error(
        `JSON parse error: ${e.message}. ` +
        (raw.length < 20 ? `Response kosong (${raw.length} chars) — kemungkinan MAX_TOKENS terpotong.` : `Raw: "${raw.slice(0, 200)}"`)
      );
      err.status = 502;
      err.raw = raw.slice(0, 500);
      throw err;
    }
    try {
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch (e2) {
      const err = new Error(`JSON parse fallback juga gagal: ${e2.message} — response terpotong di tengah JSON.`);
      err.status = 502;
      err.raw = raw.slice(0, 500);
      throw err;
    }
  }

  // Capture grounding citations if available
  const groundingMeta = cand.groundingMetadata || null;

  return {
    parsed,
    raw,
    usage: data.usageMetadata || {},
    elapsed,
    finishReason: cand.finishReason,
    groundingMeta,
  };
}

/**
 * Wrapper dengan retry untuk transient errors.
 */
async function callGeminiWithRetry(apiKey, modelId, prompt, signal, grounding) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await callGemini(apiKey, modelId, prompt, signal, grounding);
    } catch (err) {
      lastErr = err;
      // Tidak retry kalau: auth error (401/403), bad request (400), atau user abort
      if (err.status === 400 || err.status === 401 || err.status === 403) throw err;
      if (signal?.aborted) throw err;
      if (attempt === 1) {
        await new Promise(r => setTimeout(r, 1500)); // wait sebelum retry
      }
    }
  }
  throw lastErr;
}

// =============================================================================
//  AGENT COUNCIL (v5) — multi-agent debate untuk keputusan lebih robust
// =============================================================================
//  Pipeline: Bull + Bear (paralel) → Debate Judge → Portfolio Manager (final)
//  Terinspirasi TradingAgents (Tauric Research) tapi diadaptasi untuk
//  browser + Gemini single-snapshot. Tiap agent = 1 Gemini call.
// =============================================================================

/**
 * Generic free-text agent call (untuk Bull & Bear yang output prosa).
 * Fix v5.2:
 *  - Filter p.thought === true (Gemini 2.5 Pro/Flash thinking model)
 *  - Tambah finishReason check
 *  - Retry sekali untuk transient empty/502
 */
async function callAgentText(apiKey, modelId, prompt, signal) {
  const url = `${GEMINI_BASE}/${modelId}:generateContent`;

  async function _call() {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, topP: 0.95, maxOutputTokens: 3500 },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      }),
      signal,
    });

    if (!res.ok) {
      const t = await res.text();
      let detail = t, gStatus = '';
      try { const j = JSON.parse(t); detail = j.error?.message || t; gStatus = j.error?.status || ''; } catch (_) {}
      const err = new Error((gStatus ? `[${gStatus}] ` : '') + detail.slice(0, 300));
      err.status = res.status;
      throw err;
    }

    const data = await res.json();

    // ── No candidate ───────────────────────────────────────────────────────
    if (!data.candidates?.length) {
      const blockReason = data.promptFeedback?.blockReason;
      const err = new Error(blockReason
        ? `Agent diblokir Gemini: ${blockReason}`
        : 'Gemini tidak mengembalikan candidate (no_candidates)');
      err.status = 502;
      throw err;
    }

    const cand = data.candidates[0];
    const reason = cand.finishReason || 'UNKNOWN';

    // ── Blocked/failed finish reasons ─────────────────────────────────────
    if (['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'SPII'].includes(reason)) {
      const err = new Error(`Agent dihentikan Gemini (${reason}) — coba ulang, biasanya transient`);
      err.status = 502;
      err.finishReason = reason;
      throw err;
    }

    // ── Extract text — KECUALIKAN thought parts (thinking model) ──────────
    // Gemini 2.5 Pro/Flash mengembalikan parts dengan p.thought=true (internal reasoning)
    // yang bukan bagian dari response final. Kita hanya mau response-nya.
    const parts = (cand.content?.parts || []);
    const responseParts = parts.filter(p => !p.thought);
    let text = responseParts.map(p => p.text || '').filter(Boolean).join('\n').trim();

    // Fallback: kalau response parts kosong tapi ada thought parts, mungkin model
    // belum generate response — return singkat supaya pipeline tetap jalan
    if (!text && parts.length > 0) {
      // Ambil semua text termasuk thinking sebagai fallback
      text = parts.map(p => p.text || '').filter(Boolean).join('\n').trim();
    }

    if (!text) {
      const err = new Error(
        `Agent response kosong (finishReason: ${reason}) — ` +
        (reason === 'MAX_TOKENS' ? 'token habis, coba ulang' : 'kemungkinan safety filter atau thinking-only response')
      );
      err.status = 502;
      err.finishReason = reason;
      throw err;
    }

    return text;
  }

  // Retry sekali untuk empty/502 transient error
  try {
    return await _call();
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err.status === 400 || err.status === 401 || err.status === 403 || err.status === 429) throw err;
    // Tunggu lalu retry
    await new Promise(r => setTimeout(r, 2000));
    return _call();
  }
}

/**
 * Structured agent call (untuk Judge yang output JSON terstruktur).
 * Fix v5.1: tambah finishReason=MAX_TOKENS check + safe fallback parsing.
 * Fix v7: tambah retry sekali untuk transient error (sebelumnya tidak ada retry).
 */
async function callAgentStructured(apiKey, modelId, prompt, schema, signal) {
  const url = `${GEMINI_BASE}/${modelId}:generateContent`;

  async function _call() {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.35, topP: 0.95,
          maxOutputTokens: 3000,
          responseMimeType: 'application/json', responseSchema: schema,
        },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
        ],
      }),
      signal,
    });

    if (!res.ok) {
      const t = await res.text();
      let detail = t, gStatus = '';
      try { const j = JSON.parse(t); detail = j.error?.message || t; gStatus = j.error?.status || ''; } catch (_) {}
      const err = new Error((gStatus ? `[${gStatus}] ` : '') + detail.slice(0, 300));
      err.status = res.status;
      throw err;
    }

    const data = await res.json();

    // ── Block / no candidate ────────────────────────────────────────────────
    if (data.promptFeedback?.blockReason) {
      const err = new Error(`Agent blocked: ${data.promptFeedback.blockReason}`);
      err.status = 502;
      throw err;
    }
    const cand = data.candidates?.[0];
    if (!cand) {
      const err = new Error('No candidate from agent call');
      err.status = 502;
      throw err;
    }

    // ── Truncation guard ───────────────────────────────────────────────────
    if (cand.finishReason === 'MAX_TOKENS') {
      const err = new Error('Agent response truncated (MAX_TOKENS) — JSON akan corrupt. Coba lagi.');
      err.status = 502;
      throw err;
    }
    if (['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'SPII'].includes(cand.finishReason)) {
      const err = new Error(`Agent dihentikan Gemini (${cand.finishReason}) — coba ulang`);
      err.status = 502;
      throw err;
    }

    // ── Filter thinking parts (Gemini 2.5 Pro/Flash thinking model) ────────
    const parts = (cand.content?.parts || []);
    const responseParts = parts.filter(p => !p.thought);
    const raw = responseParts.map(p => p.text || '').filter(Boolean).join('\n').trim()
      || parts.map(p => p.text || '').filter(Boolean).join('\n').trim();

    if (!raw) {
      const err = new Error('Empty agent response (agent returned no text)');
      err.status = 502;
      throw err;
    }

    try {
      return JSON.parse(raw);
    } catch (_) {
      const cleaned = raw.replace(/```json|```/g, '').trim();
      const a = cleaned.indexOf('{'), b = cleaned.lastIndexOf('}');
      if (a === -1 || b === -1 || b <= a) {
        const err = new Error(`Agent returned non-JSON: "${raw.slice(0, 200)}"`);
        err.status = 502;
        throw err;
      }
      return JSON.parse(cleaned.slice(a, b + 1));
    }
  }

  // Retry sekali untuk transient 502/empty (sebelumnya tidak ada retry di sini)
  try {
    return await _call();
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err.status === 400 || err.status === 401 || err.status === 403 || err.status === 429) throw err;
    await new Promise(r => setTimeout(r, 2000));
    return _call();
  }
}

// ── Agent prompts ─────────────────────────────────────────────────────────────
// dataSection di-build SEKALI di runCouncil dan di-pass ke semua prompt.
// Ini menghindari 4× rebuild (~16K token duplikasi) per Council session.

function buildBullPrompt(dataSection, sym) {
  return `Kamu adalah BULL RESEARCHER di sebuah trading desk crypto. Tugasmu: bangun argumen TERKUAT untuk posisi LONG (beli) ${sym} saat ini.

Gunakan HANYA data di bawah. Jangan mengarang. Kalau ada sinyal bullish, tonjolkan. Kalau ada sinyal bearish, akui tapi jelaskan kenapa itu bisa di-counter atau kenapa bullish tetap lebih kuat.

${dataSection}

INSTRUKSI:
- Tulis 3-5 poin argumen LONG terkuat, masing-masing cite data spesifik (angka).
- Fokus: konfirmasi trend (OI, taker), smart money positioning, confluence TF, support levels, on-chain value, macro tailwind.
- Akui 1 risiko terbesar terhadap thesis bullish, lalu jelaskan kenapa masih worth it.
- Tulis natural seperti briefing ke trader, bukan bullet kaku. Maksimal 200 kata.
- Bahasa Indonesia.`;
}

function buildBearPrompt(dataSection, sym) {
  return `Kamu adalah BEAR RESEARCHER di sebuah trading desk crypto. Tugasmu: bangun argumen TERKUAT untuk posisi SHORT (jual) atau MENGHINDARI ${sym} saat ini.

Gunakan HANYA data di bawah. Jangan mengarang. Kalau ada sinyal bearish, tonjolkan. Kalau ada sinyal bullish, akui tapi jelaskan kenapa itu rapuh atau kenapa bearish tetap lebih kuat.

${dataSection}

INSTRUKSI:
- Tulis 3-5 poin argumen SHORT/AVOID terkuat, masing-masing cite data spesifik (angka).
- Fokus: divergence OI vs harga, funding/positioning yang crowded, resistance, RSI overbought, MVRV mahal, macro headwind, max pain di bawah harga.
- Akui 1 kekuatan terbesar dari sisi bullish, lalu jelaskan kenapa kamu tetap bearish.
- Tulis natural seperti briefing ke trader, bukan bullet kaku. Maksimal 200 kata.
- Bahasa Indonesia.`;
}

function buildJudgePrompt(dataSection, bullCase, bearCase, sym) {
  return `Kamu adalah RESEARCH MANAGER (debate judge) yang OBJEKTIF di trading desk ${sym}. Dua peneliti baru saja berdebat. Tugasmu: timbang kedua argumen, tentukan sisi mana yang lebih kuat secara bukti.

DATA MENTAH (untuk verifikasi klaim):
${dataSection}

═══ ARGUMEN BULL ═══
${bullCase}

═══ ARGUMEN BEAR ═══
${bearCase}

TUGAS:
- Evaluasi kualitas bukti tiap sisi (bukan retorika). Sisi mana cite data lebih solid?
- Tentukan lean: BULLISH / BEARISH / NEUTRAL.
- Beri conviction 0-100 (seberapa yakin pada lean ini).
- Sebutkan 2-3 faktor penentu (deciding factors) yang membuatmu condong ke sisi itu.
- Sebutkan apa yang bisa membuktikan lean ini SALAH (invalidation).
- Kalau kedua sisi sama kuat atau sinyal saling bertentangan → NEUTRAL dengan conviction rendah.
- Bahasa Indonesia untuk semua field text.`;
}

function buildCouncilFinalPrompt(dataSection, bullCase, bearCase, judge, sym) {
  return `Kamu adalah PORTFOLIO MANAGER senior — pengambil keputusan FINAL di trading desk ${sym}. Kamu menerima hasil debat tim riset dan keputusan judge. Sekarang buat keputusan trading final dengan disiplin risk management.

DATA MENTAH:
${dataSection}

═══ ARGUMEN BULL ═══
${bullCase}

═══ ARGUMEN BEAR ═══
${bearCase}

═══ KEPUTUSAN JUDGE ═══
Lean: ${judge.lean} (conviction ${judge.conviction}/100)
Faktor penentu: ${(judge.decidingFactors || []).join('; ')}
Invalidation: ${judge.invalidation || '—'}

TUGAS FINAL (terapkan RISK LENS sebagai 3 sudut pandang internal):
1. Sudut AGGRESSIVE: kalau ambil posisi, di mana peluang maksimal?
2. Sudut CONSERVATIVE: apa yang bisa bikin rugi? Worst case?
3. Sudut NEUTRAL: apakah risk/reward seimbang & layak?

Lalu putuskan trade action FINAL dengan aturan:
- Kalau judge conviction < 45 ATAU sinyal mixed → WAIT (jangan paksa).
- LONG hanya kalau lean BULLISH + R:R ≥ 1.5 + derivatives/TF confirm.
- SHORT hanya kalau lean BEARISH + R:R ≥ 1.5 + derivatives/TF confirm.
- Posisi sizing harus konsisten dengan conviction (conviction rendah = size kecil).

ATURAN HARGA KETAT:
- LONG → stopLoss < entryLow < entryHigh < takeProfit1 < takeProfit2
- SHORT → takeProfit2 < takeProfit1 < entryLow < entryHigh < stopLoss
- WAIT → semua harga ≈ harga current

Isi semua field sesuai schema. signalReasoning: 3 poin cite layer berbeda. Bahasa Indonesia untuk semua field text.`;
}

// ── Judge schema ──────────────────────────────────────────────────────────────
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    lean:            { type: 'string', enum: ['BULLISH', 'BEARISH', 'NEUTRAL'] },
    conviction:      { type: 'number' },
    decidingFactors: { type: 'array', items: { type: 'string' } },
    invalidation:    { type: 'string' },
    summary:         { type: 'string' },
  },
  required: ['lean', 'conviction', 'decidingFactors', 'invalidation', 'summary'],
};

/**
 * Orchestrate the full council pipeline.
 * @param onProgress callback(phase) untuk update UI
 */
async function runCouncil(apiKey, modelId, snapshot, signal, onProgress) {
  // Build dataSection SEKALI — di-pass ke semua 4 agent sebagai string.
  // Mengurangi dari ~16K token duplikasi menjadi ~4K (hanya 1 build).
  const dataSection = buildDataSection(snapshot);
  const sym = snapshot.symbol || 'BTC';   // v9: coin aktif untuk semua prompt

  // ── Phase 1: Bull + Bear — selalu paralel (Pro dan Flash) ────────────────
  // Alasan: sequential Pro menambah 40-50s tanpa manfaat nyata.
  onProgress?.('debate');
  const [bullCase, bearCase] = await Promise.all([
    callAgentText(apiKey, modelId, buildBullPrompt(dataSection, sym), signal),
    callAgentText(apiKey, modelId, buildBearPrompt(dataSection, sym), signal),
  ]);

  // ── Phase 2: Judge menimbang ──────────────────────────────────────────────
  onProgress?.('judge');
  const judge = await callAgentStructured(
    apiKey, modelId, buildJudgePrompt(dataSection, bullCase, bearCase, sym), JUDGE_SCHEMA, signal
  );

  // ── Phase 3: Portfolio Manager final decision ────────────────────────────
  onProgress?.('final');
  const finalRes = await callGemini(
    apiKey, modelId, buildCouncilFinalPrompt(dataSection, bullCase, bearCase, judge, sym), signal, false
  );

  const analysis = finalRes.parsed;
  analysis.debate = { bullCase, bearCase, judge };
  analysis._meta = {
    model: modelId,
    elapsedMs: finalRes.elapsed,
    finishReason: finalRes.finishReason,
    usage: finalRes.usage,
    mode: 'council',
  };
  return analysis;
}


// ─────────────────────────────────────────────────────────────────────────────
//  Snapshot fetch (Vercel edge function)
// ─────────────────────────────────────────────────────────────────────────────
async function loadSnapshot() {
  const symbol = state.symbol;   // v9: capture untuk guard race saat ganti coin
  state.loading = true;
  state.error = null;
  render();

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 28000);
    const headers = {};
    if (state.coinalyzeKey) headers['x-coinalyze-key'] = state.coinalyzeKey;
    // v8: FREE KEY tambahan (BYOK via header, Edge fetch server-side)
    const dk = state.dataKeys;
    if (dk.fred)        headers['x-fred-key'] = dk.fred;
    if (dk.cryptopanic) headers['x-cryptopanic-key'] = dk.cryptopanic;
    // ETF (SoSoValue): data harian → kirim key hanya kalau cache stale > 4 jam.
    // v9: cache dipisah per coin (etf_BTC, etf_ETH, ...)
    const cache = readSlowCache();
    const etfKey = `etf_${symbol}`;
    if (dk.soso && cacheStale(cache[etfKey], TTL_ETF_MS)) headers['x-soso-key'] = dk.soso;
    // NUPL (bitcoin-data.com): rate limit 8 req/JAM → fetch 1×/24 jam, BTC only
    if (symbol === 'BTC' && cacheStale(cache.nupl, TTL_NUPL_MS)) {
      headers['x-fetch-nupl'] = '1';
      if (dk.btcdata) headers['x-btcdata-key'] = dk.btcdata;
    }
    const r = await fetch(`/api/snapshot?symbol=${symbol}`, { signal: ctrl.signal, headers });
    clearTimeout(tid);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const snap = await r.json();
    // v8: merge cache ⇄ snapshot — simpan hasil baru, atau pakai cache saat
    // server tidak fetch (TTL belum lewat) supaya sinyal tetap tampil
    if (snap.etfFlows) cache[etfKey] = { ts: Date.now(), data: snap.etfFlows };
    else if (cache[etfKey]?.data) snap.etfFlows = { ...cache[etfKey].data, cached: true };
    if (symbol === 'BTC') {
      if (snap.nupl) cache.nupl = { ts: Date.now(), data: snap.nupl };
      else if (cache.nupl?.data) snap.nupl = { ...cache.nupl.data, cached: true };
    }
    writeSlowCache(cache);
    // v9: simpan per coin; tampilkan hanya bila user masih di coin yang sama
    state.snapshotByCoin[symbol] = snap;
    state.lastFetchByCoin[symbol] = Date.now();
    if (state.symbol === symbol) {
      state.snapshot = snap;
      state.lastFetch = state.lastFetchByCoin[symbol];
    }
  } catch (e) {
    if (state.symbol === symbol) {
      state.error = e.name === 'AbortError' ? 'Timeout 28s saat fetch snapshot — cek koneksi' : e.message;
    }
  } finally {
    state.loading = false;
    render();
  }
}

// v9: ganti coin aktif — snapshot & analisis lama coin itu langsung tampil
// dari cache memori, lalu refresh snapshot di background
function setSymbol(sym) {
  if (!COIN_LIST.includes(sym) || sym === state.symbol) return;
  state.symbol = sym;
  try { localStorage.setItem(STORAGE_SYMBOL, sym); } catch (_) {}
  state.snapshot   = state.snapshotByCoin[sym] || null;
  state.analysis   = state.analysisByCoin[sym] || null;
  state.lastFetch   = state.lastFetchByCoin[sym] || null;
  state.lastAnalyze = state.lastAnalyzeByCoin[sym] || null;
  state.error = null;
  state.analyzeError = null;
  state.analyzeHint = null;
  render();
  loadSnapshot();
}

// ─────────────────────────────────────────────────────────────────────────────
//  AI Analysis (browser → Gemini langsung)
// ─────────────────────────────────────────────────────────────────────────────
let _analysisAbortCtrl = null;

async function loadAnalysis() {
  if (!state.snapshot) return;
  const symbol = state.symbol;   // v9: guard — hasil disimpan ke coin asal

  if (!state.apiKey) {
    state.showSettings = true;
    state.analyzeError = 'API key Gemini belum di-set. Buka Settings di atas.';
    render();
    return;
  }

  state.analyzing = true;
  state.analyzeError = null;
  state.analyzeHint = null;
  state.councilPhase = null;
  render();

  // Council butuh lebih lama (4 calls) → timeout lebih panjang
  // Pro model: Bull+Bear sekarang paralel → estimasi ~100-130s, aman di 240s
  const timeoutMs = state.analysisMode === 'council' ? 240_000 : ANALYZE_TIMEOUT_MS;

  // Setup abort controller untuk timeout
  _analysisAbortCtrl = new AbortController();
  const timeoutId = setTimeout(() => _analysisAbortCtrl.abort(), timeoutMs);

  try {
    let analysis;

    if (state.analysisMode === 'council') {
      // ── Multi-agent council ──────────────────────────────────────────────
      analysis = await runCouncil(
        state.apiKey,
        state.model,
        state.snapshot,
        _analysisAbortCtrl.signal,
        (phase) => { state.councilPhase = phase; render(); },
      );
    } else {
      // ── Quick single-call (v4 behaviour) ─────────────────────────────────
      const prompt = buildPrompt(state.snapshot);
      const result = await callGeminiWithRetry(
        state.apiKey,
        state.model,
        prompt,
        _analysisAbortCtrl.signal,
        state.grounding,
      );
      analysis = result.parsed;
      analysis._meta = {
        model: state.model,
        elapsedMs: result.elapsed,
        finishReason: result.finishReason,
        usage: result.usage,
        grounding: state.grounding,
        groundingMeta: result.groundingMeta,
        mode: 'quick',
      };
    }

    // v9: cache analisis per coin — pindah coin lalu balik, analisis masih ada
    state.analysisByCoin[symbol] = analysis;
    state.lastAnalyzeByCoin[symbol] = Date.now();
    if (state.symbol === symbol) {
      state.analysis = analysis;
      state.lastAnalyze = state.lastAnalyzeByCoin[symbol];
    }
  } catch (err) {
    if (err.name === 'AbortError' || _analysisAbortCtrl?.signal.aborted) {
      state.analyzeError = `Timeout`;
      state.analyzeHint = state.analysisMode === 'council'
        ? 'Council butuh 4 AI call (~60-120s). Coba mode Quick di Settings, atau ulangi.'
        : 'Coba lagi atau ganti model ke Gemini 2.5 Flash (lebih cepat).';
    } else if (err.status === 401 || err.status === 403) {
      state.analyzeError = `Auth gagal (${err.status})`;
      state.analyzeHint = 'API key invalid atau expired. Generate ulang di aistudio.google.com';
    } else if (err.status === 429) {
      const isExhausted = err.message?.includes('RESOURCE_EXHAUSTED') || err.message?.includes('quota');
      state.analyzeError = isExhausted ? 'Kuota free tier habis' : 'Rate limit — terlalu banyak request';
      state.analyzeHint = isExhausted
        ? 'Kuota Gemini 2.5 Pro free tier sudah habis hari ini. Solusi: (1) Ganti ke Gemini 2.5 Flash di Settings — limit 1500 req/hari, (2) Buat API key baru di aistudio.google.com, atau (3) Aktifkan billing.'
        : 'Tunggu 1 menit lalu coba lagi.';
    } else if (err.status === 400) {
      state.analyzeError = 'Bad request: ' + (err.message || '').slice(0, 200);
      state.analyzeHint = 'Mungkin model tidak support fitur ini — coba switch model di Settings.';
    } else if (err.message?.includes('MAX_TOKENS') || err.message?.includes('truncat') || err.message?.includes('JSON parse')) {
      state.analyzeError = 'Response terpotong (JSON tidak lengkap)';
      state.analyzeHint = 'Sudah diperbaiki di versi ini (maxOutputTokens dinaikkan). Coba retry — kalau masih terjadi, ganti ke model Gemini 2.5 Pro.';
    } else {
      state.analyzeError = err.message || 'Unknown error';
      state.analyzeHint = err.status ? `HTTP ${err.status}` : 'Cek koneksi & coba lagi.';
    }
  } finally {
    clearTimeout(timeoutId);
    _analysisAbortCtrl = null;
    state.analyzing = false;
    state.councilPhase = null;
    render();
  }
}

function cancelAnalysis() {
  if (_analysisAbortCtrl) {
    _analysisAbortCtrl.abort();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Test API Key (langsung ke Gemini, no proxy)
// ─────────────────────────────────────────────────────────────────────────────
async function testApiKey() {
  const input = document.getElementById('api-key-input');
  const key = input ? input.value.trim() : state.apiKey;
  if (!key) {
    alert('Masukkan API key dulu');
    return;
  }

  state.testing = true;
  state.testResult = null;
  render();

  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS);

    const r = await fetch(`${GEMINI_BASE}/${state.model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Reply with just: OK' }] }],
        generationConfig: { maxOutputTokens: 100, temperature: 0.1 },
      }),
      signal: ctrl.signal,
    });
    clearTimeout(tid);

    const elapsed = Date.now() - t0;
    const bodyText = await r.text();
    let body;
    try { body = JSON.parse(bodyText); } catch (_) {}

    if (!r.ok) {
      const detail = body?.error?.message || bodyText.slice(0, 300);
      const gStatus = body?.error?.status || '';
      state.testResult = {
        ok: false,
        status: r.status,
        detail: (gStatus ? `[${gStatus}] ` : '') + detail,
        elapsedMs: elapsed,
      };
    } else {
      const cand = body?.candidates?.[0];
      const reply = cand?.content?.parts?.[0]?.text || '';
      state.testResult = {
        ok: true,
        status: 200,
        reply: reply.slice(0, 100),
        model: state.model,
        finishReason: cand?.finishReason,
        usage: body?.usageMetadata,
        elapsedMs: elapsed,
      };
    }
  } catch (e) {
    state.testResult = {
      ok: false,
      error: e.name === 'AbortError'
        ? `Test timeout ${TEST_TIMEOUT_MS / 1000}s — cek koneksi internet`
        : 'Network error: ' + e.message,
      elapsedMs: Date.now() - t0,
    };
  } finally {
    state.testing = false;
    render();
    setTimeout(() => { const i = document.getElementById('api-key-input'); if (i) i.focus(); }, 0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Settings actions
// ─────────────────────────────────────────────────────────────────────────────
function toggleSettings() {
  state.showSettings = !state.showSettings;
  state.testResult = null;
  if (!state.showSettings) {
    state.keyDraft = null;     // ← clear draft saat panel ditutup tanpa save
  }
  render();
}

function openSettingsDataKeys() {
  state.showSettings = true;
  state.testResult = null;
  render();
  setTimeout(() => {
    const el = document.getElementById('data-source-keys-section');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 80);
}

function saveApiKey() {
  const input = document.getElementById('api-key-input');
  if (!input) return;
  const key = input.value.trim();
  if (!key) { alert('API key kosong'); return; }
  if (!key.startsWith('AIza')) {
    if (!confirm('Key biasanya diawali "AIza". Lanjut save?')) return;
  }
  state.apiKey = key;
  try { localStorage.setItem(STORAGE_KEY, key); } catch (_) {}
  state.keyDraft = null;       // ← clear draft (sudah saved ke state.apiKey)
  state.showSettings = false;
  state.analyzeError = null;
  state.analyzeHint = null;
  render();
}

function clearApiKey() {
  if (!confirm('Hapus API key dari browser?')) return;
  state.apiKey = '';
  state.keyDraft = null;       // ← clear draft juga
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  state.testResult = null;
  render();
}

function toggleShowKey() {
  state.showKeyValue = !state.showKeyValue;
  render();
  setTimeout(() => { const i = document.getElementById('api-key-input'); if (i) i.focus(); }, 0);
}

function selectModel(id) {
  state.model = id;
  try { localStorage.setItem(STORAGE_MODEL, id); } catch (_) {}
  state.testResult = null;
  render();
}

function toggleGrounding() {
  state.grounding = !state.grounding;
  try { localStorage.setItem(STORAGE_GROUNDING, state.grounding ? 'true' : 'false'); } catch (_) {}
  render();
}

function setMode(mode) {
  state.analysisMode = mode;
  try { localStorage.setItem(STORAGE_MODE, mode); } catch (_) {}
  render();
}

function saveCoinalyzeKey(val) {
  state.coinalyzeKey = (val || '').trim();
  try {
    if (state.coinalyzeKey) localStorage.setItem(STORAGE_CGKEY, state.coinalyzeKey);
    else localStorage.removeItem(STORAGE_CGKEY);
  } catch (_) {}
  // Re-fetch snapshot supaya Coinalyze langsung kepakai
  render();
  loadSnapshot();
}

function clearCoinalyzeKey() {
  state.coinalyzeKey = '';
  try { localStorage.removeItem(STORAGE_CGKEY); } catch (_) {}
  render();
  loadSnapshot();
}

// v8: simpan/hapus FREE KEY data source (soso | fred | cryptopanic | btcdata)
function saveDataKey(name, val) {
  if (!(name in state.dataKeys)) return;
  state.dataKeys[name] = (val || '').trim();
  try { localStorage.setItem(STORAGE_DATAKEYS, JSON.stringify(state.dataKeys)); } catch (_) {}
  // Reset cache slow source terkait supaya key baru langsung dipakai
  if (name === 'soso' || name === 'btcdata') {
    const cache = readSlowCache();
    if (name === 'soso') delete cache.etf;
    if (name === 'btcdata') delete cache.nupl;
    writeSlowCache(cache);
  }
  render();
  loadSnapshot();
}

function clearDataKey(name) {
  saveDataKey(name, '');
}

// ─────────────────────────────────────────────────────────────────────────────
//  (View functions di bawah — di file terpisah `view.js`)
// ─────────────────────────────────────────────────────────────────────────────

// =============================================================================
//  VIEWS — semua functions yang return HTML strings
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
//  SVG helpers
// ─────────────────────────────────────────────────────────────────────────────
function sparkSVG(values, color = '#3b82f6', w = 600, h = 80) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="w-full h-full">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" />
  </svg>`;
}

function gaugeSVG(value) {
  if (value == null) return '';
  const angle = (value / 100) * 180 - 90;
  const color = value < 25 ? '#ef4444'
              : value < 45 ? '#f59e0b'
              : value < 55 ? '#eab308'
              : value < 75 ? '#84cc16'
              : '#22c55e';
  const dashLen = (value / 100) * 251;
  const x2 = 100 + 65 * Math.cos((angle - 90) * Math.PI / 180);
  const y2 = 100 + 65 * Math.sin((angle - 90) * Math.PI / 180);
  return `<svg viewBox="0 0 200 110" class="w-full h-full">
    <path d="M 20 100 A 80 80 0 0 1 180 100" stroke="#27272a" stroke-width="8" fill="none" />
    <path d="M 20 100 A 80 80 0 0 1 180 100" stroke="${color}" stroke-width="8" fill="none" stroke-dasharray="${dashLen} 251" stroke-linecap="round" />
    <line x1="100" y1="100" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#fafafa" stroke-width="2" />
    <circle cx="100" cy="100" r="4" fill="#fafafa" />
  </svg>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Settings panel
// ─────────────────────────────────────────────────────────────────────────────
function viewSettings() {
  if (!state.showSettings) return '';

  const inputType = state.showKeyValue ? 'text' : 'password';

  const modelButtons = GEMINI_MODELS.map(m => {
    const active = state.model === m.id;
    const isPro = m.id === 'gemini-2.5-pro';
    return `<button onclick="window._app.selectModel('${m.id}')"
      class="text-left border ${active
        ? (isPro ? 'border-purple-500 bg-purple-500/10' : 'border-blue-500 bg-blue-500/10')
        : 'border-zinc-800 bg-zinc-950 hover:border-zinc-600'} px-3 py-3 transition-colors relative">
      <div class="flex items-center justify-between gap-2 mb-1">
        <span class="text-xs font-medium ${active ? (isPro ? 'text-purple-200' : 'text-blue-200') : 'text-zinc-300'}">${esc(m.label)}</span>
        <span class="text-[9px] ${m.badgeColor || 'text-zinc-500'} font-medium">${esc(m.badge || '')}</span>
      </div>
      <div class="text-[10px] text-zinc-500 sans mb-1.5">${esc(m.cost)} · ${esc(m.latency)}</div>
      <div class="text-[10px] text-zinc-600 sans leading-relaxed">${esc(m.desc || '')}</div>
      ${active ? `<div class="mt-1.5 text-[9px] ${isPro ? 'text-purple-400' : 'text-blue-400'} uppercase tracking-wider">● active</div>` : ''}
    </button>`;
  }).join('');

  const testBlock = (() => {
    if (!state.testResult) return '';
    const tr = state.testResult;
    if (tr.ok) {
      return `<div class="mt-2 border border-emerald-500/30 bg-emerald-500/5 p-3 text-[11px] sans">
        <div class="text-emerald-400 font-medium mb-1">✓ Connection OK · ${tr.elapsedMs}ms</div>
        <div class="text-zinc-400">Model: <code class="text-zinc-300">${esc(tr.model || '—')}</code></div>
        ${tr.reply ? `<div class="text-zinc-400 mt-1">Reply: <code class="text-zinc-300">${esc(tr.reply)}</code></div>` : ''}
        ${tr.usage ? `<div class="text-[10px] text-zinc-500 mt-1">Tokens: ${esc(JSON.stringify(tr.usage))}</div>` : ''}
      </div>`;
    }
    return `<div class="mt-2 border border-red-500/30 bg-red-500/5 p-3 text-[11px] sans">
      <div class="text-red-400 font-medium mb-1">✗ Test failed · status ${esc(tr.status || '—')}</div>
      ${tr.detail ? `<div class="text-zinc-400 break-words">${esc(tr.detail)}</div>` : ''}
      ${tr.error ? `<div class="text-zinc-400 break-words">${esc(tr.error)}</div>` : ''}
    </div>`;
  })();

  return `<div class="border-2 border-blue-500/40 bg-zinc-950 p-6 mb-3 slide-down">
    <div class="flex items-start justify-between mb-4">
      <div>
        <div class="flex items-center gap-2 mb-1">
          <span class="text-blue-400 text-lg">⚙</span>
          <span class="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Settings · Gemini API</span>
        </div>
        <h2 class="serif text-2xl text-zinc-100">Configure <span class="italic text-blue-400">Google Gemini</span></h2>
      </div>
      <button onclick="window._app.toggleSettings()" class="text-zinc-500 hover:text-zinc-300 text-xl leading-none" title="Close">✕</button>
    </div>

    <!-- v5: Analysis Mode selector -->
    <div class="mb-5">
      <label class="block text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-2">Analysis Mode</label>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
        <button onclick="window._app.setMode('council')"
          class="text-left border ${state.analysisMode === 'council'
            ? 'border-purple-500 bg-purple-500/10'
            : 'border-zinc-800 bg-zinc-950 hover:border-zinc-600'} px-3 py-3 transition-colors">
          <div class="flex items-center justify-between gap-2 mb-1">
            <span class="text-xs font-medium ${state.analysisMode === 'council' ? 'text-purple-300' : 'text-zinc-300'}">⚖ Agent Council</span>
            ${state.analysisMode === 'council' ? '<span class="text-[9px] text-purple-400">● ACTIVE</span>' : ''}
          </div>
          <div class="text-[10px] text-zinc-500 sans leading-relaxed">Bull vs Bear berdebat → Judge timbang → Portfolio Manager putuskan. 4 AI call, ~30-50s. Lebih robust & transparan.</div>
        </button>
        <button onclick="window._app.setMode('quick')"
          class="text-left border ${state.analysisMode === 'quick'
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-zinc-800 bg-zinc-950 hover:border-zinc-600'} px-3 py-3 transition-colors">
          <div class="flex items-center justify-between gap-2 mb-1">
            <span class="text-xs font-medium ${state.analysisMode === 'quick' ? 'text-blue-300' : 'text-zinc-300'}">⚡ Quick Analysis</span>
            ${state.analysisMode === 'quick' ? '<span class="text-[9px] text-blue-400">● ACTIVE</span>' : ''}
          </div>
          <div class="text-[10px] text-zinc-500 sans leading-relaxed">Single AI call. ~12-18s. Lebih cepat & hemat kuota, cocok untuk cek cepat.</div>
        </button>
      </div>
    </div>

    <!-- Model selection -->
    <div class="mb-5">
      <label class="block text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-2">Choose Model</label>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-2">${modelButtons}</div>
      <div class="mt-2 text-[10px] text-zinc-600 sans">
        Council mode butuh ~30-50s dengan Flash · ~60-90s dengan Pro · Pro lebih dalam analisisnya
      </div>
    </div>

    <!-- v4: Google Search Grounding toggle -->
    <div class="mb-5">
      <label class="block text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-2">Real-time Web Grounding</label>
      <button onclick="window._app.toggleGrounding()" class="w-full text-left border ${state.grounding
        ? 'border-emerald-500/50 bg-emerald-500/5'
        : 'border-zinc-800 bg-zinc-950 hover:border-zinc-600'} p-3 transition-colors flex items-start justify-between gap-3">
        <div class="flex-1">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-xs font-medium ${state.grounding ? 'text-emerald-300' : 'text-zinc-300'}">Google Search Grounding</span>
            ${state.grounding ? '<span class="text-[9px] text-emerald-400">● ENABLED</span>' : '<span class="text-[9px] text-zinc-600">○ disabled</span>'}
          </div>
          <div class="text-[11px] text-zinc-500 sans leading-relaxed">
            Saat aktif, Gemini akan search web real-time untuk berita & event terbaru saat analisis. Sedikit lebih lambat (+3-8s), tapi catch event yang baru saja terjadi. Pakai key Gemini yang sama.
          </div>
        </div>
        <div class="w-10 h-6 rounded-full ${state.grounding ? 'bg-emerald-500/40' : 'bg-zinc-800'} relative transition-colors flex-shrink-0">
          <div class="absolute top-0.5 ${state.grounding ? 'right-0.5' : 'left-0.5'} w-5 h-5 rounded-full ${state.grounding ? 'bg-emerald-400' : 'bg-zinc-500'} transition-all"></div>
        </div>
      </button>
    </div>

    <!-- API Key input -->
    <div class="grid grid-cols-12 gap-4">
      <div class="col-span-12 md:col-span-8">
        <label class="block text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-2">
          API Key
          ${state.apiKey
            ? `<span class="text-emerald-400 ml-2">● configured</span>`
            : `<span class="text-amber-400 ml-2">○ not set</span>`}
        </label>
        <div class="flex gap-2">
          <div class="flex-1 relative">
            <input
              id="api-key-input"
              type="${inputType}"
              value="${esc(state.keyDraft != null ? state.keyDraft : state.apiKey)}"
              placeholder="AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
              class="w-full bg-black border border-zinc-700 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition-colors"
              autocomplete="off"
              spellcheck="false"
            />
            <button onclick="window._app.toggleShowKey()" class="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-blue-400 px-2">
              ${state.showKeyValue ? 'Hide' : 'Show'}
            </button>
          </div>
          <button onclick="window._app.testApiKey()" ${state.testing ? 'disabled' : ''}
            class="border border-zinc-700 hover:border-zinc-500 px-4 py-2.5 text-[10px] uppercase tracking-[0.15em] text-zinc-300 transition-colors disabled:opacity-50">
            ${state.testing ? 'Testing...' : 'Test'}
          </button>
          <button onclick="window._app.saveApiKey()"
            class="bg-blue-500 hover:bg-blue-400 text-black px-5 py-2.5 text-[10px] uppercase tracking-[0.15em] font-medium transition-colors">
            Save
          </button>
        </div>
        ${testBlock}
        ${state.apiKey ? `<div class="mt-2 flex items-center gap-2 text-[11px]">
          <span class="text-zinc-500 sans">Saved: <code class="text-zinc-400">${esc(fmt.maskKey(state.apiKey))}</code></span>
          <span class="text-zinc-600">·</span>
          <button onclick="window._app.clearApiKey()" class="text-red-400/80 hover:text-red-400 uppercase tracking-wider">Clear</button>
        </div>` : `<div class="mt-2 text-[11px] text-zinc-500 sans">Belum ada key tersimpan</div>`}
      </div>

      <div class="col-span-12 md:col-span-4 text-xs text-zinc-400 sans space-y-2 border-l border-zinc-800 pl-4">
        <p class="text-zinc-300"><strong>Cara dapat key:</strong></p>
        <ol class="list-decimal list-inside space-y-1 text-zinc-500">
          <li>Buka <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener" class="text-blue-400 hover:underline">aistudio.google.com</a></li>
          <li>Login dengan Google → Free tier aktif default</li>
          <li>Create API Key → copy → paste di sini</li>
        </ol>
        <div class="text-[10px] text-zinc-600 pt-2 border-t border-zinc-800/60 space-y-1">
          <p>🔒 Key disimpan di browser kamu (localStorage), tidak pernah ke server kami.</p>
          <p>⚡ Browser panggil Gemini API langsung — no proxy, no timeout Vercel.</p>
          <p>💸 Free tier: 1500 request/hari untuk Flash, cukup buat puluhan analisis.</p>
        </div>
      </div>
    </div>

    <!-- v6: Coinalyze API key (OPSIONAL, GRATIS, terpisah dari Gemini) -->
    <div class="mt-6 pt-5 border-t border-zinc-800">
      <label class="block text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-2">
        Coinalyze API Key <span class="text-zinc-600 normal-case tracking-normal">(opsional, GRATIS — liquidation & OI agregat lintas bursa)</span>
        ${state.coinalyzeKey
          ? `<span class="text-emerald-400 ml-2">● configured</span>`
          : `<span class="text-zinc-600 ml-2">○ tidak diisi (data liquidation real off)</span>`}
      </label>
      <div class="grid grid-cols-12 gap-4">
        <div class="col-span-12 md:col-span-8">
          <div class="flex gap-2">
            <input
              id="coinalyze-key-input"
              type="password"
              value="${esc(state.coinalyzeKey)}"
              placeholder="Coinalyze API key (dari coinalyze.net)"
              class="flex-1 bg-black border border-zinc-700 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500 transition-colors"
              autocomplete="off" spellcheck="false"
            />
            <button onclick="window._app.saveCoinalyzeKey(document.getElementById('coinalyze-key-input').value)"
              class="bg-amber-500 hover:bg-amber-400 text-black px-5 py-2.5 text-[10px] uppercase tracking-[0.15em] font-medium transition-colors">
              Save
            </button>
            ${state.coinalyzeKey ? `<button onclick="window._app.clearCoinalyzeKey()"
              class="border border-zinc-700 hover:border-red-500/50 px-4 py-2.5 text-[10px] uppercase tracking-[0.15em] text-red-400/80 transition-colors">
              Clear
            </button>` : ''}
          </div>
        </div>
        <div class="col-span-12 md:col-span-4 text-[11px] text-zinc-500 sans space-y-1 border-l border-zinc-800 pl-4">
          <p class="text-zinc-400">Ini <strong>BUKAN</strong> Google/Gemini key. Alternatif GRATIS untuk CoinGlass.</p>
          <ol class="list-decimal list-inside space-y-0.5 text-zinc-600">
            <li>Daftar gratis di <a href="https://coinalyze.net" target="_blank" rel="noopener" class="text-amber-400 hover:underline">coinalyze.net</a></li>
            <li>Account settings → generate API key (free, 40 call/menit)</li>
            <li>Paste di sini → Save</li>
          </ol>
          <p class="text-[10px] text-zinc-600 pt-1">Tanpa key, estimasi level magnet likuidasi tetap muncul (dihitung lokal). Dengan key, dapat angka likuidasi nyata lintas bursa.</p>
        </div>
      </div>
    </div>

    <!-- v8: FREE KEY data sources tambahan (semua opsional & gratis) -->
    <div id="data-source-keys-section" class="mt-6 pt-5 border-t border-zinc-800">
      <label class="block text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-1">
        Data Source Keys <span class="text-zinc-600 normal-case tracking-normal">(v8 — semua GRATIS &amp; opsional, daftar sendiri, key disimpan di browser)</span>
      </label>
      <p class="text-[11px] text-zinc-600 sans mb-3">Tanpa key ini dashboard tetap jalan penuh — key hanya menambah sinyal: ETF flow institusi (SoSoValue), VIX/yield makro (FRED), berita dengan voting bullish/bearish (CryptoPanic), NUPL on-chain (bitcoin-data.com).</p>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        ${[
          { name: 'soso',        label: 'SoSoValue (ETF flows)',        url: 'https://sosovalue.com/api-docs',        urlLabel: 'Daftar di sosovalue.com',        hint: 'Net inflow/outflow harian ETF spot BTC — sinyal institusi terkuat', steps: 'Buka link → Sign up gratis → My Account → API Key → Copy' },
          { name: 'fred',        label: 'FRED (makro resmi)',           url: 'https://fred.stlouisfed.org/docs/api/api_key.html', urlLabel: 'Daftar di fred.stlouisfed.org', hint: 'VIX, 10Y yield, DXY broad — dari The Fed, gratis permanen', steps: 'Buka link → Request API Key → Isi email → Cek inbox → Copy key' },
          { name: 'cryptopanic', label: 'CryptoPanic (news + votes)',   url: 'https://cryptopanic.com/developers/api/', urlLabel: 'Daftar di cryptopanic.com',       hint: 'Berita crypto + voting bullish/bearish per artikel', steps: 'Buka link → Sign up → Dashboard → Auth Token → Copy' },
          { name: 'btcdata',     label: 'bitcoin-data.com (NUPL)',      url: 'https://bitcoin-data.com',              urlLabel: 'Buka bitcoin-data.com',              hint: 'NUPL cycle-stage indicator. Rate limit ketat → di-cache 24 jam otomatis', steps: 'Saat ini endpoint publik (tanpa key) — kolom ini opsional untuk akses prioritas jika tersedia' },
        ].map(k => `<div class="border border-zinc-800 bg-zinc-950/60 p-3">
          <div class="flex items-center justify-between gap-2 mb-1">
            <span class="text-[11px] text-zinc-300 font-medium">${esc(k.label)}</span>
            ${state.dataKeys[k.name]
              ? '<span class="text-[9px] text-emerald-400">● configured</span>'
              : '<span class="text-[9px] text-zinc-600">○ off</span>'}
          </div>
          <div class="text-[10px] text-zinc-600 sans mb-1">${esc(k.hint)}</div>
          <div class="text-[10px] text-blue-400/60 sans mb-2">→ ${esc(k.steps)}</div>
          <a href="${k.url}" target="_blank" rel="noopener" class="inline-block text-[9px] text-blue-400/80 hover:text-blue-300 border border-blue-500/30 hover:border-blue-400/50 px-2 py-0.5 mb-2 transition-colors">${esc(k.urlLabel)} ↗</a>
          <div class="flex gap-2">
            <input id="datakey-${k.name}" type="password" value="${esc(state.dataKeys[k.name])}"
              placeholder="Paste API key di sini"
              class="flex-1 min-w-0 bg-black border border-zinc-700 px-2 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500"
              autocomplete="off" spellcheck="false" />
            <button onclick="window._app.saveDataKey('${k.name}', document.getElementById('datakey-${k.name}').value)"
              class="bg-zinc-700 hover:bg-zinc-600 text-zinc-100 px-3 py-1.5 text-[9px] uppercase tracking-[0.15em] font-medium transition-colors">Save</button>
            ${state.dataKeys[k.name] ? `<button onclick="window._app.clearDataKey('${k.name}')"
              class="border border-zinc-700 hover:border-red-500/50 px-2 py-1.5 text-[9px] uppercase tracking-wider text-red-400/80 transition-colors">✕</button>` : ''}
          </div>
        </div>`).join('')}
      </div>
    </div>
  </div>`;
}

function viewApiKeyBadge() {
  const hasKey = !!state.apiKey;
  const cfg = hasKey
    ? { border: 'border-emerald-500/30 bg-emerald-500/5 hover:border-emerald-500/60', dot: 'bg-emerald-500', text: 'text-emerald-400', label: 'Gemini ✓' }
    : { border: 'border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/20', dot: 'bg-blue-400 pulse-dot', text: 'text-blue-300', label: 'Setup Key' };
  return `<button onclick="window._app.toggleSettings()" class="flex items-center gap-1.5 px-2.5 py-1 border ${cfg.border} transition-colors">
    <span class="w-1.5 h-1.5 rounded-full ${cfg.dot}"></span>
    <span class="text-[10px] uppercase tracking-[0.15em] ${cfg.text}">${cfg.label}</span>
  </button>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Trade Action Hero — kartu utama berisi LONG/SHORT/WAIT decision
// ─────────────────────────────────────────────────────────────────────────────
function viewTradeActionHero(analysis, currentPrice) {
  if (!analysis || !analysis.tradeAction) return '';
  const a = analysis.tradeAction;

  // Style per direction
  const cfg = {
    LONG:  { label: 'LONG',  sub: 'Buy & hold',   icon: '↗', border: 'border-emerald-500/50', bg: 'bg-emerald-500/[0.07]', text: 'text-emerald-400', glow: 'shadow-[0_0_60px_-15px_rgba(16,185,129,0.4)]' },
    SHORT: { label: 'SHORT', sub: 'Sell / short', icon: '↘', border: 'border-red-500/50',     bg: 'bg-red-500/[0.07]',     text: 'text-red-400',     glow: 'shadow-[0_0_60px_-15px_rgba(239,68,68,0.4)]'  },
    WAIT:  { label: 'WAIT',  sub: 'Stand aside',  icon: '⏸', border: 'border-amber-500/50',   bg: 'bg-amber-500/[0.07]',   text: 'text-amber-400',   glow: 'shadow-[0_0_60px_-15px_rgba(245,158,11,0.3)]' },
  };
  const c = cfg[a.direction] || cfg.WAIT;
  const isWait = a.direction === 'WAIT';
  const confColors = {
    LOW:    'text-zinc-400 border-zinc-700',
    MEDIUM: 'text-amber-400 border-amber-500/40',
    HIGH:   'text-emerald-400 border-emerald-500/40',
  };

  const meta = analysis._meta || {};

  // Compute risk/reward percentages dari entry midpoint
  const entryMid = (a.entryLow + a.entryHigh) / 2;
  const riskPct  = entryMid && a.stopLoss   ? Math.abs((a.stopLoss   - entryMid) / entryMid) * 100 : null;
  const rew1     = entryMid && a.takeProfit1 ? Math.abs((a.takeProfit1 - entryMid) / entryMid) * 100 : null;
  const rew2     = entryMid && a.takeProfit2 ? Math.abs((a.takeProfit2 - entryMid) / entryMid) * 100 : null;

  // Price ladder
  const kindStyles = {
    tp:    { dot: 'bg-emerald-500', text: 'text-emerald-400', accent: 'border-l-emerald-500' },
    now:   { dot: 'bg-blue-400',    text: 'text-blue-300',    accent: 'border-l-blue-400'    },
    entry: { dot: 'bg-purple-400',  text: 'text-purple-300',  accent: 'border-l-purple-400'  },
    sl:    { dot: 'bg-red-500',     text: 'text-red-400',     accent: 'border-l-red-500'     },
  };

  let levels = [];
  if (!isWait) {
    if (a.direction === 'LONG') {
      levels = [
        { p: a.takeProfit2, l: 'TP2',     k: 'tp',    s: 'Target 2'  },
        { p: a.takeProfit1, l: 'TP1',     k: 'tp',    s: 'Target 1'  },
        { p: currentPrice,  l: 'NOW',     k: 'now',   s: 'Spot'      },
        { p: a.entryHigh,   l: 'ENTRY ↑', k: 'entry', s: 'Entry top' },
        { p: a.entryLow,    l: 'ENTRY ↓', k: 'entry', s: 'Entry bot' },
        { p: a.stopLoss,    l: 'SL',      k: 'sl',    s: 'Stop loss' },
      ];
    } else {
      levels = [
        { p: a.stopLoss,    l: 'SL',      k: 'sl',    s: 'Stop loss' },
        { p: a.entryHigh,   l: 'ENTRY ↑', k: 'entry', s: 'Entry top' },
        { p: a.entryLow,    l: 'ENTRY ↓', k: 'entry', s: 'Entry bot' },
        { p: currentPrice,  l: 'NOW',     k: 'now',   s: 'Spot'      },
        { p: a.takeProfit1, l: 'TP1',     k: 'tp',    s: 'Target 1'  },
        { p: a.takeProfit2, l: 'TP2',     k: 'tp',    s: 'Target 2'  },
      ];
    }
  }

  const ladderHTML = levels.map(lv => {
    const s = kindStyles[lv.k];
    const showPct = lv.k !== 'now' && lv.k !== 'entry';
    const pct = showPct ? pctFrom(currentPrice, lv.p) : null;
    return `<div class="flex items-center gap-3 px-3 py-2 border-l-2 ${s.accent} bg-zinc-950/60">
      <div class="w-1.5 h-1.5 rounded-full ${s.dot}"></div>
      <div class="text-[10px] uppercase tracking-wider w-16 ${s.text}">${esc(lv.l)}</div>
      <div class="text-base text-zinc-100 tabular-nums flex-1">${esc(fmt.usd(lv.p))}</div>
      ${pct != null ? `<div class="text-xs tabular-nums ${pct >= 0 ? 'text-emerald-400' : 'text-red-400'}">${esc(fmt.pct(pct))}</div>` : ''}
      <div class="text-[10px] text-zinc-500 sans w-20 text-right">${esc(lv.s)}</div>
    </div>`;
  }).join('');

  return `<div class="border-2 ${c.border} ${c.bg} p-6 mb-3 ${c.glow}">
    <div class="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-5 pb-5 border-b border-zinc-800/60">
      <div class="flex items-center gap-4">
        <div class="text-5xl ${c.text}">${c.icon}</div>
        <div>
          <div class="flex items-center gap-2 mb-1 flex-wrap">
            <span class="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Trade Action</span>
            <span class="text-[10px] text-zinc-600">·</span>
            <span class="text-[10px] uppercase tracking-[0.15em] text-zinc-500">${esc(a.horizon || '1–3 hari')}</span>
            ${meta.model ? `<span class="text-[10px] text-zinc-600">·</span>
              <span class="text-[10px] uppercase tracking-[0.15em] text-blue-400">🅖 ${esc(meta.model)}</span>` : ''}
            ${meta.elapsedMs ? `<span class="text-[10px] text-zinc-600">·</span>
              <span class="text-[10px] text-zinc-500">${(meta.elapsedMs/1000).toFixed(1)}s</span>` : ''}
          </div>
          <div class="text-5xl tracking-tight leading-none ${c.text}">${c.label}</div>
          <div class="text-xs text-zinc-500 mt-2 sans">${esc(c.sub)}</div>
        </div>
      </div>
      <div class="flex flex-wrap gap-2 md:gap-3 items-start">
        ${viewCycleStageBadge(analysis)}
        <div class="border px-3 py-2 ${confColors[a.confidence] || confColors.LOW}">
          <div class="text-[9px] uppercase tracking-[0.15em] text-zinc-500 mb-0.5">Confidence</div>
          <div class="text-sm">${esc(a.confidence || 'LOW')}</div>
        </div>
        ${!isWait ? `<div class="border border-zinc-700 px-3 py-2">
          <div class="text-[9px] uppercase tracking-[0.15em] text-zinc-500 mb-0.5">Risk : Reward</div>
          <div class="text-sm text-zinc-100">1 : ${a.riskRewardRatio ? esc(a.riskRewardRatio.toFixed(1)) : '—'}</div>
        </div>` : ''}
        <div class="border border-zinc-700 px-3 py-2">
          <div class="text-[9px] uppercase tracking-[0.15em] text-zinc-500 mb-0.5">Position</div>
          <div class="text-sm text-zinc-100">${esc(a.positionSize || '—')}</div>
        </div>
      </div>
    </div>

    ${isWait ? `
      <div class="text-center py-8">
        <p class="text-sm text-zinc-300 leading-relaxed sans max-w-2xl mx-auto italic">${renderMd(a.actionReasoning || '')}</p>
        ${a.invalidationReason ? `<div class="mt-6 text-xs text-zinc-500 sans">
          <span class="text-amber-400 uppercase tracking-wider text-[10px] mr-2">Watch for</span>${renderMd(a.invalidationReason || '')}
        </div>` : ''}
      </div>
    ` : `
      <div class="grid grid-cols-12 gap-6">
        <div class="col-span-12 md:col-span-6">
          <div class="text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-3">Price Ladder</div>
          <div class="space-y-1">${ladderHTML}</div>
        </div>
        <div class="col-span-12 md:col-span-6 flex flex-col gap-4">
          <div>
            <div class="text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-3">Reasoning</div>
            <p class="text-sm text-zinc-200 leading-relaxed sans">${renderMd(a.actionReasoning || '')}</p>
          </div>
          <div class="grid grid-cols-3 gap-2 mt-2">
            <div class="border border-red-500/30 bg-red-500/5 p-3">
              <div class="text-[10px] uppercase tracking-wider text-red-400/80 mb-1">Risk</div>
              <div class="text-base text-red-400 tabular-nums">${riskPct ? '-' + riskPct.toFixed(2) + '%' : '—'}</div>
              <div class="text-[10px] text-zinc-500 mt-0.5">to SL</div>
            </div>
            <div class="border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div class="text-[10px] uppercase tracking-wider text-emerald-400/80 mb-1">TP1</div>
              <div class="text-base text-emerald-400 tabular-nums">${rew1 ? '+' + rew1.toFixed(2) + '%' : '—'}</div>
              <div class="text-[10px] text-zinc-500 mt-0.5">to target 1</div>
            </div>
            <div class="border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div class="text-[10px] uppercase tracking-wider text-emerald-400/80 mb-1">TP2</div>
              <div class="text-base text-emerald-400 tabular-nums">${rew2 ? '+' + rew2.toFixed(2) + '%' : '—'}</div>
              <div class="text-[10px] text-zinc-500 mt-0.5">to target 2</div>
            </div>
          </div>
          ${a.invalidationReason ? `<div class="mt-1 pt-3 border-t border-zinc-800/60 text-xs text-zinc-400 sans leading-relaxed">
            <span class="text-amber-400 uppercase tracking-wider text-[10px] mr-2">Invalidation</span>${renderMd(a.invalidationReason || '')}
          </div>` : ''}
        </div>
      </div>
    `}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Generic cards
// ─────────────────────────────────────────────────────────────────────────────
function viewPlaceholder(label) {
  return `<div class="border border-zinc-800 bg-zinc-950 p-5">
    <div class="text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-3">${esc(label)}</div>
    <div class="text-zinc-700 text-sm">No data</div>
  </div>`;
}

function viewMetric(label, value, sub, color = 'text-zinc-100') {
  return `<div class="border border-zinc-800 bg-zinc-950 p-4 hover:border-zinc-700 transition-colors">
    <div class="text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-2">${esc(label)}</div>
    <div class="text-xl tabular-nums ${color}">${esc(value)}</div>
    ${sub ? `<div class="text-[11px] text-zinc-500 mt-1">${esc(sub)}</div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Price card (BTC spot + sparkline + 24h range)
// ─────────────────────────────────────────────────────────────────────────────
function viewPriceCard(snap) {
  if (!snap?.ticker) return viewPlaceholder(`${snap?.symbol || state.symbol} / USD · Spot`);
  const t  = snap.ticker;
  const cg = snap.coingecko || {};
  const g  = snap.global || {};
  const support    = snap.orderBook?.bids?.[0]?.price;
  const resistance = snap.orderBook?.asks?.[0]?.price;
  const pos = (support && resistance && t.price && resistance > support)
    ? Math.max(0, Math.min(100, ((t.price - support) / (resistance - support)) * 100))
    : 50;

  return `<div class="col-span-12 md:col-span-7 border border-zinc-800 bg-zinc-950 p-6">
    <div class="flex items-center justify-between mb-2">
      <span class="text-[10px] uppercase tracking-[0.15em] text-zinc-500">${esc(snap.symbol || 'BTC')} / USDT · Live tick</span>
      <span class="text-[10px] text-zinc-600">Binance + CoinGecko</span>
    </div>
    <div class="flex items-baseline gap-4 mb-4">
      <div class="text-5xl tabular-nums text-zinc-100">${esc(fmt.usd(t.price))}</div>
      <div class="text-lg ${t.change24h >= 0 ? 'text-emerald-400' : 'text-red-400'}">
        ${t.change24h >= 0 ? '▲' : '▼'} ${esc(fmt.pct(t.change24h))}
      </div>
    </div>
    <div class="h-20 mb-4">${snap.klines && snap.klines.length ? sparkSVG(snap.klines, '#3b82f6') : ''}</div>
    <div class="mb-4">
      <div class="flex justify-between text-[10px] text-zinc-500 mb-2">
        <span>BID WALL ${esc(fmt.usd(support))}</span>
        <span class="text-blue-400">NOW ${esc(fmt.usd(t.price))}</span>
        <span>ASK WALL ${esc(fmt.usd(resistance))}</span>
      </div>
      <div class="relative h-2 bg-zinc-900">
        <div class="absolute inset-y-0 left-0 bg-emerald-500/20" style="width: 15%"></div>
        <div class="absolute inset-y-0 right-0 bg-red-500/20" style="width: 15%"></div>
        <div class="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-blue-400 rounded-full -ml-1.5" style="left: ${pos}%"></div>
      </div>
    </div>
    <div class="grid grid-cols-4 gap-3 pt-4 border-t border-zinc-800">
      <div><div class="text-[10px] uppercase text-zinc-500 mb-1">7d</div>
        <div class="text-sm ${cg.change7d >= 0 ? 'text-emerald-400' : 'text-red-400'}">${esc(fmt.pct(cg.change7d))}</div></div>
      <div><div class="text-[10px] uppercase text-zinc-500 mb-1">30d</div>
        <div class="text-sm ${cg.change30d >= 0 ? 'text-emerald-400' : 'text-red-400'}">${esc(fmt.pct(cg.change30d))}</div></div>
      <div><div class="text-[10px] uppercase text-zinc-500 mb-1">ATH dist</div>
        <div class="text-sm text-zinc-300">${esc(fmt.pct(cg.athDistance))}</div></div>
      <div><div class="text-[10px] uppercase text-zinc-500 mb-1">Dominance</div>
        <div class="text-sm text-blue-400">${g.btcDominance ? esc(g.btcDominance.toFixed(2) + '%') : '—'}</div></div>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Whale Walls card — visual order book
// ─────────────────────────────────────────────────────────────────────────────
function viewWhaleWalls(snap) {
  if (!snap?.orderBook) return viewPlaceholder('Whale Walls');
  const ob = snap.orderBook;
  const allWalls = [
    ...ob.bids.map(b => ({ ...b, side: 'bid' })),
    ...ob.asks.map(a => ({ ...a, side: 'ask' })),
  ].sort((a, b) => a.price - b.price);
  const maxTotal = Math.max(...allWalls.map(w => w.total), 1);

  return `<div class="col-span-12 md:col-span-5 border border-zinc-800 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-3">
      <span class="text-[10px] uppercase tracking-[0.15em] text-zinc-500">Whale Wall Map</span>
      <span class="text-[10px] text-zinc-600">Binance top 10</span>
    </div>
    <div class="flex justify-between text-xs mb-3">
      <span class="text-emerald-400">BID $${ob.bidWall != null ? (ob.bidWall / 1e6).toFixed(2) : '—'}M</span>
      <span class="text-zinc-500">${ob.ratio != null ? (ob.ratio * 100).toFixed(0) : '—'}% bid dominance</span>
      <span class="text-red-400">$${ob.askWall != null ? (ob.askWall / 1e6).toFixed(2) : '—'}M ASK</span>
    </div>
    <div class="space-y-1">
      ${allWalls.map(w => {
        const widthPct = (w.total / maxTotal) * 100;
        return `<div class="flex items-center gap-2 text-[10px]">
          <span class="w-20 tabular-nums text-zinc-400">${esc(fmt.usd(w.price))}</span>
          <div class="flex-1 h-3 bg-zinc-900 relative">
            <div class="absolute inset-y-0 left-0 ${w.side === 'bid' ? 'bg-emerald-500/60' : 'bg-red-500/60'}" style="width: ${widthPct}%"></div>
          </div>
          <span class="w-16 text-right tabular-nums ${w.side === 'bid' ? 'text-emerald-400' : 'text-red-400'}">$${(w.total / 1e6).toFixed(2)}M</span>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Fear & Greed gauge
// ─────────────────────────────────────────────────────────────────────────────
function viewFearGreed(snap) {
  const fg = snap?.fearGreed;
  if (!fg) return viewPlaceholder('Fear & Greed');
  const color = fg.value < 25 ? '#ef4444'
              : fg.value < 45 ? '#f59e0b'
              : fg.value < 55 ? '#eab308'
              : fg.value < 75 ? '#84cc16'
              : '#22c55e';
  return `<div class="col-span-12 md:col-span-4 border border-zinc-800 bg-zinc-950 p-5 h-full">
    <div class="flex items-center justify-between mb-3">
      <span class="text-[10px] uppercase tracking-[0.15em] text-zinc-500">Fear & Greed</span>
      <span class="text-[10px] text-zinc-600">alternative.me</span>
    </div>
    <div class="relative h-24 mb-2">${gaugeSVG(fg.value)}</div>
    <div class="text-center">
      <div class="text-3xl tabular-nums" style="color: ${color}">${esc(fg.value)}</div>
      <div class="text-xs uppercase tracking-wider text-zinc-400 mt-1">${esc(fg.label || '')}</div>
    </div>
    ${fg.history && fg.history.length ? `<div class="h-10 mt-3">${sparkSVG(fg.history.map(h => h.v), color, 200, 40)}</div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Signal chip (AI sentiment + reasoning)
// ─────────────────────────────────────────────────────────────────────────────
function viewSignal(analysis) {
  if (!analysis?.signal) return '';
  const map = {
    STRONG_BUY: { label: 'STRONG BUY', klass: 'text-emerald-400 border-emerald-500/40' },
    BUY:        { label: 'BUY',        klass: 'text-green-400 border-green-500/40' },
    NEUTRAL:    { label: 'NEUTRAL',    klass: 'text-amber-400 border-amber-500/40' },
    CAUTION:    { label: 'CAUTION',    klass: 'text-orange-400 border-orange-500/40' },
    AVOID:      { label: 'AVOID',      klass: 'text-red-400 border-red-500/40' },
  };
  const m = map[analysis.signal] || map.NEUTRAL;
  const textClass = m.klass.split(' ')[0];
  return `<div class="col-span-12 md:col-span-8 border ${m.klass} bg-zinc-950 p-5">
    <div class="flex items-baseline justify-between mb-2">
      <span class="text-[10px] uppercase tracking-[0.15em] text-zinc-500">Sentiment Signal</span>
      <span class="text-[10px] text-zinc-600">snapshot + AI</span>
    </div>
    <div class="text-2xl mb-3 ${textClass}">${esc(m.label)}</div>
    <ul class="space-y-1.5 text-xs">
      ${(analysis.signalReasoning || []).slice(0, 3).map(r =>
        `<li class="text-zinc-400 leading-relaxed"><span class="opacity-60">→ </span>${renderMd(r)}</li>`
      ).join('')}
    </ul>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Whale Summary + News headlines
// ─────────────────────────────────────────────────────────────────────────────
function viewWhaleNews(analysis) {
  if (!analysis) return '';
  return `<div class="col-span-12 border border-zinc-800 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-3">
      <span class="text-[10px] uppercase tracking-[0.15em] text-zinc-500">Whale & Smart Money · 24h</span>
      <span class="text-[10px] text-zinc-600">snapshot data + CryptoCompare news</span>
    </div>
    <p class="text-sm text-zinc-300 leading-relaxed sans mb-4">${renderMd(analysis.whaleSummary || '—')}</p>
    <div class="pt-3 border-t border-zinc-800">
      <div class="text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-2">Top Headlines</div>
      <ul class="space-y-1.5">
        ${(analysis.newsHeadlines || []).map((h, i) => `<li class="text-xs text-zinc-400 leading-relaxed sans">
          <span class="text-blue-400/60 mr-2">${String(i + 1).padStart(2, '0')}</span>${esc(h)}
        </li>`).join('')}
      </ul>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  v3: Derivatives Intelligence card (OI + L/S + Taker)
// ─────────────────────────────────────────────────────────────────────────────
function viewDerivativesCard(snap, analysis) {
  const oi = snap?.openInterest;
  const ls = snap?.longShort;
  const tv = snap?.takerVolume;
  if (!oi && !ls && !tv) return '';

  // OI confluence with price
  const priceUp = (snap.ticker?.change24h ?? 0) > 0;
  let oiConfluence = { label: '—', class: 'text-zinc-400', hint: '' };
  if (oi) {
    if (oi.change24h > 2 && priceUp) oiConfluence = { label: 'NEW MONEY', class: 'text-emerald-400', hint: 'trend valid · whales open longs' };
    else if (oi.change24h < -2 && priceUp) oiConfluence = { label: 'SHORT SQUEEZE', class: 'text-amber-400', hint: 'rally lemah · shorts cover' };
    else if (oi.change24h > 2 && !priceUp) oiConfluence = { label: 'NEW SHORTS', class: 'text-red-400', hint: 'bearish confirm · whales short' };
    else if (oi.change24h < -2 && !priceUp) oiConfluence = { label: 'LONG CAPITULATE', class: 'text-orange-400', hint: 'longs surrender · selling pressure' };
    else oiConfluence = { label: 'NEUTRAL FLOW', class: 'text-zinc-400', hint: 'no significant flow' };
  }

  // Smart money bias styling
  const biasMap = {
    LONG:                     { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/40', label: 'BIAS LONG' },
    SHORT:                    { color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/40',     label: 'BIAS SHORT' },
    SMART_LONG_RETAIL_SHORT:  { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/50', label: 'CONTRARIAN LONG' },
    SMART_SHORT_RETAIL_LONG:  { color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/50',     label: 'CONTRARIAN SHORT' },
    NEUTRAL:                  { color: 'text-zinc-400',    bg: 'bg-zinc-800/40',    border: 'border-zinc-700',       label: 'NEUTRAL' },
  };
  const bias = ls ? biasMap[ls.smartMoneyBias] || biasMap.NEUTRAL : null;

  // Taker visual
  const takerPos = tv ? Math.min(Math.max((tv.current - 0.7) / 0.6, 0), 1) * 100 : 50;
  const takerLabel = tv && tv.current > 1.1 ? 'BUYERS AGGRESSIVE'
                   : tv && tv.current < 0.9 ? 'SELLERS AGGRESSIVE'
                   : 'BALANCED';
  const takerColor = tv && tv.current > 1.1 ? 'text-emerald-400'
                   : tv && tv.current < 0.9 ? 'text-red-400'
                   : 'text-zinc-400';

  return `<div class="col-span-12 border border-purple-500/30 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-4">
      <div>
        <span class="text-[10px] uppercase tracking-[0.15em] text-purple-300">Derivatives Intelligence · NEW v3</span>
        <div class="text-xs text-zinc-500 sans mt-0.5">Binance Futures — OI · Long/Short · Taker flow</div>
      </div>
      <span class="text-[10px] text-zinc-600">smart money lens</span>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-3 gap-3">

      <!-- Open Interest -->
      ${oi ? `<div class="border border-zinc-800 bg-zinc-950/40 p-4">
        <div class="flex items-center justify-between mb-3">
          <span class="text-[10px] uppercase tracking-wider text-zinc-500">Open Interest 24h</span>
          <span class="text-[10px] ${oiConfluence.class}">${oiConfluence.label}</span>
        </div>
        <div class="text-2xl tabular-nums text-zinc-100 mb-1">$${(oi.current / 1e9).toFixed(2)}<span class="text-sm text-zinc-500">B</span></div>
        <div class="flex items-center gap-2 mb-2">
          <span class="text-sm tabular-nums ${(oi.change24h ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}">${(oi.change24h ?? 0) >= 0 ? '+' : ''}${oi.change24h != null ? oi.change24h.toFixed(2) : '—'}%</span>
          <span class="text-[10px] text-zinc-500 sans">vs 24h ago</span>
        </div>
        <div class="text-[11px] text-zinc-400 sans italic">${esc(oiConfluence.hint)}</div>
      </div>` : ''}

      <!-- Long/Short ratio -->
      ${ls ? `<div class="border ${bias.border} ${bias.bg} p-4">
        <div class="flex items-center justify-between mb-3">
          <span class="text-[10px] uppercase tracking-wider text-zinc-500">Long/Short Bias</span>
          <span class="text-[10px] ${bias.color} font-medium">${bias.label}</span>
        </div>
        <div class="space-y-2 mb-2">
          <div class="flex items-center justify-between">
            <span class="text-[10px] text-zinc-500 uppercase">Smart money</span>
            <div class="flex items-center gap-2">
              <span class="text-base tabular-nums ${(ls.topTrader.current ?? 0) > 1 ? 'text-emerald-400' : 'text-red-400'}">${ls.topTrader.current != null ? ls.topTrader.current.toFixed(2) : '—'}</span>
              <span class="text-[9px] text-zinc-600">${ls.topTrader.trend === 'RISING' ? '↗' : '↘'}</span>
            </div>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-[10px] text-zinc-500 uppercase">Retail</span>
            <div class="flex items-center gap-2">
              <span class="text-base tabular-nums ${(ls.global.current ?? 0) > 1 ? 'text-emerald-400' : 'text-red-400'}">${ls.global.current != null ? ls.global.current.toFixed(2) : '—'}</span>
              <span class="text-[9px] text-zinc-600">${ls.global.trend === 'RISING' ? '↗' : '↘'}</span>
            </div>
          </div>
        </div>
        <div class="text-[11px] text-zinc-400 sans pt-2 border-t border-zinc-800/60">
          Divergence: <span class="${Math.abs(ls.divergence ?? 0) > 0.3 ? 'text-amber-400' : 'text-zinc-400'} tabular-nums">${(ls.divergence ?? 0) >= 0 ? '+' : ''}${ls.divergence != null ? ls.divergence.toFixed(2) : '—'}</span>
          ${Math.abs(ls.divergence) > 0.5 ? '<span class="text-amber-400 ml-1">⚠</span>' : ''}
        </div>
      </div>` : ''}

      <!-- Taker volume -->
      ${tv ? `<div class="border border-zinc-800 bg-zinc-950/40 p-4">
        <div class="flex items-center justify-between mb-3">
          <span class="text-[10px] uppercase tracking-wider text-zinc-500">Taker Flow 24h</span>
          <span class="text-[10px] ${takerColor}">${takerLabel}</span>
        </div>
        <div class="text-2xl tabular-nums text-zinc-100 mb-2">${tv.current != null ? tv.current.toFixed(2) : '—'}<span class="text-sm text-zinc-500"> ratio</span></div>
        <div class="h-2 bg-zinc-900 relative mb-2">
          <div class="absolute inset-y-0 left-1/2 w-px bg-zinc-700"></div>
          <div class="absolute inset-y-0 w-2 -ml-1 ${(tv.current ?? 1) > 1 ? 'bg-emerald-400' : 'bg-red-400'}" style="left: ${takerPos}%"></div>
        </div>
        <div class="flex justify-between text-[9px] text-zinc-600 mb-2">
          <span>0.7 sell</span><span>1.0</span><span>1.3 buy</span>
        </div>
        <div class="text-[11px] text-zinc-400 sans italic">trend: ${tv.trend.toLowerCase().replace('_', ' ')}</div>
      </div>` : ''}

    </div>

    ${analysis?.derivativesView ? `<div class="mt-4 pt-4 border-t border-zinc-800/60">
      <div class="text-[10px] uppercase tracking-wider text-purple-400/80 mb-2">AI Reading</div>
      <p class="text-xs text-zinc-300 sans leading-relaxed italic">${renderMd(analysis.derivativesView || '')}</p>
    </div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  v3: Technical Indicators card (RSI + MACD + BB + EMA per TF)
// ─────────────────────────────────────────────────────────────────────────────
function viewTechnicalCard(snap, analysis) {
  const ind = snap?.indicators;
  const conf = snap?.confluence;
  if (!ind) return '';

  const tfBlock = (tf, label) => {
    const i = ind[tf];
    if (!i) return `<div class="border border-zinc-800 bg-zinc-950/40 p-3 opacity-50 text-center">
      <div class="text-[10px] uppercase text-zinc-500">${label}</div>
      <div class="text-xs text-zinc-600 mt-2">data tidak tersedia</div>
    </div>`;

    const trendCfg = i.trend === 'BULLISH' ? { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', icon: '▲' }
                   : i.trend === 'BEARISH' ? { color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/30',     icon: '▼' }
                   :                          { color: 'text-zinc-400',   bg: 'bg-zinc-800/30',    border: 'border-zinc-700',       icon: '◆' };

    const rsiColor = i.rsi >= 70 ? '#ef4444' : i.rsi <= 30 ? '#22c55e' : i.rsi >= 60 ? '#84cc16' : i.rsi <= 40 ? '#f97316' : '#a1a1aa';
    const rsiLabel = i.rsi >= 70 ? 'OB' : i.rsi <= 30 ? 'OS' : i.rsi >= 60 ? 'BULL' : i.rsi <= 40 ? 'BEAR' : '—';
    const rsiPct = Math.min(Math.max(i.rsi, 0), 100);

    const bbPos = i.bb ? Math.min(Math.max(i.bb.position * 100, 0), 100) : 50;
    const bbSqueeze = i.bb && i.bb.widthPct < 4;

    return `<div class="border ${trendCfg.border} ${trendCfg.bg} p-3">
      <div class="flex items-center justify-between mb-3">
        <span class="text-[10px] uppercase tracking-wider text-zinc-500">${label}</span>
        <div class="flex items-center gap-1 ${trendCfg.color}">
          <span class="text-xs">${trendCfg.icon}</span>
          <span class="text-[10px] font-medium">${i.trend}</span>
        </div>
      </div>

      <!-- RSI -->
      <div class="mb-3">
        <div class="flex items-center justify-between text-[10px] mb-1">
          <span class="text-zinc-500">RSI 14</span>
          <span class="tabular-nums" style="color: ${rsiColor}">${i.rsi != null ? i.rsi.toFixed(1) : '—'} <span class="text-[9px]">${rsiLabel}</span></span>
        </div>
        <div class="h-1.5 bg-zinc-900 relative">
          <div class="absolute inset-y-0 left-[30%] w-px bg-zinc-700"></div>
          <div class="absolute inset-y-0 left-[70%] w-px bg-zinc-700"></div>
          <div class="absolute inset-y-0 left-0" style="width: ${rsiPct}%; background: ${rsiColor}"></div>
        </div>
      </div>

      <!-- MACD -->
      ${i.macd ? `<div class="mb-3">
        <div class="flex items-center justify-between text-[10px]">
          <span class="text-zinc-500">MACD</span>
          <div class="flex items-center gap-2">
            <span class="${i.macd.bullish ? 'text-emerald-400' : 'text-red-400'}">${i.macd.bullish ? 'BULL' : 'BEAR'}</span>
            <span class="text-zinc-600">${i.macd.momentum === 'RISING' ? '↗' : '↘'}</span>
          </div>
        </div>
        <div class="text-[10px] text-zinc-600 tabular-nums">hist ${i.macd.histogram != null ? i.macd.histogram.toFixed(2) : '—'}</div>
      </div>` : ''}

      <!-- Bollinger position -->
      ${i.bb ? `<div class="mb-2">
        <div class="flex items-center justify-between text-[10px] mb-1">
          <span class="text-zinc-500">BB pos</span>
          <span class="text-zinc-400 tabular-nums">${i.bb.position != null ? (i.bb.position * 100).toFixed(0) : '—'}%${bbSqueeze ? ' <span class="text-amber-400">SQZ</span>' : ''}</span>
        </div>
        <div class="h-1 bg-zinc-900 relative">
          <div class="absolute inset-y-0 w-1 -ml-0.5 bg-blue-400" style="left: ${bbPos}%"></div>
        </div>
      </div>` : ''}

      <!-- EMA -->
      <div class="text-[10px] text-zinc-600 sans pt-2 border-t border-zinc-800/40 tabular-nums">
        EMA21 ${i.ema21 ? '$' + i.ema21.toFixed(0) : '—'}<br>
        EMA55 ${i.ema55 ? '$' + i.ema55.toFixed(0) : '—'}${i.ema200 ? '<br>EMA200 $' + i.ema200.toFixed(0) : ''}
      </div>
    </div>`;
  };

  // Confluence summary
  const confCfg = !conf ? null
    : conf.alignment === 'STRONG_BULL' ? { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/40', label: '⚡ STRONG BULL — all 3 TF aligned', hint: 'tightest confluence · highest confidence' }
    : conf.alignment === 'STRONG_BEAR' ? { color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/40',     label: '⚡ STRONG BEAR — all 3 TF aligned', hint: 'tightest confluence · highest confidence' }
    : conf.alignment === 'BULL'        ? { color: 'text-emerald-400', bg: 'bg-emerald-500/5',  border: 'border-emerald-500/30', label: 'BULL — 2 of 3 TF aligned',          hint: 'medium confluence' }
    : conf.alignment === 'BEAR'        ? { color: 'text-red-400',     bg: 'bg-red-500/5',      border: 'border-red-500/30',     label: 'BEAR — 2 of 3 TF aligned',          hint: 'medium confluence' }
    :                                    { color: 'text-amber-400',   bg: 'bg-amber-500/5',    border: 'border-amber-500/30',   label: 'MIXED — no clear direction',        hint: 'wait for confluence' };

  return `<div class="col-span-12 border border-blue-500/30 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-4">
      <div>
        <span class="text-[10px] uppercase tracking-[0.15em] text-blue-300">Technical Analysis · NEW v3</span>
        <div class="text-xs text-zinc-500 sans mt-0.5">Multi-timeframe · pre-computed (RSI · MACD · BB · EMA)</div>
      </div>
      <span class="text-[10px] text-zinc-600">self-computed from klines</span>
    </div>

    ${confCfg ? `<div class="border ${confCfg.border} ${confCfg.bg} p-3 mb-4">
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-sm ${confCfg.color} font-medium">${esc(confCfg.label)}</div>
          <div class="text-[11px] text-zinc-500 sans mt-1">${esc(confCfg.hint)}</div>
        </div>
        <div class="flex gap-1 text-[10px]">
          <span class="px-2 py-1 ${conf.bullish > 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-zinc-900 text-zinc-600'} rounded">${conf.bullish} bull</span>
          <span class="px-2 py-1 ${conf.bearish > 0 ? 'bg-red-500/20 text-red-400' : 'bg-zinc-900 text-zinc-600'} rounded">${conf.bearish} bear</span>
          <span class="px-2 py-1 ${conf.neutral > 0 ? 'bg-zinc-800 text-zinc-400' : 'bg-zinc-900 text-zinc-600'} rounded">${conf.neutral} neut</span>
        </div>
      </div>
    </div>` : ''}

    <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
      ${tfBlock('h1', '1H · short-term')}
      ${tfBlock('h4', '4H · swing')}
      ${tfBlock('d1', '1D · position')}
    </div>

    ${(() => {
      // v5.3: Advanced metrics row (ATR/VWAP/Volume) dari 1H
      const a = snap?.advanced?.h1;
      if (!a) return '';
      const price = snap.ticker?.price;
      const aboveVwap = a.vwap && price ? price > a.vwap : null;
      return `<div class="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
        <div class="border border-zinc-800 bg-zinc-950/40 p-2.5">
          <div class="text-[9px] uppercase tracking-wider text-zinc-500 mb-1">ATR 1H (volatilitas)</div>
          <div class="text-sm tabular-nums text-zinc-200">${a.atr ? '$' + a.atr.toFixed(0) : '—'}</div>
          <div class="text-[9px] text-zinc-600">${a.atrPct ? a.atrPct.toFixed(2) + '% range/jam' : ''}</div>
        </div>
        <div class="border border-zinc-800 bg-zinc-950/40 p-2.5">
          <div class="text-[9px] uppercase tracking-wider text-zinc-500 mb-1">VWAP 1H</div>
          <div class="text-sm tabular-nums ${aboveVwap === null ? 'text-zinc-200' : aboveVwap ? 'text-emerald-400' : 'text-red-400'}">${a.vwap ? '$' + a.vwap.toFixed(0) : '—'}</div>
          <div class="text-[9px] ${aboveVwap ? 'text-emerald-500/70' : 'text-red-500/70'}">${aboveVwap === null ? '' : aboveVwap ? 'harga di atas' : 'harga di bawah'}</div>
        </div>
        <div class="border border-zinc-800 bg-zinc-950/40 p-2.5">
          <div class="text-[9px] uppercase tracking-wider text-zinc-500 mb-1">Volume</div>
          <div class="text-sm ${a.volume?.trend === 'RISING' ? 'text-emerald-400' : a.volume?.trend === 'FALLING' ? 'text-red-400' : 'text-zinc-300'}">${a.volume?.trend || '—'}${a.volume?.spike ? ' ⚡' : ''}</div>
          <div class="text-[9px] text-zinc-600">${a.volume?.relativeToAvg ? a.volume.relativeToAvg.toFixed(1) + '× avg' : ''}</div>
        </div>
        <div class="border border-zinc-800 bg-zinc-950/40 p-2.5">
          <div class="text-[9px] uppercase tracking-wider text-zinc-500 mb-1">Swing S/R 1H</div>
          <div class="text-[11px] tabular-nums text-emerald-400">R $${a.swing?.nearestResistance ? a.swing.nearestResistance.toFixed(0) : '—'}</div>
          <div class="text-[11px] tabular-nums text-red-400">S $${a.swing?.nearestSupport ? a.swing.nearestSupport.toFixed(0) : '—'}</div>
        </div>
      </div>`;
    })()}

    ${analysis?.technicalView ? `<div class="mt-4 pt-4 border-t border-zinc-800/60">
      <div class="text-[10px] uppercase tracking-wider text-blue-400/80 mb-2">AI Reading</div>
      <p class="text-xs text-zinc-300 sans leading-relaxed italic">${renderMd(analysis.technicalView || '')}</p>
    </div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  v4: Options Flow card (Deribit PCR + Max Pain)
// ─────────────────────────────────────────────────────────────────────────────
function viewOptionsCard(snap, analysis) {
  const o = snap?.options;
  if (!o) return '';

  const signalCfg = {
    BULLISH_HEAVY: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/40', label: 'BULLISH HEAVY', hint: 'calls dominant — kemungkinan extreme, watch contrarian' },
    BULLISH:       { color: 'text-emerald-400', bg: 'bg-emerald-500/5',  border: 'border-emerald-500/30', label: 'BULLISH',       hint: 'options market lean bullish' },
    NEUTRAL:       { color: 'text-zinc-400',    bg: 'bg-zinc-800/30',    border: 'border-zinc-700',       label: 'NEUTRAL',       hint: 'balanced positioning' },
    BEARISH:       { color: 'text-red-400',     bg: 'bg-red-500/5',      border: 'border-red-500/30',     label: 'BEARISH',       hint: 'puts dominant — hedging atau bearish bias' },
    BEARISH_HEAVY: { color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/40',     label: 'BEARISH HEAVY', hint: 'puts dominant — kemungkinan capitulation' },
  };
  const cfg = signalCfg[o.pcrSignal] || signalCfg.NEUTRAL;

  // Max pain magnet visualization
  const currentPrice = snap.ticker?.price || o.underlying;
  const maxPain = o.maxPain;
  const gap = o.maxPainGap;
  const magnetColor = gap == null ? 'text-zinc-400'
                    : Math.abs(gap) < 1   ? 'text-emerald-400'
                    : Math.abs(gap) < 3   ? 'text-amber-400'
                    : 'text-red-400';

  const daysToExpiry = o.nearestExpiry
    ? Math.max(0, Math.ceil((o.nearestExpiry - Date.now()) / (24 * 3600 * 1000)))
    : null;
  const expiryDate = o.nearestExpiry ? new Date(o.nearestExpiry).toISOString().slice(0, 10) : '—';

  return `<div class="col-span-12 md:col-span-6 border border-amber-500/30 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-4">
      <div>
        <span class="text-[10px] uppercase tracking-[0.15em] text-amber-300">Options Flow · NEW v4</span>
        <div class="text-xs text-zinc-500 sans mt-0.5">Deribit · Put/Call ratio + Max pain magnet</div>
      </div>
      <span class="text-[10px] text-zinc-600">${o.optionsCount} contracts</span>
    </div>

    <div class="grid grid-cols-2 gap-3">
      <!-- PCR Block -->
      <div class="border ${cfg.border} ${cfg.bg} p-3">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[10px] uppercase tracking-wider text-zinc-500">P/C Ratio</span>
          <span class="text-[9px] ${cfg.color} font-medium">${cfg.label}</span>
        </div>
        <div class="text-2xl tabular-nums text-zinc-100 mb-1">${o.pcrOI != null ? o.pcrOI.toFixed(2) : '—'}</div>
        <div class="text-[10px] text-zinc-500 sans mb-2">by open interest</div>
        <div class="text-[10px] text-zinc-400 tabular-nums">${o.pcrVolume != null ? o.pcrVolume.toFixed(2) : '—'} <span class="text-zinc-600">vol</span></div>
        <div class="text-[10px] text-zinc-600 sans mt-1 italic">${esc(cfg.hint)}</div>
      </div>

      <!-- Max Pain Block -->
      <div class="border border-zinc-800 bg-zinc-950/40 p-3">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[10px] uppercase tracking-wider text-zinc-500">Max Pain</span>
          <span class="text-[9px] text-amber-400">${daysToExpiry != null ? daysToExpiry + 'd' : '—'} expiry</span>
        </div>
        <div class="text-2xl tabular-nums text-zinc-100 mb-1">${maxPain ? '$' + maxPain.toLocaleString() : '—'}</div>
        <div class="text-[10px] ${magnetColor} tabular-nums">${gap != null ? (gap >= 0 ? '+' : '') + gap.toFixed(2) + '% from spot' : ''}</div>
        <div class="text-[10px] text-zinc-500 sans mt-2">expiry ${expiryDate}</div>
        <div class="text-[10px] text-zinc-600 sans mt-1 italic">${
          gap == null ? '' :
          Math.abs(gap) < 1 ? 'sudah di magnet — kemungkinan pinned' :
          Math.abs(gap) < 3 ? 'price magnet aktif — bisa tarik harga' :
          'gap besar — magnet effect lebih lemah'
        }</div>
      </div>
    </div>

    <!-- Call vs Put OI bar -->
    <div class="mt-3">
      <div class="flex justify-between text-[10px] text-zinc-500 mb-1">
        <span>Calls $${(o.callOI / 1000).toFixed(1)}K</span>
        <span>Puts $${(o.putOI / 1000).toFixed(1)}K</span>
      </div>
      <div class="h-2 bg-zinc-900 flex overflow-hidden">
        <div class="bg-emerald-500/60" style="width: ${(o.callOI / (o.callOI + o.putOI || 1)) * 100}%"></div>
        <div class="bg-red-500/60 flex-1"></div>
      </div>
    </div>

    ${analysis?.optionsView ? `<div class="mt-3 pt-3 border-t border-zinc-800/60">
      <div class="text-[10px] uppercase tracking-wider text-amber-400/80 mb-1.5">AI Reading</div>
      <p class="text-xs text-zinc-300 sans leading-relaxed italic">${renderMd(analysis.optionsView || '')}</p>
    </div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  v4: On-Chain Cycle card (CoinMetrics MVRV)
// ─────────────────────────────────────────────────────────────────────────────
function viewOnChainCard(snap, analysis) {
  const oc = snap?.onChain;
  if (!oc) return '';

  const cycleCfg = {
    CYCLE_BOTTOM: { color: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/50', icon: '⬇', label: 'CYCLE BOTTOM', hint: 'historical buy zone — rare opportunity' },
    UNDERVALUED:  { color: 'text-emerald-400', bg: 'bg-emerald-500/5',  border: 'border-emerald-500/30', icon: '↓', label: 'UNDERVALUED',  hint: 'below market cost basis' },
    FAIR_VALUE:   { color: 'text-blue-400',    bg: 'bg-blue-500/5',     border: 'border-blue-500/30',    icon: '◆', label: 'FAIR VALUE',   hint: 'at market cost basis' },
    BULLISH:      { color: 'text-blue-400',    bg: 'bg-blue-500/5',     border: 'border-blue-500/30',    icon: '↑', label: 'BULLISH',      hint: 'healthy bull range' },
    OVERVALUED:   { color: 'text-orange-400',  bg: 'bg-orange-500/5',   border: 'border-orange-500/30',  icon: '⬆', label: 'OVERVALUED',   hint: 'caution — late-cycle' },
    CYCLE_TOP:    { color: 'text-red-400',     bg: 'bg-red-500/15',     border: 'border-red-500/50',    icon: '⚠', label: 'CYCLE TOP',     hint: 'historical sell zone — extreme overheated' },
  };
  const cfg = cycleCfg[oc.mvrvSignal] || cycleCfg.FAIR_VALUE;

  // MVRV scale visualization (0.5 to 4.0)
  const mvrvPct = Math.min(Math.max((oc.mvrv - 0.5) / 3.5, 0), 1) * 100;
  const currentPrice = snap.ticker?.price;
  const realizedPremium = oc.realizedPrice && currentPrice
    ? ((currentPrice - oc.realizedPrice) / oc.realizedPrice) * 100
    : null;

  return `<div class="col-span-12 md:col-span-6 border border-emerald-500/30 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-4">
      <div>
        <span class="text-[10px] uppercase tracking-[0.15em] text-emerald-300">On-Chain Cycle · NEW v4</span>
        <div class="text-xs text-zinc-500 sans mt-0.5">CoinMetrics · MVRV ratio + Realized Price</div>
      </div>
      <span class="text-[10px] text-zinc-600">daily update</span>
    </div>

    <div class="grid grid-cols-2 gap-3 mb-4">
      <!-- MVRV main metric -->
      <div class="border ${cfg.border} ${cfg.bg} p-3">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[10px] uppercase tracking-wider text-zinc-500">MVRV ratio</span>
          <span class="text-[9px] ${cfg.color}">${cfg.icon} ${cfg.label}</span>
        </div>
        <div class="text-2xl tabular-nums text-zinc-100 mb-2">${oc.mvrv != null ? oc.mvrv.toFixed(2) : '—'}</div>
        <!-- MVRV scale -->
        <div class="h-1.5 bg-zinc-900 relative">
          <div class="absolute inset-y-0 left-[14%] w-px bg-zinc-700"></div>
          <div class="absolute inset-y-0 left-[29%] w-px bg-zinc-700"></div>
          <div class="absolute inset-y-0 left-[57%] w-px bg-zinc-700"></div>
          <div class="absolute inset-y-0 left-[86%] w-px bg-zinc-700"></div>
          <div class="absolute inset-y-0 w-1.5 -ml-0.5 ${cfg.color.replace('text-', 'bg-')}" style="left: ${mvrvPct}%"></div>
        </div>
        <div class="flex justify-between text-[9px] text-zinc-600 mt-1">
          <span>0.5</span><span>1</span><span>2.5</span><span>3.5</span>
        </div>
      </div>

      <!-- Realized Price -->
      <div class="border border-zinc-800 bg-zinc-950/40 p-3">
        <div class="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Realized Price</div>
        <div class="text-base tabular-nums text-zinc-100 mb-2">$${oc.realizedPrice ? Number(oc.realizedPrice).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</div>
        <div class="text-[10px] text-zinc-500 sans mb-1">market avg cost basis</div>
        ${realizedPremium != null ? `<div class="text-[11px] tabular-nums ${realizedPremium >= 0 ? 'text-emerald-400' : 'text-red-400'}">${realizedPremium >= 0 ? '+' : ''}${realizedPremium.toFixed(1)}% premium</div>` : ''}
        <div class="text-[10px] text-zinc-600 sans mt-1 italic">${realizedPremium != null
          ? (realizedPremium > 100 ? 'high premium — bull market'
            : realizedPremium > 30 ? 'healthy bull range'
            : realizedPremium > 0 ? 'modest premium'
            : 'below cost basis — bear territory')
          : ''}</div>
      </div>
    </div>

    <div class="text-[10px] text-zinc-500 sans pt-2 border-t border-zinc-800/60">
      <span class="text-emerald-400/80 uppercase tracking-wider mr-2">Reference</span>${esc(cfg.hint)}
    </div>

    ${analysis?.onChainView ? `<div class="mt-3 pt-3 border-t border-zinc-800/60">
      <div class="text-[10px] uppercase tracking-wider text-emerald-400/80 mb-1.5">AI Reading</div>
      <p class="text-xs text-zinc-300 sans leading-relaxed italic">${renderMd(analysis.onChainView || '')}</p>
    </div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  v7: On-Chain Extended card (Exchange Flow + Active Addresses)
// ─────────────────────────────────────────────────────────────────────────────
function viewOnChainExtCard(snap) {
  const oe = snap?.onChainExt;
  if (!oe) return '';

  const flowCfg = {
    ACCUMULATION:    { c: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', label: 'AKUMULASI',   hint: 'BTC banyak keluar exchange — holder menahan, bullish' },
    SLIGHT_ACCUM:    { c: 'text-blue-400',    bg: 'bg-blue-500/5',     border: 'border-blue-500/20',    label: 'SLIGHT ACCUM', hint: 'Net outflow ringan — sedikit akumulasi' },
    NEUTRAL:         { c: 'text-zinc-400',    bg: 'bg-zinc-800/30',    border: 'border-zinc-700',       label: 'NEUTRAL',      hint: 'Flow seimbang' },
    SLIGHT_DISTRIB:  { c: 'text-amber-400',   bg: 'bg-amber-500/5',    border: 'border-amber-500/20',   label: 'SLIGHT SELL',  hint: 'Net inflow ringan — sedikit distribusi' },
    DISTRIBUTION:    { c: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/30',     label: 'DISTRIBUSI',   hint: 'BTC banyak masuk exchange — tekanan jual, bearish' },
  };
  const adrCfg = {
    RISING:  { c: 'text-emerald-400', label: 'RISING',  hint: 'demand jaringan naik' },
    STABLE:  { c: 'text-blue-400',    label: 'STABLE',  hint: 'aktivitas stabil' },
    FALLING: { c: 'text-red-400',     label: 'FALLING', hint: 'aktivitas jaringan melemah' },
  };

  const flow = flowCfg[oe.exchangeFlowSignal] || flowCfg.NEUTRAL;
  const adr  = adrCfg[oe.adrTrend] || { c: 'text-zinc-400', label: oe.adrTrend || '—', hint: '' };

  const fmtM = (v) => v == null ? '—' : (Math.abs(v) >= 1000 ? (v/1000).toFixed(1)+'B' : v.toFixed(0)+'M');
  const fmtK = (v) => v == null ? '—' : (v >= 1e6 ? (v/1e6).toFixed(2)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'K' : String(v));

  return `<div class="col-span-12 md:col-span-6 border border-blue-500/20 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-4">
      <div>
        <span class="text-[10px] uppercase tracking-[0.15em] text-blue-300">On-Chain Extended · v7</span>
        <div class="text-xs text-zinc-500 sans mt-0.5">CoinMetrics Community · Exchange Flow + Active Addresses${oe.date ? ' · ' + oe.date : ''}</div>
      </div>
      <div class="border ${flow.border} ${flow.bg} px-2 py-0.5">
        <span class="text-[9px] uppercase tracking-wider ${flow.c}">${flow.label}</span>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-3 mb-3">
      <div class="border border-zinc-800 bg-zinc-950/40 p-3">
        <div class="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Exchange Net Flow</div>
        <div class="text-xl tabular-nums ${oe.netFlowM != null ? (oe.netFlowM < 0 ? 'text-emerald-400' : 'text-red-400') : 'text-zinc-400'}">
          ${oe.netFlowM != null ? (oe.netFlowM >= 0 ? '+' : '') + fmtM(oe.netFlowM) : '—'} <span class="text-xs text-zinc-600">USD</span>
        </div>
        <div class="text-[9px] text-zinc-600 mt-1">negatif = keluar exchange = akumulasi</div>
        <div class="text-[9px] text-zinc-600">in: $${fmtM(oe.flowInExUsd != null ? oe.flowInExUsd/1e6 : null)} · out: $${fmtM(oe.flowOutExUsd != null ? oe.flowOutExUsd/1e6 : null)}</div>
      </div>

      <div class="border border-zinc-800 bg-zinc-950/40 p-3">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[10px] uppercase tracking-wider text-zinc-500">Active Addresses</span>
          ${oe.adrTrend ? `<span class="text-[9px] ${adr.c}">${adr.label}</span>` : ''}
        </div>
        <div class="text-xl tabular-nums text-zinc-100">${fmtK(oe.activeAddresses)}</div>
        <div class="text-[9px] text-zinc-600 mt-1">${adr.hint || 'alamat aktif hari ini'}</div>
      </div>
    </div>

    <div class="text-[10px] text-zinc-500 sans border-t border-zinc-800/60 pt-2">
      <span class="${flow.c}">${flow.hint}</span>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  v4: Macro Context card (DXY + Gold + SPX)
// ─────────────────────────────────────────────────────────────────────────────
function viewMacroCard(snap, analysis) {
  const m = snap?.macro;
  if (!m) return '';

  const regimeCfg = {
    RISK_OFF:           { color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/40',     label: 'RISK OFF',         hint: 'DXY↑ + SPX↓ → crypto headwind' },
    DOLLAR_STRENGTH:    { color: 'text-orange-400',  bg: 'bg-orange-500/5',   border: 'border-orange-500/30',  label: 'DOLLAR STRONG',    hint: 'USD rally → crypto headwind' },
    NEUTRAL:            { color: 'text-zinc-400',    bg: 'bg-zinc-800/30',    border: 'border-zinc-700',       label: 'NEUTRAL',          hint: 'macro balanced' },
    DOLLAR_WEAKNESS:    { color: 'text-blue-400',    bg: 'bg-blue-500/5',     border: 'border-blue-500/30',    label: 'DOLLAR WEAK',      hint: 'USD slip → crypto tailwind' },
    RISK_ON:            { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/40', label: 'RISK ON',          hint: 'DXY↓ + SPX↑ → crypto tailwind' },
  };
  const cfg = regimeCfg[m.riskRegime] || regimeCfg.NEUTRAL;

  const metricBox = (label, data, inverseToBTC = false) => {
    if (!data) return `<div class="border border-zinc-800 bg-zinc-950/40 p-3 opacity-50 text-center">
      <div class="text-[10px] uppercase text-zinc-500">${label}</div>
      <div class="text-xs text-zinc-600 mt-2">N/A</div>
    </div>`;
    const positive = data.changePct >= 0;
    const goodForBTC = inverseToBTC ? !positive : positive;
    return `<div class="border border-zinc-800 bg-zinc-950/40 p-3">
      <div class="flex items-center justify-between mb-2">
        <span class="text-[10px] uppercase tracking-wider text-zinc-500">${label}</span>
        ${inverseToBTC ? '<span class="text-[9px] text-zinc-600" title="Inverse correlation to crypto">↔ inv</span>' : ''}
      </div>
      <div class="text-lg tabular-nums text-zinc-100">${typeof data.close === 'number' ? data.close.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}</div>
      <div class="text-[11px] tabular-nums ${positive ? 'text-emerald-400' : 'text-red-400'}">${positive ? '+' : ''}${data.changePct != null ? data.changePct.toFixed(2) : '0'}%</div>
      <div class="text-[9px] mt-1 ${goodForBTC ? 'text-emerald-500/70' : 'text-red-500/70'}">${goodForBTC ? '↗ crypto favorable' : '↘ crypto pressure'}</div>
    </div>`;
  };

  return `<div class="col-span-12 border border-cyan-500/30 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-4">
      <div>
        <span class="text-[10px] uppercase tracking-[0.15em] text-cyan-300">Macro Context · NEW v4</span>
        <div class="text-xs text-zinc-500 sans mt-0.5">Stooq · DXY · Gold · S&P 500 correlation</div>
      </div>
      <div class="border ${cfg.border} ${cfg.bg} px-3 py-1.5">
        <span class="text-[10px] uppercase tracking-wider ${cfg.color} font-medium">${cfg.label}</span>
      </div>
    </div>

    <div class="grid grid-cols-3 gap-3 mb-3">
      ${metricBox('DXY · Dollar Index', m.dxy, true)}
      ${metricBox('Gold · USD/oz', m.gold, false)}
      ${metricBox('S&P 500', m.spx, false)}
    </div>

    <div class="text-[11px] text-zinc-500 sans pt-2 border-t border-zinc-800/60">
      <span class="text-cyan-400/80 uppercase tracking-wider mr-2">Regime</span>${esc(cfg.hint)}
    </div>

    ${analysis?.macroView ? `<div class="mt-3 pt-3 border-t border-zinc-800/60">
      <div class="text-[10px] uppercase tracking-wider text-cyan-400/80 mb-1.5">AI Reading</div>
      <p class="text-xs text-zinc-300 sans leading-relaxed italic">${renderMd(analysis.macroView || '')}</p>
    </div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  v6: Institutional & Cross-Exchange Flow card
// ─────────────────────────────────────────────────────────────────────────────
function viewFlowCard(snap, analysis) {
  const etf  = snap?.etfFlows;
  const sc   = snap?.stablecoins;
  const cvd  = snap?.cvd;
  const basis = snap?.basis;
  const mf   = snap?.multiFunding;
  const cg   = snap?.coinalyze;
  // v7 signals
  const sms  = snap?.smartMoneyScore;
  const bbl  = snap?.bybitLiquidations;
  const okxF = snap?.okxFlow;
  const fb   = snap?.futuresBasis;
  const fd   = snap?.fundingDivergence;
  const cp   = snap?.cascadeProbability;
  if (!etf && !sc && !cvd && !basis && !mf && !cg && !sms && !bbl && !okxF && !fb) return '';

  const num = (v, d = 2) => v == null ? '—' : Number(v).toFixed(d);

  // Helper: kartu kaya yang menjelaskan diri sendiri
  // bias: 'bull' | 'bear' | 'neutral' | 'warn'
  const richCard = ({ label, whatIs, value, bias, status, meaning, extra, star }) => {
    const c = bias === 'bull' ? { border: 'border-emerald-500/40', bg: 'bg-emerald-500/5', val: 'text-emerald-400', badge: 'text-emerald-400 bg-emerald-500/10' }
            : bias === 'bear' ? { border: 'border-red-500/40', bg: 'bg-red-500/5', val: 'text-red-400', badge: 'text-red-400 bg-red-500/10' }
            : bias === 'warn' ? { border: 'border-amber-500/40', bg: 'bg-amber-500/5', val: 'text-amber-400', badge: 'text-amber-400 bg-amber-500/10' }
            : { border: 'border-zinc-800', bg: 'bg-zinc-950/40', val: 'text-zinc-200', badge: 'text-zinc-400 bg-zinc-800/50' };
    return `<div class="border ${c.border} ${c.bg} p-4 flex flex-col">
      <div class="flex items-start justify-between gap-2 mb-1">
        <span class="text-[10px] uppercase tracking-wider text-zinc-400 font-medium">${star ? '⭐ ' : ''}${esc(label)}</span>
        <span class="text-[8px] uppercase tracking-wider px-1.5 py-0.5 rounded ${c.badge} whitespace-nowrap">${esc(status)}</span>
      </div>
      <div class="text-[10px] text-zinc-600 sans leading-snug mb-2">${esc(whatIs)}</div>
      <div class="text-xl tabular-nums ${c.val} mb-0.5">${value}</div>
      ${extra ? `<div class="text-[10px] text-zinc-500 tabular-nums mb-2">${extra}</div>` : '<div class="mb-2"></div>'}
      <div class="mt-auto pt-2 border-t border-zinc-800/50">
        <div class="text-[10px] text-zinc-400 sans leading-relaxed"><span class="text-zinc-600">Artinya: </span>${esc(meaning)}</div>
      </div>
    </div>`;
  };

  const cards = [];

  // ── v7: Smart Money Conviction Score (sinyal agregat — tampil pertama) ────
  if (sms) {
    const scoreDir = sms.score >= 60 ? 'bull' : sms.score <= 40 ? 'bear' : 'neutral';
    const scoreLabel = sms.score >= 70 ? 'VERY BULLISH' : sms.score >= 60 ? 'BULLISH' : sms.score <= 30 ? 'VERY BEARISH' : sms.score <= 40 ? 'BEARISH' : 'CONFLICTED';
    const meaning = sms.score >= 70 ? 'Mayoritas sinyal bandarmologi menunjukkan akumulasi smart money. Konteks paling bullish untuk entry LONG.'
      : sms.score >= 60 ? 'Lebih banyak sinyal bullish dari bearish. Support untuk posisi LONG dengan manajemen risiko.'
      : sms.score <= 30 ? 'Mayoritas sinyal menunjukkan distribusi/pelarian smart money. Kondisi paling bearish.'
      : sms.score <= 40 ? 'Sinyal bearish lebih dominan. Waspada untuk LONG, dukung SHORT atau wait.'
      : 'Sinyal bertentangan — smart money belum menunjukkan arah jelas. Tunggu konfirmasi sebelum entry.';
    cards.unshift(richCard({
      label: 'Smart Money Score', star: true,
      whatIs: 'Skor agregat 0–100 dari semua sinyal bandarmologi (CVD, L/S, ETF, OI, Bybit liq, OKX)',
      value: `${sms.score}/100`,
      extra: `arah ${sms.direction} · conviction ${sms.conviction} · bull ${sms.bullPts}pt vs bear ${sms.bearPts}pt`,
      bias: scoreDir,
      status: scoreLabel,
      meaning,
    }));
  }

  // ── v7: Cascade Probability ───────────────────────────────────────────────
  if (cp) {
    const riskBias = cp.riskLevel === 'HIGH' ? 'warn' : cp.riskLevel === 'MEDIUM' ? 'warn' : 'neutral';
    cards.push(richCard({
      label: 'Cascade Probability',
      whatIs: 'Estimasi risiko terjadinya liquidation cascade (longsor posisi leverage) saat ini',
      value: `${cp.probability}%`,
      extra: `risiko ${cp.riskLevel} · arah cascade: ${cp.likelyCascadeDirection}`,
      bias: riskBias,
      status: cp.riskLevel,
      meaning: cp.note,
    }));
  }

  // ── v7: Bybit Liquidations (real data) ───────────────────────────────────
  if (bbl) {
    const washout = bbl.washoutSignal !== 'NONE';
    const washBias = bbl.washoutSignal === 'LONG_WASHOUT' ? 'bull' : bbl.washoutSignal === 'SHORT_SQUEEZE' ? 'bull' : 'neutral';
    const washLabel = bbl.washoutSignal === 'LONG_WASHOUT' ? 'LONG WASHOUT' : bbl.washoutSignal === 'SHORT_SQUEEZE' ? 'SHORT SQUEEZE' : bbl.momentum.replace('_', ' ');
    cards.push(richCard({
      label: 'Bybit Liquidations (nyata)', star: bbl.washoutSignal !== 'NONE',
      whatIs: 'Data likuidasi posisi leverage yang BENAR-BENAR terjadi di Bybit (200 event terakhir)',
      value: `L:$${bbl.longLiqValueM?.toFixed(1) ?? 0}M vs S:$${bbl.shortLiqValueM?.toFixed(1) ?? 0}M`,
      extra: `${bbl.longLiqCount} long liq · ${bbl.shortLiqCount} short liq${bbl.recentBurst ? ' · ⚡ BURST 30m' : ''}`,
      bias: washout ? washBias : (bbl.momentum === 'LONGS_DOMINATED' ? 'neutral' : 'neutral'),
      status: washLabel,
      meaning: bbl.washoutSignal === 'LONG_WASHOUT'
        ? 'Banyak LONG baru saja terlikuidasi paksa (kapitulasi). Secara kontrarian ini sering menandai bottom — penjual paksa sudah habis, reversalnaik lebih mungkin.'
        : bbl.washoutSignal === 'SHORT_SQUEEZE'
        ? 'SHORT sedang dilikuidasi massal (short squeeze). Harga naik paksa karena short cover. Momentum naik kuat tapi hati-hati reversal setelah squeeze selesai.'
        : bbl.momentum === 'LONGS_DOMINATED'
        ? 'Lebih banyak long yang dilikuidasi — tekanan jual. Harga mungkin masih bisa turun lebih lanjut.'
        : 'Likuidasi seimbang — tidak ada sisi yang dominan dihukum. Pasar tidak dalam kondisi cascade.',
    }));
  }

  // ── v7: OKX Top Trader L/S ────────────────────────────────────────────────
  if (okxF) {
    const lBias = okxF.bias === 'LONG_DOMINANT' ? 'bull' : okxF.bias === 'SHORT_DOMINANT' ? 'bear' : 'neutral';
    cards.push(richCard({
      label: 'OKX Top Trader L/S',
      whatIs: 'Rasio posisi long/short dari top trader di OKX — konfirmasi independen dari Binance',
      value: num(okxF.longShortRatio, 3),
      extra: okxF.trend.replace(/_/g, ' ').toLowerCase() + ' · source: ' + okxF.source,
      bias: lBias,
      status: okxF.bias.replace('_', ' '),
      meaning: okxF.bias === 'LONG_DOMINANT'
        ? 'Smart money OKX lebih banyak long. Jika Binance L/S juga bullish → konfirmasi kuat untuk LONG.'
        : okxF.bias === 'SHORT_DOMINANT'
        ? 'Smart money OKX lebih banyak short. Konfirmasi bearish — terutama bila Binance juga short dominan.'
        : 'Posisi seimbang di OKX. Tidak ada bias kuat dari smart money exchange ini.',
    }));
  }

  // ── v7: Futures Basis Premium ─────────────────────────────────────────────
  if (fb) {
    const fbBias = fb.regime.includes('CONTANGO') ? (fb.basisPct > 0.03 ? 'warn' : 'neutral')
                 : fb.regime.includes('BACKWARDATION') ? 'bear' : 'neutral';
    cards.push(richCard({
      label: 'Futures Basis Premium',
      whatIs: 'Premium/discount harga perp mark vs index price — ukuran arah bias pasar futures',
      value: `${fb.basisPct >= 0 ? '+' : ''}${fb.basisPct.toFixed(4)}%`,
      extra: `≈${fb.annualizedPct.toFixed(0)}%/yr · ${fb.regime.replace(/_/g, ' ')}`,
      bias: fbBias,
      status: fb.regime.replace(/_/g, ' '),
      meaning: fb.regime.includes('CONTANGO_BULLISH')
        ? 'Perp premium tinggi — trader mau bayar lebih untuk long futures. Bullish bias tapi waspada crowding long.'
        : fb.regime.includes('BACKWARDATION')
        ? 'Futures discount vs index — kondisi langka, tanda kepanikan/hedging besar. Kontrarian bullish jangka pendek.'
        : 'Basis flat/sedikit premium — pasar belum terlalu bias satu arah. Tidak ada tekanan leverage ekstrem.',
    }));
  }

  // ── v7: Funding Divergence ────────────────────────────────────────────────
  if (fd) {
    const fdBias = fd.consensus === 'STRONG' ? 'neutral' : fd.consensus === 'WEAK' ? 'warn' : 'neutral';
    cards.push(richCard({
      label: 'Funding Divergence',
      whatIs: 'Seberapa kompak semua exchange soal arah funding — tinggi = manipulasi/arbitrase aktif',
      value: num(fd.score, 3),
      extra: `Binance ${fd.rates?.binance != null ? fd.rates.binance.toFixed(4) : '—'}% · Bybit ${fd.rates?.bybit != null ? fd.rates.bybit.toFixed(4) : '—'}% · OKX ${fd.rates?.okx != null ? fd.rates.okx.toFixed(4) : '—'}%`,
      bias: fdBias,
      status: `consensus ${fd.consensus}`,
      meaning: fd.interpretation,
    }));
  }

  // ETF flows
  if (etf) {
    const inflow = etf.netFlow24h >= 0;
    cards.push(richCard({
      label: 'ETF Net Flow 24h', star: true,
      whatIs: 'Duit institusi masuk/keluar lewat ETF spot Bitcoin (BlackRock, Fidelity, dll)',
      value: `${inflow ? '+' : '−'}$${Math.abs(etf.netFlow24h / 1e6).toFixed(1)}M`,
      bias: inflow ? 'bull' : 'bear',
      status: etf.signal,
      meaning: inflow
        ? 'Institusi sedang AKUMULASI Bitcoin. Ini sinyal beli paling kuat — duit besar masuk.'
        : 'Institusi sedang DISTRIBUSI (jual). Tekanan jual dari pemain besar, hati-hati.',
    }));
  }

  // Stablecoin dry powder
  if (sc) {
    const exp = sc.liquiditySignal === 'EXPANDING';
    const con = sc.liquiditySignal === 'CONTRACTING';
    cards.push(richCard({
      label: 'Stablecoin Supply',
      whatIs: 'Total USDT/USDC beredar = "amunisi" tunai yang siap dipakai beli crypto',
      value: `$${(sc.total / 1e9).toFixed(1)}B`,
      extra: `7d ${sc.change7d >= 0 ? '+' : ''}${sc.change7d != null ? sc.change7d.toFixed(2) : '—'}%`,
      bias: exp ? 'bull' : con ? 'bear' : 'neutral',
      status: sc.liquiditySignal,
      meaning: exp
        ? 'Amunisi beli BERTAMBAH — duit baru masuk ke crypto, mendukung kenaikan harga.'
        : con
        ? 'Amunisi beli BERKURANG — likuiditas keluar dari crypto, kurang bahan bakar untuk naik.'
        : 'Likuiditas stabil — tidak ada penambahan/pengurangan amunisi beli yang berarti.',
    }));
  }

  // CVD
  if (cvd) {
    const buy = cvd.deltaPct >= 0;
    const strong = Math.abs(cvd.deltaPct) > 10;
    cards.push(richCard({
      label: 'CVD · Order Flow',
      whatIs: 'Selisih agresor beli vs jual (market order) dari 1000 transaksi terakhir',
      value: `${buy ? '+' : ''}${cvd.deltaPct.toFixed(1)}%`,
      extra: `beli ${cvd.buyVol?.toFixed(0)} vs jual ${cvd.sellVol?.toFixed(0)} ${snap?.symbol || 'BTC'}`,
      bias: buy ? (strong ? 'bull' : 'neutral') : (strong ? 'bear' : 'neutral'),
      status: cvd.signal.replace('_', ' '),
      meaning: buy
        ? (strong ? 'Pembeli SANGAT agresif — mereka angkat harga dengan market buy. Demand riil kuat.'
                  : 'Pembeli sedikit lebih agresif dari penjual. Demand ada tapi belum dominan.')
        : (strong ? 'Penjual SANGAT agresif — mereka tekan harga dengan market sell. Distribusi kuat.'
                  : 'Penjual sedikit lebih agresif. Tekanan jual ringan, belum dominan.'),
    }));
  }

  // Basis
  if (basis) {
    const premium = basis.signal === 'PERP_PREMIUM';
    const discount = basis.signal === 'PERP_DISCOUNT';
    cards.push(richCard({
      label: 'Spot-Perp Basis',
      whatIs: 'Selisih harga futures (perp) vs spot. Menunjukkan posisi leverage trader',
      value: `${basis.basisPct >= 0 ? '+' : ''}${basis.basisPct.toFixed(3)}%`,
      extra: `perp $${basis.perp?.toFixed(0)} vs spot $${basis.spot?.toFixed(0)}`,
      bias: premium ? 'warn' : discount ? 'bull' : 'neutral',
      status: basis.signal.replace('_', ' '),
      meaning: premium
        ? 'Perp di ATAS spot — banyak long pakai leverage (crowded). Rawan "long squeeze" kalau harga turun sedikit.'
        : discount
        ? 'Perp di BAWAH spot — sentimen takut/hedging. Sering jadi titik reversal naik (kontrarian bullish).'
        : 'Perp ≈ spot. Leverage seimbang, tidak ada tekanan posisi yang ekstrem.',
    }));
  }

  // Coinalyze liquidation (data nyata, perlu free key)
  if (cg?.liqBias) {
    const rekt = cg.liqBias;
    cards.push(richCard({
      label: 'Liquidation 24h (Coinalyze)', star: true,
      whatIs: 'Posisi yang dipaksa tutup (liquidated) agregat lintas bursa dalam 24 jam',
      value: rekt.replace('_', ' '),
      extra: cg.longLiquidation != null ? `long $${(cg.longLiquidation / 1e6).toFixed(1)}M · short $${(cg.shortLiquidation / 1e6).toFixed(1)}M` : '',
      bias: rekt === 'LONGS_REKT' ? 'bull' : rekt === 'SHORTS_REKT' ? 'warn' : 'neutral',
      status: rekt === 'LONGS_REKT' ? 'longs dihukum' : rekt === 'SHORTS_REKT' ? 'shorts dihukum' : 'seimbang',
      meaning: rekt === 'LONGS_REKT'
        ? 'Banyak LONG kena likuidasi (kapitulasi). Sering menandai BOTTOM lokal — penjual paksa sudah habis.'
        : rekt === 'SHORTS_REKT'
        ? 'Banyak SHORT kena likuidasi (short squeeze). Sering menandai TOP lokal — bahan bakar naik mulai habis.'
        : 'Likuidasi seimbang antara long & short. Tidak ada sisi yang dominan dihukum.',
    }));
  }

  // Liquidation Magnet Levels (computed, no key — selalu ada)
  const lm = snap?.liqMagnets;
  if (lm) {
    const price = snap.ticker?.price;
    cards.push(richCard({
      label: 'Liquidation Magnet (estimasi)',
      whatIs: 'Level di mana posisi leverage akan terlikuidasi. Harga sering "diburu" ke zona ini',
      value: `↑ $${(lm.upMagnet.from / 1000).toFixed(1)}k–${(lm.upMagnet.to / 1000).toFixed(1)}k`,
      extra: `↓ $${(lm.downMagnet.from / 1000).toFixed(1)}k–${(lm.downMagnet.to / 1000).toFixed(1)}k · (25x–50x cluster)`,
      bias: 'neutral',
      status: 'magnet zone',
      meaning: `Di ATAS ada short liq (kalau tembus → squeeze naik), di BAWAH ada long liq (kalau tembus → cascade turun). Pakai sebagai target/area waspada. 25x long liq di $${lm.longLiqs[2].price.toLocaleString()}, 25x short liq di $${lm.shortLiqs[2].price.toLocaleString()}.`,
    }));
  }

  // Multi-funding
  if (mf && (mf.bybit != null || mf.okx != null)) {
    const rates = [mf.bybit, mf.okx].filter(x => x != null);
    const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;
    const high = avgRate > 0.01;
    const neg = avgRate < -0.005;
    cards.push(richCard({
      label: 'Funding Lintas Bursa',
      whatIs: 'Biaya tahan posisi leverage di Bybit & OKX. Positif = long bayar short',
      value: `${avgRate >= 0 ? '+' : ''}${avgRate.toFixed(4)}%`,
      extra: `${mf.bybit != null ? `Bybit ${mf.bybit.toFixed(4)}%` : ''}${mf.okx != null ? ` · OKX ${mf.okx.toFixed(4)}%` : ''}`,
      bias: high ? 'warn' : neg ? 'bull' : 'neutral',
      status: high ? 'long crowded' : neg ? 'short crowded' : 'normal',
      meaning: high
        ? 'Funding tinggi di semua bursa — long sangat ramai & bayar mahal. Rawan koreksi (mean reversion turun).'
        : neg
        ? 'Funding negatif — short yang ramai & bayar long. Bisa jadi setup short squeeze naik.'
        : 'Funding normal di semua bursa. Posisi leverage seimbang, tidak ada crowding ekstrem.',
    }));
  }

  // Status sumber yang tidak tersedia (transparansi)
  const missing = [];
  if (!etf) missing.push('ETF flow (perlu SoSoValue key gratis di Settings)');
  if (!cg) missing.push('Liquidation nyata (perlu Coinalyze key gratis)');

  return `<div class="col-span-12 border border-purple-500/40 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-2">
      <div>
        <span class="text-[10px] uppercase tracking-[0.15em] text-purple-300">Bandarmologi Dashboard · v8</span>
        <div class="text-xs text-zinc-500 sans mt-0.5">Smart Money Score + aliran duit institusi & posisi leverage lintas bursa</div>
      </div>
      <span class="text-[10px] text-zinc-600">${cards.length} indikator aktif</span>
    </div>

    <div class="text-[11px] text-zinc-500 sans mb-4 leading-relaxed border-l-2 border-purple-500/30 pl-3">
      <span class="text-zinc-300">Smart Money Score</span> merangkum semua sinyal bandarmologi menjadi angka 0–100. Di bawahnya: data likuidasi nyata (Bybit), taker flow (CVD Binance + OKX), ETF institusi, stablecoin dry powder, funding divergence, dan cascade probability. Hijau = bullish, merah = bearish, kuning = waspada/crowded.
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      ${cards.join('')}
    </div>

    ${missing.length ? `<div class="mt-3 text-[10px] text-zinc-700 sans">
      ℹ Belum aktif: ${esc(missing.join(', '))}${!cg ? ' — isi Coinalyze key (gratis) di Settings untuk angka likuidasi nyata lintas bursa' : ''}
    </div>` : ''}

    ${analysis?.flowView ? `<div class="mt-4 pt-4 border-t border-zinc-800/60">
      <div class="text-[10px] uppercase tracking-wider text-purple-400/80 mb-2">Kesimpulan AI atas Flow Institusi</div>
      <p class="text-xs text-zinc-300 sans leading-relaxed">${renderMd(analysis.flowView || '')}</p>
    </div>` : `<div class="mt-4 pt-4 border-t border-zinc-800/60 text-[11px] text-zinc-600 sans italic">
      Jalankan AI Analysis untuk dapat kesimpulan gabungan dari semua indikator flow di atas.
    </div>`}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  v8: Whale Positioning card — Regime Matrix + Cross-Venue + Squeeze Fuel +
//  Hyperliquid/Bitfinex/COT + premium Coinbase/Kimchi/CME gap + DVOL + NUPL
// ─────────────────────────────────────────────────────────────────────────────
function viewPositioningCard(snap) {
  const mr = snap?.marketRegime, cv = snap?.crossVenue, sq = snap?.squeezeFuel;
  const hl = snap?.hyperliquid, bfx = snap?.bitfinexMargin, cot = snap?.cftcCot;
  const dvol = snap?.dvol, cbp = snap?.coinbasePremium, kim = snap?.kimchiPremium;
  const cmeG = snap?.cmeGap, nupl = snap?.nupl, miner = snap?.minerPressure;
  if (!mr && !cv && !hl && !bfx && !cot && !dvol && !cbp) return '';

  const biasColor = (b) => b === 'LONG' || b === 'bull' ? 'text-emerald-400'
    : b === 'SHORT' || b === 'bear' ? 'text-red-400' : 'text-zinc-400';

  const row = (label, value, sub, color = 'text-zinc-200') => `
    <div class="border border-zinc-800 bg-zinc-950/40 p-3">
      <div class="text-[9px] uppercase tracking-wider text-zinc-500 mb-1">${esc(label)}</div>
      <div class="text-sm ${color} leading-snug">${value}</div>
      ${sub ? `<div class="text-[10px] text-zinc-500 sans mt-1 leading-snug">${sub}</div>` : ''}
    </div>`;

  const cells = [];

  if (mr) {
    const hsColor = mr.healthScore >= 70 ? 'text-emerald-400' : mr.healthScore <= 35 ? 'text-red-400' : 'text-amber-400';
    cells.push(row('Market Regime (Price×OI×Funding)',
      `<span class="${hsColor}">${esc(mr.label.replace(/_/g, ' '))}</span> · health ${mr.healthScore}/100`,
      esc(mr.note)));
  }
  if (cv) {
    const va = cv.venueAgreement;
    const venueRows = cv.rows.map(r =>
      `<span class="text-zinc-500">${esc(r.venue)}:</span> <span class="${biasColor(r.bias)}">${esc(r.bias)}</span>`
    ).join(' · ');
    cells.push(row('Cross-Venue Agreement',
      `<span class="${biasColor(cv.dominant)}">${esc(va.verdict)}</span> · confluence ${esc(cv.confluence)}`,
      venueRows));
  }
  if (sq && sq.direction !== 'NONE') {
    cells.push(row('Squeeze Fuel',
      `<span class="${sq.direction === 'SHORT_SQUEEZE' ? 'text-emerald-400' : 'text-red-400'}">${esc(sq.direction.replace('_', ' '))}</span> · ${sq.score}/100`,
      esc(sq.direction === 'SHORT_SQUEEZE' ? 'Bahan squeeze NAIK menumpuk — jangan short sembarangan' : 'Bahan squeeze TURUN menumpuk — jangan long agresif')));
  }
  if (hl) {
    cells.push(row('Hyperliquid (whale DEX)',
      `funding 8h-eq <span class="${hl.funding8hPct >= 0 ? 'text-emerald-400' : 'text-red-400'}">${hl.funding8hPct >= 0 ? '+' : ''}${hl.funding8hPct}%</span>${hl.divergenceSignal ? ` · ${esc(hl.divergenceSignal.replace(/_/g, ' '))}` : ''}`,
      `vs CEX avg ${hl.cexFundingAvg != null ? hl.cexFundingAvg + '%' : '—'} · OI ${hl.openInterestUsd ? '$' + (hl.openInterestUsd / 1e9).toFixed(2) + 'B' : '—'}`));
  }
  if (bfx) {
    cells.push(row('Bitfinex Margin (whale legacy)',
      `<span class="${biasColor(bfx.signal === 'WHALE_LONG_BUILDUP' ? 'LONG' : bfx.signal === 'SHORT_BUILDUP' ? 'SHORT' : '')}">${esc(bfx.signal.replace(/_/g, ' '))}</span>`,
      `long ${Math.round(bfx.longBtc).toLocaleString()} BTC (Δ24h ${bfx.longDelta24hPct ?? '—'}%) · short ${Math.round(bfx.shortBtc).toLocaleString()} BTC (Δ24h ${bfx.shortDelta24hPct ?? '—'}%)`));
  }
  if (cot) {
    cells.push(row(`CFTC COT · CME (mingguan, ${esc(cot.reportDate || '—')})`,
      `<span class="${biasColor(cot.amSignal === 'INSTITUSI_AKUMULASI' ? 'LONG' : cot.amSignal === 'INSTITUSI_DISTRIBUSI' ? 'SHORT' : '')}">${esc(cot.amSignal.replace(/_/g, ' '))}</span>`,
      `asset mgr net ${cot.assetManagers.net} (ΔWoW ${cot.assetManagers.netDeltaWoW ?? '—'}) · hedge funds net ${cot.leveragedFunds.net} (ΔWoW ${cot.leveragedFunds.netDeltaWoW ?? '—'})`));
  }
  if (cbp) {
    cells.push(row('Coinbase Premium (US)',
      `<span class="${cbp.signal === 'US_BUYING' ? 'text-emerald-400' : cbp.signal === 'US_SELLING' ? 'text-red-400' : 'text-zinc-300'}">${cbp.premiumPct >= 0 ? '+' : ''}${cbp.premiumPct}%</span> · ${esc(cbp.signal.replace('_', ' '))}`,
      'Premium positif persisten = tekanan beli institusi/ETF US'));
  }
  if (kim) {
    cells.push(row('Kimchi Premium (Asia)',
      `<span class="${kim.signal === 'ASIA_EUPHORIA' ? 'text-amber-400' : kim.signal === 'ASIA_FEAR' ? 'text-blue-400' : 'text-zinc-300'}">${kim.premiumPct >= 0 ? '+' : ''}${kim.premiumPct}%</span> · ${esc(kim.signal.replace('_', ' '))}`,
      '>3% = euforia retail Asia (sering dekat top) · negatif = takut (dekat bottom)'));
  }
  if (cmeG?.level) {
    cells.push(row('CME Gap (magnet)',
      `$${cmeG.level.toLocaleString()} <span class="text-zinc-500">(${cmeG.direction === 'BELOW_PRICE' ? 'di bawah harga' : 'di atas harga'})</span>`,
      `gap ${cmeG.gapPct}% · umur ${cmeG.ageDays} hari · sangat sering di-fill`));
  }
  if (dvol) {
    cells.push(row('DVOL · Implied Volatility',
      `${dvol.current} <span class="text-zinc-500">(${dvol.positionPct}% dari range 7d)</span> · <span class="${dvol.signal === 'VOL_SPIKE' ? 'text-amber-400' : dvol.signal === 'VOL_COMPRESSED' ? 'text-blue-400' : 'text-zinc-300'}">${esc(dvol.signal.replace(/_/g, ' '))}</span>`,
      dvol.signal === 'VOL_COMPRESSED' ? 'Kompresi vol — breakout besar menunggu' : dvol.signal === 'VOL_SPIKE' ? 'Vol spike/panik — sering dekat bottom lokal' : 'Volatilitas normal'));
  }
  if (nupl) {
    cells.push(row(`NUPL on-chain${nupl.cached ? ' (cache)' : ''}`,
      `${nupl.nupl} · <span class="${nupl.signal === 'EUPHORIA' ? 'text-red-400' : nupl.signal === 'CAPITULATION' ? 'text-emerald-400' : 'text-zinc-300'}">${esc(nupl.signal.replace(/_/g, ' '))}</span>`,
      '>0.75 euphoria (distribusi) · <0 capitulation (akumulasi)'));
  }
  if (miner) {
    cells.push(row('Miner Pressure',
      `<span class="${miner.signal === 'MINER_STRESS' ? 'text-red-400' : 'text-zinc-300'}">${esc(miner.signal.replace(/_/g, ' '))}</span>`,
      `hashrate ${miner.hashFromPeak30dPct}% dari peak 30d · revenue ${miner.revFromPeak30dPct ?? '—'}%`));
  }

  return `<div class="col-span-12 border border-cyan-500/40 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-2">
      <div>
        <span class="text-[10px] uppercase tracking-[0.15em] text-cyan-300">Whale Positioning · v8</span>
        <div class="text-xs text-zinc-500 sans mt-0.5">Regime matrix, cross-venue confluence, dan posisi uang besar (CME · Hyperliquid · Bitfinex · premium US/Asia)</div>
      </div>
      <span class="text-[10px] text-zinc-600">${cells.length} sinyal aktif</span>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">${cells.join('')}</div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  v8: Source Health panel — endpoint mati harus KETAHUAN, tidak senyap
//  (pelajaran kasus ETF DefiLlama yang dead-code tanpa ada yang sadar)
// ─────────────────────────────────────────────────────────────────────────────
function viewSourceHealth(snap) {
  const health = snap?.sourceHealth;
  if (!Array.isArray(health) || !health.length) return '';
  const ok = health.filter(h => h.ok);
  const needKey = health.filter(h => !h.ok && h.needsKey);
  const dead = health.filter(h => !h.ok && !h.needsKey);
  const chip = (h, color) =>
    `<span class="inline-block px-1.5 py-0.5 border ${color} text-[9px] tracking-wide">${esc(h.source)}</span>`;
  return `<details class="mb-4 border border-zinc-800/60 bg-zinc-950/50">
    <summary class="cursor-pointer px-4 py-2 text-[10px] uppercase tracking-[0.15em] text-zinc-500 hover:text-zinc-300 select-none">
      Source Health — ${ok.length}/${health.length} hidup${dead.length ? ` · <span class="text-red-400">${dead.length} mati</span>` : ''}${needKey.length ? ` · ${needKey.length} butuh key` : ''}
    </summary>
    <div class="px-4 pb-3 space-y-2">
      <div class="flex flex-wrap gap-1">${ok.map(h => chip(h, 'border-emerald-500/30 text-emerald-400/80')).join('')}</div>
      ${dead.length ? `<div class="flex flex-wrap gap-1 items-center"><span class="text-[9px] text-red-400/80 uppercase mr-1">null/mati:</span>${dead.map(h => chip(h, 'border-red-500/40 text-red-400')).join('')}</div>` : ''}
      ${needKey.length ? `<div class="flex flex-wrap gap-1 items-center"><button onclick="window._app.openSettingsDataKeys()" class="text-[9px] text-blue-400/80 hover:text-blue-300 uppercase tracking-wider mr-1 underline underline-offset-2">butuh free key → Settings</button>${needKey.map(h => chip(h, 'border-zinc-700 text-zinc-500')).join('')}</div>` : ''}
      <div class="text-[10px] text-zinc-600 sans">Sumber yang terus-menerus "mati" berarti endpoint berubah/diblokir — laporkan/perbaiki, jangan dibiarkan senyap.</div>
    </div>
  </details>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  v4: Cycle Stage chip (shown inside trade action hero header)
// ─────────────────────────────────────────────────────────────────────────────
function viewCycleStageBadge(analysis) {
  if (!analysis?.cycleStage) return '';
  const stages = {
    ACCUMULATION:  { color: 'text-emerald-300', bg: 'bg-emerald-500/15', border: 'border-emerald-500/40', label: 'ACCUMULATION' },
    MARKUP:        { color: 'text-emerald-200', bg: 'bg-emerald-500/25', border: 'border-emerald-500/50', label: 'MARKUP' },
    DISTRIBUTION:  { color: 'text-orange-300',  bg: 'bg-orange-500/15',  border: 'border-orange-500/40',  label: 'DISTRIBUTION' },
    MARKDOWN:      { color: 'text-red-300',     bg: 'bg-red-500/15',     border: 'border-red-500/40',     label: 'MARKDOWN' },
    UNCLEAR:       { color: 'text-zinc-400',    bg: 'bg-zinc-800/40',    border: 'border-zinc-700',       label: 'UNCLEAR PHASE' },
  };
  const s = stages[analysis.cycleStage] || stages.UNCLEAR;
  return `<div class="border ${s.border} ${s.bg} px-3 py-2">
    <div class="text-[9px] uppercase tracking-[0.15em] text-zinc-500 mb-0.5">Cycle Stage</div>
    <div class="text-sm ${s.color}">${s.label}</div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  v5: Debate Transcript card (Bull vs Bear vs Judge)
// ─────────────────────────────────────────────────────────────────────────────
function viewDebateCard(analysis) {
  const d = analysis?.debate;
  if (!d) return '';
  const judge = d.judge || {};

  const leanCfg = judge.lean === 'BULLISH' ? { color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/40' }
                : judge.lean === 'BEARISH' ? { color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/40' }
                :                            { color: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/40' };
  const conviction = judge.conviction != null ? Math.round(judge.conviction) : null;

  return `<div class="col-span-12 border border-purple-500/30 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-4">
      <div>
        <span class="text-[10px] uppercase tracking-[0.15em] text-purple-300">Agent Council Debate · v5</span>
        <div class="text-xs text-zinc-500 sans mt-0.5">Bull vs Bear → Research Manager verdict</div>
      </div>
      <span class="text-[10px] text-zinc-600">multi-agent reasoning</span>
    </div>

    <!-- Bull & Bear cards — full text, no clamp, dengan collapse toggle -->
    <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4 items-start">
      <!-- Bull case -->
      <div class="border border-emerald-500/30 bg-emerald-500/[0.04] p-4">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <span class="text-emerald-400 text-sm">▲</span>
            <span class="text-[10px] uppercase tracking-wider text-emerald-400 font-medium">Bull Researcher</span>
          </div>
          <button onclick="window._app.toggleDebate(this)" data-target="bull-body-${Date.now()}"
            class="text-[10px] text-zinc-500 hover:text-zinc-300 uppercase tracking-wider sans transition-colors px-2 py-0.5 border border-zinc-800 hover:border-zinc-600">
            ▲ collapse
          </button>
        </div>
        <div id="debate-bull-body" class="text-xs text-zinc-300 sans leading-relaxed">${renderMd(d.bullCase || '—')}</div>
      </div>
      <!-- Bear case -->
      <div class="border border-red-500/30 bg-red-500/[0.04] p-4">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-2">
            <span class="text-red-400 text-sm">▼</span>
            <span class="text-[10px] uppercase tracking-wider text-red-400 font-medium">Bear Researcher</span>
          </div>
          <button onclick="window._app.toggleDebate(this)" data-target="bear-body-${Date.now()}"
            class="text-[10px] text-zinc-500 hover:text-zinc-300 uppercase tracking-wider sans transition-colors px-2 py-0.5 border border-zinc-800 hover:border-zinc-600">
            ▲ collapse
          </button>
        </div>
        <div id="debate-bear-body" class="text-xs text-zinc-300 sans leading-relaxed">${renderMd(d.bearCase || '—')}</div>
      </div>
    </div>

    <!-- Judge verdict -->
    <div class="border ${leanCfg.border} ${leanCfg.bg} p-4">
      <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div class="flex items-center gap-2">
          <span class="${leanCfg.color} text-sm">⚖</span>
          <span class="text-[10px] uppercase tracking-wider ${leanCfg.color} font-medium">Research Manager verdict</span>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-sm ${leanCfg.color} font-medium">${esc(judge.lean || '—')}</span>
          ${conviction != null ? `<div class="flex items-center gap-1.5">
            <div class="w-16 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div class="h-full ${leanCfg.color.replace('text-', 'bg-')}" style="width: ${conviction}%"></div>
            </div>
            <span class="text-[10px] text-zinc-400 tabular-nums">${conviction}%</span>
          </div>` : ''}
        </div>
      </div>
      <div class="text-xs text-zinc-300 sans leading-relaxed mb-3">${renderMd(judge.summary || '')}</div>
      ${(judge.decidingFactors && judge.decidingFactors.length) ? `<div class="mt-2 pt-3 border-t border-zinc-800/60">
        <div class="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Faktor penentu</div>
        <ul class="space-y-1.5">
          ${judge.decidingFactors.slice(0, 3).map(f => `<li class="text-[11px] text-zinc-300 sans leading-relaxed"><span class="${leanCfg.color} mr-1.5 font-medium">→</span>${renderMd(f)}</li>`).join('')}
        </ul>
      </div>` : ''}
      ${judge.invalidation ? `<div class="mt-3 pt-3 border-t border-zinc-800/60 text-[11px] text-zinc-400 sans leading-relaxed">
        <span class="text-amber-400 uppercase tracking-wider text-[9px] font-medium mr-2">Invalidation</span>${renderMd(judge.invalidation)}
      </div>` : ''}
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Call-to-action when no AI analysis yet
// ─────────────────────────────────────────────────────────────────────────────
function viewAICTA() {
  if (!state.apiKey) {
    return `<div class="border-2 border-dashed border-blue-500/40 bg-blue-500/[0.05] p-6 mb-3 text-center">
      <div class="text-blue-400 text-4xl mb-3">🔑</div>
      <div class="serif text-2xl text-zinc-100 mb-2">Setup <span class="italic text-blue-400">Gemini API Key</span> dulu</div>
      <div class="text-sm text-zinc-400 sans mb-4 max-w-xl mx-auto">
        Masukkan API key Google Gemini kamu. Disimpan di browser, dipakai per-request langsung ke Google API. Free tier sudah cukup buat puluhan analisis/hari.
      </div>
      <button onclick="window._app.toggleSettings()"
        class="bg-blue-500 hover:bg-blue-400 text-black px-5 py-2.5 text-[10px] uppercase tracking-[0.15em] font-medium transition-colors">
        ⚙ Configure API Key
      </button>
    </div>`;
  }
  const m = GEMINI_MODELS.find(x => x.id === state.model) || GEMINI_MODELS[0];
  return `<div class="border-2 border-dashed border-blue-500/30 bg-blue-500/[0.03] p-6 mb-3 text-center">
    <div class="text-blue-400 text-4xl mb-3">✦</div>
    <div class="text-sm text-zinc-300 sans mb-2">
      Tekan <span class="text-blue-400 font-medium">"Generate AI Analysis"</span> untuk dapat trade action plan
    </div>
    <div class="flex items-center justify-center gap-3 text-[11px] text-zinc-500 sans mt-2 flex-wrap">
      <span>🅖 ${esc(m.label)}</span>
      <span class="text-zinc-700">·</span>
      <span class="text-zinc-400">${esc(m.latency)}</span>
      <span class="text-zinc-700">·</span>
      <span>${esc(m.cost)}</span>
      ${state.grounding ? `<span class="text-zinc-700">·</span><span class="text-emerald-400">🌐 Web grounding ON</span>` : ''}
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Analyzing progress bar (saat AI berjalan)
// ─────────────────────────────────────────────────────────────────────────────
function viewAnalyzingProgress() {
  if (!state.analyzing) return '';
  const m = GEMINI_MODELS.find(x => x.id === state.model) || GEMINI_MODELS[0];

  // Quick mode → simple bar
  if (state.analysisMode !== 'council') {
    return `<div class="border-2 border-blue-500/40 bg-blue-500/5 p-6 mb-3">
      <div class="flex items-center justify-between mb-3">
        <div class="flex items-center gap-3">
          <div class="spin text-blue-400 text-xl">⟳</div>
          <div>
            <div class="text-sm text-blue-300 uppercase tracking-[0.15em]">Analyzing with ${esc(m.label)}</div>
            <div class="text-xs text-zinc-500 sans mt-1">Quick mode · estimasi ${esc(m.latency)}</div>
          </div>
        </div>
        <button onclick="window._app.cancelAnalysis()"
          class="text-[10px] uppercase tracking-wider text-zinc-400 hover:text-red-400 border border-zinc-700 hover:border-red-500/50 px-3 py-1.5 transition-colors">Cancel</button>
      </div>
      <div class="h-1 bg-zinc-900 overflow-hidden">
        <div class="h-full bg-gradient-to-r from-blue-500 to-purple-500 progress-bar"></div>
      </div>
    </div>`;
  }

  // Council mode → multi-phase stepper
  const phase = state.councilPhase;
  const isPro = state.model.includes('pro');
  const steps = isPro
    ? [
        { id: 'debate',      icon: '▲', label: 'Bull Researcher',    sub: 'membangun kasus LONG' },
        { id: 'debate_bear', icon: '▼', label: 'Bear Researcher',    sub: 'membangun kasus SHORT' },
        { id: 'judge',       icon: '⚖', label: 'Research Manager',   sub: 'menimbang bukti' },
        { id: 'final',       icon: '🎯', label: 'Portfolio Manager', sub: 'keputusan final' },
      ]
    : [
        { id: 'debate', icon: '⚔', label: 'Bull vs Bear Debate', sub: '2 agent paralel' },
        { id: 'judge',  icon: '⚖', label: 'Research Manager',    sub: 'menimbang bukti' },
        { id: 'final',  icon: '🎯', label: 'Portfolio Manager',  sub: 'keputusan final' },
      ];
  const order = steps.map(s => s.id);
  const curIdx = order.indexOf(phase);

  const stepHtml = steps.map((st, i) => {
    const done = curIdx > i;
    const active = curIdx === i;
    const color = done ? 'text-emerald-400' : active ? 'text-purple-300' : 'text-zinc-600';
    const dotBg = done ? 'bg-emerald-500' : active ? 'bg-purple-400 pulse-dot' : 'bg-zinc-700';
    return `<div class="flex items-center gap-3 ${active ? '' : 'opacity-' + (done ? '80' : '40')}">
      <div class="w-7 h-7 rounded-full ${dotBg} flex items-center justify-center text-sm flex-shrink-0">
        ${done ? '<span class="text-black">✓</span>' : `<span class="${active ? 'spin' : ''}">${active ? '⟳' : st.icon}</span>`}
      </div>
      <div class="flex-1">
        <div class="text-sm ${color}">${esc(st.label)}</div>
        <div class="text-[10px] text-zinc-500 sans">${esc(st.sub)}</div>
      </div>
      ${active ? '<span class="text-[10px] text-purple-400 uppercase tracking-wider">running</span>' : done ? '<span class="text-[10px] text-emerald-400 uppercase tracking-wider">done</span>' : ''}
    </div>`;
  }).join('<div class="ml-3.5 h-3 border-l border-zinc-800"></div>');

  return `<div class="border-2 border-purple-500/40 bg-purple-500/5 p-6 mb-3">
    <div class="flex items-center justify-between mb-4">
      <div class="flex items-center gap-3">
        <div class="text-purple-400 text-xl">⚖</div>
        <div>
          <div class="text-sm text-purple-300 uppercase tracking-[0.15em]">Agent Council in session</div>
          <div class="text-xs text-zinc-500 sans mt-1">${esc(m.label)} · 4 agent · estimasi ${m.id === 'gemini-2.5-pro' ? '60-90s' : '30-50s'}</div>
        </div>
      </div>
      <button onclick="window._app.cancelAnalysis()"
        class="text-[10px] uppercase tracking-wider text-zinc-400 hover:text-red-400 border border-zinc-700 hover:border-red-500/50 px-3 py-1.5 transition-colors">Cancel</button>
    </div>
    <div class="space-y-0">${stepHtml}</div>
  </div>`;
}

// =============================================================================
//  MAIN RENDER
// =============================================================================
function render() {
  // ── Capture in-flight input value SEBELUM innerHTML hancurkan DOM ─────────
  // Ini fix utk bug: user ngetik di input → klik Test/Show → render() jalan →
  // input field di-recreate dengan value kosong (karena state.apiKey belum
  // di-save). Akhirnya saat klik Save, value-nya hilang.
  const liveKeyInput = document.getElementById('api-key-input');
  if (liveKeyInput && state.showSettings) {
    state.keyDraft = liveKeyInput.value;
  }

  const { snapshot, analysis, loading, analyzing, error, analyzeError, analyzeHint, lastFetch, lastAnalyze } = state;
  const dotClass = loading || analyzing
    ? 'bg-blue-400 pulse-dot'
    : snapshot ? 'bg-emerald-500' : 'bg-zinc-600';
  const statusText = loading ? 'Fetching live data'
    : analyzing ? 'Gemini analyzing'
    : snapshot ? 'Live tick · multi-source'
    : 'Idle';
  const hasKey = !!state.apiKey;

  let body = '';

  if (loading && !snapshot) {
    body = `<div class="border border-blue-500/30 bg-blue-500/5 p-12 mb-6 text-center">
      <div class="flex items-center justify-center gap-3 mb-4">
        <span class="text-blue-400 text-lg">🔍</span>
        <span class="text-sm text-blue-300 uppercase tracking-[0.15em]">Fetching live snapshot</span>
      </div>
      <div class="text-sm text-zinc-400 sans">Mengambil tick dari Binance, Bybit, OKX, Hyperliquid, Bitfinex, CME/CFTC, Deribit, Coinbase, Upbit, mempool.space, alternative.me...</div>
      <div class="h-1 bg-zinc-900 max-w-md mx-auto overflow-hidden mt-6">
        <div class="h-full shimmer"></div>
      </div>
    </div>`;
  } else if (error) {
    body = `<div class="border border-red-500/40 bg-red-500/5 p-6 mb-6">
      <div class="text-sm font-medium text-red-400 mb-1">⚠ Gagal fetch snapshot</div>
      <div class="text-xs text-red-400/70 break-all">${esc(error)}</div>
      <button onclick="window._app.loadSnapshot()"
        class="mt-3 text-xs text-blue-400 hover:text-blue-300 uppercase tracking-wider">→ Coba lagi</button>
    </div>`;
  } else if (snapshot) {
    const t = snapshot.ticker;
    const cg = snapshot.coingecko;
    const fund = snapshot.funding;
    const net = snapshot.network;
    const mp = snapshot.mempool;

    body = `
      ${analyzing ? viewAnalyzingProgress() : (analysis ? viewTradeActionHero(analysis, t?.price) : viewAICTA())}

      ${(!analyzing && analysis?.debate) ? `<div class="grid grid-cols-12 gap-3 mb-3"><div class="col-span-12">${viewDebateCard(analysis)}</div></div>` : ''}

      <div class="grid grid-cols-12 gap-3 mb-3">
        ${viewPriceCard(snapshot)}
        ${viewWhaleWalls(snapshot)}
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        ${viewMetric('Market Cap',
          cg?.marketCap ? '$' + (cg.marketCap / 1e12).toFixed(3) + 'T' : '—',
          t?.volume24h ? '24h vol $' + (t.volume24h / 1e9).toFixed(1) + 'B' : '',
          'text-blue-400')}
        ${viewMetric('Funding Rate',
          fund?.fundingRate != null ? fund.fundingRate.toFixed(4) + '%' : '—',
          fund?.fundingRate >= 0 ? 'Longs pay shorts 🔥' : 'Shorts pay longs ❄',
          fund?.fundingRate < 0 ? 'text-blue-400' : 'text-orange-400')}
        ${snapshot.symbol === 'BTC' || !snapshot.symbol ? `${viewMetric('Hashrate',
          net?.hashrate ? (net.hashrate / 1e9).toFixed(2) + ' EH/s' : '—',
          net?.blockHeight ? 'Block #' + net.blockHeight.toLocaleString() : '',
          'text-purple-400')}
        ${viewMetric('Mempool Fee',
          mp?.fastestFee ? mp.fastestFee + ' sat/vB' : '—',
          mp?.economyFee ? 'Eco: ' + mp.economyFee + ' sat/vB' : '',
          'text-cyan-400')}` : `${viewMetric('Dominance',
          snapshot.global?.coinDominance != null ? snapshot.global.coinDominance.toFixed(2) + '%' : '—',
          snapshot.global?.btcDominance != null ? 'BTC: ' + snapshot.global.btcDominance.toFixed(1) + '%' : '',
          'text-purple-400')}
        ${viewMetric('Open Interest',
          snapshot.openInterest?.current ? '$' + (snapshot.openInterest.current / 1e9).toFixed(2) + 'B' : '—',
          snapshot.openInterest?.change24h != null ? (snapshot.openInterest.change24h >= 0 ? '+' : '') + snapshot.openInterest.change24h.toFixed(1) + '% 24h' : '',
          'text-cyan-400')}`}
      </div>

      <!-- v3: Derivatives Intelligence -->
      <div class="grid grid-cols-12 gap-3 mb-3">
        ${viewDerivativesCard(snapshot, analysis)}
      </div>

      <!-- v6: Institutional & Cross-Exchange Flow -->
      <div class="grid grid-cols-12 gap-3 mb-3">
        ${viewFlowCard(snapshot, analysis)}
      </div>

      <!-- v8: Whale Positioning (regime, cross-venue, COT, Hyperliquid, premium) -->
      <div class="grid grid-cols-12 gap-3 mb-3">
        ${viewPositioningCard(snapshot)}
      </div>

      <!-- v3: Technical Analysis multi-TF -->
      <div class="grid grid-cols-12 gap-3 mb-3">
        ${viewTechnicalCard(snapshot, analysis)}
      </div>

      <!-- v4: Options Flow + On-Chain Cycle (side by side) -->
      <div class="grid grid-cols-12 gap-3 mb-3">
        ${viewOptionsCard(snapshot, analysis)}
        ${viewOnChainCard(snapshot, analysis)}
        ${viewOnChainExtCard(snapshot)}
      </div>

      <!-- v4: Macro Context (full width) -->
      <div class="grid grid-cols-12 gap-3 mb-3">
        ${viewMacroCard(snapshot, analysis)}
      </div>

      <div class="grid grid-cols-12 gap-3 mb-3">
        ${viewFearGreed(snapshot)}
        ${analysis ? viewSignal(analysis) : `<div class="col-span-12 md:col-span-8 border border-zinc-800 bg-zinc-950 p-5 flex items-center justify-center text-sm text-zinc-500 sans italic">
          ${hasKey ? 'Tekan "Generate AI Analysis" untuk dapat sinyal bandarmologi' : 'Setup API Key dulu untuk akses AI bandarmologi'}
        </div>`}
      </div>

      ${analysis ? `<div class="grid grid-cols-12 gap-3 mb-3">${viewWhaleNews(analysis)}</div>` : ''}

      ${analyzeError ? `<div class="border border-red-500/40 bg-red-500/5 p-4 mb-6">
        <div class="text-xs text-red-400 mb-1">⚠ AI analysis gagal: ${esc(analyzeError)}</div>
        ${analyzeHint ? `<div class="text-[11px] text-red-400/70 sans mt-1">${esc(analyzeHint)}</div>` : ''}
        <div class="mt-2 flex gap-3">
          <button onclick="window._app.loadAnalysis()" class="text-xs text-blue-400 hover:text-blue-300 uppercase tracking-wider">Retry</button>
          <button onclick="window._app.toggleSettings()" class="text-xs text-zinc-400 hover:text-zinc-200 uppercase tracking-wider">Edit Settings</button>
        </div>
      </div>` : ''}

      ${analysis?.riskWarning ? `<div class="border border-zinc-800 bg-zinc-950 p-4 mb-6">
        <span class="text-amber-400 uppercase tracking-wider text-[10px] mr-2">⚠ Risk</span>
        <span class="text-xs text-zinc-400 sans italic">${esc(analysis.riskWarning)}</span>
      </div>` : ''}

      ${snapshot.errors?.length ? `<div class="text-[10px] text-red-400/70 sans mb-2">
        ⚠ ${snapshot.errors.length} sumber inti gagal: ${esc(snapshot.errors.map(e => e.source).join(', '))} — coba Refresh tick
      </div>` : ''}

      ${snapshot.degraded?.length ? `<div class="text-[10px] text-zinc-700 sans mb-4">
        ℹ ${snapshot.degraded.length} sumber opsional tidak tersedia (${esc(snapshot.degraded.map(e => e.source).join(', '))}) — data inti tetap lengkap, tidak memengaruhi analisis
      </div>` : ''}

      ${viewSourceHealth(snapshot)}

      <footer class="border-t border-zinc-800 pt-4 flex items-center justify-between text-[10px] text-zinc-600 sans gap-4 flex-wrap">
        <div>Data inti: Binance · positioning: CME COT, Hyperliquid, Bitfinex, OKX, Bybit, Coinbase, Upbit, Deribit · makro: Yahoo/FRED · on-chain: CoinMetrics, bitcoin-data</div>
        <div>Bukan saran finansial · DYOR</div>
      </footer>
    `;
  }

  document.getElementById('app').innerHTML = `
    <header class="flex flex-col md:flex-row md:items-end md:justify-between gap-4 border-b border-zinc-800 pb-5 mb-6">
      <div>
        <div class="flex items-center gap-2 mb-1">
          <div class="w-2 h-2 rounded-full ${dotClass}"></div>
          <span class="text-[10px] uppercase tracking-[0.2em] text-zinc-500">${esc(statusText)}</span>
        </div>
        <h1 class="serif text-5xl text-zinc-100 leading-none">${esc(COIN_NAMES[state.symbol] || state.symbol)} <span class="italic text-blue-400">Intelligence</span></h1>
        <p class="text-xs text-zinc-500 mt-2 sans">Live tick · AI bandarmologi · Google Gemini direct</p>
      </div>
      <div class="flex flex-col gap-2 items-start md:items-end">
        <div class="flex items-center gap-2 flex-wrap">
          <div class="flex border border-zinc-700 overflow-hidden">
            ${COIN_LIST.map(c => `<button onclick="window._app.setSymbol('${c}')"
              class="px-2.5 py-1.5 text-[10px] uppercase tracking-[0.1em] transition-colors ${state.symbol === c
                ? 'bg-blue-500 text-black font-semibold'
                : 'text-zinc-400 hover:text-blue-300 hover:bg-zinc-900'}">${c}</button>`).join('')}
          </div>
          ${viewApiKeyBadge()}
          <button onclick="window._app.loadSnapshot()" ${loading ? 'disabled' : ''}
            class="px-3 py-1.5 border border-zinc-700 hover:border-blue-500/50 hover:text-blue-300 text-[10px] uppercase tracking-[0.15em] text-zinc-400 transition-colors disabled:opacity-50 flex items-center gap-2">
            <span class="${loading ? 'spin' : ''}">↻</span>
            ${loading ? 'Loading...' : 'Refresh tick'}
          </button>
          <button onclick="window._app.loadAnalysis()" ${(!snapshot || analyzing) ? 'disabled' : ''}
            class="px-3 py-1.5 ${state.analysisMode === 'council' ? 'bg-purple-500 hover:bg-purple-400' : 'bg-blue-500 hover:bg-blue-400'} text-black text-[10px] uppercase tracking-[0.15em] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
            ${state.analysisMode === 'council' ? '⚖' : '✦'} ${analyzing ? 'Analyzing...' : analysis ? 'Re-analyze' : (state.analysisMode === 'council' ? 'Run Council' : 'Generate Analysis')}
          </button>
        </div>
        <div class="text-[10px] text-zinc-600 tabular-nums">
          ${state.analysisMode === 'council' ? '⚖ council' : '⚡ quick'}${lastFetch ? ` · tick ${esc(fmt.ago(lastFetch))}` : ''}${lastAnalyze ? ` · AI ${esc(fmt.ago(lastAnalyze))}` : ''}
        </div>
      </div>
    </header>

    ${viewSettings()}
    ${body}
  `;
}

// =============================================================================
//  BOOT
// =============================================================================
function toggleDebate(btn) {
  // Temukan body div saudara terdekat setelah parent div header
  const card = btn.closest('.border');
  if (!card) return;
  // Body adalah div terakhir di card (setelah header flex div)
  const body = card.querySelector('[id^="debate-bull-body"], [id^="debate-bear-body"]');
  if (!body) return;
  const isCollapsed = body.style.display === 'none';
  body.style.display = isCollapsed ? '' : 'none';
  btn.textContent = isCollapsed ? '▲ collapse' : '▼ expand';
  btn.classList.toggle('text-blue-400', !isCollapsed);
  btn.classList.toggle('text-zinc-500', isCollapsed);
}

window._app = {
  loadSnapshot,
  loadAnalysis,
  cancelAnalysis,
  toggleSettings,
  openSettingsDataKeys,
  saveApiKey,
  clearApiKey,
  toggleShowKey,
  testApiKey,
  selectModel,
  toggleGrounding,
  setMode,
  saveCoinalyzeKey,
  clearCoinalyzeKey,
  saveDataKey,
  clearDataKey,
  setSymbol,
  toggleDebate,
};

// Initial load
loadSnapshot();

// Auto-refresh snapshot tiap 30s (skip kalau lagi loading / panel settings buka)
setInterval(() => {
  if (!state.loading && !state.analyzing && !state.showSettings) loadSnapshot();
}, 30_000);

// Re-render tiap 5s supaya "X ago" timestamp update
setInterval(() => {
  if (!state.showSettings) render();
}, 5_000);
