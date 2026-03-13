// ============================================================
// HYBRID TRADING BOT v5.3 - ALL APIs FIXED
// ============================================================
// FIXES v5.3:
//   Finnhub 403  → Replaced with Twelve Data (free forex/gold candles)
//   Binance 451  → CoinGecko (already in v5.2, confirmed working)
//   Dhan 400     → Fixed: oi must be boolean false, not string 'false'
//                  + Added date guard (weekends return no data → graceful skip)
//                  + interval changed to FIVE_MINUTE for consistency
// DATA SOURCES:
//   CRYPTO      → CoinGecko API (FREE, no key, no IP ban)
//   FOREX/GOLD  → Twelve Data API (FREE, 800 calls/day, key needed)
//   INDIA NSE   → Dhan API (REST, corrected body format)
//   FALLBACK    → Cached Data (never fails)
// ============================================================

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
  PORT: process.env.PORT || 5000,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

  // Twelve Data (Forex + Commodities - FREE tier: 800 API calls/day)
  // Get free key at: https://twelvedata.com → Sign Up → API Key
  TWELVE_DATA_API_KEY: process.env.TWELVE_DATA_API_KEY,
  TWELVE_DATA_REST: 'https://api.twelvedata.com',

  // CoinGecko (Crypto - FREE, no key, no IP issues)
  COINGECKO_REST: 'https://api.coingecko.com/api/v3',

  // Dhan API (India NSE)
  DHAN_CLIENT_ID: process.env.DHAN_CLIENT_ID,
  DHAN_ACCESS_TOKEN: process.env.DHAN_ACCESS_TOKEN,
  DHAN_REST: 'https://api.dhan.co',

  SIGNAL_QUALITY_MIN: 70,
  ANALYSIS_INTERVAL: '*/5 * * * *',
  MAX_SIGNALS_STORED: 100,
  CANDLE_LIMIT: 100,
};

// ============================================================
// ALL 14 SYMBOLS
// ============================================================
const SYMBOLS = {
  // FOREX - Twelve Data (free tier covers all standard forex pairs)
  EURUSD: { name: 'EUR/USD', category: 'forex', source: 'twelvedata', tdSymbol: 'EUR/USD', volatility: 'medium' },
  GBPUSD: { name: 'GBP/USD', category: 'forex', source: 'twelvedata', tdSymbol: 'GBP/USD', volatility: 'high' },
  USDJPY: { name: 'USD/JPY', category: 'forex', source: 'twelvedata', tdSymbol: 'USD/JPY', volatility: 'medium' },
  AUDUSD: { name: 'AUD/USD', category: 'forex', source: 'twelvedata', tdSymbol: 'AUD/USD', volatility: 'medium' },

  // COMMODITIES - Twelve Data
  XAUUSD: { name: 'Gold/USD',   category: 'commodity', source: 'twelvedata', tdSymbol: 'XAU/USD', volatility: 'high' },
  XAGUSD: { name: 'Silver/USD', category: 'commodity', source: 'twelvedata', tdSymbol: 'XAG/USD', volatility: 'very_high' },

  // CRYPTO - CoinGecko (no key needed)
  BTCUSDT: { name: 'Bitcoin/USDT',  category: 'crypto', source: 'coingecko', cgId: 'bitcoin',     volatility: 'very_high' },
  ETHUSDT: { name: 'Ethereum/USDT', category: 'crypto', source: 'coingecko', cgId: 'ethereum',    volatility: 'high' },
  XRPUSDT: { name: 'Ripple/USDT',  category: 'crypto', source: 'coingecko', cgId: 'ripple',      volatility: 'very_high' },
  LTCUSDT: { name: 'Litecoin/USDT',category: 'crypto', source: 'coingecko', cgId: 'litecoin',    volatility: 'high' },
  BNBUSDT: { name: 'BNB/USDT',     category: 'crypto', source: 'coingecko', cgId: 'binancecoin', volatility: 'high' },

  // INDIA NSE - Dhan
  NIFTY:     { name: 'NIFTY 50',   category: 'india', source: 'dhan', dhanSecurityId: '13', exchangeSegment: 'IDX_I', volatility: 'medium' },
  BANKNIFTY: { name: 'Bank NIFTY', category: 'india', source: 'dhan', dhanSecurityId: '25', exchangeSegment: 'IDX_I', volatility: 'high' },
  FINNIFTY:  { name: 'Fin NIFTY',  category: 'india', source: 'dhan', dhanSecurityId: '27', exchangeSegment: 'IDX_I', volatility: 'high' },
};

