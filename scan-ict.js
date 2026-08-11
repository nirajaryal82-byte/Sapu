/**
 * ICT Gold AI — 24/7 Multi-Strategy Scanner (Vercel Serverless + Cron)
 * QUALITY BALANCED: More high-accuracy signals without flooding low-quality setups
 *
 * PRIMARY ENTRY STRATEGIES
 *  1. Strict ICT / Market Maker   (weight 25)
 *  2. Silver Bullet               (weight 22)
 *  3. Turtle Soup                 (weight 19)
 *  4. Breaker Block               (weight 16)
 *  5. OTE Pullback                (weight 14)
 *
 * CONFIRMATION / FILTER STRATEGIES
 *  6. CISD                        (weight 10)
 *  7. Unicorn Model               (weight 7)
 *  8. Liquidity Sweep / Raid      (weight 6)
 *  9. Judas Swing                 (weight 3)
 * 10. London Reversal             (weight 2)
 * 11. FVG Continuation            (bonus max 2 — NEVER standalone signal)
 *
 * Flow: 4H → 1H → 15M → 5M → 1M
 * Confidence 0–100. Quality Balanced signals require ≥62. Auto execution remains ≥70.
 * Same market event is deduplicated into ONE signal with primary + confirmations.
 *
 * Env vars (recommended):
 *   TWELVE_DATA_KEY, TWELVE_DATA_KEY_2, TWELVE_DATA_KEY_3   (or TWELVE_DATA_KEYS=key1,key2,key3)
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
 *   NTFY_TOPIC, FCM_SERVER_KEY, FIREBASE_RTDB_URL,
 *   MIN_SIGNAL_PROB (default 90 for strict),
 *   STRATEGY_MODE = "strict" | "multi" | "balanced" | "aggressive"  (default "balanced")
 *
 * Schedule: every 5 minutes via vercel.json crons
 *
 * Multi-key rotation: if one Twelve Data key fails (rate-limit, invalid, no data),
 * automatically tries the next available key.
 */
const FCM_SERVER_KEY = process.env.FCM_SERVER_KEY || "";
const RTDB =
  process.env.FIREBASE_RTDB_URL ||
  "https://ict-signal-default-rtdb.firebaseio.com";
const PAIR = "XAUUSD";
const LOOKBACK = 120;
const PIVOT = 2;

// Strategy mode: strict = original high-bar only | multi = all models | aggressive = lower thresholds
const STRATEGY_MODE = (process.env.STRATEGY_MODE || "balanced").toLowerCase();
const MIN_PROB_STRICT = Number(process.env.MIN_SIGNAL_PROB || 90);
const MIN_PROB_MULTI = Number(process.env.MIN_SIGNAL_PROB_MULTI || 62);
const MIN_PROB_BALANCED = Number(process.env.MIN_SIGNAL_PROB_BALANCED || 62);
const MIN_PROB_AGGRESSIVE = Number(process.env.MIN_SIGNAL_PROB_AGGRESSIVE || 50);

/** Collect up to 3+ Twelve Data API keys for automatic rotation */
function collectTdKeys(remote = {}) {
  const keys = [];
  const add = (k) => {
    const v = (k || "").trim();
    if (v && v.length > 8 && !keys.includes(v)) keys.push(v);
  };

  // From remote config (Firebase / saved)
  add(remote.twelveDataKey);
  add(remote.twelveDataKey2);
  add(remote.twelveDataKey3);
  if (remote.twelveDataKeys) {
    String(remote.twelveDataKeys)
      .split(/[,;\s]+/)
      .forEach(add);
  }

  // From environment (preferred for Vercel)
  add(process.env.TWELVE_DATA_KEY);
  add(process.env.TWELVE_DATA_KEY_2);
  add(process.env.TWELVE_DATA_KEY_3);
  add(process.env.TD_KEY);
  if (process.env.TWELVE_DATA_KEYS) {
    process.env.TWELVE_DATA_KEYS.split(/[,;\s]+/).forEach(add);
  }

  return keys;
}

async function getBlobStore() {
  // Netlify Blobs not available on Vercel — always null
  return null;
}

/** Load keys: RTDB → env vars (multi-key support) */
async function loadServerConfig() {
  let remote = {};
  try {
    const res = await fetch(RTDB.replace(/\/$/, "") + "/serverConfig.json", {
      headers: { Accept: "application/json" }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === "object") remote = data;
    }
  } catch (e) {}

  const tdKeys = collectTdKeys(remote);

  const kzRaw = (
    remote.killZoneFilter ||
    process.env.KILL_ZONE_FILTER ||
    "both"
  )
    .toString()
    .trim()
    .toLowerCase();
  const kzFilter =
    kzRaw === "inside" || kzRaw === "outside" || kzRaw === "both" ? kzRaw : "both";

  return {
    TD_KEYS: tdKeys,
    TD_KEY: tdKeys[0] || "", // primary for compatibility
    TG_TOKEN:
      (remote.telegramBotToken || "").trim() ||
      (process.env.TELEGRAM_BOT_TOKEN || "").trim(),
    TG_CHAT:
      (remote.telegramChatId || "").trim() ||
      (process.env.TELEGRAM_CHAT_ID || "").trim(),
    NTFY_TOPIC:
      (remote.ntfyTopic || "").trim() ||
      (process.env.NTFY_TOPIC || "").trim(),
    // Prefer UI-saved RTDB mode over env so Profile "Save" actually controls 24/7 scans
    MODE: (
      (remote.strategyMode && String(remote.strategyMode).trim()) ||
      STRATEGY_MODE ||
      "balanced"
    ).toLowerCase(),
    KZ_FILTER: kzFilter
  };
}

const TF_MAP = {
  h4: "4h",
  h1: "1h",
  m15: "15min",
  m5: "5min",
  m1: "1min"
};

/* ---------- helpers ---------- */
function bodySize(c) {
  return Math.abs(c.close - c.open);
}
function rangeSize(c) {
  return c.high - c.low;
}
function isBull(c) {
  return c.close > c.open;
}
function isBear(c) {
  return c.close < c.open;
}

function isDisplacement(candles, i, lookback) {
  if (i < 1) return false;
  const c = candles[i];
  const body = bodySize(c);
  const rng = rangeSize(c);
  if (rng <= 0 || body / rng < 0.55) return false;
  lookback = lookback || 14;
  let sum = 0,
    n = 0;
  for (let k = Math.max(0, i - lookback); k < i; k++) {
    sum += rangeSize(candles[k]);
    n++;
  }
  const avg = n ? sum / n : rng;
  return body >= avg * 1.35;
}

