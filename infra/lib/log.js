// Shared output and error helpers for deploy/teardown scripts.

export function log(status, label, detail = "") {
  console.log(`  ${status.padEnd(9)} ${label}${detail ? `  ${detail}` : ""}`);
}

/** True if an AWS SDK error matches any of the given error names/codes. */
export function isError(err, ...names) {
  return names.includes(err?.name) || names.includes(err?.Code) || names.includes(err?.code);
}
