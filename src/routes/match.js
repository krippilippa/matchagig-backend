// routes/match.js
import OpenAI from 'openai';
import { getResume, getJD } from '../shared/storage.js';
import { getEmbedding, signalCacheKey, getEmbeddingModel } from '../lib/embeddings.js';
import { normalizeToken, intersect, educationRank, anyContainsAny } from '../lib/text.js';

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const L = Math.min(a.length, b.length);
  for (let i = 0; i < L; i++) { const x = a[i], y = b[i]; dot += x*y; na += x*x; nb += y*y; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const norm = (s) => (s || '').toString().trim();

function buildResumeSignal(overview = {}) {
  const title = norm(overview.title);
  const seniority = norm(overview.seniorityHint);
  const funcs = (overview.functions || []).map(norm).join(', ');
  const skills = (overview.topHardSkills || []).map(norm).join(', ');
  const langs = (overview.languages || []).map(x => typeof x === 'string' ? norm(x) : norm(x?.name)).join(', ');
  const eduLevel = norm(overview.education?.level);
  const yoe = overview.yoe != null ? String(overview.yoe) : '';
  const ach = (overview.topAchievements || []).map(a => norm(a?.text)).filter(Boolean).join(', ');

  return [
    `TITLE ${title}`,
    seniority && `SENIORITY ${seniority}`,
    funcs && `FUNCTIONS ${funcs}`,
    skills && `SKILLS ${skills}`,
    langs && `LANGUAGES ${langs}`,
    eduLevel && `EDU ${eduLevel}`,
    yoe && `YOE ${yoe}`,
    ach && `ACHIEVEMENTS ${ach}`
  ].filter(Boolean).join(' | ');
}

function buildJdSignal(jd = {}) {
  const ro = jd.roleOrg || {}; const log = jd.logistics || {}; const req = jd.requirements || {}; const ss = jd.successSignals || {};
  const title = norm(ro.title); const seniority = norm(ro.seniorityHint);
  const funcs = (ro.functions || []).map(norm).join(', ');
  const skills = (ss.topHardSkills || []).map(norm).join(', ');
  const langs = (log.languages || []).map(norm).join(', ');
  const inds = (ss.industryHints || []).map(norm).join(', ');
  const outcomes = (ss.keyOutcomes || []).map(o => norm(o?.text)).filter(Boolean).join(', ');
  const workMode = norm(log.location?.workMode);
  const eduMin = norm(req.educationMin);

  return [
    `TITLE ${title}`,
    seniority && `SENIORITY ${seniority}`,
    funcs && `FUNCTIONS ${funcs}`,
    skills && `SKILLS ${skills}`,
    langs && `LANGUAGES ${langs}`,
    inds && `INDUSTRIES ${inds}`,
    workMode && `WORKMODE ${workMode}`,
    eduMin && `EDU_MIN ${eduMin}`,
    outcomes && `OUTCOMES ${outcomes}`
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
  const educationCheck = (eduMin == null || educationRank(eduMin) <= educationRank(eduCand));

  return { functionsOverlap, skillsOverlap, languagesOverlap, achievementsOverlap, yoeCheck, educationCheck, jdLangs };
}

export default async function matchRoute(app) {
  // OpenAI client not used here; embeddings handled in lib
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

      // Gates (fail fast to 0)
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
      let score = Math.round(cos * 70);

      // Boosts
      if ((overlaps.functionsOverlap || []).length > 0) { score += 5; reasons.boosts.push({ type: 'functions', amount: 5 }); }
      if ((overlaps.skillsOverlap || []).length > 0)    { score += 5; reasons.boosts.push({ type: 'skills', amount: 5 }); }
      if ((overlaps.languagesOverlap || []).length > 0) { score += 5; reasons.boosts.push({ type: 'languages', amount: 5 }); }
      if ((overlaps.achievementsOverlap || []).length > 0) { score += 3; reasons.boosts.push({ type: 'achievements', amount: 3 }); }

      // Penalties
      const sPen = seniorityPenalty(jd.roleOrg?.seniorityHint, overview.seniorityHint);
      if (sPen) { score += sPen; reasons.penalties.push({ type: 'seniority_mismatch', amount: sPen }); }
      if ((overlaps.jdLangs || []).length > 0 && (overlaps.languagesOverlap || []).length === 0) {
        score += -10; reasons.penalties.push({ type: 'language_missing', amount: -10 });
      }

      // Clamp and respond
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
            educationCheck: overlaps.educationCheck
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
