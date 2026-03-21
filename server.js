'use strict';
const express  = require('express');
const axios    = require('axios');
const cron     = require('node-cron');
require('dotenv').config();

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────
//  HYBRID TRADING BOT v9.1 — ICT/SMC PRECISION ENGINE
//  10 strategies · M15 entry · H1/H4 structure SL/TP
//  Markets: India NSE/BSE · Crypto · Forex · Commodity
// ─────────────────────────────────────────────────────────────

const CONFIG = {
  PORT:               process.env.PORT || 5000,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID,
  FINNHUB_KEY:        process.env.FINNHUB_API_KEY,
  FINNHUB_URL:        'https://finnhub.io/api/v1',
  TWELVE_DATA_KEY:    process.env.TWELVE_DATA_API_KEY,
  TWELVE_DATA_URL:    'https://api.twelvedata.com',
  DELTA_URL:          'https://api.india.delta.exchange', // No API key needed
  CG_URL:             'https://api.coingecko.com/api/v3',  // Fallback for crypto
  DHAN_URL:           'https://api.dhan.co',
  SIGNAL_QUALITY_MIN: 80,
  CANDLE_LIMIT:       130,   // M15 candles to fetch
  MAX_SIGNALS:        150,
  COOLDOWN_MIN:       45,    // minutes between signals per symbol
  FLIP_BLOCK_MIN:     120,   // minutes before direction can flip
  EXPIRY_MIN:         20,    // signal expires after 20 min (next M15 candle)
};

// ── Symbols ───────────────────────────────────────────────────
const SYMBOLS = {
  // India NSE (Dhan)
  NIFTY:     { name:'NIFTY 50',    cat:'india',     src:'dhan', dhanId:'13', seg:'IDX_I' },
  BANKNIFTY: { name:'Bank NIFTY',  cat:'india',     src:'dhan', dhanId:'25', seg:'IDX_I' },
  FINNIFTY:  { name:'Fin NIFTY',   cat:'india',     src:'dhan', dhanId:'27', seg:'IDX_I' },
  SENSEX:    { name:'BSE SENSEX',  cat:'india',     src:'dhan', dhanId:'51', seg:'IDX_I' },
  // Forex — Finnhub primary (60 req/min) | TwelveData fallback (8 req/min)
  EURUSD:    { name:'EUR/USD',     cat:'forex',     src:'td',   td:'EUR/USD',  fh:'OANDA:EUR_USD'  },
  GBPUSD:    { name:'GBP/USD',     cat:'forex',     src:'td',   td:'GBP/USD',  fh:'OANDA:GBP_USD'  },
  USDJPY:    { name:'USD/JPY',     cat:'forex',     src:'td',   td:'USD/JPY',  fh:'OANDA:USD_JPY'  },
  AUDUSD:    { name:'AUD/USD',     cat:'forex',     src:'td',   td:'AUD/USD',  fh:'OANDA:AUD_USD'  },
  // Commodity — Finnhub primary | TwelveData fallback
  XAUUSD:    { name:'Gold/USD',    cat:'commodity', src:'td',   td:'XAU/USD',  fh:'OANDA:XAU_USD'  },
  // Crypto — Delta Exchange primary (real M15) | CoinGecko fallback (30-min proxy)
  BTCUSDT:   { name:'BTC/USDT',   cat:'crypto',    src:'delta', deltaSymbol:'BTCUSD',  cgId:'bitcoin'     },
  ETHUSDT:   { name:'ETH/USDT',   cat:'crypto',    src:'delta', deltaSymbol:'ETHUSD',  cgId:'ethereum'    },
  XRPUSDT:   { name:'XRP/USDT',   cat:'crypto',    src:'delta', deltaSymbol:'XRPUSD',  cgId:'ripple'      },
  BNBUSDT:   { name:'BNB/USDT',   cat:'crypto',    src:'delta', deltaSymbol:'BNBUSD',  cgId:'binancecoin' },
};

// ── Live Dhan token (updated at runtime, no redeploy) ─────────
const dhanToken = {
  clientId:    process.env.DHAN_CLIENT_ID    || 'placeholder',
  accessToken: process.env.DHAN_ACCESS_TOKEN || 'placeholder',
  updatedAt:   null,
  updatedMs:   process.env.DHAN_ACCESS_TOKEN ? Date.now() : null, // assume fresh if set via env
};

// ── Market hours helpers ─────────────────────────────────────
const Market = {
  // India NSE: Mon-Fri 09:15–15:30 IST (03:45–10:00 UTC)
  indiaOpen() {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day  = now.getDay();
    if (day === 0 || day === 6) return false;
    const h = now.getHours(), m = now.getMinutes(), t = h * 60 + m;
    return t >= 555 && t <= 930; // 09:15 to 15:30
  },
  // Forex/Commodity: Mon 00:00 UTC – Fri 22:00 UTC (closed weekends)
  forexOpen() {
    const now = new Date();
    const day = now.getUTCDay(), h = now.getUTCHours();
    if (day === 6) return false;                    // Saturday always closed
    if (day === 0 && h < 22) return false;           // Sunday: market opens 22:00 UTC (Sydney)
    if (day === 5 && h >= 22) return false;          // Friday after 22:00 UTC
    return true;
  },
  // Crypto: always open
  cryptoOpen() { return true; },

  isOpen(cat) {
    if (cat === 'india')     return this.indiaOpen();
    if (cat === 'forex')     return this.forexOpen();
    if (cat === 'commodity') return this.forexOpen();
    if (cat === 'crypto')    return true;
    return false;
  },

  closedMessage(cat, symbol) {
    if (cat === 'india') {
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const day = now.getDay();
      if (day === 0 || day === 6) return `🔴 ${symbol}: Market closed (weekend)`;
      return `🔴 ${symbol}: NSE/BSE closed — opens 09:15 IST`;
    }
    if (cat === 'forex' || cat === 'commodity') {
      return `🔴 ${symbol}: Forex/Commodity market closed (weekend)`;
    }
    return `🔴 ${symbol}: Market closed`;
  },

  // Session name for display
  session() {
    const h = new Date().getUTCHours(), m = new Date().getUTCMinutes();
    const t = h + m / 60;
    if (t >= 22 || t < 0.5) return 'DEAD';
    if (t >= 0.5 && t < 8)  return 'ASIAN';
    if (t >= 8  && t < 13)  return 'LONDON';
    if (t >= 13 && t < 17)  return 'NY_OPEN';
    if (t >= 17 && t < 22)  return 'NY_LATE';
    return 'UNKNOWN';
  },

  // ICT Kill zones (UTC)
  inKillZone(cat) {
    if (cat === 'crypto') return true;
    if (cat === 'india') {
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const t   = now.getHours() * 60 + now.getMinutes();
      // India KZ: 09:15-10:00 and 14:00-15:15 IST
      return (t >= 555 && t <= 600) || (t >= 840 && t <= 915);
    }
    const h = new Date().getUTCHours(), m = new Date().getUTCMinutes();
    const t = h + m / 60;
    // London open: 08:00-10:00 UTC | NY open: 13:00-15:00 UTC | Silver Bullet: 15:00-16:00 / 19:00-20:00
    return (t >= 8 && t <= 10) || (t >= 13 && t <= 15) || (t >= 15 && t <= 16) || (t >= 19 && t <= 20);
  },

  // Asian session range (for PO3): 00:30-07:00 UTC
  asianRange(candles) {
    if (!candles || !candles.length) return null;
    const asian = candles.filter(c => {
      const h = new Date(c.time).getUTCHours();
      return h >= 0 && h < 7;
    });
    if (asian.length < 3) return null;
    return {
      high: Math.max(...asian.map(c => c.high)),
      low:  Math.min(...asian.map(c => c.low)),
      mid:  0,
    };
  },
};

// ═════════════════════════════════════════════════════════════
//  SECTION 1 — INDICATOR LIBRARY
// ═════════════════════════════════════════════════════════════
class Ind {

  static rsi(closes, p = 14) {
    if (closes.length < p + 1) return 50;
    let g = 0, l = 0;
    for (let i = closes.length - p; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      d > 0 ? (g += d) : (l -= d);
    }
    const ag = g / p, al = l / p;
    return al === 0 ? 100 : parseFloat((100 - 100 / (1 + ag / al)).toFixed(2));
  }

  static ema(closes, p) {
    if (closes.length < p) return closes[closes.length - 1] || 0;
    const k = 2 / (p + 1);
    let e = closes.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = p; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
    return e;
  }

  static emaArr(closes, p) {
    const k = 2 / (p + 1);
    const out = new Array(closes.length).fill(0);
    out[p - 1] = closes.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = p; i < closes.length; i++) out[i] = closes[i] * k + out[i - 1] * (1 - k);
    return out;
  }

  static sma(closes, p) {
    const s = closes.slice(-p);
    return s.reduce((a, b) => a + b, 0) / s.length;
  }

  static atr(candles, p = 14) {
    if (candles.length < 2) return (candles[0]?.high - candles[0]?.low) || 0.001;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      trs.push(Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low  - candles[i - 1].close)
      ));
    }
    const s = trs.slice(-p);
    return s.reduce((a, b) => a + b, 0) / s.length;
  }

  static macd(closes) {
    if (closes.length < 35) return { line: 0, signal: 0, hist: 0 };
    const e12 = this.emaArr(closes, 12);
    const e26 = this.emaArr(closes, 26);
    const m   = e12.map((v, i) => v - e26[i]).slice(25);
    const sig = this.emaArr(m, 9);
    return {
      line:   m[m.length - 1],
      signal: sig[sig.length - 1],
      hist:   m[m.length - 1] - sig[sig.length - 1],
    };
  }

  // Swing highs — strict: must be highest in lookback on both sides
  static swingHighs(candles, lb = 4) {
    const r = [];
    for (let i = lb; i < candles.length - lb; i++) {
      let ok = true;
      for (let j = 1; j <= lb; j++)
        if (candles[i - j].high >= candles[i].high || candles[i + j].high >= candles[i].high) { ok = false; break; }
      if (ok) r.push({ i, v: candles[i].high, t: candles[i].time });
    }
    return r;
  }

  static swingLows(candles, lb = 4) {
    const r = [];
    for (let i = lb; i < candles.length - lb; i++) {
      let ok = true;
      for (let j = 1; j <= lb; j++)
        if (candles[i - j].low <= candles[i].low || candles[i + j].low <= candles[i].low) { ok = false; break; }
      if (ok) r.push({ i, v: candles[i].low, t: candles[i].time });
    }
    return r;
  }

  // Volume: real for crypto, range-proxy for others
  static vol(candles, cat = 'forex') {
    let vals;
    if (cat === 'crypto') {
      vals = candles.map(c => c.volume || 1);
    } else {
      vals = candles.map(c => c.high - c.low); // range proxy
    }
    const avg  = vals.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const last = vals[vals.length - 1];
    return { avg, last, ratio: parseFloat((last / avg).toFixed(2)), spike: last > avg * 1.5 };
  }

  // Confirmed candles — drop last if < 80% complete
  static confirmed(candles) {
    if (candles.length < 2) return candles;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const interval = last.time - prev.time;
    if (interval > 0 && Date.now() - last.time < interval * 0.8)
      return candles.slice(0, -1);
    return candles;
  }

  // Order blocks from a candle array
  static findOBs(candles, atr) {
    const obs = [];
    for (let i = 2; i < candles.length - 2; i++) {
      const c = candles[i], n1 = candles[i + 1], n2 = candles[i + 2];
      const body = Math.abs(c.close - c.open);
      if (body < atr * 0.2) continue;
      // Bullish OB: last bearish candle before 2 strong bullish candles
      if (c.close < c.open && n1.close > n1.open && n2.close > n2.open) {
        if (n2.close - c.low > atr * 1.2)
          obs.push({ type: 'bull', top: Math.max(c.open, c.close), bot: c.low,
                     mid: (c.open + c.low) / 2, i, t: c.time });
      }
      // Bearish OB: last bullish candle before 2 strong bearish candles
      if (c.close > c.open && n1.close < n1.open && n2.close < n2.open) {
        if (c.high - n2.close > atr * 1.2)
          obs.push({ type: 'bear', top: c.high, bot: Math.min(c.open, c.close),
                     mid: (c.high + c.close) / 2, i, t: c.time });
      }
    }
    return obs.slice(-8);
  }

  // FVGs from a candle array
  static findFVGs(candles, atr) {
    const fvgs = [];
    for (let i = 1; i < candles.length - 1; i++) {
      const gUp   = candles[i + 1].low  - candles[i - 1].high;
      const gDown = candles[i - 1].low  - candles[i + 1].high;
      if (gUp   > atr * 0.25) fvgs.push({ type: 'bull', top: candles[i + 1].low, bot: candles[i - 1].high, i });
      if (gDown > atr * 0.25) fvgs.push({ type: 'bear', top: candles[i - 1].low, bot: candles[i + 1].high, i });
    }
    return fvgs.slice(-8);
  }

  // Premium / Discount zone from H4 candles
  static pdZone(price, h4) {
    if (!h4 || h4.length < 4) return { zone: 'NEUTRAL', pct: 50 };
    const hi  = Math.max(...h4.slice(-10).map(c => c.high));
    const lo  = Math.min(...h4.slice(-10).map(c => c.low));
    if (hi === lo) return { zone: 'NEUTRAL', pct: 50, hi, lo };
    const pct = Math.round(((price - lo) / (hi - lo)) * 100);
    const zone = pct <= 40 ? 'DEEP_DISCOUNT' : pct <= 50 ? 'DISCOUNT' :
                 pct <= 60 ? 'PREMIUM'        : 'DEEP_PREMIUM';
    return { zone, pct, hi, lo, eq: (hi + lo) / 2 };
  }

  // Smart decimal places based on price magnitude
  static dec(price) {
    if (!price || !isFinite(price)) return 2;
    if (price >= 1000)  return 2;
    if (price >= 10)    return 2;
    if (price >= 1)     return 4;
    return 5;
  }

  // Format price to correct decimals, return null if invalid
  static fmt(v, dec) {
    if (v == null || !isFinite(v) || isNaN(v)) return null;
    return parseFloat(v.toFixed(dec));
  }

  // Trend from EMA stack
  static trend(candles) {
    if (candles.length < 55) return 'NEUTRAL';
    const c  = candles.map(c => c.close);
    const e20 = this.ema(c, 20), e50 = this.ema(c, 50);
    const p   = c[c.length - 1];
    if (p > e20 && e20 > e50) return 'BULLISH';
    if (p < e20 && e20 < e50) return 'BEARISH';
    if (p > e20)              return 'BULLISH';
    if (p < e20)              return 'BEARISH';
    return 'NEUTRAL';
  }

  // Is price inside consolidation?
  static consolidating(candles, lb = 10) {
    const sl = candles.slice(-lb);
    const range = Math.max(...sl.map(c => c.high)) - Math.min(...sl.map(c => c.low));
    return range < this.atr(candles) * 2.5;
  }
}

