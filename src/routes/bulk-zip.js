// routes/bulk-zip.js - ZIP-based bulk resume processing
import unzipper from "unzipper";
import { extractCanonicalText } from "../lib/extract.js";
import { normalizeCanonicalText, flattenForPreview } from "../lib/canon.js";
import { embedMany, embedDocument, cosine } from "../lib/emb-bulk.js";
import { getEmbeddingModel } from "../lib/embeddings.js";
import { getJD } from "../shared/storage.js";
import { buildJdSignal } from "../lib/jd-signal.js";

export default async function bulkZipRoutes(app) {
  const MAX_FILES_PER_ZIP = Number(process.env.MAX_FILES_PER_ZIP || 100); // Reduced from 500 to 200
  const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || (10 * 1024 * 1024)); // 10MB per file
  const MAX_TOTAL_BYTES = Number(process.env.MAX_TOTAL_BYTES || (100 * 1024 * 1024)); // Reduced from 250MB to 100MB
  const CONC = Number(process.env.ZIP_EMBED_CONCURRENCY || 4);

  app.post("/v1/bulk-zip", async (req, reply) => {
    try {
      const part = await req.file();
      if (!part) return reply.code(400).send({ error: "NO_ZIP", message: 'Send one file field named "zip"' });
      if (!/\.zip$/i.test(part.filename || "")) {
        // sanity: also check magic number
        const head = (await part.toBuffer()).slice(0, 4);
        if (head.toString("ascii") !== "PK\u0003\u0004") {
          return reply.code(400).send({ error: "BAD_FILE", message: "Upload a .zip file" });
        }
        // If we consumed the buffer above, re-create a fake stream:
        // Easiest path: require .zip extension and reject if not .zip
        return reply.code(400).send({ error: "BAD_FILE", message: "Upload a .zip file" });
      }

      // Read the whole zip to buffer once (Fastify multipart gives us a stream)
      const zipBuf = await part.toBuffer();

      // Optional fields in the same multipart
      const fields = Object.fromEntries(Object.entries(part.fields || {}).map(([k,v]) => [k, v?.value]));
      const { jdHash, jdText } = fields;
      const jdMode = fields.jdMode || "structured"; // 'structured' | 'raw' | 'blend'
      const alpha = Math.max(0, Math.min(1, Number(fields.alpha ?? 0.7)));
      const topN = Math.min(Number(fields.topN ?? 100), MAX_FILES_PER_ZIP);

      // Unzip sequentially (no hangs), collect candidate files
      const zip = await unzipper.Open.buffer(zipBuf);
      let totalBytes = 0;
      const entries = zip.files.filter(e => !e.path.endsWith("/") && !e.path.startsWith("__MACOSX/"));
      const picked = [];
      for (const e of entries) {
        if (picked.length >= MAX_FILES_PER_ZIP) break;
        const lower = e.path.toLowerCase();
        const extOk = lower.endsWith(".pdf") || lower.endsWith(".docx") || lower.endsWith(".txt");
        if (!extOk) continue;
        if (e.uncompressedSize > MAX_FILE_BYTES) continue;
        totalBytes += e.uncompressedSize;
        if (totalBytes > MAX_TOTAL_BYTES) break;
        picked.push(e);
      }
      if (picked.length === 0) {
        return reply.code(400).send({ error: "NO_DOCS", message: "No supported files (pdf/docx/txt) found in zip or files exceeded limits." });
      }

      // Extract + normalize + quality
      const items = [];
      let processedCount = 0;
      for (const e of picked) {
        try {
          const buf = await e.buffer();
          let text = await extractCanonicalText(buf, e.path);
          if (text) text = normalizeCanonicalText(text, { flatten: 'soft' });

          // quality gate
          const len = text?.length || 0;
          const letters = (text?.match(/[A-Za-zÀ-ÖØ-öø-ÿ0-9]/g) || []).length;
          const ratio = len ? (letters / len) : 0;
          const ok = len >= 200 && ratio >= 0.2;

          items.push({
            filename: e.path.split("/").pop(),
            status: ok ? "ok" : "no_text",
            text: ok ? text : "",
            textChars: len,
            preview: ok ? flattenForPreview(text).slice(0, 240) : "<< no extractable text >>",
            bytes: buf.length
          });
          
          processedCount++;
          if (processedCount % 10 === 0) {
            console.log(`📊 Processed ${processedCount}/${picked.length} files...`);
          }
        } catch (fileError) {
          console.warn(`⚠️ Failed to process ${e.path}: ${fileError.message}`);
          items.push({
            filename: e.path.split("/").pop(),
            status: "error",
            text: "",
            textChars: 0,
            preview: `<< processing error: ${fileError.message} >>`,
            bytes: 0
          });
        }
      }

      // If JD provided, compute JD vector
      let jdVec = null;
      if (jdHash || jdText) {
        if (jdMode === "raw") {
          if (!jdText) return reply.code(400).send({ error: "BAD_REQUEST", message: "Provide jdText when jdMode=raw" });
          // raw JD doc vector
          jdVec = await embedDocument(jdText);
        } else if (jdMode === "blend") {
          if (!jdHash || !jdText) return reply.code(400).send({ error: "BAD_REQUEST", message: "Provide both jdHash and jdText when jdMode=blend" });
          const jdData = getJD(jdHash);
          if (!jdData) return reply.code(404).send({ error: "NOT_FOUND", message: `JD not found: ${jdHash}` });
          const signal = buildJdSignal(jdData.jd);
          const [sigVec] = await embedMany([signal]);
          const rawVec = await embedDocument(jdText);
          // blend
          const L = Math.min(sigVec.length, rawVec.length);
          jdVec = new Array(L).fill(0).map((_, i) => alpha * sigVec[i] + (1 - alpha) * rawVec[i]);
        } else {
          const jdData = getJD(jdHash);
          if (!jdData) return reply.code(404).send({ error: "NOT_FOUND", message: `JD not found: ${jdHash}` });
          const [sigVec] = await embedMany([buildJdSignal(jdData.jd)]);
          jdVec = sigVec;
        }
      }

      // If JD provided, embed résumés (ok only) and compute cosine
      let cosines = null;
      if (jdVec) {
        const okIdx = items.map((x, i) => (x.status === "ok" ? i : -1)).filter(i => i >= 0);
        cosines = new Array(items.length).fill(null);

        let cursor = 0;
        async function worker() {
          while (cursor < okIdx.length) {
            const i = okIdx[cursor++];
            const rText = items[i].text;
            const rDocVec = await embedDocument(rText);
            cosines[i] = Number(cosine(jdVec, rDocVec).toFixed(4));
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONC, okIdx.length) }, worker));
      }

      // Build response
      let out = items.map((it, i) => ({
        filename: it.filename,
        status: it.status,
        textChars: it.textChars,
        preview: it.preview,
        bytes: it.bytes,
        cosine: cosines ? cosines[i] : null
      }));

      if (cosines) out.sort((a, b) => (b.cosine ?? -1) - (a.cosine ?? -1));

      return reply.send({
        count: items.length,
        jdUsed: Boolean(jdHash || jdText),
        jdMode,
        embeddingModel: getEmbeddingModel(),
        results: out.slice(0, topN)
      });
    } catch (e) {
      req.log?.error?.(e);
      return reply.code(500).send({ error: "ZIP_BULK_FAILED", message: e.message });
    }
  });
}
