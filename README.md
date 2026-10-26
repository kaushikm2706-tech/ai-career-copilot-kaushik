# Fresher Copilot (AI Career Copilot)

Paste a resume and a job description, get an honest ATS-style score, missing keywords, skill gaps, rewritten bullets, a 30-day plan and likely interview questions. Built with the Gemini API and deployed on Vercel.

**Author:** Kaushik M

## What makes it more than the starter
- **Prompt engineering (ROLE + TASK + FORMAT + RULES)** with a scoring rubric, a few-shot example, and a prompt-injection defense.
- **Prompt versioning:** v1 (baseline) vs v2 (engineered) selectable in the UI to compare outputs.
- **Multi-model fallback:** tries a list of Gemini models in order (`GEMINI_MODELS`).
- **Deterministic checks on the AI output (server side):** the score is recomputed from the rubric parts, "missing" keywords that are actually in the resume are removed, and the verdict is derived from the score.
- **Secure by design:** the API key lives only in a Vercel environment variable, used by `api/analyze.js`. It is never sent to the browser. Input size limits and a per-IP rate limit.
- **PDF upload** (pdf.js), **history** (localStorage), **5 built-in test cases** (including a prompt-injection resume), dark mode, print to PDF.

## Run the tests (no API key needed)
```
node test/handler.test.js
```

## Deploy
1. Put these files in a GitHub repo (keep the `api/` folder).
2. Import the repo in Vercel (Framework Preset: Other).
3. Vercel > Project > Settings > Environment Variables: add `GEMINI_API_KEY`. Optional: `GEMINI_MODELS` (comma-separated, see `.env.example`).
4. Redeploy.

## Files
- `index.html`, `samples.js`: the UI
- `api/analyze.js`: serverless function that calls Gemini
- `api/prompts.js`: the versioned prompts
- `test/handler.test.js`: offline tests
