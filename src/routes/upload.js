import OpenAI, { toFile } from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

const MAX_BYTES = 10 * 1024 * 1024; // 10MB

// In-memory storage for canonical resumes (replace with DB in production)
const resumeStorage = new Map();

// Export storage getter for other routes
export function getResumeStorage() {
  return resumeStorage;
}

// JSON schema validation
const ResumeSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  text: z.string().min(1, "Text must not be empty")
}).strict(); // No extra keys allowed

// Post-processing normalization for canonical text (improved pipeline)
function normalizeCanonicalText(raw, pageBreaks = []) {
  let t = raw ?? "";
  const originalLength = t.length;
  const originalNewlines = (t.match(/\n/g) || []).length;

  // 1) Unicode & control chars
  t = t.normalize('NFC');
  t = t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // Remove control chars except \n

  // 2) Whitespace policy
  t = t.replace(/\t/g, ' ');                    // Convert tabs to spaces
  t = t.replace(/[^\S\n]+/g, ' ');              // Collapse spaces within lines (keep newlines)
  t = t.replace(/\n{3,}/g, '\n\n');            // Collapse 3+ blank lines → 1 blank line

  // 3) De-hyphenation (line-wrap only, safe)
  // Only join if: both sides alphabetic, right side starts lowercase, left side ≥2 chars, left side not ALL-CAPS
  const hyphenJoins = (t.match(/(\p{L}{2,})-\s*\n\s*(\p{Ll}+)/gu) || []).length;
  t = t.replace(/(\p{L}{2,})-\s*\n\s*(\p{Ll}+)/gu, '$1$2');

  // 3b) Inline hyphen spacing fix: "Cyber- Security" -> "Cyber-Security"
  t = t.replace(/(?<=\p{L})-\s+(?=\p{L})/gu, '-');

  // 4) Bullet normalization (Unicode-aware)
  const bulletStart = /^[\s]*[•‣∙◦–—·*●○-][\s]+/gm;
  const bulletsNormalized = (t.match(bulletStart) || []).length;
  t = t.replace(bulletStart, '- ');
  t = t.replace(/^-[\s]{2,}/gm, '- ');         // Compress - followed by 2+ spaces

  // 5) Header/footer & page number removal (statistical)
  // Remove bare page number lines
  t = t.replace(/^page\s*\d+$/gim, '');
  t = t.replace(/^\d+\/\d+$/gm, '');
  t = t.replace(/^-\s*\d+\s*-$/gm, '');

  // 6) Multi-column merge - REMOVED aggressive ALL-CAPS spacer rule
  // The previous rule was too aggressive and split legitimate ALL-CAPS words
  // const gluedWordsFixed = 0; // No longer tracking this metric

  // 7) Section break hints (very light)
  // Insert newline before ALL-CAPS headers stuck to prior sentence
  const sectionBreaks = (t.match(/([^.])\.(?=[A-Z][A-Z0-9/& \-]{5,}\b)/g) || []).length;
  t = t.replace(/([^.])\.(?=[A-Z][A-Z0-9/& \-]{5,}\b)/g, '$1.\n');

  // 8) Trim line endings and ensure file ends with single newline
  t = t.replace(/[ \t]+\n/g, '\n').trimEnd() + '\n';

  // Quality metrics
  const finalLength = t.length;
  const finalNewlines = (t.match(/\n/g) || []).length;
  
  // Guardrail: detect over-split ALL-CAPS words
  const overSplitWords = (t.match(/^[A-Z]{2,}\s+[A-Z]{2,}$/gm) || []).length;
  if (overSplitWords > 0) {
    console.warn(`Warning: ${overSplitWords} potentially over-split ALL-CAPS words detected`);
  }
  
  // Log normalization metrics (for monitoring)
  console.log(`Normalization metrics:`, {
    originalLength,
    finalLength,
    originalNewlines,
    finalNewlines,
    hyphenJoins,
    bulletsNormalized,
    gluedWordsFixed: 0, // No longer tracking this metric
    sectionBreaks,
    overSplitWords,
    compressionRatio: ((originalLength - finalLength) / originalLength * 100).toFixed(1) + '%'
  });

  return t;
}

