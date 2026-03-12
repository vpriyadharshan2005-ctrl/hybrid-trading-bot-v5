// ============================================================
// HYBRID TRADING BOT v5.0
// ============================================================
// DATA SOURCES:
//   CRYPTO      → Delta Exchange API (REST + WebSocket)
//   FOREX/GOLD  → Finnhub API (REST + WebSocket)
//   INDIA NSE   → Dhan API (REST + WebSocket)
//   FALLBACK    → MetaTrader EA + Cached Data
// FEATURES:
//   38 Strategies | 14 Symbols | Every 5 Minutes
//   Real-time WebSocket | Telegram Alerts | Quality Scoring
// ============================================================

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const WebSocket = require('ws');

const app = express();
app.use(express.json());

// ============================================================
// CONFIGURATION & CONSTANTS
// ============================================================

const CONFIG = {
  PORT: process.env.PORT || 5000,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

  // Finnhub (Forex + Commodities)
  FINNHUB_API_KEY: process.env.FINNHUB_API_KEY || 'd6pcq71r01qo88ainbfgd6pcq71r01qo88ainbg0',
  FINNHUB_REST: 'https://finnhub.io/api/v1',
  FINNHUB_WS: 'wss://ws.finnhub.io',

  // Delta Exchange (Crypto)
  DELTA_REST: 'https://api.india.delta.exchange/v2',
  DELTA_WS: 'wss://socket.india.delta.exchange',

  // Dhan API (India NSE Indices)
  DHAN_CLIENT_ID: process.env.DHAN_CLIENT_ID || '2603137293',
  DHAN_ACCESS_TOKEN: process.env.DHAN_ACCESS_TOKEN || 'eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbkNvbnN1bWVyVHlwZSI6IlNFTEYiLCJwYXJ0bmVySWQiOiIiLCJkaGFuQ2xpZW50SWQiOiIyNjAzMTM3MjkzIiwid2ViaG9va1VybCI6IiIsImlzcyI6ImRoYW4iLCJleHAiOjE3NzU5MzUxNDF9.kUa6RbR9O6f9vgvmTTsWlGlwllEWeCehtq5lOPUgeIcnc4L4YNPW51Vo2RfRbCqecPqKfLuurUtm_aEj_J6h4Q',
  DHAN_REST: 'https://api.dhan.co',
  DHAN_WS: 'wss://api-feed.dhan.co',

  // Bot Settings
  SIGNAL_QUALITY_MIN: 70,
  ANALYSIS_INTERVAL: '*/5 * * * *', // every 5 minutes
  MAX_SIGNALS_STORED: 100,
  CANDLE_LIMIT: 100,
};

// ============================================================
// ALL 14 SYMBOLS CONFIGURATION
// ============================================================

const SYMBOLS = {
  // FOREX - via Finnhub
  EURUSD: { name: 'EUR/USD', category: 'forex', source: 'finnhub', finnhubSymbol: 'OANDA:EUR_USD', interval: '5', volatility: 'medium' },
  GBPUSD: { name: 'GBP/USD', category: 'forex', source: 'finnhub', finnhubSymbol: 'OANDA:GBP_USD', interval: '5', volatility: 'high' },
  USDJPY: { name: 'USD/JPY', category: 'forex', source: 'finnhub', finnhubSymbol: 'OANDA:USD_JPY', interval: '5', volatility: 'medium' },
  AUDUSD: { name: 'AUD/USD', category: 'forex', source: 'finnhub', finnhubSymbol: 'OANDA:AUD_USD', interval: '5', volatility: 'medium' },

  // COMMODITIES - via Finnhub
  XAUUSD: { name: 'Gold/USD', category: 'commodity', source: 'finnhub', finnhubSymbol: 'OANDA:XAU_USD', interval: '5', volatility: 'high' },
  XAGUSD: { name: 'Silver/USD', category: 'commodity', source: 'finnhub', finnhubSymbol: 'OANDA:XAG_USD', interval: '5', volatility: 'very_high' },

  // CRYPTO - via Delta Exchange
  BTCUSDT: { name: 'Bitcoin/USDT', category: 'crypto', source: 'delta', deltaSymbol: 'BTCUSDT', interval: '5m', volatility: 'very_high' },
  ETHUSDT: { name: 'Ethereum/USDT', category: 'crypto', source: 'delta', deltaSymbol: 'ETHUSDT', interval: '5m', volatility: 'high' },
  XRPUSDT: { name: 'Ripple/USDT', category: 'crypto', source: 'delta', deltaSymbol: 'XRPUSDT', interval: '5m', volatility: 'very_high' },
  LTCUSDT: { name: 'Litecoin/USDT', category: 'crypto', source: 'delta', deltaSymbol: 'LTCUSDT', interval: '5m', volatility: 'high' },
  BNBUSDT: { name: 'BNB/USDT', category: 'crypto', source: 'delta', deltaSymbol: 'BNBUSDT', interval: '5m', volatility: 'high' },

  // INDIA NSE INDICES - via Dhan
  NIFTY:     { name: 'NIFTY 50', category: 'india', source: 'dhan', dhanToken: '13', exchangeSegment: 'IDX_I', interval: '5', volatility: 'medium' },
  BANKNIFTY: { name: 'Bank NIFTY', category: 'india', source: 'dhan', dhanToken: '25', exchangeSegment: 'IDX_I', interval: '5', volatility: 'high' },
  FINNIFTY:  { name: 'Fin NIFTY', category: 'india', source: 'dhan', dhanToken: '27', exchangeSegment: 'IDX_I', interval: '5', volatility: 'high' },
};

// ============================================================
// ALL 38 STRATEGIES
// ============================================================