function pivots(candles, left, right) {
  left = left || PIVOT;
  right = right || PIVOT;
  const highs = [],
    lows = [];
  for (let i = left; i < candles.length - right; i++) {
    let hi = true,
      lo = true;
    for (let j = 1; j <= left; j++) {
      if (candles[i].high <= candles[i - j].high) hi = false;
      if (candles[i].low >= candles[i - j].low) lo = false;
    }
    for (let j = 1; j <= right; j++) {
      if (candles[i].high < candles[i + j].high) hi = false;
      if (candles[i].low > candles[i + j].low) lo = false;
    }
    if (hi) highs.push({ i, price: candles[i].high, time: candles[i].time });
    if (lo) lows.push({ i, price: candles[i].low, time: candles[i].time });
  }
  return { highs, lows };
}

function structure(candles) {
  const p = pivots(candles);
  const last = candles[candles.length - 1];
  const lastIdx = candles.length - 1;
  const sh = p.highs[p.highs.length - 1];
  const sl = p.lows[p.lows.length - 1];
  const prevH = p.highs[p.highs.length - 2];
  const prevL = p.lows[p.lows.length - 2];

  let swingTrend = "WAIT";
  if (sh && prevH && sl && prevL) {
    const hh = sh.price > prevH.price;
    const hl = sl.price > prevL.price;
    const lh = sh.price < prevH.price;
    const ll = sl.price < prevL.price;
    if (hh && hl) swingTrend = "BUY";
    else if (lh && ll) swingTrend = "SELL";
  }

  let bullDisp = false,
    bearDisp = false;
  for (let i = Math.max(1, lastIdx - 6); i <= lastIdx; i++) {
    if (isDisplacement(candles, i) && isBull(candles[i])) bullDisp = true;
    if (isDisplacement(candles, i) && isBear(candles[i])) bearDisp = true;
  }

  const bullishBOS = !!(sh && last.close > sh.price && bullDisp);
  const bearishBOS = !!(sl && last.close < sl.price && bearDisp);

  let chochBull = false,
    chochBear = false;
  if (swingTrend === "SELL" && sh && last.close > sh.price && bullDisp)
    chochBull = true;
  if (swingTrend === "BUY" && sl && last.close < sl.price && bearDisp)
    chochBear = true;
  if (sl && last.close > sl.price && bullDisp && !bullishBOS) {
    if (prevL && sl.price < prevL.price) chochBull = true;
  }
  if (sh && last.close < sh.price && bearDisp && !bearishBOS) {
    if (prevH && sh.price > prevH.price) chochBear = true;
  }

  let trend = swingTrend;
  if (bullishBOS || chochBull) trend = "BUY";
  if (bearishBOS || chochBear) trend = "SELL";

  return {
    trend,
    swingTrend,
    bullishBOS,
    bearishBOS,
    chochBull,
    chochBear,
    bullDisp,
    bearDisp,
    sh,
    sl,
    pivots: p
  };
}

function liquiditySweep(candles) {
  const p = pivots(candles);
  const n = candles.length;
  const recentLows = p.lows.slice(-8).filter((x) => x.i < n - 2);
  const recentHighs = p.highs.slice(-8).filter((x) => x.i < n - 2);
  const sweepLook = Math.min(8, n - 1);

  let bullSweep = null;
  for (const lvl of recentLows.slice().reverse()) {
    for (let bi = 0; bi < sweepLook && !bullSweep; bi++) {
      const c = candles[n - 1 - bi];
      if (c.low < lvl.price && c.close > lvl.price) {
        bullSweep = { type: "sellside", level: lvl, candle: c };
        break;
      }
    }
    if (bullSweep) break;
  }

  let bearSweep = null;
  for (const lvl of recentHighs.slice().reverse()) {
    for (let bi = 0; bi < sweepLook && !bearSweep; bi++) {
      const c = candles[n - 1 - bi];
      if (c.high > lvl.price && c.close < lvl.price) {
        bearSweep = { type: "buyside", level: lvl, candle: c };
        break;
      }
    }
    if (bearSweep) break;
  }

  let sessHigh = -Infinity,
    sessLow = Infinity;
  const look = Math.min(48, n);
  for (let i = n - look; i < n; i++) {
    if (candles[i].high > sessHigh) sessHigh = candles[i].high;
    if (candles[i].low < sessLow) sessLow = candles[i].low;
  }

  return {
    bull: !!bullSweep,
    bear: !!bearSweep,
    bullSweep,
    bearSweep,
    low: bullSweep ? bullSweep.level : recentLows[recentLows.length - 1],
    high: bearSweep ? bearSweep.level : recentHighs[recentHighs.length - 1],
    sessHigh,
    sessLow
  };
}

function fvg(candles) {
  const out = [];
  const n = candles.length;
  for (let i = 2; i < n; i++) {
    const a = candles[i - 2],
      c = candles[i];
    if (c.low > a.high) {
      const gap = {
        dir: "buy",
        low: a.high,
        high: c.low,
        mid: (a.high + c.low) / 2,
        i,
        mitigated: false
      };
      for (let k = i + 1; k < n; k++) {
        if (candles[k].low <= gap.low) {
          gap.mitigated = true;
          break;
        }
      }
      out.push(gap);
    }
    if (c.high < a.low) {
      const gap = {
        dir: "sell",
        low: c.high,
        high: a.low,
        mid: (c.high + a.low) / 2,
        i,
        mitigated: false
      };
      for (let k = i + 1; k < n; k++) {
        if (candles[k].high >= gap.high) {
          gap.mitigated = true;
          break;
        }
      }
      out.push(gap);
    }
  }
  return out.filter((x) => x.i >= n - 40).slice(-12);
}

function orderBlocks(candles) {
  const out = [];
  const n = candles.length;
  for (let i = 3; i < n; i++) {
    if (!isDisplacement(candles, i)) continue;
    if (isBull(candles[i])) {
      for (let k = i - 1; k >= Math.max(0, i - 6); k--) {
        if (isBear(candles[k])) {
          const ob = {
            dir: "buy",
            low: candles[k].low,
            high: candles[k].high,
            i: k,
            mitigated: false
          };
          for (let m = i + 1; m < n; m++) {
            if (candles[m].low < ob.low) {
              ob.mitigated = true;
              break;
            }
          }
          out.push(ob);
          break;
        }
      }
    }
    if (isBear(candles[i])) {
      for (let k = i - 1; k >= Math.max(0, i - 6); k--) {
        if (isBull(candles[k])) {
          const ob = {
            dir: "sell",
            low: candles[k].low,
            high: candles[k].high,
            i: k,
            mitigated: false
          };
          for (let m = i + 1; m < n; m++) {
            if (candles[m].high > ob.high) {
              ob.mitigated = true;
              break;
            }
          }
          out.push(ob);
          break;
        }
      }
    }
  }
  return out.filter((x) => x.i >= n - 50).slice(-10);
}

