import OpenAI from 'openai';

// Import the resume storage (in production, this would be a database)
// For now, we'll access it through a shared module or move it to a proper storage layer
let resumeStorage;

// This function will be called by the main server to share the storage
export function setResumeStorage(storage) {
  resumeStorage = storage;
}

export default async function queryRoute(app) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  app.post('/v1/query', async (req, reply) => {
    if (!process.env.OPENAI_API_KEY) {
      return reply.code(500).send(err('CONFIG', 'OPENAI_API_KEY not set'));
    }

    try {
      const body = await req.body;
      const resumeId = (body?.resumeId || '').toString();
      const question = (body?.question || '').toString();

      if (!resumeId || !question) {
        return reply.code(400).send(err('BAD_REQUEST', 'Required: { resumeId, question }'));
      }

      // Fetch canonical text from storage
      const resumeData = resumeStorage?.get(resumeId);
      if (!resumeData) {
        return reply.code(404).send(err('NOT_FOUND', 'Resume not found. Please upload first.'));
      }

      const { canonicalText, name, email } = resumeData;

      // Use the canonical text directly instead of re-uploading the file
      const prompt = `Use the following résumé text to answer the question succinctly. If sections are present, respect them.

Resume Information:
- Name: ${name || 'Not provided'}
- Email: ${email || 'Not provided'}

Resume Text:
${canonicalText}

Question: ${question}`;

              const resp = await openai.responses.create({
                        model: process.env.OPENAI_MODEL || 'gpt-5-nano',
          input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: prompt }
            ]
          }
        ]
      });

      const text = resp.output_text || '';
      return reply.send({ 
        text,
        resumeId,
        question,
        textLength: canonicalText.length
      });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send(err('QUERY_ERROR', 'Query failed', { hint: e.message }));
    }
  });
}

function err(code, message, details = {}) {
  return { error: { code, message, details } };
}
