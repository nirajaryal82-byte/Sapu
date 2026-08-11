/**
 * GET /api/analysis
 * Live ICT market analysis for XAU/USD using Twelve Data keys (env + RTDB).
 * Returns MTF bias, ICT concepts, dealing range, session, and condition summary.
 */
const RTDB =
  process.env.FIREBASE_RTDB_URL ||
  "https://ict-signal-default-rtdb.firebaseio.com";
const LOOKBACK = 80;
const PIVOT = 2;
const TF_MAP = { h4: "4h", h1: "1h", m15: "15min", m5: "5min" };

function collectTdKeys(remote = {}) {
  const keys = [];
  const add = (k) => {
    const v = (k || "").trim();
    if (v && v.length > 8 && !keys.includes(v)) keys.push(v);
  };
  add(remote.twelveDataKey);
  add(remote.twelveDataKey2);
  add(remote.twelveDataKey3);
  if (remote.twelveDataKeys) {
    String(remote.twelveDataKeys)
      .split(/[,;\s]+/)
      .forEach(add);
  }
  add(process.env.TWELVE_DATA_KEY);
  add(process.env.TWELVE_DATA_KEY_2);
  add(process.env.TWELVE_DATA_KEY_3);
  add(process.env.TD_KEY);
  if (process.env.TWELVE_DATA_KEYS) {
    process.env.TWELVE_DATA_KEYS.split(/[,;\s]+/).forEach(add);
  }
  return keys;
}

async function loadRemote() {
  try {
    const res = await fetch(RTDB.replace(/\/$/, "") + "/serverConfig.json", {
      headers: { Accept: "application/json" }
    });
    if (res.ok) {
      const d = await res.json();
      if (d && typeof d === "object") return d;
    }
  } catch (e) {}
  return {};
}

function maskKey(k) {
  if (!k || k.length < 10) return "—";
  return k.slice(0, 6) + "…" + k.slice(-4);
}

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
    if (hi) highs.push({ i, price: candles[i].high });
    if (lo) lows.push({ i, price: candles[i].low });
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
    sl
  };
}

function liquiditySweep(candles) {
  const p = pivots(candles);
  const n = candles.length;
  const recentLows = p.lows.slice(-8).filter((x) => x.i < n - 2);
  const recentHighs = p.highs.slice(-8).filter((x) => x.i < n - 2);
  const sweepLook = Math.min(8, n - 1);
  let bull = false,
    bear = false;
  for (const lvl of recentLows.slice().reverse()) {
    for (let bi = 0; bi < sweepLook; bi++) {
      const c = candles[n - 1 - bi];
      if (c.low < lvl.price && c.close > lvl.price) {
        bull = true;
        break;
      }
    }
    if (bull) break;
  }
  for (const lvl of recentHighs.slice().reverse()) {
    for (let bi = 0; bi < sweepLook; bi++) {
      const c = candles[n - 1 - bi];
      if (c.high > lvl.price && c.close < lvl.price) {
        bear = true;
        break;
      }
    }
    if (bear) break;
  }
  let sessHigh = -Infinity,
    sessLow = Infinity;
  const look = Math.min(48, n);
  for (let i = n - look; i < n; i++) {
    if (candles[i].high > sessHigh) sessHigh = candles[i].high;
    if (candles[i].low < sessLow) sessLow = candles[i].low;
  }
  return { bull, bear, sessHigh, sessLow };
}

function fvg(candles) {
  const out = [];
  const n = candles.length;
  for (let i = 2; i < n; i++) {
    const a = candles[i - 2],
      c = candles[i];
    if (c.low > a.high) {
      let mitigated = false;
      for (let k = i + 1; k < n; k++) {
        if (candles[k].low <= a.high) {
          mitigated = true;
          break;
        }
      }
      out.push({ dir: "buy", low: a.high, high: c.low, i, mitigated });
    }
    if (c.high < a.low) {
      let mitigated = false;
      for (let k = i + 1; k < n; k++) {
        if (candles[k].high >= a.low) {
          mitigated = true;
          break;
        }
      }
      out.push({ dir: "sell", low: c.high, high: a.low, i, mitigated });
    }
  }
  return out.filter((x) => x.i >= n - 40).slice(-12);
}

function orderBlocks(candles) {
  const out = [];
  const n = candles.length;
  for (let i = 3; i < n - 1; i++) {
    if (isDisplacement(candles, i) && isBull(candles[i])) {
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (isBear(candles[j])) {
          out.push({
            dir: "buy",
            low: candles[j].low,
            high: candles[j].high,
            i: j
          });
          break;
        }
      }
    }
    if (isDisplacement(candles, i) && isBear(candles[i])) {
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (isBull(candles[j])) {
          out.push({
            dir: "sell",
            low: candles[j].low,
            high: candles[j].high,
            i: j
          });
          break;
        }
      }
    }
  }
  return out.slice(-10);
}

