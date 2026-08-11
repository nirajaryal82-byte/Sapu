/**
 * GET /api/live-price
 * Live XAU/USD quote from Twelve Data using server keys (env + RTDB), with rotation.
 */
const RTDB =
  process.env.FIREBASE_RTDB_URL ||
  "https://ict-signal-default-rtdb.firebaseio.com";

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

async function loadRemoteConfig() {
  try {
    const res = await fetch(RTDB.replace(/\/$/, "") + "/serverConfig.json", {
      headers: { Accept: "application/json" }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === "object") return data;
    }
  } catch (e) {}
  return {};
}

function maskKey(k) {
  if (!k || k.length < 10) return "—";
  return k.slice(0, 6) + "…" + k.slice(-4);
}

async function fetchQuote(apiKey) {
  // Prefer real-time price endpoint; fall back to latest 1-min candle close
  const priceUrl =
    "https://api.twelvedata.com/price?symbol=XAU/USD&apikey=" +
    encodeURIComponent(apiKey);
  let price = null;
  let err = null;

  try {
    const res = await fetch(priceUrl, { cache: "no-store" });
    const j = await res.json().catch(() => ({}));
    if (j && j.price != null && !isNaN(Number(j.price))) {
      price = Number(j.price);
    } else {
      err = (j && (j.message || j.status)) || "no price";
    }
  } catch (e) {
    err = e.message || String(e);
  }

  if (price == null) {
    const tsUrl =
      "https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1min&outputsize=2&apikey=" +
      encodeURIComponent(apiKey);
    try {
      const res = await fetch(tsUrl, { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      const row =
        j && j.values && j.values[0]
          ? j.values[0]
          : null;
      if (row && row.close != null) {
        price = Number(row.close);
        err = null;
      } else if (!err) {
        err = (j && (j.message || j.status)) || "no candle";
      }
    } catch (e) {
      if (!err) err = e.message || String(e);
    }
  }

  // Optional change % via quote endpoint
  let change = null;
  let percentChange = null;
  try {
    const qUrl =
      "https://api.twelvedata.com/quote?symbol=XAU/USD&apikey=" +
      encodeURIComponent(apiKey);
    const res = await fetch(qUrl, { cache: "no-store" });
    const j = await res.json().catch(() => ({}));
    if (j && j.close != null && price == null) price = Number(j.close);
    if (j && j.change != null) change = Number(j.change);
    if (j && j.percent_change != null) percentChange = Number(j.percent_change);
    if (j && j.previous_close != null && price != null && change == null) {
      change = price - Number(j.previous_close);
      if (Number(j.previous_close) > 0) {
        percentChange = (change / Number(j.previous_close)) * 100;
      }
    }
  } catch (e) {}

  return { price, change, percentChange, err };
}

async function handle(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const remote = await loadRemoteConfig();
    const keys = collectTdKeys(remote);
    if (!keys.length) {
      return res.status(200).json({
        ok: false,
        error: "No Twelve Data API keys configured",
        hint: "Set TWELVE_DATA_KEY in Vercel env or save keys in Profile",
        source: null
      });
    }

    let lastErr = null;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const q = await fetchQuote(key);
      if (q.price != null && !isNaN(q.price)) {
        return res.status(200).json({
          ok: true,
          symbol: "XAU/USD",
          price: +Number(q.price).toFixed(2),
          change: q.change != null ? +Number(q.change).toFixed(2) : null,
          percentChange:
            q.percentChange != null
              ? +Number(q.percentChange).toFixed(2)
              : null,
          source: "twelvedata",
          usedKeyIndex: i + 1,
          usedKeyMasked: maskKey(key),
          totalKeys: keys.length,
          at: new Date().toISOString()
        });
      }
      lastErr = q.err || "unknown";
    }

    return res.status(200).json({
      ok: false,
      error: "All Twelve Data keys failed",
      detail: lastErr,
      totalKeys: keys.length,
      source: "twelvedata"
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
  const req = { method: event.httpMethod, body: event.body };
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
