// ============================================================
// HYBRID TRADING BOT v8.2 — PRECISION SIGNAL ENGINE
// ============================================================
// Every strategy now has GENUINE condition detection on live
// candle data. A signal only fires when ALL conditions of that
// strategy are truly met in the market. No random selection.
//
// STRATEGIES IMPLEMENTED (all conditions real):
//   PRICE ACTION  : FVG, Order Block, ChoCh, BoS, Liquidity Sweep,
//                   Support/Resistance, Trendline Break, Inside Bar
//   MOVING AVG    : EMA Crossover, MA Stack, London-NY Overlap, Pullback
//   BREAKOUT      : ORB, Consolidation Breakout, HTF Confirmation
//   MEAN REVERSION: Mean Reversion, Fibonacci, Bollinger Bands, BB Bounce
//   MOMENTUM      : RSI Divergence, MACD Divergence, RSI Extremes, Trend Conf
//   VOLUME        : Volume Confirmation, Gap Fill, Confluence Zone
//   COMBO (12)    : All combinations — ALL sub-conditions must pass
//
// DATA SOURCES:
//   CRYPTO      → CoinGecko (FREE, no key)
//   FOREX/GOLD  → Twelve Data (FREE, key needed)
//   SILVER      → Yahoo Finance (FREE, no key)
//   INDIA NSE   → Dhan API (add token when ready)
//   FALLBACK    → Cache (never fails)
// ============================================================

require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cron    = require('node-cron');

const app = express();
app.use(express.json());

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
  PORT:               process.env.PORT || 5000,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID,

  TWELVE_DATA_API_KEY: process.env.TWELVE_DATA_API_KEY,
  TWELVE_DATA_REST:    'https://api.twelvedata.com',

  COINGECKO_REST: 'https://api.coingecko.com/api/v3',

  DHAN_CLIENT_ID:    process.env.DHAN_CLIENT_ID    || 'placeholder',
  DHAN_ACCESS_TOKEN: process.env.DHAN_ACCESS_TOKEN || 'placeholder',
  DHAN_REST:         'https://api.dhan.co',

  SIGNAL_QUALITY_MIN:  75,   // minimum confluence score to fire signal
  ANALYSIS_INTERVAL:   '*/5 * * * *',
  MAX_SIGNALS_STORED:  200,
  CANDLE_LIMIT:        100,
};

// ============================================================
// SYMBOLS
// ============================================================
const SYMBOLS = {
  EURUSD:    { name: 'EUR/USD',      category: 'forex',     source: 'twelvedata', tdSymbol: 'EUR/USD',  volatility: 'medium' },
  GBPUSD:    { name: 'GBP/USD',      category: 'forex',     source: 'twelvedata', tdSymbol: 'GBP/USD',  volatility: 'high' },
  USDJPY:    { name: 'USD/JPY',      category: 'forex',     source: 'twelvedata', tdSymbol: 'USD/JPY',  volatility: 'medium' },
  AUDUSD:    { name: 'AUD/USD',      category: 'forex',     source: 'twelvedata', tdSymbol: 'AUD/USD',  volatility: 'medium' },
  XAUUSD:    { name: 'Gold/USD',     category: 'commodity', source: 'twelvedata', tdSymbol: 'XAU/USD',  volatility: 'high' },
  XAGUSD:    { name: 'Silver/USD',   category: 'commodity', source: 'yahoo',      yahooSymbol: 'SI=F',  volatility: 'very_high' },
  BTCUSDT:   { name: 'Bitcoin/USDT', category: 'crypto',    source: 'coingecko',  cgId: 'bitcoin',      volatility: 'very_high' },
  ETHUSDT:   { name: 'Ethereum/USDT',category: 'crypto',    source: 'coingecko',  cgId: 'ethereum',     volatility: 'high' },
  XRPUSDT:   { name: 'Ripple/USDT',  category: 'crypto',    source: 'coingecko',  cgId: 'ripple',       volatility: 'very_high' },
  LTCUSDT:   { name: 'Litecoin/USDT',category: 'crypto',    source: 'coingecko',  cgId: 'litecoin',     volatility: 'high' },
  BNBUSDT:   { name: 'BNB/USDT',     category: 'crypto',    source: 'coingecko',  cgId: 'binancecoin',  volatility: 'high' },
  NIFTY:     { name: 'NIFTY 50',     category: 'india',     source: 'dhan',       dhanSecurityId: '13', exchangeSegment: 'IDX_I', volatility: 'medium' },
  BANKNIFTY: { name: 'Bank NIFTY',   category: 'india',     source: 'dhan',       dhanSecurityId: '25', exchangeSegment: 'IDX_I', volatility: 'high' },
  FINNIFTY:  { name: 'Fin NIFTY',    category: 'india',     source: 'dhan',       dhanSecurityId: '27', exchangeSegment: 'IDX_I', volatility: 'high' },
};

// ============================================================
// ── SECTION 1: TECHNICAL INDICATOR LIBRARY ──────────────────
// All raw calculations used by strategy detectors below.
// ============================================================
class Indicators {

  // ── RSI ────────────────────────────────────────────────────
  static rsi(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gains += d; else losses -= d;
    }
    let ag = gains / period, al = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      ag = (ag * (period - 1) + Math.max(d, 0)) / period;
      al = (al * (period - 1) + Math.max(-d, 0)) / period;
    }
    if (al === 0) return 100;
    return parseFloat((100 - 100 / (1 + ag / al)).toFixed(2));
  }

  // ── EMA ────────────────────────────────────────────────────
  static ema(closes, period) {
    if (closes.length < period) return closes[closes.length - 1];
    const k = 2 / (period + 1);
    let val = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) val = closes[i] * k + val * (1 - k);
    return val;
  }

  // ── SMA ────────────────────────────────────────────────────
  static sma(closes, period) {
    if (closes.length < period) return closes[closes.length - 1];
    return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
  }

  // ── MACD ───────────────────────────────────────────────────
  static macd(closes) {
    if (closes.length < 26) return { macdLine: 0, signalLine: 0, histogram: 0 };
    // Calculate full EMA arrays for proper signal line
    const ema12arr = this._emaArray(closes, 12);
    const ema26arr = this._emaArray(closes, 26);
    const macdArr  = ema12arr.map((v, i) => v - ema26arr[i]);
    const signalArr = this._emaArray(macdArr, 9);
    const last = macdArr.length - 1;
    const macdLine   = macdArr[last];
    const signalLine = signalArr[last];
    const histogram  = macdLine - signalLine;
    // Previous values for divergence detection
    const prevMacd   = macdArr[last - 1];
    const prevSignal = signalArr[last - 1];
    return { macdLine, signalLine, histogram, prevMacd, prevSignal, macdArr, signalArr };
  }

  static _emaArray(arr, period) {
    if (arr.length < period) return arr.map(() => arr[arr.length - 1]);
    const k = 2 / (period + 1);
    const result = [];
    let val = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = 0; i < period; i++) result.push(val);
    for (let i = period; i < arr.length; i++) {
      val = arr[i] * k + val * (1 - k);
      result.push(val);
    }
    return result;
  }

  // ── ATR ────────────────────────────────────────────────────
  static atr(highs, lows, closes, period = 14) {
    if (closes.length < 2) return closes[0] * 0.01;
    const trs = [];
    for (let i = 1; i < closes.length; i++) {
      trs.push(Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      ));
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, trs.length);
  }

  // ── Bollinger Bands ────────────────────────────────────────
  static bollingerBands(closes, period = 20, stdDev = 2) {
    if (closes.length < period) period = closes.length;
    const slice = closes.slice(-period);
    const mid   = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((s, v) => s + Math.pow(v - mid, 2), 0) / period;
    const sd = Math.sqrt(variance);
    return { upper: mid + stdDev * sd, mid, lower: mid - stdDev * sd, sd, width: (2 * stdDev * sd) / mid };
  }

  // ── Swing Highs / Lows ─────────────────────────────────────
  // Returns last N confirmed swing points (left+right neighbors lower/higher)
  static swingHighs(highs, lookback = 3, count = 5) {
    const result = [];
    for (let i = lookback; i < highs.length - lookback; i++) {
      const slice = highs.slice(i - lookback, i + lookback + 1);
      if (highs[i] === Math.max(...slice)) result.push({ index: i, value: highs[i] });
    }
    return result.slice(-count);
  }

  static swingLows(lows, lookback = 3, count = 5) {
    const result = [];
    for (let i = lookback; i < lows.length - lookback; i++) {
      const slice = lows.slice(i - lookback, i + lookback + 1);
      if (lows[i] === Math.min(...slice)) result.push({ index: i, value: lows[i] });
    }
    return result.slice(-count);
  }

  // ── Volume analysis ────────────────────────────────────────
  static volumeAnalysis(volumes) {
    if (volumes.length < 5) return { spike: false, ratio: 1, avgVolume: 0 };
    const recent  = volumes.slice(-10, -1);
    const avg     = recent.reduce((a, b) => a + b, 0) / recent.length;
    const current = volumes[volumes.length - 1];
    const ratio   = avg > 0 ? current / avg : 1;
    return { spike: ratio > 1.5, ratio: parseFloat(ratio.toFixed(2)), avgVolume: avg, currentVolume: current };
  }

  // ── Fibonacci levels ───────────────────────────────────────
  static fibLevels(high, low) {
    const range = high - low;
    return {
      '0':    high,
      '23.6': high - range * 0.236,
      '38.2': high - range * 0.382,
      '50':   high - range * 0.5,
      '61.8': high - range * 0.618,
      '78.6': high - range * 0.786,
      '100':  low,
    };
  }

  // ── Is London or NY session active (UTC) ──────────────────
  static isLondonNYOverlap() {
    const utcHour = new Date().getUTCHours();
    // London: 08:00–17:00 UTC, NY: 13:00–22:00 UTC, Overlap: 13:00–17:00 UTC
    return utcHour >= 13 && utcHour < 17;
  }

  static isLondonSession() {
    const utcHour = new Date().getUTCHours();
    return utcHour >= 8 && utcHour < 17;
  }

  // ── Consolidation detection ────────────────────────────────
  // Returns true if last N candles are in a tight range
  static isConsolidating(highs, lows, lookback = 10, threshold = 0.003) {
    const slice_h = highs.slice(-lookback);
    const slice_l = lows.slice(-lookback);
    const rangeHigh = Math.max(...slice_h);
    const rangeLow  = Math.min(...slice_l);
    const mid       = (rangeHigh + rangeLow) / 2;
    return mid > 0 && (rangeHigh - rangeLow) / mid < threshold;
  }

  // ── Trending market check ──────────────────────────────────
  static trendStrength(closes, period = 20) {
    if (closes.length < period) return { trend: 'NEUTRAL', strength: 0 };
    const first = closes.slice(-period, -period + 5).reduce((a, b) => a + b, 0) / 5;
    const last  = closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const change = (last - first) / first;
    if (change > 0.002)  return { trend: 'BULLISH', strength: Math.abs(change) };
    if (change < -0.002) return { trend: 'BEARISH', strength: Math.abs(change) };
    return { trend: 'NEUTRAL', strength: 0 };
  }

  // ── #2 Closed-candle confirmation ──────────────────────────
  // Returns candles with the LAST candle removed (it may still be open).
  // Strategy detectors should call this so they only read confirmed closes.
  static confirmedCandles(candles) {
    if (candles.length < 3) return candles;
    // Check if last candle is likely still open by comparing its timestamp
    // to the expected interval. If within 4.5 min of now, drop it.
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const interval = last.time - prev.time; // ms between candles
    const ageMs    = Date.now() - last.time;
    // Drop current candle if it hasn't lived at least 80% of its interval
    if (ageMs < interval * 0.8) return candles.slice(0, -1);
    return candles;
  }

  // ── #3 Forex tick-volume proxy ──────────────────────────────
  // TwelveData free tier gives no real volume for forex.
  // We approximate activity using candle body+wick range (volatility proxy).
  // A wide-range candle = high market activity. Scales to 0-100.
  static forexVolumeProxy(candles, lookback = 20) {
    if (candles.length < lookback) return { spike: false, ratio: 1, proxy: true };
    const ranges  = candles.map(c => c.high - c.low);
    const recent  = ranges.slice(-lookback, -1);
    const avgRange = recent.reduce((a, b) => a + b, 0) / recent.length;
    const curRange = ranges[ranges.length - 1];
    const ratio    = avgRange > 0 ? curRange / avgRange : 1;
    return { spike: ratio > 1.4, ratio: parseFloat(ratio.toFixed(2)), proxy: true };
  }

  // ── Smart volume: real vol for crypto, proxy for forex ─────
  static smartVolume(candles, category = 'forex') {
    const volumes = candles.map(c => c.volume || 0);
    const hasReal = volumes.some(v => v > 1);
    if (hasReal && category === 'crypto') return this.volumeAnalysis(volumes);
    return this.forexVolumeProxy(candles);
  }
}


// SessionFilter is defined later in Section 5 (full version)

// ============================================================
// ── MTF CONTEXT ANALYZER ────────────────────────────────────
// Derives the top-down bias from H4 → H1 → M5 candle data.
// Used by HTF_CONF, OB_HTF, FVG_BOS_HTF, OVERLAP_OB, ORB_MA.
// ============================================================
class MTFContext {

  // Build full top-down context from 3 TF candle arrays
  static analyze(m5, h1, h4) {
    const h4Trend  = h4 && h4.length >= 10  ? Indicators.trendStrength(h4.map(c => c.close)) : { trend: 'NEUTRAL', strength: 0 };
    const h1Trend  = h1 && h1.length >= 20  ? Indicators.trendStrength(h1.map(c => c.close)) : { trend: 'NEUTRAL', strength: 0 };
    const m5Trend  = m5 && m5.length >= 20  ? Indicators.trendStrength(m5.map(c => c.close)) : { trend: 'NEUTRAL', strength: 0 };

    const h4Rsi    = h4 && h4.length >= 15  ? Indicators.rsi(h4.map(c => c.close)) : 50;
    const h1Rsi    = h1 && h1.length >= 15  ? Indicators.rsi(h1.map(c => c.close)) : 50;

    // Key H1 levels (OB / FVG zones on 1H)
    const h1SwH    = h1 ? Indicators.swingHighs(h1.map(c => c.high), 3, 3) : [];
    const h1SwL    = h1 ? Indicators.swingLows(h1.map(c => c.low), 3, 3)   : [];
    const h4SwH    = h4 ? Indicators.swingHighs(h4.map(c => c.high), 2, 3) : [];
    const h4SwL    = h4 ? Indicators.swingLows(h4.map(c => c.low), 2, 3)   : [];

    // Overall bias: H4 is the master
    let bias = h4Trend.trend;
    if (bias === 'NEUTRAL') bias = h1Trend.trend; // fall back to H1

    // Count how many TFs agree
    const trends = [h4Trend.trend, h1Trend.trend, m5Trend.trend].filter(t => t !== 'NEUTRAL');
    const bullCount = trends.filter(t => t === 'BULLISH').length;
    const bearCount = trends.filter(t => t === 'BEARISH').length;
    const alignment = bullCount === 3 ? 'FULL_BULL'
                    : bearCount === 3 ? 'FULL_BEAR'
                    : bullCount === 2 ? 'PARTIAL_BULL'
                    : bearCount === 2 ? 'PARTIAL_BEAR'
                    : 'MIXED';

    return {
      bias,           // H4-driven master direction
      alignment,      // how many TFs agree
      h4Trend: h4Trend.trend,
      h1Trend: h1Trend.trend,
      m5Trend: m5Trend.trend,
      h4Rsi, h1Rsi,
      h1SwH, h1SwL,   // 1H swing levels (key zones)
      h4SwH, h4SwL,   // 4H swing levels (major zones)
      isRealMTF: !!(h1 && h4),
    };
  }

  // Returns true if context supports a BUY signal
  static supportsBuy(ctx) {
    if (!ctx) return false;
    return ctx.alignment === 'FULL_BULL' || ctx.alignment === 'PARTIAL_BULL';
  }

  // Returns true if context supports a SELL signal
  static supportsSell(ctx) {
    if (!ctx) return false;
    return ctx.alignment === 'FULL_BEAR' || ctx.alignment === 'PARTIAL_BEAR';
  }

  // Score boost based on MTF alignment quality
  static scoreBoost(ctx) {
    if (!ctx) return 0;
    if (ctx.alignment === 'FULL_BULL' || ctx.alignment === 'FULL_BEAR') return 15;
    if (ctx.alignment === 'PARTIAL_BULL' || ctx.alignment === 'PARTIAL_BEAR') return 8;
    return 0;
  }
}

// ============================================================
// ── SECTION 2: STRATEGY DETECTORS ───────────────────────────
// Each function returns null (no signal) or a result object
// { direction, score, conditions, name, id, strength }.
// ALL conditions inside each function must be TRUE to return
// a non-null result.
// ============================================================
class StrategyDetectors {

  // ────────────────────────────────────────────────────────────
  // PRICE ACTION STRATEGIES
  // ────────────────────────────────────────────────────────────

