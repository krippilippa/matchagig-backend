// routes/bulk-zip.js - ZIP-based bulk resume processing
import unzipper from "unzipper";
import { extractCanonicalText } from "../lib/extract.js";
import { normalizeCanonicalText, flattenForPreview } from "../lib/canon.js";
import { embedMany, embedDocument, cosine } from "../lib/emb-bulk.js";
import { getEmbeddingModel } from "../lib/embeddings.js";
import { getJD } from "../shared/storage.js";
import { buildJdSignal } from "../lib/jd-signal.js";

export default async function bulkZipRoutes(app) {
  const BATCH_SIZE = 25; // Process 25 files at a time (reduced from 50 to minimize font warnings)
  const MAX_TOTAL_FILES = 500; // Maximum total files to process
  const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || (10 * 1024 * 1024));
  const MAX_TOTAL_BYTES = Number(process.env.MAX_TOTAL_BYTES || (250 * 1024 * 1024));
  const CONC = Number(process.env.ZIP_EMBED_CONCURRENCY || 4);

  app.post("/v1/bulk-zip", async (req, reply) => {
    try {
      const part = await req.file();
      if (!part) return reply.code(400).send({ error: "NO_ZIP", message: 'Send one file field named "zip"' });

      if (!/\.zip$/i.test(part.filename || "")) {
        const head = (await part.toBuffer()).slice(0, 4);
        if (head.toString("ascii") !== "PK\u0003\u0004") {
          return reply.code(400).send({ error: "BAD_FILE", message: "Upload a .zip file" });
        }
        return reply.code(400).send({ error: "BAD_FILE", message: "Upload a .zip file" });
      }

      const zipBuf = await part.toBuffer();
      const fields = Object.fromEntries(Object.entries(part.fields || {}).map(([k,v]) => [k, v?.value]));
      const { jdHash, jdText } = fields;
      const jdMode = fields.jdMode || "structured";
      const alpha = Math.max(0, Math.min(1, Number(fields.alpha ?? 0.7)));
      const topN = Math.min(Number(fields.topN ?? 100), MAX_TOTAL_FILES);

      // Unzip and collect all candidate files
      const zip = await unzipper.Open.buffer(zipBuf);
      let totalBytes = 0;
      const entries = zip.files.filter(e => !e.path.endsWith("/") && !e.path.startsWith("__MACOSX/"));
      const picked = [];
      
      for (const e of entries) {
        if (picked.length >= MAX_TOTAL_FILES) break;
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

      // Process files in batches
      const allItems = [];
      const totalFiles = picked.length;
      const numBatches = Math.ceil(totalFiles / BATCH_SIZE);

      console.log(`🚀 Processing ${totalFiles} files in ${numBatches} batches of ${BATCH_SIZE}`);

      for (let batchNum = 0; batchNum < numBatches; batchNum++) {
        const startIdx = batchNum * BATCH_SIZE;
        const endIdx = Math.min(startIdx + BATCH_SIZE, totalFiles);
        const batchFiles = picked.slice(startIdx, endIdx);
        
        console.log(`📦 Processing batch ${batchNum + 1}/${numBatches} (files ${startIdx + 1}-${endIdx})`);

        // Process this batch
        const batchItems = [];
        for (const e of batchFiles) {
          try {
            const buf = await e.buffer();
            let text = await extractCanonicalText(buf, e.path);
            if (text) text = normalizeCanonicalText(text, { flatten: 'soft' });

            const len = text?.length || 0;
            const letters = (text?.match(/[A-Za-zÀ-ÖØ-öø-ÿ0-9]/g) || []).length;
            const ratio = len ? (letters / len) : 0;
            const ok = len >= 200 && ratio >= 0.2;

            batchItems.push({
              filename: e.path.split("/").pop(),
              status: ok ? "ok" : "no_text",
              text: ok ? text : "",
              textChars: len,
              preview: ok ? flattenForPreview(text).slice(0, 240) : "<< no extractable text >>",
              bytes: buf.length
            });
          } catch (fileError) {
            console.warn(`⚠️ Failed to process ${e.path}: ${fileError.message}`);
            batchItems.push({
              filename: e.path.split("/").pop(),
              status: "error",
              text: "",
              textChars: 0,
              preview: `<< processing error: ${fileError.message} >>`,
              bytes: 0
            });
          }
        }

        allItems.push(...batchItems);
        console.log(`✅ Batch ${batchNum + 1} complete: ${batchItems.length} files processed`);
      }

      // If JD provided, compute JD vector
      let jdVec = null;
      if (jdHash || jdText) {
        console.log(`🎯 Computing JD vector for comparison...`);
        if (jdMode === "raw") {
          if (!jdText) return reply.code(400).send({ error: "BAD_REQUEST", message: "Provide jdText when jdMode=raw" });
          jdVec = await embedDocument(jdText);
        } else if (jdMode === "blend") {
          if (!jdHash || !jdText) return reply.code(400).send({ error: "BAD_REQUEST", message: "Provide both jdHash and jdText when jdMode=blend" });
          const jdData = getJD(jdHash);
          if (!jdData) return reply.code(404).send({ error: "NOT_FOUND", message: `JD not found: ${jdHash}` });
          const signal = buildJdSignal(jdData.jd);
          const [sigVec] = await embedMany([signal]);
          const rawVec = await embedDocument(jdText);
          const L = Math.min(sigVec.length, rawVec.length);
          jdVec = new Array(L).fill(0).map((_, i) => alpha * sigVec[i] + (1 - alpha) * rawVec[i]);
        } else {
          const jdData = getJD(jdHash);
          if (!jdData) return reply.code(404).send({ error: "NOT_FOUND", message: `JD not found: ${jdHash}` });
          const [sigVec] = await embedMany([buildJdSignal(jdData.jd)]);
          jdVec = sigVec;
        }
      }

      // If JD provided, embed résumés and compute cosine
      let cosines = null;
      if (jdVec) {
        console.log(`🔍 Computing embeddings and similarities for ${allItems.filter(x => x.status === "ok").length} valid resumes...`);
        const okIdx = allItems.map((x, i) => (x.status === "ok" ? i : -1)).filter(i => i >= 0);
        cosines = new Array(allItems.length).fill(null);
        
        let cursor = 0;
        async function worker() {
          while (cursor < okIdx.length) {
            const i = okIdx[cursor++];
            const rText = allItems[i].text;
            const rDocVec = await embedDocument(rText);
            cosines[i] = Number(cosine(jdVec, rDocVec).toFixed(4));
          }
        }
        
        await Promise.all(Array.from({ length: Math.min(CONC, okIdx.length) }, worker));
        console.log(`✅ All embeddings and similarities computed`);
      }

      // Build final response
      let out = allItems.map((it, i) => ({
        filename: it.filename,
        status: it.status,
        textChars: it.textChars,
        preview: it.preview,
        bytes: it.bytes,
        cosine: cosines ? cosines[i] : null
      }));

      if (cosines) {
        out.sort((a, b) => (b.cosine ?? -1) - (a.cosine ?? -1));
      }

      const response = {
        count: allItems.length,
        totalFiles,
        batchesProcessed: numBatches,
        batchSize: BATCH_SIZE,
        jdUsed: Boolean(jdHash || jdText),
        jdMode,
        embeddingModel: getEmbeddingModel(),
        results: out.slice(0, topN)
      };

      console.log(`🎉 Bulk processing complete: ${allItems.length} files processed, ${out.filter(x => x.status === "ok").length} successful`);
      return reply.send(response);

    } catch (e) {
      req.log?.error?.(e);
      return reply.code(500).send({ error: "ZIP_BULK_FAILED", message: e.message });
    }
  });
}
