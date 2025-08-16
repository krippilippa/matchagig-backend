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

// The 13 micro-prompts with their schemas
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
    prompt: `From the résumé text below, return the current or most recent employer split into three fields.

Schema:
{
  "employerRaw": string|null,
  "employerName": string|null,
  "employerDescriptor": string|null
}

Rules:
- Identify the employer for the most recent role (or the one marked "Present"/"to date").
- employerRaw: the organization name ONLY as it appears in the résumé (no job title, no dates, no work mode, no location, no separators like "|" or "–" content that follows).
- If the organization name appears on the same line as other info (e.g., job title, dates, locations, work mode), select only the organization name portion and exclude the rest.
- employerName: same value as employerRaw (organization name only).
- employerDescriptor: if a brief tagline/sector/descriptor immediately follows the organization name after a separator (e.g., ":", "–", "—"), return that descriptor; do NOT include dates, locations, or work mode notes in employerDescriptor.
- If you cannot confidently split, set employerName = employerRaw and employerDescriptor = null.
- Use exact wording from the résumé; do not normalize or translate.
- JSON only.

Text:
<<<CANONICAL_TEXT>>>`,
    schema: {
      employerRaw: 'string|null',
      employerName: 'string|null',
      employerDescriptor: 'string|null'
    }
  },

  total_yoe_estimate: {
    prompt: `From the résumé text below, estimate total years of professional experience. Return BOTH a self-reported value (if any wording like "X years" appears) AND a date-derived value (rough estimate from role dates or tenure clues). Do not output ranges; use a single numeric estimate for each. If either cannot be determined, set it to null.

Schema:
{
  "selfReportedYears": number|null,
  "dateDerivedYears": number|null
}

Rules:
- selfReportedYears: only when the résumé literally states total years (e.g., "over 10 years"); convert to a single number (e.g., "over 10 years" → 10).
- dateDerivedYears: best-effort single numeric estimate from the document's role/tenure cues.
- Do not include text explanations. JSON only.

Text:
<<<CANONICAL_TEXT>>>`,
    schema: {
      selfReportedYears: 'number|null',
      dateDerivedYears: 'number|null'
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

  primary_functions: {
    prompt: `From the résumé text below, return the candidate's primary professional function(s).

Schema:
{ "functions": string[] }   // up to 2 items, e.g., "Sales", "Operations", "Finance", "Marketing", "HR", "Product", "Engineering", "Customer Success"

Rules:
- Return 1–2 broad professional domains that best represent the candidate's core work across roles.
- Use generic domain labels only (no tools, no industries, no company-specific terms).
- Capitalize each item in Title Case.
- If unclear, return [].
- JSON only.

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
  },

  languages: {
    prompt: `From the résumé text below, extract languages and proficiency.

Schema:
{ "languages": [ { "name": string, "proficiency": "Native"|"C2"|"C1"|"B2"|"B1"|"A2"|"A1"|"Unknown" } ] }

Rules:
- Detect languages explicitly mentioned (e.g., "English – fluent", "Swedish (native)", "French: B2").
- Map wording to CEFR where possible:
  • native/mother tongue → Native
  • fluent/professional/full professional → C1
  • advanced/upper-intermediate → C1 or B2 (choose best single)
  • intermediate → B1
  • elementary/basic → A2 or A1 (choose best single)
  • if CEFR given (A1–C2), use it directly
- Keep 1 entry per language; choose the strongest level if multiple.
- If no languages found, return { "languages": [] }.
- Output one single minified JSON object. No markdown, no backticks, no comments.

Text:
<<<CANONICAL_TEXT>>>`,
    schema: {
      languages: [{ name: 'string', proficiency: '"Native"|"C2"|"C1"|"B2"|"B1"|"A2"|"A1"|"Unknown"' }]
    }
  },

  availability: {
    prompt: `From the résumé text below, extract candidate availability.

Schema:
{ "availability": "Immediate"|"Notice"|"Unknown", "noticeDays": number|null }

Rules:
- If the text states "immediately available", "available now/ASAP" → availability = "Immediate", noticeDays = null.
- If a notice period is stated (e.g., "2 weeks", "1 month", "30 days"): availability = "Notice" and noticeDays = total days (weeks×7, months≈30).
- If only "available from <month/year or date>" is given and no notice wording → availability = "Notice" and noticeDays = null.
- If nothing is stated → availability = "Unknown", noticeDays = null.
- Do not infer from employment dates alone.
- Output one single minified JSON object. No markdown, no backticks, no comments.

Text:
<<<CANONICAL_TEXT>>>`,
    schema: {
      availability: '"Immediate"|"Notice"|"Unknown"',
      noticeDays: 'number|null'
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

  certifications: {
    prompt: `From the résumé text below, extract professional certifications or licenses.

Schema:
{ "certifications": [ { "name": string, "issuer": string|null, "year": string|null } ] }

Rules:
- Include certificates, licenses, and standardized credentials (e.g., "PMP", "AWS Certified Solutions Architect", "CPA", "Six Sigma Green Belt").
- If issuer is mentioned (organization, vendor, association), include it verbatim; otherwise null.
- Year can be completion or most recent renewal year if explicitly present; otherwise null.
- Do not include courses without a credential, awards, or degrees.
- Deduplicate exact duplicates.
- If none found, return { "certifications": [] }.
- Output one single minified JSON object. No markdown, no backticks, no comments.

Text:
<<<CANONICAL_TEXT>>>`,
    schema: {
      certifications: [{ name: 'string', issuer: 'string|null', year: 'string|null' }]
    }
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

  public_links: {
    prompt: `From the résumé text below, extract public profile/portfolio links.

Schema:
{
  "links": {
    "linkedin": string|null,
    "github": string|null,
    "website": string|null,
    "portfolio": string|null,
    "behance": string|null,
    "dribbble": string|null,
    "x": string|null
  }
}

Rules:
- Return fully qualified URLs when present (beginning with http or https). If protocol is missing but domain is obvious (e.g., "linkedin.com/in/..."), prepend "https://".
- If multiple links of the same type exist, choose the most complete profile URL (not a post).
- "website" = personal/company site if clearly the candidate's.
- "portfolio" = general portfolio link if not specifically Behance/Dribbble.
- "x" = Twitter/X profile only (not individual tweets).
- If a type is absent, return null.
- Output one single minified JSON object. No markdown, no backticks, no comments.

Text:
<<<CANONICAL_TEXT>>>`,
    schema: {
      links: {
        linkedin: 'string|null',
        github: 'string|null',
        website: 'string|null',
        portfolio: 'string|null',
        behance: 'string|null',
        dribbble: 'string|null',
        x: 'string|null'
      }
    }
  }
};

// Per-prompt schema validation functions
function assertShape_currentTitle(x) {
  return x && (typeof x.currentTitle === 'string' || x.currentTitle === null)
      && (['Junior', 'Mid', 'Senior', 'Lead/Head', 'Unknown', null].includes(x.seniorityHint));
}

function assertShape_currentEmployer(x) {
  return x
    && (typeof x.employerRaw === 'string' || x.employerRaw === null)
    && (typeof x.employerName === 'string' || x.employerName === null)
    && (typeof x.employerDescriptor === 'string' || x.employerDescriptor === null);
}

function assertShape_totalYoeEstimate(x) {
  return x
    && (typeof x.selfReportedYears === 'number' || x.selfReportedYears === null)
    && (typeof x.dateDerivedYears === 'number' || x.dateDerivedYears === null);
}

function assertShape_highestEducation(x) {
  return x && (['PhD/Doctorate', 'Master', 'Bachelor', 'Associate', 'Diploma/Certificate', 'High School', 'Unknown', null].includes(x.level))
      && (typeof x.degreeName === 'string' || x.degreeName === null)
      && (typeof x.field === 'string' || x.field === null)
      && (typeof x.institution === 'string' || x.institution === null)
      && (typeof x.year === 'string' || x.year === null);
}

function assertShape_top3Achievements(x) {
  return x && Array.isArray(x.achievements) &&
    x.achievements.every(a => typeof a.text === 'string');
}

function assertShape_primaryFunctions(x) {
  return x && Array.isArray(x.functions) && x.functions.every(f => typeof f === 'string');
}

function assertShape_locationSimple(x) {
  return x && (typeof x.city === 'string' || x.city === null)
      && (typeof x.country === 'string' || x.country === null);
}

function assertShape_languages(x) {
  return x && Array.isArray(x.languages) && x.languages.every(l =>
    typeof l.name === 'string' && (['Native', 'C2', 'C1', 'B2', 'B1', 'A2', 'A1', 'Unknown'].includes(l.proficiency))
  );
}

function assertShape_availability(x) {
  return x && (['Immediate', 'Notice', 'Unknown'].includes(x.availability)) &&
    (typeof x.noticeDays === 'number' || x.noticeDays === null);
}

function assertShape_topHardSkills(x) {
  return x && Array.isArray(x.skills) && x.skills.every(s => typeof s === 'string');
}

function assertShape_certifications(x) {
  return x && Array.isArray(x.certifications) && x.certifications.every(c =>
    typeof c.name === 'string' && (typeof c.issuer === 'string' || c.issuer === null) && (typeof c.year === 'string' || c.year === null)
  );
}

function assertShape_leadershipSummary(x) {
  return x && (typeof x.peopleManagedMax === 'number' || x.peopleManagedMax === null) && (typeof x.hiringExperience === 'boolean');
}

function assertShape_publicLinks(x) {
  const p = x && x.links;
  if (!p || typeof p !== 'object') return false;
  const keys = ["linkedin","github","website","portfolio","behance","dribbble","x"];
  return keys.every(k => typeof p[k] === 'string' || p[k] === null);
}

// Validation mapping
const VALIDATORS = {
  current_title: assertShape_currentTitle,
  current_employer: assertShape_currentEmployer,
  total_yoe_estimate: assertShape_totalYoeEstimate,
  highest_education: assertShape_highestEducation,
  top3_achievements: assertShape_top3Achievements,
  primary_functions: assertShape_primaryFunctions,
  location_simple: assertShape_locationSimple,
  languages: assertShape_languages,
  availability: assertShape_availability,
  top_hard_skills: assertShape_topHardSkills,
  certifications: assertShape_certifications,
  leadership_summary: assertShape_leadershipSummary,
  public_links: assertShape_publicLinks
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
      
      // Run all 13 micro-prompts in parallel with full resume text for maximum accuracy
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

      // Build compact overview payload
      const overview = {
        title: answers.current_title?.currentTitle || null,
        seniorityHint: answers.current_title?.seniorityHint || null,
        employer: displayEmployer(answers.current_employer?.employerName || null),
        yoe: (answers.total_yoe_estimate?.selfReportedYears ?? answers.total_yoe_estimate?.dateDerivedYears ?? null),
        yoeBasis: (answers.total_yoe_estimate?.selfReportedYears != null ? 'self-reported' : (answers.total_yoe_estimate?.dateDerivedYears != null ? 'date-derived' : null)),
        education: answers.highest_education || null,
        topAchievements: answers.top3_achievements?.achievements || [],
        functions: answers.primary_functions?.functions || [],
        location: {
          city: answers.location_simple?.city || null,
          country: answers.location_simple?.country || null
        },
        languages: answers.languages || [],
        availability: answers.availability || null,
        topHardSkills: answers.top_hard_skills?.skills || [],
        certifications: answers.certifications?.certifications || [],
        peopleManagedMax: answers.leadership_summary?.peopleManagedMax || null,
        hiringExperience: answers.leadership_summary?.hiringExperience || null,
        publicLinks: normalizePublicLinks(answers.public_links?.links || null),
        // Raw employer fields for database storage (non-breaking addition)
        employerRaw: answers.current_employer?.employerRaw || null,
        employerDescriptor: answers.current_employer?.employerDescriptor || null
      };

      // Title-Case functions as final guard (keeps output pretty even if model slips)
      overview.functions = (answers.primary_functions?.functions || []).map(s =>
        s ? s.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase()) : s
      );

      // Filter out clearly responsibility-focused achievements (safety net)
      overview.topAchievements = (answers.top3_achievements?.achievements || [])
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
