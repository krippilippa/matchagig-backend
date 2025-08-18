import OpenAI, { toFile } from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { resumeStorage, storeResume } from '../shared/storage.js';
import { normalizeCanonicalText } from '../lib/canon.js';

const MAX_BYTES = 10 * 1024 * 1024; // 10MB

// JSON schema validation
const ResumeSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  text: z.string().min(1, "Text must not be empty")
}).strict(); // No extra keys allowed



export default async function uploadRoute(app) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  app.post('/v1/upload', async (req, reply) => {
    console.log('🚀 Upload request started');
    const ctype = req.headers['content-type'] || '';
    if (!ctype.includes('multipart/form-data')) {
      return reply.code(415).send(err('UNSUPPORTED_MEDIA_TYPE', 'Use multipart/form-data'));
    }
    if (!process.env.OPENAI_API_KEY) {
      return reply.code(500).send(err('CONFIG', 'OPENAI_API_KEY not set'));
    }

    try {
      console.log('📁 Processing multipart request...');
      // Read a single file part in a blocking-safe way
      const filePart = await req.file();
      if (!filePart) return reply.code(400).send(err('BAD_REQUEST', 'No file provided'));
      console.log('📄 File part found:', filePart.filename);

      const { filename, mimetype } = filePart;
      const buf = await filePart.toBuffer();
      if (buf.length > MAX_BYTES) return reply.code(413).send(err('PAYLOAD_TOO_LARGE', 'File exceeds 10MB'));

      // Generate unique resume ID
      const resumeId = uuidv4();

      console.log('📤 Uploading file to OpenAI...');
      // Upload file to OpenAI for AI to process
      const uploaded = await openai.files.create({
        file: await toFile(buf, filename || 'upload', { type: mimetype || 'application/octet-stream' }),
        purpose: 'assistants'
      });
      console.log('✅ File uploaded to OpenAI, ID:', uploaded.id);

      // Build messages ONCE - never replace the full prompt
      const BASE_SYSTEM = `You extract plain text from résumés (any language) and return ONLY valid JSON matching the schema. Use exact wording from the document. Unknown → null. No markdown. No extra keys.`;

      const BASE_PROMPT = [
        'OUTPUT ONLY valid JSON with this exact schema:',
        '{ "name": string|null, "email": string|null, "phone": string|null, "text": string }',
        'Rules:',
        '- name: full candidate name if clearly stated; else null.',
        '- email: primary email if present; else null.',
        '- phone: main phone number if present; else null.',
        '- text: faithful plain-text extraction of the document content.',
        'Text extraction policy:',
        '• preserve original wording, punctuation, capitalization, numbers, names, dates',
        '• allowed cleanup only: fix hyphenated line breaks; merge multi-column order; remove repeated headers/footers/page numbers; collapse excessive whitespace while keeping paragraph/list structure',
        'Do NOT summarize or paraphrase.',
      ].join('\n');

      async function callExtractor(openai, fileId, attempt) {
        const messages = [
          { role: 'system', content: BASE_SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'input_text', text: BASE_PROMPT },
              { type: 'input_file', file_id: fileId },
            ],
          },
        ];
        if (attempt > 0) {
          messages.push({
            role: 'user',
            content:
              'Your previous output failed validation. Return ONLY valid JSON matching the schema. No prose. No extra keys.',
          });
        }

        const req = { model: process.env.OPENAI_MODEL || 'gpt-5-nano', input: messages };

        try {
          console.log(`🤖 Calling OpenAI with model: ${req.model}`);
          const resp = await openai.responses.create(req);
          console.log('✅ OpenAI response received');
          const text = (resp.output_text || '').trim();

          // If model still wrapped JSON in prose (just in case), extract first JSON object
          let jsonText = text;
          if (!(jsonText.startsWith('{') && jsonText.endsWith('}'))) {
            const m = text.match(/\{[\s\S]*\}$/); // naive last-brace capture
            if (m) jsonText = m[0];
          }

          const parsed = JSON.parse(jsonText);
          return { ok: true, data: parsed };
        } catch (e) {
          const msg = String(e?.message || e);
          return { ok: false, err: msg };
        }
      }

      let parsed;
      let errMsg = '';
      // Up to 2 attempts, same settings (no JSON mode), second adds a retry nudge
      for (let attempt = 0; attempt <= 1 && !parsed; attempt++) {
        const res = await callExtractor(openai, uploaded.id, attempt);
        if (!res.ok) { errMsg = res.err; continue; }
        try { parsed = ResumeSchema.parse(res.data); }
        catch (zerr) { errMsg = zerr.errors ? JSON.stringify(zerr.errors, null, 2) : String(zerr.message || zerr); }
      }
      if (!parsed) {
        throw new Error(`Failed to parse JSON after 2 attempts: ${errMsg}`);
      }

      // Store canonical resume data (AI-extracted text)
      let normalizedText = normalizeCanonicalText(parsed.text);
      
      // Single-pass normalization for performance

      const resumeData = {
        resumeId,
        name: parsed.name,
        email: parsed.email,
        phone: parsed.phone,
        canonicalText: normalizedText,
        uploadedAt: Date.now()
      };
      
      console.log('🔧 Storing resume data for ID:', resumeId);
      storeResume(resumeId, resumeData);

      // Return response
      return reply.send({
        resumeId,
        name: parsed.name,
        email: parsed.email,
        phone: parsed.phone,
        length: parsed.text.length
      });

    } catch (e) {
      req.log.error(e);
      return reply.code(500).send(err('PROCESSING_ERROR', 'Failed to process resume', { hint: e.message }));
    }
  });

  // Helper endpoint to retrieve canonical text (for other micro-prompts)
  app.get('/v1/resume/:resumeId', async (req, reply) => {
    const { resumeId } = req.params;
    const resumeData = resumeStorage.get(resumeId);
    
    if (!resumeData) {
      return reply.code(404).send(err('NOT_FOUND', 'Resume not found'));
    }
    
    return reply.send({
      resumeId,
      name: resumeData.name,
      email: resumeData.email,
      phone: resumeData.phone,
      canonicalText: resumeData.canonicalText,
      uploadedAt: resumeData.uploadedAt
    });
  });
}

function err(code, message, details = {}) {
  return { error: { code, message, details } };
}
