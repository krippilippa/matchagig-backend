// src/routes/explain-llm.js
import OpenAI from 'openai';
import { normalizeCanonicalText } from '../lib/canon.js';
import { getJD } from '../shared/storage.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const LLM_MODEL = process.env.EXPLAIN_LLM_MODEL || 'gpt-5';

export default async function explainLLMRoutes(app) {
  app.post('/v1/explain-llm', async (req, reply) => {
    try {
      const body = await req.body;
      const { jdHash = '', resumeText = '' } = body || {};

      if (!jdHash.trim()) return reply.code(400).send({ error: 'Provide jdHash' });
      if (!resumeText.trim()) return reply.code(400).send({ error: 'Provide resumeText' });

      // Fetch JD from storage using hash
      const jdRecord = getJD(jdHash);
      if (!jdRecord) {
        return reply.code(404).send({ error: `JD not found: ${jdHash}` });
      }

      // Get the JD data - either structured or raw text
      const jdData = jdRecord?.metadata?.jdText || '';

      if (!jdData) {
        return reply.code(400).send({ error: 'JD content not found' });
      }

      // Light normalization + clipping to keep tokens sane
      const jd = normalizeCanonicalText(jdData, { flatten: 'soft' }).slice(0, 8000);
      const cv = normalizeCanonicalText(resumeText, { flatten: 'soft' }).slice(0, 10000);

      const systemPrompt = [
        'You are an experienced recruiter.',
        'Give an honest, concise, caution-leaning assessment of fit between the job and the resume.',
        'Aim for roughly a 30-second read (~120–180 words).',
        'Use Markdown',
        'Base your reasoning on the provided texts; avoid overselling.',
        'End with a single line: **Verdict: Negative | Maybe | Positive**.'
      ].join(' ');

      const userPrompt = [
        'JOB DESCRIPTION (canonical text):',
        jd,
        '',
        'RESUME (canonical text):',
        cv,
        '',
        'Write a brief assessment if this resume fulfills what this job description is looking for',
        'Be candid',
        'Finish with the verdict line exactly as specified.'
      ].join('\n');

      console.log("start......");

      const resp = await client.chat.completions.create({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]
      });

      const md = resp.choices?.[0]?.message?.content?.trim() || 'No analysis generated.';
      reply.header('Content-Type', 'text/markdown; charset=utf-8');
      return reply.send(md);
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: 'EXPLAIN_LLM_FAILED', message: e.message });
    }
  });
}
