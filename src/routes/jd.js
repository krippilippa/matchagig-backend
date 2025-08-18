import OpenAI from 'openai';
import { storeJD, getJD, hasFreshJD, getJDStorageSize, getAllJDHashes } from '../shared/storage.js';
import crypto from 'crypto';

// Shared system message for all JD prompts
const SYSTEM_MESSAGE = `You extract facts from a job description. Output ONLY valid JSON matching the provided schema. Unknown → null. Use wording from the JD where applicable. Do not summarize, infer beyond the text, or add keys.`;

// Retry message for validation failures
const RETRY_MESSAGE = `Your previous output was invalid. Return ONLY valid JSON that matches the schema. No prose.`;

// Four combined micro-prompts for Job Description parsing
const JD_PROMPTS = {
  // Prompt 1 — Role & Org
  role_org: {
    prompt: `From the job description below, return the role and organization details.

Schema:
{ "title": string|null,
  "seniorityHint": "Junior"|"Mid"|"Senior"|"Lead/Head"|"Director+"|"Unknown"|null,
  "employer": string|null,
  "functions": string[] }

Rules:
- title: job title as written (trim branding/noise if obvious, e.g., remove emojis/hashtags).
- seniorityHint: infer from the title wording ONLY (e.g., Assistant=Junior; Manager=Mid/Senior; Senior=Senior; Head/Lead=Lead/Head; Director/VP/CXO=Director+). If title contains 'Representative/Associate/Executive' without 'Senior/Lead/Director', set seniorityHint = 'Mid'. If unclear → "Unknown".
- employer: company/org if clearly named; if an 'About <Company>' section exists, set employer to that company name; else null.
- functions: 1–2 generic domains that best describe the core role (e.g., "Sales", "Operations", "Finance", "Marketing", "HR", "Product", "Engineering", "Customer Success"). Consider 'Account Management' when retention/growth is emphasized, or 'Business Development' when prospecting/hunting is emphasized. Title Case. If unclear → [].
- JSON only.

Text:
<<<JD_TEXT>>>`,
    schema: {
      title: 'string|null',
      seniorityHint: '"Junior"|"Mid"|"Senior"|"Lead/Head"|"Director+"|"Unknown"|null',
      employer: 'string|null',
      functions: 'string[]'
    }
  },

  // Prompt 2 — Location & Work Rules
  location_rules: {
    prompt: `From the job description below, return location and work rule details.

Schema:
{ "location": { "city": string|null, "country": string|null, "workMode": "Onsite"|"Hybrid"|"Remote"|null },
  "workAuthorization": string|null,
  "languages": string[],
  "availability": { "earliestStart": string|null, "noticeDays": number|null } }

Rules:
- location: copy city/country if explicitly stated; if only one is present, set the other to null. Do not guess.
- workMode: map explicit wording (e.g., "remote", "hybrid 2 days onsite", "on-site") to one of: Onsite | Hybrid | Remote. If unclear → null.
- workAuthorization: copy literal requirement if present (e.g., "US work authorization", "EU work permit"); else null.
- languages: list up to 3 languages explicitly required/preferred; normalize to Title Case; deduplicate.
- availability: earliestStart as short text if stated ("Immediate", "ASAP", a month); noticeDays as a number only if a numeric notice period is stated. Unknown → nulls.
- JSON only.

Text:
<<<JD_TEXT>>>`,
    schema: {
      location: { city: 'string|null', country: 'string|null', workMode: '"Onsite"|"Hybrid"|"Remote"|null' },
      workAuthorization: 'string|null',
      languages: 'string[]',
      availability: { earliestStart: 'string|null', noticeDays: 'number|null' }
    }
  },

  // Prompt 3 — Requirements (gates)
  requirements: {
    prompt: `From the job description below, return minimum requirements.

Schema:
{ "yoeMin": number|null,
  "educationMin": "PhD/Doctorate"|"Master"|"Bachelor"|"Associate"|"Diploma/Certificate"|"High School"|"None"|"Unknown"|null,
  "certifications": string[],
  "peopleScopeReq": { "directReportsMin": number|null } }

Rules:
- yoeMin: numeric minimum years if clearly stated ("3+ years" → 3). If only ranges like "3–5 years", return the lower bound (3). If unspecified → null.
- educationMin: map stated minimum to the provided ladder; if "or equivalent" without level → "Unknown"; if explicitly "no degree required" → "None". If no education is mentioned anywhere in the JD, set to "None" instead of "Unknown".
- certifications: extract named certs only (e.g., "PMP", "CFA", "CPA", "Lean Six Sigma"); up to 5.
- peopleScopeReq.directReportsMin: numeric minimum if the JD requires team management with a number (e.g., "manage a team of 5+" → 5). If only “team leadership” without a number → null.
- JSON only.

Text:
<<<JD_TEXT>>>`,
    schema: {
      yoeMin: 'number|null',
      educationMin: '"PhD/Doctorate"|"Master"|"Bachelor"|"Associate"|"Diploma/Certificate"|"High School"|"None"|"Unknown"|null',
      certifications: 'string[]',
      peopleScopeReq: { directReportsMin: 'number|null' }
    }
  },

  // Prompt 4 — Success Signals (skills, outcomes, industries)
  success_signals: {
    prompt: `From the job description below, return success signals.

Schema:
{ "topHardSkills": string[],
  "keyOutcomes": [ { "text": string } ],
  "industryHints": string[] }

Rules:
- topHardSkills: list 3–8 tools/platforms/technical competencies explicitly required or preferred (e.g., Salesforce, Excel, SAP, SQL, LinkedIn). Include broad technical domains if phrased as such (e.g., 'IT technologies', 'software development terms'). Exclude soft skills.
- keyOutcomes: 3–5 verb-led clauses; remove filler ('help/ensure/facilitate'); keep wording close, no numbers/units. Make them concise and action-focused (e.g., "Identify & engage prospects", "Run qualification calls", "Coordinate onboarding comms").
- industryHints: return 1–3 distinct, generic sectors explicitly mentioned or clearly implied (e.g., "Retail", "Financial Services", "Staffing and Recruiting"). Do not collapse different industries into one broad word like "Technology". If the JD text gives multiple distinct domains (e.g., IT plus Staffing), keep them as separate items. Prefer multi-word industry labels exactly as they appear (e.g., "Staffing and Recruiting") over shortened forms like "Recruitment". Always return at least two if the JD text provides them.
- JSON only.

Text:
<<<JD_TEXT>>>`,
    schema: {
      topHardSkills: 'string[]',
      keyOutcomes: [{ text: 'string' }],
      industryHints: 'string[]'
    }
  }
};

