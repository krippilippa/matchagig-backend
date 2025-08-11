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

      const prompt = (
        'You are a parser. Read the attached résumé file. Output only valid JSON with this shape: ' +
        '{ "text": "<single block of clean plain text>", "sections": [{ "heading": "...", "body": "..." }] }. ' +
        'Normalize headings, fix hyphenation/line breaks, merge multi-column text logically, keep bullets as lines starting with "- ". ' +
        'If you cannot build sections reliably, still return the JSON with an empty sections array. No commentary.'
      );

      const resp = await openai.responses.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
        attachments: [{ file_id: uploaded.id, tools: [{ type: 'file_search' }] }]
      });

      const outputText = resp.output_text || '';
      let parsed;
      try { parsed = JSON.parse(outputText); } catch (_) { parsed = { text: outputText, sections: [] }; }

      return reply.send({ fileId: uploaded.id, text: parsed.text || '', sections: Array.isArray(parsed.sections) ? parsed.sections : [] });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send(err('OPENAI_ERROR', 'Failed to process file with OpenAI', { hint: e.message }));
    }
  });
}

function err(code, message, details = {}) {
  return { error: { code, message, details } };
}
