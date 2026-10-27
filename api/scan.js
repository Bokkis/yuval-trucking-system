// Vercel serverless function: reads a photo of a timesheet (DTR) with Claude Haiku 5.5.
// In Vercel (Settings > Environment Variables) set:
//   ANTHROPIC_API_KEY  - key from console.anthropic.com   (required)
//   ANTHROPIC_MODEL    - optional, defaults to claude-haiku-5-5 (fast).
//                        Use claude-sonnet-5-5 for better handwriting accuracy.
module.exports = async (req, res) => {
  const AKEY = process.env.ANTHROPIC_API_KEY;
  if (req.method === "GET") return res.status(200).json({ ok: true, anthropicKeySet: !!AKEY, model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5" });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Only signed-in staff may use this (checks the Supabase login).
  const SB_URL = process.env.SUPABASE_URL || "https://atkgorpjdiinyycidgqf.supabase.co";
  const SB_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_lE8Ypw1rFpa3VD8i7z6VrA_e04wz6Im";
  const tok = (req.headers.authorization || "").replace("Bearer ", "");
  if (!tok) return res.status(401).json({ error: "Please sign in" });
  const u = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_KEY, authorization: "Bearer " + tok } });
  if (!u.ok) return res.status(401).json({ error: "Please sign in again" });

  if (!AKEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set in Vercel. Add it (Settings > Environment Variables), then redeploy." });
  const { image, prompt } = req.body || {};
  if (!image || !prompt) return res.status(400).json({ error: "No image" });

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": AKEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5", max_tokens: 4000, temperature: 0,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
        { type: "text", text: prompt } ] }]
    })
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) return res.status(502).json({ error: "Anthropic rejected the key. Check ANTHROPIC_API_KEY in Vercel, then redeploy." });
  if (r.status === 429) return res.status(429).json({ error: "Too many scans at once. Wait a moment and try again." });
  if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || "AI request failed" });
  const txt = (j.content || []).map(c => c.text || "").join("");
  try { return res.status(200).json(JSON.parse(txt.match(/\{[\s\S]*\}/)[0])); }
  catch (e) { return res.status(502).json({ error: "Could not read the AI answer. Try a clearer photo." }); }
};
module.exports.config = { maxDuration: 60 };
