import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import uploadRoute from './routes/upload.js';
import queryRoute from './routes/query.js';
import summaryRoute from './routes/summary.js';
import redflagsRoute from './routes/redflags.js';
import overviewRoute from './routes/overview.js';

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

// Register routes
await app.register(uploadRoute);
await app.register(queryRoute);
await app.register(summaryRoute);
await app.register(redflagsRoute);
await app.register(overviewRoute);

// Share resume storage between routes (temporary solution - replace with proper DB in production)
// This ensures all routes can access the canonical resume data
if (typeof uploadRoute.getResumeStorage === 'function') {
  // Get the storage from upload route and share it
  const storage = uploadRoute.getResumeStorage?.() || new Map();
  if (typeof queryRoute.setResumeStorage === 'function') {
    queryRoute.setResumeStorage(storage);
  }
  if (typeof summaryRoute.setResumeStorage === 'function') {
    summaryRoute.setResumeStorage(storage);
  }
  if (typeof redflagsRoute.setResumeStorage === 'function') {
    redflagsRoute.setResumeStorage(storage);
  }
  if (typeof overviewRoute.setResumeStorage === 'function') {
    overviewRoute.setResumeStorage(storage);
  }
}

function err(code, message, details = {}) {
  return { error: { code, message, details } };
}

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => app.log.info(`listening on :${PORT}`))
  .catch((e) => { app.log.error(e); process.exit(1); });
