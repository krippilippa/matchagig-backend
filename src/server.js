import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import OpenAI, { toFile } from 'openai';

const PORT = process.env.PORT || 8787;
const MAX_BYTES = 10 * 1024 * 1024; // 10MB

const app = Fastify({ logger: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

await app.register(cors, {
  origin: (origin, cb) => cb(null, true), // open for now; lock later
  methods: ['POST', 'GET', 'OPTIONS']
});
await app.register(multipart, {
  limits: { fileSize: MAX_BYTES, files: 1, fields: 5 }
});

app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

// Minimal MVP: upload file -> OpenAI Files -> Responses with file reference -> cleaned text (JSON)
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

    // Extract text output
    const outputText = resp.output_text || '';
    let parsed;
    try { parsed = JSON.parse(outputText); } catch (_) { parsed = { text: outputText, sections: [] }; }

    return reply.send({ fileId: uploaded.id, text: parsed.text || '', sections: Array.isArray(parsed.sections) ? parsed.sections : [] });
  } catch (e) {
    req.log.error(e);
    return reply.code(500).send(err('OPENAI_ERROR', 'Failed to process file with OpenAI', { hint: e.message }));
  }
});

app.post('/v1/extract', async (req, reply) => {
  // Accept EITHER multipart file OR raw JSON with {text}
  const ctype = req.headers['content-type'] || '';

  try {
    if (ctype.includes('application/json')) {
      const body = await req.body;
      const text = (body?.text || '').toString();
      if (!text.trim()) {
        return reply.code(400).send(err('BAD_REQUEST', 'Missing "text" in JSON body'));
      }
      return reply.send({
        text,
        meta: { pages: null, bytes: Buffer.byteLength(text, 'utf8'), filename: null, mime: 'text/plain' }
      });
    }

    if (!ctype.includes('multipart/form-data')) {
      return reply.code(415).send(err('UNSUPPORTED_MEDIA_TYPE', 'Use multipart/form-data or application/json'));
    }

    const parts = req.parts();
    let filePart = null;
    for await (const part of parts) {
      if (part.type === 'file' && !filePart) filePart = part;
      else await part?.toBuffer?.().catch(() => {}); // drain extras
    }
    if (!filePart) return reply.code(400).send(err('BAD_REQUEST', 'No file provided (field name can be anything)'));

    const { filename, mimetype } = filePart;
    const buf = await filePart.toBuffer();
    if (buf.length > MAX_BYTES) return reply.code(413).send(err('PAYLOAD_TOO_LARGE', 'File exceeds 10MB'));

    if (mimetype === 'application/pdf' || filename?.toLowerCase().endsWith('.pdf')) {
      const res = await pdfParse(buf);
      return reply.send({
        text: (res.text || '').trim(),
        meta: { pages: res.numpages ?? null, bytes: buf.length, filename, mime: 'application/pdf' }
      });
    }

    if (
      mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      filename?.toLowerCase().endsWith('.docx')
    ) {
      const res = await mammoth.extractRawText({ buffer: buf });
      return reply.send({
        text: (res.value || '').trim(),
        meta: { pages: null, bytes: buf.length, filename, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
      });
    }

    // Optional: accept plain .txt uploads
    if (mimetype === 'text/plain' || filename?.toLowerCase().endsWith('.txt')) {
      const text = buf.toString('utf8');
      return reply.send({
        text: text.trim(),
        meta: { pages: null, bytes: buf.length, filename, mime: 'text/plain' }
      });
    }

    return reply.code(415).send(err('UNSUPPORTED_MEDIA_TYPE', 'Only PDF, DOCX, or TXT supported'));
  } catch (e) {
    req.log.error(e);
    return reply.code(500).send(err('INTERNAL', 'Unexpected error', { hint: e.message }));
  }
});

function err(code, message, details = {}) {
  return { error: { code, message, details } };
}

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`listening on :${PORT}`))
  .catch((e) => { app.log.error(e); process.exit(1); });