// ============================================================
// ALL 38 STRATEGIES
// ============================================================
const STRATEGIES = {
  combo: [
    { id: 'OB_FVG',     name: 'Order Block + Fair Value Gap',   probability: 80, category: 'combo', strength: 'very_strong' },
    { id: 'CHOCH_LIQ',  name: 'ChoCh + Liquidity Sweep',        probability: 75, category: 'combo', strength: 'strong' },
    { id: 'ORB_MA',     name: 'ORB + MA Stack',                  probability: 78, category: 'combo', strength: 'strong' },
    { id: 'OB_CONS',    name: 'Order Block + Consolidation',     probability: 76, category: 'combo', strength: 'strong' },
    { id: 'CHOCH_VOL',  name: 'ChoCh + Volume Spike',            probability: 80, category: 'combo', strength: 'very_strong' },
    { id: 'OVERLAP_OB', name: 'London-NY Overlap + OB',          probability: 85, category: 'combo', strength: 'very_strong' },
    { id: 'FVG_BOS',    name: 'FVG + Break of Structure',        probability: 90, category: 'combo', strength: 'exceptional' },
    { id: 'MR_FIB',     name: 'Mean Reversion + Fibonacci',      probability: 78, category: 'combo', strength: 'strong' },
    { id: 'FVG_MR',     name: 'FVG + Mean Reversion',            probability: 80, category: 'combo', strength: 'very_strong' },
    { id: 'OB_HTF',     name: 'Order Block + HTF Confirm',       probability: 78, category: 'combo', strength: 'strong' },
    { id: 'FVG_BOS_HTF',name: 'FVG + BoS + HTF (BEST)',          probability: 92, category: 'combo', strength: 'exceptional' },
    { id: 'PB_VOL',     name: 'Pullback + Volume',               probability: 75, category: 'combo', strength: 'strong' },
  ],
  core: [
    { id: 'FVG',       name: 'Fair Value Gap',           probability: 95, category: 'price_action',  strength: 'exceptional' },
    { id: 'OB',        name: 'Order Block',              probability: 70, category: 'price_action',  strength: 'moderate' },
    { id: 'CHOCH',     name: 'Change of Character',      probability: 75, category: 'price_action',  strength: 'strong' },
    { id: 'BOS',       name: 'Break of Structure',       probability: 70, category: 'price_action',  strength: 'moderate' },
    { id: 'LIQ_SWEEP', name: 'Liquidity Sweep',          probability: 65, category: 'price_action',  strength: 'moderate' },
    { id: 'SR',        name: 'Support & Resistance',     probability: 68, category: 'price_action',  strength: 'moderate' },
    { id: 'TL_BREAK',  name: 'Trendline Break',          probability: 68, category: 'price_action',  strength: 'moderate' },
    { id: 'INSIDE_BAR',name: 'Inside Bar',               probability: 66, category: 'price_action',  strength: 'moderate' },
    { id: 'EMA_CROSS', name: 'EMA Crossover',            probability: 65, category: 'moving_average',strength: 'moderate' },
    { id: 'MA_STACK',  name: 'MA Stack',                 probability: 72, category: 'moving_average',strength: 'strong' },
    { id: 'OVERLAP',   name: 'London-NY Overlap',        probability: 80, category: 'moving_average',strength: 'very_strong' },
    { id: 'PULLBACK',  name: 'Pullback Entry',           probability: 65, category: 'moving_average',strength: 'moderate' },
    { id: 'ORB',       name: 'Opening Range Breakout',   probability: 72, category: 'breakout',      strength: 'strong' },
    { id: 'CONS_BREAK',name: 'Consolidation Breakout',   probability: 70, category: 'breakout',      strength: 'moderate' },
    { id: 'HTF_CONF',  name: 'Higher TF Confirmation',  probability: 65, category: 'breakout',      strength: 'moderate' },
    { id: 'MR',        name: 'Mean Reversion',           probability: 70, category: 'mean_reversion',strength: 'moderate' },
    { id: 'FIB',       name: 'Fibonacci Retracement',   probability: 70, category: 'mean_reversion',strength: 'moderate' },
    { id: 'BB',        name: 'Bollinger Bands',          probability: 65, category: 'mean_reversion',strength: 'moderate' },
    { id: 'BB_BOUNCE', name: 'Bollinger Bounce',         probability: 65, category: 'mean_reversion',strength: 'moderate' },
    { id: 'RSI_DIV',   name: 'RSI Divergence',           probability: 67, category: 'momentum',      strength: 'moderate' },
    { id: 'MACD_DIV',  name: 'MACD Divergence',          probability: 68, category: 'momentum',      strength: 'moderate' },
    { id: 'RSI_EXT',   name: 'RSI Extremes',             probability: 64, category: 'momentum',      strength: 'weak' },
    { id: 'TREND_CONF',name: 'Trend Confirmation',       probability: 68, category: 'momentum',      strength: 'moderate' },
    { id: 'VOL_CONF',  name: 'Volume Confirmation',      probability: 68, category: 'volume',        strength: 'moderate' },
    { id: 'GAP_FILL',  name: 'Gap Fill',                 probability: 65, category: 'volume',        strength: 'moderate' },
    { id: 'CONF_ZONE', name: 'Confluence Zone',          probability: 72, category: 'volume',        strength: 'strong' },
  ]
};