  // 1. Fair Value Gap (FVG)
  // Condition: 3-candle pattern where candle 1 high < candle 3 low (bullish)
  // or candle 1 low > candle 3 high (bearish). Price is currently near the gap.
  static detectFVG(candles) {
    if (candles.length < 10) return null;
    const len  = candles.length;
    const c    = candles;
    const price = c[len - 1].close;

    // Scan last 15 candles for a gap that hasn't been fully filled
    for (let i = len - 3; i >= Math.max(0, len - 15); i--) {
      const c1 = c[i], c3 = c[i + 2];
      if (!c1 || !c3) continue;

      // Bullish FVG: gap between c1.high and c3.low, price trading near/into gap
      if (c1.high < c3.low) {
        const gapTop    = c3.low;
        const gapBottom = c1.high;
        const gapMid    = (gapTop + gapBottom) / 2;
        // Price must be at or below gap mid (retesting into gap)
        if (price <= gapTop && price >= gapBottom * 0.995) {
          return {
            direction: 'BUY', id: 'FVG', name: 'Fair Value Gap',
            strength: 'exceptional', probability: 95, score: 88,
            conditions: { gapTop, gapBottom, gapMid, priceInGap: true, type: 'bullish' },
          };
        }
      }

      // Bearish FVG: gap between c3.high and c1.low
      if (c1.low > c3.high) {
        const gapTop    = c1.low;
        const gapBottom = c3.high;
        const gapMid    = (gapTop + gapBottom) / 2;
        // Price must be at or above gap mid
        if (price >= gapBottom && price <= gapTop * 1.005) {
          return {
            direction: 'SELL', id: 'FVG', name: 'Fair Value Gap',
            strength: 'exceptional', probability: 95, score: 88,
            conditions: { gapTop, gapBottom, gapMid, priceInGap: true, type: 'bearish' },
          };
        }
      }
    }
    return null;
  }

  // 2. Order Block (OB)
  // Condition: Last bearish candle before a strong bullish impulse (bullish OB)
  // or last bullish candle before a strong bearish impulse (bearish OB).
  // Price must return to the OB zone.
  static detectOrderBlock(candles) {
    if (candles.length < 15) return null;
    const len   = candles.length;
    const price = candles[len - 1].close;
    const atr   = Indicators.atr(
      candles.map(c => c.high), candles.map(c => c.low), candles.map(c => c.close)
    );

    // Look for OB in last 20 candles
    for (let i = len - 5; i >= Math.max(2, len - 20); i--) {
      const candle    = candles[i];
      const nextTwo   = candles.slice(i + 1, i + 4);
      if (nextTwo.length < 2) continue;

      // Impulse strength: next candles must move strongly away
      const impulseUp   = nextTwo.every(c => c.close > candle.high);
      const impulseDown = nextTwo.every(c => c.close < candle.low);

      // Bullish OB: bearish candle before up-impulse, price retests candle zone
      if (candle.close < candle.open && impulseUp) {
        const obTop = candle.open, obBot = candle.low;
        if (price >= obBot && price <= obTop + atr * 0.3) {
          return {
            direction: 'BUY', id: 'OB', name: 'Order Block',
            strength: 'strong', probability: 70, score: 75,
            conditions: { obTop, obBot, type: 'bullish', candleIndex: i },
          };
        }
      }

      // Bearish OB: bullish candle before down-impulse, price retests candle zone
      if (candle.close > candle.open && impulseDown) {
        const obTop = candle.high, obBot = candle.close;
        if (price <= obTop && price >= obBot - atr * 0.3) {
          return {
            direction: 'SELL', id: 'OB', name: 'Order Block',
            strength: 'strong', probability: 70, score: 75,
            conditions: { obTop, obBot, type: 'bearish', candleIndex: i },
          };
        }
      }
    }
    return null;
  }

  // 3. Change of Character (ChoCh)
  // Condition: Price was making lower lows (downtrend), then breaks above
  // a prior swing high — character changes from bearish to bullish, and vice versa.
  static detectChoCh(candles) {
    if (candles.length < 20) return null;
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const len    = candles.length;
    const price  = closes[len - 1];

    const swHigh = Indicators.swingHighs(highs, 3, 4);
    const swLow  = Indicators.swingLows(lows, 3, 4);

    if (swHigh.length < 2 || swLow.length < 2) return null;

    // Bullish ChoCh: prior lower highs/lows, then price breaks last swing high
    const lastSwHigh = swHigh[swHigh.length - 1];
    const prevSwHigh = swHigh[swHigh.length - 2];
    const lastSwLow  = swLow[swLow.length - 1];
    const prevSwLow  = swLow[swLow.length - 2];

    // Bearish structure: lower highs AND lower lows
    const bearishStructure = lastSwHigh.value < prevSwHigh.value && lastSwLow.value < prevSwLow.value;
    // Bullish ChoCh: price just broke above last swing high in a bearish structure
    if (bearishStructure && price > lastSwHigh.value && closes[len - 2] <= lastSwHigh.value) {
      return {
        direction: 'BUY', id: 'CHOCH', name: 'Change of Character',
        strength: 'strong', probability: 75, score: 78,
        conditions: { brokenLevel: lastSwHigh.value, priorStructure: 'bearish', type: 'bullish_choch' },
      };
    }

    // Bullish structure: higher highs AND higher lows
    const bullishStructure = lastSwHigh.value > prevSwHigh.value && lastSwLow.value > prevSwLow.value;
    // Bearish ChoCh: price just broke below last swing low in a bullish structure
    if (bullishStructure && price < lastSwLow.value && closes[len - 2] >= lastSwLow.value) {
      return {
        direction: 'SELL', id: 'CHOCH', name: 'Change of Character',
        strength: 'strong', probability: 75, score: 78,
        conditions: { brokenLevel: lastSwLow.value, priorStructure: 'bullish', type: 'bearish_choch' },
      };
    }
    return null;
  }

  // 4. Break of Structure (BoS)
  // Condition: In an established trend, price breaks a key swing level
  // in the SAME direction as the trend (trend continuation).
  static detectBoS(candles) {
    if (candles.length < 20) return null;
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const len    = candles.length;
    const price  = closes[len - 1];
    const prev   = closes[len - 2];

    const swHigh = Indicators.swingHighs(highs, 3, 3);
    const swLow  = Indicators.swingLows(lows, 3, 3);
    if (swHigh.length < 2 || swLow.length < 2) return null;

    const trend = Indicators.trendStrength(closes);
    if (trend.trend === 'NEUTRAL') return null;

    const lastSwHigh = swHigh[swHigh.length - 1];
    const lastSwLow  = swLow[swLow.length - 1];

    // Bullish BoS: uptrend breaking above prior swing high
    if (trend.trend === 'BULLISH' && price > lastSwHigh.value && prev <= lastSwHigh.value) {
      return {
        direction: 'BUY', id: 'BOS', name: 'Break of Structure',
        strength: 'moderate', probability: 70, score: 72,
        conditions: { brokenLevel: lastSwHigh.value, trend: 'BULLISH', type: 'bullish_bos' },
      };
    }

    // Bearish BoS: downtrend breaking below prior swing low
    if (trend.trend === 'BEARISH' && price < lastSwLow.value && prev >= lastSwLow.value) {
      return {
        direction: 'SELL', id: 'BOS', name: 'Break of Structure',
        strength: 'moderate', probability: 70, score: 72,
        conditions: { brokenLevel: lastSwLow.value, trend: 'BEARISH', type: 'bearish_bos' },
      };
    }
    return null;
  }

  // 5. Liquidity Sweep
  // Condition: Price spikes below a key swing low (sweeping buy-side stops)
  // then closes back above it (bullish), or spikes above swing high then closes below (bearish).
  static detectLiquiditySweep(candles) {
    if (candles.length < 15) return null;
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const len    = candles.length;

    const lastCandle = candles[len - 1];
    const swHigh = Indicators.swingHighs(highs, 3, 3);
    const swLow  = Indicators.swingLows(lows, 3, 3);
    if (!swHigh.length || !swLow.length) return null;

    // Bullish sweep: candle low pierces below key swing low, but CLOSES above it
    const keyLow = swLow[swLow.length - 1].value;
    if (lastCandle.low < keyLow && lastCandle.close > keyLow) {
      // Extra confirmation: close must be in upper 40% of candle range
      const range     = lastCandle.high - lastCandle.low;
      const closePos  = (lastCandle.close - lastCandle.low) / range;
      if (closePos > 0.6 && range > 0) {
        return {
          direction: 'BUY', id: 'LIQ_SWEEP', name: 'Liquidity Sweep',
          strength: 'moderate', probability: 65, score: 70,
          conditions: { sweptLevel: keyLow, sweepLow: lastCandle.low, closeBack: lastCandle.close, type: 'bullish_sweep' },
        };
      }
    }

    // Bearish sweep: candle high pierces above key swing high, but CLOSES below it
    const keyHigh = swHigh[swHigh.length - 1].value;
    if (lastCandle.high > keyHigh && lastCandle.close < keyHigh) {
      const range    = lastCandle.high - lastCandle.low;
      const closePos = (lastCandle.close - lastCandle.low) / range;
      if (closePos < 0.4 && range > 0) {
        return {
          direction: 'SELL', id: 'LIQ_SWEEP', name: 'Liquidity Sweep',
          strength: 'moderate', probability: 65, score: 70,
          conditions: { sweptLevel: keyHigh, sweepHigh: lastCandle.high, closeBack: lastCandle.close, type: 'bearish_sweep' },
        };
      }
    }
    return null;
  }

  // 6. Support & Resistance
  // Condition: Price is at a significant S/R level (multiple touches),
  // and the current candle shows rejection (wick) at that level.
  static detectSR(candles) {
    if (candles.length < 30) return null;
    const len    = candles.length;
    const price  = candles[len - 1].close;
    const atr    = Indicators.atr(candles.map(c => c.high), candles.map(c => c.low), candles.map(c => c.close));
    const zone   = atr * 0.5; // tolerance for level touch

    // Build S/R levels from swing highs/lows with multiple touches
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const swH    = Indicators.swingHighs(highs, 3, 8);
    const swL    = Indicators.swingLows(lows, 3, 8);

    // Find resistance levels touched 2+ times
    for (const sh of swH) {
      const touches = swH.filter(h => Math.abs(h.value - sh.value) < zone).length;
      if (touches >= 2) {
        // Price is retesting resistance
        if (Math.abs(price - sh.value) < zone) {
          // Rejection: upper wick should be larger than body
          const last  = candles[len - 1];
          const body  = Math.abs(last.close - last.open);
          const wick  = last.high - Math.max(last.close, last.open);
          if (wick > body * 0.5) {
            return {
              direction: 'SELL', id: 'SR', name: 'Support & Resistance',
              strength: 'moderate', probability: 68, score: 70,
              conditions: { level: sh.value, touches, rejectionWick: wick, type: 'resistance_rejection' },
            };
          }
        }
      }
    }

    // Find support levels touched 2+ times
    for (const sl of swL) {
      const touches = swL.filter(l => Math.abs(l.value - sl.value) < zone).length;
      if (touches >= 2) {
        if (Math.abs(price - sl.value) < zone) {
          const last = candles[len - 1];
          const body = Math.abs(last.close - last.open);
          const wick = Math.min(last.close, last.open) - last.low;
          if (wick > body * 0.5) {
            return {
              direction: 'BUY', id: 'SR', name: 'Support & Resistance',
              strength: 'moderate', probability: 68, score: 70,
              conditions: { level: sl.value, touches, rejectionWick: wick, type: 'support_bounce' },
            };
          }
        }
      }
    }
    return null;
  }

  // 7. Trendline Break
  // Condition: Price breaks above a descending trendline (bullish)
  // or below an ascending trendline (bearish), confirmed by close.
  static detectTrendlineBreak(candles) {
    if (candles.length < 20) return null;
    const len    = candles.length;
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const price  = closes[len - 1];
    const prev   = closes[len - 2];

    // Descending trendline: connect last 2 swing highs
    const swH = Indicators.swingHighs(highs, 3, 3);
    if (swH.length >= 2) {
      const p1 = swH[swH.length - 2], p2 = swH[swH.length - 1];
      if (p2.index > p1.index && p2.value < p1.value) {
        // Trendline slope
        const slope = (p2.value - p1.value) / (p2.index - p1.index);
        const tlAtNow = p2.value + slope * (len - 1 - p2.index);
        // Bullish break: price closes above trendline
        if (prev < tlAtNow && price > tlAtNow) {
          return {
            direction: 'BUY', id: 'TL_BREAK', name: 'Trendline Break',
            strength: 'moderate', probability: 68, score: 71,
            conditions: { trendlineValue: tlAtNow, type: 'descending_break', slope },
          };
        }
      }
    }

    // Ascending trendline: connect last 2 swing lows
    const swL = Indicators.swingLows(lows, 3, 3);
    if (swL.length >= 2) {
      const p1 = swL[swL.length - 2], p2 = swL[swL.length - 1];
      if (p2.index > p1.index && p2.value > p1.value) {
        const slope = (p2.value - p1.value) / (p2.index - p1.index);
        const tlAtNow = p2.value + slope * (len - 1 - p2.index);
        if (prev > tlAtNow && price < tlAtNow) {
          return {
            direction: 'SELL', id: 'TL_BREAK', name: 'Trendline Break',
            strength: 'moderate', probability: 68, score: 71,
            conditions: { trendlineValue: tlAtNow, type: 'ascending_break', slope },
          };
        }
      }
    }
    return null;
  }

  // 8. Inside Bar
  // Condition: Current candle's high and low are completely inside prior candle.
  // Signal direction: break of the mother candle in trend direction.
  static detectInsideBar(candles) {
    if (candles.length < 15) return null;
    const len    = candles.length;
    const last   = candles[len - 1];
    const mother = candles[len - 2];
    const closes = candles.map(c => c.close);

    // Inside bar condition
    if (last.high > mother.high || last.low < mother.low) return null;

    // Need trending context — inside bar is a continuation setup
    const trend = Indicators.trendStrength(closes.slice(0, -2));
    if (trend.trend === 'NEUTRAL') return null;

    return {
      direction: trend.trend === 'BULLISH' ? 'BUY' : 'SELL',
      id: 'INSIDE_BAR', name: 'Inside Bar',
      strength: 'moderate', probability: 66, score: 68,
      conditions: {
        motherHigh: mother.high, motherLow: mother.low,
        insideHigh: last.high,  insideLow: last.low,
        trend: trend.trend,
      },
    };
  }

  // ────────────────────────────────────────────────────────────
  // MOVING AVERAGE STRATEGIES
  // ────────────────────────────────────────────────────────────

  // 9. EMA Crossover
  // Condition: EMA 12 crosses above EMA 26 (bullish) or below (bearish).
  // Current candle is the crossover candle.
  static detectEMACrossover(candles) {
    if (candles.length < 30) return null;
    const closes = candles.map(c => c.close);
    const len    = closes.length;

    const ema12Now  = Indicators.ema(closes, 12);
    const ema26Now  = Indicators.ema(closes, 26);
    const ema12Prev = Indicators.ema(closes.slice(0, -1), 12);
    const ema26Prev = Indicators.ema(closes.slice(0, -1), 26);

    // Bullish cross: 12 was below 26, now above 26
    if (ema12Prev < ema26Prev && ema12Now > ema26Now) {
      return {
        direction: 'BUY', id: 'EMA_CROSS', name: 'EMA Crossover',
        strength: 'moderate', probability: 65, score: 67,
        conditions: { ema12: ema12Now, ema26: ema26Now, type: 'golden_cross' },
      };
    }

    // Bearish cross: 12 was above 26, now below 26
    if (ema12Prev > ema26Prev && ema12Now < ema26Now) {
      return {
        direction: 'SELL', id: 'EMA_CROSS', name: 'EMA Crossover',
        strength: 'moderate', probability: 65, score: 67,
        conditions: { ema12: ema12Now, ema26: ema26Now, type: 'death_cross' },
      };
    }
    return null;
  }

  // 10. MA Stack
  // Condition: EMA12 > EMA26 > EMA50 (bullish stack) all aligned in same direction.
  // Price pulls back to EMA26 and bounces.
  static detectMAStack(candles) {
    if (candles.length < 55) return null;
    const closes = candles.map(c => c.close);
    const len    = closes.length;
    const price  = closes[len - 1];
    const prev   = closes[len - 2];

    const ema12 = Indicators.ema(closes, 12);
    const ema26 = Indicators.ema(closes, 26);
    const ema50 = Indicators.ema(closes, 50);
    const atr   = Indicators.atr(candles.map(c => c.high), candles.map(c => c.low), closes);

    // Bullish stack: 12 > 26 > 50, price near EMA26 (support)
    if (ema12 > ema26 && ema26 > ema50) {
      if (Math.abs(price - ema26) < atr * 0.5 && prev < ema26 && price > ema26) {
        return {
          direction: 'BUY', id: 'MA_STACK', name: 'MA Stack',
          strength: 'strong', probability: 72, score: 76,
          conditions: { ema12, ema26, ema50, bouncedFrom: 'ema26', type: 'bullish_stack' },
        };
      }
    }

    // Bearish stack: 12 < 26 < 50, price near EMA26 (resistance)
    if (ema12 < ema26 && ema26 < ema50) {
      if (Math.abs(price - ema26) < atr * 0.5 && prev > ema26 && price < ema26) {
        return {
          direction: 'SELL', id: 'MA_STACK', name: 'MA Stack',
          strength: 'strong', probability: 72, score: 76,
          conditions: { ema12, ema26, ema50, rejectedFrom: 'ema26', type: 'bearish_stack' },
        };
      }
    }
    return null;
  }

  // 11. London-NY Overlap
  // Condition: Must be during 13:00–17:00 UTC (overlap hours).
  // Price breaks out of the London morning range with volume.
  static detectLondonNYOverlap(candles) {
    if (!Indicators.isLondonNYOverlap()) return null;
    if (candles.length < 20) return null;

    const closes  = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume || 0);
    const len     = closes.length;
    const price   = closes[len - 1];
    const vol     = Indicators.volumeAnalysis(volumes);
    const trend   = Indicators.trendStrength(closes);

