// Vercel serverless function: reads a photo of a timesheet (DTR) with AI.
// Set ONE of these environment variables in Vercel (Settings > Environment Variables):
//   GEMINI_API_KEY     - free key from Google AI Studio (aistudio.google.com)
//   ANTHROPIC_API_KEY  - paid key from console.anthropic.com
// If both are set, Gemini is used.
module.exports = async (req, res) => {
  const GKEY = process.env.GEMINI_API_KEY, AKEY = process.env.ANTHROPIC_API_KEY;
  if (req.method === "GET") return res.status(200).json({ ok: true, geminiKeySet: !!GKEY, anthropicKeySet: !!AKEY });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Only signed-in staff may use this (checks the Supabase login).
  const SB_URL = process.env.SUPABASE_URL || "https://atkgorpjdiinyycidgqf.supabase.co";
  const SB_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_lE8Ypw1rFpa3VD8i7z6VrA_e04wz6Im";
  const tok = (req.headers.authorization || "").replace("Bearer ", "");
  if (!tok) return res.status(401).json({ error: "Please sign in" });
  const u = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_KEY, authorization: "Bearer " + tok } });
  if (!u.ok) return res.status(401).json({ error: "Please sign in again" });

  if (!GKEY && !AKEY) return res.status(500).json({ error: "No AI key is set in Vercel. Add GEMINI_API_KEY (free) or ANTHROPIC_API_KEY, then redeploy." });
  const { image, prompt } = req.body || {};
  if (!image || !prompt) return res.status(400).json({ error: "No image" });

  let txt = "";
  if (GKEY) {
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
      method: "POST",
      headers: { "x-goog-api-key": GKEY, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: "image/jpeg", data: image } }, { text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 }
      })
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 429) return res.status(429).json({ error: "The free limit was reached. Wait a minute and try again." });
    if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || "Gemini request failed" });
    const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    txt = parts.map(p => p.text || "").join("");
  } else {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": AKEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5-5", max_tokens: 4000,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
          { type: "text", text: prompt } ] }]
      })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || "AI request failed" });
    txt = (j.content || []).map(c => c.text || "").join("");
  }
  try { return res.status(200).json(JSON.parse(txt.match(/\{[\s\S]*\}/)[0])); }
  catch (e) { return res.status(502).json({ error: "Could not read the AI answer. Try a clearer photo." }); }
};
module.exports.config = { maxDuration: 60 };