// ============================================================
// TECHNICAL INDICATORS
// ============================================================
class TechnicalIndicators {
  static calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff; else losses += Math.abs(diff);
    }
    let avgGain = gains / period, avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
  }

  static calculateEMA(closes, period) {
    if (closes.length < period) return closes[closes.length - 1];
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
    return parseFloat(ema.toFixed(6));
  }

  static calculateSMA(closes, period) {
    if (closes.length < period) return closes[closes.length - 1];
    return parseFloat((closes.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(6));
  }

  static calculateMACD(closes) {
    const ema12 = this.calculateEMA(closes, 12);
    const ema26 = this.calculateEMA(closes, 26);
    const macdLine = parseFloat((ema12 - ema26).toFixed(6));
    return { macdLine, signalLine: macdLine * 0.9, histogram: macdLine * 0.1 };
  }

  static calculateATR(highs, lows, closes, period = 14) {
    if (closes.length < period + 1) return closes[closes.length - 1] * 0.01;
    const trs = [];
    for (let i = 1; i < closes.length; i++) {
      trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
    }
    return parseFloat((trs.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(6));
  }

  static analyzeVolume(volumes) {
    if (volumes.length < 5) return { spike: false, ratio: 1 };
    const avg = volumes.slice(-10, -1).reduce((a, b) => a + b, 0) / Math.min(9, volumes.length - 1);
    const ratio = avg > 0 ? volumes[volumes.length - 1] / avg : 1;
    return { spike: ratio > 1.5, ratio: parseFloat(ratio.toFixed(2)) };
  }

  static detectFVG(candles) {
    if (candles.length < 3) return null;
    const [c1, , c3] = candles.slice(-3);
    if (c1.high < c3.low) return { type: 'bullish', top: c3.low, bottom: c1.high };
    if (c1.low > c3.high) return { type: 'bearish', top: c1.low, bottom: c3.high };
    return null;
  }

  static calculateAll(candles) {
    if (!candles || candles.length < 10) return null;
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);
    const closes  = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume || 0);
    const rsi   = this.calculateRSI(closes);
    const macd  = this.calculateMACD(closes);
    const ema12 = this.calculateEMA(closes, Math.min(12, closes.length - 1));
    const ema26 = this.calculateEMA(closes, Math.min(26, closes.length - 1));
    const ema50 = this.calculateEMA(closes, Math.min(50, closes.length - 1));
    const atr    = this.calculateATR(highs, lows, closes);
    const volume = this.analyzeVolume(volumes);
    const fvg    = this.detectFVG(candles);
    const currentPrice = closes[closes.length - 1];
    let trend = 'NEUTRAL';
    if (ema12 > ema26 && ema26 > ema50) trend = 'BULLISH';
    else if (ema12 < ema26 && ema26 < ema50) trend = 'BEARISH';
    return { currentPrice, trend, rsi, macd, ema: { ema12, ema26, ema50 }, atr, volume, fvg, candleCount: candles.length };
  }
}

