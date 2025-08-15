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
  text: z.string().min(1, "Text must not be empty")
}).strict(); // No extra keys allowed

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
      let prompt = `You are a résumé text extractor. Read the attached file and OUTPUT ONLY valid JSON with this exact schema:
{
  "name": string|null,
  "email": string|null,
  "text": string
}
Rules:
- name: full candidate name if clearly stated; else null.
- email: primary email if present; else null.
- text: faithful plain-text extraction of the document content.
Text extraction rules:
- Preserve all wording, punctuation, capitalization, numbers, names, and dates.
- Allowed cleanup: fix hyphenated line breaks; merge multi-column order; remove repeated headers/footers/page numbers; collapse excessive whitespace while keeping paragraph/list structure.
- Do NOT summarize, paraphrase, or infer content.
Output JSON only. No markdown, no extra keys, no comments.`;

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
        canonicalText: parsed.text,
        uploadedAt: Date.now()
      };
      
      resumeStorage.set(resumeId, resumeData);

      // Return response
      return reply.send({
        resumeId,
        name: parsed.name,
        email: parsed.email,
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
      canonicalText: resumeData.canonicalText,
      uploadedAt: resumeData.uploadedAt
    });
  });
}

function err(code, message, details = {}) {
  return { error: { code, message, details } };
}
