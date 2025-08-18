// routes/match.js
import OpenAI from 'openai';
import crypto from 'crypto';

// Optional: wire to your storage if you want server-side fetch.
// For the demo, we accept the already-parsed JSONs in the request body.
// import { getResume } from '../shared/storage.js'; // not required here

const EMBED_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

// Simple in-memory cache for embeddings (ok for demo)
const embedCache = new Map(); // key -> { vec, model, at }

function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const L = Math.min(a.length, b.length);
  for (let i = 0; i < L; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Normalize helpers
const norm = s => (s || '').toString().trim();
const normArr = arr => Array.from(new Set((arr || []).map(x => norm(x).toLowerCase()).filter(Boolean)));

function eduRank(level) {
  const order = ['None','High School','Diploma/Certificate','Associate','Bachelor','Master','PhD/Doctorate'];
  const i = order.indexOf(level || '');
  return i === -1 ? -1 : i;
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

  // Weighted, labeled, compact; keep under a few KB
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
  const ro = jd.roleOrg || {};
  const log = jd.logistics || {};
  const req = jd.requirements || {};
  const ss = jd.successSignals || {};

  const title = norm(ro.title);
  const seniority = norm(ro.seniorityHint);
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

  const res = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: text
  });
  const vec = res.data[0].embedding;
  embedCache.set(key, { vec, model: EMBED_MODEL, at: Date.now() });
  return vec;
}

function intersections({ resume, jd }) {
  const rFuncs = normArr(resume.functions);
  const jFuncs = normArr(jd.roleOrg?.functions);
  const funcHit = rFuncs.filter(x => jFuncs.includes(x));

  const rSkills = normArr(resume.topHardSkills);
  const jSkills = normArr(jd.successSignals?.topHardSkills);
  const skillHit = rSkills.filter(x => jSkills.includes(x));

  const rLangs = normArr(
    (resume.languages || []).map(x => typeof x === 'string' ? x : x?.name)
  );
  const jLangs = normArr(jd.logistics?.languages);
  const langHit = rLangs.filter(x => jLangs.includes(x));

  // Achievements vs JD outcomes (loose contains)
  const rAch = (resume.topAchievements || []).map(a => norm(a?.text).toLowerCase()).filter(Boolean);
  const jOut = (jd.successSignals?.keyOutcomes || []).map(o => norm(o?.text).toLowerCase()).filter(Boolean);
  const achHit = [];
  for (const a of rAch) {
    if (jOut.some(o => a.includes(o) || o.includes(a))) achHit.push(a);
  }

  // YOE / Education gates
  const yoeMin = jd.requirements?.yoeMin ?? null;
  const yoe = resume.yoe ?? null;
  const yoeCheck = (yoeMin == null || (yoe != null && yoe >= yoeMin));

  const eduMin = jd.requirements?.educationMin ?? null;
  const eduCand = resume.education?.level ?? null;
  const eduCheck = (eduMin == null || eduMin === 'Unknown' || eduMin === 'None'
    || (eduRank(eduCand) >= eduRank(eduMin)));

  return {
    functions: funcHit,
    skills: skillHit,
    languages: langHit,
    achievementsOverlap: achHit,
    yoeCheck,
    educationCheck: eduCheck
  };
}

function boostedScore(cos, overlaps) {
  let score = Math.max(0, Math.min(100, Math.round(cos * 100)));

  // Lightweight, explainable boosts (caps keep it sane)
  score += Math.min(10, overlaps.functions.length * 5); // up to +10
  score += Math.min(10, overlaps.skills.length * 2);    // up to +10
  if (overlaps.languages.length > 0) score += 5;        // +5
  if (overlaps.yoeCheck) score += 10;                   // +10
  if (overlaps.educationCheck) score += 5;              // +5

  return Math.max(0, Math.min(100, score));
}

export default async function matchRoute(app) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  app.post('/v1/match', async (req, reply) => {
    try {
      const body = await req.body;

      // Expect parsed JSONs provided by the client (keeps this route fast & deterministic)
      const overview = body?.overview; // résumé overview JSON from /v1/overview
      const jd = body?.jd;             // JD JSON from /v1/jd

      if (!overview || !jd) {
        return reply.code(400).send({
          error: { code: 'BAD_REQUEST',
          message: 'Required: { overview, jd } — pass the parsed JSON objects from /v1/overview and /v1/jd.' }
        });
      }

      const resumeSignal = buildResumeSignal(overview);
      const jdSignal = buildJdSignal(jd);

      const [rVec, jVec] = await Promise.all([
        getEmbedding(openai, resumeSignal),
        getEmbedding(openai, jdSignal)
      ]);

      const cos = cosine(rVec, jVec);
      const overlap = intersections({ resume: overview, jd });

      const score = boostedScore(cos, overlap);

      return reply.send({
        score,
        breakdown: {
          cosine: Number(cos.toFixed(4)),
          overlaps: overlap
        },
        snippets: {
          resumeSignal,
          jdSignal
        },
        metadata: {
          embeddingModel: EMBED_MODEL,
          timestamp: new Date().toISOString()
        }
      });
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({
        error: { code: 'MATCH_ERROR', message: 'Failed to compute match', details: { hint: e.message } }
      });
    }
  });
}