/** Detect Breaker Blocks: an OB that was violated (price closed through it) */
function breakerBlocks(candles, obs) {
  const out = [];
  const n = candles.length;
  const lastClose = candles[n - 1].close;
  for (const ob of obs) {
    // Original bullish OB that price later closed below → becomes bearish breaker
    if (ob.dir === "buy" && !ob.mitigated) {
      for (let k = ob.i + 1; k < n; k++) {
        if (candles[k].close < ob.low) {
          out.push({
            dir: "sell",
            low: ob.low,
            high: ob.high,
            i: ob.i,
            type: "breaker",
            originalDir: "buy"
          });
          break;
        }
      }
    }
    // Original bearish OB that price later closed above → becomes bullish breaker
    if (ob.dir === "sell" && !ob.mitigated) {
      for (let k = ob.i + 1; k < n; k++) {
        if (candles[k].close > ob.high) {
          out.push({
            dir: "buy",
            low: ob.low,
            high: ob.high,
            i: ob.i,
            type: "breaker",
            originalDir: "sell"
          });
          break;
        }
      }
    }
  }
  return out.slice(-6);
}

function dealingRange(candles, s) {
  const highs = (s && s.pivots && s.pivots.highs) || pivots(candles).highs;
  const lows = (s && s.pivots && s.pivots.lows) || pivots(candles).lows;
  const useH = highs.slice(-4);
  const useL = lows.slice(-4);
  let high = -Infinity,
    low = Infinity;
  for (const h of useH) if (h.price > high) high = h.price;
  for (const l of useL) if (l.price < low) low = l.price;
  if (!isFinite(high) || !isFinite(low) || high <= low) {
    const slice = candles.slice(-40);
    high = Math.max(...slice.map((c) => c.high));
    low = Math.min(...slice.map((c) => c.low));
  }
  const range = high - low;
  const eq = (high + low) / 2;
  const oteBuyLow = high - range * 0.79;
  const oteBuyHigh = high - range * 0.618;
  const oteSellLow = low + range * 0.618;
  const oteSellHigh = low + range * 0.79;
  return {
    high,
    low,
    eq,
    range,
    oteBuyLow,
    oteBuyHigh,
    oteSellLow,
    oteSellHigh
  };
}

function analyzeTF(candles) {
  const s = structure(candles);
  const liq = liquiditySweep(candles);
  const fvgs = fvg(candles);
  const obs = orderBlocks(candles);
  const breakers = breakerBlocks(candles, obs);
  const dr = dealingRange(candles, s);
  const last = candles[candles.length - 1];
  let pd = "EQ";
  if (last.close < dr.eq) pd = "DISCOUNT";
  else if (last.close > dr.eq) pd = "PREMIUM";
  return { ...s, liq, fvgs, obs, breakers, dr, pd, last, candles };
}

function getSessionInfo(date) {
  const d = date || new Date();
  const day = d.getUTCDay();
  const weekday = day >= 1 && day <= 5;
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  let active = null;
  if (h >= 7 && h < 10) active = { id: "london", name: "London Open" };
  else if (h >= 12 && h < 15) active = { id: "nyam", name: "New York AM" };
  else if (h >= 15 && h < 17) active = { id: "nypm", name: "New York PM" };
  else if (h >= 0 && h < 7) active = { id: "asia", name: "Asian" };
  const inKillZone = !!(active && (active.id === "london" || active.id === "nyam"));
  const inSilverBulletWindow =
    (h >= 12 && h < 13) || (h >= 14 && h < 15) || (h >= 7 && h < 8); // approx 10-11 NY / 2-3 / London
  return { weekday, inKillZone, inSilverBulletWindow, active, hourUTC: h };
}

function inZone(price, z) {
  return price >= z.low && price <= z.high;
}

function inRange(price, lo, hi) {
  return price >= lo && price <= hi;
}

/* ============================================================
   UPGRADED MULTI-STRATEGY ICT SIGNAL ENGINE
   11 strategies · MTF hierarchy · weighted confidence · dedup
   ============================================================ */

const STRATEGY_WEIGHTS = {
  "Strict ICT / Market Maker": 25,
  "Silver Bullet": 22,
  "Turtle Soup": 19,
  "Breaker Block": 16,
  "OTE Pullback": 14,
  "CISD": 10,                 // boosted — strong confirmation
  "Unicorn Model": 7,         // boosted — high-quality confluence
  "Liquidity Sweep / Raid": 6, // slight boost
  "Judas Swing": 3,
  "London Reversal": 2,
  "FVG Continuation": 2
};

const PRIMARY_STRATEGIES = new Set([
  "Strict ICT / Market Maker",
  "Silver Bullet",
  "Turtle Soup",
  "Breaker Block",
  "OTE Pullback"
]);

function buildTradeResult(direction, price, zone, entryTF, refineTF, dr, session, primary, confirmations, score, dig, biases, reason, mode) {
  const entry = price;
  const buffer = Math.max((zone.high - zone.low) * 0.15, price * 0.0002);
  let sl, tp1, tp2, tp3;

  if (direction === "BUY") {
    const sweepLvl = entryTF.liq.bullSweep ? entryTF.liq.bullSweep.level.price : zone.low;
    const swingLow = entryTF.sl ? entryTF.sl.price : zone.low;
    sl = Math.min(zone.low, sweepLvl, swingLow) - buffer;
    const risk = Math.max(entry - sl, price * 0.00035);
    const buySideLiq = entryTF.liq.sessHigh || dr.high;
    tp1 = entry + risk * 2.0;
    tp2 = Math.max(entry + risk * 3.0, buySideLiq * 0.999);
    tp3 = Math.max(entry + risk * 4.0, dr.high);
    if ((tp1 - entry) / risk < 2) tp1 = entry + risk * 2;
  } else {
    const sweepLvl = entryTF.liq.bearSweep ? entryTF.liq.bearSweep.level.price : zone.high;
    const swingHigh = entryTF.sh ? entryTF.sh.price : zone.high;
    sl = Math.max(zone.high, sweepLvl, swingHigh) + buffer;
    const risk = Math.max(sl - entry, price * 0.00035);
    const sellSideLiq = entryTF.liq.sessLow || dr.low;
    tp1 = entry - risk * 2.0;
    tp2 = Math.min(entry - risk * 3.0, sellSideLiq * 1.001);
    tp3 = Math.min(entry - risk * 4.0, dr.low);
    if ((entry - tp1) / risk < 2) tp1 = entry - risk * 2;
  }

  const risk = Math.abs(entry - sl);
  const rr = risk > 0 ? Math.abs(tp1 - entry) / risk : 0;
  if (rr < 1.8) {
    return { trade: false, reason: "R:R below minimum (1:" + rr.toFixed(1) + ")" };
  }

  const confLevel =
    score >= 90 ? "EXTREME / A+" :
    score >= 80 ? "HIGH CONFIDENCE" :
    score >= 70 ? "GOOD SETUP" :
    score >= 60 ? "MODERATE / WATCH" : "NO TRADE";

  return {
    trade: true,
    dir: direction.toLowerCase(),
    direction,
    entry: +entry.toFixed(dig),
    sl: +sl.toFixed(dig),
    tp1: +tp1.toFixed(dig),
    tp2: +tp2.toFixed(dig),
    tp3: +tp3.toFixed(dig),
    rr: +rr.toFixed(2),
    prob: Math.min(98, Math.round(score)),
    confidenceLevel: confLevel,
    model: primary,
    primaryStrategy: primary,
    confirmations: confirmations || [],
    pair: PAIR,
    session: session.active ? session.active.name : (session.inKillZone ? "Kill Zone" : ""),
    mode: mode || STRATEGY_MODE,
    bias4H: biases.h4 || "—",
    bias1H: biases.h1 || "—",
    setupTF: "15M",
    confirmTF: "5M",
    entryTF: "1M/5M",
    reason: reason || (primary + (confirmations && confirmations.length ? " + " + confirmations.join(" + ") : "")),
    at: new Date().toISOString()
  };
}