function dealingRange(candles, s) {
  const p = pivots(candles);
  const useH = p.highs.slice(-4);
  const useL = p.lows.slice(-4);
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
  return {
    high: +high.toFixed(2),
    low: +low.toFixed(2),
    eq: +eq.toFixed(2),
    range: +range.toFixed(2),
    oteBuyLow: +(high - range * 0.79).toFixed(2),
    oteBuyHigh: +(high - range * 0.618).toFixed(2),
    oteSellLow: +(low + range * 0.618).toFixed(2),
    oteSellHigh: +(low + range * 0.79).toFixed(2)
  };
}

function analyzeTF(candles) {
  const s = structure(candles);
  const liq = liquiditySweep(candles);
  const fvgs = fvg(candles);
  const obs = orderBlocks(candles);
  const dr = dealingRange(candles, s);
  const last = candles[candles.length - 1];
  let pd = "EQ";
  if (last.close < dr.eq) pd = "DISCOUNT";
  else if (last.close > dr.eq) pd = "PREMIUM";
  const openFvg = fvgs.filter((f) => !f.mitigated);
  return {
    trend: s.trend,
    swingTrend: s.swingTrend,
    bullishBOS: s.bullishBOS,
    bearishBOS: s.bearishBOS,
    chochBull: s.chochBull,
    chochBear: s.chochBear,
    bullDisp: s.bullDisp,
    bearDisp: s.bearDisp,
    liq,
    openFvgCount: openFvg.length,
    buyFvg: openFvg.filter((f) => f.dir === "buy").length,
    sellFvg: openFvg.filter((f) => f.dir === "sell").length,
    obCount: obs.length,
    buyOb: obs.filter((o) => o.dir === "buy").length,
    sellOb: obs.filter((o) => o.dir === "sell").length,
    dr,
    pd,
    lastClose: +last.close.toFixed(2),
    lastHigh: +last.high.toFixed(2),
    lastLow: +last.low.toFixed(2)
  };
}

function getSessionInfo() {
  const d = new Date();
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
    (h >= 12 && h < 13) || (h >= 14 && h < 15) || (h >= 7 && h < 8);
  return {
    weekday,
    inKillZone,
    inSilverBulletWindow,
    active,
    hourUTC: +h.toFixed(2)
  };
}

function biasLabel(t) {
  if (t === "BUY") return "BULLISH";
  if (t === "SELL") return "BEARISH";
  return "NEUTRAL";
}

function conceptStatus(m15, m5) {
  const a = m15 || {};
  const b = m5 || {};
  const fvgActive = (a.openFvgCount || 0) + (b.openFvgCount || 0) > 0;
  const obActive = (a.obCount || 0) + (b.obCount || 0) > 0;
  const liq =
    a.liq && b.liq
      ? a.liq.bull || a.liq.bear || b.liq.bull || b.liq.bear
      : false;
  const mss =
    a.bullishBOS ||
    a.bearishBOS ||
    a.chochBull ||
    a.chochBear ||
    b.bullishBOS ||
    b.bearishBOS ||
    b.chochBull ||
    b.chochBear;
  const disp = a.bullDisp || a.bearDisp || b.bullDisp || b.bearDisp;
  return [
    {
      name: "Fair Value Gap (FVG)",
      status: fvgActive ? "ACTIVE" : "NONE",
      detail:
        (a.buyFvg || 0) +
        (b.buyFvg || 0) +
        " buy / " +
        ((a.sellFvg || 0) + (b.sellFvg || 0)) +
        " sell open"
    },
    {
      name: "Order Block",
      status: obActive ? "ACTIVE" : "NONE",
      detail:
        (a.buyOb || 0) +
        (b.buyOb || 0) +
        " bull / " +
        ((a.sellOb || 0) + (b.sellOb || 0)) +
        " bear"
    },
    {
      name: "Liquidity Sweep",
      status: liq ? "ACTIVE" : "PENDING",
      detail: liq
        ? a.liq && a.liq.bull || b.liq && b.liq.bull
          ? "Sell-side raid"
          : "Buy-side raid"
        : "No recent sweep"
    },
    {
      name: "MSS / CHoCH",
      status: mss ? "ACTIVE" : "WATCH",
      detail: mss ? "Structure shift detected" : "No MSS/CHoCH"
    },
    {
      name: "Displacement",
      status: disp ? "ACTIVE" : "WATCH",
      detail: disp ? "Impulse candle present" : "No displacement"
    },
    {
      name: "Premium / Discount",
      status: a.pd || "EQ",
      detail: "Price vs dealing range EQ"
    }
  ];
}

