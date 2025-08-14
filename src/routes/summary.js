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

      const hasFile = !!fileId;
      const hasText = !!resumeText.trim();
      if ((hasFile && hasText) || (!hasFile && !hasText)) {
        return reply.code(400).send(err('BAD_REQUEST', 'Provide either fileId OR text, not both'));
      }

      const prompt = [
        'You are an objective résumé data extractor. Return ONLY valid JSON describing the candidate. Schema:',
        '{ "jobsCount": number, "yearsExperience": number|null, "companies": string[], "roles": string[],',
        '  "education": [{ "degree": string|null, "field": string|null, "institution": string|null, "year": string|null }],',
        '  "hardSkills": string[], "softSkills": string[] }.',
        'Guidelines:',
        '- Be strictly factual. Do NOT invent. If unknown, use null (for fields) or [] (for arrays).',
        '- Derive jobsCount from distinct employment entries. Estimate yearsExperience if feasible; else null.',
        '- companies: list unique organization names. roles: list unique job titles.',
        '- education: extract degree/field/institution/year when present; otherwise nulls.',
        '- hardSkills: concrete tools/technologies/languages/frameworks. softSkills: interpersonal/communication/leadership/etc.',
        'Output JSON only. No markdown. No extra keys.'
      ].join(' ');

      const content = [
        { type: 'input_text', text: prompt }
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
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { jobsCount: 0, yearsExperience: null, companies: [], roles: [], education: [], hardSkills: [], softSkills: [] };
      }
      const safe = {
        jobsCount: Number.isFinite(parsed.jobsCount) ? parsed.jobsCount : 0,
        yearsExperience: typeof parsed.yearsExperience === 'number' && parsed.yearsExperience >= 0 ? parsed.yearsExperience : null,
        companies: Array.isArray(parsed.companies) ? parsed.companies.filter((s) => typeof s === 'string' && s.trim()).slice(0, 50) : [],
        roles: Array.isArray(parsed.roles) ? parsed.roles.filter((s) => typeof s === 'string' && s.trim()).slice(0, 50) : [],
        education: Array.isArray(parsed.education)
          ? parsed.education.slice(0, 20).map((e) => ({
              degree: e && typeof e.degree === 'string' ? e.degree : null,
              field: e && typeof e.field === 'string' ? e.field : null,
              institution: e && typeof e.institution === 'string' ? e.institution : null,
              year: e && typeof e.year === 'string' ? e.year : null
            }))
          : [],
        hardSkills: Array.isArray(parsed.hardSkills) ? parsed.hardSkills.filter((s) => typeof s === 'string' && s.trim()).slice(0, 100) : [],
        softSkills: Array.isArray(parsed.softSkills) ? parsed.softSkills.filter((s) => typeof s === 'string' && s.trim()).slice(0, 100) : []
      };

      return reply.send(safe);
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send(err('OPENAI_ERROR', 'Summary generation failed', { hint: e.message }));
    }
  });
}

function err(code, message, details = {}) {
  return { error: { code, message, details } };
}
