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
        'Return ONLY valid JSON with this exact schema: { "items": [{ "title": string, "description": string }] }.',
        'Rules:',
        '- Consider primary categories: >6 month employment gaps; <12 month tenures; missing degree; unreadable formatting.',
        '- ALSO consider other objective red flags: overlapping/contradictory dates; unrealistic rapid progressions/titles; implausible or impossible skill claims; overstuffed skill lists suggesting implausible breadth; inconsistencies between roles and qualifications; potential scam indicators.',
        '- Each item: title is 1–3 words (e.g., "Employment gap", "Short tenure", "Overclaiming skills").',
        '- Description: one short sentence with specifics (dates/employers/facts) in neutral tone.',
        '- Max 5 items. Neutral, factual. No advice or praise.',
        '- If no red flags: return { "items": [] }.',
        'Output JSON only. No markdown. No extra keys.'
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
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { items: [] };
      }
      if (!parsed || !Array.isArray(parsed.items)) parsed = { items: [] };
      const items = parsed.items
        .filter((it) => it && typeof it === 'object')
        .slice(0, 5)
        .map((it) => ({
          title: typeof it.title === 'string' ? it.title.trim() : '',
          description: typeof it.description === 'string' ? it.description.trim() : ''
        }))
        .filter((it) => it.title && it.description);

      return reply.send({ items });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send(err('OPENAI_ERROR', 'Red flag scan failed', { hint: e.message }));
    }
  });
}

function err(code, message, details = {}) {
  return { error: { code, message, details } };
}
