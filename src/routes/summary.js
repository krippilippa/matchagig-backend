import OpenAI from 'openai';

export default async function summaryRoute(app) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  app.post('/v1/summary', async (req, reply) => {
    if (!process.env.OPENAI_API_KEY) {
      return reply.code(500).send(err('CONFIG', 'OPENAI_API_KEY not set'));
    }

    try {
      const body = await req.body;
      const fileId = (body?.fileId || '').toString();
      const resumeText = (body?.text || '').toString();
      const jobTitle = (body?.jobTitle || '').toString();

      const hasFile = !!fileId;
      const hasText = !!resumeText.trim();
      if ((hasFile && hasText) || (!hasFile && !hasText)) {
        return reply.code(400).send(err('BAD_REQUEST', 'Provide either fileId OR text, not both'));
      }

      const promptHeader = (
        'You are a Resume Summary AI assistant designed to help recruiters and hiring decision-makers quickly understand a candidate’s profile.\n\n' +
        'Your task:\n' +
        'Given a résumé (text or PDF) and optionally a target job title, produce output in exactly the following structure — no extra text, no headings beyond what is specified.\n\n' +
        '### Summary bullets (Always required)\n' +
        '- Output exactly 5 bullets.\n' +
        '- Each bullet must be 12–16 words maximum.\n' +
        '- Each bullet must begin with a **bold theme word** followed by a colon (e.g., **Experience:**, **Skills:**, **Certifications:**, **Projects:**, **Education:**).\n' +
        '- Summarize factual experience, skills, and qualifications from the résumé.\n' +
        '- Use concrete facts, metrics, and outcomes when available.\n' +
        '- If a job title is provided, emphasize relevance to that role.\n' +
        '- Maintain strict neutrality — no praise, no negative tone, no subjective language.\n\n' +
        '### Concerns & Requirements (Conditional)\n' +
        '- Include this section only if a job title is provided.\n' +
        '- Title it exactly: **Concerns & Requirements:**\n' +
        '- List bullet points for potential concerns or missing hard requirements. If none, write exactly: `No concerns identified.`\n\n' +
        '### Fit Signal (Always required)\n' +
        '- On a single final line, write: **Fit signal:** <3–6 keywords from résumé aligned to the role or general profile> (do not bold the keywords, only the label).\n\n' +
        'Strict formatting rules:\n' +
        '1. Output order: Summary bullets (5) → Concerns & Requirements (only if job title provided) → Fit signal line.\n' +
        '2. No introductions, no conclusions, no explanations.\n' +
        '3. All bullets must use the standard hyphen `-` followed by a space.\n' +
        '4. Never exceed 16 words per bullet.'
      );

      const userContext = jobTitle ? `\n\nTarget job title: ${jobTitle}` : '';

      const content = [
        { type: 'input_text', text: promptHeader + userContext }
      ];

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
      return reply.code(500).send(err('OPENAI_ERROR', 'Summary generation failed', { hint: e.message }));
    }
  });
}

function err(code, message, details = {}) {
  return { error: { code, message, details } };
}