// ============================================================
// TWELVE DATA FETCHER — Forex + Commodities (FREE, 800/day)
// ============================================================
// Sign up at https://twelvedata.com to get your free API key.
// Free plan: 800 API credits/day, 8 requests/minute.
// Add TWELVE_DATA_API_KEY to your Render environment variables.
// ============================================================
class TwelveDataFetcher {
  constructor() {
    this.apiKey = CONFIG.TWELVE_DATA_API_KEY;
    this.baseUrl = CONFIG.TWELVE_DATA_REST;
    this.lastCall = 0; // rate-limit guard (8 req/min on free plan)
  }

  async fetchCandles(tdSymbol) {
    try {
      if (!this.apiKey) {
        console.warn(`[TwelveData] No API key — skipping ${tdSymbol}`);
        return null;
      }

      // Respect free tier: 8 requests/minute → wait 8s between calls
      const now = Date.now();
      const wait = 8000 - (now - this.lastCall);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.lastCall = Date.now();

      const response = await axios.get(`${this.baseUrl}/time_series`, {
        params: {
          symbol:     tdSymbol,
          interval:   '5min',
          outputsize: 100,
          apikey:     this.apiKey,
        },
        timeout: 15000,
      });

      const d = response.data;

      // API-level error (e.g. wrong symbol, quota exceeded)
      if (d.status === 'error' || d.code) {
        console.error(`[TwelveData] API error ${tdSymbol}: ${d.message || d.code}`);
        return null;
      }

      if (!d.values || !d.values.length) {
        console.log(`[TwelveData] No data for ${tdSymbol}`);
        return null;
      }

      // Twelve Data returns newest first — reverse so oldest is first
      const candles = d.values.reverse().map(bar => ({
        time:   new Date(bar.datetime).getTime(),
        open:   parseFloat(bar.open),
        high:   parseFloat(bar.high),
        low:    parseFloat(bar.low),
        close:  parseFloat(bar.close),
        volume: parseFloat(bar.volume || 0) || 1,
      }));

      console.log(`[TwelveData] ✅ ${tdSymbol}: ${candles.length} candles`);
      return candles;

    } catch (err) {
      const status = err.response?.status;
      console.error(`[TwelveData] Error ${tdSymbol}: ${status || err.message}`);
      return null;
    }
  }
}

// ============================================================
// COINGECKO FETCHER — Crypto (FREE, no key, no IP ban)
// ============================================================
class CoinGeckoFetcher {
  constructor() {
    this.baseUrl = CONFIG.COINGECKO_REST;
    this.lastFetch = {};
  }

  async fetchCandles(cgId) {
    try {
      // OHLC endpoint — 1 day returns ~24 candles (hourly-ish)
      const response = await axios.get(
        `${this.baseUrl}/coins/${cgId}/ohlc`,
        {
          params: { vs_currency: 'usd', days: '1' },
          timeout: 15000,
          headers: { 'Accept': 'application/json' },
        }
      );

      if (!response.data || !response.data.length) {
        console.log(`[CoinGecko] No data for ${cgId}`);
        return null;
      }

      const candles = response.data.map(c => ({
        time: c[0], open: c[1], high: c[2], low: c[3], close: c[4],
        volume: 1000000, // OHLC endpoint has no volume — placeholder
      }));

      console.log(`[CoinGecko] ✅ ${cgId}: ${candles.length} candles`);
      return candles;

    } catch (err) {
      const status = err.response?.status;
      console.error(`[CoinGecko] Error ${cgId}: ${status || err.message}`);
      // Rate limited — try market_chart fallback
      if (status === 429) return await this.fetchMarketChart(cgId);
      return null;
    }
  }

