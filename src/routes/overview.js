import OpenAI from 'openai';
import { resumeStorage, getResume, getStorageSize, getAllResumeIds } from '../shared/storage.js';

// Shared system message for all prompts
const SYSTEM_MESSAGE = `You extract facts from a résumé. Output ONLY valid JSON matching the provided schema. Unknown → null. Use exact wording from the text. Do not summarize, infer, or add keys.`;

// Retry message for validation failures
const RETRY_MESSAGE = `Your previous output was invalid. Return ONLY valid JSON that matches the schema. No prose.`;

// Helper functions for targeted snippets (no longer used - sending full text for maximum accuracy)

// Clean employer name for display (remove trailing descriptors)
function displayEmployer(raw) {
  if (!raw) return raw;
  const m = raw.match(/^(.+?)(?:[:–—]\s+)(.+)$/); // no simple hyphen '-'
  return m ? m[1].trim() : raw;
}

// URL normalization helpers for public links
function normalizeUrl(u) {
  if (!u) return u;
  // add protocol if missing
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
  // trim spaces
  return u.trim();
}

function normalizePublicLinks(links) {
  if (!links) return links;
  for (const k of ["linkedin","github","website","portfolio","behance","dribbble","x"]) {
    if (links[k]) links[k] = normalizeUrl(links[k]);
  }
  return links;
}

