import OpenAI from 'openai';

export default async function redflagsRoute(app) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  app.post('/v1/redflags', async (req, reply) => {
    if (!process.env.OPENAI_API_KEY) {
      return reply.code(500).send(err('CONFIG', 'OPENAI_API_KEY not set'));
    }

    try {
      const body = await req.body;
      const fileId = (body?.fileId || '').toString();
      const resumeText = (body?.text || '').toString();

      const hasFile = !!fileId;
      const hasText = !!resumeText.trim();
      if ((hasFile && hasText) || (!hasFile && !hasText)) {
        return reply.code(400).send(err('BAD_REQUEST', 'Provide either fileId OR text, not both'));
      }

      const prompt = [
        'You are MatchAGig Red-Flag Scanner, an AI assistant for résumé screening.',
        'Identify objective red flags only. Primary categories:',
        '- Gaps in employment longer than 6 months.',
        '- Job tenures of less than 12 months.',
        "- Missing educational degree (e.g., bachelor's, associate's, etc.).",
        '- Résumés with formatting so poor that key details are unreadable or unclear.',
        'Also include other major objective red flags such as overlapping dates, unrealistic progressions or titles, significant inconsistencies between roles and qualifications, excessive job hopping.',
        'For each red flag, provide a short, clear 1-sentence explanation. Limit to 5 items maximum.',
        'If no red flags are found, respond exactly with: “✅ No major red flags”.',
        'Output format policy:',
        '- If flags exist, output 1 line per flag, each starting with "- ".',
        '- No other text before or after. No headings. No extra commentary. Strictly neutral tone.'
      ].join(' ');

      const content = [{ type: 'input_text', text: prompt }];
      if (hasFile) {
        content.push({ type: 'input_file', file_id: fileId });
      } else {
        content.push({ type: 'input_text', text: `\n\nRESUME (plain text):\n${resumeText}` });
      }

      const resp = await openai.responses.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        input: [{ role: 'user', content }]
      });

      const text = (resp.output_text || '').trim();
      return reply.send({ text });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send(err('OPENAI_ERROR', 'Red flag scan failed', { hint: e.message }));
    }
  });
}

function err(code, message, details = {}) {
  return { error: { code, message, details } };
}