    // Require volume spike during overlap + trending
    if (!vol.spike) return null;
    if (trend.trend === 'NEUTRAL') return null;

    return {
      direction: trend.trend === 'BULLISH' ? 'BUY' : 'SELL',
      id: 'OVERLAP', name: 'London-NY Overlap',
      strength: 'very_strong', probability: 80, score: 82,
      conditions: { sessionActive: true, volumeRatio: vol.ratio, trend: trend.trend },
    };
  }

  // 12. Pullback Entry
  // Condition: Strong trend established. Price pulls back to EMA50.
  // Candle closes back above (bullish) or below (bearish) EMA50.
  static detectPullback(candles) {
    if (candles.length < 55) return null;
    const closes = candles.map(c => c.close);
    const len    = closes.length;
    const price  = closes[len - 1];
    const prev   = closes[len - 2];
    const ema50  = Indicators.ema(closes, 50);
    const trend  = Indicators.trendStrength(closes);
    const atr    = Indicators.atr(candles.map(c => c.high), candles.map(c => c.low), closes);

    if (trend.trend === 'NEUTRAL') return null;

    // Bullish: price dipped to EMA50 zone and closed back above
    if (trend.trend === 'BULLISH' && prev < ema50 && price > ema50 && Math.abs(price - ema50) < atr) {
      return {
        direction: 'BUY', id: 'PULLBACK', name: 'Pullback Entry',
        strength: 'moderate', probability: 65, score: 68,
        conditions: { ema50, pullbackTo: prev, reclaim: price, trend: 'BULLISH' },
      };
    }

    // Bearish: price rose to EMA50 zone and closed back below
    if (trend.trend === 'BEARISH' && prev > ema50 && price < ema50 && Math.abs(price - ema50) < atr) {
      return {
        direction: 'SELL', id: 'PULLBACK', name: 'Pullback Entry',
        strength: 'moderate', probability: 65, score: 68,
        conditions: { ema50, pullbackTo: prev, rejection: price, trend: 'BEARISH' },
      };
    }
    return null;
  }

  // ────────────────────────────────────────────────────────────
  // BREAKOUT STRATEGIES
  // ────────────────────────────────────────────────────────────

  // 13. Opening Range Breakout (ORB)
  // Condition: Must be in London or NY session.
  // First 4 candles form a range. Current price breaks that range with volume.
  static detectORB(candles) {
    if (candles.length < 10) return null;
    if (!Indicators.isLondonSession()) return null;

    const closes  = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume || 0);
    const len     = candles.length;

    // Use first 4 candles of available data as "opening range"
    const orbCandles = candles.slice(0, 4);
    const orbHigh = Math.max(...orbCandles.map(c => c.high));
    const orbLow  = Math.min(...orbCandles.map(c => c.low));

    const price = closes[len - 1];
    const prev  = closes[len - 2];
    const vol   = Indicators.volumeAnalysis(volumes);

    if (!vol.spike) return null;

    // Bullish breakout: close above ORB high
    if (prev <= orbHigh && price > orbHigh) {
      return {
        direction: 'BUY', id: 'ORB', name: 'Opening Range Breakout',
        strength: 'strong', probability: 72, score: 75,
        conditions: { orbHigh, orbLow, breakLevel: orbHigh, volumeRatio: vol.ratio, type: 'bullish_orb' },
      };
    }

    // Bearish breakout: close below ORB low
    if (prev >= orbLow && price < orbLow) {
      return {
        direction: 'SELL', id: 'ORB', name: 'Opening Range Breakout',
        strength: 'strong', probability: 72, score: 75,
        conditions: { orbHigh, orbLow, breakLevel: orbLow, volumeRatio: vol.ratio, type: 'bearish_orb' },
      };
    }
    return null;
  }

  // 14. Consolidation Breakout
  // Condition: Last 10+ candles are in tight range (consolidation detected).
  // Current candle breaks out of that range with expanded range.
  static detectConsolidationBreakout(candles) {
    if (candles.length < 20) return null;
    const len    = candles.length;
    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);

    // Check if prior 12 candles were consolidating (excluding last 2)
    const priorHighs  = highs.slice(-14, -2);
    const priorLows   = lows.slice(-14, -2);
    const wasConsolidating = Indicators.isConsolidating(priorHighs, priorLows, 12, 0.004);
    if (!wasConsolidating) return null;

    const consHigh = Math.max(...priorHighs);
    const consLow  = Math.min(...priorLows);
    const price    = closes[len - 1];
    const prev     = closes[len - 2];

    // Breakout: current candle closes outside the consolidation zone
    if (prev <= consHigh && price > consHigh * 1.001) {
      return {
        direction: 'BUY', id: 'CONS_BREAK', name: 'Consolidation Breakout',
        strength: 'moderate', probability: 70, score: 73,
        conditions: { consHigh, consLow, breakLevel: consHigh, type: 'bullish_break' },
      };
    }
    if (prev >= consLow && price < consLow * 0.999) {
      return {
        direction: 'SELL', id: 'CONS_BREAK', name: 'Consolidation Breakout',
        strength: 'moderate', probability: 70, score: 73,
        conditions: { consHigh, consLow, breakLevel: consLow, type: 'bearish_break' },
      };
    }
    return null;
  }

  // 15. Higher Timeframe (HTF) Confirmation
  // Real MTF: uses actual 1H and 4H candle arrays when available.
  // Falls back to every-4th-candle proxy only if HTF data missing.
  static detectHTFConfirmation(candles, h1Candles = null, h4Candles = null) {
    if (candles.length < 20) return null;
    const m5Closes = candles.map(c => c.close);
    const m5Trend  = Indicators.trendStrength(m5Closes.slice(-20));

    let h1Trend = null, h4Trend = null;

    // Real 1H trend
    if (h1Candles && h1Candles.length >= 20) {
      h1Trend = Indicators.trendStrength(h1Candles.map(c => c.close));
    }
    // Real 4H trend
    if (h4Candles && h4Candles.length >= 10) {
      h4Trend = Indicators.trendStrength(h4Candles.map(c => c.close));
    }
    // Fallback proxy if no real HTF data
    if (!h1Trend) {
      const proxy = m5Closes.filter((_, i) => i % 4 === 0);
      h1Trend = Indicators.trendStrength(proxy);
    }
    if (!h4Trend) {
      const proxy = m5Closes.filter((_, i) => i % 12 === 0);
      h4Trend = Indicators.trendStrength(proxy);
    }

    if (m5Trend.trend === 'NEUTRAL') return null;
    if (h1Trend.trend === 'NEUTRAL' && h4Trend.trend === 'NEUTRAL') return null;

    // Strong: all 3 align
    const allAlign = m5Trend.trend === h1Trend.trend && h1Trend.trend === h4Trend.trend;
    // Partial: at least 2 align
    const twoAlign = (m5Trend.trend === h1Trend.trend) || (m5Trend.trend === h4Trend.trend);
    if (!twoAlign) return null;

    const score = allAlign ? 78 : 67;
    const isReal = !!(h1Candles && h4Candles);

    return {
      direction: m5Trend.trend === 'BULLISH' ? 'BUY' : 'SELL',
      id: 'HTF_CONF', name: 'Higher TF Confirmation',
      strength: allAlign ? 'strong' : 'moderate',
      probability: allAlign ? 75 : 65, score,
      conditions: {
        m5Trend: m5Trend.trend, h1Trend: h1Trend.trend, h4Trend: h4Trend.trend,
        allAligned: allAlign, realMTF: isReal,
      },
    };
  }

  // ────────────────────────────────────────────────────────────
  // MEAN REVERSION STRATEGIES
  // ────────────────────────────────────────────────────────────

  // 16. Mean Reversion
  // Condition: Price is extended far from SMA50 (>2 ATR).
  // Current candle starts to reverse back toward mean.
  static detectMeanReversion(candles) {
    if (candles.length < 55) return null;
    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const len    = closes.length;
    const price  = closes[len - 1];
    const prev   = closes[len - 2];

    const sma50 = Indicators.sma(closes, 50);
    const atr   = Indicators.atr(highs, lows, closes);
    const dist  = Math.abs(price - sma50);

    if (dist < atr * 2) return null; // Not extended enough

    // Bullish: price is far below SMA50 and starts moving up
    if (price < sma50 - atr * 2 && price > prev) {
      return {
        direction: 'BUY', id: 'MR', name: 'Mean Reversion',
        strength: 'moderate', probability: 70, score: 72,
        conditions: { sma50, currentPrice: price, deviation: dist / atr, type: 'oversold_reversion' },
      };
    }

    // Bearish: price is far above SMA50 and starts moving down
    if (price > sma50 + atr * 2 && price < prev) {
      return {
        direction: 'SELL', id: 'MR', name: 'Mean Reversion',
        strength: 'moderate', probability: 70, score: 72,
        conditions: { sma50, currentPrice: price, deviation: dist / atr, type: 'overbought_reversion' },
      };
    }
    return null;
  }

  // 17. Fibonacci Retracement
  // Condition: Identifies a recent swing move, plots fib levels,
  // and signals when price bounces off 38.2%, 50%, or 61.8%.
  static detectFibonacci(candles) {
    if (candles.length < 30) return null;
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const len    = closes.length;
    const price  = closes[len - 1];
    const prev   = closes[len - 2];
    const atr    = Indicators.atr(highs, lows, closes);

    const swH = Indicators.swingHighs(highs, 3, 2);
    const swL = Indicators.swingLows(lows, 3, 2);
    if (!swH.length || !swL.length) return null;

    const lastH = swH[swH.length - 1];
    const lastL = swL[swL.length - 1];

    // Bullish fib: down move from high to low, retracing up to key level
    if (lastH.index < lastL.index) {
      // Down move, now retracing UP
      const fibs = Indicators.fibLevels(lastH.value, lastL.value);
      const keyLevels = [fibs['38.2'], fibs['50'], fibs['61.8']];
      for (const lvl of keyLevels) {
        if (Math.abs(price - lvl) < atr * 0.4 && prev < lvl && price >= lvl) {
          return {
            direction: 'SELL', id: 'FIB', name: 'Fibonacci Retracement',
            strength: 'moderate', probability: 70, score: 73,
            conditions: { fibLevel: lvl, swingHigh: lastH.value, swingLow: lastL.value, type: 'fib_resistance' },
          };
        }
      }
    }

    // Bearish fib: up move from low to high, retracing down to key level
    if (lastL.index < lastH.index) {
      const fibs = Indicators.fibLevels(lastH.value, lastL.value);
      const keyLevels = [fibs['38.2'], fibs['50'], fibs['61.8']];
      for (const lvl of keyLevels) {
        if (Math.abs(price - lvl) < atr * 0.4 && prev > lvl && price <= lvl) {
          return {
            direction: 'BUY', id: 'FIB', name: 'Fibonacci Retracement',
            strength: 'moderate', probability: 70, score: 73,
            conditions: { fibLevel: lvl, swingHigh: lastH.value, swingLow: lastL.value, type: 'fib_support' },
          };
        }
      }
    }
    return null;
  }

  // 18. Bollinger Bands Squeeze + Breakout
  // Condition: BB width contracts (squeeze), then expands (breakout).
  // Signal in direction of breakout candle.
  static detectBollingerBands(candles) {
    if (candles.length < 25) return null;
    const closes = candles.map(c => c.close);
    const len    = closes.length;

    const bbNow  = Indicators.bollingerBands(closes);
    const bbPrev = Indicators.bollingerBands(closes.slice(0, -5));

    // Squeeze: width was narrow
    if (bbPrev.width > 0.02) return null; // not in squeeze previously
    // Expansion: width is now wider
    if (bbNow.width <= bbPrev.width * 1.2) return null;

    const price = closes[len - 1];
    if (price > bbNow.upper) {
      return {
        direction: 'BUY', id: 'BB', name: 'Bollinger Bands',
        strength: 'moderate', probability: 65, score: 68,
        conditions: { upper: bbNow.upper, lower: bbNow.lower, mid: bbNow.mid, type: 'squeeze_breakout_up', width: bbNow.width },
      };
    }
    if (price < bbNow.lower) {
      return {
        direction: 'SELL', id: 'BB', name: 'Bollinger Bands',
        strength: 'moderate', probability: 65, score: 68,
        conditions: { upper: bbNow.upper, lower: bbNow.lower, mid: bbNow.mid, type: 'squeeze_breakout_down', width: bbNow.width },
      };
    }
    return null;
  }

  // 19. Bollinger Band Bounce
  // Condition: RSI not extreme. Price touches lower band and closes back inside (BUY).
  // Price touches upper band and closes back inside (SELL).
  static detectBBBounce(candles) {
    if (candles.length < 25) return null;
    const closes = candles.map(c => c.close);
    const len    = closes.length;

    const bb    = Indicators.bollingerBands(closes);
    const rsi   = Indicators.rsi(closes);
    const price = closes[len - 1];
    const prev  = closes[len - 2];

    // Bullish bounce: previous candle below lower band, current closes inside
    if (prev < bb.lower && price > bb.lower && rsi < 50) {
      return {
        direction: 'BUY', id: 'BB_BOUNCE', name: 'Bollinger Bounce',
        strength: 'moderate', probability: 65, score: 68,
        conditions: { lower: bb.lower, upper: bb.upper, rsi, type: 'lower_band_bounce' },
      };
    }

    // Bearish bounce: previous candle above upper band, current closes inside
    if (prev > bb.upper && price < bb.upper && rsi > 50) {
      return {
        direction: 'SELL', id: 'BB_BOUNCE', name: 'Bollinger Bounce',
        strength: 'moderate', probability: 65, score: 68,
        conditions: { lower: bb.lower, upper: bb.upper, rsi, type: 'upper_band_bounce' },
      };
    }
    return null;
  }

  // ────────────────────────────────────────────────────────────
  // MOMENTUM STRATEGIES
  // ────────────────────────────────────────────────────────────

  // 20. RSI Divergence
  // Condition: Price makes new low but RSI makes higher low (bullish divergence),
  // or price makes new high but RSI makes lower high (bearish divergence).
  static detectRSIDivergence(candles) {
    if (candles.length < 30) return null;
    const closes = candles.map(c => c.close);
    const lows   = candles.map(c => c.low);
    const highs  = candles.map(c => c.high);
    const len    = closes.length;

    // Calculate RSI for each candle
    const rsiValues = [];
    for (let i = 15; i < len; i++) {
      rsiValues.push(Indicators.rsi(closes.slice(0, i + 1)));
    }

    if (rsiValues.length < 5) return null;
    const rsiLen = rsiValues.length;

    // Bullish divergence: price lower low, RSI higher low
    const priceLL  = lows[len - 1] < lows[len - 5];
    const rsiHL    = rsiValues[rsiLen - 1] > rsiValues[rsiLen - 5];
    const rsiLow   = rsiValues[rsiLen - 1] < 45; // RSI should be in lower zone

    if (priceLL && rsiHL && rsiLow) {
      return {
        direction: 'BUY', id: 'RSI_DIV', name: 'RSI Divergence',
        strength: 'moderate', probability: 67, score: 72,
        conditions: { rsi: rsiValues[rsiLen - 1], priceLL, rsiHL, type: 'bullish_divergence' },
      };
    }

    // Bearish divergence: price higher high, RSI lower high
    const priceHH  = highs[len - 1] > highs[len - 5];
    const rsiLH    = rsiValues[rsiLen - 1] < rsiValues[rsiLen - 5];
    const rsiHigh  = rsiValues[rsiLen - 1] > 55;

    if (priceHH && rsiLH && rsiHigh) {
      return {
        direction: 'SELL', id: 'RSI_DIV', name: 'RSI Divergence',
        strength: 'moderate', probability: 67, score: 72,
        conditions: { rsi: rsiValues[rsiLen - 1], priceHH, rsiLH, type: 'bearish_divergence' },
      };
    }
    return null;
  }

  // 21. MACD Divergence
  // Condition: MACD histogram diverges from price action.
  static detectMACDDivergence(candles) {
    if (candles.length < 35) return null;
    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const len    = closes.length;
    const macdData = Indicators.macd(closes);

    if (!macdData.macdArr || macdData.macdArr.length < 10) return null;
    const mArr = macdData.macdArr;
    const mLen = mArr.length;

    // Bullish MACD divergence: price lower low, MACD higher low
    const priceLow1 = Math.min(...lows.slice(-10, -5));
    const priceLow2 = Math.min(...lows.slice(-5));
    const macdLow1  = Math.min(...mArr.slice(-10, -5));
    const macdLow2  = Math.min(...mArr.slice(-5));

    if (priceLow2 < priceLow1 && macdLow2 > macdLow1 && macdData.macdLine < 0) {
      return {
        direction: 'BUY', id: 'MACD_DIV', name: 'MACD Divergence',
        strength: 'moderate', probability: 68, score: 72,
        conditions: { macdLine: macdData.macdLine, histogram: macdData.histogram, type: 'bullish_macd_div' },
      };
    }

    // Bearish MACD divergence: price higher high, MACD lower high
    const priceHigh1 = Math.max(...highs.slice(-10, -5));
    const priceHigh2 = Math.max(...highs.slice(-5));
    const macdHigh1  = Math.max(...mArr.slice(-10, -5));
    const macdHigh2  = Math.max(...mArr.slice(-5));

    if (priceHigh2 > priceHigh1 && macdHigh2 < macdHigh1 && macdData.macdLine > 0) {
      return {
        direction: 'SELL', id: 'MACD_DIV', name: 'MACD Divergence',
        strength: 'moderate', probability: 68, score: 72,
        conditions: { macdLine: macdData.macdLine, histogram: macdData.histogram, type: 'bearish_macd_div' },
      };
    }
    return null;
  }

  // 22. RSI Extremes
  // Condition: RSI truly oversold (<25) or overbought (>75).
  // Current candle must show a reversal (close in opposite direction).
  static detectRSIExtremes(candles) {
    if (candles.length < 20) return null;
    const closes = candles.map(c => c.close);
    const len    = closes.length;
    const rsi    = Indicators.rsi(closes);
    const last   = candles[len - 1];

    // Oversold + bullish reversal candle
    if (rsi < 25 && last.close > last.open) {
      return {
        direction: 'BUY', id: 'RSI_EXT', name: 'RSI Extremes',
        strength: 'weak', probability: 64, score: 66,
        conditions: { rsi, level: 'oversold', reversalCandle: true },
      };
    }

    // Overbought + bearish reversal candle
    if (rsi > 75 && last.close < last.open) {
      return {
        direction: 'SELL', id: 'RSI_EXT', name: 'RSI Extremes',
        strength: 'weak', probability: 64, score: 66,
        conditions: { rsi, level: 'overbought', reversalCandle: true },
      };
    }
    return null;
  }

  // 23. Trend Confirmation
  // Condition: EMA stack + MACD + RSI all agree on direction.
  static detectTrendConfirmation(candles) {
    if (candles.length < 55) return null;
    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);

    const ema12    = Indicators.ema(closes, 12);
    const ema26    = Indicators.ema(closes, 26);
    const ema50    = Indicators.ema(closes, 50);
    const rsi      = Indicators.rsi(closes);
    const macdData = Indicators.macd(closes);

    // Bullish: ema stack up + MACD positive + RSI 50-65
    if (ema12 > ema26 && ema26 > ema50 && macdData.macdLine > 0 && macdData.histogram > 0 && rsi > 50 && rsi < 70) {
      return {
        direction: 'BUY', id: 'TREND_CONF', name: 'Trend Confirmation',
        strength: 'moderate', probability: 68, score: 71,
        conditions: { ema12, ema26, ema50, rsi, macd: macdData.macdLine, type: 'bullish_confluence' },
      };
    }

    // Bearish: ema stack down + MACD negative + RSI 30-50
    if (ema12 < ema26 && ema26 < ema50 && macdData.macdLine < 0 && macdData.histogram < 0 && rsi < 50 && rsi > 30) {
      return {
        direction: 'SELL', id: 'TREND_CONF', name: 'Trend Confirmation',
        strength: 'moderate', probability: 68, score: 71,
        conditions: { ema12, ema26, ema50, rsi, macd: macdData.macdLine, type: 'bearish_confluence' },
      };
    }
    return null;
  }

  // ────────────────────────────────────────────────────────────
  // VOLUME STRATEGIES
  // ────────────────────────────────────────────────────────────

  // 24. Volume Confirmation
  // Condition: Strong directional candle (body > 60% of range) + volume spike (>2x avg).
  static detectVolumeConfirmation(candles) {
    if (candles.length < 15) return null;
    const len     = candles.length;
    const last    = candles[len - 1];
    const volumes = candles.map(c => c.volume || 0);
    const vol     = Indicators.volumeAnalysis(volumes);

    if (!vol.spike || vol.ratio < 2.0) return null;

    const range = last.high - last.low;
    if (range === 0) return null;
    const body  = Math.abs(last.close - last.open);
    if (body / range < 0.6) return null; // needs strong body

    if (last.close > last.open) {
      return {
        direction: 'BUY', id: 'VOL_CONF', name: 'Volume Confirmation',
        strength: 'moderate', probability: 68, score: 73,
        conditions: { volumeRatio: vol.ratio, bodyPercent: body / range, type: 'bullish_volume' },
      };
    } else {
      return {
        direction: 'SELL', id: 'VOL_CONF', name: 'Volume Confirmation',
        strength: 'moderate', probability: 68, score: 73,
        conditions: { volumeRatio: vol.ratio, bodyPercent: body / range, type: 'bearish_volume' },
      };
    }
  }

  // 25. Gap Fill
  // Condition: A price gap exists between yesterday's close and today's open.
  // Price is moving toward filling it.
  static detectGapFill(candles) {
    if (candles.length < 5) return null;
    const len  = candles.length;
    const c1   = candles[len - 2]; // previous
    const c2   = candles[len - 1]; // current

    // Gap up: today's open > yesterday's high → price might fill gap downward
    if (c2.open > c1.high * 1.001) {
      if (c2.close < c2.open) { // bearish candle trying to fill
        return {
          direction: 'SELL', id: 'GAP_FILL', name: 'Gap Fill',
          strength: 'moderate', probability: 65, score: 67,
          conditions: { gapOpen: c2.open, prevClose: c1.close, gapSize: c2.open - c1.high, type: 'gap_up_fill' },
        };
      }
    }

    // Gap down: today's open < yesterday's low → price might fill gap upward
    if (c2.open < c1.low * 0.999) {
      if (c2.close > c2.open) { // bullish candle trying to fill
        return {
          direction: 'BUY', id: 'GAP_FILL', name: 'Gap Fill',
          strength: 'moderate', probability: 65, score: 67,
          conditions: { gapOpen: c2.open, prevClose: c1.close, gapSize: c1.low - c2.open, type: 'gap_down_fill' },
        };
      }
    }
    return null;
  }

  // 26. Confluence Zone
  // Condition: Multiple S/R levels cluster within ATR/2 of current price
  // (swing high, swing low, EMA, fib all near same price level).
  static detectConfluenceZone(candles) {
    if (candles.length < 55) return null;
    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const len    = closes.length;
    const price  = closes[len - 1];
    const atr    = Indicators.atr(highs, lows, closes);
    const zone   = atr * 0.5;

    const ema50  = Indicators.ema(closes, 50);
    const swH    = Indicators.swingHighs(highs, 3, 3);
    const swL    = Indicators.swingLows(lows, 3, 3);

    // Count how many levels are near current price
    let bullishLevels = 0, bearishLevels = 0;

    // EMA50 near price and acting as support
    if (Math.abs(price - ema50) < zone && price > ema50) bullishLevels++;
    if (Math.abs(price - ema50) < zone && price < ema50) bearishLevels++;

    // Swing lows near price (support)
    for (const sl of swL) {
      if (Math.abs(price - sl.value) < zone && price > sl.value) bullishLevels++;
    }
    // Swing highs near price (resistance)
    for (const sh of swH) {
      if (Math.abs(price - sh.value) < zone && price < sh.value) bearishLevels++;
    }

    if (bullishLevels >= 2) {
      return {
        direction: 'BUY', id: 'CONF_ZONE', name: 'Confluence Zone',
        strength: 'strong', probability: 72, score: 76,
        conditions: { confluenceLevels: bullishLevels, ema50, price, type: 'bullish_confluence_zone' },
      };
    }
    if (bearishLevels >= 2) {
      return {
        direction: 'SELL', id: 'CONF_ZONE', name: 'Confluence Zone',
        strength: 'strong', probability: 72, score: 76,
        conditions: { confluenceLevels: bearishLevels, ema50, price, type: 'bearish_confluence_zone' },
      };
    }
    return null;
  }

  // ────────────────────────────────────────────────────────────
  // COMBO STRATEGIES — ALL sub-conditions must pass
  // ────────────────────────────────────────────────────────────

  // C1. Order Block + FVG
  static detectOB_FVG(candles) {
    const ob  = this.detectOrderBlock(candles);
    const fvg = this.detectFVG(candles);
    if (!ob || !fvg) return null;
    if (ob.direction !== fvg.direction) return null;
    return {
      direction: ob.direction, id: 'OB_FVG', name: 'Order Block + Fair Value Gap',
      strength: 'very_strong', probability: 80, score: 85,
      conditions: { ob: ob.conditions, fvg: fvg.conditions },
    };
  }

  // C2. ChoCh + Liquidity Sweep
  static detectChoCh_Liq(candles) {
    const choch = this.detectChoCh(candles);
    const liq   = this.detectLiquiditySweep(candles);
    if (!choch || !liq) return null;
    if (choch.direction !== liq.direction) return null;
    return {
      direction: choch.direction, id: 'CHOCH_LIQ', name: 'ChoCh + Liquidity Sweep',
      strength: 'strong', probability: 75, score: 82,
      conditions: { choch: choch.conditions, liq: liq.conditions },
    };
  }

  // C3. ORB + MA Stack
  static detectORB_MA(candles) {
    const orb = this.detectORB(candles);
    const ma  = this.detectMAStack(candles);
    if (!orb || !ma) return null;
    if (orb.direction !== ma.direction) return null;
    return {
      direction: orb.direction, id: 'ORB_MA', name: 'ORB + MA Stack',
      strength: 'strong', probability: 78, score: 83,
      conditions: { orb: orb.conditions, ma: ma.conditions },
    };
  }

  // C4. Order Block + Consolidation Breakout
  static detectOB_Cons(candles) {
    const ob   = this.detectOrderBlock(candles);
    const cons = this.detectConsolidationBreakout(candles);
    if (!ob || !cons) return null;
    if (ob.direction !== cons.direction) return null;
    return {
      direction: ob.direction, id: 'OB_CONS', name: 'Order Block + Consolidation',
      strength: 'strong', probability: 76, score: 81,
      conditions: { ob: ob.conditions, cons: cons.conditions },
    };
  }

  // C5. ChoCh + Volume Spike
  static detectChoCh_Vol(candles) {
    const choch = this.detectChoCh(candles);
    const vol   = this.detectVolumeConfirmation(candles);
    if (!choch || !vol) return null;
    if (choch.direction !== vol.direction) return null;
    return {
      direction: choch.direction, id: 'CHOCH_VOL', name: 'ChoCh + Volume Spike',
      strength: 'very_strong', probability: 80, score: 86,
      conditions: { choch: choch.conditions, vol: vol.conditions },
    };
  }

  // C6. London-NY Overlap + Order Block
  static detectOverlap_OB(candles) {
    const overlap = this.detectLondonNYOverlap(candles);
    const ob      = this.detectOrderBlock(candles);
    if (!overlap || !ob) return null;
    if (overlap.direction !== ob.direction) return null;
    return {
      direction: overlap.direction, id: 'OVERLAP_OB', name: 'London-NY Overlap + OB',
      strength: 'very_strong', probability: 85, score: 88,
      conditions: { overlap: overlap.conditions, ob: ob.conditions },
    };
  }

  // C7. FVG + Break of Structure
  static detectFVG_BoS(candles) {
    const fvg = this.detectFVG(candles);
    const bos = this.detectBoS(candles);
    if (!fvg || !bos) return null;
    if (fvg.direction !== bos.direction) return null;
    return {
      direction: fvg.direction, id: 'FVG_BOS', name: 'FVG + Break of Structure',
      strength: 'exceptional', probability: 90, score: 91,
      conditions: { fvg: fvg.conditions, bos: bos.conditions },
    };
  }

  // C8. Mean Reversion + Fibonacci
  static detectMR_Fib(candles) {
    const mr  = this.detectMeanReversion(candles);
    const fib = this.detectFibonacci(candles);
    if (!mr || !fib) return null;
    if (mr.direction !== fib.direction) return null;
    return {
      direction: mr.direction, id: 'MR_FIB', name: 'Mean Reversion + Fibonacci',
      strength: 'strong', probability: 78, score: 82,
      conditions: { mr: mr.conditions, fib: fib.conditions },
    };
  }

  // C9. FVG + Mean Reversion
  static detectFVG_MR(candles) {
    const fvg = this.detectFVG(candles);
    const mr  = this.detectMeanReversion(candles);
    if (!fvg || !mr) return null;
    if (fvg.direction !== mr.direction) return null;
    return {
      direction: fvg.direction, id: 'FVG_MR', name: 'FVG + Mean Reversion',
      strength: 'very_strong', probability: 80, score: 85,
      conditions: { fvg: fvg.conditions, mr: mr.conditions },
    };
  }

  // C10. Order Block + HTF Confirmation (real MTF)
  static detectOB_HTF(candles, h1Candles = null, h4Candles = null) {
    const ob  = this.detectOrderBlock(candles);
    const htf = this.detectHTFConfirmation(candles, h1Candles, h4Candles);
    if (!ob || !htf) return null;
    if (ob.direction !== htf.direction) return null;
    const isReal = !!(h1Candles && h4Candles);
    return {
      direction: ob.direction, id: 'OB_HTF', name: 'Order Block + HTF Confirm',
      strength: isReal ? 'very_strong' : 'strong',
      probability: isReal ? 82 : 78,
      score: isReal ? 87 : 83,
      conditions: { ob: ob.conditions, htf: htf.conditions, realMTF: isReal },
    };
  }

  // C11. FVG + BoS + HTF — THE BEST SETUP ⭐ (real MTF)
  static detectFVG_BoS_HTF(candles, h1Candles = null, h4Candles = null) {
    const fvg = this.detectFVG(candles);
    const bos = this.detectBoS(candles);
    const htf = this.detectHTFConfirmation(candles, h1Candles, h4Candles);
    if (!fvg || !bos || !htf) return null;
    if (fvg.direction !== bos.direction || bos.direction !== htf.direction) return null;
    const isReal = !!(h1Candles && h4Candles);
    return {
      direction: fvg.direction, id: 'FVG_BOS_HTF', name: 'FVG + BoS + HTF (BEST ⭐)',
      strength: 'exceptional',
      probability: isReal ? 95 : 92,
      score: isReal ? 98 : 95,
      conditions: { fvg: fvg.conditions, bos: bos.conditions, htf: htf.conditions, realMTF: isReal },
    };
  }

  // C12. Pullback + Volume
  static detectPullback_Vol(candles) {
    const pb  = this.detectPullback(candles);
    const vol = this.detectVolumeConfirmation(candles);
    if (!pb || !vol) return null;
    if (pb.direction !== vol.direction) return null;
    return {
      direction: pb.direction, id: 'PB_VOL', name: 'Pullback + Volume',
      strength: 'strong', probability: 75, score: 79,
      conditions: { pb: pb.conditions, vol: vol.conditions },
    };
  }

  // ────────────────────────────────────────────────────────────
  // RUN ALL DETECTORS
  // mtfCtx is optional MTFContext.analyze() result.
  // When present, MTF-aware strategies use real H1/H4 data.
  // MTF bias also gates which direction signals are allowed.
  // ────────────────────────────────────────────────────────────
  static runAll(candles, h1Candles = null, h4Candles = null, category = 'forex') {
    // Build MTF context if HTF data available
    const mtfCtx = MTFContext.analyze(candles, h1Candles, h4Candles);

    const detectors = [
      // Core strategies (all pass candles + optional HTF arrays)
      () => this.detectFVG(candles),
      () => this.detectOrderBlock(candles),
      () => this.detectChoCh(candles),
      () => this.detectBoS(candles),
      () => this.detectLiquiditySweep(candles),
      () => this.detectSR(candles),
      () => this.detectTrendlineBreak(candles),
      () => this.detectInsideBar(candles),
      () => this.detectEMACrossover(candles),
      () => this.detectMAStack(candles),
      () => this.detectLondonNYOverlap(candles),
      () => this.detectPullback(candles),
      () => this.detectORB(candles),
      () => this.detectConsolidationBreakout(candles),
      () => this.detectHTFConfirmation(candles, h1Candles, h4Candles), // real MTF
      () => this.detectMeanReversion(candles),
      () => this.detectFibonacci(candles),
      () => this.detectBollingerBands(candles),
      () => this.detectBBBounce(candles),
      () => this.detectRSIDivergence(candles),
      () => this.detectMACDDivergence(candles),
      () => this.detectRSIExtremes(candles),
      () => this.detectTrendConfirmation(candles),
      () => this.detectVolumeConfirmation(candles),
      () => this.detectGapFill(candles),
      () => this.detectConfluenceZone(candles),
      // Combo strategies — pass HTF arrays to combos that need them
      () => this.detectOB_FVG(candles),
      () => this.detectChoCh_Liq(candles),
      () => this.detectORB_MA(candles),
      () => this.detectOB_Cons(candles),
      () => this.detectChoCh_Vol(candles),
      () => this.detectOverlap_OB(candles),
      () => this.detectFVG_BoS(candles),
      () => this.detectMR_Fib(candles),
      () => this.detectFVG_MR(candles),
      () => this.detectOB_HTF(candles, h1Candles, h4Candles),       // real MTF
      () => this.detectFVG_BoS_HTF(candles, h1Candles, h4Candles), // real MTF
      () => this.detectPullback_Vol(candles),
    ];

    const fired = [];
    for (const fn of detectors) {
      try {
        const result = fn();
        if (!result) continue;

        // MTF GATE: block counter-trend signals when real HTF data confirms direction
        if (mtfCtx.isRealMTF) {
          if (mtfCtx.alignment === 'FULL_BULL' && result.direction === 'SELL') continue;
          if (mtfCtx.alignment === 'FULL_BEAR' && result.direction === 'BUY')  continue;
        }

        // #5 SESSION GATE: block strategies outside their valid session
        const sf = SessionFilter.check(result.id, category);
        if (!sf.allowed) continue;

        fired.push(result);
      } catch (e) { /* skip failed detector */ }
    }
    return { fired, mtfCtx };
  }
}




