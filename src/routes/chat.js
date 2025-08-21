import OpenAI from 'openai';
import { normalizeCanonicalText } from '../lib/canon.js';
import { getJD } from '../shared/storage.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.CHAT_LLM_MODEL || 'gpt-5';

function buildSystemPrompt() {
  return [
    'You are an experienced recruiter working inside a live chat.',
    'Context is a single job description and one candidate resume.',
    'Be honest and slightly cautious rather than optimistic.',
    'Write in clean Markdown. Keep answers concise by default.',
    'If asked to draft emails or questions, produce directly usable, copy-ready outputs.',
    'If information is missing, say so plainly and suggest the smallest next step.'
  ].join(' ');
}

function buildContextBlock(jdHash, resumeText) {
  // Fetch JD text from storage
  const jdRecord = getJD(jdHash);
  if (!jdRecord) {
    throw new Error(`JD not found: ${jdHash}`);
  }
  
  const jdText = jdRecord?.metadata?.jdText || '';
  if (!jdText) {
    throw new Error(`JD content not found for hash: ${jdHash}`);
  }
  
  // Light normalization + clipping to control tokens
  const jd = normalizeCanonicalText(jdText, { flatten: 'soft' }).slice(0, 9000);
  const cv = normalizeCanonicalText(resumeText || '', { flatten: 'soft' }).slice(0, 11000);
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

/**
 * Optional quick-action instruction presets (triggered by `mode`)
 * You can expand these later.
 */
const MODE_INSTRUCTIONS = {
  interview_questions:
    'Generate 6 sharp interview questions to verify the most uncertain or high-risk requirements from the JD. For each: what good/OK/poor answers sound like (brief rubric).',
  email_candidate:
    'Draft a short outreach email to the candidate (≤130 words). Tone: warm + concise. Include 2 time options, subject line, and a single CTA.',
  email_hiring_manager:
    'Summarize this candidate for the hiring manager: 3 bullets strengths, 2 bullets risks, a one-line verdict, and a suggested next step.',
  summary_for_client:
    'Write a crisp candidate summary for a client: role fit, key evidence, main risk, and recommendation. ≤120 words.'
};

export default async function chatRoutes(app) {
  app.post('/v1/chat', async (req, reply) => {
    try {
      const body = await req.body;
      const { jdHash, resumeText, messages, mode } = body || {};

      if (!jdHash?.trim())   return reply.code(400).send({ error: 'Provide jdHash' });
      if (!resumeText?.trim()) return reply.code(400).send({ error: 'Provide resumeText' });
      if (!Array.isArray(messages)) return reply.code(400).send({ error: 'Provide messages[]' });

      // Keep only the last few exchanges to limit tokens (MVP-safe)
      const MAX_TURNS = 8; // user+assistant turns
      const trimmed = messages.slice(-MAX_TURNS * 2);

      const system = buildSystemPrompt();
      const context = buildContextBlock(jdHash, resumeText);

      // If a quick-action `mode` is passed, prepend a tiny instruction to the last user turn
      let finalMessages = trimmed;
      if (mode && MODE_INSTRUCTIONS[mode]) {
        finalMessages = [
          ...trimmed,
          { role: 'user', content: `[Quick action: ${mode}]\n\n${MODE_INSTRUCTIONS[mode]}` }
        ];
      }

      const chat = [
        { role: 'system', content: system },
        // pin the context as an assistant message so it isn't "user text"
        { role: 'assistant', content: context },
        ...finalMessages
      ];

      const resp = await client.chat.completions.create({
        model: MODEL,
        messages: chat
      });

      const md = resp.choices?.[0]?.message?.content?.trim() || 'No reply.';
      reply.header('Content-Type', 'text/markdown; charset=utf-8');
      return reply.send(md);
    } catch (e) {
      req.log.error(e);
      
      // Handle specific JD-related errors
      if (e.message.includes('JD not found') || e.message.includes('JD content not found')) {
        return reply.code(404).send({ error: 'JD_NOT_FOUND', message: e.message });
      }
      
      return reply.code(500).send({ error: 'CHAT_FAILED', message: e.message });
    }
  });
}