function detectCISD(entryTF, refineTF, direction) {
  // CISD: strong close in trade direction after displacement / MSS (state of delivery change)
  const c = entryTF.last || refineTF.last;
  if (!c) return false;
  if (direction === "BUY") {
    return isBull(c) && (entryTF.bullDisp || refineTF.bullDisp || entryTF.chochBull || entryTF.bullishBOS);
  }
  return isBear(c) && (entryTF.bearDisp || refineTF.bearDisp || entryTF.chochBear || entryTF.bearishBOS);
}

function detectUnicorn(entryTF, m15, direction, price) {
  // Unicorn: FVG + Order Block confluence in same direction (both unmitigated near price)
  const dirKey = direction === "BUY" ? "buy" : "sell";
  const fvgs = (entryTF.fvgs || []).concat(m15.fvgs || []).filter(x => x.dir === dirKey && !x.mitigated);
  const obs = (entryTF.obs || []).concat(m15.obs || []).filter(x => x.dir === dirKey && !x.mitigated);
  let hasF = false, hasO = false;
  for (const z of fvgs) if (inZone(price, z) || Math.abs(z.mid - price) / price < 0.0015) hasF = true;
  for (const z of obs) if (inZone(price, z) || Math.abs(((z.high + z.low) / 2) - price) / price < 0.0015) hasO = true;
  return hasF && hasO;
}

function detectJudas(session, entryTF, refineTF, direction) {
  // Judas Swing: London / early session false break (liquidity sweep that fails)
  if (!session.active || (session.active.id !== "london" && session.active.id !== "nyam")) return false;
  const liq = entryTF.liq;
  if (direction === "BUY") {
    return !!(liq.bull && liq.bullSweep && entryTF.last && entryTF.last.close > liq.bullSweep.level.price &&
      (entryTF.chochBull || entryTF.bullishBOS || entryTF.bullDisp || refineTF.bullDisp));
  }
  return !!(liq.bear && liq.bearSweep && entryTF.last && entryTF.last.close < liq.bearSweep.level.price &&
    (entryTF.chochBear || entryTF.bearishBOS || entryTF.bearDisp || refineTF.bearDisp));
}