// The 7 micro-prompts with their schemas
const MICRO_PROMPTS = {
  top3_achievements: {
    prompt: `Identify up to three achievements from the résumé.

Schema:
{ "achievements": [ { "text": string } ] }

Rules:
- An achievement is a completed result or change — something that happened and is done.  
  It can be a win, improvement, launch, delivery, resolved problem, secured deal, growth, or any measurable success.
- Do NOT include:
  • Ongoing tasks or maintenance (e.g., "Maintained accounts", "Managing daily operations") unless tied to a clear outcome.
  • Pure responsibilities (e.g., "Responsible for...", "Leading a team") without a stated result.
  • Generic skills or capability statements.
- Copy the exact wording from the résumé, but remove any numbers, units, and currency symbols.
- Keep each item concise (one sentence or clause).
- If no qualifying achievements exist, return { "achievements": [] }.
- JSON only.

Text:
<<<CANONICAL_TEXT>>>`,
    schema: {
      achievements: [{ text: 'string' }]
    }
  },

  top_hard_skills: {
    prompt: `From the résumé text below, extract the top hard skills/tools (normalized).

Schema:
{ "skills": string[] }

Rules:
- Return 5–10 concise, deduplicated hard skills/tools (e.g., "Excel", "SQL", "Photoshop", "Figma", "Python", "HubSpot").
- No soft skills (e.g., "communication", "teamwork"), no duties ("stakeholder management"), no company names.
- Capitalize properly; keep acronyms uppercase (e.g., "SQL", "CRM").
- If fewer than 5 clear items exist, return whatever is confidently present.
- Output one single minified JSON object. No markdown, no backticks, no comments.

Text:
<<<CANONICAL_TEXT>>>`,
    schema: { skills: 'string[]' }
  },

  leadership_summary: {
    prompt: `From the résumé text below, extract signals of people leadership and hiring experience.

Schema:
{ "peopleManagedMax": number|null, "hiringExperience": boolean }

Rules:
- peopleManagedMax = the largest team size the candidate led or managed at any time (e.g., "Led a team of 8" → 8). If multiple sizes appear, return the maximum. If not found, null.
- Count both direct and indirect reports when stated; if only "cross-functional teams" with no number, do not infer a number → leave null.
- hiringExperience = true if résumé explicitly mentions hiring, recruiting, interviewing, sourcing, building a team, or owning headcount; else false.
- Output one single minified JSON object. No markdown, no backticks, no comments.

Text:
<<<CANONICAL_TEXT>>>`,
    schema: {
      peopleManagedMax: 'number|null',
      hiringExperience: 'boolean'
    }
  },

  // merged prompts below
  // Merged: current_title + current_employer + location_simple
  role_header: {
    prompt: `Extract current role and location from the résumé text.

Schema:
{
  "currentTitle": string|null,
  "seniorityHint": "Junior"|"Mid"|"Senior"|"Lead/Head"|"Unknown"|null,
  "employerRaw": string|null,
  "employerName": string|null,
  "employerDescriptor": string|null,
  "location": { "city": string|null, "country": string|null }
}

Rules:
- currentTitle/employer = most recent or marked "Present/to date".
- Copy exact wording; no normalization/translation.
- location: prefer header; else current role line; else nulls.
- Output one single minified JSON object. No markdown/backticks.

Text:
<<<CANONICAL_TEXT>>>`,
    schema: {
      currentTitle: 'string|null',
      seniorityHint: '"Junior"|"Mid"|"Senior"|"Lead/Head"|"Unknown"|null',
      employerRaw: 'string|null',
      employerName: 'string|null',
      employerDescriptor: 'string|null',
      location: { city: 'string|null', country: 'string|null' }
    }
  },

  // Merged: total_yoe_estimate + primary_functions
  experience_signals: {
    prompt: `Extract experience signals.

Schema:
{
  "selfReportedYears": number|null,
  "dateDerivedYears": number|null,
  "functions": string[]
}

Rules:
- selfReportedYears only if literally stated ("X years").
- dateDerivedYears = rough single number from dates/tenure cues.
- functions: 1–2 generic domains (e.g., "Sales","Marketing","HR","Product","Engineering","Customer Success"). Title Case.
- Output one single minified JSON object. No markdown/backticks.

Text:
<<<CANONICAL_TEXT>>>`,
    schema: {
      selfReportedYears: 'number|null',
      dateDerivedYears: 'number|null',
      functions: 'string[]'
    }
  },

  // Merged: languages + availability + public_links
  profile_extras: {
    prompt: `Extract languages, availability, and public links.

Schema:
{
  "languages": [ { "name": string, "proficiency": "Native"|"C2"|"C1"|"B2"|"B1"|"A2"|"A1"|"Unknown" } ],
  "availability": { "availability": "Immediate"|"Notice"|"Unknown", "noticeDays": number|null },
  "links": { "linkedin": string|null, "github": string|null, "website": string|null, "portfolio": string|null, "behance": string|null, "dribbble": string|null, "x": string|null }
}

Rules:
- Map language wording to CEFR when possible; else Unknown.
- Availability: see/convert notice period; else Unknown.
- Links: return full URLs; prepend https:// if protocol missing.
- Output one single minified JSON object. No markdown/backticks.

Text:
<<<CANONICAL_TEXT>>>`,
    schema: {
      languages: [{ name: 'string', proficiency: '"Native"|"C2"|"C1"|"B2"|"B1"|"A2"|"A1"|"Unknown"' }],
      availability: { availability: '"Immediate"|"Notice"|"Unknown"', noticeDays: 'number|null' },
      links: {
        linkedin: 'string|null', github: 'string|null', website: 'string|null',
        portfolio: 'string|null', behance: 'string|null', dribbble: 'string|null', x: 'string|null'
      }
    }
  },

  // Merged: highest_education + certifications
  credentials: {
    prompt: `Extract highest education and certifications/licenses.

Schema:
{
  "education": { "level": "PhD/Doctorate"|"Master"|"Bachelor"|"Associate"|"Diploma/Certificate"|"High School"|"Unknown"|null, "degreeName": string|null, "field": string|null, "institution": string|null, "year": string|null },
  "certifications": [ { "name": string, "issuer": string|null, "year": string|null } ]
}

Rules:
- Choose a single highest completed level; unknown parts → null.
- Certifications: real credentials only; dedupe exact duplicates.
- Output one single minified JSON object. No markdown/backticks.

Text:
<<<CANONICAL_TEXT>>>`,
    schema: {
      education: {
        level: '"PhD/Doctorate"|"Master"|"Bachelor"|"Associate"|"Diploma/Certificate"|"High School"|"Unknown"|null',
        degreeName: 'string|null', field: 'string|null', institution: 'string|null', year: 'string|null'
      },
      certifications: [{ name: 'string', issuer: 'string|null', year: 'string|null' }]
    }
  }
};

// Per-prompt schema validation functions
function assertShape_top3Achievements(x) {
  return x && Array.isArray(x.achievements) && x.achievements.every(a => typeof a.text === 'string');
}

function assertShape_topHardSkills(x) {
  return x && Array.isArray(x.skills) && x.skills.every(s => typeof s === 'string');
}

function assertShape_leadershipSummary(x) {
  return x && (typeof x.peopleManagedMax === 'number' || x.peopleManagedMax === null) && (typeof x.hiringExperience === 'boolean');
}

// Validators for merged prompts
function assertShape_roleHeader(x) {
  return x && (typeof x.currentTitle === 'string' || x.currentTitle === null)
    && (["Junior", "Mid", "Senior", "Lead/Head", "Unknown", null].includes(x.seniorityHint))
    && (typeof x.employerRaw === 'string' || x.employerRaw === null)
    && (typeof x.employerName === 'string' || x.employerName === null)
    && (typeof x.employerDescriptor === 'string' || x.employerDescriptor === null)
    && x.location && (typeof x.location.city === 'string' || x.location.city === null)
    && (typeof x.location.country === 'string' || x.location.country === null);
}