function conditionSummary(h4, h1, m15, m5, session, price) {
  const aligned =
    h4.trend !== "WAIT" &&
    h4.trend === h1.trend &&
    (m15.trend === h4.trend || m15.trend === "WAIT");
  const conflict = h4.trend !== "WAIT" && h1.trend !== "WAIT" && h4.trend !== h1.trend;
  let score = 50;
  if (aligned) score += 20;
  if (conflict) score -= 15;
  if (session.inKillZone) score += 10;
  if (session.inSilverBulletWindow) score += 5;
  if (m5.liq && (m5.liq.bull || m5.liq.bear)) score += 8;
  if (m15.openFvgCount > 0) score += 5;
  if (m15.pd === "DISCOUNT" && h4.trend === "BUY") score += 8;
  if (m15.pd === "PREMIUM" && h4.trend === "SELL") score += 8;
  score = Math.max(0, Math.min(98, score));

  let condition = "WAIT / NO CLEAR SETUP";
  if (score >= 75 && aligned) condition = "HIGH PROBABILITY — LOOK FOR ENTRY";
  else if (score >= 62) condition = "MODERATE — WATCH FOR CONFIRMATION";
  else if (conflict) condition = "HTF CONFLICT — STAND ASIDE";
  else if (!session.weekday) condition = "WEEKEND — LOW PRIORITY";

  return {
    score,
    condition,
    aligned,
    conflict,
    price,
    array: m15.pd,
    htfBias: h4.trend,
    ltfBias: m5.trend
  };
}

async function fetchTF(tf, apiKey) {
  const url =
    "https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=" +
    TF_MAP[tf] +
    "&outputsize=" +
    LOOKBACK +
    "&apikey=" +
    encodeURIComponent(apiKey);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const j = await res.json();
  if (!j || !j.values || !Array.isArray(j.values)) {
    const msg = (j && (j.message || j.status)) || "no data";
    const err = new Error("TD " + tf + ": " + msg);
    err.isRateLimit = /rate|limit|quota|exceeded/i.test(String(msg));
    throw err;
  }
  return j.values
    .map((v) => ({
      time: Date.parse(v.datetime) || 0,
      open: +v.open,
      high: +v.high,
      low: +v.low,
      close: +v.close
    }))
    .filter((c) => isFinite(c.close))
    .reverse();
}

async function handle(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const remote = await loadRemote();
    const keys = collectTdKeys(remote);
    if (!keys.length) {
      return res.status(200).json({
        ok: false,
        error: "No Twelve Data API keys. Save keys in Profile or set TWELVE_DATA_KEY."
      });
    }

    let data = null;
    let usedKeyIndex = 0;
    let usedKeyMasked = "";
    let lastErr = null;
    const tfs = ["h4", "h1", "m15", "m5"];

    for (let i = 0; i < keys.length; i++) {
      try {
        const rows = await Promise.all(tfs.map((tf) => fetchTF(tf, keys[i])));
        data = {};
        tfs.forEach((tf, idx) => {
          data[tf] = rows[idx];
        });
        usedKeyIndex = i + 1;
        usedKeyMasked = maskKey(keys[i]);
        break;
      } catch (e) {
        lastErr = e.message || String(e);
      }
    }

    if (!data) {
      return res.status(200).json({
        ok: false,
        error: "All Twelve Data keys failed",
        detail: lastErr
      });
    }

    const h4 = analyzeTF(data.h4);
    const h1 = analyzeTF(data.h1);
    const m15 = analyzeTF(data.m15);
    const m5 = analyzeTF(data.m5);
    const price = m5.lastClose || m15.lastClose;
    const session = getSessionInfo();
    const concepts = conceptStatus(m15, m5);
    const summary = conditionSummary(h4, h1, m15, m5, session, price);

    return res.status(200).json({
      ok: true,
      symbol: "XAU/USD",
      price,
      session: {
        name: session.active ? session.active.name : "Off-session",
        inKillZone: session.inKillZone,
        inSilverBullet: session.inSilverBulletWindow,
        weekday: session.weekday,
        hourUTC: session.hourUTC
      },
      mtf: {
        h4: { trend: h4.trend, label: biasLabel(h4.trend), pd: h4.pd },
        h1: { trend: h1.trend, label: biasLabel(h1.trend), pd: h1.pd },
        m15: { trend: m15.trend, label: biasLabel(m15.trend), pd: m15.pd },
        m5: { trend: m5.trend, label: biasLabel(m5.trend), pd: m5.pd }
      },
      dealingRange: m15.dr,
      array: m15.pd,
      concepts,
      summary,
      levels: {
        sessHigh: m5.liq ? +Number(m5.liq.sessHigh).toFixed(2) : null,
        sessLow: m5.liq ? +Number(m5.liq.sessLow).toFixed(2) : null,
        eq: m15.dr.eq,
        rangeHigh: m15.dr.high,
        rangeLow: m15.dr.low,
        oteBuy: [m15.dr.oteBuyLow, m15.dr.oteBuyHigh],
        oteSell: [m15.dr.oteSellLow, m15.dr.oteSellHigh]
      },
      source: "twelvedata",
      usedKeyIndex,
      usedKeyMasked,
      totalKeys: keys.length,
      at: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "server error" });
  }
}

module.exports = handle;
module.exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  const req = { method: event.httpMethod };
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = JSON.stringify(obj);
      return this;
    },
    end() {}
  };
  await handle(req, res);
  return {
    statusCode: res.statusCode,
    headers: { ...headers, ...res.headers },
    body: res.body
  };
};
