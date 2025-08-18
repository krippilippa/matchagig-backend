const PUNCT_RE = /[\p{P}\p{S}]+/gu;

export function normalizeToken(s) {
  if (!s) return '';
  let t = String(s).toLowerCase().trim();
  t = t.replace(PUNCT_RE, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  // basic plural stripping
  if (t.endsWith('es')) t = t.slice(0, -2);
  else if (t.endsWith('s')) t = t.slice(0, -1);
  return t;
}

export function intersect(a = [], b = [], limit = Infinity) {
  const A = Array.from(new Set(a.map(normalizeToken).filter(Boolean)));
  const Bset = new Set(b.map(normalizeToken).filter(Boolean));
  const out = [];
  for (const x of A) {
    if (Bset.has(x)) out.push(x);
    if (out.length >= limit) break;
  }
  return out;
}

export function educationRank(level) {
  const order = ['None','High School','Diploma/Certificate','Associate','Bachelor','Master','PhD/Doctorate'];
  const i = order.indexOf(level || '');
  return i === -1 ? -1 : i;
}

export function containsAny(haystack = '', needles = []) {
  const t = normalizeToken(haystack);
  return needles.some(n => t.includes(normalizeToken(n)));
}

export function anyContainsAny(arr = [], needles = []) {
  return arr.some(v => containsAny(typeof v === 'string' ? v : v?.text || '', needles));
}