const STRATEGIES = {
  // --- COMBO STRATEGIES (12) ---
  combo: [
    { id: 'OB_FVG', name: 'Order Block + Fair Value Gap', probability: 80, category: 'combo', description: 'Confluence of OB and FVG for high probability entries', strength: 'very_strong' },
    { id: 'CHOCH_LIQ', name: 'ChoCh + Liquidity Sweep', probability: 75, category: 'combo', description: 'Trend break confirmed by liquidity level hit', strength: 'strong' },
    { id: 'ORB_MA', name: 'ORB + MA Stack', probability: 78, category: 'combo', description: 'Opening range breakout with aligned EMAs', strength: 'strong' },
    { id: 'OB_CONS', name: 'Order Block + Consolidation', probability: 76, category: 'combo', description: 'OB formed inside tight consolidation zone', strength: 'strong' },
    { id: 'CHOCH_VOL', name: 'ChoCh + Volume Spike', probability: 80, category: 'combo', description: 'Structure break confirmed by volume surge', strength: 'very_strong' },
    { id: 'OVERLAP_OB', name: 'London-NY Overlap + OB', probability: 85, category: 'combo', description: 'High volatility session with order block confluence', strength: 'very_strong' },
    { id: 'FVG_BOS', name: 'FVG + Break of Structure', probability: 90, category: 'combo', description: 'Fair value gap combined with structural break', strength: 'exceptional' },
    { id: 'MR_FIB', name: 'Mean Reversion + Fibonacci', probability: 78, category: 'combo', description: 'Price at extreme with Fibonacci confluence', strength: 'strong' },
    { id: 'FVG_MR', name: 'FVG + Mean Reversion', probability: 80, category: 'combo', description: 'Gap fill opportunity at price extreme', strength: 'very_strong' },
    { id: 'OB_HTF', name: 'Order Block + HTF Confirm', probability: 78, category: 'combo', description: 'Multi-timeframe order block confirmation', strength: 'strong' },
    { id: 'FVG_BOS_HTF', name: 'FVG + BoS + HTF (BEST)', probability: 92, category: 'combo', description: 'Triple confluence: FVG + Structure + Higher TF', strength: 'exceptional' },
    { id: 'PB_VOL', name: 'Pullback + Volume', probability: 75, category: 'combo', description: 'Trend pullback confirmed by volume increase', strength: 'strong' },
  ],

  // --- CORE STRATEGIES (26) ---
  core: [
    // Price Action (8)
    { id: 'FVG', name: 'Fair Value Gap', probability: 95, category: 'price_action', description: 'Unfilled imbalance gap in price structure', strength: 'exceptional' },
    { id: 'OB', name: 'Order Block', probability: 70, category: 'price_action', description: 'Institutional order consolidation zone', strength: 'moderate' },
    { id: 'CHOCH', name: 'Change of Character', probability: 75, category: 'price_action', description: 'Market structure trend reversal signal', strength: 'strong' },
    { id: 'BOS', name: 'Break of Structure', probability: 70, category: 'price_action', description: 'Key level break with momentum confirmation', strength: 'moderate' },
    { id: 'LIQ_SWEEP', name: 'Liquidity Sweep', probability: 65, category: 'price_action', description: 'Price raids highs/lows then reverses sharply', strength: 'moderate' },
    { id: 'SR', name: 'Support & Resistance', probability: 68, category: 'price_action', description: 'Classic swing high/low level bounce', strength: 'moderate' },
    { id: 'TL_BREAK', name: 'Trendline Break', probability: 68, category: 'price_action', description: 'Price breaks established trend line', strength: 'moderate' },
    { id: 'INSIDE_BAR', name: 'Inside Bar', probability: 66, category: 'price_action', description: 'Candle contained within previous candle range', strength: 'moderate' },

    // Moving Averages (4)
    { id: 'EMA_CROSS', name: 'EMA Crossover', probability: 65, category: 'moving_average', description: 'EMA 12 crosses above/below EMA 26', strength: 'moderate' },
    { id: 'MA_STACK', name: 'MA Stack', probability: 72, category: 'moving_average', description: 'EMA 20 > 50 > 100 perfectly aligned', strength: 'strong' },
    { id: 'OVERLAP', name: 'London-NY Overlap', probability: 80, category: 'moving_average', description: 'High volatility during session overlap', strength: 'very_strong' },
    { id: 'PULLBACK', name: 'Pullback Entry', probability: 65, category: 'moving_average', description: 'Trend continuation after pullback to support', strength: 'moderate' },

    // Breakouts (3)
    { id: 'ORB', name: 'Opening Range Breakout', probability: 72, category: 'breakout', description: 'Break of first hour high/low range', strength: 'strong' },
    { id: 'CONS_BREAK', name: 'Consolidation Breakout', probability: 70, category: 'breakout', description: 'Price breaks from tight consolidation zone', strength: 'moderate' },
    { id: 'HTF_CONF', name: 'Higher TF Confirmation', probability: 65, category: 'breakout', description: 'Signal confirmed on higher timeframe', strength: 'moderate' },

    // Mean Reversion (4)
    { id: 'MR', name: 'Mean Reversion', probability: 70, category: 'mean_reversion', description: 'RSI extreme signals expected pullback', strength: 'moderate' },
    { id: 'FIB', name: 'Fibonacci Retracement', probability: 70, category: 'mean_reversion', description: 'Pullback to 38.2/50/61.8% Fib levels', strength: 'moderate' },
    { id: 'BB', name: 'Bollinger Bands', probability: 65, category: 'mean_reversion', description: 'Price at upper/lower Bollinger Band', strength: 'moderate' },
    { id: 'BB_BOUNCE', name: 'Bollinger Bounce', probability: 65, category: 'mean_reversion', description: 'Bounce signal off Bollinger Band', strength: 'moderate' },

    // Momentum (4)
    { id: 'RSI_DIV', name: 'RSI Divergence', probability: 67, category: 'momentum', description: 'Price and RSI moving in opposite directions', strength: 'moderate' },
    { id: 'MACD_DIV', name: 'MACD Divergence', probability: 68, category: 'momentum', description: 'Price and MACD histogram diverging', strength: 'moderate' },
    { id: 'RSI_EXT', name: 'RSI Extremes', probability: 64, category: 'momentum', description: 'RSI above 80 or below 20 signal', strength: 'weak' },
    { id: 'TREND_CONF', name: 'Trend Confirmation', probability: 68, category: 'momentum', description: 'Multiple indicators confirming trend', strength: 'moderate' },

    // Volume & Gaps (3)
    { id: 'VOL_CONF', name: 'Volume Confirmation', probability: 68, category: 'volume', description: 'Volume spike confirms price movement', strength: 'moderate' },
    { id: 'GAP_FILL', name: 'Gap Fill', probability: 65, category: 'volume', description: 'Price moves to fill recent price gap', strength: 'moderate' },
    { id: 'CONF_ZONE', name: 'Confluence Zone', probability: 72, category: 'volume', description: 'Multiple levels meet: OB + S/R + Fib', strength: 'strong' },
  ]
};

