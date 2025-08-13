import OpenAI from 'openai';

export default async function queryRoute(app) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  app.post('/v1/query', async (req, reply) => {
    if (!process.env.OPENAI_API_KEY) {
      return reply.code(500).send(err('CONFIG', 'OPENAI_API_KEY not set'));
    }

    try {
      const body = await req.body;
      const fileId = (body?.fileId || '').toString();
      const question = (body?.question || '').toString();

      if (!fileId || !question) {
        return reply.code(400).send(err('BAD_REQUEST', 'Required: { fileId, question }'));
      }

      const prompt = 'Use the attached résumé to answer succinctly. If sections are present, respect them.\n\nQuestion: ' + question;

      const resp = await openai.responses.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: prompt },
              { type: 'input_file', file_id: fileId }
            ]
          }
        ]
      });

      const text = resp.output_text || '';
      return reply.send({ text });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send(err('OPENAI_ERROR', 'Query failed', { hint: e.message }));
    }
  });
}

function err(code, message, details = {}) {
  return { error: { code, message, details } };
}
