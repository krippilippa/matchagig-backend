import OpenAI from 'openai';
import { resumeStorage, getResume, getStorageSize, getAllResumeIds } from '../shared/storage.js';

// Shared system message for all prompts
const SYSTEM_MESSAGE = `You extract facts from a résumé. Output ONLY valid JSON matching the provided schema. Unknown → null. Use exact wording from the text. Do not summarize, infer, or add keys.`;

// Retry message for validation failures
const RETRY_MESSAGE = `Your previous output was invalid. Return ONLY valid JSON that matches the schema. No prose.`;

// Helper functions for targeted snippets
function headerSnippet(text) { 
  return text.split('\n').slice(0, 15).join('\n'); 
}

function topSnippet(text) { 
  return text.split('\n').slice(0, 120).join('\n'); 
}

// Clean employer name for display (remove trailing descriptors)
function displayEmployer(raw) {
  if (!raw) return raw;
  const m = raw.match(/^(.+?)(?:[:–—]\s+)(.+)$/); // no simple hyphen '-'
  return m ? m[1].trim() : raw;
}

// The 7 micro-prompts with their schemas
const MICRO_PROMPTS = {
  current_title: {
    prompt: `From the résumé text below, return the current or most recent job title.

Schema:
{ "currentTitle": string|null, "seniorityHint": "Junior"|"Mid"|"Senior"|"Lead/Head"|"Unknown"|null }

Rules:
- currentTitle = title of the most recent position listed OR the one marked "Present", "to date", or similar.
- Copy the title exactly as written (keep casing and punctuation).
- seniorityHint: best single-word guess based on the title wording ONLY (no date math). If unclear, "Unknown".
- If no title is clearly identifiable, set both fields to null.

Text:
<<<CANONICAL_TEXT>>>`,
    schema: {
      currentTitle: 'string|null',
      seniorityHint: '"Junior"|"Mid"|"Senior"|"Lead/Head"|"Unknown"|null'
    }
  },

  current_employer: {
    prompt: `From the résumé text below, return the current or most recent employer/company/organization.

Schema:
{ "currentEmployer": string|null }

Rules:
- currentEmployer = employer for the most recent role OR the role marked "Present"/"to date".
- Copy exactly as written (do not expand or translate).
- If unclear, return null.

Text:
<<<CANONICAL_TEXT>>>`,
    schema: { currentEmployer: 'string|null' }
  },

  total_yoe_estimate: {
    prompt: `Estimate the candidate's total years of professional experience from the résumé text.

Schema:
{ "totalYearsExperience": number|null, "basis": "self-reported"|"date-derived"|"mixed"|"unknown" }

Rules:
- Return a single number in years (decimals allowed). If uncertain, return null.
- If the résumé explicitly states "X years", prefer that and set basis="self-reported".
- If you infer from dates or phrases, basis="date-derived" or "mixed".
- Do not output ranges (use a single numeric estimate).

Text:
<<<CANONICAL_TEXT>>>`,
    schema: {
      totalYearsExperience: 'number|null',
      basis: '"self-reported"|"date-derived"|"mixed"|"unknown"'
    }
  },

  highest_education: {
    prompt: `From the résumé text below, return the highest completed education.

Schema:
{
  "level": "PhD/Doctorate"|"Master"|"Bachelor"|"Associate"|"Diploma/Certificate"|"High School"|"Unknown"|null,
  "degreeName": string|null,
  "field": string|null,
  "institution": string|null,
  "year": string|null
}

Rules:
- Identify the single highest level completed; if unclear, "Unknown".
- Copy degreeName/field/institution/year as written when available.
- If multiple items tie at the same level, choose the most recent.
- Unknown parts → null.

Text:
<<<CANONICAL_TEXT>>>`,
    schema: {
      level: '"PhD/Doctorate"|"Master"|"Bachelor"|"Associate"|"Diploma/Certificate"|"High School"|"Unknown"|null',
      degreeName: 'string|null',
      field: 'string|null',
      institution: 'string|null',
      year: 'string|null'
    }
  },

  top3_achievements: {
    prompt: `Identify up to three strongest quantified achievements (metric-first).

Schema:
{
  "achievements": [
    {
      "text": string,                            // copy minimal original line or phrase
      "value": number|null,                      // pick the main numeric value; if a range "15–20%", choose a representative mid-point (e.g., 17.5)
      "unit": "percent"|"currency"|"count"|"time"|"rate"|"other"|null,
      "subject": string|null                     // e.g., "revenue", "sales", "accounts", "NPS", "cost", "cycle time"
    }
  ]
}

Rules:
- "Quantified" means a number + an explicit unit/context (%, $, €, £, K/M, customers/accounts/revenue, days/weeks/months/hours, etc.) with a performance verb (increase/reduce/grow/improve/cut/expand/manage/achieved/drove).
- Choose the 1–3 most material achievements; prefer % or currency magnitude, then breadth (national/global).
- Keep wording faithful (light trim allowed). Unknown parts → null.
- If none exist, return {"achievements": []}.

Text:
<<<CANONICAL_TEXT>>>`,
    schema: {
      achievements: [{
        text: 'string',
        value: 'number|null',
        unit: '"percent"|"currency"|"count"|"time"|"rate"|"other"|null',
        subject: 'string|null'
      }]
    }
  },

  primary_functions: {
    prompt: `From the résumé text below, return the candidate's primary function(s).

Schema:
{ "functions": string[] }   // up to 2 items; examples: "Sales", "Operations", "Finance", "Marketing", "HR", "Product", "Engineering", "Customer Success"

Rules:
- Return 1–2 broad functions that best describe the candidate's core work from the résumé. 
- Prefer consistently repeated functions over isolated mentions.
- Use generic labels (no company-specific jargon).
- If unclear, return [].

Text:
<<<CANONICAL_TEXT>>>`,
    schema: { functions: 'string[]' }
  },

  location_simple: {
    prompt: `From the résumé text below, return the most current or primary location.

Schema:
{ "city": string|null, "country": string|null }

Rules:
- Copy city and country as written if present.
- If only one is available, return the one you have and null for the other.
- Do not infer or guess; if unclear, return nulls.

Text:
<<<CANONICAL_TEXT>>>`,
    schema: { city: 'string|null', country: 'string|null' }
  }
};