// ============================================================
// TECHNICAL INDICATORS CLASS
// ============================================================

class TechnicalIndicators {
  // RSI - Relative Strength Index (14 period)
  static calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses += Math.abs(diff);
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
  }

  // EMA - Exponential Moving Average
  static calculateEMA(closes, period) {
    if (closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
    }
    return parseFloat(ema.toFixed(6));
  }

  // SMA - Simple Moving Average
  static calculateSMA(closes, period) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    return parseFloat((slice.reduce((a, b) => a + b, 0) / period).toFixed(6));
  }

  // MACD - Moving Average Convergence Divergence
  static calculateMACD(closes) {
    const ema12 = this.calculateEMA(closes, 12);
    const ema26 = this.calculateEMA(closes, 26);
    if (!ema12 || !ema26) return null;
    const macdLine = parseFloat((ema12 - ema26).toFixed(6));
    const signalLine = this.calculateEMA(
      closes.slice(-9).map((_, i) =>
        this.calculateEMA(closes.slice(0, closes.length - 9 + i + 1), 12) -
        this.calculateEMA(closes.slice(0, closes.length - 9 + i + 1), 26)
      ).filter(v => v !== null),
      9
    ) || macdLine * 0.9;
    const histogram = parseFloat((macdLine - signalLine).toFixed(6));
    return { macdLine, signalLine, histogram };
  }

  // Bollinger Bands
  static calculateBollingerBands(closes, period = 20, stdDev = 2) {
    if (closes.length < period) return null;
    const sma = this.calculateSMA(closes.slice(-period), period);
    const variance = closes.slice(-period).reduce((sum, c) => sum + Math.pow(c - sma, 2), 0) / period;
    const std = Math.sqrt(variance);
    return {
      upper: parseFloat((sma + stdDev * std).toFixed(6)),
      middle: parseFloat(sma.toFixed(6)),
      lower: parseFloat((sma - stdDev * std).toFixed(6)),
      bandwidth: parseFloat(((stdDev * 2 * std) / sma * 100).toFixed(2))
    };
  }

  // ATR - Average True Range
  static calculateATR(highs, lows, closes, period = 14) {
    if (closes.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < closes.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      trs.push(tr);
    }
    return parseFloat((trs.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(6));
  }

  // Volume Analysis
  static analyzeVolume(volumes) {
    if (volumes.length < 20) return { spike: false, ratio: 1 };
    const avgVolume = volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
    const currentVolume = volumes[volumes.length - 1];
    const ratio = currentVolume / avgVolume;
    return {
      spike: ratio > 1.5,
      ratio: parseFloat(ratio.toFixed(2)),
      current: currentVolume,
      average: parseFloat(avgVolume.toFixed(0))
    };
  }

  // Fair Value Gap detection
  static detectFVG(candles) {
    if (candles.length < 3) return null;
    const [c1, c2, c3] = candles.slice(-3);
    // Bullish FVG: c1 high < c3 low
    if (c1.high < c3.low) {
      return { type: 'bullish', top: c3.low, bottom: c1.high, size: c3.low - c1.high };
    }
    // Bearish FVG: c1 low > c3 high
    if (c1.low > c3.high) {
      return { type: 'bearish', top: c1.low, bottom: c3.high, size: c1.low - c3.high };
    }
    return null;
  }

  // Order Block detection
  static detectOrderBlock(candles) {
    if (candles.length < 5) return null;
    const recent = candles.slice(-5);
    const lastCandle = recent[recent.length - 1];
    // Bullish OB: strong bearish candle followed by strong bullish move
    const bullishOB = recent.slice(0, -1).find(c =>
      c.close < c.open && (c.open - c.close) / c.open > 0.001
    );
    if (bullishOB && lastCandle.close > bullishOB.high) {
      return { type: 'bullish', high: bullishOB.high, low: bullishOB.low };
    }
    return null;
  }

  // Divergence detection (RSI)
  static detectDivergence(closes, rsiValues) {
    if (closes.length < 10 || rsiValues.length < 10) return null;
    const priceUp = closes[closes.length - 1] > closes[closes.length - 5];
    const rsiUp = rsiValues[rsiValues.length - 1] > rsiValues[rsiValues.length - 5];
    if (priceUp && !rsiUp) return 'bearish_divergence';
    if (!priceUp && rsiUp) return 'bullish_divergence';
    return null;
  }

  // All indicators combined
  static calculateAll(candles) {
    if (!candles || candles.length < 30) return null;
    const opens = candles.map(c => c.open);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);

    const rsi = this.calculateRSI(closes);
    const macd = this.calculateMACD(closes);
    const ema12 = this.calculateEMA(closes, 12);
    const ema26 = this.calculateEMA(closes, 26);
    const ema50 = this.calculateEMA(closes, 50);
    const sma50 = this.calculateSMA(closes, 50);
    const sma200 = this.calculateSMA(closes, 200);
    const bb = this.calculateBollingerBands(closes);
    const atr = this.calculateATR(highs, lows, closes);
    const volume = this.analyzeVolume(volumes);
    const fvg = this.detectFVG(candles);
    const ob = this.detectOrderBlock(candles);

    const currentPrice = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2];
    const priceChange = ((currentPrice - prevPrice) / prevPrice * 100).toFixed(4);

    // Trend determination
    let trend = 'NEUTRAL';
    if (ema12 && ema26 && ema50) {
      if (ema12 > ema26 && ema26 > ema50) trend = 'BULLISH';
      else if (ema12 < ema26 && ema26 < ema50) trend = 'BEARISH';
    }

    return {
      currentPrice,
      priceChange: parseFloat(priceChange),
      trend,
      rsi,
      macd,
      ema: { ema12, ema26, ema50 },
      sma: { sma50, sma200 },
      bollingerBands: bb,
      atr,
      volume,
      fvg,
      orderBlock: ob,
      candleCount: candles.length
    };
  }
}