// ═════════════════════════════════════════════════════════════
//  SECTION 2 — STRATEGY DETECTORS (10 strategies)
//  All entry on M15. SL/TP strictly from live candle structure.
//  Strategies: FVG_OB · LIQ_SWEEP · CHOCH · FPB · OTE
//              BREAKER · SILVER_BULLET · ORB · CRT · PO3
//              + FVG_BOS_HTF (combo)
// ═════════════════════════════════════════════════════════════
class Detectors {

  // ─── shared context prepared once per cycle ───────────────
  static ctx(m15, h1, h4, cat) {
    const c   = Ind.confirmed(m15);
    const cls = c.map(x => x.close);
    const atr = Ind.atr(c);
    const dec = Ind.dec(cls[cls.length - 1]);
    const f   = v => Ind.fmt(v, dec);
    const price = cls[cls.length - 1];
    const swH = Ind.swingHighs(c);
    const swL = Ind.swingLows(c);
    const obs  = Ind.findOBs(c, atr);
    const fvgs = Ind.findFVGs(c, atr);
    const vol  = Ind.vol(c, cat);
    const rsi  = Ind.rsi(cls);
    const macd = Ind.macd(cls);
    const tr   = Ind.trend(c);

    // H1 context
    const h1Atr = h1?.length >= 10 ? Ind.atr(h1) : atr;
    const h1OBs = h1?.length >= 10 ? Ind.findOBs(h1, h1Atr) : [];
    const h1FVGs= h1?.length >= 10 ? Ind.findFVGs(h1, h1Atr) : [];
    const h1SwH = h1?.length >= 10 ? Ind.swingHighs(h1, 3) : [];
    const h1SwL = h1?.length >= 10 ? Ind.swingLows(h1, 3)  : [];

    // H4 context
    const pd   = Ind.pdZone(price, h4);
    const h4OBs= h4?.length >= 5  ? Ind.findOBs(h4, Ind.atr(h4)) : [];

    // Is price at an H1 POI?
    const tol  = h1Atr * 0.5;
    let h1POI  = null;
    for (const ob of h1OBs)
      if (price >= ob.bot - tol && price <= ob.top + tol) { h1POI = { type: 'H1_OB', ob }; break; }
    if (!h1POI)
      for (const fvg of h1FVGs)
        if (price >= fvg.bot - tol && price <= fvg.top + tol) { h1POI = { type: 'H1_FVG', fvg }; break; }

    // H4 trend
    const h4Tr = h4?.length >= 5 ? Ind.trend(h4) : 'NEUTRAL';
    const h1Tr = h1?.length >= 10 ? Ind.trend(h1) : 'NEUTRAL';

    // Alignment
    const trs = [h4Tr, h1Tr, tr];
    const bulls = trs.filter(t => t === 'BULLISH').length;
    const bears = trs.filter(t => t === 'BEARISH').length;
    const align = bulls === 3 ? 'FULL_BULL' : bears === 3 ? 'FULL_BEAR' :
                  bulls === 2 ? 'PARTIAL_BULL' : bears === 2 ? 'PARTIAL_BEAR' : 'MIXED';

    // Premium/Discount gate
    const pdZone = pd.zone;
    const buyOk  = ['DEEP_DISCOUNT','DISCOUNT','NEUTRAL'].includes(pdZone);
    const sellOk = ['DEEP_PREMIUM', 'PREMIUM',  'NEUTRAL'].includes(pdZone);

    return {
      c, cls, atr, f, price, dec,
      swH, swL, obs, fvgs, vol, rsi, macd, tr,
      h1Atr, h1OBs, h1FVGs, h1SwH, h1SwL, h1POI,
      h4Tr, h1Tr, pd, pdZone, buyOk, sellOk,
      align, kz: Market.inKillZone(cat), cat,
      last:  c[c.length - 1],
      prev:  c[c.length - 2],
      last2: c[c.length - 3],
    };
  }

  // ─── run all detectors ────────────────────────────────────
  static runAll(m15, h1, h4, cat) {
    if (!m15 || m15.length < 40) return [];
    let x;
    try { x = this.ctx(m15, h1, h4, cat); }
    catch { return []; }

    const results = [];
    const runners = [
      this.fvgOB, this.liqSweep, this.choch, this.fpb, this.ote,
      this.breaker, this.silverBullet, this.orb, this.crt, this.po3,
      this.fvgBosHTF,
    ];
    for (const fn of runners) {
      try {
        const r = fn.call(this, x, m15, h1, h4);
        if (!r) continue;
        const arr = Array.isArray(r) ? r : [r];
        for (const sig of arr) {
          if (!sig?.dir || !sig?.id) continue;
          // Premium/Discount gate
          if (sig.dir === 'BUY'  && !x.buyOk)  continue;
          if (sig.dir === 'SELL' && !x.sellOk) continue;
          // H4 hard block
          if (x.align === 'FULL_BULL' && sig.dir === 'SELL') continue;
          if (x.align === 'FULL_BEAR' && sig.dir === 'BUY')  continue;
          results.push(sig);
        }
      } catch { /* skip */ }
    }
    return results;
  }

  // ══════════════════════════════════════════════════════════
  //  1. FVG + OB (merged — both catch institutional zones)
  //  Entry: at gap or OB zone edge
  //  SL:    below OB candle low (BUY) / above OB candle high (SELL)
  //  TP1:   opposite edge of FVG / OB
  //  TP2:   next H1 swing high/low
  // ══════════════════════════════════════════════════════════
  static fvgOB(x) {
    const results = [];
    const { c, price, atr, f, fvgs, obs, h1POI, h4Tr, h1Tr, kz } = x;
    const last = x.last, prev = x.prev;

    // FVG retest
    for (const fvg of fvgs.slice(-4)) {
      const postIdx = fvg.i + 1;
      if (postIdx >= c.length - 1) continue;
      const post = c.slice(postIdx);
      const returnedToGap = price >= fvg.bot - atr * 0.1 && price <= fvg.top + atr * 0.1;
      if (!returnedToGap) continue;
      const gapSize = fvg.top - fvg.bot;
      if (gapSize < atr * 0.2) continue;
      const score = 72
        + (h1POI ? 10 : 0)
        + (kz ? 6 : 0)
        + (fvg.type === 'bull' && h4Tr === 'BULLISH' ? 6 : 0)
        + (fvg.type === 'bear' && h4Tr === 'BEARISH' ? 6 : 0);
      if (fvg.type === 'bull' && last.close > last.open) {
        results.push({ id: 'FVG_OB', name: 'Fair Value Gap', dir: 'BUY', score,
          sl_ref: { type: 'fvg_bot', val: fvg.bot },
          tp_ref: { tp1_type: 'fvg_top', tp1_val: fvg.top } });
      }
      if (fvg.type === 'bear' && last.close < last.open) {
        results.push({ id: 'FVG_OB', name: 'Fair Value Gap', dir: 'SELL', score,
          sl_ref: { type: 'fvg_top', val: fvg.top },
          tp_ref: { tp1_type: 'fvg_bot', tp1_val: fvg.bot } });
      }
    }

    // OB retest (only fresh OBs not retested yet)
    for (const ob of obs.slice(-4)) {
      if (ob.i >= c.length - 3) continue;
      const post = c.slice(ob.i + 1);
      const touched = post.some(cx => cx.low <= ob.top && cx.high >= ob.bot);
      if (!touched) continue;
      const inZone = price >= ob.bot - atr * 0.1 && price <= ob.top + atr * 0.1;
      if (!inZone) continue;
      const score = 74
        + (h1POI ? 10 : 0)
        + (kz ? 6 : 0)
        + (ob.type === 'bull' && h4Tr === 'BULLISH' ? 6 : 0)
        + (ob.type === 'bear' && h4Tr === 'BEARISH' ? 6 : 0);
      if (ob.type === 'bull' && last.close > last.open) {
        results.push({ id: 'FVG_OB', name: 'Order Block', dir: 'BUY', score,
          sl_ref: { type: 'ob_bot', val: ob.bot },
          tp_ref: { tp1_type: 'ob_top', tp1_val: ob.top } });
      }
      if (ob.type === 'bear' && last.close < last.open) {
        results.push({ id: 'FVG_OB', name: 'Order Block', dir: 'SELL', score,
          sl_ref: { type: 'ob_top', val: ob.top },
          tp_ref: { tp1_type: 'ob_bot', tp1_val: ob.bot } });
      }
    }
    return results.slice(0, 1); // best only
  }