// ============================================================
// ── SECTION 3: SIGNAL BUILDER ────────────────────────────────
// Takes fired strategies, picks the highest-scoring one that
// meets the minimum quality threshold, builds full signal object.
// ============================================================
class SignalBuilder {

  // ── #1 STRUCTURE-BASED LEVELS ───────────────────────────────
  // Every strategy returns its own structural entry, SL, TP.
  // Entry  = precise zone based on pattern geometry
  // SL     = structural invalidation point (not ATR multiple)
  // TP1    = nearest opposing swing
  // TP2    = H1 swing / next major zone
  // TP3    = 3× risk extension (institutional target)
  static calculateLevels(direction, price, atr, conditions = {}, candles = [], h1 = [], h4 = []) {
    // Smart decimal formatter: matches instrument type
    // Crypto/Gold: 2dp, Forex: 5dp, fallback: 4dp
    const f = (v) => {
      if (v == null || !isFinite(v) || isNaN(v)) return parseFloat(price.toFixed(5));
      if (price >= 10000) return parseFloat(v.toFixed(2));   // BTC, ETH, Gold, NIFTY
      if (price >= 100)   return parseFloat(v.toFixed(3));   // XAU, some crypto
      if (price >= 1)     return parseFloat(v.toFixed(5));   // Forex: EURUSD, GBPUSD
      return parseFloat(v.toFixed(6));                        // sub-1 pairs: XRPUSDT etc
    };
    const buf = atr * 0.15; // small buffer to avoid exact level rejection

    // ── Gather structural data ───────────────────────────────
    const highs   = candles.length ? candles.map(c => c.high)  : [];
    const lows    = candles.length ? candles.map(c => c.low)   : [];
    const closes  = candles.length ? candles.map(c => c.close) : [];

    const swH5 = highs.length  ? Indicators.swingHighs(highs, 3, 5) : [];
    const swL5 = lows.length   ? Indicators.swingLows(lows, 3, 5)   : [];

    // Safe helpers — never return Infinity/-Infinity
    const safeNearHigh = (swings, above, fallback) => {
      const vals = swings.map(s => s.value).filter(v => v > above && isFinite(v));
      return vals.length ? Math.min(...vals) : fallback;
    };
    const safeNearLow = (swings, below, fallback) => {
      const vals = swings.map(s => s.value).filter(v => v < below && isFinite(v));
      return vals.length ? Math.max(...vals) : fallback;
    };

    // Nearest opposing swing for TP1
    const nearestSwHigh = safeNearHigh(swH5, price, price + atr * 2);
    const nearestSwLow  = safeNearLow(swL5,  price, price - atr * 2);

    // H1 swing targets for TP2
    const h1H = h1.length ? Indicators.swingHighs(h1.map(c => c.high), 2, 3) : [];
    const h1L = h1.length ? Indicators.swingLows(h1.map(c => c.low),  2, 3)  : [];
    const h1SwHigh = safeNearHigh(h1H, price, price + atr * 4);
    const h1SwLow  = safeNearLow(h1L,  price, price - atr * 4);

    // ── Per-strategy structural entry & SL ───────────────────
    let entry = price;
    let sl, tp1, tp2, tp3;

    const id = conditions._strategyId || '';

    if (direction === 'BUY') {
      // Strategy-specific entry and SL
      if (id === 'FVG' && conditions.gapBottom != null) {
        // Enter at bottom of FVG (gap support), SL just below gap
        entry = f(conditions.gapBottom + buf);
        sl    = f(conditions.gapBottom - atr * 0.5 - buf);
      } else if (id === 'OB' && conditions.obBot != null) {
        // Enter at top of OB zone, SL below OB low
        entry = f(conditions.obBot + (conditions.obTop - conditions.obBot) * 0.3 + buf);
        sl    = f(conditions.obBot - atr * 0.3 - buf);
      } else if ((id === 'CHOCH' || id === 'BOS') && conditions.brokenLevel != null) {
        // Enter on retest of broken level
        entry = f(conditions.brokenLevel + buf);
        sl    = f(conditions.brokenLevel - atr * 0.8);
      } else if (id === 'LIQ_SWEEP' && conditions.sweptLevel != null) {
        // Enter at the swept low level (liquidity already cleared)
        entry = f(conditions.sweptLevel + buf);
        sl    = f(conditions.sweepLow - atr * 0.3);
      } else if (id === 'SR' && conditions.level != null) {
        // Enter just above support zone
        entry = f(conditions.level + buf);
        sl    = f(conditions.level - atr * 0.6);
      } else if (id === 'INSIDE_BAR' && conditions.motherLow != null) {
        // Enter at mother candle high break
        entry = f(conditions.motherHigh + buf);
        sl    = f(conditions.motherLow - buf);
      } else if (id === 'BB' && (conditions.lower != null || conditions.upper != null)) {
        // BB squeeze breakout — enter on breakout side
        if (conditions.lower != null) {
          entry = f(conditions.lower - buf);
          sl    = f(conditions.lower - atr * 0.8);
        } else {
          entry = f(conditions.upper + buf);
          sl    = f(conditions.upper + atr * 0.8);
        }
      } else if (id === 'MA_STACK' && conditions.ema26 != null) {
        entry = f(conditions.ema26 + buf);
        sl    = f(conditions.ema26 - atr * 0.8);
      } else if (id === 'PULLBACK' && conditions.ema50 != null) {
        entry = f(conditions.ema50 + buf);
        sl    = f(conditions.ema50 - atr);
      } else if (id === 'MR' && conditions.sma50 != null) {
        entry = f(price + buf);
        sl    = f(price - atr * 1.2);
      } else if (id === 'FIB' && conditions.fibLevel != null) {
        entry = f(conditions.fibLevel + buf);
        sl    = f(conditions.fibLevel - atr * 0.6);
      } else if (id === 'BB_BOUNCE' && (conditions.lower != null || conditions.lowerBand != null)) {
        const lBand = conditions.lower ?? conditions.lowerBand;
        entry = f(lBand + buf);
        sl    = f(lBand - atr * 0.5);
      } else if (id === 'ORB' && conditions.orbHigh != null) {
        entry = f(conditions.orbHigh + buf);
        sl    = f(conditions.orbLow - buf);
      } else if (id === 'CONS_BREAK' && conditions.consHigh != null) {
        entry = f(conditions.consHigh + buf);
        sl    = f(conditions.consLow - buf);
      } else if (id === 'TL_BREAK' && conditions.trendlineValue != null) {
        entry = f(conditions.trendlineValue + buf);
        sl    = f(conditions.trendlineValue - atr);
      } else {
        // Generic fallback: current price, ATR-based SL
        entry = f(price);
        sl    = f(price - atr * 1.5);
      }

      // Structure-based TPs: nearest M5 swing → H1 swing → 3R extension
      const risk = Math.max(entry - sl, atr * 0.5); // min risk = 0.5 ATR
      tp1 = f(nearestSwHigh > entry + atr * 0.3 ? Math.min(nearestSwHigh - buf, entry + risk * 2) : entry + risk * 1.5);
      tp2 = f(h1SwHigh      > tp1 + atr * 0.5   ? Math.min(h1SwHigh - buf,     entry + risk * 3) : entry + risk * 2.5);
      tp3 = f(entry + risk * 4);
      // Enforce ascending order
      if (tp2 <= tp1) tp2 = f(tp1 + risk * 0.8);
      if (tp3 <= tp2) tp3 = f(tp2 + risk * 1.2);

    } else { // SELL

      if (id === 'FVG' && conditions.gapTop != null) {
        entry = f(conditions.gapTop - buf);
        sl    = f(conditions.gapTop + atr * 0.5 + buf);
      } else if (id === 'OB' && conditions.obTop != null) {
        entry = f(conditions.obTop - (conditions.obTop - conditions.obBot) * 0.3 - buf);
        sl    = f(conditions.obTop + atr * 0.3 + buf);
      } else if ((id === 'CHOCH' || id === 'BOS') && conditions.brokenLevel != null) {
        entry = f(conditions.brokenLevel - buf);
        sl    = f(conditions.brokenLevel + atr * 0.8);
      } else if (id === 'LIQ_SWEEP' && conditions.sweptLevel != null) {
        entry = f(conditions.sweptLevel - buf);
        sl    = f(conditions.sweepHigh + atr * 0.3);
      } else if (id === 'SR' && conditions.level != null) {
        entry = f(conditions.level - buf);
        sl    = f(conditions.level + atr * 0.6);
      } else if (id === 'INSIDE_BAR' && conditions.motherHigh != null) {
        entry = f(conditions.motherLow - buf);
        sl    = f(conditions.motherHigh + buf);
      } else if (id === 'BB' && (conditions.lower != null || conditions.upper != null)) {
        // BB squeeze breakout — enter on breakout side
        if (conditions.lower != null) {
          entry = f(conditions.lower - buf);
          sl    = f(conditions.lower - atr * 0.8);
        } else {
          entry = f(conditions.upper + buf);
          sl    = f(conditions.upper + atr * 0.8);
        }
      } else if (id === 'BB' && (conditions.upper != null || conditions.lower != null)) {
        if (conditions.upper != null) {
          entry = f(conditions.upper + buf);
          sl    = f(conditions.upper + atr * 0.8);
        } else {
          entry = f(conditions.lower - buf);
          sl    = f(conditions.lower - atr * 0.8);
        }
      } else if (id === 'MA_STACK' && conditions.ema26 != null) {
        entry = f(conditions.ema26 - buf);
        sl    = f(conditions.ema26 + atr * 0.8);
      } else if (id === 'PULLBACK' && conditions.ema50 != null) {
        entry = f(conditions.ema50 - buf);
        sl    = f(conditions.ema50 + atr);
      } else if (id === 'MR' && conditions.sma50 != null) {
        entry = f(price - buf);
        sl    = f(price + atr * 1.2);
      } else if (id === 'FIB' && conditions.fibLevel != null) {
        entry = f(conditions.fibLevel - buf);
        sl    = f(conditions.fibLevel + atr * 0.6);
      } else if (id === 'BB_BOUNCE' && (conditions.upper != null || conditions.upperBand != null)) {
        const uBand = conditions.upper ?? conditions.upperBand;
        entry = f(uBand - buf);
        sl    = f(uBand + atr * 0.5);
      } else if (id === 'ORB' && conditions.orbLow != null) {
        entry = f(conditions.orbLow - buf);
        sl    = f(conditions.orbHigh + buf);
      } else if (id === 'CONS_BREAK' && conditions.consLow != null) {
        entry = f(conditions.consLow - buf);
        sl    = f(conditions.consHigh + buf);
      } else if (id === 'TL_BREAK' && conditions.trendlineValue != null) {
        entry = f(conditions.trendlineValue - buf);
        sl    = f(conditions.trendlineValue + atr);
      } else {
        entry = f(price);
        sl    = f(price + atr * 1.5);
      }

      const risk = Math.max(sl - entry, atr * 0.5);
      tp1 = f(nearestSwLow < entry - atr * 0.3 ? Math.max(nearestSwLow + buf, entry - risk * 2) : entry - risk * 1.5);
      tp2 = f(h1SwLow      < tp1 - atr * 0.5   ? Math.max(h1SwLow + buf,     entry - risk * 3) : entry - risk * 2.5);
      tp3 = f(entry - risk * 4);
      // Enforce descending order
      if (tp2 >= tp1) tp2 = f(tp1 - risk * 0.8);
      if (tp3 >= tp2) tp3 = f(tp2 - risk * 1.2);
    }

    // Compute actual R:R from calculated levels
    const actualRisk   = Math.abs(entry - sl);
    const actualReward = Math.abs(tp2 - entry);
    const rr = actualRisk > 0 ? (actualReward / actualRisk).toFixed(1) : '2.0';

    return { entry, sl, tp1, tp2, tp3, riskReward: `1:${rr}` };
  }

