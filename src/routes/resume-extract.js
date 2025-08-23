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
      "blurb": "string|null",
      "summary": "string|null",
      "yearsExperience": "number|null"
    }
  }
}

Rules:
- name: Full name as written in resume
- location: City, State/Country if present
- title: Current or most recent job title
- blurb: Quick one-sentence overview (5-10 words max) describing who they are professionally
- summary: Write a neutral, objective summary of around 100 words describing who this candidate is, their key strengths, and general background. Be objective and professional regardless of industry or seniority level.
- yearsExperience: Total years of experience (numeric only)

Extract from this resume text:
<<<RESUME_TEXT>>>`;

export default async function resumeExtractRoutes(app) {
  app.post('/v1/resume/extract', async (req, reply) => {
    const requestId = Math.random().toString(36).substring(7);
    console.log(`🚀 [${requestId}] Resume extraction request started`);
    
    try {
      const body = await req.body;
      const { canonicalText } = body || {};

      console.log(`📥 [${requestId}] Request body received:`, {
        hasCanonicalText: !!canonicalText,
        textLength: canonicalText?.length || 0,
        textPreview: canonicalText?.substring(0, 100) + '...' || 'None'
      });

      // Validation
      if (!canonicalText?.trim()) {
        console.log(`❌ [${requestId}] Validation failed: No canonicalText provided`);
        return reply.code(400).send({ 
          error: 'BAD_REQUEST', 
          message: 'Provide canonicalText field' 
        });
      }

      const startTime = Date.now();
      console.log(`⏱️ [${requestId}] Starting extraction process`);

      // Check if OpenAI API key is available
      if (!process.env.OPENAI_API_KEY) {
        console.warn(`⚠️ [${requestId}] OpenAI API key not configured, using fallback extraction`);
        
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

        console.log(`✅ [${requestId}] Fallback extraction completed in ${Date.now() - startTime}ms`);
        return reply.send(fallbackData);
      }

      try {
        // Call OpenAI with the optimized prompt
        console.log(`🤖 [${requestId}] Attempting AI extraction with model: ${MODEL}`);
        console.log(`📝 [${requestId}] Sending prompt to OpenAI...`);
        
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

        console.log(`✅ [${requestId}] OpenAI API call successful`);
        console.log(`📊 [${requestId}] OpenAI response details:`, {
          model: response.model,
          usage: response.usage,
          finishReason: response.choices[0]?.finish_reason,
          responseLength: response.choices[0]?.message?.content?.length || 0
        });

        const rawResponse = response.choices[0].message.content;
        console.log(`📄 [${requestId}] Raw LLM response:`, rawResponse);

        try {
          const extractedData = JSON.parse(rawResponse);
          console.log(`✅ [${requestId}] JSON parsing successful`);
          console.log(`🔍 [${requestId}] Parsed data structure:`, {
            hasExtraction: !!extractedData.extraction,
            hasBasic: !!extractedData.extraction?.basic,
            fields: extractedData.extraction?.basic ? Object.keys(extractedData.extraction.basic) : 'None'
          });

          const processingTime = `${Date.now() - startTime}ms`;
          extractedData.processingTime = processingTime;

          console.log(`🎉 [${requestId}] Extraction completed successfully in ${processingTime}`);
          return reply.send(extractedData);

        } catch (jsonError) {
          console.error(`❌ [${requestId}] JSON parsing failed:`, jsonError.message);
          console.error(`📄 [${requestId}] Failed to parse response:`, rawResponse);
          throw new Error(`JSON parsing failed: ${jsonError.message}`);
        }

      } catch (aiError) {
        // If AI extraction fails, return an error
        console.error(`❌ [${requestId}] AI extraction failed:`, aiError.message);
        console.error(`🔍 [${requestId}] Error details:`, {
          name: aiError.name,
          message: aiError.message,
          stack: aiError.stack?.substring(0, 200) + '...' || 'No stack'
        });
        
        return reply.code(500).send({ 
          error: 'AI_EXTRACTION_FAILED', 
          message: 'Failed to extract resume data using AI',
          details: aiError.message,
          processingTime: `${Date.now() - startTime}ms`,
          requestId: requestId
        });
      }
      
    } catch (e) {
      console.error(`💥 [${requestId}] Unexpected error:`, e.message);
      console.error(`🔍 [${requestId}] Full error:`, e);
      req.log.error(e);
      return reply.code(500).send({ 
        error: 'EXTRACTION_FAILED', 
        message: e.message,
        requestId: requestId
      });
    }
  });
}