function assertShape_experienceSignals(x) {
  return x && (typeof x.selfReportedYears === 'number' || x.selfReportedYears === null)
    && (typeof x.dateDerivedYears === 'number' || x.dateDerivedYears === null)
    && Array.isArray(x.functions) && x.functions.every(s => typeof s === 'string');
}

function assertShape_profileExtras(x) {
  const okLanguages = Array.isArray(x.languages) && x.languages.every(l => typeof l.name === 'string' && ["Native","C2","C1","B2","B1","A2","A1","Unknown"].includes(l.proficiency));
  const okAvailability = x.availability && (["Immediate","Notice","Unknown"].includes(x.availability.availability)) && (typeof x.availability.noticeDays === 'number' || x.availability.noticeDays === null);
  const p = x.links;
  const keys = ["linkedin","github","website","portfolio","behance","dribbble","x"];
  const okLinks = p && typeof p === 'object' && keys.every(k => typeof p[k] === 'string' || p[k] === null);
  return okLanguages && okAvailability && okLinks;
}

function assertShape_credentials(x) {
  const e = x && x.education;
  const okEdu = e && (["PhD/Doctorate","Master","Bachelor","Associate","Diploma/Certificate","High School","Unknown", null].includes(e.level))
    && (typeof e.degreeName === 'string' || e.degreeName === null)
    && (typeof e.field === 'string' || e.field === null)
    && (typeof e.institution === 'string' || e.institution === null)
    && (typeof e.year === 'string' || e.year === null);
  const okCerts = Array.isArray(x.certifications) && x.certifications.every(c => typeof c.name === 'string' && (typeof c.issuer === 'string' || c.issuer === null) && (typeof c.year === 'string' || c.year === null));
  return okEdu && okCerts;
}

// Validation mapping
const VALIDATORS = {
  top3_achievements: assertShape_top3Achievements,
  top_hard_skills: assertShape_topHardSkills,
  leadership_summary: assertShape_leadershipSummary,
  role_header: assertShape_roleHeader,
  experience_signals: assertShape_experienceSignals,
  profile_extras: assertShape_profileExtras,
  credentials: assertShape_credentials
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
      
      // Run all 7 micro-prompts in parallel with full resume text for maximum accuracy
      const promptPromises = Object.entries(MICRO_PROMPTS).map(async ([key, config]) => {
        // Send full resume text to every microprompt for best results
        const result = await runMicroPrompt(openai, config.prompt, canonicalText, key);
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

      // Build compact overview payload (using merged prompts only)
      const overview = {
        title: answers.role_header?.currentTitle ?? null,
        seniorityHint: answers.role_header?.seniorityHint ?? null,
        employer: displayEmployer(answers.role_header?.employerName || null),
        yoe: (answers.experience_signals?.selfReportedYears ?? answers.experience_signals?.dateDerivedYears ?? null),
        yoeBasis: (answers.experience_signals?.selfReportedYears != null ? 'self-reported' : (answers.experience_signals?.dateDerivedYears != null ? 'date-derived' : null)),
        education: answers.credentials?.education || null,
        topAchievements: answers.top3_achievements?.achievements || [],
        functions: answers.experience_signals?.functions || [],
        location: {
          city: answers.role_header?.location?.city || null,
          country: answers.role_header?.location?.country || null
        },
        languages: answers.profile_extras?.languages || [],
        availability: answers.profile_extras?.availability || null,
        topHardSkills: answers.top_hard_skills?.skills || [],
        certifications: answers.credentials?.certifications || [],
        peopleManagedMax: answers.leadership_summary?.peopleManagedMax || null,
        hiringExperience: answers.leadership_summary?.hiringExperience || null,
        publicLinks: normalizePublicLinks(answers.profile_extras?.links || null),
        // Raw employer fields for database storage
        employerRaw: answers.role_header?.employerRaw || null,
        employerDescriptor: answers.role_header?.employerDescriptor || null
      };

      // Title-Case functions as final guard (keeps output pretty even if model slips)
      overview.functions = (overview.functions || []).map(s =>
        s ? s.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()) : s
      );

      // Filter out clearly responsibility-focused achievements (safety net)
      overview.topAchievements = (overview.topAchievements || [])
        .filter(a => a && a.text && !/^(Leading|Managing|Building|Creating|Developing)\b/i.test(a.text));

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
