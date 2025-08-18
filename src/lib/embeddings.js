import OpenAI from 'openai';
import crypto from 'crypto';

const EMBED_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Simple in-memory cache with TTL: key -> { vec, at, model }
const cache = new Map();

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

export function signalCacheKey(prefix, id, text) {
  const h = sha1(text || '');
  return `${prefix}:${id}:${EMBED_MODEL}:${h}`;
}

export async function getEmbedding(text, cacheKey) {
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && (now - hit.at) < TTL_MS && hit.model === EMBED_MODEL) {
    return hit.vec;
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const res = await openai.embeddings.create({ model: EMBED_MODEL, input: text });
  const vec = res.data[0].embedding;
  cache.set(cacheKey, { vec, at: now, model: EMBED_MODEL });
  return vec;
}

export function getEmbeddingModel() {
  return EMBED_MODEL;
}


