/**
 * GET/POST /api/save-config
 * Saves or reads server config (mainly Firebase RTDB on Vercel).
 * Prefer setting secrets via Vercel Environment Variables for reliability.
 * Supports multiple Twelve Data keys: twelveDataKey, twelveDataKey2, twelveDataKey3
 * or twelveDataKeys (comma-separated).
 */
const RTDB =
  process.env.FIREBASE_RTDB_URL ||
  "https://ict-signal-default-rtdb.firebaseio.com";

async function readConfig() {
  // Always try RTDB so UI-saved strategyMode is available even when secrets live in env
  let fromRtdb = {};
  try {
    const res = await fetch(RTDB.replace(/\/$/, "") + "/serverConfig.json", {
      headers: { Accept: "application/json" }
    });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === "object") fromRtdb = data;
    }
  } catch (e) {}

  const fromEnv = {
    twelveDataKey: (process.env.TWELVE_DATA_KEY || process.env.TD_KEY || "").trim(),
    twelveDataKey2: (process.env.TWELVE_DATA_KEY_2 || "").trim(),
    twelveDataKey3: (process.env.TWELVE_DATA_KEY_3 || "").trim(),
    twelveDataKeys: (process.env.TWELVE_DATA_KEYS || "").trim(),
    telegramBotToken: (process.env.TELEGRAM_BOT_TOKEN || "").trim(),
    telegramChatId: (process.env.TELEGRAM_CHAT_ID || "").trim(),
    ntfyTopic: (process.env.NTFY_TOPIC || "").trim(),
    strategyMode: (process.env.STRATEGY_MODE || "").trim(),
    killZoneFilter: (process.env.KILL_ZONE_FILTER || "").trim()
  };

  const hasEnvSecrets =
    !!(fromEnv.twelveDataKey ||
      fromEnv.twelveDataKey2 ||
      fromEnv.twelveDataKey3 ||
      fromEnv.twelveDataKeys ||
      fromEnv.telegramBotToken);

  // Merge: env secrets win when present; strategyMode / killZoneFilter prefer env if set, else RTDB
  const merged = {
    twelveDataKey: fromEnv.twelveDataKey || fromRtdb.twelveDataKey || "",
    twelveDataKey2: fromEnv.twelveDataKey2 || fromRtdb.twelveDataKey2 || "",
    twelveDataKey3: fromEnv.twelveDataKey3 || fromRtdb.twelveDataKey3 || "",
    twelveDataKeys: fromEnv.twelveDataKeys || fromRtdb.twelveDataKeys || "",
    telegramBotToken: fromEnv.telegramBotToken || fromRtdb.telegramBotToken || "",
    telegramChatId: fromEnv.telegramChatId || fromRtdb.telegramChatId || "",
    ntfyTopic: fromEnv.ntfyTopic || fromRtdb.ntfyTopic || "",
    strategyMode:
      fromEnv.strategyMode ||
      (fromRtdb.strategyMode || "").trim() ||
      "",
    killZoneFilter:
      fromEnv.killZoneFilter ||
      (fromRtdb.killZoneFilter || "").trim() ||
      "both",
    updatedAt: fromRtdb.updatedAt || null,
    source: hasEnvSecrets ? "env+rtdb" : Object.keys(fromRtdb).length ? "rtdb" : "none"
  };

  return merged;
}

async function writeConfig(merged) {
  const errors = [];
  try {
    const res = await fetch(RTDB.replace(/\/$/, "") + "/serverConfig.json", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(merged)
    });
    if (res.ok) return { ok: true, via: "rtdb" };
    const t = await res.text();
    errors.push("rtdb: " + t.slice(0, 120));
  } catch (e) {
    errors.push("rtdb: " + (e.message || String(e)));
  }

  return { ok: false, errors };
}

function countKeys(data) {
  let n = 0;
  if (data.twelveDataKey && String(data.twelveDataKey).length > 8) n++;
  if (data.twelveDataKey2 && String(data.twelveDataKey2).length > 8) n++;
  if (data.twelveDataKey3 && String(data.twelveDataKey3).length > 8) n++;
  if (data.twelveDataKeys) {
    n += String(data.twelveDataKeys)
      .split(/[,;\s]+/)
      .filter((k) => k.trim().length > 8).length;
  }
  return n;
}

