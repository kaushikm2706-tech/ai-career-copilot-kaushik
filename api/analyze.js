// Vercel serverless function. The Gemini API key lives ONLY here (environment variable),
// never in the browser. The browser calls POST /api/analyze.
const { VERSIONS, DEFAULT_VERSION } = require("./prompts");

const DEFAULT_MODELS = "gemini-3.8-flash,gemini-3.5-flash-lite,gemini-2.5-flash";
const LIMITS = { resume: 12000, jd: 8000, minResume: 80, minJd: 30 };
const MAX = { rpm: 8 };
const hits = new Map(); // best-effort per-instance rate limit

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 500) hits.clear();
  return arr.length > MAX.rpm;
}

const clean = (s) =>
  String(s || "")
    .replace(/<\/?(resume|job_description)>/gi, "") // stop tag-breaking injection
    .replace(/\u0000/g, "")
    .trim();

const str = (v, n = 220) => String(v == null ? "" : v).trim().slice(0, n);
const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
const num = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));

function extractJson(text) {
  let t = String(text || "").trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(t); } catch (_) {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error("Model did not return JSON");
}

// Turn raw model JSON into a safe, consistent result. Deterministic checks run here, not in the model.
function normalize(raw, resumeText) {
  const bd = raw.score_breakdown || null;
  let score, breakdown = null;
  if (bd) {
    breakdown = {
      keywords: num(bd.keywords, 40), experience: num(bd.experience, 30),
      education: num(bd.education, 10), impact: num(bd.impact, 10), clarity: num(bd.clarity, 10),
    };
    score = Object.values(breakdown).reduce((a, b) => a + b, 0); // total recomputed, never trusted
  } else {
    score = num(raw.ats_score, 100);
  }
  const lower = resumeText.toLowerCase();
  const missingRaw = arr(raw.missing_keywords, 12).map((k) => str(k, 60)).filter(Boolean);
  const missing = missingRaw.filter((k) => !lower.includes(k.toLowerCase())); // fact-check: drop "missing" skills that ARE in the resume
  const removed = missingRaw.length - missing.length;
  const verdict = score >= 80 ? "Strong match" : score >= 65 ? "Good match" : score >= 45 ? "Partial match" : "Weak match";
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentions = (text, kw) => new RegExp("(^|[^a-z0-9+#.])" + esc(kw.toLowerCase()) + "($|[^a-z0-9+#.])", "i").test(text);
  const pr = (p) => (["high", "medium", "low"].includes(String(p).toLowerCase()) ? String(p).toLowerCase() : "medium");
  return {
    ats_score: score,
    score_breakdown: breakdown,
    verdict,
    summary: str(raw.summary, 400),
    matched_keywords: arr(raw.matched_keywords, 8).map((k) => str(k, 60)).filter(Boolean),
    missing_keywords: missing.slice(0, 8),
    strengths: arr(raw.strengths, 4).map((s) => ({ point: str(s && s.point), evidence: str(s && s.evidence) })),
    // guard: a suggested bullet must not claim a skill that the fact-check says is absent from the resume
    improvements: arr(raw.improvements, 5).map((s) => {
      const rw = str(s && s.example_rewrite, 300);
      return { issue: str(s && s.issue), fix: str(s && s.fix, 300), example_rewrite: rw,
        unsupported_skills: missing.filter((k) => mentions(rw, k)).slice(0, 4) };
    }),
    skill_gaps: arr(raw.skill_gaps, 5).map((s) => ({
      skill: str(s && s.skill, 80), priority: pr(s && s.priority), how_to_close: str(s && s.how_to_close, 300),
    })),
    action_plan: arr(raw.action_plan, 6).map((s) => str(s, 250)),
    interview_questions: arr(raw.interview_questions, 5).map((s) => str(s, 250)),
    checks: { keywords_removed_by_fact_check: removed },
  };
}

async function callGemini(model, key, system, userText, timeoutMs, fetchImpl) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig: { temperature: 0.3, responseMimeType: "application/json", maxOutputTokens: 8192 },
      }),
      signal: ctrl.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error((data.error && data.error.message) || `HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const text = parts.map((p) => p.text || "").join("");
    if (!text) throw Object.assign(new Error("Empty response (possibly blocked)"), { status: 502 });
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function handler(req, res, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const env = deps.env || process.env;
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      configured: !!env.GEMINI_API_KEY,
      default_version: DEFAULT_VERSION,
      versions: Object.values(VERSIONS).map((v) => ({ id: v.id, label: v.label, note: v.note })),
    });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const key = env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "Server is missing GEMINI_API_KEY. Add it in Vercel > Settings > Environment Variables, then redeploy." });

  const ip = String((req.headers && (req.headers["x-forwarded-for"] || "")) || "local").split(",")[0].trim();
  if (rateLimited(ip)) return res.status(429).json({ error: "Too many requests. Wait a minute and try again." });

  const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch (_) { return {}; } })() : req.body || {};
  const resume = clean(body.resume), jd = clean(body.jobDescription);
  if (resume.length < LIMITS.minResume) return res.status(400).json({ error: `Resume text is too short (min ${LIMITS.minResume} characters).` });
  if (jd.length < LIMITS.minJd) return res.status(400).json({ error: `Job description is too short (min ${LIMITS.minJd} characters).` });
  if (resume.length > LIMITS.resume || jd.length > LIMITS.jd) return res.status(400).json({ error: `Too long. Max ${LIMITS.resume} characters for resume and ${LIMITS.jd} for job description.` });

  const version = VERSIONS[body.promptVersion] || VERSIONS[DEFAULT_VERSION];
  const userText = `<resume>\n${resume}\n</resume>\n\n<job_description>\n${jd}\n</job_description>\n\nReturn the JSON object now.`;
  const models = String(env.GEMINI_MODELS || DEFAULT_MODELS).split(",").map((m) => m.trim()).filter(Boolean);

  const tried = [];
  let fatal = null;
  for (const model of models) {
    try {
      const text = await callGemini(model, key, version.system, userText, 25000, fetchImpl);
      let parsed;
      try { parsed = extractJson(text); }
      catch (e) { tried.push(`${model}: invalid JSON`); continue; }
      const result = normalize(parsed, resume);
      result.meta = { model, prompt_version: version.id, tried: tried.slice() };
      return res.status(200).json(result);
    } catch (e) {
      tried.push(`${model}: ${e.status || "error"} ${String(e.message).slice(0, 120)}`);
      // bad/expired key or permission: no point trying other models
      if (e.status === 401 || e.status === 403 || /API key not valid|API_KEY_INVALID/i.test(e.message)) {
        fatal = "The Gemini API key was rejected. Check GEMINI_API_KEY in Vercel and redeploy.";
        break;
      }
    }
  }
  return res.status(fatal ? 500 : 502).json({ error: fatal || "All configured models failed. Try again in a minute, or update GEMINI_MODELS.", tried });
}

module.exports = (req, res) => handler(req, res);
module.exports.handler = handler;
module.exports._internal = { normalize, extractJson };