  // Boost score when multiple fired strategies agree on same direction
  static confluenceBoost(firedStrategies, chosenDirection) {
    const agreeing = firedStrategies.filter(s => s.direction === chosenDirection).length;
    return Math.min(agreeing * 3, 15); // up to +15 points for confluence
  }

  // mtfData = { m5, h1, h4 } from HybridDataFetcher.fetchMTF()
  static build(symbol, candles, source, mtfData = null) {
    const h1 = mtfData?.h1 || null;
    const h4 = mtfData?.h4 || null;
    const category = SYMBOLS[symbol]?.category || 'forex';

    // #2 — Only analyse on CLOSED candles. Drop the last candle if still open.
    const confirmedM5 = Indicators.confirmedCandles(candles);
    if (confirmedM5.length < 10) return null;

    // Run all 38 detectors with real MTF data when available
    const { fired, mtfCtx } = StrategyDetectors.runAll(confirmedM5, h1, h4, category);
    if (!fired.length) return null;

    // Sort by score descending — pick best
    fired.sort((a, b) => b.score - a.score);
    const best = fired[0];

    // Confluence boost from multiple strategies agreeing
    const confluenceBoost = this.confluenceBoost(fired, best.direction);

    // MTF alignment boost — real multi-TF confirmation adds score
    const mtfBoost = MTFContext.scoreBoost(mtfCtx);

    const finalScore = Math.min(best.score + confluenceBoost + mtfBoost, 100);
    if (finalScore < CONFIG.SIGNAL_QUALITY_MIN) return null;

    // Indicators on M5 (entry TF) — using confirmed closed candles
    const closes  = confirmedM5.map(c => c.close);
    const highs   = confirmedM5.map(c => c.high);
    const lows    = confirmedM5.map(c => c.low);
    const price   = closes[closes.length - 1];
    const atr     = Indicators.atr(highs, lows, closes);
    const rsi     = Indicators.rsi(closes);
    const macd    = Indicators.macd(closes);
    const ema12   = Indicators.ema(closes, 12);
    const ema26   = Indicators.ema(closes, 26);
    const ema50   = Indicators.ema(closes, Math.min(50, closes.length - 1));
    // #3 — Smart volume: real for crypto, range-proxy for forex
    const vol     = Indicators.smartVolume(confirmedM5, category);
    const m5Trend = Indicators.trendStrength(closes);

    // H1 indicators (zone TF)
    let h1Rsi = null, h1Trend = null;
    if (h1 && h1.length >= 15) {
      h1Rsi   = parseFloat(Indicators.rsi(h1.map(c => c.close)).toFixed(2));
      h1Trend = Indicators.trendStrength(h1.map(c => c.close)).trend;
    }

    // H4 indicators (bias TF)
    let h4Rsi = null, h4Trend = null;
    if (h4 && h4.length >= 10) {
      h4Rsi   = parseFloat(Indicators.rsi(h4.map(c => c.close)).toFixed(2));
      h4Trend = Indicators.trendStrength(h4.map(c => c.close)).trend;
    }

    const confirmingStrategies = fired
      .filter(s => s.direction === best.direction)
      .map(s => ({ id: s.id, name: s.name, score: s.score }));

    return {
      id:          `${symbol}_${Date.now()}`,
      symbol,
      symbolName:  SYMBOLS[symbol].name,
      category:    SYMBOLS[symbol].category,
      direction:   best.direction,
      quality:     finalScore,
      strategy: {
        id:          best.id,
        name:        best.name,
        probability: best.probability,
        strength:    best.strength,
      },
      confirmedBy:  confirmingStrategies,
      totalFired:   fired.length,
      levels:       this.calculateLevels(best.direction, price, atr,
                      { ...best.conditions, _strategyId: best.id },
                      candles, h1 || [], h4 || []),

      // M5 indicators (entry)
      indicators: {
        rsi:       parseFloat(rsi.toFixed(2)),
        macd:      parseFloat(macd.macdLine.toFixed(6)),
        histogram: parseFloat(macd.histogram.toFixed(6)),
        trend:     m5Trend.trend,
        ema12:     parseFloat(ema12.toFixed(6)),
        ema26:     parseFloat(ema26.toFixed(6)),
        ema50:     parseFloat(ema50.toFixed(6)),
        volume:    vol,
        atr:       parseFloat(atr.toFixed(6)),
      },

      // MTF analysis summary
      mtf: {
        enabled:    !!(h1 && h4),
        bias:       mtfCtx.bias,
        alignment:  mtfCtx.alignment,
        h4Trend:    mtfCtx.h4Trend,
        h1Trend:    mtfCtx.h1Trend,
        m5Trend:    mtfCtx.m5Trend,
        h4Rsi, h1Rsi,
        mtfBoost,
      },

      strategyConditions: best.conditions,
      dataSource:   source,
      candleCount:  confirmedM5.length,
      timestamp:    new Date().toISOString(),
      session:      SessionFilter.currentSession(),
      // #4 Signal expiry — signal valid for 3 candles (15 min)
      expiresAt:    new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      expired:      false,
      invalidated:  false,
    };
  }
}

// ============================================================
// ── SECTION 4: DATA FETCHERS ─────────────────────────────────
// ============================================================

class TwelveDataFetcher {
  constructor() {
    this.apiKey   = CONFIG.TWELVE_DATA_API_KEY;
    this.baseUrl  = CONFIG.TWELVE_DATA_REST;
    this.lastCall = 0;
  }

  // interval: '5min' | '1h' | '4h'
  async fetchCandles(tdSymbol, interval = '5min', outputsize = 100) {
    try {
      if (!this.apiKey) { console.warn(`[TwelveData] No key — skipping ${tdSymbol}`); return null; }
      // Rate limit: 8s between calls on free tier (max 8/min)
      const now  = Date.now();
      const wait = 8000 - (now - this.lastCall);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.lastCall = Date.now();

      const res = await axios.get(`${this.baseUrl}/time_series`, {
        params: { symbol: tdSymbol, interval, outputsize, apikey: this.apiKey },
        timeout: 15000,
      });

      const d = res.data;
      if (d.status === 'error' || d.code) { console.error(`[TwelveData] ${tdSymbol}/${interval}: ${d.message}`); return null; }
      if (!d.values?.length) return null;

      const candles = d.values.reverse().map(b => ({
        time: new Date(b.datetime).getTime(),
        open: parseFloat(b.open), high: parseFloat(b.high),
        low:  parseFloat(b.low),  close: parseFloat(b.close),
        volume: parseFloat(b.volume || 0) || 1,
      }));
      console.log(`[TwelveData] ✅ ${tdSymbol} [${interval}]: ${candles.length} candles`);
      return candles;
    } catch (err) {
      console.error(`[TwelveData] Error ${tdSymbol}/${interval}: ${err.response?.status || err.message}`);
      return null;
    }
  }
}