function generateSignal(analyses, price, mode, kzFilter) {
  mode = (mode || STRATEGY_MODE || "multi").toLowerCase();
  kzFilter = (kzFilter || "both").toLowerCase();
  if (kzFilter !== "inside" && kzFilter !== "outside" && kzFilter !== "both") kzFilter = "both";
  const session = getSessionInfo();
  const h4 = analyses.h4, h1 = analyses.h1, m15 = analyses.m15, m5 = analyses.m5, m1 = analyses.m1;

  const dig = 2;
  const entryTF = m5;
  const refineTF = m1;
  const dr = h1.dr.range > 0 ? h1.dr : m15.dr;

  // Manual Kill Zone preference (Profile):
  //  inside  = only when in London / NY AM Kill Zone
  //  outside = only when NOT in Kill Zone
  //  both    = no KZ gate (mode-based defaults still apply for quality)
  const kzOk =
    kzFilter === "both"
      ? true
      : kzFilter === "inside"
        ? !!session.inKillZone
        : !session.inKillZone;

  let minProb = MIN_PROB_MULTI;
  if (mode === "strict") minProb = MIN_PROB_STRICT;
  if (mode === "balanced") minProb = MIN_PROB_BALANCED;
  if (mode === "aggressive") minProb = MIN_PROB_AGGRESSIVE;
  // Quality Balanced (≥62): more high-accuracy signals via smarter gates + boosted confirmations.
  // Strict remains high-selectivity. Auto-execution is separately gated in the frontend (≥70).
  minProb = Math.max(minProb, mode === "strict" ? 70 : 50);

  const biases = {
    h4: h4.trend || "WAIT",
    h1: h1.trend || "WAIT",
    m15: m15.trend || "WAIT",
    m5: m5.trend || "WAIT"
  };

  // HTF directional context
  let htfDirection = null;
  if (h4.trend === "BUY" || h4.trend === "SELL") htfDirection = h4.trend;
  if (h1.trend === "BUY" || h1.trend === "SELL") {
    if (!htfDirection) htfDirection = h1.trend;
    else if (htfDirection !== h1.trend) {
      // Strong conflict 4H vs 1H → heavily penalize later
      htfDirection = "CONFLICT";
    }
  }

  // Collect evidence for BUY and SELL separately
  function collectEvidence(direction) {
    const evidence = { primary: null, primaries: [], confirmations: [], score: 0, zone: null, tags: [], usedSweep: false };

    const dirKey = direction === "BUY" ? "buy" : "sell";
    const inDiscount = price <= dr.eq;
    const inPremium = price >= dr.eq;
    const arrayOk = (direction === "BUY" && inDiscount) || (direction === "SELL" && inPremium);
    const inOTE = direction === "BUY"
      ? inRange(price, dr.oteBuyLow, dr.oteBuyHigh)
      : inRange(price, dr.oteSellLow, dr.oteSellHigh);

    const sweepOk = direction === "BUY"
      ? (entryTF.liq.bull || refineTF.liq.bull || m15.liq.bull)
      : (entryTF.liq.bear || refineTF.liq.bear || m15.liq.bear);
    const mssOk = direction === "BUY"
      ? (entryTF.chochBull || entryTF.bullishBOS || refineTF.chochBull || refineTF.bullishBOS || m15.chochBull || m15.bullishBOS)
      : (entryTF.chochBear || entryTF.bearishBOS || refineTF.chochBear || refineTF.bearishBOS || m15.chochBear || m15.bearishBOS);
    const dispOk = direction === "BUY"
      ? (entryTF.bullDisp || refineTF.bullDisp || m15.bullDisp)
      : (entryTF.bearDisp || refineTF.bearDisp || m15.bearDisp);

    // Zone finder
    const fvgs = (entryTF.fvgs || []).concat(m15.fvgs || []).filter(x => x.dir === dirKey && !x.mitigated);
    const obs = (entryTF.obs || []).concat(m15.obs || []).filter(x => x.dir === dirKey && !x.mitigated);
    const breakers = (entryTF.breakers || []).concat(m15.breakers || []).filter(x => x.dir === dirKey);
    let zoneF = null, zoneO = null, zoneB = null;
    for (const z of fvgs.slice().reverse()) if (inZone(price, z)) { zoneF = z; break; }
    for (const z of obs.slice().reverse()) if (inZone(price, z)) { zoneO = z; break; }
    for (const z of breakers.slice().reverse()) if (inZone(price, z)) { zoneB = z; break; }

    const entryCandle = entryTF.last || refineTF.last;
    const candleOk = entryCandle && ((direction === "BUY" && isBull(entryCandle)) || (direction === "SELL" && isBear(entryCandle)));

    // --- PRIMARY: Strict ICT / Market Maker ---
    // Kill Zone gate: Profile killZoneFilter (inside/outside/both) is authoritative.
    // When filter is "both", multi/aggressive still allow outside KZ; strict/balanced prefer KZ.
    const balanced = mode === "balanced" || mode === "aggressive";
    const allowOutsideKZ =
      kzFilter === "both" && (mode === "multi" || mode === "aggressive");
    const sessionOkStrict =
      kzFilter === "inside"
        ? session.inKillZone
        : kzFilter === "outside"
          ? !session.inKillZone
          : session.inKillZone || allowOutsideKZ;
    const htfAligned = (h4.trend === direction && h1.trend === direction);
    const htfAtLeastOne = (h4.trend === direction || h1.trend === direction);
    if (session.weekday && sessionOkStrict &&
        (balanced ? htfAtLeastOne : htfAligned) &&
        (m15.trend === direction || m15.trend === "WAIT") &&
        sweepOk && mssOk && (balanced ? (dispOk || candleOk) : dispOk) &&
        arrayOk && (zoneF || zoneO) && candleOk) {
      evidence.primaries.push("Strict ICT / Market Maker");
      if (!evidence.primary) evidence.primary = "Strict ICT / Market Maker";
      evidence.score += STRATEGY_WEIGHTS["Strict ICT / Market Maker"];
      evidence.zone = zoneF || zoneO;
      evidence.tags.push("Strict ICT");
      evidence.usedSweep = true;
    }

    // --- PRIMARY: Silver Bullet ---
    // Quality Balanced: allow FVG or OB zone, and accept MSS or displacement
    // Profile killZoneFilter controls inside/outside/both; SB windows still help when "both"
    const sessionOkSB =
      kzFilter === "inside"
        ? session.inKillZone || session.inSilverBulletWindow
        : kzFilter === "outside"
          ? !session.inKillZone
          : session.inKillZone ||
            session.inSilverBulletWindow ||
            allowOutsideKZ ||
            (balanced &&
              session.active &&
              (session.active.id === "london" || session.active.id === "nyam"));
    if (session.weekday && sessionOkSB &&
        (h1.trend === direction || m15.trend === direction) &&
        sweepOk && (balanced ? (mssOk || dispOk) : mssOk) && (zoneF || zoneO) && candleOk) {
      evidence.primaries.push("Silver Bullet");
      if (!evidence.primary) evidence.primary = "Silver Bullet";
      evidence.score += STRATEGY_WEIGHTS["Silver Bullet"];
      if (!evidence.zone) evidence.zone = zoneF || zoneO;
      evidence.tags.push("Silver Bullet");
      evidence.usedSweep = true;
    }

    // --- PRIMARY: Turtle Soup ---
    {
      const liq = entryTF.liq;
      let tsOk = false;
      if (direction === "BUY" && liq.bull && liq.bullSweep) {
        const lvl = liq.bullSweep.level.price;
        if (entryTF.last && entryTF.last.close > lvl && (entryTF.chochBull || entryTF.bullishBOS || entryTF.bullDisp || refineTF.bullDisp)) tsOk = true;
      }
      if (direction === "SELL" && liq.bear && liq.bearSweep) {
        const lvl = liq.bearSweep.level.price;
        if (entryTF.last && entryTF.last.close < lvl && (entryTF.chochBear || entryTF.bearishBOS || entryTF.bearDisp || refineTF.bearDisp)) tsOk = true;
      }
      if (tsOk && session.weekday && kzOk) {
        evidence.primaries.push("Turtle Soup");
        if (!evidence.primary) evidence.primary = "Turtle Soup";
        evidence.score += STRATEGY_WEIGHTS["Turtle Soup"];
        if (!evidence.zone) {
          const lvl = direction === "BUY" ? liq.bullSweep.level.price : liq.bearSweep.level.price;
          evidence.zone = direction === "BUY"
            ? { low: lvl - price * 0.0004, high: lvl + price * 0.0002 }
            : { low: lvl - price * 0.0002, high: lvl + price * 0.0004 };
        }
        evidence.tags.push("Turtle Soup");
        evidence.usedSweep = true;
      }
    }

    // --- PRIMARY: Breaker Block ---
    if (session.weekday && kzOk && zoneB && (balanced ? (candleOk || dispOk) : candleOk) && (mssOk || dispOk)) {
      evidence.primaries.push("Breaker Block");
      if (!evidence.primary) evidence.primary = "Breaker Block";
      evidence.score += STRATEGY_WEIGHTS["Breaker Block"];
      if (!evidence.zone) evidence.zone = zoneB;
      evidence.tags.push("Breaker Block");
    }

    // --- PRIMARY: OTE Pullback ---
    if (session.weekday && kzOk && (h1.trend === direction || m15.trend === direction) &&
        (balanced ? (dispOk || mssOk) : dispOk) && inOTE && candleOk) {
      evidence.primaries.push("OTE Pullback");
      if (!evidence.primary) evidence.primary = "OTE Pullback";
      evidence.score += STRATEGY_WEIGHTS["OTE Pullback"];
      if (!evidence.zone) {
        evidence.zone = zoneF || zoneO || (direction === "BUY"
          ? { low: dr.oteBuyLow, high: dr.oteBuyHigh }
          : { low: dr.oteSellLow, high: dr.oteSellHigh });
      }
      evidence.tags.push("OTE");
    }

    // Must have at least one primary for a trade
    if (!evidence.primary) return evidence;

    // --- CONFIRMATIONS (do not double-count the same sweep event) ---

    // CISD
    if (detectCISD(entryTF, refineTF, direction)) {
      evidence.confirmations.push("CISD");
      evidence.score += STRATEGY_WEIGHTS["CISD"];
      evidence.tags.push("CISD");
    }

    // Unicorn
    if (detectUnicorn(entryTF, m15, direction, price)) {
      evidence.confirmations.push("Unicorn Model");
      evidence.score += STRATEGY_WEIGHTS["Unicorn Model"];
      evidence.tags.push("Unicorn");
    }

    // Liquidity Sweep / Raid (only if not already used by primary)
    if (sweepOk && !evidence.usedSweep) {
      evidence.confirmations.push("Liquidity Sweep / Raid");
      evidence.score += STRATEGY_WEIGHTS["Liquidity Sweep / Raid"];
      evidence.tags.push("Liquidity Sweep");
    } else if (sweepOk && evidence.usedSweep) {
      // already counted inside primary — small bonus only
      evidence.score += 1;
      evidence.tags.push("Liquidity Sweep");
    }

    // Judas Swing
    if (detectJudas(session, entryTF, refineTF, direction)) {
      evidence.confirmations.push("Judas Swing");
      evidence.score += STRATEGY_WEIGHTS["Judas Swing"];
      evidence.tags.push("Judas Swing");
    }

    // London Reversal (session-specific confirmation)
    if (session.active && session.active.id === "london" && sweepOk && mssOk) {
      evidence.confirmations.push("London Reversal");
      evidence.score += STRATEGY_WEIGHTS["London Reversal"];
      evidence.tags.push("London Reversal");
    }

    // FVG Continuation — bonus only, never standalone (already enforced by primary requirement)
    if (zoneF && (h1.trend === direction || m15.trend === direction)) {
      evidence.confirmations.push("FVG Continuation");
      evidence.score += Math.min(2, STRATEGY_WEIGHTS["FVG Continuation"]);
      evidence.tags.push("FVG");
    }

    // HTF alignment bonus / penalty (boosted for Quality Balanced — multi-TF confluence scores higher)
    if (h4.trend === direction && h1.trend === direction) evidence.score += 10;
    else if (h1.trend === direction) evidence.score += 5;
    else if (htfDirection === "CONFLICT") evidence.score -= 15;
    else if (h4.trend && h4.trend !== "WAIT" && h4.trend !== direction) evidence.score -= 10;

    if (m15.trend === direction) evidence.score += 4;
    if (session.inKillZone) evidence.score += 4;
    if (arrayOk) evidence.score += 3;
    if (inOTE) evidence.score += 3;

    // Extra quality bonus when multiple confirmations stack
    if (evidence.confirmations.length >= 2) evidence.score += 3;
    if (evidence.confirmations.length >= 3) evidence.score += 2;

    evidence.score = Math.max(0, Math.min(98, evidence.score));
    return evidence;
  }

  // Evaluate both directions
  const buyEv = collectEvidence("BUY");
  const sellEv = collectEvidence("SELL");

  // Prefer the higher-scoring side that has a primary
  let best = null;
  let bestDir = null;
  if (buyEv.primary && sellEv.primary) {
    if (buyEv.score >= sellEv.score) { best = buyEv; bestDir = "BUY"; }
    else { best = sellEv; bestDir = "SELL"; }
  } else if (buyEv.primary) { best = buyEv; bestDir = "BUY"; }
  else if (sellEv.primary) { best = sellEv; bestDir = "SELL"; }

  if (!best || !best.primary || !best.zone) {
    return {
      trade: false,
      reason: "No Quality Balanced ICT setup met the active 11-strategy filters"
    };
  }

  if (best.score < minProb) {
    return {
      trade: false,
      reason: "Confidence " + Math.round(best.score) + " below " + minProb + " in " + mode + " mode"
    };
  }

  // Strict mode: only allow Strict ICT primary
  if (mode === "strict" && best.primary !== "Strict ICT / Market Maker") {
    return { trade: false, reason: "Strict mode: only Strict ICT / Market Maker allowed" };
  }

  const reasonParts = [
    best.primary,
    best.confirmations.length ? "Confirmations: " + best.confirmations.join(", ") : null,
    "4H " + biases.h4 + " / 1H " + biases.h1,
    session.active ? session.active.name : null
  ].filter(Boolean);

  return buildTradeResult(
    bestDir,
    price,
    best.zone,
    entryTF,
    refineTF,
    dr,
    session,
    best.primary,
    best.confirmations,
    best.score,
    dig,
    biases,
    reasonParts.join(" · "),
    mode
  );
}