// Validators
function assertShape_roleOrg(x) {
  return x && (typeof x.title === 'string' || x.title === null)
    && (["Junior","Mid","Senior","Lead/Head","Director+","Unknown", null].includes(x.seniorityHint))
    && (typeof x.employer === 'string' || x.employer === null)
    && Array.isArray(x.functions) && x.functions.every(s => typeof s === 'string');
}

function assertShape_locationRules(x) {
  const loc = x && x.location;
  const okLoc = loc && (typeof loc.city === 'string' || loc.city === null)
    && (typeof loc.country === 'string' || loc.country === null)
    && (["Onsite","Hybrid","Remote", null].includes(loc.workMode));
  const okAuth = (typeof x.workAuthorization === 'string' || x.workAuthorization === null);
  const okLangs = Array.isArray(x.languages) && x.languages.every(s => typeof s === 'string');
  const av = x && x.availability;
  const okAvail = av && (typeof av.earliestStart === 'string' || av.earliestStart === null)
    && (typeof av.noticeDays === 'number' || av.noticeDays === null);
  return okLoc && okAuth && okLangs && okAvail;
}

function assertShape_requirements(x) {
  const okYoe = (typeof x.yoeMin === 'number' || x.yoeMin === null);
  const okEdu = (["PhD/Doctorate","Master","Bachelor","Associate","Diploma/Certificate","High School","None","Unknown", null].includes(x.educationMin));
  const okCerts = Array.isArray(x.certifications) && x.certifications.every(s => typeof s === 'string');
  const ps = x && x.peopleScopeReq;
  const okPeople = ps && (typeof ps.directReportsMin === 'number' || ps.directReportsMin === null);
  return okYoe && okEdu && okCerts && okPeople;
}

function assertShape_successSignals(x) {
  const okSkills = Array.isArray(x.topHardSkills) && x.topHardSkills.every(s => typeof s === 'string');
  const okOutcomes = Array.isArray(x.keyOutcomes) && x.keyOutcomes.every(o => o && typeof o.text === 'string');
  const okIndustries = Array.isArray(x.industryHints) && x.industryHints.every(s => typeof s === 'string');
  return okSkills && okOutcomes && okIndustries;
}

const VALIDATORS = {
  role_org: assertShape_roleOrg,
  location_rules: assertShape_locationRules,
  requirements: assertShape_requirements,
  success_signals: assertShape_successSignals
};

