/**
 * GET /api/health
 * Quick status of configured env vars and services (Vercel).
 */
function collectTdKeys() {
  const keys = [];
  const add = (k) => {
    const v = (k || "").trim();
    if (v && v.length > 8 && !keys.includes(v)) keys.push(v);
  };
  add(process.env.TWELVE_DATA_KEY);
  add(process.env.TWELVE_DATA_KEY_2);
  add(process.env.TWELVE_DATA_KEY_3);
  add(process.env.TD_KEY);
  if (process.env.TWELVE_DATA_KEYS) {
    process.env.TWELVE_DATA_KEYS.split(/[,;\s]+/).forEach(add);
  }
  return keys;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  const tdKeys = collectTdKeys();
  const hasTd = tdKeys.length > 0;
  const hasTg = !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
  const hasNtfy = !!process.env.NTFY_TOPIC;
  const hasFcm = !!process.env.FCM_SERVER_KEY;

  // Read last heartbeat so you can see if cron is alive
  let lastHeartbeat = null;
  try {
    const RTDB =
      process.env.FIREBASE_RTDB_URL ||
      "https://ict-signal-default-rtdb.firebaseio.com";
    const r = await fetch(RTDB.replace(/\/$/, "") + "/lastServerHeartbeat.json", {
      headers: { Accept: "application/json" }
    });
    if (r.ok) lastHeartbeat = await r.json();
  } catch (e) {}

  const ageMin = lastHeartbeat && lastHeartbeat.at
    ? Math.round((Date.now() - lastHeartbeat.at) / 60000)
    : null;

  const body = {
    ok: true,
    platform: "vercel",
    service: "ICT Gold AI — 24/7 Multi-Strategy Scanner",
    hasFcmKey: hasFcm,
    hasTelegram: hasTg,
    hasNtfy: hasNtfy,
    hasTwelveData: hasTd,
    twelveDataKeysCount: tdKeys.length,
    twelveDataKeysMasked: tdKeys.map((k) => k.slice(0, 6) + "…" + k.slice(-4)),
    scanner: "scan-ict every 5 min (Vercel Cron) — browser does NOT need to stay open",
    rtdb: process.env.FIREBASE_RTDB_URL || "https://ict-signal-default-rtdb.firebaseio.com",
    lastHeartbeat: lastHeartbeat
      ? {
          ok: lastHeartbeat.ok,
          trade: lastHeartbeat.trade,
          error: lastHeartbeat.error || null,
          usedKey: lastHeartbeat.usedKeyMasked || null,
          price: lastHeartbeat.price || null,
          ageMinutes: ageMin,
          at: lastHeartbeat.iso || null
        }
      : null,
    cronAlive: ageMin != null && ageMin < 15,
    note:
      hasTd && hasTg
        ? "Env vars OK — 24/7 scanner runs via Vercel Cron (no browser needed). Keys rotate automatically. Alerts on key/notify failures."
        : "Missing env vars. In Vercel Dashboard → Project → Settings → Environment Variables set: TWELVE_DATA_KEY (and optionally _2, _3), TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Then redeploy.",
    at: new Date().toISOString()
  };

  return res.status(200).json(body);
};

// Netlify-style fallback
module.exports.handler = async function () {
  const tdKeys = collectTdKeys();
  return {
    statusCode: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ok: true,
      platform: "netlify-compat",
      hasTwelveData: tdKeys.length > 0,
      twelveDataKeysCount: tdKeys.length,
      at: new Date().toISOString()
    })
  };
};
