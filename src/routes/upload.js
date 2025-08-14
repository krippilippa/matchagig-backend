import OpenAI, { toFile } from 'openai';

const MAX_BYTES = 10 * 1024 * 1024; // 10MB

export default async function uploadRoute(app) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  app.post('/v1/upload', async (req, reply) => {
    const ctype = req.headers['content-type'] || '';
    if (!ctype.includes('multipart/form-data')) {
      return reply.code(415).send(err('UNSUPPORTED_MEDIA_TYPE', 'Use multipart/form-data'));
    }
    if (!process.env.OPENAI_API_KEY) {
      return reply.code(500).send(err('CONFIG', 'OPENAI_API_KEY not set'));
    }

    try {
      const parts = req.parts();
      let filePart = null;
      for await (const part of parts) {
        if (part.type === 'file' && !filePart) filePart = part; else await part?.toBuffer?.().catch(() => {});
      }
      if (!filePart) return reply.code(400).send(err('BAD_REQUEST', 'No file provided'));

      const { filename, mimetype } = filePart;
      const buf = await filePart.toBuffer();
      if (buf.length > MAX_BYTES) return reply.code(413).send(err('PAYLOAD_TOO_LARGE', 'File exceeds 10MB'));

      const uploaded = await openai.files.create({
        file: await toFile(buf, filename || 'upload', { type: mimetype || 'application/octet-stream' }),
        purpose: 'assistants'
      });

      const prompt = [
        'You are a résumé parser. Read the attached file and OUTPUT ONLY valid JSON with this exact schema:',
        '{ "name": string|null, "email": string|null, "blurb": string, "text": string }.',
        'Rules for fields:',
        '- name: best candidate full name if confidently found, else null. Do not invent.',
        '- email: primary email if present, else null. Do not invent.',
        '- blurb: a neutral 1–2 sentence objective summary of the candidate (no hype).',
        '- text: faithful plain-text extraction of the document content. Do NOT summarize or paraphrase.',
        'text extraction policy:',
        '- Preserve original wording, punctuation, capitalization, numbers, names, dates.',
        '- Allowed cleanup only: fix line-break hyphenation; merge multi-column order; remove repeated headers/footers/page numbers; collapse excessive whitespace while keeping paragraph/list structure.',
        'Output JSON only. No markdown. No extra keys. No comments.'
      ].join(' ');

      const resp = await openai.responses.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: prompt },
              { type: 'input_file', file_id: uploaded.id }
            ]
          }
        ]
      });

      const outputText = (resp.output_text || '').trim();
      let parsed;
      try {
        parsed = JSON.parse(outputText);
      } catch {
        parsed = { name: null, email: null, blurb: '', text: outputText };
      }
      const name = typeof parsed.name === 'string' || parsed.name === null ? parsed.name : null;
      const email = typeof parsed.email === 'string' || parsed.email === null ? parsed.email : null;
      const blurb = typeof parsed.blurb === 'string' ? parsed.blurb : '';
      const text = typeof parsed.text === 'string' ? parsed.text : '';
      return reply.send({ fileId: uploaded.id, name, email, blurb, text });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send(err('OPENAI_ERROR', 'Failed to process file with OpenAI', { hint: e.message }));
    }
  });
}

function err(code, message, details = {}) {
  return { error: { code, message, details } };
}
