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
        'You are a text extractor. Read the attached résumé and OUTPUT ONLY the extracted plain text of the document.',
        'Verbatim policy: do NOT summarize, paraphrase, rephrase, shorten, expand, or invent anything.',
        'Preserve the original wording, punctuation, capitalization, numbers, names, and dates exactly as written.',
        'Allowed cleanup: (1) fix layout artifacts like broken hyphenation at line breaks, (2) merge multi-column/segmented layouts into logical reading order,',
        '(3) remove repeated headers/footers/page numbers, (4) collapse excessive whitespace but keep paragraph and list structure.',
        'Do NOT normalize headings or bullets; keep the original characters and labels as in the source.',
        'Include ALL content that appears in the document. Output plain text only—no JSON, no markdown, no commentary.'
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
      return reply.send({ fileId: uploaded.id, text: outputText });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send(err('OPENAI_ERROR', 'Failed to process file with OpenAI', { hint: e.message }));
    }
  });
}

function err(code, message, details = {}) {
  return { error: { code, message, details } };
}