class YahooFetcher {
  // interval: '5m' | '1h' | '1d'
  async fetchCandles(yahooSymbol, interval = '5m') {
    try {
      const now    = Math.floor(Date.now() / 1000);
      // Lookback window based on interval
      const window = interval === '1h' ? 60 * 86400 : interval === '1d' ? 365 * 86400 : 86400;
      const from   = now - window;
      const res    = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=${interval}&period1=${from}&period2=${now}`,
        { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const result = res.data?.chart?.result?.[0];
      if (!result?.timestamp?.length) return null;
      const { timestamp, indicators } = result;
      const q = indicators.quote[0];
      const candles = timestamp
        .map((t, i) => ({ time: t * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0 }))
        .filter(c => c.open != null && c.close != null);
      if (candles.length < 10) return null;
      console.log(`[Yahoo] ✅ ${yahooSymbol} [${interval}]: ${candles.length} candles`);
      return candles;
    } catch (err) {
      console.error(`[Yahoo] Error ${yahooSymbol}/${interval}: ${err.response?.status || err.message}`);
      return null;
    }
  }
}

// ============================================================
// COINGECKO FETCHER — Smart batched fetcher
// Strategy:
//   - All 5 coins are pre-fetched ONCE per cycle with 20s stagger
//   - Results cached in this.batch{}
//   - On 429, skip fallback immediately and return cached data
//   - Batch is refreshed only once every 4.5 minutes (just under 5min cycle)
// ============================================================
class CoinGeckoFetcher {
  constructor() {
    this.baseUrl    = CONFIG.COINGECKO_REST;
    this.batch      = {};        // { cgId: candles[] }
    this.batchTime  = 0;         // when last batch was fetched
    this.batchTTL   = 8 * 60 * 1000;   // 8 minutes — well above 5min cycle
    this.rateLimited = false;    // global 429 flag
    this.rateLimitUntil = 0;     // backoff until timestamp
  }

  // Called once per cycle to pre-fetch all coins with stagger
  async prefetchAll(cgIds) {
    // Skip if batch is still fresh (TTL 6min > 5min cycle = never double-fetches)
    if (Date.now() - this.batchTime < this.batchTTL && Object.keys(this.batch).length > 0) {
      console.log(`[CoinGecko] Using cached batch (${Object.keys(this.batch).length}/5 coins)`);
      return;
    }

    // Skip if globally rate limited and backoff not expired
    if (this.rateLimited && Date.now() < this.rateLimitUntil) {
      const secsLeft = Math.ceil((this.rateLimitUntil - Date.now()) / 1000);
      console.log(`[CoinGecko] Rate limited — ${secsLeft}s backoff remaining, using cache`);
      return;
    }
    this.rateLimited = false;

    console.log('[CoinGecko] Prefetching all 5 crypto coins (20s stagger)...');
    let fetched = 0;

    for (let i = 0; i < cgIds.length; i++) {
      const cgId = cgIds[i];
      // 20s between each coin = 3 req/min, well under CoinGecko free limit
      if (i > 0) await new Promise(r => setTimeout(r, 20000));

      try {
        const res = await axios.get(`${this.baseUrl}/coins/${cgId}/ohlc`, {
          params: { vs_currency: 'usd', days: '1' },
          timeout: 15000,
          headers: { 'Accept': 'application/json' },
        });

        if (res.data?.length) {
          this.batch[cgId] = res.data.map(c => ({
            time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: 1000000,
          }));
          fetched++;
          console.log(`[CoinGecko] SUCCESS ${cgId}: ${this.batch[cgId].length} candles (${fetched}/${cgIds.length})`);
        }

      } catch (err) {
        const status = err.response?.status;
        if (status === 429) {
          // Back off 90s to fully clear the rate limit window
          this.rateLimited    = true;
          this.rateLimitUntil = Date.now() + 120000;
          console.warn(`[CoinGecko] 429 on ${cgId} — 120s backoff, cache used for remaining ${cgIds.length - i} coins`);
          break;
        } else {
          console.error(`[CoinGecko] Error ${cgId}: ${status || err.message}`);
        }
      }
    }

    if (fetched > 0) this.batchTime = Date.now();
    console.log(`[CoinGecko] Prefetch complete — ${fetched}/${cgIds.length} fresh, rest from cache`);
  }

  // Returns candles from batch (already fetched by prefetchAll)
  getCandles(cgId) {
    return this.batch[cgId] || null;
  }
}

// ── #7 DHAN LIVE TOKEN MANAGER ──────────────────────────────
// Dhan access tokens expire daily. Instead of redeploying each time,
// POST to /api/dhan/token with your new token to update it live.
// The bot will immediately start using it for NIFTY/BANKNIFTY/FINNIFTY.
const dhanLiveToken = {
  clientId:    process.env.DHAN_CLIENT_ID    || 'placeholder',
  accessToken: process.env.DHAN_ACCESS_TOKEN || 'placeholder',
  updatedAt:   null,
};

class DhanFetcher {
  constructor() {
    this.clientId    = CONFIG.DHAN_CLIENT_ID;
    this.accessToken = CONFIG.DHAN_ACCESS_TOKEN;
    this.baseUrl     = CONFIG.DHAN_REST;
  }

  formatDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  isWeekday() {
    const day = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).getDay();
    return day >= 1 && day <= 5;
  }

  async fetchCandles(symbol) {
    try {
      if (this.clientId === 'placeholder' || this.accessToken === 'placeholder') {
        console.log(`[Dhan] Placeholder credentials — skipping ${symbol}`);
        return null;
      }
      if (!this.isWeekday()) { console.log(`[Dhan] Weekend — skipping ${symbol}`); return null; }

      const config   = SYMBOLS[symbol];
      const toDate   = new Date();
      const fromDate = new Date(); fromDate.setDate(fromDate.getDate() - 5);

      const res = await axios.post(`${this.baseUrl}/v2/charts/historical`, {
        securityId: config.dhanSecurityId, exchangeSegment: 'IDX_I',
        instrument: 'INDEX', expiryCode: 0, oi: false,
        fromDate: this.formatDate(fromDate), toDate: this.formatDate(toDate),
        interval: 'FIVE_MINUTE',
      }, {
        headers: { 'access-token': dhanLiveToken.accessToken !== 'placeholder' ? dhanLiveToken.accessToken : this.accessToken, 'client-id': dhanLiveToken.clientId !== 'placeholder' ? dhanLiveToken.clientId : this.clientId, 'Content-Type': 'application/json' },
        timeout: 15000,
      });

      const data = res.data;
      if (!data?.open?.length) return null;
      const candles = data.timestamp.map((t, i) => ({
        time: t * 1000, open: data.open[i], high: data.high[i],
        low: data.low[i], close: data.close[i], volume: data.volume?.[i] || 0,
      }));
      console.log(`[Dhan] ✅ ${symbol}: ${candles.length} candles`);
      return candles;
    } catch (err) {
      const msg = err.response?.data?.remarks || err.response?.data?.message || err.message;
      console.error(`[Dhan] Error ${symbol}: ${err.response?.status} — ${msg}`);
      if (msg?.toLowerCase().includes('token')) {
        console.error('[Dhan] ⚠️  Token expired — update DHAN_ACCESS_TOKEN in Render env vars');
      }
      return null;
    }
  }
}

class MetaTraderReceiver {
  constructor() { this.data = {}; this.lastUpdate = {}; }
  receiveData(symbol, candles) { this.data[symbol] = candles; this.lastUpdate[symbol] = Date.now(); }
  getCandles(symbol) {
    if (!this.lastUpdate[symbol] || Date.now() - this.lastUpdate[symbol] > 15 * 60 * 1000) return null;
    return this.data[symbol] || null;
  }
}

class HybridDataFetcher {
  constructor() {
    this.twelvedata = new TwelveDataFetcher();
    this.yahoo      = new YahooFetcher();
    this.coingecko  = new CoinGeckoFetcher();
    this.dhan       = new DhanFetcher();
    this.metatrader = new MetaTraderReceiver();
    this.cache      = {};
    this.mtfCache   = {}; // MTF candle cache: { symbol_mtf: { data, time } }

    // All CoinGecko coin IDs in order
    this.cgIds = Object.values(SYMBOLS)
      .filter(s => s.source === 'coingecko')
      .map(s => s.cgId);
  }

  async initialize() {
    console.log('[Bot] Data sources: CoinGecko (batch) | Twelve Data | Yahoo Finance | Dhan');
    await this.coingecko.prefetchAll(this.cgIds);
  }

  async prefetchCrypto() {
    await this.coingecko.prefetchAll(this.cgIds);
  }

  // ── Fetch single TF (5m) candles ───────────────────────────
  async fetchCandles(symbol) {
    const config = SYMBOLS[symbol];
    if (!config) return null;
    let candles = null, source = 'unknown';

    try {
      if (config.source === 'twelvedata') {
        candles = await this.twelvedata.fetchCandles(config.tdSymbol, '5min', 100);
        source  = 'twelvedata';
      } else if (config.source === 'yahoo') {
        candles = await this.yahoo.fetchCandles(config.yahooSymbol, '5m');
        source  = 'yahoo';
      } else if (config.source === 'coingecko') {
        candles = this.coingecko.getCandles(config.cgId);
        source  = candles ? 'coingecko' : 'unknown';
      } else if (config.source === 'dhan') {
        candles = await this.dhan.fetchCandles(symbol);
        source  = 'dhan';
      }
    } catch (err) { console.error(`[Hybrid] ${symbol}:`, err.message); }

    if (!candles || candles.length < 10) {
      const mt = this.metatrader.getCandles(symbol);
      if (mt) { candles = mt; source = 'metatrader'; }
    }
    if (!candles || candles.length < 10) {
      if (this.cache[symbol]) { candles = this.cache[symbol]; source = 'cache'; }
    }
    if (candles?.length >= 10) this.cache[symbol] = candles;
    return candles?.length >= 10 ? { candles, source } : null;
  }

  // ── Fetch ALL THREE timeframes for a symbol ─────────────────
  // Returns { m5, h1, h4, source } or null
  // m5  = 5-minute  (100 candles) → entry timeframe
  // h1  = 1-hour    (100 candles) → zone timeframe
  // h4  = 4-hour    (100 candles) → bias timeframe
  async fetchMTF(symbol) {
    const config = SYMBOLS[symbol];
    if (!config) return null;

    const cacheKey = `${symbol}_mtf`;
    const mtfTTL   = 4 * 60 * 1000; // 4 min cache — h1/h4 don't change fast

    // Return cached MTF if still fresh
    if (this.mtfCache[cacheKey] && Date.now() - this.mtfCache[cacheKey].time < mtfTTL) {
      return this.mtfCache[cacheKey].data;
    }

    let m5 = null, h1 = null, h4 = null, source = 'unknown';

    try {
      if (config.source === 'twelvedata') {
        // Fetch all 3 TFs — each call has 8s rate limit built in
        m5 = await this.twelvedata.fetchCandles(config.tdSymbol, '5min',  100);
        h1 = await this.twelvedata.fetchCandles(config.tdSymbol, '1h',    100);
        h4 = await this.twelvedata.fetchCandles(config.tdSymbol, '4h',    100);
        source = 'twelvedata';

      } else if (config.source === 'yahoo') {
        m5 = await this.yahoo.fetchCandles(config.yahooSymbol, '5m');
        h1 = await this.yahoo.fetchCandles(config.yahooSymbol, '1h');
        // Yahoo 4h not available — build from 1h candles
        h4 = h1 ? this._resample(h1, 4) : null;
        source = 'yahoo';

      } else if (config.source === 'coingecko') {
        // CoinGecko OHLC: days=1 gives ~30min candles, days=7 gives 4h candles
        m5 = this.coingecko.getCandles(config.cgId);  // from batch
        const h1Raw = await this._cgFetchH1(config.cgId);
        h1 = h1Raw;
        h4 = h1 ? this._resample(h1, 4) : null;
        source = 'coingecko';

      } else if (config.source === 'dhan') {
        // Dhan only provides 5min — use resample for higher TFs
        m5 = await this.dhan.fetchCandles(symbol);
        if (m5 && m5.length >= 20) {
          h1 = this._resample(m5, 12); // 12 × 5min = 1h
          h4 = this._resample(m5, 48); // 48 × 5min = 4h
        }
        source = 'dhan';
      }
    } catch (err) { console.error(`[MTF] ${symbol}:`, err.message); }

    // Fallbacks from cache
    if (!m5 || m5.length < 10) {
      const cached = this.cache[symbol];
      if (cached) { m5 = cached; }
    }
    if (m5?.length >= 10) this.cache[symbol] = m5;

    // Need at least m5 to proceed
    if (!m5 || m5.length < 10) return null;

    // If HTF missing, resample from m5
    if (!h1 || h1.length < 10) h1 = this._resample(m5, 12);
    if (!h4 || h4.length < 5)  h4 = this._resample(m5, 48);

    const result = { m5, h1, h4, source };
    this.mtfCache[cacheKey] = { data: result, time: Date.now() };
    return result;
  }

  // ── Resample candles: combine N consecutive candles into one ─
  _resample(candles, n) {
    if (!candles || candles.length < n) return candles;
    const result = [];
    for (let i = 0; i + n <= candles.length; i += n) {
      const slice = candles.slice(i, i + n);
      result.push({
        time:   slice[0].time,
        open:   slice[0].open,
        high:   Math.max(...slice.map(c => c.high)),
        low:    Math.min(...slice.map(c => c.low)),
        close:  slice[slice.length - 1].close,
        volume: slice.reduce((s, c) => s + (c.volume || 0), 0),
      });
    }
    return result;
  }

  // ── CoinGecko hourly candles (days=7 gives 4h OHLC) ─────────
  async _cgFetchH1(cgId) {
    try {
      // CoinGecko market_chart with days=7 gives hourly data points
      const res = await axios.get(`${CONFIG.COINGECKO_REST}/coins/${cgId}/market_chart`, {
        params: { vs_currency: 'usd', days: '7', interval: 'hourly' },
        timeout: 15000,
      });
      if (!res.data?.prices?.length) return null;
      const prices = res.data.prices;
      return prices.map((p, i) => {
        const prev = prices[i - 1] || p;
        return {
          time:   p[0],
          open:   prev[1],
          high:   Math.max(p[1], prev[1]),
          low:    Math.min(p[1], prev[1]),
          close:  p[1],
          volume: 1000000,
        };
      });
    } catch { return null; }
  }
}

// ============================================================
// ── SECTION 5: TELEGRAM ──────────────────────────────────────
// ============================================================
async function sendTelegramAlert(signal) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  const emoji = signal.direction === 'BUY' ? '🟢' : '🔴';
  const bar   = '█'.repeat(Math.floor(signal.quality / 10)) + '░'.repeat(10 - Math.floor(signal.quality / 10));

  // List confirming strategies (up to 3)
  const confirms = signal.confirmedBy.slice(0, 3).map(s => `  • ${s.name}`).join('\n');

  const mtfLine = signal.mtf?.enabled
    ? `📡 *MTF Bias:* H4:${signal.mtf?.h4Trend} | H1:${signal.mtf?.h1Trend} | M5:${signal.mtf?.m5Trend} [${signal.mtf?.alignment}]`
    : `📡 *MTF:* M5 only`;
  const sessionLine = `🌍 *Session:* ${(signal.session || 'UNKNOWN').replace(/_/g,' ')} | Expires: ${signal.expiresAt ? new Date(signal.expiresAt).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'}) : 'N/A'} IST`;

  const msg = `${emoji} *${signal.direction} SIGNAL — ${signal.symbol}*
━━━━━━━━━━━━━━━━━━━━
📊 ${signal.symbolName} | ${signal.category.toUpperCase()}
⚡ *${signal.strategy.name}*
💯 Quality: ${signal.quality}/100 [${bar}]
📐 Strength: ${signal.strategy.strength.replace(/_/g, ' ').toUpperCase()}

${mtfLine}
${sessionLine}

💰 Entry:  \`${signal.levels?.entry ?? 'N/A'}\`
🛑 SL:     \`${signal.levels?.sl ?? 'N/A'}\`
🎯 TP1:    \`${signal.levels?.tp1 ?? 'N/A'}\`
🎯 TP2:    \`${signal.levels?.tp2 ?? 'N/A'}\`
🎯 TP3:    \`${signal.levels?.tp3 ?? 'N/A'}\`
📐 R:R     ${signal.levels.riskReward}

📈 *Indicators (M5):*
  RSI: ${signal.indicators.rsi} | Trend: ${signal.indicators.trend}
  MACD: ${signal.indicators.macd > 0 ? '▲' : '▼'} ${signal.indicators.macd}
  Vol: ${signal.indicators.volume.spike ? '✅ spike' : '❌ normal'} (${signal.indicators.volume.ratio}x avg)
  ATR: ${signal.indicators.atr}

✅ *Confirmed by ${signal.confirmedBy.length} strategies:*
${confirms}

🔌 Source: ${signal.dataSource.toUpperCase()} | ${signal.candleCount} candles
🕑 ${new Date(signal.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
⚠️ _For educational purposes only_`;

  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: CONFIG.TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' },
      { timeout: 10000 }
    );
    console.log(`[Telegram] ✅ Sent ${signal.direction} ${signal.symbol}`);
  } catch (err) { console.error('[Telegram] Error:', err.message); }
}

// ============================================================
// ── SECTION 6: BOT ENGINE ────────────────────────────────────
// ============================================================

// ── Signal Gate: prevents false, repeated, conflicting signals ──
// Rules:
//  1. Quality >= 75 (raised from 65)
//  2. At least 2 strategies must confirm
//  3. Entry price within 0.3% of live candle close (no stale price)
//  4. 30-min cooldown per symbol (no spam every 5 min)
//  5. No direction flip within 60 min (no BUY then SELL same symbol)
//  6. No duplicate: same strategy + direction within 2 hours
class SignalGate {
  constructor() {
    this.lastSignal = {}; // { symbol: { direction, time, price, strategy } }
  }

