// routes/bulk-zip.js - ZIP-based bulk resume processing
import crypto from 'crypto';
import unzipper from 'unzipper';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { normalizeCanonicalText } from '../lib/canon.js';
import { getJD } from '../shared/storage.js';
import { getEmbedding, getEmbeddingModel, signalCacheKey } from '../lib/embeddings.js';

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const L = Math.min(a.length, b.length);
  for (let i = 0; i < L; i++) { 
    const x = a[i], y = b[i]; 
    dot += x*y; 
    na += x*x; 
    nb += y*y; 
  }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
function firstEmail(s='') {
  const hits = s.match(EMAIL_RE) || [];
  return hits.find(e => !/no.?reply|donotreply|example\.com/i.test(e)) || hits[0] || null;
}

// stable short id from canonical text
function makeResumeIdFromText(text) {
  const h = crypto.createHash('sha256').update(text).digest('hex');
  return `rs_${h.slice(0, 12)}`;
}

export default async function bulkZipRoutes(app) {
  app.post('/v1/bulk-zip', async (req, reply) => {
    try {
      const mp = await req.multipart();
      if (!mp) return reply.code(400).send({ error: 'multipart required' });

      let zipBuf = null;
      let jdHash = null;
      let jdText = null;
      let wantCanonicalText = true;
      let topN = null;

      for await (const part of mp) {
        if (part.type === 'file' && part.fieldname === 'zip') {
          const chunks = [];
          for await (const chunk of part.file) chunks.push(chunk);
          zipBuf = Buffer.concat(chunks);
        } else if (part.type === 'field') {
          if (part.fieldname === 'jdHash') jdHash = (part.value || '').trim() || null;
          if (part.fieldname === 'jdText') jdText = (part.value || '').trim() || null;
          if (part.fieldname === 'wantCanonicalText') wantCanonicalText = (String(part.value).toLowerCase() === 'true');
          if (part.fieldname === 'topN') topN = Math.max(1, Math.min(1000, parseInt(part.value, 10) || 0)) || null;
        }
      }

      if (!zipBuf) {
        return reply.code(400).send({ error: 'No zip uploaded (field "zip")' });
      }

      // Resolve JD vector
      let jdMode = 'none';
      let jdVec = null;
      if (jdHash) {
        const jdRec = getJD(jdHash);
        if (!jdRec) return reply.code(404).send({ error: `JD not found for hash ${jdHash}` });
        jdMode = 'structured';
        const fullJdText = (jdRec?.metadata?.jdText || '') || ''; // raw JD stored earlier
        const jdTextNorm = normalizeCanonicalText(fullJdText, { flatten: 'soft' });
        jdVec = await getEmbedding(jdTextNorm, signalCacheKey('jdRaw', jdHash, fullJdText));
      } else if (jdText) {
        jdMode = 'raw';
        const jdTextNorm = normalizeCanonicalText(jdText, { flatten: 'soft' });
        jdVec = await getEmbedding(jdTextNorm, signalCacheKey('jdRaw', 'inline', jdTextNorm));
      }

      // Unzip and process PDFs
      const directory = await unzipper.Open.buffer(zipBuf);
      const pdfEntries = directory.files.filter(f => !f.isDirectory && /\.pdf$/i.test(f.path));
      const results = [];

      for (const entry of pdfEntries) {
        try {
          const buf = await entry.buffer();
          const parsed = await pdfParse(buf);
          const raw = parsed?.text || '';
          const canonical = normalizeCanonicalText(raw, { flatten: 'soft' });

          const resumeId = makeResumeIdFromText(canonical || entry.path || String(buf.length));
          const email = firstEmail(canonical) || null;
          const textChars = canonical.length;

          let cos = null;
          if (jdVec) {
            const docVec = await getEmbedding(canonical, signalCacheKey('bulkDoc', resumeId, canonical.slice(0, 4096)));
            cos = Number(cosine(docVec, jdVec).toFixed(4));
          }

          results.push({
            resumeId,
            filename: entry.path.split('/').pop(),
            bytes: buf.length,
            textChars,
            email,
            cosine: cos,
            canonicalText: wantCanonicalText ? canonical : undefined
          });
        } catch (e) {
          // Skip broken PDFs (or push an error row if you prefer)
          // results.push({ filename: entry.path, status: 'error', message: e.message });
        }
      }

      // Sort by cosine desc (nulls last)
      results.sort((a, b) => {
        const ax = (typeof a.cosine === 'number') ? a.cosine : -Infinity;
        const bx = (typeof b.cosine === 'number') ? b.cosine : -Infinity;
        return bx - ax;
      });

      const limited = topN ? results.slice(0, topN) : results;

      return reply.send({
        uploadId: `uz_${Math.random().toString(36).slice(2, 8)}`,
        jdMode,
        embeddingModel: getEmbeddingModel(),
        count: results.length,
        results: limited
      });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: 'BULK_ZIP_FAILED', message: e.message });
    }
  });
}
