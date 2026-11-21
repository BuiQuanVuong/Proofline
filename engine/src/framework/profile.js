// The repository profile, .proofline.json.

import { CATEGORY, DEFAULT_REQUIRED_LEVEL, RULES, parseLevel } from "./rules.js";

export const PROFILE_FILE = ".proofline.json";

/** `*` stays within a path segment, `**` crosses segments. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?"; // "**/" also matches zero directories
      } else {
        re += ".*";
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export const matchesAny = (file, globs) => globs.some((g) => globToRegExp(g).test(file));

/**
 * Validate a profile object. Invalid entries are dropped and reported, so a
 * typo can never silently weaken the assessment. Returns { profile, errors }.
 */
export function parseProfile(raw) {
  const errors = [];
  const profile = { requiredLevel: DEFAULT_REQUIRED_LEVEL, paths: [], deviations: [], declared: raw != null };
  if (raw == null) return { profile, errors };
  if (typeof raw !== "object" || Array.isArray(raw)) return { profile, errors: ["profile must be a JSON object"] };

  if (raw.pvf !== undefined && raw.pvf !== "1.0") errors.push(`profile targets pvf ${raw.pvf}; assessed against pvf 1.0`);
  if (raw.requiredLevel !== undefined) {
    const level = parseLevel(raw.requiredLevel);
    if (level === null) errors.push(`requiredLevel "${raw.requiredLevel}" is not PV-1..PV-4; using PV-${DEFAULT_REQUIRED_LEVEL}`);
    else profile.requiredLevel = level;
  }
  for (const [i, entry] of (Array.isArray(raw.paths) ? raw.paths : []).entries()) {
    const level = parseLevel(entry?.requiredLevel);
    if (typeof entry?.glob !== "string" || level === null) {
      errors.push(`paths[${i}] needs a glob and a requiredLevel PV-1..PV-4`);
      continue;
    }
    profile.paths.push({ glob: entry.glob, requiredLevel: level });
  }
  for (const [i, d] of (Array.isArray(raw.deviations) ? raw.deviations : []).entries()) {
    const label = `deviations[${i}]${d?.rule ? ` (${d.rule})` : ""}`;
    const rule = RULES[d?.rule];
    if (!rule) { errors.push(`${label}: unknown rule`); continue; }
    if (rule.category === CATEGORY.MANDATORY) { errors.push(`${label}: mandatory rules can't be deviated`); continue; }
    if (typeof d.justification !== "string" || !d.justification.trim()) { errors.push(`${label}: a justification is required`); continue; }
    const byPath = Array.isArray(d.paths) && d.paths.length > 0 && d.paths.every((p) => typeof p === "string");
    const byFinding = typeof d.file === "string" && Number.isInteger(d.line);
    if (byPath === byFinding) { errors.push(`${label}: give either paths, or file + line`); continue; }
    profile.deviations.push({
      rule: d.rule, justification: d.justification.trim(), approvedBy: d.approvedBy ?? null,
      ...(byPath ? { paths: d.paths } : { file: d.file, line: d.line, operator: d.operator ?? null }),
    });
  }
  return { profile, errors };
}

/** The strictest level required for a file by the profile. */
export function requiredLevelFor(profile, file) {
  return profile.paths.reduce((level, p) => (globToRegExp(p.glob).test(file) ? Math.max(level, p.requiredLevel) : level),
    profile.requiredLevel);
}

/** The first deviation that covers a finding, or null. */
export function deviationFor(profile, finding) {
  return profile.deviations.find((d) => d.rule === finding.ruleId && (
    d.paths ? matchesAny(finding.file, d.paths)
      : d.file === finding.file && d.line === finding.line && (!d.operator || d.operator === finding.witness?.operator)
  )) ?? null;
}
