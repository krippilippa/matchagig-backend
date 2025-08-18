// routes/match.js
import OpenAI from 'openai';
import { getResume, getJD } from '../shared/storage.js';
import { getEmbedding, signalCacheKey, getEmbeddingModel } from '../lib/embeddings.js';
import { normalizeToken, intersect, educationMeets } from '../lib/text.js';
import { SOFT_SKILL, SOFT_FUNC, SOFT_OUTCOME } from '../config/match-weights.js';

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

  const yoeMin = jd.requirements?.yoeMin ?? null;
  const yoe = overview.yoe ?? null;
  const yoeCheck = (yoeMin == null || (yoe != null && yoe >= (yoeMin)));

  const eduMin = jd.requirements?.educationMin ?? null;
  const eduCand = overview.education?.level ?? null;
  const educationCheck = educationMeets(eduCand, eduMin);

  return { functionsOverlap, skillsOverlap, languagesOverlap, yoeCheck, educationCheck, jdLangs, resumeSkills, jdSkills, resumeFunctions: overview.functions || [], jdFunctions: jd.roleOrg?.functions || [], jdIndustries: jd.successSignals?.industryHints || [], resumeAchievements: rAch, jdOutcomes: jOut };
}

async function softSkillMatches(resumeSkills = [], jdSkills = [], resumeId = '', jdHash = '', threshold = 0.80) {
  const exactOverlap = new Set(intersect(resumeSkills, jdSkills, 100));
  const jdFiltered = (jdSkills || []).filter(s => !exactOverlap.has(normalizeToken(s)));
  const resumeNorm = (resumeSkills || []).map(normalizeToken).filter(Boolean);
  const matches = [];
  for (const jdSkill of jdFiltered) {
    const jdTok = normalizeToken(jdSkill);
    if (!jdTok) continue;
    const jdVec = await getEmbedding(jdTok, signalCacheKey('skill', `jd:${jdHash}`, jdTok));
    for (const cvSkill of resumeNorm) {
      const cvVec = await getEmbedding(cvSkill, signalCacheKey('skill', `cv:${resumeId}`, cvSkill));
      const sim = cosine(jdVec, cvVec);
      if (sim >= threshold) { 
        matches.push({ left: cvSkill, right: jdSkill, cosine: Number(sim.toFixed(4)) }); 
        break; 
      }
    }
  }
  return matches;
}

async function softStringMatches(resumeTerms = [], jdTerms = [], cachePrefix = '', leftId = '', rightId = '', threshold = 0.50, maxTotal = 4) {
  const exact = new Set(intersect(resumeTerms, jdTerms, 100));
  const jdFiltered = (jdTerms || []).filter(s => !exact.has(normalizeToken(s)));
  const resumeNorm = (resumeTerms || []).map(normalizeToken).filter(Boolean);
  const matches = [];
  for (const jdTerm of jdFiltered) {
    const jdTok = normalizeToken(jdTerm);
    if (!jdTok) continue;
    const jdVec = await getEmbedding(jdTok, signalCacheKey(cachePrefix, `right:${rightId}`, jdTok));
    for (const cvTerm of resumeNorm) {
      const cvTok = normalizeToken(cvTerm);
      const cvVec = await getEmbedding(cvTok, signalCacheKey(cachePrefix, `left:${leftId}`, cvTok));
      const sim = cosine(jdVec, cvVec);
      if (sim >= threshold) { 
        matches.push({ left: cvTerm, right: jdTerm, cosine: Number(sim.toFixed(4)) }); 
        break; 
      }
    }
    if (matches.length >= maxTotal) break;
  }
  return matches;
}

// Pairwise semantic matching for achievements (resume) ↔ outcomes (JD)
async function matchOutcomesSemantically(resumeAchievements = [], jdOutcomes = [], embedFn) {
  const A = (resumeAchievements || []).map(a => String(a || '').trim()).filter(Boolean);
  const B = (jdOutcomes || []).map(o => String(o || '').trim()).filter(Boolean);
  if (!A.length || !B.length) return { pairs: [] };

  const aVecs = await Promise.all(A.map(t => embedFn(t)));
  const bVecs = await Promise.all(B.map(t => embedFn(t)));

  const pairs = [];
  const usedB = new Set();
  for (let i = 0; i < A.length; i++) {
    let bestJ = -1; let bestCos = -1;
    for (let j = 0; j < B.length; j++) {
      if (usedB.has(j)) continue;
      const cos = cosine(aVecs[i], bVecs[j]);
      if (cos > bestCos) { bestCos = cos; bestJ = j; }
    }
    if (bestJ >= 0 && bestCos >= SOFT_OUTCOME.cosineThreshold) {
      pairs.push({ left: A[i], right: B[bestJ], cosine: Number(bestCos.toFixed(4)) });
      usedB.add(bestJ);
    }
  }

  return { pairs };
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

      // Debug inputs for semantic matching
      console.log('[DEBUG] resumeFunctions:', overlaps.resumeFunctions);
      console.log('[DEBUG] jdFunctions:', overlaps.jdFunctions);
      console.log('[DEBUG] resumeSkills:', overlaps.resumeSkills);
      console.log('[DEBUG] jdSkills:', overlaps.jdSkills);
      console.log('[DEBUG] resumeAchievements:', overlaps.resumeAchievements);
      console.log('[DEBUG] jdOutcomes:', overlaps.jdOutcomes);
      console.log('[DEBUG] languagesOverlap:', overlaps.languagesOverlap);

      // Get all semantic matches (no filtering by thresholds for scoring)
      const skillMatches = await softSkillMatches(overlaps.resumeSkills, overlaps.jdSkills, resumeId, jdHash, 0.0);
      console.log('[DEBUG] skillMatches(raw):', skillMatches);
      
      const funcMatches = await softStringMatches(overlaps.resumeFunctions, overlaps.jdFunctions, 'func', resumeId, jdHash, 0.0, 100);
      console.log('[DEBUG] funcMatches(raw):', funcMatches);
      
      const { pairs: outcomePairs } = await matchOutcomesSemantically(overlaps.resumeAchievements, overlaps.jdOutcomes, async (t) => getEmbedding(t, signalCacheKey('outcome', 'phrase', t)));
      console.log('[DEBUG] outcomePairs(raw):', outcomePairs);

      return reply.send({
        resumeId, 
        jdHash,
        breakdown: {
          cosine: Number(cos.toFixed(4)),
          overlaps: {
            functions: funcMatches,
            skills: skillMatches,
            languages: overlaps.languagesOverlap,
            achievementsOverlap: outcomePairs,
            yoeCheck: overlaps.yoeCheck,
            educationCheck: overlaps.educationCheck
          }
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
