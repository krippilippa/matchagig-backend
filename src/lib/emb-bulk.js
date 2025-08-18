// lib/emb-bulk.js - Embedding helpers for bulk processing
import OpenAI from "openai";
import { getEmbeddingModel } from "./embeddings.js"; // reuse your existing function

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export function chunkText(text, size = 3000, overlap = 300) {
  const out = []; let i = 0;
  while (i < text.length) { out.push(text.slice(i, i + size)); i += (size - overlap); }
  return out;
}

export async function embedMany(texts) {
  const model = getEmbeddingModel(); // e.g. text-embedding-3-small
  const BATCH = 96;
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await client.embeddings.create({ model, input: batch });
    for (const d of res.data) out.push(d.embedding);
  }
  return out;
}

export async function embedDocument(text) {
  const capped = text.length > 50000 ? text.slice(0, 50000) : text;
  const parts = chunkText(capped, 3000, 300);
  const vecs = await embedMany(parts);
  return meanPool(vecs);
}

export function meanPool(vecs) {
  if (!vecs.length) return [];
  const L = vecs[0].length, v = new Array(L).fill(0);
  for (const e of vecs) for (let i = 0; i < L; i++) v[i] += e[i];
  for (let i = 0; i < L; i++) v[i] /= vecs.length;
  return v;
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0, L = Math.min(a.length, b.length);
  for (let i = 0; i < L; i++) { const x=a[i], y=b[i]; dot+=x*y; na+=x*x; nb+=y*y; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