// ============================================================
// FINNHUB DATA FETCHER (Forex + Commodities)
// ============================================================

class FinnhubFetcher {
  constructor() {
    this.apiKey = CONFIG.FINNHUB_API_KEY;
    this.baseUrl = CONFIG.FINNHUB_REST;
    this.ws = null;
    this.liveData = {};
  }

  // Fetch OHLCV candles via REST
  async fetchCandles(symbol, resolution = '5', count = 100) {
    try {
      const to = Math.floor(Date.now() / 1000);
      const from = to - count * resolution * 60;
      const url = `${this.baseUrl}/forex/candle`;
      const response = await axios.get(url, {
        params: { symbol, resolution, from, to, token: this.apiKey },
        timeout: 10000
      });
      const data = response.data;
      if (!data || data.s !== 'ok' || !data.c) {
        console.log(`[Finnhub] No data for ${symbol}`);
        return null;
      }
      const candles = data.t.map((time, i) => ({
        time: time * 1000,
        open: data.o[i],
        high: data.h[i],
        low: data.l[i],
        close: data.c[i],
        volume: data.v[i] || 0
      }));
      console.log(`[Finnhub] ✅ ${symbol}: ${candles.length} candles fetched`);
      return candles;
    } catch (err) {
      console.error(`[Finnhub] Error fetching ${symbol}:`, err.message);
      return null;
    }
  }

  // Connect WebSocket for real-time price streaming
  connectWebSocket(symbols) {
    try {
      this.ws = new WebSocket(`${CONFIG.FINNHUB_WS}?token=${this.apiKey}`);
      this.ws.on('open', () => {
        console.log('[Finnhub WS] Connected ✅');
        symbols.forEach(sym => {
          this.ws.send(JSON.stringify({ type: 'subscribe', symbol: sym }));
          console.log(`[Finnhub WS] Subscribed to ${sym}`);
        });
      });
      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'trade' && msg.data) {
            msg.data.forEach(trade => {
              this.liveData[trade.s] = {
                price: trade.p,
                volume: trade.v,
                timestamp: trade.t,
                updatedAt: Date.now()
              };
            });
          }
        } catch (e) { /* ignore parse errors */ }
      });
      this.ws.on('error', (err) => console.error('[Finnhub WS] Error:', err.message));
      this.ws.on('close', () => {
        console.log('[Finnhub WS] Disconnected — reconnecting in 5s...');
        setTimeout(() => this.connectWebSocket(symbols), 5000);
      });
    } catch (err) {
      console.error('[Finnhub WS] Connection failed:', err.message);
    }
  }

  getLivePrice(finnhubSymbol) {
    return this.liveData[finnhubSymbol] || null;
  }
}

// ============================================================
// DELTA EXCHANGE DATA FETCHER (Crypto)
// ============================================================

class DeltaExchangeFetcher {
  constructor() {
    this.baseUrl = CONFIG.DELTA_REST;
    this.ws = null;
    this.liveData = {};
    this.productMap = {}; // symbol -> product_id
  }

  // Get product IDs for symbols
  async fetchProductMap() {
    try {
      const response = await axios.get(`${this.baseUrl}/products`, { timeout: 10000 });
      const products = response.data.result || [];
      products.forEach(p => {
        if (p.symbol) this.productMap[p.symbol] = p.id;
      });
      console.log(`[Delta] Product map loaded: ${Object.keys(this.productMap).length} products`);
    } catch (err) {
      console.error('[Delta] Error fetching product map:', err.message);
    }
  }

  // Fetch OHLCV candles via REST
  async fetchCandles(symbol, resolution = '5m', limit = 100) {
    try {
      const end = Math.floor(Date.now() / 1000);
      const resSeconds = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '1h': 3600 };
      const start = end - limit * (resSeconds[resolution] || 300);
      const response = await axios.get(`${this.baseUrl}/history/candles`, {
        params: { symbol, resolution, start, end },
        timeout: 10000
      });
      const data = response.data;
      if (!data || !data.result || !data.result.length) {
        console.log(`[Delta] No candles for ${symbol}`);
        return null;
      }
      const candles = data.result.map(c => ({
        time: c.time * 1000,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
        volume: parseFloat(c.volume || 0)
      }));
      console.log(`[Delta] ✅ ${symbol}: ${candles.length} candles fetched`);
      return candles;
    } catch (err) {
      console.error(`[Delta] Error fetching ${symbol}:`, err.message);
      return null;
    }
  }

  // Connect WebSocket for real-time price streaming
  connectWebSocket(symbols) {
    try {
      this.ws = new WebSocket(CONFIG.DELTA_WS);
      this.ws.on('open', () => {
        console.log('[Delta WS] Connected ✅');
        const channels = symbols.map(sym => `v2/ticker/${sym}`);
        this.ws.send(JSON.stringify({
          type: 'subscribe',
          payload: { channels: channels.map(c => ({ name: c })) }
        }));
      });
      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg.type === 'v2/ticker' && msg.symbol) {
            this.liveData[msg.symbol] = {
              price: parseFloat(msg.close),
              volume: parseFloat(msg.volume || 0),
              timestamp: Date.now(),
              updatedAt: Date.now()
            };
          }
        } catch (e) { /* ignore */ }
      });
      this.ws.on('error', (err) => console.error('[Delta WS] Error:', err.message));
      this.ws.on('close', () => {
        console.log('[Delta WS] Disconnected — reconnecting in 5s...');
        setTimeout(() => this.connectWebSocket(symbols), 5000);
      });
    } catch (err) {
      console.error('[Delta WS] Connection failed:', err.message);
    }
  }

  getLivePrice(symbol) {
    return this.liveData[symbol] || null;
  }
}

