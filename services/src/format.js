// Plain-text rendering of a report, shared by the CLI and local-e2e.

const ORDER = { mandatory: 0, required: 1, advisory: 2 };

/** The PVF part of a report. */
export function formatConformance(c) {
  if (!c) return [];
  const lines = ["", `PVF 1.0 verdict:       ${c.verdict}${c.achievedLevel ? `  (lowest level achieved: ${c.achievedLevel})` : ""}`];
  if (c.note) lines.push(`                       ${c.note}`);
  for (const f of c.files ?? []) {
    lines.push(`  ${f.meets ? "meets " : "BELOW "} ${f.file}  achieved ${f.achievedLevel}, required ${f.requiredLevel}` +
      `  (coverage ${f.coverage}, mutation score ${f.mutationScore})`);
    for (const b of f.blocking.slice(0, 3)) lines.push(`         next level needs: ${b}`);
  }
  const shown = (c.findings ?? [])
    .filter((f) => f.ruleId !== "PV-TEST-03") // survivors are listed in full below
    .sort((a, b) => ORDER[a.category] - ORDER[b.category] || (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0));
  if (shown.length) lines.push("", "Findings:");
  for (const f of shown) {
    const where = f.file ? `${f.file}:${f.line}` : "";
    const tag = f.status === "deviated" ? "deviated" : f.category;
    lines.push(`  ${f.ruleId.padEnd(11)} ${tag.padEnd(9)} ${where}  ${f.message}`);
    if (f.status === "deviated") lines.push(`              justification: ${f.deviation.justification}`);
    else if (f.witness?.snippet) lines.push(`              ${f.witness.snippet}`);
    else if (f.witness?.value && f.witness.kind === "secret") lines.push(`              value: ${f.witness.value} (redacted)`);
  }
  const deviatedMutants = (c.findings ?? []).filter((f) => f.ruleId === "PV-TEST-03" && f.status === "deviated");
  for (const f of deviatedMutants) {
    lines.push(`  PV-TEST-03  deviated  ${f.file}:${f.line}  ${f.witness.operator}`, `              justification: ${f.deviation.justification}`);
  }
  for (const e of c.profileErrors ?? []) lines.push(`  profile error: ${e}`);
  return lines;
}

export function formatReport(report, { location } = {}) {
  const m = report.mutants;
  const lines = [
    "",
    `Risk tier:             ${report.riskTier}${report.partial ? "  (PARTIAL: some shards failed)" : ""}`,
    `Mutation score:        ${report.mutationScore}`,
    `Changed-line coverage: ${report.changedLineCoverage ?? "n/a"}`,
    `Mutants:               ${m.total} total, ${m.killed} killed, ${m.survived} survived, ${m.noCoverage} uncovered, ` +
      `${m.timeout} timeout, ${m.error} error${m.missing ? `, ${m.missing} missing` : ""}, ${m.cacheHits} from cache`,
  ];
  if (location) lines.push(`Report:                ${location}`);
  lines.push(...formatConformance(report.conformance));
  if (report.evidence?.length) lines.push("", "Surviving mutants (PV-TEST-03):");
  for (const e of report.evidence ?? []) {
    lines.push("", `  ${e.outcome}  ${e.file}:${e.line}  ${e.operator}`, `    ${e.diff.replace("\n", "\n    ")}`);
  }
  for (const e of report.errors ?? []) {
    lines.push("", `  ERROR  ${e.file}:${e.line}  ${e.detail ?? ""}`);
  }
  lines.push("");
  return lines.join("\n");
}
