// lib/canon.js - Shared text normalization for resumes
export function normalizeCanonicalText(raw, { flatten = 'none' } = {}) {
  let t = (raw ?? '').normalize('NFC');

  // control chars (keep \n)
  t = t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // spaces & blank blocks
  t = t.replace(/\t/g, ' ');
  t = t.replace(/[^\S\n]+/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');

  // de-hyphenate wrapped words: "construc-\ntion" -> "construction"
  t = t.replace(/(\p{L}{2,})-\s*\n\s*(\p{Ll}+)/gu, '$1$2');

  // normalize bullets
  t = t.replace(/^[\s]*[•‣∙◦–—·*●○-][\s]+/gm, '- ').replace(/^-[\s]{2,}/gm, '- ');

  // tame weird separator glyphs
  t = t.replace(/[‒—–ᅳ]+/g, '—');

  // >>> NEW: soft line-wrap joining <<<
  if (flatten === 'soft') {
    // join single newlines inside sentences (keep blank-line paragraph breaks)
    // letter/number → \n → lowercase/number  => space
    t = t.replace(/(?<=\p{L}|\d)[ \t]*\n(?!\n)[ \t]*(?=\p{Ll}|\d)/gu, ' ');
    // after comma/semicolon/colon → \n → word  => space
    t = t.replace(/(?<=[,;:])\s*\n(?!\n)\s*/g, ' ');
  } else if (flatten === 'all') {
    // collapse all single newlines; keep paragraph breaks
    t = t.replace(/\n{2,}/g, '¶').replace(/\n/g, ' ').replace(/¶/g, '\n\n');
  }

  // light section breaks: add a newline before ALL-CAPS headers that follow a period
  t = t.replace(/([^.])\.(?=[A-Z][A-Z0-9/& \-]{5,}\b)/g, '$1.\n');

  // >>> remove leading blank lines completely
  t = t.replace(/^\s*\n+/g, '');

  // tidy edges
  t = t.replace(/[ \t]+\n/g, '\n').trimEnd() + '\n';

  return t;
}

// Optional helper for preview strings (single line)
export function flattenForPreview(t) {
  return (t || '').replace(/\s+/g, ' ').trim();
}