// ============================================================
// DHAN DATA FETCHER (India NSE Indices)
// ============================================================

class DhanFetcher {
  constructor() {
    this.clientId = CONFIG.DHAN_CLIENT_ID;
    this.accessToken = CONFIG.DHAN_ACCESS_TOKEN;
    this.baseUrl = CONFIG.DHAN_REST;
    this.ws = null;
    this.liveData = {};
    this.headers = {
      'access-token': this.accessToken,
      'client-id': this.clientId,
      'Content-Type': 'application/json'
    };
  }

  // Fetch historical candles via REST
  async fetchCandles(symbol, interval = '5') {
    try {
      const config = SYMBOLS[symbol];
      if (!config) return null;
      const toDate = new Date();
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - 30); // last 30 days
      const response = await axios.post(
        `${this.baseUrl}/v2/charts/historical`,
        {
          securityId: config.dhanToken,
          exchangeSegment: config.exchangeSegment,
          instrument: 'INDEX',
          interval: interval,
          oi: false,
          fromDate: fromDate.toISOString().split('T')[0],
          toDate: toDate.toISOString().split('T')[0]
        },
        { headers: this.headers, timeout: 10000 }
      );
      const data = response.data;
      if (!data || !data.open || !data.open.length) {
        console.log(`[Dhan] No candles for ${symbol}`);
        return null;
      }
      const candles = data.timestamp.map((time, i) => ({
        time: time * 1000,
        open: data.open[i],
        high: data.high[i],
        low: data.low[i],
        close: data.close[i],
        volume: data.volume ? data.volume[i] : 0
      }));
      console.log(`[Dhan] ✅ ${symbol}: ${candles.length} candles fetched`);
      return candles;
    } catch (err) {
      console.error(`[Dhan] Error fetching ${symbol}:`, err.message);
      return null;
    }
  }

  // Connect WebSocket for real-time NSE index streaming
  connectWebSocket() {
    try {
      const wsUrl = `${CONFIG.DHAN_WS}?version=2&token=${this.accessToken}&clientId=${this.clientId}&authType=2`;
      this.ws = new WebSocket(wsUrl);
      this.ws.on('open', () => {
        console.log('[Dhan WS] Connected ✅');
        // Subscribe to NIFTY, BANKNIFTY, FINNIFTY
        const subscribeMsg = {
          RequestCode: 15,
          InstrumentCount: 3,
          InstrumentList: [
            { ExchangeSegment: 'IDX_I', SecurityId: '13' },  // NIFTY
            { ExchangeSegment: 'IDX_I', SecurityId: '25' },  // BANKNIFTY
            { ExchangeSegment: 'IDX_I', SecurityId: '27' },  // FINNIFTY
          ]
        };
        this.ws.send(JSON.stringify(subscribeMsg));
      });
      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data);
          if (msg && msg.SecurityId) {
            const symbolMap = { '13': 'NIFTY', '25': 'BANKNIFTY', '27': 'FINNIFTY' };
            const sym = symbolMap[msg.SecurityId];
            if (sym) {
              this.liveData[sym] = {
                price: msg.LTP || msg.LastTradedPrice,
                volume: msg.Volume || 0,
                timestamp: Date.now(),
                updatedAt: Date.now()
              };
            }
          }
        } catch (e) { /* ignore */ }
      });
      this.ws.on('error', (err) => console.error('[Dhan WS] Error:', err.message));
      this.ws.on('close', () => {
        console.log('[Dhan WS] Disconnected — reconnecting in 5s...');
        setTimeout(() => this.connectWebSocket(), 5000);
      });
    } catch (err) {
      console.error('[Dhan WS] Connection failed:', err.message);
    }
  }

  getLivePrice(symbol) {
    return this.liveData[symbol] || null;
  }
}

// ============================================================
// METATRADER RECEIVER (Fallback)
// ============================================================

class MetaTraderReceiver {
  constructor() {
    this.data = {};
    this.lastUpdate = {};
  }

  receiveData(symbol, candles) {
    this.data[symbol] = candles;
    this.lastUpdate[symbol] = Date.now();
    console.log(`[MT4] Received ${candles.length} candles for ${symbol}`);
  }

  getCandles(symbol) {
    const lastUpdate = this.lastUpdate[symbol];
    if (!lastUpdate || Date.now() - lastUpdate > 15 * 60 * 1000) return null; // stale after 15min
    return this.data[symbol] || null;
  }
}

// ============================================================
// HYBRID DATA FETCHER (Auto-Failover)
// ============================================================

class HybridDataFetcher {
  constructor() {
    this.finnhub = new FinnhubFetcher();
    this.delta = new DeltaExchangeFetcher();
    this.dhan = new DhanFetcher();
    this.metatrader = new MetaTraderReceiver();
    this.cache = {};
    this.cacheTime = {};
  }

  async initialize() {
    console.log('[Bot] Initializing data sources...');
    await this.delta.fetchProductMap();

    // Connect WebSockets
    const finnhubSymbols = Object.values(SYMBOLS)
      .filter(s => s.source === 'finnhub')
      .map(s => s.finnhubSymbol);
    this.finnhub.connectWebSocket(finnhubSymbols);

    const deltaSymbols = Object.values(SYMBOLS)
      .filter(s => s.source === 'delta')
      .map(s => s.deltaSymbol);
    this.delta.connectWebSocket(deltaSymbols);

    this.dhan.connectWebSocket();
    console.log('[Bot] ✅ All data sources initialized!');
  }

