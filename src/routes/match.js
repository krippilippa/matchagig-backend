// routes/match.js
import OpenAI from 'openai';
import { getResume, getJD } from '../shared/storage.js';
import { getEmbedding, signalCacheKey, getEmbeddingModel } from '../lib/embeddings.js';
import { normalizeToken, intersect, educationRank, educationMeets, anyContainsAny } from '../lib/text.js';
import { COSINE_WEIGHT, BOOSTS, PENALTIES, GATES, SOFT_SKILL, SOFT_FUNC, SOFT_INDUSTRY } from '../config/match-weights.js';

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const L = Math.min(a.length, b.length);
  for (let i = 0; i < L; i++) { const x = a[i], y = b[i]; dot += x*y; na += x*x; nb += y*y; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const norm = (s) => (s || '').toString().trim();

function buildResumeSignal(overview = {}) {
  const title = norm(overview.title);
  const funcs = (overview.functions || []).map(norm).join(', ');
  const skills = (overview.topHardSkills || []).map(norm).join(', ');
  const outcomes = (overview.topAchievements || []).map(a => norm(a?.text)).filter(Boolean).join(', ');
  const industries = ''; // not available on CV side in current schema
  const seniority = norm(overview.seniorityHint);
  const langs = (overview.languages || []).map(x => typeof x === 'string' ? norm(x) : norm(x?.name)).join(', ');
  const eduLevel = norm(overview.education?.level);
  const yoe = overview.yoe != null ? String(overview.yoe) : '';

  return [
    `TITLE ${title}`,
    funcs && `FUNCTIONS ${funcs}`,
    skills && `SKILLS ${skills}`,
    outcomes && `OUTCOMES ${outcomes}`,
    industries && `INDUSTRIES ${industries}`,
    seniority && `SENIORITY ${seniority}`,
    langs && `LANGUAGES ${langs}`,
    eduLevel && `EDU ${eduLevel}`,
    yoe && `YOE ${yoe}`
  ].filter(Boolean).join(' | ');
}

function buildJdSignal(jd = {}) {
  const ro = jd.roleOrg || {}; const log = jd.logistics || {}; const req = jd.requirements || {}; const ss = jd.successSignals || {};
  const title = norm(ro.title);
  const funcs = (ro.functions || []).map(norm).join(', ');
  const skills = (ss.topHardSkills || []).map(norm).join(', ');
  const outcomes = (ss.keyOutcomes || []).map(o => norm(o?.text)).filter(Boolean).join(', ');
  const inds = (ss.industryHints || []).map(norm).join(', ');
  const seniority = norm(ro.seniorityHint);
  const langs = (log.languages || []).map(norm).join(', ');
  const eduMin = norm(req.educationMin);
  const workMode = norm(log.location?.workMode);

  return [
    `TITLE ${title}`,
    funcs && `FUNCTIONS ${funcs}`,
    skills && `SKILLS ${skills}`,
    outcomes && `OUTCOMES ${outcomes}`,
    inds && `INDUSTRIES ${inds}`,
    seniority && `SENIORITY ${seniority}`,
    langs && `LANGUAGES ${langs}`,
    eduMin && `EDU_MIN ${eduMin}`,
    workMode && `WORKMODE ${workMode}`
  ].filter(Boolean).join(' | ');
}

function seniorityPenalty(jdSeniority, cvSeniority) {
  const j = (jdSeniority || '').toLowerCase();
  const r = (cvSeniority || '').toLowerCase();
  if (j === 'mid' || j === 'junior') {
    if (r === 'lead/head' || r === 'director+') return -8;
  }
  return 0;
}

function computeOverlaps({ overview, jd }) {
  const functionsOverlap = intersect(overview.functions || [], jd.roleOrg?.functions || [], 3);
  const resumeSkills = overview.topHardSkills || [];
  const jdSkills = jd.successSignals?.topHardSkills || [];
  const skillsOverlap = intersect(resumeSkills, jdSkills, 10);

  const resumeLangs = (overview.languages || []).map(x => typeof x === 'string' ? x : x?.name || '');
  const jdLangs = jd.logistics?.languages || [];
  const languagesOverlap = intersect(resumeLangs, jdLangs, 3);

  const rAch = (overview.topAchievements || []).map(a => a?.text || '').filter(Boolean);
  const jOut = (jd.successSignals?.keyOutcomes || []).map(o => o?.text || '').filter(Boolean);
  const achievementsOverlap = [];
  for (const a of rAch) {
    const an = normalizeToken(a);
    if (!an) continue;
    for (const o of jOut) {
      const on = normalizeToken(o);
      if (!on) continue;
      if (an.includes(on) || on.includes(an)) { achievementsOverlap.push(on); break; }
    }
    if (achievementsOverlap.length >= 5) break;
  }

  const yoeMin = jd.requirements?.yoeMin ?? null;
  const yoe = overview.yoe ?? null;
  const yoeCheck = (yoeMin == null || (yoe != null && yoe >= (yoeMin)));

  const eduMin = jd.requirements?.educationMin ?? null;
  const eduCand = overview.education?.level ?? null;
  const educationCheck = educationMeets(eduCand, eduMin);

  return { functionsOverlap, skillsOverlap, languagesOverlap, achievementsOverlap, yoeCheck, educationCheck, jdLangs, resumeSkills, jdSkills, resumeFunctions: overview.functions || [], jdFunctions: jd.roleOrg?.functions || [], jdIndustries: jd.successSignals?.industryHints || [] };
}

async function softSkillMatches(resumeSkills = [], jdSkills = [], resumeId = '', jdHash = '', threshold = 0.80) {
  const exactOverlap = new Set(intersect(resumeSkills, jdSkills, 100));
  const jdFiltered = (jdSkills || []).filter(s => !exactOverlap.has(normalizeToken(s)));
  const resumeNorm = (resumeSkills || []).map(normalizeToken).filter(Boolean);
  const matches = new Set();
  for (const jdSkill of jdFiltered) {
    const jdTok = normalizeToken(jdSkill);
    if (!jdTok) continue;
    const jdVec = await getEmbedding(jdTok, signalCacheKey('skill', `jd:${jdHash}`, jdTok));
    for (const cvSkill of resumeNorm) {
      const cvVec = await getEmbedding(cvSkill, signalCacheKey('skill', `cv:${resumeId}`, cvSkill));
      const sim = cosine(jdVec, cvVec);
      if (sim >= threshold) { matches.add(jdTok); break; }
    }
  }
  return Array.from(matches);
}

async function softStringMatches(resumeTerms = [], jdTerms = [], cachePrefix = '', leftId = '', rightId = '', threshold = 0.50, maxTotal = 4) {
  const exact = new Set(intersect(resumeTerms, jdTerms, 100));
  const jdFiltered = (jdTerms || []).filter(s => !exact.has(normalizeToken(s)));
  const resumeNorm = (resumeTerms || []).map(normalizeToken).filter(Boolean);
  const matches = new Set();
  for (const jdTerm of jdFiltered) {
    const jdTok = normalizeToken(jdTerm);
    if (!jdTok) continue;
    const jdVec = await getEmbedding(jdTok, signalCacheKey(cachePrefix, `right:${rightId}`, jdTok));
    for (const cvTerm of resumeNorm) {
      const cvTok = normalizeToken(cvTerm);
      const cvVec = await getEmbedding(cvTok, signalCacheKey(cachePrefix, `left:${leftId}`, cvTok));
      const sim = cosine(jdVec, cvVec);
      if (sim >= threshold) { matches.add(jdTok); break; }
    }
    if (matches.size >= maxTotal) break;
  }
  return Array.from(matches);
}

export default async function matchRoute(app) {
  new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  app.post('/v1/match', async (req, reply) => {
    try {
      const body = await req.body;
      const resumeId = body?.resumeId;
      const jdHash = body?.jdHash;
      if (!resumeId || !jdHash) {
        return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Required: { resumeId, jdHash }' } });
      }

      const resumeData = getResume(resumeId);
      if (!resumeData) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: `Resume not found with ID: ${resumeId}` } });
      const jdData = getJD(jdHash);
      if (!jdData) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: `JD not found with hash: ${jdHash}` } });
      if (!resumeData.overview) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: `Resume ${resumeId} has no overview. Generate overview first using /v1/overview.` } });

      const overview = resumeData.overview;
      const jd = jdData.jd;

      const resumeSignal = buildResumeSignal(overview);
      const jdSignal = buildJdSignal(jd);

      const [rVec, jVec] = await Promise.all([
        getEmbedding(resumeSignal, signalCacheKey('resume', resumeId, resumeSignal)),
        getEmbedding(jdSignal, signalCacheKey('jd', jdHash, jdSignal))
      ]);

      const cos = cosine(rVec, jVec);
      const overlaps = computeOverlaps({ overview, jd });

      // Gates
      const reasons = { boosts: [], penalties: [], gates: [] };
      const yoeMin = jd.requirements?.yoeMin ?? null;
      const yoe = overview.yoe ?? null;
      if (yoeMin != null && yoe != null && yoe < (yoeMin - 1)) {
        reasons.gates.push({ type: 'yoe_below_min', yoe, yoeMin });
        return reply.send({
          resumeId, jdHash, score: 0,
          breakdown: { cosine: Number(cos.toFixed(4)), overlaps: { ...overlaps }, reasons },
          snippets: { resumeSignal, jdSignal },
          metadata: { embeddingModel: getEmbeddingModel(), timestamp: new Date().toISOString() }
        });
      }
      const eduMin = jd.requirements?.educationMin ?? null;
      const eduCand = overview.education?.level ?? null;
      if (eduMin && eduCand && educationRank(eduCand) > -1 && educationRank(eduMin) > -1 && educationRank(eduCand) < educationRank(eduMin)) {
        reasons.gates.push({ type: 'education_below_min', edu: eduCand, eduMin });
        return reply.send({
          resumeId, jdHash, score: 0,
          breakdown: { cosine: Number(cos.toFixed(4)), overlaps: { ...overlaps }, reasons },
          snippets: { resumeSignal, jdSignal },
          metadata: { embeddingModel: getEmbeddingModel(), timestamp: new Date().toISOString() }
        });
      }

      // Base score
      let score = Math.round(cos * COSINE_WEIGHT);

      // Boosts
      if ((overlaps.functionsOverlap || []).length > 0) { score += BOOSTS.functions; reasons.boosts.push({ type: 'functions', amount: BOOSTS.functions }); }
      if ((overlaps.skillsOverlap || []).length > 0)    { score += BOOSTS.skills; reasons.boosts.push({ type: 'skills', amount: BOOSTS.skills }); }
      if ((overlaps.languagesOverlap || []).length > 0) { score += BOOSTS.languages; reasons.boosts.push({ type: 'languages', amount: BOOSTS.languages }); }
      if ((overlaps.achievementsOverlap || []).length > 0) { score += BOOSTS.achievements; reasons.boosts.push({ type: 'achievements', amount: BOOSTS.achievements }); }

      // Soft semantic skill matches (+2 each, capped via config)
      const softMatches = await softSkillMatches(overlaps.resumeSkills, overlaps.jdSkills, resumeId, jdHash, SOFT_SKILL.cosineThreshold);
      if (softMatches.length > 0) {
        const amt = Math.min(softMatches.length * BOOSTS.softSkillPerMatch, 6); // cap +6
        score += amt;
        reasons.boosts.push({ type: 'soft_skill_matches', amount: amt, matches: softMatches });
      }

      // Soft semantic function matches (small boost)
      const softFuncMatches = await softStringMatches(overlaps.resumeFunctions, overlaps.jdFunctions, 'func', resumeId, jdHash, SOFT_FUNC.cosineThreshold, Math.ceil(SOFT_FUNC.maxTotal / SOFT_FUNC.perMatch) * 10);
      if (softFuncMatches.length > 0) {
        const amtF = Math.min(softFuncMatches.length * SOFT_FUNC.perMatch, SOFT_FUNC.maxTotal);
        if (amtF > 0) { score += amtF; reasons.boosts.push({ type: 'soft_function_matches', amount: amtF, matches: softFuncMatches }); }
      }

      // Soft semantic industry matches (JD industries only for now)
      const softIndMatches = await softStringMatches([], overlaps.jdIndustries, 'industry', resumeId, jdHash, SOFT_INDUSTRY.cosineThreshold, Math.ceil(SOFT_INDUSTRY.maxTotal / SOFT_INDUSTRY.perMatch) * 10);
      // Note: no resume industries to compare; skip unless you add CV industries later

      // Penalties
      const sPen = seniorityPenalty(jd.roleOrg?.seniorityHint, overview.seniorityHint);
      if (sPen) { score += sPen; reasons.penalties.push({ type: 'seniority_mismatch', amount: sPen }); }
      const hasLangReq = (overlaps.jdLangs || []).filter(Boolean).length > 0;
      const langOverlapCount = (overlaps.languagesOverlap || []).length;
      if (hasLangReq && langOverlapCount === 0) { score += PENALTIES.languageMissing; reasons.penalties.push({ type: 'language_missing', amount: PENALTIES.languageMissing }); }

      // Final clamp
      score = Math.max(0, Math.min(100, score));

      return reply.send({
        resumeId, jdHash, score,
        breakdown: {
          cosine: Number(cos.toFixed(4)),
          overlaps: {
            functions: overlaps.functionsOverlap,
            skills: overlaps.skillsOverlap,
            languages: overlaps.languagesOverlap,
            achievementsOverlap: overlaps.achievementsOverlap,
            yoeCheck: overlaps.yoeCheck,
            educationCheck: overlaps.educationCheck,
            softSkillMatches: softMatches,
            softFunctionMatches: softFuncMatches
          },
          reasons
        },
        snippets: { resumeSignal, jdSignal },
        metadata: { embeddingModel: getEmbeddingModel(), timestamp: new Date().toISOString() }
      });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: { code: 'PROCESSING_ERROR', message: 'Failed to compute match', details: { hint: e.message } } });
    }
  });
}
