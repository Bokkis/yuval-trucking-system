// Vercel serverless function: reads a photo of a timesheet with Claude.
// Needs the environment variable ANTHROPIC_API_KEY in your Vercel project settings.
module.exports = async (req, res) => {
  if (req.method === "GET") return res.status(200).json({ ok: true, anthropicKeySet: !!process.env.ANTHROPIC_API_KEY });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const SB_URL = process.env.SUPABASE_URL || "https://atkgorpjdiinyycidgqf.supabase.co";
  const SB_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_lE8Ypw1rFpa3VD8i7z6VrA_e04wz6Im";
  const tok = (req.headers.authorization || "").replace("Bearer ", "");
  if (!tok) return res.status(401).json({ error: "Please sign in" });
  const u = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_KEY, authorization: "Bearer " + tok } });
  if (!u.ok) return res.status(401).json({ error: "Please sign in again" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set in Vercel" });
  const { image, prompt } = req.body || {};
  if (!image || !prompt) return res.status(400).json({ error: "No image" });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5-5", max_tokens: 4000,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
        { type: "text", text: prompt } ] }]
    })
  });
  const j = await r.json();
  if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || "AI request failed" });
  const txt = (j.content || []).map(c => c.text || "").join("");
  try { return res.status(200).json(JSON.parse(txt.match(/\{[\s\S]*\}/)[0])); }
  catch (e) { return res.status(502).json({ error: "Could not read the AI answer" }); }
};
module.exports.config = { maxDuration: 60 };