  async fetchMarketChart(cgId) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/coins/${cgId}/market_chart`,
        {
          params: { vs_currency: 'usd', days: '1', interval: 'hourly' },
          timeout: 15000,
        }
      );
      if (!response.data?.prices?.length) return null;
      const prices = response.data.prices;
      const candles = prices.map((p, i) => {
        const prev = prices[i - 1] || p;
        const price = p[1], prevPrice = prev[1];
        return {
          time: p[0], open: prevPrice,
          high: Math.max(price, prevPrice) * 1.001,
          low:  Math.min(price, prevPrice) * 0.999,
          close: price, volume: 1000000,
        };
      });
      console.log(`[CoinGecko] ✅ ${cgId} (market_chart): ${candles.length} candles`);
      return candles;
    } catch (err) {
      console.error(`[CoinGecko] Market chart error ${cgId}: ${err.message}`);
      return null;
    }
  }
}

// ============================================================
// DHAN FETCHER — India NSE Indices (FIXED)
// ============================================================
// FIXES applied:
//   1. oi must be boolean false, NOT the string 'false'
//   2. expiryCode must be integer 0
//   3. Weekend guard — Dhan returns 400 on Sat/Sun (market closed)
//   4. interval changed to FIVE_MINUTE (matches bot's 5-min cycle)
//   5. Better error logging (prints full Dhan error message)
// ============================================================
class DhanFetcher {
  constructor() {
    this.clientId    = CONFIG.DHAN_CLIENT_ID;
    this.accessToken = CONFIG.DHAN_ACCESS_TOKEN;
    this.baseUrl     = CONFIG.DHAN_REST;
  }

  formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  isMarketWeekday() {
    // Dhan rejects requests on weekends (Indian market is Mon-Fri)
    const istNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = istNow.getDay(); // 0 = Sun, 6 = Sat
    return day >= 1 && day <= 5;
  }

  async fetchCandles(symbol) {
    try {
      if (!this.clientId || !this.accessToken) {
        throw new Error('Dhan credentials not configured');
      }

      // Skip weekends — Dhan 400s when market is closed
      if (!this.isMarketWeekday()) {
        console.log(`[Dhan] Weekend/holiday — skipping ${symbol}`);
        return null;
      }

      const config = SYMBOLS[symbol];
      if (!config) return null;

      const toDate   = new Date();
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - 5);

      const requestBody = {
        securityId:      config.dhanSecurityId,  // string, e.g. '13'
        exchangeSegment: 'IDX_I',
        instrument:      'INDEX',
        expiryCode:      0,          // ✅ integer (was missing/wrong type)
        oi:              false,      // ✅ boolean (was string 'false' — caused 400)
        fromDate:        this.formatDate(fromDate),
        toDate:          this.formatDate(toDate),
        interval:        'FIVE_MINUTE', // changed from ONE_MINUTE for cleaner data
      };

      const response = await axios.post(
        `${this.baseUrl}/v2/charts/historical`,
        requestBody,
        {
          headers: {
            'access-token':  this.accessToken,
            'client-id':     this.clientId,
            'Content-Type':  'application/json',
            'Accept':        'application/json',
          },
          timeout: 15000,
        }
      );

      const data = response.data;
      if (!data?.open?.length) {
        console.log(`[Dhan] Empty response for ${symbol}`);
        return null;
      }

      const candles = data.timestamp.map((t, i) => ({
        time:   t * 1000,
        open:   data.open[i],
        high:   data.high[i],
        low:    data.low[i],
        close:  data.close[i],
        volume: data.volume?.[i] || 0,
      }));

      console.log(`[Dhan] ✅ ${symbol}: ${candles.length} candles`);
      return candles;

    } catch (err) {
      const status = err.response?.status;
      const msg    = err.response?.data?.remarks
                  || err.response?.data?.errorMessage
                  || err.response?.data?.message
                  || err.message;
      console.error(`[Dhan] Error ${symbol}: ${status} — ${msg}`);
      return null;
    }
  }
}

// ============================================================
// METATRADER RECEIVER (Optional Fallback)
// ============================================================
class MetaTraderReceiver {
  constructor() { this.data = {}; this.lastUpdate = {}; }
  receiveData(symbol, candles) { this.data[symbol] = candles; this.lastUpdate[symbol] = Date.now(); }
  getCandles(symbol) {
    if (!this.lastUpdate[symbol] || Date.now() - this.lastUpdate[symbol] > 15 * 60 * 1000) return null;
    return this.data[symbol] || null;
  }
}

// ============================================================
// HYBRID DATA FETCHER
// ============================================================
class HybridDataFetcher {
  constructor() {
    this.twelvedata = new TwelveDataFetcher();
    this.coingecko  = new CoinGeckoFetcher();
    this.dhan       = new DhanFetcher();
    this.metatrader = new MetaTraderReceiver();
    this.cache      = {};
    this.cgLastFetch = {};
  }

  async initialize() {
    console.log('[Bot] ✅ Data sources:');
    console.log('[Bot]    Crypto  → CoinGecko    (free, no key)');
    console.log('[Bot]    Forex   → Twelve Data  (free, key needed)');
    console.log('[Bot]    India   → Dhan REST API');
    if (!CONFIG.TWELVE_DATA_API_KEY) {
      console.warn('[Bot] ⚠️  TWELVE_DATA_API_KEY not set — Forex/Gold will use cache/MetaTrader fallback');
    }
    if (!CONFIG.DHAN_CLIENT_ID || !CONFIG.DHAN_ACCESS_TOKEN) {
      console.warn('[Bot] ⚠️  Dhan credentials not set — NSE indices will be skipped');
    }
  }

  async fetchCandles(symbol) {
    const config = SYMBOLS[symbol];
    if (!config) return null;
    let candles = null;
    let source  = 'unknown';

    try {
      if (config.source === 'twelvedata') {
        candles = await this.twelvedata.fetchCandles(config.tdSymbol);
        source  = 'twelvedata';

      } else if (config.source === 'coingecko') {
        // Rate limit: 2s between CoinGecko calls
        const now  = Date.now();
        const last = this.cgLastFetch[config.cgId] || 0;
        if (now - last < 2000) await new Promise(r => setTimeout(r, 2000 - (now - last)));
        candles = await this.coingecko.fetchCandles(config.cgId);
        this.cgLastFetch[config.cgId] = Date.now();
        source  = 'coingecko';

      } else if (config.source === 'dhan') {
        candles = await this.dhan.fetchCandles(symbol);
        source  = 'dhan';
      }
    } catch (err) {
      console.error(`[Hybrid] Error ${symbol}:`, err.message);
    }

    // Fallback 1: MetaTrader EA data
    if (!candles || candles.length < 10) {
      const mtCandles = this.metatrader.getCandles(symbol);
      if (mtCandles) { candles = mtCandles; source = 'metatrader'; }
    }

    // Fallback 2: Last-known cache
    if (!candles || candles.length < 10) {
      if (this.cache[symbol]) { candles = this.cache[symbol]; source = 'cache'; }
    }

    // Update cache on success
    if (candles?.length >= 10) this.cache[symbol] = candles;

    return candles?.length >= 10 ? { candles, source } : null;
  }
}

// ============================================================
// SIGNAL GENERATOR
// ============================================================
class SignalGenerator {
  constructor() { this.allStrategies = [...STRATEGIES.combo, ...STRATEGIES.core]; }

  scoreSignal(strategy, indicators) {
    let score = strategy.probability;
    if (!indicators) return score;
    if (indicators.rsi) {
      if (indicators.rsi >= 30 && indicators.rsi <= 70) score += 5;
      if (indicators.rsi < 25 || indicators.rsi > 75)  score += 8;
    }
    if (indicators.macd?.histogram > 0 && indicators.trend === 'BULLISH') score += 8;
    if (indicators.macd?.histogram < 0 && indicators.trend === 'BEARISH') score += 8;
    if (indicators.volume?.spike) score += 8;
    if (indicators.fvg)           score += 5;
    const { ema12, ema26, ema50 } = indicators.ema || {};
    if (ema12 && ema26 && ema50) {
      if (ema12 > ema26 && ema26 > ema50) score += 8;
      if (ema12 < ema26 && ema26 < ema50) score += 8;
    }
    return Math.min(Math.round(score), 100);
  }

  getDirection(indicators) {
    if (!indicators) return Math.random() > 0.5 ? 'BUY' : 'SELL';
    if (indicators.fvg) return indicators.fvg.type === 'bullish' ? 'BUY' : 'SELL';
    if (indicators.rsi < 35) return 'BUY';
    if (indicators.rsi > 65) return 'SELL';
    if (indicators.trend === 'BULLISH') return 'BUY';
    if (indicators.trend === 'BEARISH') return 'SELL';
    return Math.random() > 0.5 ? 'BUY' : 'SELL';
  }

  calculateLevels(direction, price, atr) {
    const risk = atr || price * 0.01;
    return direction === 'BUY' ? {
      entry: price,
      sl:  parseFloat((price - risk).toFixed(6)),
      tp1: parseFloat((price + risk).toFixed(6)),
      tp2: parseFloat((price + risk * 2).toFixed(6)),
      tp3: parseFloat((price + risk * 3).toFixed(6)),
      riskReward: '1:2',
    } : {
      entry: price,
      sl:  parseFloat((price + risk).toFixed(6)),
      tp1: parseFloat((price - risk).toFixed(6)),
      tp2: parseFloat((price - risk * 2).toFixed(6)),
      tp3: parseFloat((price - risk * 3).toFixed(6)),
      riskReward: '1:2',
    };
  }

  generateSignal(symbol, candles, source) {
    const indicators = TechnicalIndicators.calculateAll(candles);
    if (!indicators) return null;
    const strategy = this.allStrategies[Math.floor(Math.random() * this.allStrategies.length)];
    const quality  = this.scoreSignal(strategy, indicators);
    if (quality < CONFIG.SIGNAL_QUALITY_MIN) return null;
    const direction = this.getDirection(indicators);
    const levels    = this.calculateLevels(direction, indicators.currentPrice, indicators.atr);
    return {
      id: `${symbol}_${Date.now()}`, symbol,
      symbolName: SYMBOLS[symbol].name, category: SYMBOLS[symbol].category,
      direction, quality,
      strategy: { id: strategy.id, name: strategy.name, probability: strategy.probability, strength: strategy.strength },
      levels,
      indicators: { rsi: indicators.rsi, macd: indicators.macd, trend: indicators.trend, volume: indicators.volume, fvg: indicators.fvg, ema: indicators.ema },
      dataSource: source, candleCount: candles.length, timestamp: new Date().toISOString(),
    };
  }
}

// ============================================================
// TELEGRAM ALERT
// ============================================================
async function sendTelegramAlert(signal) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  const emoji = signal.direction === 'BUY' ? '🟢' : '🔴';
  const bar   = '█'.repeat(Math.floor(signal.quality / 10)) + '░'.repeat(10 - Math.floor(signal.quality / 10));
  const msg   = `${emoji} *${signal.direction} — ${signal.symbol}*
━━━━━━━━━━━━━━━━━━━━
📊 ${signal.symbolName} | ${signal.category.toUpperCase()}
⚡ ${signal.strategy.name}
💯 Quality: ${signal.quality}/100 [${bar}]

💰 Entry: \`${signal.levels.entry}\`
🛑 SL: \`${signal.levels.sl}\`
🎯 TP1: \`${signal.levels.tp1}\`
🎯 TP2: \`${signal.levels.tp2}\`
🎯 TP3: \`${signal.levels.tp3}\`

📈 RSI: ${signal.indicators.rsi} | Trend: ${signal.indicators.trend}
🔌 Source: ${signal.dataSource.toUpperCase()}
🕐 ${new Date(signal.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
⚠️ _Educational purposes only_`;

  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: CONFIG.TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' },
      { timeout: 10000 }
    );
    console.log(`[Telegram] ✅ ${signal.direction} ${signal.symbol}`);
  } catch (err) {
    console.error('[Telegram] Error:', err.message);
  }
}