  // ══════════════════════════════════════════════════════════
  //  2. LIQUIDITY SWEEP
  //  Entry: when M15 wick sweeps swing H/L, candle CLOSES back
  //  SL:    below sweep wick low (BUY) / above wick high (SELL)
  //  TP1:   swept level (now support/resistance)
  //  TP2:   opposite session swing
  // ══════════════════════════════════════════════════════════
  static liqSweep(x) {
    const { c, price, atr, f, swH, swL, h4Tr, h1POI, kz } = x;
    const last = x.last;
    if (!swH.length || !swL.length) return null;
    const keyH = swH[swH.length - 1].v;
    const keyL = swL[swL.length - 1].v;
    const closePos = (last.close - last.low) / (Math.max(last.high - last.low, 0.0001));

    // Bullish sweep: wick below key low, closes above it
    if (last.low < keyL && last.close > keyL && closePos > 0.65) {
      const score = 78 + (h1POI ? 8 : 0) + (h4Tr === 'BULLISH' ? 8 : 0) + (kz ? 6 : 0);
      return { id: 'LIQ_SWEEP', name: 'Liquidity Sweep', dir: 'BUY', score,
        sl_ref: { type: 'sweep_wick', val: last.low },
        tp_ref: { tp1_type: 'swept_level', tp1_val: keyL } };
    }
    // Bearish sweep: wick above key high, closes below it
    if (last.high > keyH && last.close < keyH && closePos < 0.35) {
      const score = 78 + (h1POI ? 8 : 0) + (h4Tr === 'BEARISH' ? 8 : 0) + (kz ? 6 : 0);
      return { id: 'LIQ_SWEEP', name: 'Liquidity Sweep', dir: 'SELL', score,
        sl_ref: { type: 'sweep_wick', val: last.high },
        tp_ref: { tp1_type: 'swept_level', tp1_val: keyH } };
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════
  //  3. CHANGE OF CHARACTER (ChoCh)
  //  Entry: M15 candle closes beyond last swing in opposite trend direction
  //  SL:    below the candle that broke structure (BUY) / above it (SELL)
  //  TP1:   prior swing in new direction
  //  TP2:   H1 swing in new direction
  // ══════════════════════════════════════════════════════════
  static choch(x) {
    const { c, price, swH, swL, tr, h1Tr, h4Tr, atr, kz } = x;
    const last = x.last, prev = x.prev;
    if (swH.length < 2 || swL.length < 2) return null;
    const lastSH = swH[swH.length - 1].v;
    const lastSL = swL[swL.length - 1].v;

    // Bullish ChoCh: was bearish/neutral, breaks above last swing high with full body
    if ((tr === 'BEARISH' || tr === 'NEUTRAL') && prev.close <= lastSH && last.close > lastSH && last.close > last.open) {
      const score = 76 + (h4Tr === 'BULLISH' ? 8 : 0) + (h1Tr === 'BULLISH' ? 6 : 0) + (kz ? 6 : 0);
      return { id: 'CHOCH', name: 'Change of Character', dir: 'BUY', score,
        brokenLevel: lastSH,
        sl_ref: { type: 'break_candle_low', val: last.low },
        tp_ref: { tp1_type: 'prior_swing', tp1_val: swH.length >= 2 ? swH[swH.length - 2].v : lastSH + atr * 2 } };
    }
    // Bearish ChoCh: was bullish/neutral, breaks below last swing low
    if ((tr === 'BULLISH' || tr === 'NEUTRAL') && prev.close >= lastSL && last.close < lastSL && last.close < last.open) {
      const score = 76 + (h4Tr === 'BEARISH' ? 8 : 0) + (h1Tr === 'BEARISH' ? 6 : 0) + (kz ? 6 : 0);
      return { id: 'CHOCH', name: 'Change of Character', dir: 'SELL', score,
        brokenLevel: lastSL,
        sl_ref: { type: 'break_candle_high', val: last.high },
        tp_ref: { tp1_type: 'prior_swing', tp1_val: swL.length >= 2 ? swL[swL.length - 2].v : lastSL - atr * 2 } };
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════
  //  4. FIRST PULLBACK after ChoCh (FPB)
  //  Entry: after ChoCh on prior candles, price pulls back to broken level
  //  SL:    beyond broken level by 0.5 ATR
  //  TP1:   swing high/low created by ChoCh move
  //  TP2:   H1 swing in direction
  // ══════════════════════════════════════════════════════════
  static fpb(x) {
    const { c, price, atr, swH, swL, tr, h4Tr, h1POI, kz } = x;
    if (swH.length < 3 || swL.length < 3) return null;
    const last = x.last, prev = x.prev;

    // Look back 3-10 candles for a recent structure break (ChoCh-like)
    for (let k = 3; k <= Math.min(10, c.length - 3); k++) {
      const breakCandle = c[c.length - 1 - k];
      const preSH = swH.filter(s => s.i < c.length - 1 - k);
      const preSL = swL.filter(s => s.i < c.length - 1 - k);
      if (!preSH.length || !preSL.length) continue;

      // Bullish FPB: break candle closed above recent swing high → now retracing to it
      const oldSH = preSH[preSH.length - 1].v;
      if (breakCandle.close > oldSH) {
        const retestingLevel = Math.abs(price - oldSH) < atr * 0.4;
        if (retestingLevel && last.close > last.open) {
          const score = 74 + (h4Tr === 'BULLISH' ? 10 : 0) + (h1POI ? 8 : 0) + (kz ? 4 : 0);
          return { id: 'FPB', name: 'First Pullback', dir: 'BUY', score,
            brokenLevel: oldSH,
            sl_ref: { type: 'broken_level_below', val: oldSH - atr * 0.5 },
            tp_ref: { tp1_type: 'choch_swing_high', tp1_val: swH[swH.length - 1].v } };
        }
      }

      // Bearish FPB: break candle closed below recent swing low → retracing to it
      const oldSL = preSL[preSL.length - 1].v;
      if (breakCandle.close < oldSL) {
        const retestingLevel = Math.abs(price - oldSL) < atr * 0.4;
        if (retestingLevel && last.close < last.open) {
          const score = 74 + (h4Tr === 'BEARISH' ? 10 : 0) + (h1POI ? 8 : 0) + (kz ? 4 : 0);
          return { id: 'FPB', name: 'First Pullback', dir: 'SELL', score,
            brokenLevel: oldSL,
            sl_ref: { type: 'broken_level_above', val: oldSL + atr * 0.5 },
            tp_ref: { tp1_type: 'choch_swing_low', tp1_val: swL[swL.length - 1].v } };
        }
      }
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════
  //  5. OTE — OPTIMAL TRADE ENTRY (ICT)
  //  Entry: 62-79% fib of swing, price at H1 OB/FVG
  //  SL:    below H1 OB candle low (BUY) / above H1 OB high (SELL)
  //  TP1:   swing high that started the retracement
  //  TP2:   H4 premium/discount extreme
  // ══════════════════════════════════════════════════════════
  static ote(x) {
    const { c, price, atr, swH, swL, tr, h4Tr, h1POI, h1OBs, kz } = x;
    if (swH.length < 2 || swL.length < 2) return null;
    const last = x.last;

    if (tr === 'BULLISH') {
      const sL = Math.min(...swL.slice(-3).map(s => s.v));
      const sH = Math.max(...swH.slice(-2).map(s => s.v));
      const range = sH - sL;
      if (range < atr) return null;
      const fib618 = sH - range * 0.618;
      const fib786 = sH - range * 0.786;
      if (price >= fib786 - atr * 0.15 && price <= fib618 + atr * 0.15) {
        const atOB = h1OBs.some(ob => ob.type === 'bull' && price >= ob.bot - atr * 0.1 && price <= ob.top + atr * 0.1);
        if (!atOB && !h1POI) return null; // OTE requires H1 confluence
        const score = 82 + (h4Tr === 'BULLISH' ? 8 : 0) + (kz ? 6 : 0) + (atOB ? 4 : 0);
        const slOB  = h1OBs.find(ob => ob.type === 'bull' && price >= ob.bot - atr * 0.1);
        return { id: 'OTE', name: 'Optimal Trade Entry', dir: 'BUY', score,
          sl_ref: { type: 'h1_ob_bot', val: slOB ? slOB.bot : fib786 - atr },
          tp_ref: { tp1_type: 'swing_high', tp1_val: sH } };
      }
    }
    if (tr === 'BEARISH') {
      const sH = Math.max(...swH.slice(-3).map(s => s.v));
      const sL = Math.min(...swL.slice(-2).map(s => s.v));
      const range = sH - sL;
      if (range < atr) return null;
      const fib618 = sL + range * 0.618;
      const fib786 = sL + range * 0.786;
      if (price >= fib618 - atr * 0.15 && price <= fib786 + atr * 0.15) {
        const atOB = h1OBs.some(ob => ob.type === 'bear' && price >= ob.bot - atr * 0.1 && price <= ob.top + atr * 0.1);
        if (!atOB && !h1POI) return null;
        const score = 82 + (h4Tr === 'BEARISH' ? 8 : 0) + (kz ? 6 : 0) + (atOB ? 4 : 0);
        const slOB  = h1OBs.find(ob => ob.type === 'bear' && price <= ob.top + atr * 0.1);
        return { id: 'OTE', name: 'Optimal Trade Entry', dir: 'SELL', score,
          sl_ref: { type: 'h1_ob_top', val: slOB ? slOB.top : fib786 + atr },
          tp_ref: { tp1_type: 'swing_low', tp1_val: sL } };
      }
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════
  //  6. BREAKER BLOCK
  //  Entry: when price returns to a failed OB zone (swept + reclaimed)
  //  SL:    below breaker bottom (BUY) / above breaker top (SELL)
  //  TP1:   origin of the displacement that swept the OB
  //  TP2:   H1 swing in direction
  // ══════════════════════════════════════════════════════════
  static breaker(x) {
    const { c, price, atr, obs, h4Tr, h1POI, kz } = x;
    const last = x.last;
    for (const ob of obs.slice(-6)) {
      if (ob.i >= c.length - 3) continue;
      const post = c.slice(ob.i + 1);

      if (ob.type === 'bear') {
        // Bearish OB swept below (bullish breaker)
        const swept     = post.some(cx => cx.low < ob.bot);
        const reclaimed = post.slice(-3).some(cx => cx.close > ob.bot);
        if (!swept || !reclaimed) continue;
        if (price >= ob.bot - atr * 0.2 && price <= ob.top + atr * 0.2 && last.close > last.open) {
          const score = 80 + (h4Tr === 'BULLISH' ? 8 : 0) + (h1POI ? 6 : 0) + (kz ? 4 : 0);
          // TP1 = origin of displacement (first post-OB candle that was strong bullish)
          const dispCandle = post.find(cx => cx.close > cx.open && (cx.close - cx.open) > atr * 0.8);
          return { id: 'BREAKER', name: 'Breaker Block', dir: 'BUY', score,
            sl_ref: { type: 'breaker_bot', val: ob.bot },
            tp_ref: { tp1_type: 'displacement_origin', tp1_val: dispCandle ? dispCandle.high : ob.top + atr * 2 } };
        }
      }
      if (ob.type === 'bull') {
        // Bullish OB swept above (bearish breaker)
        const swept     = post.some(cx => cx.high > ob.top);
        const reclaimed = post.slice(-3).some(cx => cx.close < ob.top);
        if (!swept || !reclaimed) continue;
        if (price >= ob.bot - atr * 0.2 && price <= ob.top + atr * 0.2 && last.close < last.open) {
          const score = 80 + (h4Tr === 'BEARISH' ? 8 : 0) + (h1POI ? 6 : 0) + (kz ? 4 : 0);
          const dispCandle = post.find(cx => cx.close < cx.open && (cx.open - cx.close) > atr * 0.8);
          return { id: 'BREAKER', name: 'Breaker Block', dir: 'SELL', score,
            sl_ref: { type: 'breaker_top', val: ob.top },
            tp_ref: { tp1_type: 'displacement_origin', tp1_val: dispCandle ? dispCandle.low : ob.bot - atr * 2 } };
        }
      }
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════
  //  7. ICT SILVER BULLET
  //  Kill zone 10-11 EST (15:00-16:00 UTC) or 14-15 EST (19:00-20:00 UTC)
  //  Entry: FVG + liquidity sweep inside kill zone
  //  SL:    below FVG bottom (BUY) / above FVG top (SELL)
  //  TP1:   kill zone high/low
  //  TP2:   previous session high/low
  // ══════════════════════════════════════════════════════════
  static silverBullet(x) {
    const { c, price, atr, fvgs, swH, swL, h4Tr, cat } = x;
    if (cat !== 'forex' && cat !== 'commodity') return null;
    const h = new Date().getUTCHours(), m = new Date().getUTCMinutes();
    const t = h + m / 60;
    const inSB = (t >= 15 && t <= 16) || (t >= 19 && t <= 20);
    if (!inSB) return null;

    const last = x.last;
    const keyH = swH.length ? swH[swH.length - 1].v : 0;
    const keyL = swL.length ? swL[swL.length - 1].v : Infinity;
    const bullSweep = last.low < keyL && last.close > keyL;
    const bearSweep = last.high > keyH && last.close < keyH;

    if (bullSweep) {
      const nearFVG = fvgs.find(fv => fv.type === 'bull' && price >= fv.bot - atr * 0.2 && price <= fv.top + atr * 0.2);
      if (nearFVG) {
        const score = 86 + (h4Tr === 'BULLISH' ? 6 : 0);
        return { id: 'SILVER_BULLET', name: 'ICT Silver Bullet', dir: 'BUY', score,
          sl_ref: { type: 'fvg_bot', val: nearFVG.bot - atr * 0.3 },
          tp_ref: { tp1_type: 'kz_high', tp1_val: keyH } };
      }
    }
    if (bearSweep) {
      const nearFVG = fvgs.find(fv => fv.type === 'bear' && price >= fv.bot - atr * 0.2 && price <= fv.top + atr * 0.2);
      if (nearFVG) {
        const score = 86 + (h4Tr === 'BEARISH' ? 6 : 0);
        return { id: 'SILVER_BULLET', name: 'ICT Silver Bullet', dir: 'SELL', score,
          sl_ref: { type: 'fvg_top', val: nearFVG.top + atr * 0.3 },
          tp_ref: { tp1_type: 'kz_low', tp1_val: keyL } };
      }
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════
  //  8. OPENING RANGE BREAKOUT (ORB)
  //  Entry: breakout of first 15-min session candle range
  //  SL:    opposite side of ORB range
  //  TP1:   1× ORB range projected
  //  TP2:   2× ORB range projected
  // ══════════════════════════════════════════════════════════
  static orb(x) {
    const { c, price, atr, vol, h4Tr, cat } = x;
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: cat === 'india' ? 'Asia/Kolkata' : 'UTC' }));
    const hh = now.getHours(), mm = now.getMinutes(), t = hh + mm / 60;

    let winStart, winEnd, tradeWindow;
    if (cat === 'india') {
      winStart = 9.25; winEnd = 9.5; tradeWindow = 13; // 09:15-09:30 IST, trade till 13:00
    } else if (cat === 'forex' || cat === 'commodity') {
      winStart = 8.0; winEnd = 8.25; tradeWindow = 12; // 08:00-08:15 UTC, London open
    } else return null;

    // Only trade after ORB forms and within trade window
    if (t < winEnd || t > tradeWindow) return null;

    // Get ORB candles
    const orbCandles = c.filter(cx => {
      const ct = new Date(cx.time);
      const ch = ct.getHours() + ct.getMinutes() / 60;
      return ch >= winStart && ch < winEnd;
    });
    if (orbCandles.length < 1) return null;

    const orbH = Math.max(...orbCandles.map(cx => cx.high));
    const orbL = Math.min(...orbCandles.map(cx => cx.low));
    const range = orbH - orbL;
    if (range < atr * 0.5) return null; // too tight to be meaningful

    const last = x.last, prev = x.prev;
    if (prev.close <= orbH && last.close > orbH && vol.ratio > 1.3) {
      const score = 76 + (h4Tr === 'BULLISH' ? 8 : 0);
      return { id: 'ORB', name: 'ORB Breakout', dir: 'BUY', score,
        sl_ref: { type: 'orb_low', val: orbL },
        tp_ref: { tp1_type: 'orb_proj1', tp1_val: orbH + range, tp2_val: orbH + range * 2 } };
    }
    if (prev.close >= orbL && last.close < orbL && vol.ratio > 1.3) {
      const score = 76 + (h4Tr === 'BEARISH' ? 8 : 0);
      return { id: 'ORB', name: 'ORB Breakdown', dir: 'SELL', score,
        sl_ref: { type: 'orb_high', val: orbH },
        tp_ref: { tp1_type: 'orb_proj1', tp1_val: orbL - range, tp2_val: orbL - range * 2 } };
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════
  //  9. CRT — CANDLE RANGE THEORY (H1 + H4)
  //  Uses completed H1 or H4 candle range
  //  Entry: M15 closes back inside candle body after wick sweep
  //  SL:    beyond the swept wick extreme
  //  TP1:   50% of H1/H4 candle body (midpoint)
  //  TP2:   opposite edge of H1/H4 candle
  // ══════════════════════════════════════════════════════════
  static crt(x, m15, h1, h4) {
    const results = [];
    const { price, atr, h4Tr, h1Tr, kz } = x;
    const last = x.last;

    // Run for both H1 and H4
    for (const [tfs, candles, label] of [['H1', h1, 'CRT H1'], ['H4', h4, 'CRT H4']]) {
      if (!candles || candles.length < 4) continue;
      // Analyse last 3 completed HTF candles
      for (let k = 1; k <= 3; k++) {
        const htfC = candles[candles.length - 1 - k];
        if (!htfC) continue;
        const body    = Math.abs(htfC.close - htfC.open);
        const htfAtr  = Ind.atr(candles);
        if (body < htfAtr * 0.3) continue; // ignore doji HTF candles

        const cHigh   = htfC.high;
        const cLow    = htfC.low;
        const cOpen   = htfC.open;
        const cClose  = htfC.close;
        const bodyTop = Math.max(cOpen, cClose);
        const bodyBot = Math.min(cOpen, cClose);
        const bodyMid = (bodyTop + bodyBot) / 2;

        // Bullish CRT: HTF candle swept BELOW its body (long wick down), closed back inside body
        // Now M15 price is near bodyBot retest → BUY target bodyMid then cHigh
        const bullSweep = cLow < bodyBot - htfAtr * 0.1; // wick below body
        if (bullSweep && price >= bodyBot - atr * 0.3 && price <= bodyMid + atr * 0.3) {
          if (last.close > last.open) { // M15 bullish confirmation
            const score = 74
              + (tfs === 'H4' ? 4 : 0)
              + (h4Tr === 'BULLISH' ? 8 : 0)
              + (kz ? 6 : 0);
            results.push({ id: 'CRT', name: label, dir: 'BUY', score,
              sl_ref: { type: 'crt_wick_low', val: cLow },
              tp_ref: { tp1_type: 'crt_body_mid', tp1_val: bodyMid, tp2_val: cHigh } });
          }
        }

        // Bearish CRT: HTF candle swept ABOVE its body (long wick up), closed back inside body
        // M15 price near bodyTop retest → SELL target bodyMid then cLow
        const bearSweep = cHigh > bodyTop + htfAtr * 0.1;
        if (bearSweep && price >= bodyMid - atr * 0.3 && price <= bodyTop + atr * 0.3) {
          if (last.close < last.open) { // M15 bearish confirmation
            const score = 74
              + (tfs === 'H4' ? 4 : 0)
              + (h4Tr === 'BEARISH' ? 8 : 0)
              + (kz ? 6 : 0);
            results.push({ id: 'CRT', name: label, dir: 'SELL', score,
              sl_ref: { type: 'crt_wick_high', val: cHigh },
              tp_ref: { tp1_type: 'crt_body_mid', tp1_val: bodyMid, tp2_val: cLow } });
          }
        }
      }
    }
    return results.slice(0, 1);
  }

  // ══════════════════════════════════════════════════════════
  //  10. POWER OF THREE / AMD (PO3)
  //  Asian session defines accumulation range (00:30-07:00 UTC)
  //  London sweeps one side (manipulation)
  //  Entry: M15 closes BACK inside Asian range after sweep
  //  SL:    beyond manipulation wick
  //  TP1:   opposite side of Asian range
  //  TP2:   Asian range ± 1 ATR extension
  // ══════════════════════════════════════════════════════════
  static po3(x, m15) {
    const { price, atr, h4Tr, kz, cat } = x;
    if (cat !== 'forex' && cat !== 'commodity') return null;

    const asianR = Market.asianRange(m15);
    if (!asianR) return null;

    const h = new Date().getUTCHours(), m2 = new Date().getUTCMinutes(), t = h + m2 / 60;
    // PO3 setup only fires 08:00-12:00 UTC (London session, after Asian closes)
    if (t < 8 || t > 12) return null;

    const last = x.last, prev = x.prev;
    const asH  = asianR.high, asL = asianR.low, asRange = asH - asL;
    if (asRange < atr * 0.8) return null; // Asian range too tight

    // Bullish PO3: London swept below Asian low, M15 just closed back above Asian low
    if (prev.close < asL && last.close > asL && last.close > last.open) {
      const score = 78 + (h4Tr === 'BULLISH' ? 10 : 0) + (kz ? 6 : 0);
      return { id: 'PO3', name: 'Power of Three', dir: 'BUY', score,
        sl_ref: { type: 'po3_sweep_low', val: Math.min(prev.low, last.low) },
        tp_ref: { tp1_type: 'asian_opposite', tp1_val: asH, tp2_val: asH + atr } };
    }
    // Bearish PO3: London swept above Asian high, M15 closed back below Asian high
    if (prev.close > asH && last.close < asH && last.close < last.open) {
      const score = 78 + (h4Tr === 'BEARISH' ? 10 : 0) + (kz ? 6 : 0);
      return { id: 'PO3', name: 'Power of Three', dir: 'SELL', score,
        sl_ref: { type: 'po3_sweep_high', val: Math.max(prev.high, last.high) },
        tp_ref: { tp1_type: 'asian_opposite', tp1_val: asL, tp2_val: asL - atr } };
    }
    return null;
  }

  // ══════════════════════════════════════════════════════════
  //  11. FVG + BOS + HTF (combo — best setup ⭐)
  //  All three must align: H4 bias + H1 FVG/OB + M15 BOS
  //  SL/TP: inherited from FVG/OB component
  // ══════════════════════════════════════════════════════════
  static fvgBosHTF(x) {
    const { c, price, atr, fvgs, swH, swL, tr, h4Tr, h1Tr, h1POI, h1OBs, h1FVGs, align } = x;
    if (!h1POI) return null;
    if (align !== 'FULL_BULL' && align !== 'FULL_BEAR' && align !== 'PARTIAL_BULL' && align !== 'PARTIAL_BEAR') return null;
    const last = x.last, prev = x.prev;
    const lastSH = swH.length ? swH[swH.length - 1].v : 0;
    const lastSL = swL.length ? swL[swL.length - 1].v : Infinity;

    // BOS in H4 direction
    if ((align === 'FULL_BULL' || align === 'PARTIAL_BULL') && prev.close <= lastSH && last.close > lastSH) {
      const nearFVG = fvgs.find(fv => fv.type === 'bull' && price >= fv.bot - atr * 0.2 && price <= fv.top + atr * 0.2);
      if (!nearFVG) return null;
      const score = 88 + (align === 'FULL_BULL' ? 8 : 4) + (x.kz ? 4 : 0);
      return { id: 'FVG_BOS_HTF', name: 'FVG + BoS + HTF', dir: 'BUY', score,
        sl_ref: { type: 'fvg_bot', val: nearFVG.bot },
        tp_ref: { tp1_type: 'fvg_top', tp1_val: nearFVG.top } };
    }
    if ((align === 'FULL_BEAR' || align === 'PARTIAL_BEAR') && prev.close >= lastSL && last.close < lastSL) {
      const nearFVG = fvgs.find(fv => fv.type === 'bear' && price >= fv.bot - atr * 0.2 && price <= fv.top + atr * 0.2);
      if (!nearFVG) return null;
      const score = 88 + (align === 'FULL_BEAR' ? 8 : 4) + (x.kz ? 4 : 0);
      return { id: 'FVG_BOS_HTF', name: 'FVG + BoS + HTF', dir: 'SELL', score,
        sl_ref: { type: 'fvg_top', val: nearFVG.top },
        tp_ref: { tp1_type: 'fvg_bot', tp1_val: nearFVG.bot } };
    }
    return null;
  }
}

// ═════════════════════════════════════════════════════════════
//  SECTION 3 — SIGNAL BUILDER
//  Converts detector output into a complete signal with
//  SL and TP derived strictly from live candle structure.
// ═════════════════════════════════════════════════════════════
class Builder {

  static build(symbol, m15, source, mtfData) {
    if (!m15 || m15.length < 30) return null;
    const cfg  = SYMBOLS[symbol];
    if (!cfg)  return null;
    const cat  = cfg.cat;
    const h1   = mtfData?.h1 || null;
    const h4   = mtfData?.h4 || null;

    const fired = Detectors.runAll(m15, h1, h4, cat);
    if (!fired.length) return null;

    // Best signal by score
    const best = fired.reduce((a, b) => a.score > b.score ? a : b);

    // Confirming signals in same direction
    const conf = fired.filter(s => s.dir === best.dir);
    if (conf.length < 2) return null; // need at least 2 strategies agreeing

    // Quality score
    const quality = Math.min(100, Math.round(
      best.score
      + (conf.length >= 4 ? 8 : conf.length >= 3 ? 5 : 2)
    ));
    if (quality < CONFIG.SIGNAL_QUALITY_MIN) return null;

    // Build levels from live candle data
    const lvls = this.levels(best, m15, h1, h4, cat);
    if (!lvls.entry || !lvls.sl || !lvls.tp1) return null;

    // MTF context
    const ctx = Detectors.ctx(m15, h1, h4, cat);

    const risk   = Math.abs(lvls.entry - lvls.sl);
    const reward = Math.abs(lvls.tp2   - lvls.entry);
    const rr     = risk > 0 ? `1:${(reward / risk).toFixed(1)}` : 'N/A';
    lvls.rr      = rr;

    return {
      id:          `${symbol}_${Date.now()}`,
      symbol,
      name:        cfg.name,
      cat,
      dir:         best.dir,
      strategy:    { id: best.id, name: best.name, score: best.score },
      quality,
      levels:      lvls,
      confirmedBy: conf.map(s => ({ id: s.id, name: s.name })),
      mtf: {
        h4:    ctx.h4Tr,
        h1:    ctx.h1Tr,
        m15:   ctx.tr,
        align: ctx.align,
        pd:    ctx.pd,
        h1POI: ctx.h1POI?.type || null,
        kz:    ctx.kz,
      },
      indicators: {
        rsi:    Ind.rsi(m15.map(c => c.close)),
        macd:   Ind.macd(m15.map(c => c.close)).hist,
        vol:    Ind.vol(Ind.confirmed(m15), cat),
        atr:    Ind.fmt(ctx.atr, ctx.dec),
      },
      session:   Market.session(),
      source,
      candles:   m15.length,
      timeframe: 'M15',
      ts:        new Date().toISOString(),
      expiresAt: new Date(Date.now() + CONFIG.EXPIRY_MIN * 60000).toISOString(),
      expired:   false,
      slHit:     false,
    };
  }

  // ── SL / TP from live candle data per strategy ────────────
  static levels(sig, m15, h1, h4, cat) {
    const c   = Ind.confirmed(m15);
    const cls = c.map(x => x.close);
    const atr = Ind.atr(c);
    const price = cls[cls.length - 1];
    const dec = Ind.dec(price);
    const f   = v => Ind.fmt(v, dec);
    const dir = sig.dir;
    const isBuy = dir === 'BUY';

    // H1 structure for SL fallback
    const h1Atr = h1?.length >= 10 ? Ind.atr(h1) : atr;
    const h1SwH = h1?.length >= 10 ? Ind.swingHighs(h1, 3) : [];
    const h1SwL = h1?.length >= 10 ? Ind.swingLows(h1, 3)  : [];
    const nearH1Low  = h1SwL.filter(s => s.v < price).sort((a,b) => b.v - a.v)[0];
    const nearH1High = h1SwH.filter(s => s.v > price).sort((a,b) => a.v - b.v)[0];

    // M15 swings for TP
    const m15SwH = Ind.swingHighs(c, 3).filter(s => s.v > price);
    const m15SwL = Ind.swingLows(c, 3).filter(s => s.v < price);
    const nearM15High = m15SwH.length ? m15SwH[0].v : price + atr * 2;
    const nearM15Low  = m15SwL.length ? m15SwL[m15SwL.length-1].v : price - atr * 2;

    let entry = f(price), sl = null, tp1 = null, tp2 = null, tp3 = null;

    // ── Entry ─────────────────────────────────────────────────
    // Entry is always at the current M15 close (confirmed candle close = market order on signal)
    // For zone-based strategies, entry is at the zone edge closest to price
    const buf = atr * 0.1; // tiny buffer to avoid spread

    switch (sig.id) {
      case 'FVG_OB':
        entry = f(sig.sl_ref.val + buf * (isBuy ? 1 : -1));
        break;
      case 'LIQ_SWEEP':
        entry = f(sig.tp_ref.tp1_val + buf * (isBuy ? 1 : -1));
        break;
      case 'CHOCH':
        entry = f(sig.brokenLevel + buf * (isBuy ? 1 : -1));
        break;
      case 'FPB':
        entry = f(sig.brokenLevel + buf * (isBuy ? 1 : -1));
        break;
      case 'OTE':
        entry = f(price); // at current price inside OTE zone
        break;
      case 'BREAKER':
        entry = f(isBuy ? sig.sl_ref.val + buf : sig.sl_ref.val - buf);
        break;
      case 'SILVER_BULLET':
        entry = f(isBuy ? sig.sl_ref.val + buf : sig.sl_ref.val - buf);
        break;
      case 'ORB':
        entry = f(isBuy ? sig.tp_ref.tp1_val - (sig.tp_ref.tp1_val - price) + buf : sig.tp_ref.tp1_val + (price - sig.tp_ref.tp1_val) - buf);
        entry = f(price); // ORB entry is at current price (close above/below breakout)
        break;
      case 'CRT':
        entry = f(price);
        break;
      case 'PO3':
        entry = f(isBuy ? sig.tp_ref.tp1_val - (sig.tp_ref.tp1_val - price) : price);
        entry = f(price);
        break;
      case 'FVG_BOS_HTF':
        entry = f(isBuy ? sig.sl_ref.val + buf : sig.sl_ref.val - buf);
        break;
      default:
        entry = f(price);
    }

    // ── SL — strictly from strategy's own structure ───────────
    switch (sig.id) {
      case 'FVG_OB':
        // SL below OB/FVG bottom (BUY) / above OB/FVG top (SELL)
        sl = f(isBuy ? sig.sl_ref.val - atr * 0.2 : sig.sl_ref.val + atr * 0.2);
        break;
      case 'LIQ_SWEEP':
        // SL beyond sweep wick
        sl = f(isBuy ? sig.sl_ref.val - atr * 0.15 : sig.sl_ref.val + atr * 0.15);
        break;
      case 'CHOCH':
        // SL below/above the break candle
        sl = f(isBuy ? sig.sl_ref.val - atr * 0.2 : sig.sl_ref.val + atr * 0.2);
        break;
      case 'FPB':
        // SL beyond broken level
        sl = f(sig.sl_ref.val);
        break;
      case 'OTE':
        // SL below H1 OB bottom
        sl = f(isBuy ? sig.sl_ref.val - atr * 0.15 : sig.sl_ref.val + atr * 0.15);
        break;
      case 'BREAKER':
        // SL beyond breaker block
        sl = f(isBuy ? sig.sl_ref.val - atr * 0.2 : sig.sl_ref.val + atr * 0.2);
        break;
      case 'SILVER_BULLET':
        // SL below/above FVG
        sl = f(isBuy ? sig.sl_ref.val - atr * 0.2 : sig.sl_ref.val + atr * 0.2);
        break;
      case 'ORB':
        // SL opposite side of ORB range
        sl = f(sig.sl_ref.val);
        break;
      case 'CRT':
        // SL beyond the swept wick
        sl = f(isBuy ? sig.sl_ref.val - atr * 0.15 : sig.sl_ref.val + atr * 0.15);
        break;
      case 'PO3':
        // SL beyond manipulation wick
        sl = f(isBuy ? sig.sl_ref.val - atr * 0.15 : sig.sl_ref.val + atr * 0.15);
        break;
      case 'FVG_BOS_HTF':
        sl = f(isBuy ? sig.sl_ref.val - atr * 0.2 : sig.sl_ref.val + atr * 0.2);
        break;
      default:
        sl = isBuy
          ? f(nearH1Low ? nearH1Low.v - h1Atr * 0.2 : price - atr * 2.5)
          : f(nearH1High ? nearH1High.v + h1Atr * 0.2 : price + atr * 2.5);
    }

    // ── TP1 — from strategy's own live structure ──────────────
    switch (sig.id) {
      case 'FVG_OB':
        tp1 = f(sig.tp_ref.tp1_val); // opposite edge of FVG/OB
        break;
      case 'LIQ_SWEEP':
        tp1 = f(sig.tp_ref.tp1_val); // swept level (now acts as S/R)
        break;
      case 'CHOCH':
      case 'FPB':
        tp1 = f(sig.tp_ref.tp1_val); // prior swing
        break;
      case 'OTE':
        tp1 = f(sig.tp_ref.tp1_val); // swing high/low
        break;
      case 'BREAKER':
        tp1 = f(sig.tp_ref.tp1_val); // origin of displacement
        break;
      case 'SILVER_BULLET':
        tp1 = f(sig.tp_ref.tp1_val); // kill zone high/low
        break;
      case 'ORB':
        tp1 = f(sig.tp_ref.tp1_val); // 1× range projection
        break;
      case 'CRT':
        tp1 = f(sig.tp_ref.tp1_val); // HTF candle body midpoint
        break;
      case 'PO3':
        tp1 = f(sig.tp_ref.tp1_val); // opposite side of Asian range
        break;
      case 'FVG_BOS_HTF':
        tp1 = f(sig.tp_ref.tp1_val);
        break;
      default:
        tp1 = isBuy ? f(nearM15High) : f(nearM15Low);
    }

    // ── TP2 — nearest H1 swing beyond TP1 ────────────────────
    if (isBuy) {
      const h1Above = h1SwH.filter(s => s.v > (tp1 || price)).sort((a,b) => a.v - b.v)[0];
      tp2 = h1Above ? f(h1Above.v) : f((tp1 || price) + Math.abs((tp1||price) - (entry||price)));
      // ORB/CRT: use their own TP2
      if (sig.id === 'ORB' || sig.id === 'CRT' || sig.id === 'PO3') tp2 = f(sig.tp_ref.tp2_val);
    } else {
      const h1Below = h1SwL.filter(s => s.v < (tp1 || price)).sort((a,b) => b.v - a.v)[0];
      tp2 = h1Below ? f(h1Below.v) : f((tp1 || price) - Math.abs((entry||price) - (tp1||price)));
      if (sig.id === 'ORB' || sig.id === 'CRT' || sig.id === 'PO3') tp2 = f(sig.tp_ref.tp2_val);
    }

    // ── TP3 — 3× risk extension ───────────────────────────────
    const risk3 = entry && sl ? Math.abs(entry - sl) * 3 : atr * 4;
    tp3 = isBuy ? f((entry || price) + risk3) : f((entry || price) - risk3);

    // ── Enforce ordering ──────────────────────────────────────
    if (isBuy) {
      if (entry && sl && sl >= entry) sl  = f(entry - atr);
      if (tp1 && entry && tp1 <= entry) tp1 = f(entry + atr * 1.5);
      if (tp2 && tp1  && tp2 <= tp1)   tp2 = f(tp1  + atr * 1.5);
      if (tp3 && tp2  && tp3 <= tp2)   tp3 = f(tp2  + atr * 2);
    } else {
      if (entry && sl && sl <= entry) sl  = f(entry + atr);
      if (tp1 && entry && tp1 >= entry) tp1 = f(entry - atr * 1.5);
      if (tp2 && tp1  && tp2 >= tp1)   tp2 = f(tp1  - atr * 1.5);
      if (tp3 && tp2  && tp3 >= tp2)   tp3 = f(tp2  - atr * 2);
    }

    return { entry, sl, tp1, tp2, tp3 };
  }
}

// ═════════════════════════════════════════════════════════════
//  SECTION 4 — DATA FETCHERS
// ═════════════════════════════════════════════════════════════

class TDFetcher {
  constructor() { this.lastCall = 0; }

  async fetch(symbol, interval, size = 130) {
    if (!CONFIG.TWELVE_DATA_KEY) return null;
    const wait = 8000 - (Date.now() - this.lastCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this.lastCall = Date.now();
    try {
      const res = await axios.get(`${CONFIG.TWELVE_DATA_URL}/time_series`, {
        params: { symbol, interval, outputsize: size, apikey: CONFIG.TWELVE_DATA_KEY },
        timeout: 15000,
      });
      const d = res.data;
      if (d.status === 'error' || !d.values?.length) { console.error(`[TD] ${symbol}/${interval}: ${d.message}`); return null; }
      return d.values.reverse().map(b => ({
        time: new Date(b.datetime).getTime(),
        open: +b.open, high: +b.high, low: +b.low, close: +b.close,
        volume: +(b.volume || 0) || 1,
      }));
    } catch (e) { console.error(`[TD] ${symbol}/${interval}: ${e.message}`); return null; }
  }
}

// ── Finnhub Fetcher — primary for Forex + Gold ───────────────────────────────
// Free tier: 60 calls/min. Real M15 OHLC from institutional brokers.
// Docs: https://finnhub.io/docs/api/forex-candles
class FinnhubFetcher {
  constructor() {
    this.key     = CONFIG.FINNHUB_KEY;
    this.baseUrl = CONFIG.FINNHUB_URL;
    this.cache   = {};           // symbol → { m15, h1, h4, time }
    this.ttlM15  = 12 * 60000;  // 12 min
    this.ttlH1   = 25 * 60000;  // 25 min
    this.lastCall = 0;
    this.minGap  = 200;          // ms between calls (well under 60/min)
  }

  get available() { return !!this.key; }

  async _wait() {
    const gap = this.minGap - (Date.now() - this.lastCall);
    if (gap > 0) await new Promise(r => setTimeout(r, gap));
    this.lastCall = Date.now();
  }

  // resolution: '15' (15min) | '60' (1h) | '240' (4h)
  // Returns candles oldest→newest, or null on failure
  async fetchCandles(fhSymbol, resolution = '15', days = 3) {
    if (!this.available) return null;
    await this._wait();
    const to   = Math.floor(Date.now() / 1000);
    const from = to - days * 86400;
    try {
      const res = await axios.get(`${this.baseUrl}/forex/candle`, {
        params: { symbol: fhSymbol, resolution, from, to, token: this.key },
        timeout: 15000,
      });
      const d = res.data;
      if (d.s !== 'ok' || !d.t?.length) {
        // 'no_data' means market closed or no candles in range — not an error
        if (d.s !== 'no_data') console.warn(`[FH] ${fhSymbol}/${resolution}: status=${d.s}`);
        return null;
      }
      const candles = d.t.map((ts, i) => ({
        time:   ts * 1000,
        open:   d.o[i], high: d.h[i],
        low:    d.l[i], close: d.c[i],
        volume: d.v?.[i] || 1,
      }));
      console.log(`[FH] ✅ ${fhSymbol} [${resolution}m]: ${candles.length} candles`);
      return candles;
    } catch (e) {
      const status = e.response?.status;
      if (status === 429) console.warn('[FH] Rate limited — slow down');
      else console.error(`[FH] ${fhSymbol}/${resolution}: ${status || e.message}`);
      return null;
    }
  }

  // Fetch M15 + H1 + H4 for a symbol, with cache
  async fetchMTF(fhSymbol) {
    const cached = this.cache[fhSymbol];
    if (cached && Date.now() - cached.time < this.ttlM15) return cached;

    const m15 = await this.fetchCandles(fhSymbol, '15', 3);
    if (!m15 || m15.length < 10) return cached || null;

    // H1 — only refetch if stale
    let h1 = cached?.h1 || null;
    if (!h1 || Date.now() - (cached?.h1Time || 0) > this.ttlH1) {
      h1 = await this.fetchCandles(fhSymbol, '60', 7);
    }

    // H4
    const h4 = await this.fetchCandles(fhSymbol, '240', 30);

    const result = {
      m15, h1: h1 || [], h4: h4 || [],
      time: Date.now(), h1Time: Date.now(),
    };
    this.cache[fhSymbol] = result;
    return result;
  }
}

class DeltaFetcher {
  // Delta Exchange India — https://api.india.delta.exchange
  // Public API, no key needed. Real M15 OHLC.
  // Docs: https://docs.delta.exchange/#get-ohlc-candles
  constructor() {
    this.baseUrl  = 'https://api.india.delta.exchange';
    this.cache    = {};   // symbol → { m15, h1, time }
    this.ttlM15   = 12 * 60000; // 12 min cache (just under M15 cycle)
    this.ttlH1    = 25 * 60000; // 25 min cache for H1
    this.lastCall = 0;
    this.minGap   = 300;  // ms between calls (Delta allows ~5 req/sec)
  }

  // Rate limit guard — 300ms between calls
  async _wait() {
    const gap = this.minGap - (Date.now() - this.lastCall);
    if (gap > 0) await new Promise(r => setTimeout(r, gap));
    this.lastCall = Date.now();
  }

  // Fetch candles from Delta Exchange
  // resolution: '15m' | '1h' | '4h'
  // returns candles oldest→newest, or null on failure
  async fetchCandles(symbol, resolution = '15m', days = 2) {
    await this._wait();
    const end   = Math.floor(Date.now() / 1000);
    const start = end - days * 86400;
    try {
      const res = await axios.get(`${this.baseUrl}/v2/history/candles`, {
        params: { symbol, resolution, start, end },
        headers: { 'Accept': 'application/json', 'User-Agent': 'HybridTradingBot/9.1' },
        timeout: 15000,
      });
      const raw = res.data?.result;
      if (!raw?.length) { console.warn(`[Delta] No data for ${symbol}/${resolution}`); return null; }
      // Delta returns newest-first — reverse to oldest-first
      const candles = raw.reverse().map(d => ({
        time:   d.time * 1000,  // seconds → ms
        open:   parseFloat(d.open),
        high:   parseFloat(d.high),
        low:    parseFloat(d.low),
        close:  parseFloat(d.close),
        volume: parseFloat(d.volume || 0),
      }));
      console.log(`[Delta] ✅ ${symbol} [${resolution}]: ${candles.length} candles`);
      return candles;
    } catch (e) {
      const status = e.response?.status;
      console.error(`[Delta] ${symbol}/${resolution}: ${status || e.message}`);
      return null;
    }
  }

  // Fetch M15 + H1 + H4 for a symbol, with cache
  async fetchMTF(symbol) {
    const cached = this.cache[symbol];
    // Return cache if M15 is fresh
    if (cached && Date.now() - cached.time < this.ttlM15) {
      return cached;
    }
    // Fetch M15 (2 days = ~192 candles)
    const m15 = await this.fetchCandles(symbol, '15m', 2);
    if (!m15 || m15.length < 10) return cached || null; // fallback to stale

    // Fetch H1 (7 days = 168 candles) — only if H1 cache stale
    let h1 = cached?.h1 || null;
    if (!h1 || Date.now() - cached.h1Time > this.ttlH1) {
      h1 = await this.fetchCandles(symbol, '1h', 7);
    }

    // H4 — fetch directly (Delta supports it)
    let h4 = await this.fetchCandles(symbol, '4h', 30);

    const result = { m15, h1: h1 || [], h4: h4 || [], time: Date.now(), h1Time: Date.now() };
    this.cache[symbol] = result;
    return result;
  }

  // Prefetch all symbols (called at cycle start)
  async prefetchAll(symbols) {
    console.log(`[Delta] Prefetching ${symbols.length} symbols...`);
    for (let i = 0; i < symbols.length; i++) {
      await this.fetchCandles(symbols[i], '15m', 2);
      if (i < symbols.length - 1) await new Promise(r => setTimeout(r, 400));
    }
    console.log('[Delta] Prefetch done');
  }
}


// ── CoinGecko Fallback — only used when Delta Exchange fails ─────────────────
// Simpler than the old CGFetcher: no prefetch, just fetch on demand.
// Returns 30-min candles (best CG free tier offers) as M15 proxy.
class CGFallback {
  constructor() {
    this.cache   = {};          // cgId → { candles, time }
    this.ttl     = 15 * 60000; // 15 min cache
    this.backoff = 0;
    this.lastCall = 0;
  }

  async fetch(cgId) {
    // Return cache if fresh
    if (this.cache[cgId] && Date.now() - this.cache[cgId].time < this.ttl)
      return this.cache[cgId].candles;
    // Respect backoff
    if (this.backoff > Date.now()) {
      console.log(`[CG-FB] Backoff — returning cache for ${cgId}`);
      return this.cache[cgId]?.candles || null;
    }
    // Rate limit: 2s between calls
    const gap = 2000 - (Date.now() - this.lastCall);
    if (gap > 0) await new Promise(r => setTimeout(r, gap));
    this.lastCall = Date.now();
    try {
      const res = await axios.get(`${CONFIG.CG_URL}/coins/${cgId}/ohlc`, {
        params: { vs_currency: 'usd', days: 1 },
        headers: { 'Accept': 'application/json', 'User-Agent': 'HybridTradingBot/9.3' },
        timeout: 15000,
      });
      if (!res.data?.length) return this.cache[cgId]?.candles || null;
      const candles = res.data.map(([t, o, h, l, cv]) => ({
        time: t, open: o, high: h, low: l, close: cv, volume: 500000,
      }));
      this.cache[cgId] = { candles, time: Date.now() };
      console.log(`[CG-FB] ✅ ${cgId}: ${candles.length} candles (30-min proxy)`);
      return candles;
    } catch (e) {
      if (e.response?.status === 429) {
        this.backoff = Date.now() + 120000;
        console.warn('[CG-FB] 429 — 2 min backoff');
      } else {
        console.error(`[CG-FB] ${cgId}: ${e.message}`);
      }
      return this.cache[cgId]?.candles || null;
    }
  }
}

class DhanFetcher {
  constructor() {}

  isWeekday() {
    const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getDay();
    return d >= 1 && d <= 5;
  }

  fmtDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  async fetch(symbol, interval = 'FIFTEEN_MINUTE') {
    const tk = dhanToken.accessToken !== 'placeholder' ? dhanToken.accessToken : CONFIG.DHAN_ACCESS_TOKEN || 'placeholder';
    const cl = dhanToken.clientId    !== 'placeholder' ? dhanToken.clientId    : CONFIG.DHAN_CLIENT_ID    || 'placeholder';
    if (tk === 'placeholder') { console.log(`[Dhan] No token — skipping ${symbol}`); return null; }
    if (!this.isWeekday())    { console.log(`[Dhan] Weekend — skip`); return null; }

    const cfg = SYMBOLS[symbol];
    const to  = new Date(), from = new Date(); from.setDate(from.getDate() - 10);
    try {
      const res = await axios.post(`${CONFIG.DHAN_URL}/v2/charts/historical`, {
        securityId: cfg.dhanId, exchangeSegment: cfg.seg || 'IDX_I',
        instrument: 'INDEX', expiryCode: 0, oi: false,
        fromDate: this.fmtDate(from), toDate: this.fmtDate(to),
        interval,
      }, {
        headers: { 'access-token': tk, 'client-id': cl, 'Content-Type': 'application/json' },
        timeout: 15000,
      });
      const d = res.data;
      if (!d?.open?.length) return null;
      const candles = d.timestamp.map((t, i) => ({
        time: t * 1000, open: d.open[i], high: d.high[i],
        low: d.low[i], close: d.close[i], volume: d.volume?.[i] || 0,
      }));
      console.log(`[Dhan] ✅ ${symbol}: ${candles.length} candles (${interval})`);
      return candles;
    } catch (e) {
      const msg = e.response?.data?.remarks || e.response?.data?.message || e.message;
      console.error(`[Dhan] ${symbol}: ${e.response?.status} — ${msg}`);
      if (msg?.toLowerCase().includes('token')) console.error('[Dhan] ⚠️  Token expired — POST /api/dhan/token to update');
      return null;
    }
  }
}

class DataFetcher {
  constructor() {
    this.td      = new TDFetcher();
    this.fh      = new FinnhubFetcher();
    this.delta   = new DeltaFetcher();
    this.cgFb    = new CGFallback();     // CoinGecko fallback for crypto
    this.dhan    = new DhanFetcher();
    this.cache = {};     // symbol → last known M15 candles
    this.mtfCache = {}; // symbol_mtf → { data, time }
    this.mtfTTL   = 14 * 60000; // 14 min (just under M15 cycle)
  }

  resample(candles, n) {
    if (!candles || candles.length < n) return candles;
    const out = [];
    for (let i = 0; i + n <= candles.length; i += n) {
      const sl = candles.slice(i, i + n);
      out.push({ time: sl[0].time, open: sl[0].open,
        high: Math.max(...sl.map(c => c.high)),
        low:  Math.min(...sl.map(c => c.low)),
        close: sl[sl.length - 1].close,
        volume: sl.reduce((s, c) => s + (c.volume || 0), 0) });
    }
    return out;
  }

  async fetchMTF(symbol) {
    const cfg = SYMBOLS[symbol];
    if (!cfg) return null;
    const key = `${symbol}_mtf`;

    // Use cache if fresh (avoid hammering APIs on every 15-min cycle)
    if (this.mtfCache[key] && Date.now() - this.mtfCache[key].time < this.mtfTTL)
      return this.mtfCache[key].data;

    let m15 = null, h1 = null, h4 = null, source = 'unknown';

    try {
      if (cfg.src === 'td') {
        // ── Primary: Finnhub (60 req/min, fast) ─────────────────────
        if (this.fh.available && cfg.fh) {
          const fhData = await this.fh.fetchMTF(cfg.fh);
          if (fhData?.m15?.length >= 10) {
            m15 = fhData.m15;
            h1  = fhData.h1?.length ? fhData.h1 : null;
            h4  = fhData.h4?.length ? fhData.h4 : null;
            source = 'finnhub';
            console.log(`[FH] ✅ ${symbol}: M15(${m15.length}) H1(${h1?.length||0}) H4(${h4?.length||0})`);
          }
        }
        // ── Fallback: TwelveData (8 req/min) ────────────────────────
        if (!m15 || m15.length < 10) {
          console.log(`[TD] ${source === 'finnhub' ? '' : 'Finnhub unavailable — '}using TwelveData for ${symbol}`);
          m15 = await this.td.fetch(cfg.td, '15min', 130);
          h1  = m15 ? await this.td.fetch(cfg.td, '1h', 100) : null;
          h4  = m15 ? await this.td.fetch(cfg.td, '4h', 60)  : null;
          source = m15 ? 'twelvedata' : 'failed';
        }

      } else if (cfg.src === 'delta') {
        // ── Primary: Delta Exchange India (real M15, no API key) ────
        const dtf = await this.delta.fetchMTF(cfg.deltaSymbol);
        if (dtf?.m15?.length >= 10) {
          m15 = dtf.m15;
          h1  = dtf.h1?.length ? dtf.h1 : null;
          h4  = dtf.h4?.length ? dtf.h4 : null;
          source = 'delta';
        }
        // ── Fallback: CoinGecko (30-min proxy if Delta fails) ────────
        if (!m15 || m15.length < 10) {
          console.log(`[CG-FB] Delta failed for ${symbol} — trying CoinGecko fallback`);
          const cgCandles = await this.cgFb.fetch(cfg.cgId);
          if (cgCandles?.length >= 10) {
            m15    = cgCandles;
            h1     = this.resample(cgCandles, 2);  // 2 × 30min = 1h proxy
            h4     = this.resample(cgCandles, 8);  // 8 × 30min = 4h proxy
            source = 'coingecko_fallback';
            console.log(`[CG-FB] ✅ ${symbol}: using CoinGecko (${cgCandles.length} candles)`);
          }
        }

      } else if (cfg.src === 'dhan') {
        // Dhan: fetch M15 directly, resample for H1 and H4
        m15 = await this.dhan.fetch(symbol, 'FIFTEEN_MINUTE');
        if (m15 && m15.length >= 20) {
          h1 = this.resample(m15, 4);   // 4 × 15min = 1h
          h4 = this.resample(m15, 16);  // 16 × 15min = 4h
        }
        source = 'dhan';
      }
    } catch (e) { console.error(`[DataFetcher] ${symbol}:`, e.message); }

    // Fallback to cache if fetch failed
    if (!m15 || m15.length < 15) {
      if (this.cache[symbol]) { m15 = this.cache[symbol]; source = 'cache'; }
    }
    if (!m15 || m15.length < 15) return null;

    // Cache M15
    this.cache[symbol] = m15;

    // Build HTF if missing
    if (!h1 || h1.length < 8)  h1 = this.resample(m15, 4);
    if (!h4 || h4.length < 4)  h4 = this.resample(m15, 16);

    const result = { m15, h1, h4, source };
    this.mtfCache[key] = { data: result, time: Date.now() };
    return result;
  }
}

const dataFetcher = new DataFetcher();

// ═════════════════════════════════════════════════════════════
//  SECTION 5 — TELEGRAM
// ═════════════════════════════════════════════════════════════

async function tgSend(text) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: CONFIG.TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown', disable_web_page_preview: true },
      { timeout: 10000 }
    );
  } catch (e) { console.error('[TG] Send error:', e.message); }
}

async function tgSignal(sig) {
  const em  = sig.dir === 'BUY' ? '🟢' : '🔴';
  const bar = '█'.repeat(Math.floor(sig.quality / 10)) + '░'.repeat(10 - Math.floor(sig.quality / 10));
  const pd  = sig.mtf?.pd ? `${sig.mtf.pd.zone} (${sig.mtf.pd.pct}%)` : 'N/A';
  const confirms = sig.confirmedBy.map(s => `  • ${s.name}`).join('\n');
  const exp = sig.expiresAt ? new Date(sig.expiresAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : 'N/A';

  const msg = `${em} *${sig.dir} — ${sig.symbol}*
━━━━━━━━━━━━━━━━━━━━
📊 *${sig.name}* | ${sig.cat.toUpperCase()}
⚡ *${sig.strategy.name}*
💯 Quality: *${sig.quality}/100* [${bar}]

📡 *Bias:* H4:${sig.mtf.h4} | H1:${sig.mtf.h1} | M15:${sig.mtf.m15} [${sig.mtf.align}]
🌍 *Session:* ${sig.session} | KZ: ${sig.mtf.kz ? '✅' : '❌'}
📍 *Zone:* ${pd} | H1 POI: ${sig.mtf.h1POI || 'none'}

💰 *Entry:*  \`${sig.levels.entry}\`
🛑 *SL:*     \`${sig.levels.sl}\`
🎯 *TP1:*   \`${sig.levels.tp1}\`
🎯 *TP2:*   \`${sig.levels.tp2}\`
🎯 *TP3:*   \`${sig.levels.tp3}\`
📐 *R:R:*   ${sig.levels.rr}
⏱ *Expires:* ${exp} IST | M15 entry | H1 SL

📈 RSI: ${sig.indicators.rsi} | Vol: ${sig.indicators.vol.ratio}x | ATR: ${sig.indicators.atr}

✅ *Confirmed by:*
${confirms}

🔌 ${sig.source.toUpperCase()} | ${sig.candles} M15 candles
🕑 ${new Date(sig.ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
⚠️ _Educational use only_`;

  await tgSend(msg);
  console.log(`[TG] ✅ Sent: ${sig.dir} ${sig.symbol} | Q:${sig.quality}`);
}

async function tgClosed(cat, symbol) {
  const msg = Market.closedMessage(cat, symbol);
  // Only send once per cycle per category (not per symbol — would spam)
  console.log(`[Market] ${msg}`);
  // NOTE: We do NOT send per-symbol closed messages to Telegram — too noisy.
  // The cycle summary handles this.
}

async function tgExpiry(sig, reason) {
  const em  = reason === 'SL_HIT' ? '❌' : '⏱';
  const msg = reason === 'SL_HIT'
    ? `${em} *SL HIT* — ${sig.dir} ${sig.symbol}\nStrategy: ${sig.strategy.name}\nSL: \`${sig.levels.sl}\``
    : `${em} *EXPIRED* — ${sig.dir} ${sig.symbol} (${sig.strategy.name})\nNo TP hit in ${CONFIG.EXPIRY_MIN} min.`;
  await tgSend(msg);
}

// ═════════════════════════════════════════════════════════════
//  SECTION 6 — SIGNAL GATE
// ═════════════════════════════════════════════════════════════
class Gate {
  constructor() {
    this._hist = [];
    this._cd   = {};
  }

  check(sig, price) {
    const now = Date.now(), sym = sig.symbol;
    const cdMs   = CONFIG.COOLDOWN_MIN  * 60000;
    const flipMs = CONFIG.FLIP_BLOCK_MIN * 60000;

    if (sig.quality < CONFIG.SIGNAL_QUALITY_MIN)
      return { ok: false, why: `Q${sig.quality} < min` };

    if (sig.confirmedBy.length < 2)
      return { ok: false, why: `Only ${sig.confirmedBy.length} strategy` };

    // Price drift: entry must be within 0.5% of live price
    if (sig.levels?.entry) {
      const drift = Math.abs(sig.levels.entry - price) / price;
      if (drift > 0.005) return { ok: false, why: `Price drifted ${(drift*100).toFixed(2)}%` };
    }

    if (this._cd[sym] && now - this._cd[sym] < cdMs) {
      const left = Math.ceil((cdMs - (now - this._cd[sym])) / 60000);
      return { ok: false, why: `Cooldown ${left}m` };
    }

    const prev = this._hist.filter(h => h.sym === sym && now - h.t < flipMs);
    if (prev.length && prev[0].dir !== sig.dir)
      return { ok: false, why: `Direction flip blocked ${CONFIG.FLIP_BLOCK_MIN}m` };

    const dup = this._hist.find(h => h.sym === sym && h.id === sig.strategy.id && h.dir === sig.dir && now - h.t < 3 * 3600000);
    if (dup) return { ok: false, why: `Dup ${sig.strategy.id} within 3h` };

    return { ok: true };
  }

  record(sig) {
    this._cd[sig.symbol] = Date.now();
    this._hist.unshift({ sym: sig.symbol, dir: sig.dir, id: sig.strategy.id, t: Date.now() });
    if (this._hist.length > 300) this._hist = this._hist.slice(0, 300);
  }

  cooldowns() {
    const now = Date.now(), ms = CONFIG.COOLDOWN_MIN * 60000;
    return Object.entries(this._cd).map(([sym, t]) => ({ sym, left: Math.max(0, Math.ceil((ms - (now - t)) / 60000)) }));
  }
}

const gate = new Gate();

// ═════════════════════════════════════════════════════════════
//  SECTION 7 — BOT STATE & EXPIRY CHECKER
// ═════════════════════════════════════════════════════════════
const state = {
  signals: [],
  stats: { total: 0, blocked: 0, analyzed: 0, startTime: Date.now() },
  lastCycle: null,
  running: false,
  closedNotified: {}, // cat → last notification time
};

async function checkExpiry() {
  const active = state.signals.filter(s => !s.expired && !s.slHit);
  for (const sig of active) {
    // Time expiry
    if (new Date(sig.expiresAt) < new Date()) {
      sig.expired = true;
      await tgExpiry(sig, 'EXPIRED');
      continue;
    }
    // SL check
    const mtf = dataFetcher.mtfCache[`${sig.symbol}_mtf`];
    if (!mtf?.data?.m15?.length || !sig.levels?.sl) continue;
    const price = mtf.data.m15[mtf.data.m15.length - 1].close;
    const slHit = sig.dir === 'BUY' ? price <= sig.levels.sl : price >= sig.levels.sl;
    if (slHit) {
      sig.slHit = true;
      await tgExpiry(sig, 'SL_HIT');
    }
  }
}

// ═════════════════════════════════════════════════════════════
//  SECTION 8 — ANALYSIS CYCLE
//  Runs every 15 min aligned to M15 candle close.
//  Skips closed markets (sends one Telegram message per category).
// ═════════════════════════════════════════════════════════════
async function runCycle() {
  if (state.running) return;
  state.running = true;
  const t0 = Date.now();
  const ist = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  console.log(`\n[v9.1] ⚡ M15 Cycle — ${ist}`);

  // Prefetch all Delta crypto symbols
  const deltaSyms = Object.values(SYMBOLS).filter(s => s.src === 'delta').map(s => s.deltaSymbol);
  await dataFetcher.delta.prefetchAll(deltaSyms).catch(() => {});

  // Track which categories are closed this cycle (send one message per cat)
  const closedSent = new Set();
  let cycleSignals = 0, cycleBlocked = 0;

  for (const [symbol, cfg] of Object.entries(SYMBOLS)) {
    try {
      state.stats.analyzed++;

      // ── Market hours check ─────────────────────────────────
      if (!Market.isOpen(cfg.cat)) {
        if (!closedSent.has(cfg.cat)) {
          closedSent.add(cfg.cat);
          const now = Date.now();
          const lastNotif = state.closedNotified[cfg.cat] || 0;
          // Send closed message at most once per hour per category
          if (now - lastNotif > 3600000) {
            state.closedNotified[cfg.cat] = now;
            const catLabel = { india: 'India NSE/BSE', forex: 'Forex/Commodity', crypto: 'Crypto' };
            await tgSend(`🔴 *${catLabel[cfg.cat] || cfg.cat} Market Closed*\n${Market.closedMessage(cfg.cat, symbol)}`);
          }
        }
        console.log(`[v9.1] 🔴 ${symbol}: ${cfg.cat} market closed`);
        continue;
      }

      // ── Fetch candles ──────────────────────────────────────
      const mtf = await dataFetcher.fetchMTF(symbol);
      if (!mtf?.m15?.length) { console.log(`[v9.1] ⚠️  No data: ${symbol}`); continue; }

      // ── Build signal ───────────────────────────────────────
      const sig      = Builder.build(symbol, mtf.m15, mtf.source, mtf);
      const curPrice = mtf.m15[mtf.m15.length - 1].close;

      if (!sig) { console.log(`[v9.1] ℹ️  No signal: ${symbol}`); continue; }

      // ── Gate check ─────────────────────────────────────────
      const g = gate.check(sig, curPrice);
      if (!g.ok) {
        cycleBlocked++; state.stats.blocked++;
        console.log(`[v9.1] 🚫 ${symbol}: ${g.why}`);
        continue;
      }

      // ✅ Signal passes all checks
      gate.record(sig);
      state.signals.unshift(sig);
      if (state.signals.length > CONFIG.MAX_SIGNALS) state.signals = state.signals.slice(0, CONFIG.MAX_SIGNALS);
      state.stats.total++;
      cycleSignals++;

      console.log(`[v9.1] ✅ ${sig.dir} ${symbol} | Q:${sig.quality} | ${sig.strategy.id} | ${sig.mtf.align} | ${sig.mtf.pd?.zone}`);
      await tgSignal(sig);
      await new Promise(r => setTimeout(r, 500));

    } catch (e) { console.error(`[v9.1] Error ${symbol}:`, e.message, e.stack?.split('\n')[1]); }
  }

  await checkExpiry();

  await checkDhanTokenAge();
  state.lastCycle = { signals: cycleSignals, blocked: cycleBlocked, ms: Date.now() - t0, ts: new Date().toISOString() };
  console.log(`[v9.1] ✅ Done — ${cycleSignals} signals | ${cycleBlocked} blocked | ${Date.now() - t0}ms\n`);
  state.running = false;
}

// ═════════════════════════════════════════════════════════════
//  SECTION 9 — API ENDPOINTS
// ═════════════════════════════════════════════════════════════
app.get('/', (req, res) => res.json({
  bot: 'Hybrid Trading Bot v9.1 — ICT/SMC Engine',
  version: '9.4.0',
  strategies: 10,
  symbols: Object.keys(SYMBOLS).length,
  timeframe: 'M15 entry | H1/H4 SL-TP',
  markets: 'India NSE/BSE · Crypto · Forex · Commodity',
  status: 'OPERATIONAL',
}));

app.get('/api/health', (req, res) => {
  const up = Math.floor((Date.now() - state.stats.startTime) / 1000);
  res.json({
    status: 'OK', version: '9.4.0',
    uptime: `${Math.floor(up/3600)}h ${Math.floor((up%3600)/60)}m ${up%60}s`,
    totalSignals: state.stats.total,
    blocked: state.stats.blocked,
    analyzed: state.stats.analyzed,
    activeCooldowns: gate.cooldowns().filter(c => c.left > 0).length,
    lastCycle: state.lastCycle,
    marketStatus: {
      india:     Market.indiaOpen()  ? 'OPEN'   : 'CLOSED',
      forex:     Market.forexOpen()  ? 'OPEN'   : 'CLOSED',
      crypto:    'OPEN (24/7)',
    },
    dataSources: {
      finnhub:    CONFIG.FINNHUB_KEY      ? '✅ primary forex/gold' : '⚠️  add FINNHUB_API_KEY',
      twelvedata: CONFIG.TWELVE_DATA_KEY  ? '✅ fallback forex/gold' : '⚠️  key missing',
      delta:     '✅ crypto primary (real M15)',
      coingecko: '✅ crypto fallback (auto if Delta fails)',
      dhan: dhanToken.accessToken === 'placeholder' ? '⏳ no token — POST /api/dhan/token' :
               dhanToken.updatedMs && (Date.now() - dhanToken.updatedMs) > 86400000 ? '❌ token expired — refresh now' :
               dhanToken.updatedMs && (Date.now() - dhanToken.updatedMs) > 72000000 ? '⚠️  token expiring soon' : '✅ active',
    },
  });
});

app.get('/api/signals',          (req, res) => {
  let sigs = state.signals.slice(0, parseInt(req.query.limit) || 50);
  if (req.query.cat)      sigs = sigs.filter(s => s.cat      === req.query.cat);
  if (req.query.dir)      sigs = sigs.filter(s => s.dir      === req.query.dir.toUpperCase());
  if (req.query.strategy) sigs = sigs.filter(s => s.strategy.id === req.query.strategy.toUpperCase());
  res.json({ count: sigs.length, signals: sigs });
});

app.get('/api/signals/:symbol',  (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  res.json({ symbol: sym, signals: state.signals.filter(s => s.symbol === sym) });
});

app.get('/api/strategies',       (req, res) => res.json({
  version: '9.1', total: 10,
  note: 'All 10 strategies use M15 entry. SL/TP derived from live candle structure per strategy.',
  strategies: [
    { id: 'FVG_OB',       name: 'Fair Value Gap + Order Block',  cat: 'SMC', wr: '60-68%', rr: '1:2-1:4' },
    { id: 'LIQ_SWEEP',    name: 'Liquidity Sweep',               cat: 'ICT', wr: '62-70%', rr: '1:2-1:5' },
    { id: 'CHOCH',        name: 'Change of Character',           cat: 'SMC', wr: '55-62%', rr: '1:2-1:3' },
    { id: 'FPB',          name: 'First Pullback after ChoCh',    cat: 'ICT', wr: '65-70%', rr: '1:2-1:3' },
    { id: 'OTE',          name: 'Optimal Trade Entry',           cat: 'ICT', wr: '65-72%', rr: '1:3-1:6' },
    { id: 'BREAKER',      name: 'Breaker Block',                 cat: 'ICT', wr: '60-68%', rr: '1:2-1:4' },
    { id: 'SILVER_BULLET',name: 'ICT Silver Bullet',             cat: 'ICT', wr: '68-75%', rr: '1:2-1:3' },
    { id: 'ORB',          name: 'Opening Range Breakout',        cat: 'PA',  wr: '55-65%', rr: '1:2-1:3' },
    { id: 'CRT',          name: 'Candle Range Theory (H1+H4)',   cat: 'ICT', wr: '65-72%', rr: '1:2-1:5' },
    { id: 'PO3',          name: 'Power of Three / AMD',          cat: 'ICT', wr: '65-72%', rr: '1:2-1:4' },
    { id: 'FVG_BOS_HTF',  name: 'FVG + BoS + HTF Combo',        cat: 'COMBO', wr: '68-75%', rr: '1:3-1:6' },
  ],
}));

app.get('/api/symbols',          (req, res) => res.json({ total: Object.keys(SYMBOLS).length, symbols: SYMBOLS }));

app.get('/api/stats',            (req, res) => {
  const up = Math.floor((Date.now() - state.stats.startTime) / 1000);
  const byCat = {}, byStrat = {};
  state.signals.forEach(s => {
    byCat[s.cat]          = (byCat[s.cat]          || 0) + 1;
    byStrat[s.strategy.id] = (byStrat[s.strategy.id] || 0) + 1;
  });
  res.json({
    uptime: `${Math.floor(up/3600)}h ${Math.floor((up%3600)/60)}m`,
    total: state.stats.total, blocked: state.stats.blocked, analyzed: state.stats.analyzed,
    avgQuality: state.signals.length ? Math.round(state.signals.reduce((s,x)=>s+x.quality,0)/state.signals.length) : 0,
    cooldowns: gate.cooldowns(),
    byCategory: byCat, byStrategy: byStrat,
    BUY:  state.signals.filter(s => s.dir === 'BUY').length,
    SELL: state.signals.filter(s => s.dir === 'SELL').length,
    lastCycle: state.lastCycle,
  });
});

// Live Dhan token update — no redeploy needed
app.post('/api/dhan/token', (req, res) => {
  const { clientId, accessToken } = req.body;
  if (!clientId || !accessToken) return res.status(400).json({ error: 'Provide clientId + accessToken' });
  dhanToken.clientId    = clientId;
  dhanToken.accessToken = accessToken;
  dhanToken.updatedAt   = new Date().toISOString();
  dhanToken.updatedMs   = Date.now();
  console.log(`[Dhan] ✅ Token updated at ${dhanToken.updatedAt}`);
  tgSend(`✅ *Dhan Token Updated*\nNIFTY/BANKNIFTY/FINNIFTY/SENSEX are now active.\nToken valid until approximately ${new Date(Date.now() + 23*3600000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST tomorrow.`);
  res.json({ ok: true, updatedAt: dhanToken.updatedAt, message: 'India symbols active next cycle' });
});

// Token age check — called in runCycle to warn if expiring soon
async function checkDhanTokenAge() {
  if (dhanToken.accessToken === 'placeholder') return;
  if (!dhanToken.updatedMs) return;
  const ageHours = (Date.now() - dhanToken.updatedMs) / 3600000;
  // Warn at 20 hours (token expires at 24h)
  if (ageHours >= 20 && ageHours < 21) {
    const msg = `⚠️ *Dhan Token Expiring Soon*\nYour token was set ${Math.floor(ageHours)}h ago and expires in ~${Math.ceil(24 - ageHours)}h.\n\nRefresh now:\n1. Go to developer.dhan.co\n2. Generate new token\n3. POST to /api/dhan/token`;
    await tgSend(msg);
    console.log('[Dhan] ⚠️  Token expiring in ~4h — Telegram warning sent');
  }
  // Hard expired (>24h) — warn every cycle
  if (ageHours >= 24) {
    const msg = `❌ *Dhan Token Expired*\nIndia symbols (NIFTY/BANKNIFTY/FINNIFTY/SENSEX) are now offline.\n\nRefresh immediately:\n1. Go to developer.dhan.co\n2. Generate new token\n3. POST to /api/dhan/token`;
    await tgSend(msg);
    console.log('[Dhan] ❌ Token expired — India symbols offline');
  }
}

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ═════════════════════════════════════════════════════════════
//  START
// ═════════════════════════════════════════════════════════════
app.listen(CONFIG.PORT, async () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   HYBRID TRADING BOT v9.4 — ICT/SMC ENGINE      ║
║   10 strategies · M15 entry · H1/H4 SL-TP       ║
║   India NSE/BSE · Crypto · Forex · Commodity    ║
╚══════════════════════════════════════════════════╝
Port: ${CONFIG.PORT} | Quality gate: ${CONFIG.SIGNAL_QUALITY_MIN} | Cooldown: ${CONFIG.COOLDOWN_MIN}min
Symbols: ${Object.keys(SYMBOLS).length} (India:4 · Forex:4 · Gold:1 · Crypto:4) | Auto market hours
  `);

  // Give CoinGecko a moment before first cycle (avoid cold-start 429)
  console.log('[v9.1] Waiting 5s before first cycle (CG rate limit buffer)...');
  await new Promise(r => setTimeout(r, 5000));
  // Startup Telegram notification
  const indiaReady = dhanToken.accessToken !== 'placeholder';
  await tgSend(`🚀 *Hybrid Trading Bot v9.1 Online*
Markets: India NSE/BSE ${indiaReady ? '✅' : '⏳ (add Dhan token)'} | Forex/Gold ✅ (Finnhub+TwelveData) | Crypto ✅ (Delta + CoinGecko fallback)
Strategies: 10 ICT/SMC | Entry: M15 | SL: H1 structure
Quality gate: ${CONFIG.SIGNAL_QUALITY_MIN}/100 | Cooldown: ${CONFIG.COOLDOWN_MIN}min
${!indiaReady ? '\n⚠️ India symbols offline\nPOST /api/dhan/token to activate NIFTY/BANKNIFTY/FINNIFTY/SENSEX' : ''}`);
  await runCycle();

  // Schedule every 15 min aligned to clock (09:15, 09:30, 09:45...)
  // */15 fires at :00, :15, :30, :45 of every hour — perfect M15 alignment
  cron.schedule('*/15 * * * *', runCycle);
  console.log('[v9.1] Cron scheduled: every 15 min. Bot running.\n');
});
