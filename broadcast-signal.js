/**
 * POST /api/broadcast-signal
 * Body: { title, body, dir, pair, entry, sl, tp1, model, prob }
 *
 * 1) Loads FCM tokens from Firebase RTDB
 * 2) Sends push via FCM legacy HTTP API (needs env FCM_SERVER_KEY)
 * 3) Optionally relays to ntfy.sh if NTFY_TOPIC is set (or body.ntfyTopic)
 */
const RTDB = process.env.FIREBASE_RTDB_URL || "https://ict-signal-default-rtdb.firebaseio.com";
const FCM_SERVER_KEY = process.env.FCM_SERVER_KEY || "";
const DEFAULT_NTFY = process.env.NTFY_TOPIC || "";

async function loadTokens() {
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
}

async function sendFcm(tokens, notification, data) {
  if (!FCM_SERVER_KEY) {
    return { sent: 0, skipped: true, reason: "FCM_SERVER_KEY not set in Vercel env" };
  }
  if (!tokens.length) {
    return { sent: 0, skipped: true, reason: "No registered tokens" };
  }

  let sent = 0;
  const errors = [];
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
        notification: {
          title: notification.title,
          body: notification.body,
          icon: "/favicon.ico",
          click_action: "/"
        },
        data: data || {}
      })
    });
    const json = await res.json().catch(() => ({}));
    if (json.success) sent += json.success;
    if (json.failure) errors.push({ failure: json.failure, results: (json.results || []).slice(0, 3) });
    if (!res.ok && json.error) errors.push(json.error);
  }
  return { sent, errors, total: tokens.length };
}

async function sendNtfy(topic, title, message) {
  if (!topic) return { sent: false, reason: "no topic" };
  const res = await fetch("https://ntfy.sh/" + encodeURIComponent(topic), {
    method: "POST",
    headers: {
      Title: title,
      Priority: "high",
      Tags: "chart_with_upwards_trend,moneybag",
      "Content-Type": "text/plain"
    },
    body: message
  });
  return { sent: res.ok, status: res.status };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  try {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body || "{}");
      } catch {
        body = {};
      }
    }
    if (!body || typeof body !== "object") body = {};

    const title = body.title || "ICT Gold Signal";
    const msg =
      body.body ||
      [body.dir, body.pair, body.model, body.prob != null ? body.prob + "%" : ""]
        .filter(Boolean)
        .join(" · ");

    const data = {
      dir: String(body.dir || ""),
      pair: String(body.pair || "XAUUSD"),
      entry: String(body.entry || ""),
      sl: String(body.sl || ""),
      tp1: String(body.tp1 || ""),
      model: String(body.model || ""),
      prob: String(body.prob || ""),
      url: "/"
    };

    const tokens = await loadTokens();
    const fcm = await sendFcm(tokens, { title, body: msg }, data);

    const ntfyTopic = (body.ntfyTopic || DEFAULT_NTFY || "").trim();
    const ntfy = ntfyTopic
      ? await sendNtfy(ntfyTopic, title, msg)
      : { sent: false, reason: "ntfy not configured" };

    return res.status(200).json({
      ok: true,
      fcm,
      ntfy,
      tokenCount: tokens.length,
      hasServerKey: !!FCM_SERVER_KEY
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "server error" });
  }
};