// Run a single JD micro-prompt with retry logic
async function runJDPrompt(openai, basePrompt, jdText, promptKey, maxRetries = 1) {
  const userMsg = basePrompt.replace('<<<JD_TEXT>>>', jdText);

  let tryResponseFormat = true;
  let tryTemperature = false;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const messages = [
        { role: 'system', content: SYSTEM_MESSAGE },
        { role: 'user', content: userMsg }
      ];
      if (attempt > 0) messages.push({ role: 'user', content: RETRY_MESSAGE });

      const req = {
        model: process.env.OPENAI_MODEL || 'gpt-5-nano',
        input: messages
      };
      if (tryTemperature) req.temperature = 0.1;
      if (tryResponseFormat) req.response_format = { type: 'json_object' };

      const resp = await openai.responses.create(req);
      const outputText = (resp.output_text || '').trim();
      const parsed = JSON.parse(outputText);
      if (typeof parsed !== 'object' || parsed === null) {
        throw new Error('Output is not a valid JSON object');
      }
      const validator = VALIDATORS[promptKey];
      if (validator && !validator(parsed)) {
        throw new Error('Output does not match expected schema');
      }
      return { success: true, data: parsed };
    } catch (error) {
      const msg = String(error?.message || error);
      if (/Unsupported parameter/i.test(msg)) {
        if (/response_format/i.test(msg) && tryResponseFormat) { tryResponseFormat = false; continue; }
        if (/temperature/i.test(msg) && tryTemperature) { tryTemperature = false; continue; }
      }
      if (attempt === maxRetries) {
        return { success: false, error: `Failed after ${maxRetries + 1} attempts: ${msg}` };
      }
      // else retry with RETRY_MESSAGE appended
    }
  }
}

export default async function jdRoute(app) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // GET endpoint to retrieve cached JD results
  app.get('/v1/jd/:jdHash', async (req, reply) => {
    try {
      const { jdHash } = req.params;
      
      if (!jdHash) {
        return reply.code(400).send(err('BAD_REQUEST', 'Required: jdHash parameter'));
      }

      const jdData = getJD(jdHash);
      
      if (!jdData) {
        return reply.code(404).send(err('NOT_FOUND', 'JD not found in cache'));
      }

      return reply.send({
        jdHash,
        jd: jdData.jd,
        metadata: {
          ...jdData.metadata,
          cached: true,
          retrievedAt: new Date().toISOString()
        }
      });

    } catch (e) {
      req.log.error(e);
      return reply.code(500).send(err('JD_GET_ERROR', 'Failed to retrieve JD', { hint: e.message }));
    }
  });

  // GET endpoint to list all cached JDs
  app.get('/v1/jd', async (req, reply) => {
    try {
      const jdHashes = getAllJDHashes();
      const storageSize = getJDStorageSize();
      
      return reply.send({
        totalCached: storageSize,
        jdHashes,
        metadata: {
          timestamp: new Date().toISOString()
        }
      });

    } catch (e) {
      req.log.error(e);
      return reply.code(500).send(err('JD_LIST_ERROR', 'Failed to list JDs', { hint: e.message }));
    }
  });

  app.post('/v1/jd', async (req, reply) => {
    if (!process.env.OPENAI_API_KEY) {
      return reply.code(500).send(err('CONFIG', 'OPENAI_API_KEY not set'));
    }

    try {
      const body = await req.body;
      const jdText = (body?.jdText || '').toString();

      if (!jdText) {
        return reply.code(400).send(err('BAD_REQUEST', 'Required: { jdText }'));
      }

      // Generate hash for the JD text
      const jdHash = crypto.createHash('sha256').update(jdText).digest('hex').substring(0, 16);

      // Check for cached JD
      if (hasFreshJD(jdHash)) {
        console.log('🔧 JD route: Using cached JD for hash:', jdHash);
        const cachedJD = getJD(jdHash);
        return reply.send({
          jdHash,
          jd: cachedJD.jd,
          metadata: {
            ...cachedJD.metadata,
            cached: true,
            retrievedAt: new Date().toISOString()
          }
        });
      }

      const promptPromises = Object.entries(JD_PROMPTS).map(async ([key, config]) => {
        const result = await runJDPrompt(openai, config.prompt, jdText, key);
        return { key, ...result };
      });

      const results = await Promise.allSettled(promptPromises);
      const processed = results.map((r, i) => r.status === 'fulfilled' ? r.value : ({ key: Object.keys(JD_PROMPTS)[i], success: false, error: `Promise rejected: ${r.reason?.message || 'Unknown error'}` }));

      const answers = {};
      const errors = [];
      processed.forEach(r => {
        if (r.success) answers[r.key] = r.data; else { errors.push({ key: r.key, error: r.error }); answers[r.key] = null; }
      });

      const jd = {
        roleOrg: answers.role_org || null,
        logistics: answers.location_rules || null,
        requirements: answers.requirements || null,
        successSignals: answers.success_signals || null
      };

      const metadata = {
        promptVersion: 'v1',
        jdTextLength: jdText.length,
        jdText: jdText, // Store the original JD text for full text matching
        errors: errors.length > 0 ? errors : undefined,
        timestamp: new Date().toISOString()
      };

      // Store JD in cache
      storeJD(jdHash, { jd, metadata });

      return reply.send({
        jdHash,
        jd,
        metadata
      });

    } catch (e) {
      req.log.error(e);
      return reply.code(500).send(err('JD_ERROR', 'Failed to process job description', { hint: e.message }));
    }
  });
}

function err(code, message, details = {}) {
  return { error: { code, message, details } };
}