  check(signal, currentPrice) {
    const symbol = signal.symbol;
    const now    = Date.now();
    const last   = this.lastSignal[symbol];

    // Rule 1: Quality gate
    if (signal.quality < 75) {
      return { allowed: false, reason: `Quality ${signal.quality} < 75` };
    }

    // Rule 2: Need at least 2 strategies confirming
    if (signal.confirmedBy.length < 2) {
      return { allowed: false, reason: `Only ${signal.confirmedBy.length} confirmation — need 2+` };
    }

    // Rule 3: Price validity — entry must be within 0.3% of live price
    if (currentPrice > 0) {
      const drift = Math.abs(signal.levels.entry - currentPrice) / currentPrice;
      if (drift > 0.003) {
        return { allowed: false, reason: `Price drift ${(drift*100).toFixed(2)}% > 0.3%` };
      }
    }

    if (last) {
      const mins = (now - last.time) / 60000;

      // Rule 4: 30-min cooldown per symbol
      if (mins < 30) {
        return { allowed: false, reason: `Cooldown: ${mins.toFixed(1)}min < 30min` };
      }

      // Rule 5: No direction flip within 60 min
      if (mins < 60 && last.direction !== signal.direction) {
        return { allowed: false, reason: `Direction flip blocked: was ${last.direction} ${mins.toFixed(1)}min ago` };
      }

      // Rule 6: No duplicate strategy+direction within 2h
      if (mins < 120 && last.direction === signal.direction && last.strategy === signal.strategy.id) {
        return { allowed: false, reason: `Duplicate ${signal.strategy.id} ${signal.direction} within 2h` };
      }
    }

    return { allowed: true, reason: 'passed' };
  }

  record(signal) {
    this.lastSignal[signal.symbol] = {
      direction: signal.direction,
      time:      Date.now(),
      price:     signal.levels.entry,
      strategy:  signal.strategy.id,
    };
  }

  cooldowns() {
    const now = Date.now();
    return Object.entries(this.lastSignal).map(([sym, s]) => ({
      symbol: sym, direction: s.direction, strategy: s.strategy,
      minsAgo: Math.round((now - s.time) / 60000),
      cooldownLeft: Math.max(0, Math.round(30 - (now - s.time) / 60000)),
    }));
  }
}

const signalGate = new SignalGate();
const botState = {
  signals: [], lastCycle: null,
  stats: {
    totalAnalyzed: 0, totalSignals: 0,
    totalStrategiesFired: 0, blockedByGate: 0,
    startTime: Date.now(),
  },
  isRunning: false,
};
const dataFetcher = new HybridDataFetcher();

// ── #4 Signal Expiry Checker ────────────────────────────────
// Runs every cycle. Marks signals as expired if:
//   a) 15 minutes have passed since signal (time expiry), OR
//   b) price has moved more than 2×ATR away from entry zone (price invalidation)
// Sends a Telegram "INVALIDATED" alert for each expired active signal.
async function checkSignalExpiry(currentPrices) {
  const now = Date.now();
  for (const signal of botState.signals) {
    if (signal.expired || signal.invalidated) continue;
    const expiryTime = new Date(signal.expiresAt).getTime();

    // Time expiry
    if (now > expiryTime) {
      signal.expired = true;
      console.log(`[Expiry] ⏰ Expired: ${signal.direction} ${signal.symbol} (15min passed)`);
      await sendExpiryAlert(signal, 'TIME_EXPIRED');
      continue;
    }

    // Price invalidation: if current price crossed SL
    const currentPrice = currentPrices[signal.symbol];
    if (currentPrice != null) {
      const slHit = signal.direction === 'BUY'
        ? currentPrice < signal.levels.sl
        : currentPrice > signal.levels.sl;
      if (slHit) {
        signal.invalidated = true;
        console.log(`[Expiry] ❌ SL hit: ${signal.direction} ${signal.symbol} at ${currentPrice}`);
        await sendExpiryAlert(signal, 'SL_INVALIDATED');
      }
    }
  }
}

async function sendExpiryAlert(signal, reason) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  const emoji = reason === 'SL_INVALIDATED' ? '❌' : '⏰';
  const label = reason === 'SL_INVALIDATED' ? 'SIGNAL INVALIDATED — SL Hit' : 'SIGNAL EXPIRED';
  const msg = `${emoji} *${label}*
━━━━━━━━━━━━━━━━━━━━
📊 ${signal.symbolName} | ${signal.direction}
⚡ ${signal.strategy.name}
Entry was: \`${signal.levels.entry}\` | SL: \`${signal.levels?.sl ?? 'N/A'}\`
🕑 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
_No action needed — setup no longer valid_`;
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: CONFIG.TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' },
      { timeout: 10000 }
    );
  } catch (e) { /* silent fail */ }
}



// ============================================================
// ── BACKTESTING ENGINE (#6) ──────────────────────────────────
// Runs all 38 strategies on historical candle data and
// tracks how many signals hit TP1/TP2/TP3 vs SL.
//
// How it works:
//   1. Fetch 500 historical candles (5-day history on 5m)
//   2. Slide a 100-candle window across them
//   3. Run all detectors on each window
//   4. For each signal, look forward 20 candles to see outcome:
//      → TP1 hit first = WIN (partial)
//      → TP2 hit first = WIN (full)
//      → SL  hit first = LOSS
//      → Neither hit   = OPEN (excluded from stats)
//   5. Store winRate, avgRR, total trades per strategy
//
// Results exposed at GET /api/backtest
// ============================================================
class BacktestEngine {
  constructor() {
    this.results    = {};  // { strategyId: { wins, losses, open, winRate, avgRR } }
    this.lastRun    = null;
    this.isRunning  = false;
  }

  async run(dataFetcher) {
    if (this.isRunning) return { error: 'Already running' };
    this.isRunning = true;
    console.log('[Backtest] ⚙️  Starting backtest on 500 candles per symbol...');
    const startTime  = Date.now();
    const results    = {};
    const symbolKeys = Object.keys(SYMBOLS).filter(s => SYMBOLS[s].source !== 'dhan'); // skip Dhan (no token)

    for (const symbol of symbolKeys) {
      try {
        const config = SYMBOLS[symbol];
        let candles  = null;

        // Fetch 500 candles (extended history)
        if (config.source === 'twelvedata') {
          candles = await dataFetcher.twelvedata.fetchCandles(config.tdSymbol, '5min', 500);
        } else if (config.source === 'yahoo') {
          candles = await dataFetcher.yahoo.fetchCandles(config.yahooSymbol, '5m');
        } else if (config.source === 'coingecko') {
          candles = dataFetcher.coingecko.getCandles(config.cgId);
        }

        if (!candles || candles.length < 120) {
          console.log(`[Backtest] ⚠️  Insufficient candles for ${symbol}: ${candles?.length || 0}`);
          continue;
        }

        console.log(`[Backtest] 📊 ${symbol}: ${candles.length} candles`);

        // Slide 100-candle window across all candles
        const windowSize  = 100;
        const forwardLook = 20; // candles to check after signal

        for (let i = windowSize; i < candles.length - forwardLook; i++) {
          const window    = candles.slice(i - windowSize, i);
          const confirmed = Indicators.confirmedCandles(window);
          if (confirmed.length < 50) continue;

          const { fired } = StrategyDetectors.runAll(confirmed, null, null, config.category || 'forex');
          if (!fired.length) continue;

          fired.sort((a, b) => b.score - a.score);
          const best = fired[0];

          // Quick calculate levels for this signal
          const closes = confirmed.map(c => c.close);
          const highs  = confirmed.map(c => c.high);
          const lows   = confirmed.map(c => c.low);
          const price  = closes[closes.length - 1];
          const atr    = Indicators.atr(highs, lows, closes);

          const levels = SignalBuilder.calculateLevels(
            best.direction, price, atr,
            { ...best.conditions, _strategyId: best.id },
            confirmed, [], []
          );
          if (!levels.entry || !levels.sl || !levels.tp1) continue;

          // Look forward to determine outcome
          const future  = candles.slice(i, i + forwardLook);
          let outcome   = 'open';
          for (const fc of future) {
            if (best.direction === 'BUY') {
              if (fc.low  <= levels.sl)  { outcome = 'loss'; break; }
              if (fc.high >= levels.tp2 || fc.high >= levels.tp1) { outcome = 'win'; break; }
            } else {
              if (fc.high >= levels.sl)  { outcome = 'loss'; break; }
              if (fc.low  <= levels.tp2 || fc.low  <= levels.tp1) { outcome = 'win'; break; }
            }
          }

          if (outcome === 'open') continue; // don't count unresolved

          const id  = best.id;
          if (!results[id]) results[id] = { wins: 0, losses: 0, open: 0, totalRR: 0, trades: 0 };
          results[id].trades++;
          if (outcome === 'win') {
            results[id].wins++;
            // Approximate R:R as TP2 distance / SL distance
            const reward = Math.abs(levels.tp2 - levels.entry);
            const risk   = Math.abs(levels.sl   - levels.entry);
            results[id].totalRR += risk > 0 ? reward / risk : 2;
          } else {
            results[id].losses++;
          }
        }

        await new Promise(r => setTimeout(r, 500)); // rate limit respect
      } catch (err) {
        console.error(`[Backtest] Error ${symbol}:`, err.message);
      }
    }

    // Compute final stats
    const summary = {};
    for (const [id, r] of Object.entries(results)) {
      if (r.trades < 3) continue; // not enough data
      summary[id] = {
        strategy:  id,
        trades:    r.trades,
        wins:      r.wins,
        losses:    r.losses,
        winRate:   Math.round((r.wins / r.trades) * 100),
        avgRR:     r.wins > 0 ? parseFloat((r.totalRR / r.wins).toFixed(2)) : 0,
        verdict:   r.wins / r.trades >= 0.55 ? '✅ KEEP' : r.wins / r.trades >= 0.45 ? '⚠️ WATCH' : '❌ REVIEW',
      };
    }

    this.results  = summary;
    this.lastRun  = new Date().toISOString();
    this.isRunning = false;

    const totalTrades = Object.values(summary).reduce((s, r) => s + r.trades, 0);
    const avgWin      = Object.values(summary).length
      ? Math.round(Object.values(summary).reduce((s, r) => s + r.winRate, 0) / Object.values(summary).length)
      : 0;

    console.log(`[Backtest] ✅ Done — ${totalTrades} trades analysed across ${Object.keys(summary).length} strategies | avg win rate: ${avgWin}% | ${Date.now() - startTime}ms`);
    return { summary, totalTrades, avgWinRate: avgWin, ranAt: this.lastRun };
  }
}

const backtestEngine = new BacktestEngine();

// ============================================================
// ── SESSION FILTER (#5) ─────────────────────────────────────
// Different strategies have optimal trading sessions.
// Signals outside optimal session get suppressed or penalized.
//
// Sessions (UTC):
//   Asian    00:00–08:00  low volatility, mean reversion
//   London   08:00–13:00  breakouts, OB, FVG
//   NY Open  13:00–17:00  overlap, momentum, trend
//   NY Late  17:00–22:00  trend continuation
//   Dead     22:00–00:00  avoid most signals
//
// India NSE: 03:45–10:00 UTC (09:15–15:30 IST)
// ============================================================
class SessionFilter {

  static currentSession() {
    const h = new Date().getUTCHours();
    const m = new Date().getUTCMinutes();
    const t = h + m / 60;
    if (t >= 22 || t < 0.5)  return 'DEAD';    // 22:00–00:30 UTC — very low liquidity
    if (t >= 0.5 && t < 8)   return 'ASIAN';   // 00:30–08:00 UTC
    if (t >= 8  && t < 13)   return 'LONDON';  // 08:00–13:00 UTC
    if (t >= 13 && t < 17)   return 'NY_OPEN'; // 13:00–17:00 UTC (overlap)
    if (t >= 17 && t < 22)   return 'NY_LATE'; // 17:00–22:00 UTC
    return 'UNKNOWN';
  }

  static isIndiaMarketHours() {
    // NSE: 09:15–15:30 IST = 03:45–10:00 UTC
    const h = new Date().getUTCHours();
    const m = new Date().getUTCMinutes();
    const t = h * 60 + m;
    return t >= 225 && t <= 600; // 3h45m to 10h00m UTC in minutes
  }

  // Returns { allowed: bool, reason: string, sessionPenalty: number }
  // sessionPenalty: score reduction for signals in non-ideal sessions
  static check(strategyId, category) {
    const session = this.currentSession();

    // India symbols: only during NSE hours
    if (category === 'india') {
      if (!this.isIndiaMarketHours()) {
        return { allowed: false, reason: `India NSE closed (UTC ${new Date().getUTCHours()}:${String(new Date().getUTCMinutes()).padStart(2,'0')})` };
      }
      return { allowed: true, reason: 'NSE market hours', sessionPenalty: 0 };
    }

    // Dead session: block almost everything
    if (session === 'DEAD') {
      // Only allow mean reversion setups (price usually returns to range after NY close)
      const mrStrategies = ['MR', 'MR_FIB', 'FVG_MR', 'FIB', 'BB_BOUNCE'];
      if (mrStrategies.includes(strategyId)) {
        return { allowed: true, reason: 'MR allowed in dead session', sessionPenalty: 8 };
      }
      return { allowed: false, reason: `Dead session (UTC ${new Date().getUTCHours()}:00) — ${strategyId} blocked` };
    }

    // Strategy-session optimal mapping
    const optimalSessions = {
      // Breakout strategies → best in London/NY
      'ORB':        ['LONDON', 'NY_OPEN'],
      'ORB_MA':     ['LONDON', 'NY_OPEN'],
      'OVERLAP':    ['NY_OPEN'],
      'OVERLAP_OB': ['NY_OPEN'],
      'CONS_BREAK': ['LONDON', 'NY_OPEN'],
      'TL_BREAK':   ['LONDON', 'NY_OPEN'],
      // Institutional / smart money → London + NY
      'FVG':        ['LONDON', 'NY_OPEN', 'NY_LATE'],
      'FVG_BOS':    ['LONDON', 'NY_OPEN'],
      'FVG_BOS_HTF':['LONDON', 'NY_OPEN'],
      'FVG_MR':     ['LONDON', 'NY_OPEN', 'ASIAN'],
      'OB':         ['LONDON', 'NY_OPEN', 'NY_LATE'],
      'OB_FVG':     ['LONDON', 'NY_OPEN'],
      'OB_HTF':     ['LONDON', 'NY_OPEN'],
      'CHOCH':      ['LONDON', 'NY_OPEN'],
      'CHOCH_LIQ':  ['LONDON', 'NY_OPEN'],
      'CHOCH_VOL':  ['LONDON', 'NY_OPEN'],
      'BOS':        ['LONDON', 'NY_OPEN', 'NY_LATE'],
      'LIQ_SWEEP':  ['LONDON', 'NY_OPEN'],
      // Trend strategies → any active session
      'EMA_CROSS':  ['LONDON', 'NY_OPEN', 'NY_LATE'],
      'MA_STACK':   ['LONDON', 'NY_OPEN', 'NY_LATE'],
      'PULLBACK':   ['LONDON', 'NY_OPEN', 'NY_LATE'],
      'PB_VOL':     ['LONDON', 'NY_OPEN', 'NY_LATE'],
      'TREND_CONF': ['LONDON', 'NY_OPEN', 'NY_LATE'],
      'HTF_CONF':   ['LONDON', 'NY_OPEN', 'NY_LATE'],
      'OB_CONS':    ['LONDON', 'NY_OPEN'],
      // Mean reversion → best in Asian / quiet
      'MR':         ['ASIAN', 'NY_LATE', 'LONDON'],
      'MR_FIB':     ['ASIAN', 'NY_LATE'],
      'FIB':        ['ASIAN', 'LONDON', 'NY_LATE'],
      'BB':         ['LONDON', 'NY_OPEN'],
      'BB_BOUNCE':  ['ASIAN', 'NY_LATE'],
      // Volume/Momentum → need active sessions
      'VOL_CONF':   ['LONDON', 'NY_OPEN'],
      'RSI_DIV':    ['LONDON', 'NY_OPEN', 'NY_LATE'],
      'MACD_DIV':   ['LONDON', 'NY_OPEN', 'NY_LATE'],
      'RSI_EXT':    ['ASIAN', 'LONDON', 'NY_LATE'],
      'CONF_ZONE':  ['LONDON', 'NY_OPEN', 'NY_LATE'],
      'GAP_FILL':   ['LONDON', 'NY_OPEN'],
      // SR works any active session
      'SR':         ['LONDON', 'NY_OPEN', 'NY_LATE', 'ASIAN'],
      'INSIDE_BAR': ['LONDON', 'NY_OPEN', 'NY_LATE'],
    };

    const optimal = optimalSessions[strategyId];
    if (!optimal) {
      // Unknown strategy — allow with small penalty
      return { allowed: true, reason: 'Unknown strategy — default allow', sessionPenalty: 3 };
    }

    if (optimal.includes(session)) {
      return { allowed: true, reason: `${strategyId} optimal in ${session}`, sessionPenalty: 0 };
    }

    // Non-optimal but not dead session — allow with score penalty
    const penalty = session === 'ASIAN' && !['MR','MR_FIB','FIB','BB_BOUNCE','SR'].includes(strategyId) ? 12 : 6;
    return { allowed: true, reason: `${strategyId} non-optimal in ${session}`, sessionPenalty: penalty };
  }
}

