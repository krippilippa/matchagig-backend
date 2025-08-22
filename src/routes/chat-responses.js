import OpenAI from 'openai';
import { normalizeCanonicalText } from '../lib/canon.js';
import { getJD } from '../shared/storage.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-5-nano';

// In-memory storage for thread persistence (TODO: swap to Redis/DB in prod)
const threadStorage = new Map();

function buildSystemPrompt() {
  return [
    'You are an experienced recruiter in a live chat.',
    'Use the provided JD and Resume as ground truth.',
    'Be concise by default and answer exactly what was asked.',
    'If the user asks for a single field (name/email/phone/location), reply with ONLY that field, nothing else.',
    'If info is missing, say so plainly and suggest the smallest next step.'
  ].join(' ');
}

function buildContextBlock(jd, cv) {
  return [
    '### Context (ground truth)',
    '',
    '#### Job Description',
    jd,
    '',
    '#### Resume',
    cv,
    '',
    '---',
    'Use this context for all answers in this chat.'
  ].join('\n');
}

export default async function chatResponsesRoutes(app) {
  app.post('/v1/chat/seed', async (req, reply) => {
    try {
      const body = await req.body;
      const { candidateId, jdHash, resumeText } = body || {};

      // Validation
      if (!candidateId?.trim()) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Provide candidateId' });
      }
      if (!jdHash?.trim()) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Provide jdHash' });
      }
      if (!resumeText?.trim()) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Provide resumeText' });
      }

      // Fetch JD from storage
      const jdRecord = getJD(jdHash);
      if (!jdRecord) {
        return reply.code(404).send({ error: 'JD_NOT_FOUND', message: `JD not found: ${jdHash}` });
      }
      
      const jdText = jdRecord?.metadata?.jdText || '';
      if (!jdText) {
        return reply.code(404).send({ error: 'JD_NOT_FOUND', message: `JD content not found for hash: ${jdHash}` });
      }

      // Normalize + clip both JD and resume using canon helper (same as routes/chat.js)
      const jd = normalizeCanonicalText(jdText, { flatten: 'soft' }).slice(0, 9000);
      const cv = normalizeCanonicalText(resumeText || '', { flatten: 'soft' }).slice(0, 11000);

      const systemPrompt = buildSystemPrompt();
      const contextBlock = buildContextBlock(jd, cv);

      // Call Responses API and store: true
      const r = await client.responses.create({
        model: MODEL,
        store: true,
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'assistant', content: contextBlock }
        ]
      });

      // Store thread info per candidateId
      threadStorage.set(candidateId, {
        previousResponseId: r.id,
        jdHash: jdHash
      });

      return reply.send({ ok: true, previousResponseId: r.id });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: 'CHAT_FAILED', message: e.message });
    }
  });

  app.post('/v1/chat/ask', async (req, reply) => {
    try {
      const body = await req.body;
      const { candidateId, text } = body || {};

      // Validation
      if (!candidateId?.trim()) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Provide candidateId' });
      }
      if (!text?.trim()) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: 'Provide text' });
      }

      // Lookup thread by candidateId
      const thread = threadStorage.get(candidateId);
      if (!thread) {
        return reply.code(404).send({ error: 'THREAD_NOT_FOUND', message: 'Seed the thread first.' });
      }

      // Call OpenAI Responses API
      const r = await client.responses.create({
        model: MODEL,
        previous_response_id: thread.previousResponseId,
        input: [{ role: 'user', content: text }]
      });

      // Update stored previousResponseId
      thread.previousResponseId = r.id;
      threadStorage.set(candidateId, thread);

      return reply.send({ text: r.output_text, previousResponseId: r.id });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: 'CHAT_FAILED', message: e.message });
    }
  });
}