// Per-prompt schema validation functions
function assertShape_currentTitle(x) {
  return x && (typeof x.currentTitle === 'string' || x.currentTitle === null)
      && (['Junior', 'Mid', 'Senior', 'Lead/Head', 'Unknown', null].includes(x.seniorityHint));
}

function assertShape_currentEmployer(x) {
  return x && (typeof x.currentEmployer === 'string' || x.currentEmployer === null);
}

function assertShape_totalYoeEstimate(x) {
  return x && (typeof x.totalYearsExperience === 'number' || x.totalYearsExperience === null)
      && (['self-reported', 'date-derived', 'mixed', 'unknown'].includes(x.basis));
}

function assertShape_highestEducation(x) {
  return x && (['PhD/Doctorate', 'Master', 'Bachelor', 'Associate', 'Diploma/Certificate', 'High School', 'Unknown', null].includes(x.level))
      && (typeof x.degreeName === 'string' || x.degreeName === null)
      && (typeof x.field === 'string' || x.field === null)
      && (typeof x.institution === 'string' || x.institution === null)
      && (typeof x.year === 'string' || x.year === null);
}

function assertShape_top3Achievements(x) {
  return x && Array.isArray(x.achievements) && x.achievements.every(achievement => 
    typeof achievement.text === 'string' &&
    (typeof achievement.value === 'number' || achievement.value === null) &&
    (['percent', 'currency', 'count', 'time', 'rate', 'other', null].includes(achievement.unit)) &&
    (typeof achievement.subject === 'string' || achievement.subject === null)
  );
}

function assertShape_primaryFunctions(x) {
  return x && Array.isArray(x.functions) && x.functions.every(f => typeof f === 'string');
}

function assertShape_locationSimple(x) {
  return x && (typeof x.city === 'string' || x.city === null)
      && (typeof x.country === 'string' || x.country === null);
}

// Validation mapping
const VALIDATORS = {
  current_title: assertShape_currentTitle,
  current_employer: assertShape_currentEmployer,
  total_yoe_estimate: assertShape_totalYoeEstimate,
  highest_education: assertShape_highestEducation,
  top3_achievements: assertShape_top3Achievements,
  primary_functions: assertShape_primaryFunctions,
  location_simple: assertShape_locationSimple
};