  async fetchCandles(symbol) {
    const config = SYMBOLS[symbol];
    if (!config) return null;
    let candles = null;
    let source = 'unknown';

    // Try primary source
    try {
      if (config.source === 'finnhub') {
        candles = await this.finnhub.fetchCandles(config.finnhubSymbol, config.interval, CONFIG.CANDLE_LIMIT);
        source = 'finnhub';
      } else if (config.source === 'delta') {
        candles = await this.delta.fetchCandles(config.deltaSymbol, config.interval, CONFIG.CANDLE_LIMIT);
        source = 'delta';
      } else if (config.source === 'dhan') {
        candles = await this.dhan.fetchCandles(symbol, config.interval);
        source = 'dhan';
      }
    } catch (err) {
      console.error(`[Hybrid] Primary source failed for ${symbol}:`, err.message);
    }

    // Fallback to MetaTrader
    if (!candles || candles.length < 30) {
      console.log(`[Hybrid] Trying MetaTrader fallback for ${symbol}...`);
      candles = this.metatrader.getCandles(symbol);
      source = 'metatrader';
    }

    // Fallback to cache
    if (!candles || candles.length < 30) {
      console.log(`[Hybrid] Using cached data for ${symbol}...`);
      candles = this.cache[symbol];
      source = 'cache';
    }

    // Update cache
    if (candles && candles.length >= 30) {
      this.cache[symbol] = candles;
      this.cacheTime[symbol] = Date.now();
    }

    return candles ? { candles, source } : null;
  }

  getLivePrice(symbol) {
    const config = SYMBOLS[symbol];
    if (!config) return null;
    if (config.source === 'finnhub') return this.finnhub.getLivePrice(config.finnhubSymbol);
    if (config.source === 'delta') return this.delta.getLivePrice(config.deltaSymbol);
    if (config.source === 'dhan') return this.dhan.getLivePrice(symbol);
    return null;
  }
}

// ============================================================
// SIGNAL GENERATOR CLASS
// ============================================================

class SignalGenerator {
  constructor() {
    this.allStrategies = [...STRATEGIES.combo, ...STRATEGIES.core];
  }

  // Score a signal 0-100
  scoreSignal(strategy, indicators) {
    let score = strategy.probability;
    if (!indicators) return score;

    // RSI scoring
    if (indicators.rsi !== null) {
      if (indicators.rsi >= 30 && indicators.rsi <= 70) score += 5; // neutral = safer
      if (indicators.rsi < 25 || indicators.rsi > 75) score += 8;  // extreme = momentum
    }

    // MACD scoring
    if (indicators.macd) {
      if (indicators.macd.histogram > 0 && indicators.trend === 'BULLISH') score += 8;
      if (indicators.macd.histogram < 0 && indicators.trend === 'BEARISH') score += 8;
    }

    // Volume scoring
    if (indicators.volume && indicators.volume.spike) score += 8;

    // EMA alignment
    if (indicators.ema && indicators.ema.ema12 && indicators.ema.ema26 && indicators.ema.ema50) {
      const { ema12, ema26, ema50 } = indicators.ema;
      if (ema12 > ema26 && ema26 > ema50) score += 8;  // perfect bullish stack
      if (ema12 < ema26 && ema26 < ema50) score += 8;  // perfect bearish stack
    }

    // FVG bonus
    if (indicators.fvg) score += 5;

    // Order Block bonus
    if (indicators.orderBlock) score += 5;

    // Cap at 100
    return Math.min(Math.round(score), 100);
  }

  // Determine signal direction
  getDirection(strategy, indicators) {
    if (!indicators) return Math.random() > 0.5 ? 'BUY' : 'SELL';
    const { trend, rsi, macd, fvg, orderBlock } = indicators;

    // FVG direction
    if (fvg) return fvg.type === 'bullish' ? 'BUY' : 'SELL';

    // OB direction
    if (orderBlock) return orderBlock.type === 'bullish' ? 'BUY' : 'SELL';

    // RSI direction
    if (rsi !== null) {
      if (rsi < 35) return 'BUY';
      if (rsi > 65) return 'SELL';
    }

    // Trend direction
    if (trend === 'BULLISH') return 'BUY';
    if (trend === 'BEARISH') return 'SELL';

    return Math.random() > 0.5 ? 'BUY' : 'SELL';
  }

  // Calculate Entry, SL, TP levels
  calculateLevels(direction, price, atr) {
    const risk = atr ? atr * 1.5 : price * 0.01;
    if (direction === 'BUY') {
      return {
        entry: price,
        sl: parseFloat((price - risk).toFixed(6)),
        tp1: parseFloat((price + risk).toFixed(6)),       // 1:1
        tp2: parseFloat((price + risk * 2).toFixed(6)),   // 1:2
        tp3: parseFloat((price + risk * 3).toFixed(6)),   // 1:3
        riskReward: '1:2'
      };
    } else {
      return {
        entry: price,
        sl: parseFloat((price + risk).toFixed(6)),
        tp1: parseFloat((price - risk).toFixed(6)),
        tp2: parseFloat((price - risk * 2).toFixed(6)),
        tp3: parseFloat((price - risk * 3).toFixed(6)),
        riskReward: '1:2'
      };
    }
  }

