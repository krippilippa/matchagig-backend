// routes/resume-extract.js - AI-powered resume extraction for frontend development
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.OPENAI_MODEL || 'gpt-5-mini';

// Single optimized prompt for extracting essential resume information
const EXTRACTION_PROMPT = `Extract essential information from this resume text. Return ONLY valid JSON matching this exact schema:

{
  "extraction": {
    "basic": {
      "name": "string|null",
      "location": "string|null",
      "title": "string|null",
      "summary": "string|null",
      "yearsExperience": "number|null"
    }
  }
}

Rules:
- name: Full name as written in resume
- location: City, State/Country if present
- title: Current or most recent job title
- summary: Write a neutral, objective summary of around 100 words describing who this candidate is, their key strengths, and general background. Be objective and professional regardless of industry or seniority level.
- yearsExperience: Total years of experience (numeric only)

Extract from this resume text:
<<<RESUME_TEXT>>>`;

export default async function resumeExtractRoutes(app) {
  app.post('/v1/resume/extract', async (req, reply) => {
    try {
      const body = await req.body;
      const { canonicalText } = body || {};

      // Validation
      if (!canonicalText?.trim()) {
        return reply.code(400).send({ 
          error: 'BAD_REQUEST', 
          message: 'Provide canonicalText field' 
        });
      }

      const startTime = Date.now();

      // Check if OpenAI API key is available
      if (!process.env.OPENAI_API_KEY) {
        console.warn('OpenAI API key not configured, using fallback extraction');
        
        // Use fallback extraction when no API key
        const fallbackData = {
          extraction: {
            basic: {
              name: extractName(canonicalText),
              email: extractEmail(canonicalText),
              phone: extractPhone(canonicalText),
              location: extractLocation(canonicalText)
            },
            professional: {
              title: extractTitle(canonicalText),
              summary: extractSummary(canonicalText),
              yearsExperience: extractYearsExperience(canonicalText),
              seniority: extractSeniority(extractYearsExperience(canonicalText))
            }
          },
          processingTime: `${Date.now() - startTime}ms`,
          fallbackUsed: true,
          reason: 'No OpenAI API key configured'
        };

        return reply.send(fallbackData);
      }

      try {
        // Call OpenAI with the optimized prompt
        console.log('🤖 Attempting AI extraction with model:', MODEL);
        
        const response = await openai.chat.completions.create({
          model: MODEL,
          messages: [
            { 
              role: 'system', 
              content: 'You are a professional resume analyst. Extract information accurately and write neutral, objective summaries of around 100 words for any candidate regardless of industry or seniority level. Return only valid JSON.' 
            },
            { 
              role: 'user', 
              content: EXTRACTION_PROMPT.replace('<<<RESUME_TEXT>>>', canonicalText) 
            }
          ]
        });

        console.log('✅ AI extraction successful');
        const extractedData = JSON.parse(response.choices[0].message.content);
        const processingTime = `${Date.now() - startTime}ms`;

        // Add processing time to the response
        extractedData.processingTime = processingTime;

        return reply.send(extractedData);

      } catch (aiError) {
        // If AI extraction fails, return an error
        console.warn('❌ AI extraction failed:', aiError.message);
        return reply.code(500).send({ 
          error: 'AI_EXTRACTION_FAILED', 
          message: 'Failed to extract resume data using AI',
          details: aiError.message,
          processingTime: `${Date.now() - startTime}ms`
        });
      }
      
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ 
        error: 'EXTRACTION_FAILED', 
        message: e.message 
      });
    }
  });
}
