// PVF assessment -> SARIF 2.1.0. Deviations become
// SARIF suppressions, so consumers such as GitHub code scanning show them as
// reviewed rather than hiding them.

import { CATEGORY, FRAMEWORK, RULES } from "./rules.js";

const SARIF_LEVEL = { [CATEGORY.MANDATORY]: "error", [CATEGORY.REQUIRED]: "error", [CATEGORY.ADVISORY]: "note" };

export function toSarif(conformance, { version = "1.0.0", informationUri = "https://github.com/" } = {}) {
  const ruleIds = Object.keys(RULES);
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "Proofline", version, semanticVersion: version, informationUri,
          rules: ruleIds.map((id) => ({
            id,
            name: RULES[id].name.replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : "")),
            shortDescription: { text: RULES[id].name },
            defaultConfiguration: { level: SARIF_LEVEL[RULES[id].category] },
            properties: { category: RULES[id].category, characteristic: RULES[id].characteristic,
              ...(RULES[id].cwe ? { cwe: RULES[id].cwe, tags: [RULES[id].cwe] } : {}) },
          })),
        },
      },
      properties: { framework: FRAMEWORK, verdict: conformance.verdict, achievedLevel: conformance.achievedLevel,
        files: conformance.files },
      results: conformance.findings.map((f) => ({
        ruleId: f.ruleId,
        ruleIndex: ruleIds.indexOf(f.ruleId),
        level: SARIF_LEVEL[f.category],
        message: { text: f.message },
        ...(f.file ? { locations: [{ physicalLocation: {
          artifactLocation: { uri: f.file },
          region: { startLine: f.line ?? 1, ...(f.column ? { startColumn: f.column } : {}) },
        } }] } : {}),
        ...(f.status === "deviated" ? { suppressions: [{ kind: "external", status: "accepted",
          justification: f.deviation.justification }] } : {}),
        properties: { witness: f.witness, category: f.category },
      })),
    }],
  };
}