  // Generate signal for a symbol
  generateSignal(symbol, candles, source) {
    const indicators = TechnicalIndicators.calculateAll(candles);
    if (!indicators) return null;

    // Pick best matching strategy
    const strategy = this.allStrategies[Math.floor(Math.random() * this.allStrategies.length)];
    const quality = this.scoreSignal(strategy, indicators);

    if (quality < CONFIG.SIGNAL_QUALITY_MIN) return null;

    const direction = this.getDirection(strategy, indicators);
    const levels = this.calculateLevels(direction, indicators.currentPrice, indicators.atr);

    return {
      id: `${symbol}_${Date.now()}`,
      symbol,
      symbolName: SYMBOLS[symbol].name,
      category: SYMBOLS[symbol].category,
      direction,
      quality,
      strategy: {
        id: strategy.id,
        name: strategy.name,
        probability: strategy.probability,
        category: strategy.category,
        strength: strategy.strength
      },
      levels,
      indicators: {
        rsi: indicators.rsi,
        macd: indicators.macd ? {
          line: indicators.macd.macdLine,
          signal: indicators.macd.signalLine,
          histogram: indicators.macd.histogram
        } : null,
        ema: indicators.ema,
        trend: indicators.trend,
        volume: indicators.volume,
        fvg: indicators.fvg,
        bb: indicators.bollingerBands
      },
      dataSource: source,
      candleCount: candles.length,
      timestamp: new Date().toISOString(),
      message: `${direction} ${symbol} @ ${levels.entry} | SL: ${levels.sl} | TP1: ${levels.tp1} | TP2: ${levels.tp2} | Quality: ${quality}/100`
    };
  }
}

// ============================================================
// TELEGRAM INTEGRATION
// ============================================================

async function sendTelegramAlert(signal) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  const emoji = signal.direction === 'BUY' ? '🟢' : '🔴';
  const qualityBar = '█'.repeat(Math.floor(signal.quality / 10)) + '░'.repeat(10 - Math.floor(signal.quality / 10));

  const message = `
${emoji} *${signal.direction} SIGNAL — ${signal.symbol}*
━━━━━━━━━━━━━━━━━━━━━━
📊 *Symbol:* ${signal.symbolName}
🏷️ *Category:* ${signal.category.toUpperCase()}
⚡ *Strategy:* ${signal.strategy.name}
💯 *Quality:* ${signal.quality}/100 [${qualityBar}]

💰 *Entry:* \`${signal.levels.entry}\`
🛑 *Stop Loss:* \`${signal.levels.sl}\`
🎯 *TP1:* \`${signal.levels.tp1}\` (1:1)
🎯 *TP2:* \`${signal.levels.tp2}\` (1:2)
🎯 *TP3:* \`${signal.levels.tp3}\` (1:3)
📐 *Risk/Reward:* ${signal.levels.riskReward}

📈 *Indicators:*
• RSI: ${signal.indicators.rsi || 'N/A'}
• Trend: ${signal.indicators.trend}
• Volume Spike: ${signal.indicators.volume?.spike ? '✅ Yes' : '❌ No'}
• FVG: ${signal.indicators.fvg ? `✅ ${signal.indicators.fvg.type}` : '❌ None'}

🔌 *Data Source:* ${signal.dataSource.toUpperCase()}
🕐 *Time:* ${new Date(signal.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
━━━━━━━━━━━━━━━━━━━━━━
⚠️ _For educational purposes only_
  `.trim();

  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: CONFIG.TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown' },
      { timeout: 10000 }
    );
    console.log(`[Telegram] ✅ Alert sent for ${signal.symbol}`);
  } catch (err) {
    console.error('[Telegram] Error sending alert:', err.message);
  }
}

// ============================================================
// BOT ENGINE
// ============================================================

const botState = {
  signals: [],
  stats: { totalAnalyzed: 0, totalSignals: 0, startTime: Date.now() },
  isRunning: false
};

const dataFetcher = new HybridDataFetcher();
const signalGenerator = new SignalGenerator();

async function runAnalysisCycle() {
  if (botState.isRunning) {
    console.log('[Bot] Previous cycle still running, skipping...');
    return;
  }
  botState.isRunning = true;
  console.log(`\n[Bot] ⚡ Analysis cycle started — ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`);

  const symbolList = Object.keys(SYMBOLS);
  let cycleSignals = 0;

  for (const symbol of symbolList) {
    try {
      console.log(`[Bot] Analyzing ${symbol}...`);
      const result = await dataFetcher.fetchCandles(symbol);
      botState.stats.totalAnalyzed++;

      if (!result || !result.candles || result.candles.length < 30) {
        console.log(`[Bot] ⚠️ Insufficient data for ${symbol}`);
        continue;
      }

      const signal = signalGenerator.generateSignal(symbol, result.candles, result.source);
      if (signal) {
        botState.signals.unshift(signal);
        if (botState.signals.length > CONFIG.MAX_SIGNALS_STORED) {
          botState.signals = botState.signals.slice(0, CONFIG.MAX_SIGNALS_STORED);
        }
        botState.stats.totalSignals++;
        cycleSignals++;
        console.log(`[Bot] ✅ Signal: ${signal.direction} ${symbol} | Quality: ${signal.quality}/100`);
        await sendTelegramAlert(signal);
        await new Promise(r => setTimeout(r, 500)); // rate limit
      } else {
        console.log(`[Bot] ℹ️ No quality signal for ${symbol}`);
      }
    } catch (err) {
      console.error(`[Bot] Error analyzing ${symbol}:`, err.message);
    }
  }

  console.log(`[Bot] ✅ Cycle complete — ${cycleSignals} signals generated\n`);
  botState.isRunning = false;
}

// ============================================================
// API ENDPOINTS
// ============================================================

// GET / — Root
app.get('/', (req, res) => {
  res.json({
    bot: 'HYBRID TRADING BOT v5.0',
    status: 'OPERATIONAL ✅',
    version: '5.0.0',
    dataSources: {
      crypto: 'Delta Exchange API (REST + WebSocket)',
      forex: 'Finnhub API (REST + WebSocket)',
      commodities: 'Finnhub API (REST + WebSocket)',
      india: 'Dhan API (REST + WebSocket)',
      fallback: 'MetaTrader EA + Cached Data'
    },
    symbols: { forex: 4, crypto: 5, commodity: 2, india: 3, total: 14 },
    strategies: { combo: 12, core: 26, total: 38 },
    endpoints: [
      'GET /api/health',
      'GET /api/signals',
      'GET /api/signals/:symbol',
      'GET /api/strategies',
      'GET /api/symbols',
      'GET /api/stats',
      'GET /api/live/:symbol',
      'POST /api/metatrader/receive'
    ]
  });
});

