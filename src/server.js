import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import uploadRoute from './routes/upload.js';
import queryRoute from './routes/query.js';
import summaryRoute from './routes/summary.js';
import redflagsRoute from './routes/redflags.js';
import overviewRoute from './routes/overview.js';
import jdRoute from './routes/jd.js';
import matchRoute from './routes/match.js';
import bulkRoutes from './routes/bulk.js';
import bulkZipRoutes from './routes/bulk-zip.js';

const PORT = process.env.PORT || 8787;
const MAX_BYTES = 250 * 1024 * 1024; // 250MB for bulk-zip support

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: (origin, cb) => cb(null, true), // open for now; lock later
  methods: ['POST', 'GET', 'OPTIONS']
});
await app.register(multipart, {
  limits: { fileSize: MAX_BYTES, files: 1, fields: 5 }
});

app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

// Register routes - all now use shared storage module
await app.register(uploadRoute);
await app.register(queryRoute);
await app.register(summaryRoute);
await app.register(redflagsRoute);
await app.register(overviewRoute);
await app.register(jdRoute);
await app.register(matchRoute);
await app.register(bulkRoutes);
await app.register(bulkZipRoutes);

console.log('✅ All routes registered with shared storage');

function err(code, message, details = {}) {
  return { error: { code, message, details } };
}

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`listening on :${PORT}`))
  .catch((e) => { app.log.error(e); process.exit(1); });
