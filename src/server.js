import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import uploadRoute from './routes/upload.js';

const PORT = process.env.PORT || 8787;
const MAX_BYTES = 10 * 1024 * 1024; // 10MB

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: (origin, cb) => cb(null, true), // open for now; lock later
  methods: ['POST', 'GET', 'OPTIONS']
});
await app.register(multipart, {
  limits: { fileSize: MAX_BYTES, files: 1, fields: 5 }
});

app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));
await app.register(uploadRoute);

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
