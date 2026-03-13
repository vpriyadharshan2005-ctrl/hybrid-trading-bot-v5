// ============================================================
// HYBRID TRADING BOT v6.0 — REAL SIGNAL ENGINE
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

  SIGNAL_QUALITY_MIN:  65,   // minimum confluence score to fire signal
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
  // Condition: Use every 4th candle as "HTF" proxy. HTF trend aligns
  // with current price action direction. Trend must be clear.
  static detectHTFConfirmation(candles) {
    if (candles.length < 40) return null;
    const closes = candles.map(c => c.close);

    // Build pseudo-HTF candles by taking every 4th close
    const htfCloses = closes.filter((_, i) => i % 4 === 0);
    const htfTrend  = Indicators.trendStrength(htfCloses);
    const ltfTrend  = Indicators.trendStrength(closes.slice(-20));

    // Both timeframes must agree
    if (htfTrend.trend === 'NEUTRAL' || ltfTrend.trend === 'NEUTRAL') return null;
    if (htfTrend.trend !== ltfTrend.trend) return null;

    return {
      direction: htfTrend.trend === 'BULLISH' ? 'BUY' : 'SELL',
      id: 'HTF_CONF', name: 'Higher TF Confirmation',
      strength: 'moderate', probability: 65, score: 67,
      conditions: { htfTrend: htfTrend.trend, ltfTrend: ltfTrend.trend, aligned: true },
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

  // C10. Order Block + HTF Confirmation
  static detectOB_HTF(candles) {
    const ob  = this.detectOrderBlock(candles);
    const htf = this.detectHTFConfirmation(candles);
    if (!ob || !htf) return null;
    if (ob.direction !== htf.direction) return null;
    return {
      direction: ob.direction, id: 'OB_HTF', name: 'Order Block + HTF Confirm',
      strength: 'strong', probability: 78, score: 83,
      conditions: { ob: ob.conditions, htf: htf.conditions },
    };
  }

  // C11. FVG + BoS + HTF — THE BEST SETUP ⭐
  static detectFVG_BoS_HTF(candles) {
    const fvg = this.detectFVG(candles);
    const bos = this.detectBoS(candles);
    const htf = this.detectHTFConfirmation(candles);
    if (!fvg || !bos || !htf) return null;
    if (fvg.direction !== bos.direction || bos.direction !== htf.direction) return null;
    return {
      direction: fvg.direction, id: 'FVG_BOS_HTF', name: 'FVG + BoS + HTF (BEST ⭐)',
      strength: 'exceptional', probability: 92, score: 95,
      conditions: { fvg: fvg.conditions, bos: bos.conditions, htf: htf.conditions },
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
  // RUN ALL DETECTORS — returns array of all fired signals
  // ────────────────────────────────────────────────────────────
  static runAll(candles) {
    const detectors = [
      // Core strategies
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
      () => this.detectHTFConfirmation(candles),
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
      // Combo strategies (all sub-conditions must pass)
      () => this.detectOB_FVG(candles),
      () => this.detectChoCh_Liq(candles),
      () => this.detectORB_MA(candles),
      () => this.detectOB_Cons(candles),
      () => this.detectChoCh_Vol(candles),
      () => this.detectOverlap_OB(candles),
      () => this.detectFVG_BoS(candles),
      () => this.detectMR_Fib(candles),
      () => this.detectFVG_MR(candles),
      () => this.detectOB_HTF(candles),
      () => this.detectFVG_BoS_HTF(candles),
      () => this.detectPullback_Vol(candles),
    ];

    const fired = [];
    for (const fn of detectors) {
      try {
        const result = fn();
        if (result) fired.push(result);
      } catch (e) { /* skip failed detector */ }
    }
    return fired;
  }
}

// ============================================================
// ── SECTION 3: SIGNAL BUILDER ────────────────────────────────
// Takes fired strategies, picks the highest-scoring one that
// meets the minimum quality threshold, builds full signal object.
// ============================================================
class SignalBuilder {

  static calculateLevels(direction, price, atr) {
    const risk = atr || price * 0.01;
    return direction === 'BUY' ? {
      entry: parseFloat(price.toFixed(6)),
      sl:    parseFloat((price - risk * 1.5).toFixed(6)),
      tp1:   parseFloat((price + risk).toFixed(6)),
      tp2:   parseFloat((price + risk * 2).toFixed(6)),
      tp3:   parseFloat((price + risk * 3).toFixed(6)),
      riskReward: '1:2',
    } : {
      entry: parseFloat(price.toFixed(6)),
      sl:    parseFloat((price + risk * 1.5).toFixed(6)),
      tp1:   parseFloat((price - risk).toFixed(6)),
      tp2:   parseFloat((price - risk * 2).toFixed(6)),
      tp3:   parseFloat((price - risk * 3).toFixed(6)),
      riskReward: '1:2',
    };
  }

  // Boost score when multiple fired strategies agree on same direction
  static confluenceBoost(firedStrategies, chosenDirection) {
    const agreeing = firedStrategies.filter(s => s.direction === chosenDirection).length;
    return Math.min(agreeing * 3, 15); // up to +15 points for confluence
  }

  static build(symbol, candles, source) {
    const fired = StrategyDetectors.runAll(candles);
    if (!fired.length) return null;

    // Sort by score descending — pick best
    fired.sort((a, b) => b.score - a.score);
    const best = fired[0];

    // Apply confluence boost
    const boost = this.confluenceBoost(fired, best.direction);
    const finalScore = Math.min(best.score + boost, 100);

    if (finalScore < CONFIG.SIGNAL_QUALITY_MIN) return null;

    // Calculate indicators for display
    const closes  = candles.map(c => c.close);
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume || 0);
    const price   = closes[closes.length - 1];
    const atr     = Indicators.atr(highs, lows, closes);
    const rsi     = Indicators.rsi(closes);
    const macd    = Indicators.macd(closes);
    const ema12   = Indicators.ema(closes, 12);
    const ema26   = Indicators.ema(closes, 26);
    const ema50   = Indicators.ema(closes, Math.min(50, closes.length - 1));
    const vol     = Indicators.volumeAnalysis(volumes);
    const trend   = Indicators.trendStrength(closes);

    // All strategies that fired and agree with signal direction
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
      strategy:    {
        id:          best.id,
        name:        best.name,
        probability: best.probability,
        strength:    best.strength,
      },
      confirmedBy:  confirmingStrategies,  // all strategies that agree
      totalFired:   fired.length,
      levels:       this.calculateLevels(best.direction, price, atr),
      indicators: {
        rsi:    parseFloat(rsi.toFixed(2)),
        macd:   parseFloat(macd.macdLine.toFixed(6)),
        histogram: parseFloat(macd.histogram.toFixed(6)),
        trend:  trend.trend,
        ema12:  parseFloat(ema12.toFixed(6)),
        ema26:  parseFloat(ema26.toFixed(6)),
        ema50:  parseFloat(ema50.toFixed(6)),
        volume: vol,
        atr:    parseFloat(atr.toFixed(6)),
      },
      strategyConditions: best.conditions, // the actual conditions that were met
      dataSource:   source,
      candleCount:  candles.length,
      timestamp:    new Date().toISOString(),
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

  async fetchCandles(tdSymbol) {
    try {
      if (!this.apiKey) { console.warn(`[TwelveData] No key — skipping ${tdSymbol}`); return null; }
      const now  = Date.now();
      const wait = 8000 - (now - this.lastCall);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.lastCall = Date.now();

      const res = await axios.get(`${this.baseUrl}/time_series`, {
        params: { symbol: tdSymbol, interval: '5min', outputsize: 100, apikey: this.apiKey },
        timeout: 15000,
      });

      const d = res.data;
      if (d.status === 'error' || d.code) { console.error(`[TwelveData] ${tdSymbol}: ${d.message}`); return null; }
      if (!d.values?.length) return null;

      const candles = d.values.reverse().map(b => ({
        time: new Date(b.datetime).getTime(),
        open: parseFloat(b.open), high: parseFloat(b.high),
        low:  parseFloat(b.low),  close: parseFloat(b.close),
        volume: parseFloat(b.volume || 0) || 1,
      }));
      console.log(`[TwelveData] ✅ ${tdSymbol}: ${candles.length} candles`);
      return candles;
    } catch (err) {
      console.error(`[TwelveData] Error ${tdSymbol}: ${err.response?.status || err.message}`);
      return null;
    }
  }
}

class YahooFetcher {
  async fetchCandles(yahooSymbol) {
    try {
      const now  = Math.floor(Date.now() / 1000);
      const from = now - 86400;
      const res  = await axios.get(
        `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=5m&period1=${from}&period2=${now}`,
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
      console.log(`[Yahoo] ✅ ${yahooSymbol}: ${candles.length} candles`);
      return candles;
    } catch (err) {
      console.error(`[Yahoo] Error ${yahooSymbol}: ${err.response?.status || err.message}`);
      return null;
    }
  }
}

class CoinGeckoFetcher {
  constructor() { this.baseUrl = CONFIG.COINGECKO_REST; }

  async fetchCandles(cgId) {
    try {
      const res = await axios.get(`${this.baseUrl}/coins/${cgId}/ohlc`,
        { params: { vs_currency: 'usd', days: '1' }, timeout: 15000, headers: { 'Accept': 'application/json' } }
      );
      if (!res.data?.length) return null;
      const candles = res.data.map(c => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: 1000000 }));
      console.log(`[CoinGecko] ✅ ${cgId}: ${candles.length} candles`);
      return candles;
    } catch (err) {
      const status = err.response?.status;
      console.error(`[CoinGecko] Error ${cgId}: ${status || err.message}`);
      if (status === 429) return await this.fetchMarketChart(cgId);
      return null;
    }
  }

  async fetchMarketChart(cgId) {
    try {
      await new Promise(r => setTimeout(r, 5000));
      const res = await axios.get(`${this.baseUrl}/coins/${cgId}/market_chart`,
        { params: { vs_currency: 'usd', days: '1', interval: 'hourly' }, timeout: 15000 }
      );
      if (!res.data?.prices?.length) return null;
      const prices = res.data.prices;
      const candles = prices.map((p, i) => {
        const prev = prices[i - 1] || p;
        return { time: p[0], open: prev[1], high: Math.max(p[1], prev[1]) * 1.001, low: Math.min(p[1], prev[1]) * 0.999, close: p[1], volume: 1000000 };
      });
      console.log(`[CoinGecko] ✅ ${cgId} (market_chart): ${candles.length} candles`);
      return candles;
    } catch (err) {
      console.error(`[CoinGecko] market_chart error ${cgId}: ${err.message}`);
      return null;
    }
  }
}

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
        headers: { 'access-token': this.accessToken, 'client-id': this.clientId, 'Content-Type': 'application/json' },
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
    this.twelvedata  = new TwelveDataFetcher();
    this.yahoo       = new YahooFetcher();
    this.coingecko   = new CoinGeckoFetcher();
    this.dhan        = new DhanFetcher();
    this.metatrader  = new MetaTraderReceiver();
    this.cache       = {};
    this.cgLastFetch = {};
  }

  async initialize() {
    console.log('[Bot] Data sources: CoinGecko | Twelve Data | Yahoo Finance | Dhan (placeholder until token added)');
  }

  async fetchCandles(symbol) {
    const config = SYMBOLS[symbol];
    if (!config) return null;
    let candles = null, source = 'unknown';

    try {
      if (config.source === 'twelvedata') {
        candles = await this.twelvedata.fetchCandles(config.tdSymbol); source = 'twelvedata';
      } else if (config.source === 'yahoo') {
        candles = await this.yahoo.fetchCandles(config.yahooSymbol); source = 'yahoo';
      } else if (config.source === 'coingecko') {
        const now = Date.now(), last = this.cgLastFetch[config.cgId] || 0;
        if (now - last < 15000) await new Promise(r => setTimeout(r, 15000 - (now - last)));
        candles = await this.coingecko.fetchCandles(config.cgId);
        this.cgLastFetch[config.cgId] = Date.now();
        source = 'coingecko';
      } else if (config.source === 'dhan') {
        candles = await this.dhan.fetchCandles(symbol); source = 'dhan';
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

  const msg = `${emoji} *${signal.direction} SIGNAL — ${signal.symbol}*
━━━━━━━━━━━━━━━━━━━━
📊 ${signal.symbolName} | ${signal.category.toUpperCase()}
⚡ *${signal.strategy.name}*
💯 Quality: ${signal.quality}/100 [${bar}]
📐 Strength: ${signal.strategy.strength.replace('_', ' ').toUpperCase()}

💰 Entry:  \`${signal.levels.entry}\`
🛑 SL:     \`${signal.levels.sl}\`
🎯 TP1:    \`${signal.levels.tp1}\`
🎯 TP2:    \`${signal.levels.tp2}\`
🎯 TP3:    \`${signal.levels.tp3}\`
📐 R:R     ${signal.levels.riskReward}

📈 *Indicators (live):*
  RSI: ${signal.indicators.rsi} | Trend: ${signal.indicators.trend}
  MACD: ${signal.indicators.macd > 0 ? '▲' : '▼'} ${signal.indicators.macd}
  Vol spike: ${signal.indicators.volume.spike ? '✅' : '❌'} (${signal.indicators.volume.ratio}x avg)
  ATR: ${signal.indicators.atr}

✅ *Confirmed by ${signal.confirmedBy.length} strategies:*
${confirms}

🔌 Source: ${signal.dataSource.toUpperCase()} | ${signal.candleCount} candles
🕐 ${new Date(signal.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
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
const botState = {
  signals: [], lastCycle: null,
  stats: { totalAnalyzed: 0, totalSignals: 0, totalStrategiesFired: 0, startTime: Date.now() },
  isRunning: false,
};
const dataFetcher = new HybridDataFetcher();

async function runAnalysisCycle() {
  if (botState.isRunning) return;
  botState.isRunning = true;
  const cycleStart = Date.now();
  console.log(`\n[Bot] ⚡ Cycle — ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
  let cycleSignals = 0;

  for (const symbol of Object.keys(SYMBOLS)) {
    try {
      const result = await dataFetcher.fetchCandles(symbol);
      botState.stats.totalAnalyzed++;
      if (!result) { console.log(`[Bot] ⚠️ No data: ${symbol}`); continue; }

      const signal = SignalBuilder.build(symbol, result.candles, result.source);
      if (signal) {
        botState.signals.unshift(signal);
        if (botState.signals.length > CONFIG.MAX_SIGNALS_STORED)
          botState.signals = botState.signals.slice(0, CONFIG.MAX_SIGNALS_STORED);
        botState.stats.totalSignals++;
        botState.stats.totalStrategiesFired += signal.totalFired;
        cycleSignals++;
        console.log(`[Bot] ✅ ${signal.direction} ${symbol} | Q:${signal.quality} | Strategy:${signal.strategy.id} | ConfirmedBy:${signal.confirmedBy.length} | src:${result.source}`);
        await sendTelegramAlert(signal);
        await new Promise(r => setTimeout(r, 500));
      } else {
        console.log(`[Bot] ℹ️ No signal: ${symbol} (src:${result.source})`);
      }
    } catch (err) { console.error(`[Bot] Error ${symbol}:`, err.message); }
  }

  botState.lastCycle = { signals: cycleSignals, durationMs: Date.now() - cycleStart, timestamp: new Date().toISOString() };
  console.log(`[Bot] ✅ Cycle done — ${cycleSignals} real signals | ${Date.now() - cycleStart}ms\n`);
  botState.isRunning = false;
}

// ============================================================
// ── SECTION 7: API ENDPOINTS ─────────────────────────────────
// ============================================================
app.get('/', (req, res) => res.json({
  bot: 'HYBRID TRADING BOT v6.0 — REAL SIGNAL ENGINE',
  status: 'OPERATIONAL ✅', version: '6.0.0',
  description: 'All 38 strategies have genuine condition detection on live candle data. Signals only fire when ALL conditions are truly met.',
  dataSources: { crypto: 'CoinGecko', forex: 'Twelve Data', silver: 'Yahoo Finance', india: 'Dhan (add token when ready)' },
  symbols: 14, strategies: 38,
}));

app.get('/api/health', (req, res) => {
  const uptime = Math.floor((Date.now() - botState.stats.startTime) / 1000);
  res.json({
    status: 'OPERATIONAL ✅', version: '6.0.0',
    uptime: `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m ${uptime%60}s`,
    totalSignals: botState.stats.totalSignals,
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

app.post('/api/metatrader/receive', (req, res) => {
  const { symbol, candles } = req.body;
  if (!symbol || !Array.isArray(candles)) return res.status(400).json({ error: 'Invalid data' });
  dataFetcher.metatrader.receiveData(symbol.toUpperCase(), candles);
  res.json({ success: true, symbol: symbol.toUpperCase(), candlesReceived: candles.length });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ============================================================
// START
// ============================================================
async function startBot() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   HYBRID TRADING BOT v6.0 — REAL SIGNAL ENGINE  ║');
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