/* ---------- data fetch (with multi-key rotation) ---------- */
async function fetchTF(tf, TD_KEY) {
  const interval = TF_MAP[tf];
  const url =
    "https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=" +
    interval +
    "&outputsize=" +
    LOOKBACK +
    "&apikey=" +
    encodeURIComponent(TD_KEY);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const j = await res.json();
  if (!j || !j.values || !Array.isArray(j.values)) {
    const msg = (j && (j.message || j.status || j.code)) || "no data";
    const err = new Error("Twelve Data " + tf + ": " + msg);
    err.raw = j;
    err.isRateLimit =
      /rate|limit|quota|exceeded|credits|api key/i.test(String(msg)) ||
      res.status === 429 ||
      (j && (j.code === 429 || j.status === "error"));
    err.isInvalidKey = /invalid|api key|unauthorized|forbidden/i.test(String(msg));
    throw err;
  }
  const candles = j.values
    .map((v) => ({
      time: Date.parse(v.datetime) || 0,
      open: +v.open,
      high: +v.high,
      low: +v.low,
      close: +v.close
    }))
    .filter((c) => isFinite(c.close))
    .reverse();
  return candles;
}

/** Load all timeframes. Tries each API key in order until one succeeds. */
async function loadAllWithRotation(keys) {
  if (!keys || keys.length === 0) {
    throw new Error(
      "No Twelve Data API keys configured. Set TWELVE_DATA_KEY, TWELVE_DATA_KEY_2, TWELVE_DATA_KEY_3 (or TWELVE_DATA_KEYS) in Vercel Environment Variables."
    );
  }

  const tfs = ["h4", "h1", "m15", "m5", "m1"];
  let lastError = null;
  const tried = [];

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const masked = key.slice(0, 6) + "…" + key.slice(-4);
    try {
      const results = await Promise.all(tfs.map((tf) => fetchTF(tf, key)));
      const out = {};
      tfs.forEach((tf, idx) => {
        out[tf] = results[idx];
      });
      // Basic validation
      for (const tf of tfs) {
        if (!out[tf] || out[tf].length < 20) {
          throw new Error("Insufficient " + tf + " candles with key " + masked);
        }
      }
      return {
        data: out,
        usedKeyIndex: i,
        usedKeyMasked: masked,
        totalKeys: keys.length
      };
    } catch (e) {
      lastError = e;
      tried.push({ key: masked, error: e.message });
      console.warn(
        "[scan-ict] Twelve Data key #" + (i + 1) + " (" + masked + ") failed: " + e.message
      );
      // Continue to next key on any failure (rate limit, invalid, network, empty)
    }
  }

  const detail = tried.map((t) => t.key + ": " + t.error).join(" | ");
  throw new Error(
    "All " + keys.length + " Twelve Data key(s) failed. " + (lastError ? lastError.message : "") + " Details: " + detail
  );
}

/** Compatibility wrapper */
async function loadAll(TD_KEY) {
  const result = await loadAllWithRotation([TD_KEY]);
  return result.data;
}

