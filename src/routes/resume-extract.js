// routes/resume-extract.js - AI-powered resume extraction for frontend development
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Single optimized prompt for extracting essential resume information
const EXTRACTION_PROMPT = `Extract essential information from this resume text. Return ONLY valid JSON matching this exact schema:

{
  "extraction": {
    "basic": {
      "name": "string|null",
      "email": "string|null", 
      "phone": "string|null",
      "location": "string|null"
    },
    "professional": {
      "title": "string|null",
      "summary": "string|null",
      "yearsExperience": "number|null",
      "seniority": "Junior|Mid|Senior|Lead/Head|Director+|Unknown|null"
    }
  }
}

Rules:
- name: Full name as written in resume
- email: Email address if present
- phone: Phone number if present  
- location: City, State/Country if present
- title: Current or most recent job title
- summary: Professional summary or objective (1-2 sentences max)
- yearsExperience: Total years of experience (numeric only)
- seniority: Infer from title/experience (Junior=0-2y, Mid=3-5y, Senior=6-8y, Lead/Head=9-12y, Director+=13y+)

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
        const response = await openai.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
          messages: [
            { 
              role: 'system', 
              content: 'You are a resume parsing expert. Extract information accurately and return only valid JSON.' 
            },
            { 
              role: 'user', 
              content: EXTRACTION_PROMPT.replace('<<<RESUME_TEXT>>>', canonicalText) 
            }
          ],
          temperature: 0, // Ensure consistent output
          max_tokens: 500,
          response_format: { type: 'json_object' }
        });

        const extractedData = JSON.parse(response.choices[0].message.content);
        const processingTime = `${Date.now() - startTime}ms`;

        // Validate the extracted data structure
        if (!extractedData.extraction || !extractedData.extraction.basic || !extractedData.extraction.professional) {
          throw new Error('Invalid extraction structure returned from AI');
        }

        // Add processing time to the response
        extractedData.processingTime = processingTime;

        return reply.send(extractedData);

      } catch (aiError) {
        // If AI extraction fails, provide a fallback with basic info
        console.warn('AI extraction failed, using fallback:', aiError.message);
        
        // Simple fallback extraction using regex patterns
        const yearsExp = extractYearsExperience(canonicalText);
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
              yearsExperience: yearsExp,
              seniority: extractSeniority(yearsExp)
            }
          },
          processingTime: `${Date.now() - startTime}ms`,
          fallbackUsed: true,
          reason: 'AI extraction failed, using regex fallback'
        };

        return reply.send(fallbackData);
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

// Fallback extraction functions using regex patterns
function extractName(text) {
  // Look for common name patterns at the beginning
  const nameMatch = text.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/);
  return nameMatch ? nameMatch[1] : null;
}

function extractEmail(text) {
  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return emailMatch ? emailMatch[0] : null;
}

function extractPhone(text) {
  const phoneMatch = text.match(/(\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  return phoneMatch ? phoneMatch[0] : null;
}

function extractLocation(text) {
  // Look for city, state/country patterns
  const locationMatch = text.match(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z][a-z]+)/);
  return locationMatch ? locationMatch[1] : null;
}

function extractTitle(text) {
  // Look for job titles in the first few lines
  const lines = text.split('\n').slice(0, 10);
  for (const line of lines) {
    const titleMatch = line.match(/(?:^|\s)((?:Senior\s+)?(?:Software\s+)?(?:Engineer|Developer|Manager|Analyst|Consultant|Specialist|Coordinator|Assistant|Director|Lead|Head))/i);
    if (titleMatch) return titleMatch[1];
  }
  return null;
}

function extractSummary(text) {
  // Look for summary/objective sections
  const summaryMatch = text.match(/(?:summary|objective|profile)[:\s]+([^.\n]+(?:[.\n][^.\n]+)*)/i);
  return summaryMatch ? summaryMatch[1].trim() : null;
}

function extractYearsExperience(text) {
  // Look for years of experience patterns
  const yearsMatch = text.match(/(\d+)\+?\s*(?:years?|yrs?)\s+(?:of\s+)?experience/i);
  if (yearsMatch) return parseInt(yearsMatch[1]);
  
  // Look for date ranges to estimate
  const dateMatch = text.match(/(\d{4})\s*[-–]\s*(\d{4}|present|current)/i);
  if (dateMatch) {
    const startYear = parseInt(dateMatch[1]);
    const endYear = dateMatch[2].toLowerCase() === 'present' || dateMatch[2].toLowerCase() === 'current' 
      ? new Date().getFullYear() 
      : parseInt(dateMatch[2]);
    return endYear - startYear;
  }
  
  return null;
}

function extractSeniority(years) {
  if (!years) return 'Unknown';
  if (years <= 2) return 'Junior';
  if (years <= 5) return 'Mid';
  if (years <= 8) return 'Senior';
  if (years <= 12) return 'Lead/Head';
  return 'Director+';
}