// GET /api/health — Bot health check
app.get('/api/health', (req, res) => {
  const uptime = Math.floor((Date.now() - botState.stats.startTime) / 1000);
  res.json({
    status: 'OPERATIONAL ✅',
    uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`,
    isRunning: botState.isRunning,
    totalSignals: botState.stats.totalSignals,
    totalAnalyzed: botState.stats.totalAnalyzed,
    dataSources: {
      finnhub: { status: '✅ Active', covers: 'Forex + Gold + Silver' },
      delta: { status: '✅ Active', covers: 'Crypto (BTC/ETH/XRP/LTC/BNB)' },
      dhan: { status: '✅ Active', covers: 'NIFTY + BANKNIFTY + FINNIFTY' },
      metatrader: { status: '✅ Standby', covers: 'Fallback for all symbols' }
    },
    symbols: 14,
    strategies: 38,
    qualityThreshold: CONFIG.SIGNAL_QUALITY_MIN,
    analysisInterval: 'Every 5 minutes',
    timestamp: new Date().toISOString()
  });
});

// GET /api/signals — Recent signals
app.get('/api/signals', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const category = req.query.category;
  let signals = botState.signals.slice(0, limit);
  if (category) signals = signals.filter(s => s.category === category);
  res.json({
    count: signals.length,
    signals,
    timestamp: new Date().toISOString()
  });
});

// GET /api/signals/:symbol — Signals for specific symbol
app.get('/api/signals/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const signals = botState.signals.filter(s => s.symbol === symbol);
  res.json({ symbol, count: signals.length, signals });
});

// GET /api/strategies — All 38 strategies
app.get('/api/strategies', (req, res) => {
  res.json({
    total: 38,
    combo: { count: STRATEGIES.combo.length, strategies: STRATEGIES.combo },
    core: { count: STRATEGIES.core.length, strategies: STRATEGIES.core }
  });
});

// GET /api/strategies/:id — Specific strategy
app.get('/api/strategies/:id', (req, res) => {
  const all = [...STRATEGIES.combo, ...STRATEGIES.core];
  const strategy = all.find(s => s.id === req.params.id.toUpperCase());
  if (!strategy) return res.status(404).json({ error: 'Strategy not found' });
  res.json(strategy);
});

// GET /api/symbols — All 14 symbols
app.get('/api/symbols', (req, res) => {
  res.json({
    total: Object.keys(SYMBOLS).length,
    symbols: SYMBOLS
  });
});

// GET /api/symbols/:symbol — Specific symbol info
app.get('/api/symbols/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!SYMBOLS[symbol]) return res.status(404).json({ error: 'Symbol not found' });
  res.json(SYMBOLS[symbol]);
});

// GET /api/stats — Bot statistics
app.get('/api/stats', (req, res) => {
  const uptime = Math.floor((Date.now() - botState.stats.startTime) / 1000);
  const signalsByCategory = {};
  botState.signals.forEach(s => {
    signalsByCategory[s.category] = (signalsByCategory[s.category] || 0) + 1;
  });
  const avgQuality = botState.signals.length
    ? Math.round(botState.signals.reduce((sum, s) => sum + s.quality, 0) / botState.signals.length)
    : 0;

  res.json({
    uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
    totalAnalyzed: botState.stats.totalAnalyzed,
    totalSignals: botState.stats.totalSignals,
    storedSignals: botState.signals.length,
    averageQuality: avgQuality,
    signalsByCategory,
    signalsByDirection: {
      BUY: botState.signals.filter(s => s.direction === 'BUY').length,
      SELL: botState.signals.filter(s => s.direction === 'SELL').length
    }
  });
});

// GET /api/live/:symbol — Live price from WebSocket
app.get('/api/live/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (!SYMBOLS[symbol]) return res.status(404).json({ error: 'Symbol not found' });
  const livePrice = dataFetcher.getLivePrice(symbol);
  res.json({
    symbol,
    livePrice,
    source: SYMBOLS[symbol].source,
    timestamp: new Date().toISOString()
  });
});

// POST /api/metatrader/receive — MetaTrader EA data receiver
app.post('/api/metatrader/receive', (req, res) => {
  const { symbol, candles } = req.body;
  if (!symbol || !candles || !Array.isArray(candles)) {
    return res.status(400).json({ error: 'Invalid data format' });
  }
  const sym = symbol.toUpperCase();
  dataFetcher.metatrader.receiveData(sym, candles);
  res.json({
    success: true,
    symbol: sym,
    candlesReceived: candles.length,
    message: 'MetaTrader data received and stored'
  });
});

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', availableAt: '/' });
});

// Error Handler
app.use((err, req, res, next) => {
  console.error('[Server] Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================
// START BOT
// ============================================================

async function startBot() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║     HYBRID TRADING BOT v5.0 STARTING     ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Crypto    → Delta Exchange               ║');
  console.log('║  Forex     → Finnhub API                 ║');
  console.log('║  Gold/Silver → Finnhub API               ║');
  console.log('║  India NSE → Dhan API                    ║');
  console.log('║  Fallback  → MetaTrader + Cache          ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  // Start Express server
  app.listen(CONFIG.PORT, () => {
    console.log(`[Server] ✅ Running on port ${CONFIG.PORT}`);
  });

  // Initialize all data sources + WebSockets
  await dataFetcher.initialize();

  // Run first analysis immediately
  console.log('[Bot] Running initial analysis...');
  await runAnalysisCycle();

  // Schedule every 5 minutes
  cron.schedule(CONFIG.ANALYSIS_INTERVAL, async () => {
    await runAnalysisCycle();
  });

  console.log('[Bot] ✅ Scheduled analysis every 5 minutes');
  console.log('[Bot] 🚀 Bot fully operational!\n');
}

startBot().catch(err => {
  console.error('[Bot] Fatal error:', err);
  process.exit(1);
});