// Run a single micro-prompt with retry logic and capability negotiation
async function runMicroPrompt(openai, basePrompt, canonicalText, promptKey, maxRetries = 1) {
  const userMsg = basePrompt.replace('<<<CANONICAL_TEXT>>>', canonicalText);

  // Try capabilities in descending order; fall back if the model rejects a param.
  let tryResponseFormat = true;
  let tryTemperature = false; // default OFF for gpt-5-nano to avoid API errors

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const messages = [
        { role: 'system', content: SYSTEM_MESSAGE },
        { role: 'user', content: userMsg }
      ];
      
      // Add retry message as second user message if this is a retry
      if (attempt > 0) {
        messages.push({ role: 'user', content: RETRY_MESSAGE });
      }

      const req = {
        model: process.env.OPENAI_MODEL || 'gpt-5-nano',
        input: messages,
      };

      if (tryTemperature) req.temperature = 0.1;           // only if enabled
      if (tryResponseFormat) req.response_format = { type: 'json_object' };

      const resp = await openai.responses.create(req);
      const outputText = (resp.output_text || '').trim();
      const parsed = JSON.parse(outputText);
      
      // Basic validation - ensure it's valid JSON
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('Output is not a valid JSON object');
      }
      
      // Schema validation using the appropriate validator
      const validator = VALIDATORS[promptKey];
      if (validator && !validator(parsed)) {
        throw new Error('Output does not match expected schema');
      }
      
      return { success: true, data: parsed };
      
    } catch (error) {
      // Handle unsupported parameter fallbacks based on error message
      const msg = String(error?.message || error);
      if (/Unsupported parameter/i.test(msg)) {
        if (/response_format/i.test(msg) && tryResponseFormat) {
          tryResponseFormat = false;           // retry without response_format
          continue;
        }
        if (/temperature/i.test(msg) && tryTemperature) {
          tryTemperature = false;              // retry without temperature
          continue;
        }
      }
      
      if (attempt === maxRetries) {
        return { 
          success: false, 
          error: `Failed after ${maxRetries + 1} attempts: ${msg}` 
        };
      }
      // otherwise, loop and retry with same prompt (we already append RETRY_MESSAGE on attempt>0)
    }
  }
}

export default async function overviewRoute(app) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  app.post('/v1/overview', async (req, reply) => {
    if (!process.env.OPENAI_API_KEY) {
      return reply.code(500).send(err('CONFIG', 'OPENAI_API_KEY not set'));
    }

    try {
      const body = await req.body;
      const resumeId = (body?.resumeId || '').toString();

      if (!resumeId) {
        return reply.code(400).send(err('BAD_REQUEST', 'Required: { resumeId }'));
      }

      // Fetch canonical text from storage
      const resumeData = getResume(resumeId);
      console.log('🔧 Overview route: Looking for resumeId:', resumeId);
      console.log('🔧 Overview route: Current storage size:', getStorageSize());
      console.log('🔧 Overview route: Stored keys:', getAllResumeIds());
      console.log('🔧 Overview route: Found resume data:', !!resumeData);
      
      if (!resumeData) {
        return reply.code(404).send(err('NOT_FOUND', 'Resume not found. Please upload first.'));
      }

      const { canonicalText, name, email, phone } = resumeData;
      
      // Run all 7 micro-prompts in parallel with targeted snippets
      const promptPromises = Object.entries(MICRO_PROMPTS).map(async ([key, config]) => {
        let textToUse = canonicalText;
        
        // Use targeted snippets for specific prompts
        if (key === 'current_title' || key === 'current_employer') {
          textToUse = topSnippet(canonicalText);
        } else if (key === 'location_simple') {
          textToUse = headerSnippet(canonicalText);
        }
        
        const result = await runMicroPrompt(openai, config.prompt, textToUse, key);
        return { key, ...result };
      });

      const results = await Promise.allSettled(promptPromises);
      
      // Process results and handle both fulfilled and rejected promises
      const processedResults = results.map((result, index) => {
        if (result.status === 'fulfilled') {
          return result.value;
        } else {
          const key = Object.keys(MICRO_PROMPTS)[index];
          return { 
            key, 
            success: false, 
            error: `Promise rejected: ${result.reason?.message || 'Unknown error'}` 
          };
        }
      });
      
      // Process results and build overview
      const answers = {};
      const errors = [];
      
      processedResults.forEach(result => {
        if (result.success) {
          answers[result.key] = result.data;
        } else {
          errors.push({ key: result.key, error: result.error });
          answers[result.key] = null; // Set to null for failed prompts
        }
      });

      // Build compact overview payload
      const overview = {
        title: answers.current_title?.currentTitle || null,
        seniorityHint: answers.current_title?.seniorityHint || null,
        employer: displayEmployer(answers.current_employer?.currentEmployer || null),
        yoe: answers.total_yoe_estimate?.totalYearsExperience || null,
        yoeBasis: answers.total_yoe_estimate?.basis || null,
        education: answers.highest_education || null,
        topAchievements: answers.top3_achievements?.achievements || [],
        functions: answers.primary_functions?.functions || [],
        location: {
          city: answers.location_simple?.city || null,
          country: answers.location_simple?.country || null
        }
      };

      // Return overview with metadata
      return reply.send({
        resumeId,
        name,
        email,
        phone,
        overview,
        metadata: {
          promptVersion: 'v1',
          canonicalTextLength: canonicalText.length,
          errors: errors.length > 0 ? errors : undefined,
          timestamp: new Date().toISOString()
        }
      });

    } catch (e) {
      req.log.error(e);
      return reply.code(500).send(err('OVERVIEW_ERROR', 'Failed to generate overview', { hint: e.message }));
    }
  });
}

function err(code, message, details = {}) {
  return { error: { code, message, details } };
}