async function handle(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method === "GET") {
    try {
      const data = await readConfig();
      const keyCount = countKeys(data);
      return res.status(200).json({
        ok: true,
        hasTwelveData: keyCount > 0,
        twelveDataKeysCount: keyCount,
        hasTelegram: !!(data.telegramBotToken && data.telegramChatId),
        hasNtfy: !!(data.ntfyTopic && String(data.ntfyTopic).length >= 4),
        ntfyTopic: data.ntfyTopic ? String(data.ntfyTopic) : "",
        telegramChatId: data.telegramChatId ? String(data.telegramChatId) : "",
        strategyMode: data.strategyMode || "balanced",
        killZoneFilter: data.killZoneFilter || "both",
        updatedAt: data.updatedAt || null,
        storage: data.source || "none",
        envAvailable: !!(
          process.env.TWELVE_DATA_KEY ||
          process.env.TWELVE_DATA_KEY_2 ||
          process.env.TELEGRAM_BOT_TOKEN
        ),
        platform: "vercel"
      });
    } catch (e) {
      return res.status(200).json({
        ok: true,
        hasTwelveData: false,
        hasTelegram: false,
        hasNtfy: false,
        strategyMode: "balanced",
        killZoneFilter: "both",
        error: e.message
      });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST or GET only" });
  }

  try {
    // Vercel provides req.body already parsed for JSON, but support both
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body || "{}");
      } catch {
        body = {};
      }
    }
    if (!body || typeof body !== "object") body = {};

    const existing = await readConfig();
    const merged = {
      twelveDataKey:
        String(body.twelveDataKey || body.TWELVE_DATA_KEY || "").trim() ||
        existing.twelveDataKey ||
        "",
      twelveDataKey2:
        String(body.twelveDataKey2 || body.TWELVE_DATA_KEY_2 || "").trim() ||
        existing.twelveDataKey2 ||
        "",
      twelveDataKey3:
        String(body.twelveDataKey3 || body.TWELVE_DATA_KEY_3 || "").trim() ||
        existing.twelveDataKey3 ||
        "",
      twelveDataKeys:
        String(body.twelveDataKeys || body.TWELVE_DATA_KEYS || "").trim() ||
        existing.twelveDataKeys ||
        "",
      telegramBotToken:
        String(body.telegramBotToken || body.TELEGRAM_BOT_TOKEN || "").trim() ||
        existing.telegramBotToken ||
        "",
      telegramChatId:
        String(body.telegramChatId || body.TELEGRAM_CHAT_ID || "").trim() ||
        existing.telegramChatId ||
        "",
      ntfyTopic:
        String(body.ntfyTopic || body.NTFY_TOPIC || "").trim() ||
        existing.ntfyTopic ||
        "",
      strategyMode:
        String(body.strategyMode || body.STRATEGY_MODE || "").trim() ||
        existing.strategyMode ||
        "",
      killZoneFilter: (() => {
        const raw = String(
          body.killZoneFilter || body.KILL_ZONE_FILTER || existing.killZoneFilter || "both"
        )
          .trim()
          .toLowerCase();
        return raw === "inside" || raw === "outside" || raw === "both" ? raw : "both";
      })(),
      updatedAt: Date.now()
    };

    const result = await writeConfig(merged);
    if (!result.ok) {
      return res.status(502).json({
        error: "Config save failed",
        detail: (result.errors || []).join(" | "),
        hint:
          "Firebase RTDB write failed. Best practice on Vercel: go to Project → Settings → Environment Variables and set TWELVE_DATA_KEY, TWELVE_DATA_KEY_2, TWELVE_DATA_KEY_3, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, NTFY_TOPIC. Then redeploy.",
        useEnvVars: true
      });
    }

    return res.status(200).json({
      ok: true,
      via: result.via,
      hasTwelveData: countKeys(merged) > 0,
      twelveDataKeysCount: countKeys(merged),
      hasTelegram: !!(merged.telegramBotToken && merged.telegramChatId),
      hasNtfy: !!merged.ntfyTopic,
      strategyMode: merged.strategyMode || "balanced",
      killZoneFilter: merged.killZoneFilter || "both"
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "server error" });
  }
}

module.exports = handle;

// Netlify-style
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
  // Minimal shim
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
