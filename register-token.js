/**
 * POST /api/register-token
 * Body: { token: string, platform?: string }
 * Stores FCM web token in Firebase Realtime Database (free Spark plan).
 */
const RTDB = process.env.FIREBASE_RTDB_URL || "https://ict-signal-default-rtdb.firebaseio.com";

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

    const token = (body.token || "").trim();
    if (!token || token.length < 20) {
      return res.status(400).json({ error: "Invalid token" });
    }

    const key = Buffer.from(token).toString("base64url").slice(0, 48);
    const payload = {
      token,
      platform: body.platform || "web",
      ua: (body.ua || "").slice(0, 180),
      updatedAt: Date.now()
    };

    const url = RTDB.replace(/\/$/, "") + "/fcmTokens/" + key + ".json";
    const r = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(502).json({
        error: "RTDB write failed",
        detail: t.slice(0, 200),
        hint: "Enable Realtime Database in Firebase Console and set rules to allow write on /fcmTokens"
      });
    }

    return res.status(200).json({ ok: true, key });
  } catch (e) {
    return res.status(500).json({ error: e.message || "server error" });
  }
};
