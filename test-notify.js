/**
 * POST /api/test-notify
 * Sends a test message to all configured channels:
 *  - Telegram
 *  - ntfy
 *  - FCM (app / website push tokens)
 *
 * Body (optional overrides):
 *   { telegramBotToken, telegramChatId, ntfyTopic }
 * Falls back to RTDB serverConfig + env vars.
 */
const RTDB =
  process.env.FIREBASE_RTDB_URL ||
  "https://ict-signal-default-rtdb.firebaseio.com";
const FCM_SERVER_KEY = process.env.FCM_SERVER_KEY || "";

async function readConfig() {
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

  return {
    telegramBotToken:
      (remote.telegramBotToken || "").trim() ||
      (process.env.TELEGRAM_BOT_TOKEN || "").trim(),
    telegramChatId:
      (remote.telegramChatId || "").trim() ||
      (process.env.TELEGRAM_CHAT_ID || "").trim(),
    ntfyTopic:
      (remote.ntfyTopic || "").trim() ||
      (process.env.NTFY_TOPIC || "").trim()
  };
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

async function testTelegram(token, chatId) {
  if (!token || !chatId) {
    return { ok: false, channel: "telegram", reason: "not configured" };
  }
  const text =
    "✅ ICT Gold AI — Notification Test\n\n" +
    "Telegram is working.\n" +
    "Channel: Telegram\n" +
    "Time: " +
    new Date().toISOString();
  try {
    const res = await fetch(
      "https://api.telegram.org/bot" + token + "/sendMessage",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true
        })
      }
    );
    const j = await res.json().catch(() => ({}));
    return {
      ok: !!(j && j.ok),
      channel: "telegram",
      detail: j.description || (j.ok ? "sent" : "failed"),
      status: res.status
    };
  } catch (e) {
    return { ok: false, channel: "telegram", reason: e.message || String(e) };
  }
}

async function testNtfy(topic) {
  if (!topic) {
    return { ok: false, channel: "ntfy", reason: "not configured" };
  }
  try {
    const res = await fetch("https://ntfy.sh/" + encodeURIComponent(topic), {
      method: "POST",
      headers: {
        Title: "ICT Gold AI — Test",
        Priority: "high",
        Tags: "white_check_mark,bell",
        "Content-Type": "text/plain"
      },
      body:
        "ntfy push is working.\nTopic: " +
        topic +
        "\nTime: " +
        new Date().toISOString()
    });
    return {
      ok: res.ok,
      channel: "ntfy",
      status: res.status,
      detail: res.ok ? "sent" : "HTTP " + res.status
    };
  } catch (e) {
    return { ok: false, channel: "ntfy", reason: e.message || String(e) };
  }
}

async function testFcm() {
  if (!FCM_SERVER_KEY) {
    return {
      ok: false,
      channel: "fcm",
      reason: "FCM_SERVER_KEY not set in Vercel env"
    };
  }
  const tokens = await loadFcmTokens();
  if (!tokens.length) {
    return {
      ok: false,
      channel: "fcm",
      reason: "No registered app/website push tokens"
    };
  }

  let sent = 0;
  const errors = [];
  try {
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
            title: "ICT Gold AI — Test",
            body: "App / website push is working · " + new Date().toISOString(),
            icon: "/icon-192.png",
            click_action: "/"
          },
          data: {
            type: "test",
            at: new Date().toISOString()
          }
        })
      });
      const json = await res.json().catch(() => ({}));
      if (json.success) sent += json.success;
      if (json.failure) {
        errors.push({ failure: json.failure });
      }
      if (!res.ok && json.error) errors.push(json.error);
    }
    return {
      ok: sent > 0,
      channel: "fcm",
      sent,
      totalTokens: tokens.length,
      detail: sent > 0 ? "sent to " + sent + " device(s)" : "no successful delivery",
      errors: errors.slice(0, 3)
    };
  } catch (e) {
    return { ok: false, channel: "fcm", reason: e.message || String(e) };
  }
}

async function handle(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "POST or GET only" });
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

    const cfg = await readConfig();
    const token =
      String(body.telegramBotToken || body.TELEGRAM_BOT_TOKEN || "").trim() ||
      cfg.telegramBotToken;
    const chatId =
      String(body.telegramChatId || body.TELEGRAM_CHAT_ID || "").trim() ||
      cfg.telegramChatId;
    const ntfyTopic =
      String(body.ntfyTopic || body.NTFY_TOPIC || "").trim() || cfg.ntfyTopic;

    const [telegram, ntfy, fcm] = await Promise.all([
      testTelegram(token, chatId),
      testNtfy(ntfyTopic),
      testFcm()
    ]);

    const anyOk = !!(telegram.ok || ntfy.ok || fcm.ok);

    return res.status(200).json({
      ok: true,
      anySent: anyOk,
      channels: { telegram, ntfy, fcm },
      summary: {
        telegram: telegram.ok ? "OK" : telegram.reason || telegram.detail || "fail",
        ntfy: ntfy.ok ? "OK" : ntfy.reason || ntfy.detail || "fail",
        fcm: fcm.ok ? "OK (" + (fcm.sent || 0) + ")" : fcm.reason || fcm.detail || "fail"
      },
      at: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "server error" });
  }
}

module.exports = handle;

module.exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json"
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  const req = {
    method: event.httpMethod,
    body: event.body
  };
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