/* ---------- notify ---------- */
async function loadLastSignal() {
  try {
    const store = await getBlobStore();
    if (store) {
      const data = await store.get("lastServerSignal", { type: "json" });
      if (data) return data;
    }
  } catch (e) {}
  try {
    const url = RTDB.replace(/\/$/, "") + "/lastServerSignal.json";
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function saveLastSignal(sig) {
  const payload = {
    dir: sig.dir,
    direction: sig.direction || String(sig.dir || "").toUpperCase(),
    entry: sig.entry,
    sl: sig.sl,
    tp1: sig.tp1,
    tp2: sig.tp2,
    tp3: sig.tp3,
    model: sig.model || sig.primaryStrategy,
    primaryStrategy: sig.primaryStrategy || sig.model,
    confirmations: sig.confirmations || [],
    prob: sig.prob,
    rr: sig.rr,
    bias4H: sig.bias4H,
    bias1H: sig.bias1H,
    session: sig.session || "",
    mode: sig.mode || "",
    reason: sig.reason || "",
    at: Date.now()
  };
  try {
    const store = await getBlobStore();
    if (store) await store.setJSON("lastServerSignal", payload);
  } catch (e) {}
  try {
    const url = RTDB.replace(/\/$/, "") + "/lastServerSignal.json";
    await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {}
}

function isDuplicate(prev, sig) {
  if (!prev || !sig) return false;
  if (prev.dir !== sig.dir) return false;
  if (Math.abs((prev.entry || 0) - sig.entry) > 0.5) return false;
  // same setup within 60 minutes (slightly tighter for multi-model)
  if (prev.at && Date.now() - prev.at < 60 * 60 * 1000) return true;
  return false;
}

async function sendTelegram(sig, TG_TOKEN, TG_CHAT) {
  if (!TG_TOKEN || !TG_CHAT) return { sent: false, reason: "not configured" };
  const arrow = sig.direction === "BUY" ? "🟢 BUY" : "🔴 SELL";
  const confs = (sig.confirmations && sig.confirmations.length)
    ? sig.confirmations.join(", ")
    : "—";
  const text =
    "🔔 ICT Gold Multi-Strategy Signal\n\n" +
    arrow + "  " + sig.pair + "\n" +
    "Primary: " + (sig.primaryStrategy || sig.model) + "\n" +
    "Confirmations: " + confs + "\n" +
    "Confidence: " + sig.prob + "% (" + (sig.confidenceLevel || "") + ")\n\n" +
    "Entry: " + sig.entry + "\n" +
    "SL: " + sig.sl + "\n" +
    "TP1: " + sig.tp1 + "\n" +
    "TP2: " + sig.tp2 + "\n" +
    "TP3: " + (sig.tp3 || "—") + "\n" +
    "R:R: 1:" + (sig.rr || "—") + "\n\n" +
    "4H Bias: " + (sig.bias4H || "—") + "\n" +
    "1H Bias: " + (sig.bias1H || "—") + "\n" +
    "Session: " + (sig.session || "-") + "\n" +
    "Reason: " + (sig.reason || "") + "\n" +
    "⏱ " + new Date().toISOString();

  const res = await fetch(
    "https://api.telegram.org/bot" + TG_TOKEN + "/sendMessage",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        text,
        disable_web_page_preview: true
      })
    }
  );
  const j = await res.json().catch(() => ({}));
  return { sent: !!(j && j.ok), detail: j.description || null };
}

async function sendNtfy(sig, NTFY_TOPIC) {
  if (!NTFY_TOPIC) return { sent: false, reason: "not configured" };
  const title = "ICT Gold · " + sig.direction + " " + sig.pair;
  const body =
    sig.model +
    " · " +
    sig.prob +
    "% · Entry " +
    sig.entry +
    " · SL " +
    sig.sl +
    " · TP1 " +
    sig.tp1;
  const res = await fetch("https://ntfy.sh/" + encodeURIComponent(NTFY_TOPIC), {
    method: "POST",
    headers: {
      Title: title,
      Priority: "5",
      Tags: "chart_with_upwards_trend,moneybag,rotating_light",
      "Content-Type": "text/plain"
    },
    body
  });
  return { sent: res.ok, status: res.status };
}

async function loadFcmTokens() {
  try {
    const url = RTDB.replace(/\/$/, "") + "/fcmTokens.json";
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data || typeof data !== "object") return [];
    const tokens = [];
    const seen = new Set();
    for (const k of Object.keys(data)) {
      const t = data[k] && data[k].token;
      if (t && !seen.has(t)) {
        seen.add(t);
        tokens.push(t);
      }
    }
    return tokens;
  } catch (e) {
    return [];
  }
}

async function sendFcm(sig) {
  if (!FCM_SERVER_KEY) return { sent: 0, reason: "no key" };
  const tokens = await loadFcmTokens();
  if (!tokens.length) return { sent: 0, reason: "no tokens" };
  const title = "ICT Gold · " + sig.direction + " " + sig.pair;
  const body =
    sig.model +
    " · " +
    sig.prob +
    "% · Entry " +
    sig.entry +
    " · SL " +
    sig.sl;
  let sent = 0;
  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);
    const res = await fetch("https://fcm.googleapis.com/fcm/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "key=" + FCM_SERVER_KEY
      },
      body: JSON.stringify({
        registration_ids: batch,
        priority: "high",
        notification: { title, body, click_action: "/" },
        data: {
          dir: sig.dir,
          pair: sig.pair,
          entry: String(sig.entry),
          sl: String(sig.sl),
          tp1: String(sig.tp1),
          model: sig.model,
          prob: String(sig.prob)
        }
      })
    });
    const j = await res.json().catch(() => ({}));
    if (j.success) sent += j.success;
  }
  return { sent, total: tokens.length };
}


/* ---------- heartbeat + failure alerts (24/7 reliability) ---------- */
async function saveHeartbeat(status) {
  const payload = {
    ok: !!status.ok,
    trade: !!status.trade,
    reason: status.reason || null,
    error: status.error || null,
    usedKeyMasked: status.usedKeyMasked || null,
    totalKeys: status.totalKeys || 0,
    price: status.price || null,
    mode: status.mode || null,
    at: Date.now(),
    iso: new Date().toISOString()
  };
  try {
    const url = RTDB.replace(/\/$/, "") + "/lastServerHeartbeat.json";
    await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) {}
  return payload;
}

async function loadLastAlert() {
  try {
    const url = RTDB.replace(/\/$/, "") + "/lastServerAlert.json";
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function saveLastAlert(kind, message) {
  try {
    const url = RTDB.replace(/\/$/, "") + "/lastServerAlert.json";
    await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, message, at: Date.now() })
    });
  } catch (e) {}
}

