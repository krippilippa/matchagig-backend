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

// Post-processing normalization for canonical text
function normalizeCanonicalText(text) {
  return text
    // 1. Whitespace & tabs normalization
    .replace(/\t/g, ' ')                    // Convert tabs to spaces
    .replace(/[ \t]+/g, ' ')                // Collapse multiple spaces/tabs to single space
    
    // 2. Hyphenation rules - join words split by linebreak hyphens
    .replace(/([A-Za-z])-\s*\n\s*([A-Za-z])/g, '$1$2')  // Linebreak hyphens
    .replace(/([A-Za-z])-\s+([A-Za-z])/g, '$1$2')       // Space-separated hyphens
    
    // 3. UTF-8 normalization and control chars
    .normalize('NFC')                       // Normalize to NFC
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')  // Remove control chars
    
    // 4. Bullet normalization - standardize all list markers
    .replace(/^[•–—]\s*/gm, '- ')           // Convert bullets to standard format
    .replace(/^[-]\s*/gm, '- ')             // Ensure consistent spacing
    
    // 5. Header/footer scrubbing
    .replace(/^Page\s+\d+$/gm, '')          // Remove page numbers
    .replace(/^\s*$/gm, '')                 // Remove empty lines
    
    // 6. Final whitespace cleanup while preserving structure
    .replace(/\n\s*\n\s*\n/g, '\n\n')      // Max 2 consecutive line breaks
    .replace(/^\s+|\s+$/gm, '')            // Trim lines
    .trim();                                // Trim overall text
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
      const resumeData = {
        resumeId,
        name: parsed.name,
        email: parsed.email,
        phone: parsed.phone,
        canonicalText: normalizeCanonicalText(parsed.text),
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
