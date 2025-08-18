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

async function softStringMatches(
  resumeTerms = [],
  jdTerms = [],
  cachePrefix = '',
  leftId = '',
  rightId = '',
  threshold = 0.0,         // ignored now; we return top-1 per JD term
  maxTotal = 100           // keep high so we don't truncate
) {
  const normTok = (s) => normalizeToken(s);
  const L = (resumeTerms || []).map(normTok).filter(Boolean);
  const Rraw = jdTerms || [];
  const R = Rraw.map(normTok).filter(Boolean);

  const exactPairs = [];
  const Rremaining = [];

  // 1) Emit exact matches with cosine=1.0
  const Lset = new Set(L);
  for (let i = 0; i < R.length; i++) {
    const rTok = R[i];
    if (Lset.has(rTok)) {
      // use the original JD term for 'left' to preserve casing
      const leftOriginal = Rraw[i];
      exactPairs.push({ left: leftOriginal, right: rTok, cosine: 1.0, kind: 'exact' });
    } else {
      Rremaining.push({ tok: rTok, original: Rraw[i] });
    }
  }

  // 2) For remaining JD terms, get TOP-1 semantic match per JD term
  if (!L.length || !Rremaining.length) return exactPairs;

  const lVecs = Object.create(null);
  async function getLeftVec(t) {
    if (!lVecs[t]) {
      // context prefix helps single/brand terms
      lVecs[t] = await getEmbedding(t, signalCacheKey(cachePrefix, `left:${leftId}`, t));
    }
    return lVecs[t];
  }

  const rVecs = Object.create(null);
  async function getRightVec(t) {
    if (!rVecs[t]) {
      rVecs[t] = await getEmbedding(t, signalCacheKey(cachePrefix, `right:${rightId}`, t));
    }
    return rVecs[t];
  }

  const matches = [...exactPairs];
  for (const r of Rremaining) {
    const rVec = await getRightVec(r.tok);
    // Get TOP-1 semantic match for this JD term
    let best = null;
    for (const lTok of L) {
      const lVec = await getLeftVec(lTok);
      const c = cosine(rVec, lVec);
      if (!best || c > best.cosine) {
        best = { left: r.original, right: lTok, cosine: Number(c.toFixed(4)), kind: 'semantic' };
      }
    }
    if (best) matches.push(best);
    if (matches.length >= maxTotal) break;
  }

  return matches;
}

async function softSkillMatches(resumeSkills = [], jdSkills = [], resumeId = '', jdHash = '') {
  return softStringMatches(resumeSkills, jdSkills, 'skill', resumeId, jdHash, 0.0, 100);
}

// Pairwise semantic matching for achievements (resume) ↔ outcomes (JD)
async function matchOutcomesSemantically(resumeAchievements = [], jdOutcomes = [], embedFn) {
  const A = (resumeAchievements || []).map(a => String(a || '').trim()).filter(Boolean);
  const B = (jdOutcomes || []).map(o => String(o || '').trim()).filter(Boolean);
  if (!A.length || !B.length) return { pairs: [] };

  const aVecs = await Promise.all(A.map(t => embedFn(t)));
  const bVecs = await Promise.all(B.map(t => embedFn(t)));

  const pairs = [];
  // Get TOP-1 match per JD outcome
  for (let j = 0; j < B.length; j++) {
    let best = null;
    for (let i = 0; i < A.length; i++) {
      const cos = cosine(aVecs[i], bVecs[j]);
      if (!best || cos > best.cosine) {
        best = { left: B[j], right: A[i], cosine: Number(cos.toFixed(4)), kind: 'semantic' };
      }
    }
    if (best) pairs.push(best);
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

      // Check if full text matching is available
      const hasFullText = resumeData.canonicalText && jdData.metadata?.jdText;

      const resumeSignal = buildResumeSignal(overview);
      const jdSignal = buildJdSignal(jd);

      // Get embeddings for structured signals
      const [rVec, jVec] = await Promise.all([
        getEmbedding(resumeSignal, signalCacheKey('resume', resumeId, resumeSignal)),
        getEmbedding(jdSignal, signalCacheKey('jd', jdHash, jdSignal))
      ]);

      const cos = cosine(rVec, jVec);
      const overlaps = computeOverlaps({ overview, jd });

      // Get full text embeddings if available
      let fullTextCosine = null;
      if (resumeData.canonicalText && jdData.metadata?.jdText) {
        const resumeFullText = resumeData.canonicalText;
        const jdFullText = jdData.metadata.jdText;
        console.log('[DEBUG] Full text matching - Resume length:', resumeFullText.length, 'JD length:', jdFullText.length);
        
        const [resumeFullVec, jdFullVec] = await Promise.all([
          getEmbedding(resumeFullText, signalCacheKey('resume_full', resumeId, resumeFullText.substring(0, 100))),
          getEmbedding(jdFullText, signalCacheKey('jd_full', jdHash, jdFullText.substring(0, 100)))
        ]);
        
        fullTextCosine = cosine(resumeFullVec, jdFullVec);
        console.log('[DEBUG] Full text cosine:', fullTextCosine);
      }

      // Debug inputs for semantic matching
      console.log('[DEBUG] resumeFunctions:', overlaps.resumeFunctions);
      console.log('[DEBUG] jdFunctions:', overlaps.jdFunctions);
      console.log('[DEBUG] resumeSkills:', overlaps.resumeSkills);
      console.log('[DEBUG] jdSkills:', overlaps.jdSkills);
      console.log('[DEBUG] resumeAchievements:', overlaps.resumeAchievements);
      console.log('[DEBUG] jdOutcomes:', overlaps.jdOutcomes);
      console.log('[DEBUG] languagesOverlap:', overlaps.languagesOverlap);

      // Get all semantic matches (no filtering by thresholds for scoring)
      const skillMatches = await softSkillMatches(overlaps.resumeSkills, overlaps.jdSkills, resumeId, jdHash);
      console.log('[DEBUG] skillMatches(raw):', skillMatches);
      
      const funcMatches = await softStringMatches(overlaps.resumeFunctions, overlaps.jdFunctions, 'func', resumeId, jdHash);
      console.log('[DEBUG] funcMatches(raw):', funcMatches);
      
      const { pairs: outcomePairs } = await matchOutcomesSemantically(overlaps.resumeAchievements, overlaps.jdOutcomes, async (t) => getEmbedding(t, signalCacheKey('outcome', 'phrase', t)));
      console.log('[DEBUG] outcomePairs(raw):', outcomePairs);

      return reply.send({
        resumeId, 
        jdHash,
        breakdown: {
          cosine: Number(cos.toFixed(4)),
          fullTextCosine: fullTextCosine ? Number(fullTextCosine.toFixed(4)) : null,
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
