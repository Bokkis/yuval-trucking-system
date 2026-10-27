// Vercel serverless function: reads a photo of a timesheet (DTR) with AI.
// In Vercel (Settings > Environment Variables) set any of these (tried in this order, next one is used if one fails):
//   GEMINI_API_KEY     - FREE key from Google AI Studio (aistudio.google.com)
//   GROQ_API_KEY       - key from console.groq.com (free plan with limits). Optional GROQ_MODEL.
//   ANTHROPIC_API_KEY  - paid key from console.anthropic.com (needs credit)
// Optional: GEMINI_MODEL, ANTHROPIC_MODEL (default claude-haiku-5-5; claude-sonnet-5-5 is more accurate).
const fail = (status, error) => ({ status, error });

async function gemini(key, image, prompt) {
  const models = [process.env.GEMINI_MODEL || "gemini-3.8-flash", "gemini-3.5-flash"];
  let j = {}, r = null;
  for (const model of models) {
    r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: "image/jpeg", data: image } }, { text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 }
      })
    });
    j = await r.json().catch(() => ({}));
    if (r.status !== 404) break;
  }
  if (r.status === 401 || r.status === 403) return fail(502, "Google rejected the key. Create a new key in AI Studio, update GEMINI_API_KEY in Vercel, then redeploy.");
  if (r.status === 429) return fail(429, "The free limit was reached. Wait a minute and try again.");
  if (!r.ok) return fail(502, (j.error && j.error.message) || "Gemini request failed");
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  return { text: parts.map(p => p.text || "").join("") };
}

// Groq (free plan with limits) - OpenAI-compatible vision API. Model can be changed with GROQ_MODEL.
async function groq(key, image, prompt) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + key, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || "qwen/qwen3.8-27b", temperature: 0, max_completion_tokens: 4000,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: [
        { type: "text", text: prompt + "\nReply with JSON only." },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + image } } ] }]
    })
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) return fail(502, "Groq rejected the key. Check GROQ_API_KEY in Vercel, then redeploy.");
  if (r.status === 429) return fail(429, "Groq free limit reached. Wait a minute and try again.");
  if (!r.ok) return fail(502, (j.error && j.error.message) || "Groq request failed");
  return { text: (((j.choices || [])[0] || {}).message || {}).content || "" };
}

async function claude(key, image, prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5", max_tokens: 4000, temperature: 0,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
        { type: "text", text: prompt } ] }]
    })
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) return fail(502, "Anthropic rejected the key. Check ANTHROPIC_API_KEY in Vercel, then redeploy.");
  if (r.status === 429) return fail(429, "Too many scans at once. Wait a moment and try again.");
  if (!r.ok) return fail(502, (j.error && j.error.message) || "Claude request failed");
  return { text: (j.content || []).map(c => c.text || "").join("") };
}

async function handler(req, res) {
  const GKEY = process.env.GEMINI_API_KEY, AKEY = process.env.ANTHROPIC_API_KEY, QKEY = process.env.GROQ_API_KEY;
  if (req.method === "GET") return res.status(200).json({ ok: true, geminiKeySet: !!GKEY, groqKeySet: !!QKEY, anthropicKeySet: !!AKEY, supabaseVarsSet: !!(process.env.SUPABASE_URL || process.env.SUPABASE_ANON_KEY),
    // names only (never the values) so a typo or hidden space in a variable name is visible
    seenNames: Object.keys(process.env).filter(k => /gemini|groq|anthropic|api_key/i.test(k)) });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // Only signed-in staff may use this (checks the Supabase login).
  // Tries the Vercel variables first, then the built-in project, so a wrong variable cannot lock everyone out.
  const DEF = { url: "https://atkgorpjdiinyycidgqf.supabase.co", key: "sb_publishable_lE8Ypw1rFpa3VD8i7z6VrA_e04wz6Im" };
  const pairs = [];
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) pairs.push({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY });
  pairs.push(DEF);
  const tok = (req.headers.authorization || "").replace("Bearer ", "");
  if (!tok) return res.status(401).json({ error: "Please sign in (no login token was sent)" });
  let okUser = false, why = "";
  for (const p of pairs) {
    try {
      const u = await fetch(p.url.replace(/\/$/, "") + "/auth/v1/user", { headers: { apikey: p.key, authorization: "Bearer " + tok } });
      if (u.ok) { okUser = true; break; }
      const j = await u.json().catch(() => ({}));
      why = u.status + " " + (j.msg || j.message || j.error_description || j.error || "");
    } catch (e) { why = "could not reach Supabase: " + e.message; }
  }
  if (!okUser) return res.status(401).json({ error: "Please sign in again (Supabase said: " + why.trim() + ")" });

  if (!GKEY && !QKEY && !AKEY) return res.status(500).json({ error: "No AI key is set in Vercel. Add GEMINI_API_KEY or GROQ_API_KEY (both free) or ANTHROPIC_API_KEY, then redeploy." });
  const { image, prompt } = req.body || {};
  if (!image || !prompt) return res.status(400).json({ error: "No image" });

  const order = [];
  if (GKEY) order.push(() => gemini(GKEY, image, prompt));
  if (QKEY) order.push(() => groq(QKEY, image, prompt));
  if (AKEY) order.push(() => claude(AKEY, image, prompt));
  let out = null;
  const errs = [];
  for (const run of order) {
    try { out = await run(); } catch (e) { out = fail(502, "AI request crashed: " + (e && e.message || e)); }
    if (out.text) break;
    errs.push(out.error); // fall through to the next AI if one fails
  }
  if (!out.text) return res.status(out.status || 502).json({ error: errs.filter(Boolean).join(" | ") || "AI request failed" });
  try { return res.status(200).json(JSON.parse(out.text.match(/\{[\s\S]*\}/)[0])); }
  catch (e) { return res.status(502).json({ error: "Could not read the AI answer. Try a clearer photo." }); }
};
module.exports = async (req, res) => {
  try { return await handler(req, res); }
  catch (e) { return res.status(500).json({ error: "Scan server error: " + (e && e.message || e) }); }
};
module.exports.config = { maxDuration: 60 };