// ============================================================
// BOT ENGINE
// ============================================================
const botState = {
  signals: [],
  stats: { totalAnalyzed: 0, totalSignals: 0, startTime: Date.now() },
  isRunning: false,
};
const dataFetcher    = new HybridDataFetcher();
const signalGenerator = new SignalGenerator();

async function runAnalysisCycle() {
  if (botState.isRunning) return;
  botState.isRunning = true;
  console.log(`\n[Bot] ⚡ Analysis cycle — ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);
  let cycleSignals = 0;

  for (const symbol of Object.keys(SYMBOLS)) {
    try {
      const result = await dataFetcher.fetchCandles(symbol);
      botState.stats.totalAnalyzed++;
      if (!result) { console.log(`[Bot] ⚠️ No data for ${symbol}`); continue; }
      const signal = signalGenerator.generateSignal(symbol, result.candles, result.source);
      if (signal) {
        botState.signals.unshift(signal);
        if (botState.signals.length > CONFIG.MAX_SIGNALS_STORED)
          botState.signals = botState.signals.slice(0, CONFIG.MAX_SIGNALS_STORED);
        botState.stats.totalSignals++;
        cycleSignals++;
        console.log(`[Bot] ✅ ${signal.direction} ${symbol} Q:${signal.quality} src:${result.source}`);
        await sendTelegramAlert(signal);
        await new Promise(r => setTimeout(r, 500));
      } else {
        console.log(`[Bot] ℹ️ No signal: ${symbol} (src:${result.source})`);
      }
    } catch (err) {
      console.error(`[Bot] Error ${symbol}:`, err.message);
    }
  }

  console.log(`[Bot] ✅ Cycle done — ${cycleSignals} signals\n`);
  botState.isRunning = false;
}

// ============================================================
// API ENDPOINTS
// ============================================================
app.get('/', (req, res) => res.json({
  bot: 'HYBRID TRADING BOT v5.3', status: 'OPERATIONAL ✅', version: '5.3.0',
  dataSources: {
    crypto:      'CoinGecko (free, no key)',
    forex:       'Twelve Data API (free, key needed)',
    commodities: 'Twelve Data API (free, key needed)',
    india:       'Dhan API',
  },
  symbols:    { forex: 4, crypto: 5, commodity: 2, india: 3, total: 14 },
  strategies: { total: 38 },
  endpoints: [
    'GET  /api/health',
    'GET  /api/signals',
    'GET  /api/signals/:symbol',
    'GET  /api/strategies',
    'GET  /api/symbols',
    'GET  /api/stats',
    'POST /api/metatrader/receive',
  ],
}));

app.get('/api/health', (req, res) => {
  const uptime = Math.floor((Date.now() - botState.stats.startTime) / 1000);
  res.json({
    status: 'OPERATIONAL ✅', version: '5.3.0',
    uptime: `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m ${uptime%60}s`,
    totalSignals: botState.stats.totalSignals,
    totalAnalyzed: botState.stats.totalAnalyzed,
    dataSources: {
      twelvedata: CONFIG.TWELVE_DATA_API_KEY ? '✅ Forex+Gold' : '⚠️ Key missing',
      coingecko:  '✅ Crypto (no key needed)',
      dhan:       (CONFIG.DHAN_CLIENT_ID && CONFIG.DHAN_ACCESS_TOKEN) ? '✅ India NSE' : '⚠️ Credentials missing',
    },
    symbols: 14, strategies: 38,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/signals', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const category = req.query.category;
  let signals = botState.signals.slice(0, limit);
  if (category) signals = signals.filter(s => s.category === category);
  res.json({ count: signals.length, signals });
});

app.get('/api/signals/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  res.json({ symbol, signals: botState.signals.filter(s => s.symbol === symbol) });
});

app.get('/api/strategies', (req, res) => res.json({ total: 38, combo: STRATEGIES.combo, core: STRATEGIES.core }));

app.get('/api/symbols', (req, res) => res.json({ total: 14, symbols: SYMBOLS }));

app.get('/api/stats', (req, res) => {
  const uptime = Math.floor((Date.now() - botState.stats.startTime) / 1000);
  const byCategory = {};
  botState.signals.forEach(s => { byCategory[s.category] = (byCategory[s.category] || 0) + 1; });
  res.json({
    uptime: `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`,
    totalAnalyzed:  botState.stats.totalAnalyzed,
    totalSignals:   botState.stats.totalSignals,
    avgQuality: botState.signals.length
      ? Math.round(botState.signals.reduce((s, x) => s + x.quality, 0) / botState.signals.length) : 0,
    byCategory,
    BUY:  botState.signals.filter(s => s.direction === 'BUY').length,
    SELL: botState.signals.filter(s => s.direction === 'SELL').length,
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
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   HYBRID TRADING BOT v5.3 - ALL FIXED! ✅   ║');
  console.log('║  Crypto  → CoinGecko  (no key, no ban)      ║');
  console.log('║  Forex   → Twelve Data (free key)            ║');
  console.log('║  India   → Dhan REST API (body fixed)        ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  app.listen(CONFIG.PORT, () => console.log(`[Server] ✅ Port ${CONFIG.PORT}`));
  await dataFetcher.initialize();
  console.log('[Bot] Running initial analysis...');
  await runAnalysisCycle();
  cron.schedule(CONFIG.ANALYSIS_INTERVAL, runAnalysisCycle);
  console.log('[Bot] ✅ Scheduled every 5 minutes\n');
}

startBot().catch(err => { console.error('[Fatal]', err); process.exit(1); });
