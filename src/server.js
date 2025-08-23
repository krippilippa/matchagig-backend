import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import bulkZipRoutes from './routes/bulk-zip.js';
import chatResponsesRoutes from './routes/chat-responses.js';
import resumeExtractRoutes from './routes/resume-extract.js';

const PORT = process.env.PORT || 8787;
const MAX_BYTES = 250 * 1024 * 1024; // 250MB for bulk-zip support

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: (origin, cb) => cb(null, true), // open for now; lock later
  methods: ['POST', 'GET', 'OPTIONS'],
  exposedHeaders: ['X-JD-Hash']
});
await app.register(multipart, {
  limits: { fileSize: MAX_BYTES, files: 1, fields: 5 }
});

app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

// Register only essential routes for demo
await app.register(bulkZipRoutes);
await app.register(chatResponsesRoutes);
await app.register(resumeExtractRoutes);

console.log('✅ Demo routes registered: bulk-zip, chat-responses, resume-extract');

function err(code, message, details = {}) {
  return { error: { code, message, details } };
}

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`listening on :${PORT}`))
  .catch((e) => { app.log.error(e); process.exit(1); });
