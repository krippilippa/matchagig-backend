// Matching configuration: tweak weights and thresholds without touching logic

export const COSINE_WEIGHT = 70; // base score weight (cosine * COSINE_WEIGHT)

export const BOOSTS = {
  functions: 5,
  skills: 5,
  languages: 5,
  achievements: 3,
  softSkillPerMatch: 2,
};

export const PENALTIES = {
  seniorityLeadVsMid: -8, // JD Mid/Junior vs CV Lead/Director+
  languageMissing: -10,
};

export const GATES = {
  yoeToleranceYears: 1, // allow this much below yoeMin before hard fail
};

export const SOFT_SKILL = {
  cosineThreshold: 0.80, // semantic match threshold for soft skill matches
};

export const SOFT_FUNC = {
  cosineThreshold: 0.50,
  perMatch: 2,
  maxTotal: 4,
};

export const SOFT_INDUSTRY = {
  cosineThreshold: 0.45,
  perMatch: 2,
  maxTotal: 4,
};


