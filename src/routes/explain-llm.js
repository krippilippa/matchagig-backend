// src/routes/explain-llm.js
import OpenAI from 'openai';
import { normalizeCanonicalText } from '../lib/canon.js';
import { parseAndCacheJD } from '../lib/jd-parser.js';
import { getJD, getResume } from '../shared/storage.js';
import { getEmbedding, getEmbeddingModel, signalCacheKey } from '../lib/embeddings.js';
import { educationMeets } from '../lib/text.js';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const LLM_MODEL = process.env.EXPLAIN_LLM_MODEL || 'gpt-4o-mini';

// --- Similarity helpers ---
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const L = Math.min(a.length, b.length);
  for (let i = 0; i < L; i++) { const x=a[i], y=b[i]; dot += x*y; na += x*x; nb += y*y; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function splitSentences(t) {
  return (t || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map(s => s.trim())
    .filter(s => s.length >= 20 && s.length <= 600)
    .slice(0, 600); // cap sentences to embed
}

// thresholds tuned for text-embedding-3-small
const STRONG_T = 0.48;
const WEAK_T   = 0.35;

function levelForCos(c) {
  if (c >= STRONG_T) return 'strong';
  if (c >= WEAK_T)   return 'weak';
  return 'none';
}

// --- JD signal used for ranking evidence ---
function buildJdSignal(jdObj = {}, jdText = '') {
  if (jdObj && Object.keys(jdObj).length) {
    const ro = jdObj.roleOrg || {};
    const log = jdObj.logistics || {};
    const ss  = jdObj.successSignals || {};
    const title = ro.title || '';
    const funcs = (ro.functions || []).join(', ');
    const skills = (ss.topHardSkills || []).join(', ');
    const outcomes = (ss.keyOutcomes || []).map(o => o?.text).filter(Boolean).join(', ');
    const langs = (log.languages || []).join(', ');
    const parts = [
      title && `TITLE ${title}`,
      funcs && `FUNCTIONS ${funcs}`,
      skills && `SKILLS ${skills}`,
      outcomes && `OUTCOMES ${outcomes}`,
      langs && `LANGUAGES ${langs}`,
      ro.seniorityHint && `SENIORITY ${ro.seniorityHint}`
    ].filter(Boolean);
    return parts.join(' | ');
  }
  return normalizeCanonicalText(jdText || '', { flatten: 'soft' });
}

function verdictBand(cos) {
  if (cos >= 0.62) return 'Strong';
  if (cos >= 0.52) return 'Moderate';
  return 'Light';
}

function toLowerTokens(a=[]) { return a.map(x => String(x||'').toLowerCase().trim()).filter(Boolean); }

function languageOverlap(jdLangs=[], text='') {
  const norm = text.toLowerCase();
  const hits = [];
  for (const L of toLowerTokens(jdLangs)) {
    if (L && new RegExp(`\\b${L}\\b`, 'i').test(norm)) hits.push(L);
  }
  return hits;
}

// Best sentence per term (by cosine)
async function bestForTerms(terms, sentVecs, sentences, keyPrefix, idL, idR) {
  const out = [];
  for (const term of (terms||[])) {
    const q = String(term||'').trim();
    if (!q) continue;
    const qv = await getEmbedding(q, signalCacheKey('q', `${keyPrefix}`, q));
    let best = { idx: -1, text: null, cosine: -1 };
    for (let i=0;i<sentVecs.length;i++) {
      const c = cosine(qv, sentVecs[i]);
      if (c > best.cosine) best = { idx: i, text: sentences[i], cosine: c };
    }
    out.push({ jd: q, ...best, level: levelForCos(best.cosine) });
  }
  return out;
}

export default async function explainLLMRoutes(app) {
  app.post('/v1/explain-llm', async (req, reply) => {
    try {
      const body = await req.body;
      const {
        // preferred: raw texts from client (exactly what user sees)
        jdText = null,
        resumeText = null,
        // fallbacks:
        jdHash = null,
        resumeId = null,
        // tuning:
        topKGlobal = 14,      // global top-K evidence
        includePerTerm = true,
        temperature = 0.2
      } = body || {};

      // --- Resolve JD with hybrid precedence
      let jdRecord = null;
      if (jdHash) {
        jdRecord = getJD(jdHash);
        if (!jdRecord && jdText) {
          const parsed = await parseAndCacheJD(jdText);
          jdRecord = getJD(parsed.jdHash);
        }
        if (!jdRecord && !jdText) return reply.code(404).send({ error: `JD not found: ${jdHash}` });
      } else if (jdText) {
        const parsed = await parseAndCacheJD(jdText);
        jdRecord = getJD(parsed.jdHash);
      } else {
        return reply.code(400).send({ error: 'Provide jdHash or jdText' });
      }

      // Use both the structured JSON and the raw JD text we store in metadata
      const jdObj = jdRecord.jd || {};
      const rawJdText = (jdRecord.metadata?.jdText || '').toString();
      const jdSignal = buildJdSignal(jdObj, rawJdText);
      const jdSignalNorm = normalizeCanonicalText(jdSignal, { flatten: 'soft' });

      // Pull structured fields (if any)
      const jdTitle   = jdObj?.roleOrg?.title || null;
      const jdFuncs   = jdObj?.roleOrg?.functions || [];
      const jdSkills  = jdObj?.successSignals?.topHardSkills || [];
      const jdOutcomes= (jdObj?.successSignals?.keyOutcomes || []).map(o => o?.text).filter(Boolean);
      const jdLangs   = jdObj?.logistics?.languages || [];
      const yoeMin    = jdObj?.requirements?.yoeMin ?? null;
      const eduMin    = jdObj?.requirements?.educationMin ?? null;

      // --- Resolve Resume text (+ overview if available)
      let cvText = resumeText;
      let resumeLabel = 'inline';
      let overview = null;
      if (!cvText && resumeId) {
        const r = getResume(resumeId);
        if (!r) return reply.code(404).send({ error: `Resume not found: ${resumeId}` });
        resumeLabel = resumeId;
        overview = r.overview || null;
        cvText = r?.canonicalText || r?.text?.canonical || r?.text || '';
      }
      if (!cvText) return reply.code(400).send({ error: 'Provide resumeText or resumeId' });
      const cvCanonical = normalizeCanonicalText(cvText, { flatten: 'soft' });

      // --- Base sims (for overall verdict band)
      const actualJdHash = jdRecord.metadata?.jdHash || jdHash || 'inline';
      const [jdVec, cvVec] = await Promise.all([
        getEmbedding(jdSignalNorm, signalCacheKey('jdSignal', actualJdHash, jdSignalNorm)),
        getEmbedding(cvCanonical,  signalCacheKey('cvRaw', resumeLabel, cvCanonical.slice(0, 8192)))
      ]);
      const semanticCosine = Number(cosine(cvVec, jdVec).toFixed(4));
      const cvShort = cvCanonical.slice(0, 4000);
      const cvShortVec = await getEmbedding(cvShort, signalCacheKey('cvShort', resumeLabel, cvShort));
      const fullTextCosine = Number(cosine(cvShortVec, jdVec).toFixed(4));
      const band = verdictBand(semanticCosine);

      // --- Sentence embeddings
      const sentences = splitSentences(cvCanonical);
      const sentVecs = await Promise.all(
        sentences.map((s,i) =>
          getEmbedding(s, signalCacheKey('sent', `cv:${resumeLabel}`, `${i}:${s.slice(0,64)}`))
        )
      );

      // --- Global top-K evidence vs JD signal
      const globalRank = sentences
        .map((s, i) => ({ idx: i, text: s, cos: cosine(sentVecs[i], jdVec) }))
        .sort((a,b) => b.cos - a.cos)
        .slice(0, Math.max(6, Math.min(30, topKGlobal)));

      // --- Per-term best matches (functions/skills/outcomes)
      let funcHits = [], skillHits = [], outcomeHits = [];
      if (includePerTerm) {
        funcHits    = await bestForTerms(jdFuncs,    sentVecs, sentences, 'func', resumeLabel, actualJdHash);
        skillHits   = await bestForTerms(jdSkills,   sentVecs, sentences, 'skill', resumeLabel, actualJdHash);
        outcomeHits = await bestForTerms(jdOutcomes, sentVecs, sentences, 'outcome', resumeLabel, actualJdHash);
      }

      // --- Union evidence set: global top-K + all per-term picks (cap 40)
      const wantedIdx = new Set(globalRank.map(r => r.idx));
      for (const arr of [funcHits, skillHits, outcomeHits]) {
        for (const h of arr) if (h.idx >= 0) wantedIdx.add(h.idx);
      }
      const evidenceAll = sentences
        .map((s,i) => ({ idx:i, text:s, cos: cosine(sentVecs[i], jdVec) }))
        .filter(r => wantedIdx.has(r.idx))
        .sort((a,b) => b.cos - a.cos)
        .slice(0, 40);
      const evidenceMd = evidenceAll.map(r => `[#${r.idx}] ${r.text}`).join('\n');

      // --- Must-haves labeling
      const musts = [];
      // Language(s)
      if (jdLangs?.length) {
        const overlap = languageOverlap(jdLangs, cvCanonical);
        const hits = overlap.length ? 'strong' : 'none';
        musts.push({ name: `Language(${jdLangs.join(', ')})`, level: hits, evidence: overlap.length ? `found: ${overlap.join(', ')}` : 'not evidenced' });
      }
      // YOE
      if (yoeMin != null) {
        const ycv = overview?.yoe ?? null;
        let level = 'unknown', ev = 'unknown';
        if (typeof ycv === 'number') {
          level = (ycv >= yoeMin) ? 'strong' : 'none';
          ev = `resume_yOE=${ycv}, req_min=${yoeMin}`;
        }
        musts.push({ name: `YOE(>=${yoeMin})`, level, evidence: ev });
      }
      // Education min
      if (eduMin) {
        const eduCand = overview?.education?.level || null;
        let level='unknown', ev='unknown';
        if (eduCand) {
          level = educationMeets(eduCand, eduMin) ? 'strong' : 'none';
          ev = `candidate=${eduCand}, req=${eduMin}`;
        }
        musts.push({ name: `Education(>=${eduMin})`, level, evidence: ev });
      }

      // --- Compact evidence pack for LLM (no JSON required, but structured text)
      const section = (label, items, mapFn) => {
        if (!items?.length) return `${label}: (none)`;
        return `${label}:\n` + items.map(mapFn).join('\n');
      };

      const fmtHit = h => {
        if (!h || !h.jd) return '';
        if (h.idx < 0) return `- ${h.jd}: level=${h.level} (no evidence)`;
        return `- ${h.jd}: level=${h.level} (cos=${h.cosine?.toFixed?.(3) ?? h.cosine}) evidence=[#${h.idx}] "${h.text}"`;
      };

      const mustLines = musts.length
        ? musts.map(m => `- ${m.name}: ${m.level.toUpperCase()} (${m.evidence})`).join('\n')
        : '- (none)';

      const jdTitleStr = jdTitle ? `Role: ${jdTitle}` : 'Role: (title not provided)';

      const guidance = [
        jdTitleStr,
        `Verdict band (semantic): ${band} (semantic=${semanticCosine}, text=${fullTextCosine})`,
        '',
        'MUST HAVES:',
        mustLines,
        '',
        section('FUNCTIONS', funcHits, fmtHit),
        section('SKILLS',    skillHits, fmtHit),
        section('OUTCOMES',  outcomeHits, fmtHit),
        '',
        `EVIDENCE (union of top-K and per-term picks, cite by index):`,
        evidenceMd || '(none)'
      ].join('\n');

      // --- LLM prompt (bar-raiser; strict format; no fluff)
      const sys = [
        'You are a bar-raiser recruiter.',
        'Be brief, blunt, and evidence-led.',
        'If a must-have is NONE/failed, recommend Reject or Maybe with explicit reason.',
        'Do not infer beyond the provided evidence. If something is not evidenced, say so.',
        'Length target: ~120–150 words.'
      ].join(' ');

      const user = [
        guidance,
        '',
        'Write Markdown with exactly this shape:',
        '## Why this candidate fits',
        '- Up to 3 bullets with concrete reasons tied to the JD (cite [#idx]).',
        '### Potential risks',
        '- Up to 3 bullets; focus on gaps or mismatches.',
        '### Next step',
        '- 1–2 bullets (what you would ask/verify).',
        '',
        'Then a final verdict line using one of:',
        '**Pass to phone screen** | **Maybe** | **Reject**',
        '',
        'Rules:',
        '- If any MUST HAVE is NONE, default to Reject unless other must-haves are strong and role is highly flexible.',
        '- Avoid generic praise. No fluff. Use the evidence indexes.',
      ].join('\n');

      const resp = await client.chat.completions.create({
        model: LLM_MODEL,
        ...(temperature !== null && { temperature }),
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user }
        ]
      });

      const md = resp.choices?.[0]?.message?.content?.trim() || 'No explanation generated.';
      reply.header('Content-Type', 'text/markdown; charset=utf-8');
      return reply.send(md);
    } catch (e) {
      req.log.error(e);
      return reply.code(500).send({ error: 'EXPLAIN_LLM_FAILED', message: e.message });
    }
  });
}