/** Send plain text alert via Telegram + ntfy (for errors / status). Rate-limited to once per 30 min per kind. */
async function sendStatusAlert(cfg, kind, message) {
  const prev = await loadLastAlert();
  if (prev && prev.kind === kind && prev.at && Date.now() - prev.at < 30 * 60 * 1000) {
    return { skipped: true, reason: "rate-limited 30min" };
  }

  const results = { telegram: null, ntfy: null };
  const text = "⚠️ ICT Gold AI — " + kind + "\n\n" + message + "\n\n⏱ " + new Date().toISOString();

  if (cfg.TG_TOKEN && cfg.TG_CHAT) {
    try {
      const res = await fetch(
        "https://api.telegram.org/bot" + cfg.TG_TOKEN + "/sendMessage",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: cfg.TG_CHAT,
            text,
            disable_web_page_preview: true
          })
        }
      );
      const j = await res.json().catch(() => ({}));
      results.telegram = { sent: !!(j && j.ok), detail: j.description || null };
    } catch (e) {
      results.telegram = { sent: false, error: e.message };
    }
  }

  if (cfg.NTFY_TOPIC) {
    try {
      const res = await fetch(
        "https://ntfy.sh/" + encodeURIComponent(cfg.NTFY_TOPIC),
        {
          method: "POST",
          headers: {
            Title: "ICT Gold · " + kind,
            Priority: "4",
            Tags: "warning,rotating_light",
            "Content-Type": "text/plain"
          },
          body: message
        }
      );
      results.ntfy = { sent: res.ok, status: res.status };
    } catch (e) {
      results.ntfy = { sent: false, error: e.message };
    }
  }

  await saveLastAlert(kind, message);
  return results;
}


/* ---------- handler (Vercel + Netlify-compatible style) ---------- */
async function runScan() {
  const cfg = await loadServerConfig();

  // --- No API keys configured ---
  if (!cfg.TD_KEYS || cfg.TD_KEYS.length === 0) {
    const msg =
      "No Twelve Data API keys configured.\n" +
      "Set TWELVE_DATA_KEY, TWELVE_DATA_KEY_2, TWELVE_DATA_KEY_3 in Vercel Environment Variables.\n" +
      "Scanner cannot run until keys are set.";
    await saveHeartbeat({ ok: false, error: "no_keys" });
    await sendStatusAlert(cfg, "NO_API_KEYS", msg);
    throw new Error(msg.replace(/\n/g, " "));
  }

  let data, usedKeyIndex, usedKeyMasked, totalKeys;
  try {
    const loaded = await loadAllWithRotation(cfg.TD_KEYS);
    data = loaded.data;
    usedKeyIndex = loaded.usedKeyIndex;
    usedKeyMasked = loaded.usedKeyMasked;
    totalKeys = loaded.totalKeys;
  } catch (e) {
    // All keys failed
    await saveHeartbeat({
      ok: false,
      error: e.message,
      totalKeys: cfg.TD_KEYS.length
    });
    await sendStatusAlert(
      cfg,
      "ALL_KEYS_FAILED",
      "All Twelve Data API keys failed.\n" +
        e.message +
        "\n\nCheck rate limits / key validity. Scanner will retry next cron."
    );
    throw e;
  }

  const analyses = {};
  for (const tf of ["h4", "h1", "m15", "m5", "m1"]) {
    if (!data[tf] || data[tf].length < 20) {
      const errMsg =
        "Insufficient " + tf + " candles (" + (data[tf] ? data[tf].length : 0) + ")";
      await saveHeartbeat({ ok: false, error: errMsg, usedKeyMasked, totalKeys });
      throw new Error(errMsg);
    }
    analyses[tf] = analyzeTF(data[tf]);
  }

  const price =
    (analyses.m1 && analyses.m1.last && analyses.m1.last.close) ||
    (analyses.m5 && analyses.m5.last && analyses.m5.last.close) ||
    analyses.m15.last.close;

  const mode = cfg.MODE || STRATEGY_MODE || "multi";
  const kzFilter = cfg.KZ_FILTER || "both";
  const result = generateSignal(analyses, price, mode, kzFilter);

  const keyInfo = {
    usedKeyIndex,
    usedKeyMasked,
    totalKeys,
    hasTelegram: !!(cfg.TG_TOKEN && cfg.TG_CHAT),
    hasNtfy: !!cfg.NTFY_TOPIC,
    hasTwelveData: true,
    mode,
    killZoneFilter: kzFilter
  };

  // Always write heartbeat so we know cron is alive (even when no trade)
  await saveHeartbeat({
    ok: true,
    trade: !!result.trade,
    reason: result.reason || null,
    price,
    mode,
    killZoneFilter: kzFilter,
    usedKeyMasked,
    totalKeys
  });

  if (!result.trade) {
    return {
      ok: true,
      trade: false,
      reason: result.reason,
      price,
      mode,
      trends: {
        h4: analyses.h4.trend,
        h1: analyses.h1.trend,
        m15: analyses.m15.trend,
        m5: analyses.m5.trend
      },
      session: getSessionInfo(),
      config: keyInfo,
      at: new Date().toISOString()
    };
  }

  const prev = await loadLastSignal();
  if (isDuplicate(prev, result)) {
    return {
      ok: true,
      trade: true,
      duplicate: true,
      signal: result,
      config: keyInfo,
      at: new Date().toISOString()
    };
  }

  // Fire all notification channels independently (one failure must not block others)
  let tg = { sent: false }, ntfy = { sent: false }, fcm = { sent: 0 };
  try { tg = await sendTelegram(result, cfg.TG_TOKEN, cfg.TG_CHAT); } catch (e) { tg = { sent: false, error: e.message }; }
  try { ntfy = await sendNtfy(result, cfg.NTFY_TOPIC); } catch (e) { ntfy = { sent: false, error: e.message }; }
  try { fcm = await sendFcm(result); } catch (e) { fcm = { sent: 0, error: e.message }; }

  await saveLastSignal(result);

  // If ALL channels failed and at least one was configured, alert once
  const anyConfigured = keyInfo.hasTelegram || keyInfo.hasNtfy || !!FCM_SERVER_KEY;
  const anySent = tg.sent || ntfy.sent || (fcm.sent && fcm.sent > 0);
  if (anyConfigured && !anySent) {
    await sendStatusAlert(
      cfg,
      "NOTIFY_FAILED",
      "New signal generated but ALL notification channels failed.\n" +
        "Telegram: " + JSON.stringify(tg) + "\n" +
        "ntfy: " + JSON.stringify(ntfy) + "\n" +
        "FCM: " + JSON.stringify(fcm) + "\n" +
        "Signal: " + result.direction + " " + result.pair + " @ " + result.entry
    );
  }

  return {
    ok: true,
    trade: true,
    signal: result,
    notify: { telegram: tg, ntfy, fcm },
    config: keyInfo,
    at: new Date().toISOString()
  };
}

// Vercel serverless handler (req, res)
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const body = await runScan();
    return res.status(200).json(body);
  } catch (e) {
    // Best-effort heartbeat on unexpected crash (keys / alerts already handled inside runScan)
    try {
      await saveHeartbeat({ ok: false, error: e.message || String(e) });
    } catch (_) {}
    return res.status(500).json({
      ok: false,
      error: e.message || String(e),
      at: new Date().toISOString(),
      note: "If Telegram/ntfy are configured, a status alert may have been sent (rate-limited 30 min)."
    });
  }
};

// Also support Netlify-style for easy dual deploy if needed
module.exports.handler = async function (event) {
  try {
    const body = await runScan();
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ok: false,
        error: e.message || String(e),
        at: new Date().toISOString()
      })
    };
  }
};
