// routes/match.js
import OpenAI from 'openai';
import crypto from 'crypto';
import { getResume, getJD } from '../shared/storage.js';

const EMBED_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

const embedCache = new Map();

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const L = Math.min(a.length, b.length);
  for (let i = 0; i < L; i++) { const x = a[i], y = b[i]; dot += x*y; na += x*x; nb += y*y; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const norm = s => (s || '').toString().trim();
const normArr = arr => Array.from(new Set((arr || []).map(x => norm(x).toLowerCase()).filter(Boolean)));

function eduRank(level) {
  const order = ['None','High School','Diploma/Certificate','Associate','Bachelor','Master','PhD/Doctorate'];
  const i = order.indexOf(level || '');
  return i === -1 ? -1 : i;
}

// Skill canonicalization map (synonyms -> canonical)
const SKILL_SYNONYMS = {
  linkedin: ['linkedin', 'li prospecting', 'social selling', 'sales navigator', 'linkedin sales navigator'],
  leadgen: ['lead gen','leadgen','lead-generation','prospecting','outreach','cold outreach','pipeline','pipeline building'],
  crm: ['salesforce','hubspot','pipedrive','zoho crm','crm'],
  'it-basics': ['software development terms','it technologies','tech stack','information technology','it']
};

function canonicalizeSkill(raw) {
  const s = norm(raw).toLowerCase();
  for (const [canon, variants] of Object.entries(SKILL_SYNONYMS)) {
    if (variants.includes(s)) return canon; // return canonical token
  }
  return s; // fallback to normalized literal
}

function canonicalizeSkills(arr) {
  return Array.from(new Set((arr || []).map(canonicalizeSkill).filter(Boolean)));
}

function textContainsAny(text, terms) {
  const t = norm(text).toLowerCase();
  return terms.some(k => t.includes(k));
}

function anyContainsAny(arr, terms) {
  return (arr || []).some(v => textContainsAny(typeof v === 'string' ? v : v?.text, terms));
}

function buildResumeSignal(overview = {}) {
  const title = norm(overview.title);
  const seniority = norm(overview.seniorityHint);
  const funcs = (overview.functions || []).map(norm);
  const skills = (overview.topHardSkills || []).map(norm);
  const langs = (overview.languages || []).map(x => typeof x === 'string' ? norm(x) : norm(x?.name));
  const eduLevel = norm(overview.education?.level);
  const yoe = overview.yoe != null ? String(overview.yoe) : '';
  const ach = (overview.topAchievements || []).map(a => norm(a?.text)).filter(Boolean);

  return [
    `TITLE: ${title}`,
    seniority && `SENIORITY: ${seniority}`,
    funcs.length && `FUNCTIONS: ${funcs.join(', ')}`,
    skills.length && `SKILLS: ${skills.join(', ')}`,
    langs.length && `LANGUAGES: ${langs.join(', ')}`,
    eduLevel && `EDU: ${eduLevel}`,
    yoe && `YOE: ${yoe}`,
    ach.length && `ACHIEVEMENTS: ${ach.join(' | ')}`
  ].filter(Boolean).join('\n');
}

function buildJdSignal(jd = {}) {
  const ro = jd.roleOrg || {}; const log = jd.logistics || {}; const req = jd.requirements || {}; const ss = jd.successSignals || {};
  const title = norm(ro.title); const seniority = norm(ro.seniorityHint);
  const funcs = (ro.functions || []).map(norm);
  const skills = (ss.topHardSkills || []).map(norm);
  const langs = (log.languages || []).map(norm);
  const inds = (ss.industryHints || []).map(norm);
  const outcomes = (ss.keyOutcomes || []).map(o => norm(o?.text)).filter(Boolean);
  const workMode = norm(log.location?.workMode);
  const eduMin = norm(req.educationMin);
  const yoeMin = req.yoeMin != null ? String(req.yoeMin) : '';

  return [
    `TITLE: ${title}`,
    seniority && `SENIORITY: ${seniority}`,
    funcs.length && `FUNCTIONS: ${funcs.join(', ')}`,
    skills.length && `SKILLS: ${skills.join(', ')}`,
    langs.length && `LANGUAGES: ${langs.join(', ')}`,
    inds.length && `INDUSTRIES: ${inds.join(', ')}`,
    workMode && `WORKMODE: ${workMode}`,
    eduMin && `EDU_MIN: ${eduMin}`,
    yoeMin && `YOE_MIN: ${yoeMin}`,
    outcomes.length && `OUTCOMES: ${outcomes.join(' | ')}`
  ].filter(Boolean).join('\n');
}

async function getEmbedding(openai, text) {
  const key = `${EMBED_MODEL}:${sha1(text)}`;
  const hit = embedCache.get(key);
  if (hit) return hit.vec;
  const res = await openai.embeddings.create({ model: EMBED_MODEL, input: text });
  const vec = res.data[0].embedding; embedCache.set(key, { vec, model: EMBED_MODEL, at: Date.now() });
  return vec;
}

function intersections({ resume, jd }) {
  const rFuncs = normArr(resume.functions);
  const jFuncs = normArr(jd.roleOrg?.functions);
  const funcHit = rFuncs.filter(x => jFuncs.includes(x));

  const rSkills = canonicalizeSkills(resume.topHardSkills);
  const jSkills = canonicalizeSkills(jd.successSignals?.topHardSkills);
  const skillHit = rSkills.filter(x => jSkills.includes(x));

  const rLangs = normArr((resume.languages || []).map(x => typeof x === 'string' ? x : x?.name));
  const jLangs = normArr(jd.logistics?.languages);
  const langHit = rLangs.filter(x => jLangs.includes(x));

  // Lead-gen requirement: detect in JD (skills or outcomes) using synonym terms
  const leadgenTerms = SKILL_SYNONYMS.leadgen || [];
  const jdLeadgenRequired = anyContainsAny(jd.successSignals?.topHardSkills, leadgenTerms)
    || anyContainsAny(jd.successSignals?.keyOutcomes, leadgenTerms);
  const resumeLeadgenPresent = anyContainsAny(resume.topHardSkills, leadgenTerms)
    || anyContainsAny(resume.topAchievements, leadgenTerms);

  // Achievements vs JD outcomes (loose contains)
  const rAch = (resume.topAchievements || []).map(a => norm(a?.text).toLowerCase()).filter(Boolean);
  const jOut = (jd.successSignals?.keyOutcomes || []).map(o => norm(o?.text).toLowerCase()).filter(Boolean);
  const achHit = [];
  for (const a of rAch) { if (jOut.some(o => a.includes(o) || o.includes(a))) achHit.push(a); }

  // YOE / Education gates
  const yoeMin = jd.requirements?.yoeMin ?? null; const yoe = resume.yoe ?? null;
  const yoeCheck = (yoeMin == null || (yoe != null && yoe >= yoeMin));

  const eduMin = jd.requirements?.educationMin ?? null; const eduCand = resume.education?.level ?? null;
  const eduCheck = (eduMin == null || eduMin === 'Unknown' || eduMin === 'None' || (eduRank(eduCand) >= eduRank(eduMin)));

  return {
    rFuncs, jFuncs, rSkills, jSkills, rLangs, jLangs,
    funcHit, skillHit, langHit, achHit,
    jdLeadgenRequired, resumeLeadgenPresent,
    yoeCheck, eduCheck
  };
}

function seniorityPenalty(jdSeniority, cvSeniority) {
  const j = (jdSeniority || '').toLowerCase();
  const r = (cvSeniority || '').toLowerCase();
  if (j === 'mid') {
    if (r === 'junior') return -12;
    if (r === 'lead/head' || r === 'director+') return -8;
  }
  return 0;
}

function industryAlignmentBoost(jd, resume) {
  const inds = (jd.successSignals?.industryHints || []).map(x => norm(x).toLowerCase());
  if (inds.length === 0) return 0;
  const employerDesc = norm(resume.employerDescriptor).toLowerCase();
  const employer = norm(resume.employer).toLowerCase();
  const texts = [employerDesc, employer, ...(resume.topAchievements || []).map(a => norm(a?.text).toLowerCase())];
  const anyMatch = inds.some(ind => texts.some(t => t && t.includes(ind)));
  return anyMatch ? 5 : 0;
}

function languageGatePenalty(jLangs, rLangs) {
  if ((jLangs || []).length === 0) return { penalty: 0, mode: 'none' }; // no gate
  const hasAny = jLangs.some(l => rLangs.includes(l));
  if (hasAny) return { penalty: 0, mode: 'ok' };
  // heuristic: if JD only lists English, make it soft (-4), else strict (-10)
  const onlyEnglish = jLangs.length === 1 && jLangs[0] && jLangs[0].toLowerCase() === 'english';
  return onlyEnglish ? { penalty: -4, mode: 'soft' } : { penalty: -10, mode: 'strict' };
}

export function boostedScore(cos, overlaps, jd, resume) {
  // base from cosine (weighted 80)
  const base = Math.round(cos * 80);
  let boostSum = 0;
  let penaltySum = 0;
  const reasons = { boosts: [], penalties: [], gates: [] };

  const funcBoost = Math.min(10, overlaps.funcHit.length * 5);
  if (funcBoost) { boostSum += funcBoost; reasons.boosts.push({ type: 'functions', amount: funcBoost, matches: overlaps.funcHit }); }

  const skillBoost = Math.min(20, overlaps.skillHit.length * 4);
  if (skillBoost) { boostSum += skillBoost; reasons.boosts.push({ type: 'skills', amount: skillBoost, matches: overlaps.skillHit }); }

  // Positive mirror: resume has lead-gen signals
  if (overlaps.resumeLeadgenPresent) {
    boostSum += 8;
    reasons.boosts.push({ type: 'leadgen_present', amount: 8 });
  }

  const { penalty: langPenalty, mode: langMode } = languageGatePenalty(overlaps.jLangs, overlaps.rLangs);
  if (langPenalty) { penaltySum += langPenalty; reasons.penalties.push({ type: 'language_gate', mode: langMode, amount: langPenalty }); }

  const sPen = seniorityPenalty(jd.roleOrg?.seniorityHint, resume.seniorityHint);
  if (sPen) { penaltySum += sPen; reasons.penalties.push({ type: 'seniority_mismatch', amount: sPen }); }

  const indBoost = industryAlignmentBoost(jd, resume);
  if (indBoost) { boostSum += indBoost; reasons.boosts.push({ type: 'industry', amount: indBoost }); }

  // Soft must-have: lead-gen present in JD but absent in resume => -6
  if (overlaps.jdLeadgenRequired && !overlaps.resumeLeadgenPresent) {
    penaltySum += -6;
    reasons.penalties.push({ type: 'leadgen_missing', amount: -6 });
  }

  // Cap total penalties at -20
  if (penaltySum < -20) {
    reasons.gates.push({ type: 'penalty_cap', cappedAt: -20, original: penaltySum });
    penaltySum = -20;
  }

  // Aggregate score
  let score = base + boostSum + penaltySum;

  // Skill gate cap: if zero skill overlap, cap at 75
  if (overlaps.skillHit.length === 0) {
    if (score > 75) { reasons.gates.push({ type: 'skill_cap', cappedAt: 75 }); }
    score = Math.min(score, 75);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  return { score, reasons };
}

export default async function matchRoute(app) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  app.post('/v1/match', async (req, reply) => {
    try {
      const body = await req.body;
      const resumeId = body?.resumeId;
      const jdHash = body?.jdHash;
      if (!resumeId || !jdHash) {
        return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Required: { resumeId, jdHash } — pass the IDs from /v1/overview and /v1/jd.' } });
      }

      const resumeData = getResume(resumeId);
      if (!resumeData) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: `Resume not found with ID: ${resumeId}` } });
      const jdData = getJD(jdHash);
      if (!jdData) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: `JD not found with hash: ${jdHash}` } });
      if (!resumeData.overview) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: `Resume ${resumeId} has no overview. Generate overview first using /v1/overview.` } });

      const resumeSignal = buildResumeSignal(resumeData.overview);
      const jdSignal = buildJdSignal(jdData.jd);

      const [rVec, jVec] = await Promise.all([
        getEmbedding(openai, resumeSignal),
        getEmbedding(openai, jdSignal)
      ]);

      const cos = cosine(rVec, jVec);
      const overlap = intersections({ resume: resumeData.overview, jd: jdData.jd });
      const { score, reasons } = boostedScore(cos, overlap, jdData.jd, resumeData.overview);

      return reply.send({
        resumeId,
        jdHash,
        score,
        breakdown: {
          cosine: Number(cos.toFixed(4)),
          overlaps: {
            functions: overlap.funcHit,
            skills: overlap.skillHit,
            languages: overlap.langHit,
            achievementsOverlap: overlap.achHit,
            yoeCheck: overlap.yoeCheck,
            educationCheck: overlap.eduCheck,
            leadgenRequired: overlap.jdLeadgenRequired,
            leadgenPresent: overlap.resumeLeadgenPresent
          },
          reasons
        },
        snippets: { resumeSignal, jdSignal },
        metadata: { embeddingModel: EMBED_MODEL, timestamp: new Date().toISOString() }
      });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: { code: 'MATCH_ERROR', message: 'Failed to compute match', details: { hint: e.message } } });
    }
  });
}
