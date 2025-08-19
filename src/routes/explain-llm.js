// src/routes/explain-llm.js
import OpenAI from 'openai';
import { normalizeCanonicalText } from '../lib/canon.js';
import { getJD, getResume } from '../shared/storage.js';
import { getEmbedding, getEmbeddingModel, signalCacheKey } from '../lib/embeddings.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const LLM_MODEL = process.env.EXPLAIN_LLM_MODEL || 'gpt-4o-mini';

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const L = Math.min(a.length, b.length);
  for (let i = 0; i < L; i++) { const x=a[i], y=b[i]; dot += x*y; na += x*x; nb += y*y; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function splitSentences(t) {
  return (t || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map(s => s.trim())
    .filter(s => s.length >= 20 && s.length <= 600)
    .slice(0, 500);
}

function buildJdSignal(jdObj = {}, jdText = '') {
  if (jdObj && Object.keys(jdObj).length) {
    const ro = jdObj.roleOrg || {};
    const log = jdObj.logistics || {};
    const ss  = jdObj.successSignals || {};
    const title = ro.title || '';
    const funcs = (ro.functions || []).join(', ');
    const skills = (ss.topHardSkills || []).join(', ');
    const outcomes = (ss.keyOutcomes || []).map(o => o?.text).filter(Boolean).join(', ');
    const langs = (log.languages || []).join(', ');
    const parts = [
      title && `TITLE ${title}`,
      funcs && `FUNCTIONS ${funcs}`,
      skills && `SKILLS ${skills}`,
      outcomes && `OUTCOMES ${outcomes}`,
      langs && `LANGUAGES ${langs}`,
    ].filter(Boolean);
    return parts.join(' | ');
  }
  return normalizeCanonicalText(jdText || '', { flatten: 'soft' });
}

function verdictFor(cos) {
  if (cos >= 0.62) return 'Fit verdict: **Strong**';
  if (cos >= 0.52) return 'Fit verdict: **Moderate**';
  return 'Fit verdict: **Light**';
}

export default async function explainLLMRoutes(app) {
  app.post('/v1/explain-llm', async (req, reply) => {
    try {
      const body = await req.body;
      const {
        jdText = null,
        jdHash = null,
        resumeText = null,
        resumeId = null,
        topK = 18,
        temperature = 0.2
      } = body || {};

      // --- Resolve JD text / JD signal
      let jdObj = null;
      let rawJdText = jdText;
      if (!rawJdText && jdHash) {
        const rec = getJD(jdHash);
        if (!rec) return reply.code(404).send({ error: `JD not found: ${jdHash}` });
        jdObj = rec.jd || {};
        rawJdText = (rec.metadata?.jdText || '').toString();
      }
      if (!rawJdText && !jdObj) {
        return reply.code(400).send({ error: 'Provide jdText or jdHash' });
      }
      const jdSignal = buildJdSignal(jdObj, rawJdText);
      const jdSignalNorm = normalizeCanonicalText(jdSignal, { flatten: 'soft' });

      // --- Resolve Resume text
      let cvText = resumeText;
      let resumeLabel = 'inline';
      if (!cvText && resumeId) {
        const r = getResume(resumeId);
        if (!r) return reply.code(404).send({ error: `Resume not found: ${resumeId}` });
        resumeLabel = resumeId;
        cvText = r?.canonicalText || r?.text?.canonical || r?.text || '';
      }
      if (!cvText) return reply.code(400).send({ error: 'Provide resumeText or resumeId' });
      const cvCanonical = normalizeCanonicalText(cvText, { flatten: 'soft' });

      // --- Base sims
      const [jdVec, cvVec] = await Promise.all([
        getEmbedding(jdSignalNorm, signalCacheKey('jdSignal', jdHash || 'inline', jdSignalNorm)),
        getEmbedding(cvCanonical,  signalCacheKey('cvRaw', resumeLabel, cvCanonical.slice(0, 8192)))
      ]);
      const semanticCosine = Number(cosine(cvVec, jdVec).toFixed(4));
      const cvShort = cvCanonical.slice(0, 4000);
      const cvShortVec = await getEmbedding(cvShort, signalCacheKey('cvShort', resumeLabel, cvShort));
      const fullTextCosine = Number(cosine(cvShortVec, jdVec).toFixed(4));

      // --- Evidence selection (top-K sentences)
      const sentences = splitSentences(cvCanonical);
      const sentVecs = await Promise.all(
        sentences.map((s,i) =>
          getEmbedding(s, signalCacheKey('sent', `cv:${resumeLabel}`, `${i}:${s.slice(0,64)}`))
        )
      );
      const ranked = sentences
        .map((s, i) => ({ idx: i, text: s, cos: cosine(sentVecs[i], jdVec) }))
        .sort((a,b) => b.cos - a.cos)
        .slice(0, Math.max(6, Math.min(40, topK)));

      // --- LLM prompt → Markdown (chat-ready)
      const sys = [
        "You are a seasoned recruiter. Write a crisp 30-second read that explains why the candidate fits the role.",
        "Use the JD summary and the evidence sentences only; do not invent facts.",
        "Be concrete and specific. No fluff. Prefer bullets.",
        "Keep total length ~120–150 words."
      ].join(' ');

      const evidenceMd = ranked.map(r => `[#${r.idx}] ${r.text}`).join('\n');
      const user = [
        `JD SUMMARY:\n${jdSignalNorm}\n`,
        `EVIDENCE (top ${ranked.length} resume snippets):\n${evidenceMd}\n`,
        `BASE SCORES: semantic=${semanticCosine}  text=${fullTextCosine}\n`,
        "Write Markdown with this shape:",
        "## Why this candidate fits",
        "- 4–6 bullets with concrete reasons tied to the JD (cite evidence indexes like [#12] where relevant).",
        "### Potential risks",
        "- 1–3 short bullets",
        "### Follow-ups",
        "- 2–3 short bullets",
        `**${verdictFor(semanticCosine)}**`,
        "Do not include any JSON or code fences.",
      ].join('\n');

      const resp = await client.chat.completions.create({
        model: LLM_MODEL,
        temperature,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user }
        ]
      });

      const text = resp.choices?.[0]?.message?.content?.trim() || 'No explanation generated.';
      reply.header('Content-Type', 'text/markdown; charset=utf-8');
      return reply.send(text);
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: 'EXPLAIN_LLM_FAILED', message: e.message });
    }
  });
}