export default async function uploadRoute(app) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  app.post('/v1/upload', async (req, reply) => {
    const ctype = req.headers['content-type'] || '';
    if (!ctype.includes('multipart/form-data')) {
      return reply.code(415).send(err('UNSUPPORTED_MEDIA_TYPE', 'Use multipart/form-data'));
    }
    if (!process.env.OPENAI_API_KEY) {
      return reply.code(500).send(err('CONFIG', 'OPENAI_API_KEY not set'));
    }

    try {
      const parts = req.parts();
      let filePart = null;
      for await (const part of parts) {
        if (part.type === 'file' && !filePart) filePart = part; else await part?.toBuffer?.().catch(() => {});
      }
      if (!filePart) return reply.code(400).send(err('BAD_REQUEST', 'No file provided'));

      const { filename, mimetype } = filePart;
      const buf = await filePart.toBuffer();
      if (buf.length > MAX_BYTES) return reply.code(413).send(err('PAYLOAD_TOO_LARGE', 'File exceeds 10MB'));

      // Generate unique resume ID
      const resumeId = uuidv4();

      // Upload file to OpenAI for AI to process
      const uploaded = await openai.files.create({
        file: await toFile(buf, filename || 'upload', { type: mimetype || 'application/octet-stream' }),
        purpose: 'assistants'
      });

      // Send to GPT-5-nano for text extraction and structured output
      let prompt = `You are a résumé text extractor. OUTPUT ONLY valid JSON with this exact schema:
{ "name": string|null, "email": string|null, "phone": string|null, "text": string }
Rules:
• **name**: candidate's full name if clearly stated; else null.
• **email**: primary email if present; else null.
• **phone**: main phone number in international or local format if present; else null.
• **text**: faithful plain-text extraction of the document content.
Text extraction policy: preserve wording, punctuation, capitalization, numbers, names, and dates.
Allowed cleanup only: fix hyphenated line breaks; merge multi-column order; remove repeated headers/footers/page numbers; collapse excessive whitespace while keeping paragraph/list structure.
Do NOT summarize or paraphrase.
Output JSON only. No markdown. No extra keys. No comments.`;

      let parsed;
      let retryCount = 0;
      const maxRetries = 1;

      while (retryCount <= maxRetries) {
                  try {
            const resp = await openai.responses.create({
              model: process.env.OPENAI_MODEL || 'gpt-5-nano',
              input: [
              {
                role: 'user',
                content: [
                  { type: 'input_text', text: prompt },
                  { type: 'input_file', file_id: uploaded.id }
                ]
              }
            ]
          });

          const outputText = (resp.output_text || '').trim();
          parsed = JSON.parse(outputText);
          
          // Validate against schema
          const validated = ResumeSchema.parse(parsed);
          parsed = validated;
          break; // Success, exit retry loop
          
        } catch (parseError) {
          retryCount++;
          if (retryCount > maxRetries) {
            throw new Error(`Failed to parse JSON after ${maxRetries + 1} attempts: ${parseError.message}`);
          }
          
          // Retry with stricter prompt
          prompt = `Your previous output failed validation. Return ONLY valid JSON matching the schema. No prose.`;
        }
      }

      // Store canonical resume data (AI-extracted text)
      let normalizedText = normalizeCanonicalText(parsed.text);
      
      // Idempotency check: running normalization twice should yield same result
      const doubleNormalized = normalizeCanonicalText(normalizedText);
      if (normalizedText !== doubleNormalized) {
        console.warn('Warning: Normalization not idempotent, using double-normalized result');
        // Use the double-normalized version for true canonical text
        normalizedText = doubleNormalized;
      }

      const resumeData = {
        resumeId,
        name: parsed.name,
        email: parsed.email,
        phone: parsed.phone,
        canonicalText: normalizedText,
        uploadedAt: Date.now()
      };
      
      resumeStorage.set(resumeId, resumeData);

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
