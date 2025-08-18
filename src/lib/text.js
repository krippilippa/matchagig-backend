export function normalizeToken(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9+&/#.\- ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function intersect(a = [], b = [], limit = Infinity) {
  const Aset = new Set(a.map(normalizeToken).filter(Boolean));
  const out = [];
  const seen = new Set();
  for (const x of b) {
    const nx = normalizeToken(x);
    if (!nx || seen.has(nx)) continue;
    if (Aset.has(nx)) {
      out.push(nx);
      seen.add(nx);
      if (out.length >= limit) break;
    }
  }
  return out;
}

const EDU_RANK = {
  'none': 0,
  'high school': 1,
  'diploma/certificate': 2,
  'associate': 3,
  'bachelor': 4,
  'master': 5,
  'phd/doctorate': 6,
  null: -1,
  unknown: -1,
  '': -1
};

export function educationRank(level) {
  if (!level) return -1;
  const key = String(level).toLowerCase();
  return EDU_RANK[key] ?? -1;
}

export function educationMeets(resumeEdu, jdEduMin) {
  if (!jdEduMin) return true;
  if (String(jdEduMin).toLowerCase() === 'none') return true;
  return educationRank(resumeEdu) >= educationRank(jdEduMin);
}

export function containsAny(haystack = '', needles = []) {
  const t = normalizeToken(haystack);
  return needles.some(n => t.includes(normalizeToken(n)));
}

export function anyContainsAny(arr = [], needles = []) {
  return arr.some(v => containsAny(typeof v === 'string' ? v : v?.text || '', needles));
}


