// lib/jd-signal.js - JD signal builder (structured JD → string)
const norm = (s) => (s || "").toString().trim();

export function buildJdSignal(jd = {}) {
  const ro = jd.roleOrg || {}, log = jd.logistics || {}, req = jd.requirements || {}, ss = jd.successSignals || {};
  const title = norm(ro.title);
  const funcs = (ro.functions || []).map(norm).join(", ");
  const skills = (ss.topHardSkills || []).map(norm).join(", ");
  const outcomes = (ss.keyOutcomes || []).map(o => norm(o?.text)).filter(Boolean).join(", ");
  const inds = (ss.industryHints || []).map(norm).join(", ");
  const seniority = norm(ro.seniorityHint);
  const langs = (log.languages || []).map(norm).join(", ");
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
  ].filter(Boolean).join(" | ");
}