async function runAnalysisCycle() {
  if (botState.isRunning) return;
  botState.isRunning = true;
  const cycleStart = Date.now();
  console.log(`\n[Bot] ⚡ Cycle — ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);

  console.log('[Bot] Prefetching crypto batch...');
  await dataFetcher.prefetchCrypto();

  let cycleSignals = 0, cycleBlocked = 0;

  for (const symbol of Object.keys(SYMBOLS)) {
    try {
      const mtfData = await dataFetcher.fetchMTF(symbol);
      botState.stats.totalAnalyzed++;

      if (!mtfData || !mtfData.m5) { console.log(`[Bot] ⚠️ No data: ${symbol}`); continue; }

      const mtfLabel     = mtfData.h1 && mtfData.h4 ? '[M5+H1+H4]' : '[M5 only]';
      const signal       = SignalBuilder.build(symbol, mtfData.m5, mtfData.source, mtfData);
      const currentPrice = mtfData.m5[mtfData.m5.length - 1].close;

      if (!signal) {
        console.log(`[Bot] ℹ️  No signal: ${symbol} ${mtfLabel}`);
        continue;
      }

      // #5 Session filter — check if strategy is valid in current session
      const sessionCheck = SessionFilter.check(signal.strategy.id, SYMBOLS[symbol].category);
      if (!sessionCheck.allowed) {
        cycleBlocked++;
        botState.stats.blockedByGate++;
        console.log(`[Bot] 🕐 SESSION BLOCK ${symbol}: ${sessionCheck.reason}`);
        continue;
      }
      // Apply session penalty to quality score if non-optimal
      if (sessionCheck.sessionPenalty > 0) {
        signal.quality = Math.max(0, signal.quality - sessionCheck.sessionPenalty);
        signal.sessionNote = sessionCheck.reason;
        if (signal.quality < 75) {
          cycleBlocked++;
          botState.stats.blockedByGate++;
          console.log(`[Bot] 🕐 SESSION PENALTY ${symbol}: Q dropped to ${signal.quality} — blocked`);
          continue;
        }
      }

      // Run all gate checks
      const gate = signalGate.check(signal, currentPrice);
      if (!gate.allowed) {
        cycleBlocked++;
        botState.stats.blockedByGate++;
        console.log(`[Bot] 🚫 ${symbol}: ${gate.reason}`);
        continue;
      }

      // ✅ Signal passed — record, store, alert
      signalGate.record(signal);
      botState.signals.unshift(signal);
      if (botState.signals.length > CONFIG.MAX_SIGNALS_STORED)
        botState.signals = botState.signals.slice(0, CONFIG.MAX_SIGNALS_STORED);
      botState.stats.totalSignals++;
      botState.stats.totalStrategiesFired += signal.totalFired;
      cycleSignals++;

      console.log(`[Bot] ✅ ${signal.direction} ${symbol} | Q:${signal.quality} | ${signal.strategy.id} | Align:${signal.mtf.alignment} | Confirmed:${signal.confirmedBy.length} | ${mtfLabel}`);
      await sendTelegramAlert(signal);
      await new Promise(r => setTimeout(r, 500));

    } catch (err) { console.error(`[Bot] Error ${symbol}:`, err.message); }
  }

  // #4 — Check all active signals for expiry / price invalidation
  const currentPrices = {};
  for (const s of botState.signals.filter(x => !x.expired && !x.invalidated)) {
    const mtf = dataFetcher.mtfCache[s.symbol + '_mtf'];
    if (mtf?.data?.m5?.length) {
      const m5 = mtf.data.m5;
      currentPrices[s.symbol] = m5[m5.length - 1].close;
    }
  }
  await checkSignalExpiry(currentPrices);

  botState.lastCycle = {
    signals: cycleSignals, blocked: cycleBlocked,
    durationMs: Date.now() - cycleStart, timestamp: new Date().toISOString(),
  };
  console.log(`[Bot] ✅ Cycle done — ${cycleSignals} signals | ${cycleBlocked} blocked | ${Date.now() - cycleStart}ms\n`);
  botState.isRunning = false;
}

// ============================================================
// ── SECTION 7: API ENDPOINTS ─────────────────────────────────
// ============================================================
app.get('/', (req, res) => res.json({
  bot: 'HYBRID TRADING BOT v6.0 — REAL SIGNAL ENGINE',
  status: 'OPERATIONAL ✅', version: '8.0.0',
  description: 'All 38 strategies have genuine condition detection on live candle data. Signals only fire when ALL conditions are truly met.',
  dataSources: { crypto: 'CoinGecko', forex: 'Twelve Data', silver: 'Yahoo Finance', india: 'Dhan (add token when ready)' },
  symbols: 14, strategies: 38,
}));

app.get('/api/health', (req, res) => {
  const uptime = Math.floor((Date.now() - botState.stats.startTime) / 1000);
  res.json({
    status: 'OPERATIONAL ✅', version: '8.0.0',
    uptime: `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m ${uptime%60}s`,
    totalSignals: botState.stats.totalSignals,
    blockedByGate: botState.stats.blockedByGate,
    activeCooldowns: signalGate.cooldowns().filter(c => c.cooldownLeft > 0).length,
    totalAnalyzed: botState.stats.totalAnalyzed,
    totalStrategiesFired: botState.stats.totalStrategiesFired,
    lastCycle: botState.lastCycle,
    dataSources: {
      twelvedata: CONFIG.TWELVE_DATA_API_KEY ? '✅ Forex+Gold' : '⚠️ Key missing',
      yahoo:  '✅ Silver',
      coingecko: '✅ Crypto',
      dhan: (CONFIG.DHAN_CLIENT_ID !== 'placeholder') ? '✅ India NSE' : '⏳ Placeholder (add token)',
    },
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/signals', (req, res) => {
  const limit    = parseInt(req.query.limit) || 50;
  const category = req.query.category;
  const strategy = req.query.strategy;
  let signals    = botState.signals.slice(0, limit);
  if (category) signals = signals.filter(s => s.category === category);
  if (strategy) signals = signals.filter(s => s.strategy.id === strategy.toUpperCase());
  res.json({ count: signals.length, signals });
});

app.get('/api/signals/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  res.json({ symbol, signals: botState.signals.filter(s => s.symbol === symbol) });
});

app.get('/api/strategies', (req, res) => res.json({
  total: 38,
  note: 'All strategies have real condition detection — signals only fire when all conditions are genuinely met on live candles',
  combo: [
    { id: 'OB_FVG', name: 'Order Block + Fair Value Gap', probability: 80, strength: 'very_strong' },
    { id: 'CHOCH_LIQ', name: 'ChoCh + Liquidity Sweep', probability: 75, strength: 'strong' },
    { id: 'ORB_MA', name: 'ORB + MA Stack', probability: 78, strength: 'strong' },
    { id: 'OB_CONS', name: 'Order Block + Consolidation', probability: 76, strength: 'strong' },
    { id: 'CHOCH_VOL', name: 'ChoCh + Volume Spike', probability: 80, strength: 'very_strong' },
    { id: 'OVERLAP_OB', name: 'London-NY Overlap + OB', probability: 85, strength: 'very_strong' },
    { id: 'FVG_BOS', name: 'FVG + Break of Structure', probability: 90, strength: 'exceptional' },
    { id: 'MR_FIB', name: 'Mean Reversion + Fibonacci', probability: 78, strength: 'strong' },
    { id: 'FVG_MR', name: 'FVG + Mean Reversion', probability: 80, strength: 'very_strong' },
    { id: 'OB_HTF', name: 'Order Block + HTF Confirm', probability: 78, strength: 'strong' },
    { id: 'FVG_BOS_HTF', name: 'FVG + BoS + HTF (BEST ⭐)', probability: 92, strength: 'exceptional' },
    { id: 'PB_VOL', name: 'Pullback + Volume', probability: 75, strength: 'strong' },
  ],
  core: [
    { id: 'FVG', name: 'Fair Value Gap', probability: 95 },
    { id: 'OB', name: 'Order Block', probability: 70 },
    { id: 'CHOCH', name: 'Change of Character', probability: 75 },
    { id: 'BOS', name: 'Break of Structure', probability: 70 },
    { id: 'LIQ_SWEEP', name: 'Liquidity Sweep', probability: 65 },
    { id: 'SR', name: 'Support & Resistance', probability: 68 },
    { id: 'TL_BREAK', name: 'Trendline Break', probability: 68 },
    { id: 'INSIDE_BAR', name: 'Inside Bar', probability: 66 },
    { id: 'EMA_CROSS', name: 'EMA Crossover', probability: 65 },
    { id: 'MA_STACK', name: 'MA Stack', probability: 72 },
    { id: 'OVERLAP', name: 'London-NY Overlap', probability: 80 },
    { id: 'PULLBACK', name: 'Pullback Entry', probability: 65 },
    { id: 'ORB', name: 'Opening Range Breakout', probability: 72 },
    { id: 'CONS_BREAK', name: 'Consolidation Breakout', probability: 70 },
    { id: 'HTF_CONF', name: 'Higher TF Confirmation', probability: 65 },
    { id: 'MR', name: 'Mean Reversion', probability: 70 },
    { id: 'FIB', name: 'Fibonacci Retracement', probability: 70 },
    { id: 'BB', name: 'Bollinger Bands', probability: 65 },
    { id: 'BB_BOUNCE', name: 'Bollinger Bounce', probability: 65 },
    { id: 'RSI_DIV', name: 'RSI Divergence', probability: 67 },
    { id: 'MACD_DIV', name: 'MACD Divergence', probability: 68 },
    { id: 'RSI_EXT', name: 'RSI Extremes', probability: 64 },
    { id: 'TREND_CONF', name: 'Trend Confirmation', probability: 68 },
    { id: 'VOL_CONF', name: 'Volume Confirmation', probability: 68 },
    { id: 'GAP_FILL', name: 'Gap Fill', probability: 65 },
    { id: 'CONF_ZONE', name: 'Confluence Zone', probability: 72 },
  ],
}));

app.get('/api/symbols', (req, res) => res.json({ total: 14, symbols: SYMBOLS }));

app.get('/api/stats', (req, res) => {
  const uptime     = Math.floor((Date.now() - botState.stats.startTime) / 1000);
  const byCategory = {}, byStrategy = {};
  botState.signals.forEach(s => {
    byCategory[s.category] = (byCategory[s.category] || 0) + 1;
    byStrategy[s.strategy.id] = (byStrategy[s.strategy.id] || 0) + 1;
  });
  res.json({
    uptime: `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`,
    totalAnalyzed:        botState.stats.totalAnalyzed,
    blockedByGate:        botState.stats.blockedByGate,
    cooldowns:            signalGate.cooldowns(),
    totalSignals:         botState.stats.totalSignals,
    totalStrategiesFired: botState.stats.totalStrategiesFired,
    avgQuality: botState.signals.length
      ? Math.round(botState.signals.reduce((s, x) => s + x.quality, 0) / botState.signals.length) : 0,
    byCategory, byStrategy,
    BUY:  botState.signals.filter(s => s.direction === 'BUY').length,
    SELL: botState.signals.filter(s => s.direction === 'SELL').length,
    lastCycle: botState.lastCycle,
  });
});

// #7 — Live Dhan token update (no redeploy needed)
app.post('/api/dhan/token', (req, res) => {
  const { clientId, accessToken } = req.body;
  if (!clientId || !accessToken) {
    return res.status(400).json({ error: 'Provide clientId and accessToken in body' });
  }
  dhanLiveToken.clientId    = clientId;
  dhanLiveToken.accessToken = accessToken;
  dhanLiveToken.updatedAt   = new Date().toISOString();
  console.log(`[Dhan] ✅ Token updated at ${dhanLiveToken.updatedAt}`);
  res.json({
    success: true,
    message: 'Dhan token updated. NIFTY/BANKNIFTY/FINNIFTY will use it next cycle.',
    updatedAt: dhanLiveToken.updatedAt,
  });
});

app.post('/api/metatrader/receive', (req, res) => {
  const { symbol, candles } = req.body;
  if (!symbol || !Array.isArray(candles)) return res.status(400).json({ error: 'Invalid data' });
  dataFetcher.metatrader.receiveData(symbol.toUpperCase(), candles);
  res.json({ success: true, symbol: symbol.toUpperCase(), candlesReceived: candles.length });
});

// ── #6 BACKTEST ENGINE ──────────────────────────────────────
// Runs all 38 strategies on historical candle windows.
// For each signal fired in history, checks if TP1/TP2/SL was hit.
// Returns win rates per strategy.
function runBacktest(candles) {
  const results = {};
  if (!candles || candles.length < 50) return results;

  // Slide a window of 100 candles across history, fire detectors on each
  const windowSize = 100;
  for (let i = windowSize; i < candles.length - 20; i++) {
    const window = candles.slice(i - windowSize, i);
    let runResult;
    try { runResult = StrategyDetectors.runAll(window, null, null, 'forex'); }
    catch { continue; }
    if (!runResult?.fired?.length) continue;

    for (const fired of runResult.fired) {
      const id  = fired.id;
      if (!results[id]) results[id] = { fires: 0, tp1: 0, tp2: 0, sl: 0 };
      results[id].fires++;

      // Simulate forward — look at next 20 candles to see what got hit first
      const closes  = window.map(c => c.close);
      const highs   = candles.slice(i, i + 20).map(c => c.high);
      const lows    = candles.slice(i, i + 20).map(c => c.low);
      const atr     = Indicators.atr(window.map(c => c.high), window.map(c => c.low), closes);
      const price   = closes[closes.length - 1];
      const dir     = fired.direction;

      // Use simple ATR-based levels for backtest (same as v1 for consistency)
      const risk  = atr * 1.5;
      const tp1   = dir === 'BUY' ? price + atr       : price - atr;
      const tp2   = dir === 'BUY' ? price + atr * 2   : price - atr * 2;
      const sl    = dir === 'BUY' ? price - risk       : price + risk;

      let tp1Hit = false, tp2Hit = false, slHit = false;
      for (let j = 0; j < highs.length; j++) {
        if (dir === 'BUY') {
          if (!tp1Hit && highs[j] >= tp1) tp1Hit = true;
          if (!tp2Hit && highs[j] >= tp2) tp2Hit = true;
          if (!slHit  && lows[j]  <= sl)  slHit  = true;
        } else {
          if (!tp1Hit && lows[j]  <= tp1) tp1Hit = true;
          if (!tp2Hit && lows[j]  <= tp2) tp2Hit = true;
          if (!slHit  && highs[j] >= sl)  slHit  = true;
        }
        // Stop at first exit
        if (slHit || tp2Hit) break;
      }

      if (tp2Hit && !slHit) results[id].tp2++;
      else if (tp1Hit && !slHit) results[id].tp1++;
      else if (slHit) results[id].sl++;
    }
  }

  // Compute win rates
  for (const id of Object.keys(results)) {
    const r = results[id];
    const total = r.tp1 + r.tp2 + r.sl;
    r.winRate  = total > 0 ? Math.round(((r.tp1 + r.tp2) / total) * 100) : 0;
    r.tp1Rate  = total > 0 ? Math.round((r.tp1 / total) * 100) : 0;
    r.tp2Rate  = total > 0 ? Math.round((r.tp2 / total) * 100) : 0;
    r.slRate   = total > 0 ? Math.round((r.sl  / total) * 100) : 0;
  }

  return results;
}

app.get('/api/backtest/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cached = dataFetcher.cache[symbol];
  if (!cached || cached.length < 50) {
    return res.json({ error: 'Not enough candle data cached for this symbol. Wait for at least 1 cycle.' });
  }
  try {
    const results = runBacktest(cached);
    const sorted  = Object.entries(results)
      .sort((a, b) => b[1].winRate - a[1].winRate)
      .map(([id, r]) => ({ id, ...r }));
    res.json({ symbol, candlesUsed: cached.length, strategies: sorted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ============================================================
// START
// ============================================================
async function startBot() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   HYBRID TRADING BOT v8.2 — PRECISION ENGINE    ║');
  console.log('║  All 38 strategies: genuine condition detection  ║');
  console.log('║  Signals ONLY fire when ALL conditions are met   ║');
  console.log('║  Live candle analysis every 5 minutes 24/7      ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  app.listen(CONFIG.PORT, () => console.log(`[Server] ✅ Port ${CONFIG.PORT}`));
  await dataFetcher.initialize();
  console.log('[Bot] Running initial analysis...');
  await runAnalysisCycle();
  cron.schedule(CONFIG.ANALYSIS_INTERVAL, runAnalysisCycle);
  console.log('[Bot] ✅ Scheduled every 5 minutes\n');
}

startBot().catch(err => { console.error('[Fatal]', err); process.exit(1); });
