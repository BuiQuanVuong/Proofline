// Proofline mutation engine: generate, apply and execute change-scoped mutants.

export { gitChangedLines, isConfigPath, isSourcePath, isTestPath, parseUnifiedDiff } from "./diff.js";
export { MutantMismatch, applyMutant, generateMutants, mutantDiff, mutantId, statementLines } from "./mutate.js";
export { FileHasher, mutantCacheKey, sha256 } from "./cachekey.js";
export * from "./execute.js";
export { buildReport, mutationScore, riskTier } from "./report.js";
export { verifyLocal } from "./pipeline.js";
export { analyzeChange } from "./framework/analyze.js";
export { assess } from "./framework/assess.js";
export { complexity, staticFindings } from "./framework/checks.js";
export { PROFILE_FILE, globToRegExp, parseProfile, requiredLevelFor } from "./framework/profile.js";
export { CATEGORY, FRAMEWORK, LIMITS, RULES, levelName } from "./framework/rules.js";
export { toSarif } from "./framework/sarif.js";
