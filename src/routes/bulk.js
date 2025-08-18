// routes/bulk.js - Minimal test route for PDF text extraction
import { toFile } from 'openai';
import OpenAI from 'openai';
import { normalizeCanonicalText, flattenForPreview } from '../lib/canon.js';
import { getJD } from '../shared/storage.js';
import { getEmbeddingModel } from '../lib/embeddings.js';

export default async function bulkRoutes(app) {
  // helper: chunk → embed (batched) → mean-pool → cosine
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  function chunk(text, size=3000, overlap=300) {
    const out=[]; let i=0;
    while (i<text.length) { out.push(text.slice(i, i+size)); i += (size-overlap); }
    return out;
  }
  
  async function embedMany(texts) {
    const model = getEmbeddingModel(); // e.g., text-embedding-3-small
    const BATCH = 96;
    const out = [];
    for (let i=0;i<texts.length;i+=BATCH) {
      const batch = texts.slice(i,i+BATCH);
      const res = await client.embeddings.create({ model, input: batch });
      for (const d of res.data) out.push(d.embedding);
    }
    return out;
  }
  
  function meanPool(vecs) {
    if (!vecs.length) return [];
    const L = vecs[0].length, v = new Array(L).fill(0);
    for (const e of vecs) for (let i=0;i<L;i++) v[i]+=e[i];
    for (let i=0;i<L;i++) v[i]/=vecs.length;
    return v;
  }
  
  function cosine(a,b){
    let dot=0,na=0,nb=0, L=Math.min(a.length,b.length);
    for (let i=0;i<L;i++){ const x=a[i],y=b[i]; dot+=x*y; na+=x*x; nb+=y*y; }
    return (na&&nb)? dot/(Math.sqrt(na)*Math.sqrt(nb)) : 0;
  }

  // JD signal builder (same idea as in match.js)
  const norm = s => (s||'').toString().trim();
  function buildJdSignal(jd={}) {
    const ro=jd.roleOrg||{}, log=jd.logistics||{}, req=jd.requirements||{}, ss=jd.successSignals||{};
    const title=norm(ro.title);
    const funcs=(ro.functions||[]).map(norm).join(', ');
    const skills=(ss.topHardSkills||[]).map(norm).join(', ');
    const outcomes=(ss.keyOutcomes||[]).map(o=>norm(o?.text)).filter(Boolean).join(', ');
    const inds=(ss.industryHints||[]).map(norm).join(', ');
    const seniority=norm(ro.seniorityHint);
    const langs=(log.languages||[]).map(norm).join(', ');
    const eduMin=norm(req.educationMin);
    const workMode=norm(log.location?.workMode);
    return [
      `TITLE ${title}`,
      funcs && `FUNCTIONS ${funcs}`,
      skills && `SKILLS ${skills}`,
      outcomes && `OUTCOMES ${outcomes}`,
      inds && `INDUSTRIES ${inds}`,
      seniority && `SENIORITY ${seniority}`,
      langs && `LANGUAGES ${langs}`,
      eduMin && `EDU_MIN ${eduMin}`,
      workMode && `WORKMODE ${workMode}`
    ].filter(Boolean).join(' | ');
  }

  // Simple test route - upload PDF and extract text
  app.post("/v1/bulk-test", async (req, reply) => {
    try {
      console.log('🔍 Testing PDF text extraction...');
      
      // Read a single file part in a blocking-safe way (same as upload.js)
      const filePart = await req.file();
      if (!filePart) {
        return reply.code(400).send({ 
          error: "No file uploaded",
          message: "Upload a PDF file" 
        });
      }

      console.log(`📁 Filename: ${filePart.filename}`);
      console.log(`📏 File size: ${filePart.file.bytesRead} bytes`);
      
      // Convert the file to buffer (same as upload.js)
      const buf = await filePart.toBuffer();
      console.log(`📏 Buffer size: ${buf.length} bytes`);
      
      // HOIST THESE so they're visible after the inner try/catch:
      let text = '';
      let cosineScore = null;
      
      // Try to extract text with better error handling
      try {
        const pdf = (await import('pdf-parse/lib/pdf-parse.js')).default;
        const pdfData = await pdf(buf);
        text = pdfData.text || '';
        console.log(`📝 Extracted text length: ${text.length}`);
        console.log(`📝 Text preview: ${text.substring(0, 200)}...`);
        
        // Clean up the extracted text with soft line-wrap joining
        console.log(`🔍 Before normalization - text length: ${text.length}`);
        console.log(`🔍 Before normalization - first 200 chars: ${text.substring(0, 200)}`);
        
        text = normalizeCanonicalText(text, { flatten: 'soft' });
        console.log(`🧹 After normalization - text length: ${text.length}`);
        console.log(`🧹 After normalization - first 200 chars: ${text.substring(0, 200)}`);
        
        // Optional: JD comparison if jdHash or jdText provided
        const fields = Object.fromEntries(Object.entries(filePart.fields||{}).map(([k,v])=>[k, v?.value]));
        const jdHash = fields.jdHash;
        const jdText = fields.jdText; // if you want to test raw JD text instead of stored JD

        if (jdHash || jdText) {
          try {
            // 1) resume doc vector
            const capped = text.length > 50000 ? text.slice(0,50000) : text;
            const rChunks = chunk(capped, 3000, 300);
            const rVecs = await embedMany(rChunks);
            const rDoc = meanPool(rVecs);

            // 2) JD vector
            let jdVec;
            if (jdText) {
              const jChunks = chunk(jdText, 3000, 300);
              jdVec = meanPool(await embedMany(jChunks));
            } else {
              const jdData = getJD(jdHash);
              if (!jdData) return reply.code(400).send({ error: 'BAD_REQUEST', message: `Unknown jdHash ${jdHash}` });
              const jdSignal = buildJdSignal(jdData.jd);
              [jdVec] = await embedMany([jdSignal]);
            }

            // 3) similarity
            cosineScore = Number(cosine(rDoc, jdVec).toFixed(4));
            console.log(`🎯 Cosine similarity: ${cosineScore}`);
          } catch (embedError) {
            console.error('❌ Embedding failed:', embedError.message);
            // Continue without similarity score
          }
        }
      } catch (pdfError) {
        console.error('❌ PDF parsing failed:', pdfError.message);
        
        // Try alternative approach - check if it's a valid PDF first
        if (buf.length < 4 || buf.toString('ascii', 0, 4) !== '%PDF') {
          return reply.code(400).send({
            error: "Invalid PDF file",
            message: "File does not appear to be a valid PDF"
          });
        }
        
        // If it's a valid PDF but parsing failed, return error with details
        return reply.code(500).send({
          error: "PDF parsing failed",
          message: pdfError.message,
          details: "The PDF file appears valid but could not be parsed. This might be due to encryption, corruption, or unsupported PDF features."
        });
      }
      
      return reply.send({
        success: true,
        filename: filePart.filename,
        textLength: text.length,
        preview: flattenForPreview(text).slice(0, 500),
        fullText: text,
        cosine: cosineScore,             // null if no jdHash/jdText sent
        embeddingModel: getEmbeddingModel()
      });
      
    } catch (e) {
      console.error('❌ PDF extraction failed:', e.message);
      return reply.code(500).send({ 
        error: "PDF extraction failed",
        message: e.message 
      });
    }
  });
}
