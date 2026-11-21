// Static PVF rules: AST checks on changed lines only.
// Pure and safe: reads source text, never executes it, so the planner (which
// must never run repository code) can call it.

import { parseSource } from "../mutate.js";

const SKIP_KEYS = new Set([
  "loc", "start", "end", "extra", "range", "leadingComments", "trailingComments", "innerComments", "comments",
  "tokens", "typeAnnotation", "returnType", "typeParameters", "typeArguments", "superTypeParameters", "implements",
]);
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod",
]);
const DECISIONS = new Set([
  "IfStatement", "ConditionalExpression", "ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement",
  "DoWhileStatement", "CatchClause",
]);

/** Depth-first [node, parent] pairs; type-only TypeScript subtrees are skipped. */
function* nodes(node, parent = null) {
  if (node.type.startsWith("TS") && !/^TS(As|Satisfies|NonNull|TypeAssertion|Instantiation)Expression$|^TSParameterProperty$/.test(node.type)) return;
  yield [node, parent];
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    for (const child of [node[key]].flat()) {
      if (child && typeof child.type === "string") yield* nodes(child, node);
    }
  }
}

/** True for values fixed at the time the code was written. */
function isConstant(node) {
  if (!node) return true;
  switch (node.type) {
    case "StringLiteral": case "NumericLiteral": case "BooleanLiteral": case "NullLiteral": return true;
    case "TemplateLiteral": return node.expressions.length === 0;
    case "BinaryExpression": return node.operator === "+" && isConstant(node.left) && isConstant(node.right);
    default: return false;
  }
}

const isStringy = (node) => node && (node.type === "TemplateLiteral" || (node.type === "BinaryExpression" && node.operator === "+"));
const calleeName = (callee) => {
  if (callee.type === "Identifier") return callee.name;
  if ((callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") && !callee.computed && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  return null;
};
const objectName = (callee) => (callee.type === "MemberExpression" && callee.object.type === "Identifier" ? callee.object.name : null);

const CREDENTIAL_NAMES = ["password", "passwd", "pwd", "secret", "token", "apikey", "privatekey", "accesskey", "clientsecret"];
const TOKEN_PATTERNS = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key ID", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
];
const PLACEHOLDER = /^(\*+|x+|\.+|changeme|change[-_ ]?me|placeholder|example|<.*>|\$\{.*\}|your[-_ ].*|todo)$/i;
const isCredentialName = (name) => {
  const n = String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
  return CREDENTIAL_NAMES.some((c) => n.endsWith(c));
};
const literalValue = (node) => {
  if (node?.type === "StringLiteral") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
};
const redact = (value) => `${value.slice(0, 4)}… (${value.length} chars)`;

function functionName(fn, parent) {
  if (fn.id?.name) return fn.id.name;
  if (fn.key) return fn.key.name ?? fn.key.value ?? "(computed)";
  if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
  if ((parent?.type === "ObjectProperty" || parent?.type === "ClassProperty") && parent.key) return parent.key.name ?? parent.key.value;
  if (parent?.type === "AssignmentExpression") return calleeName(parent.left) ?? "(anonymous)";
  return "(anonymous)";
}

/** Cyclomatic complexity of one function, excluding nested functions. */
export function complexity(fn) {
  const points = [];
  const visit = (node) => {
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      for (const child of [node[key]].flat()) {
        if (!child || typeof child.type !== "string") continue;
        if (FUNCTION_TYPES.has(child.type)) continue;
        if (DECISIONS.has(child.type) || (child.type === "SwitchCase" && child.test) ||
          (child.type === "LogicalExpression" && ["&&", "||", "??"].includes(child.operator))) {
          points.push(child.loc.start.line);
        }
        visit(child);
      }
    }
  };
  visit(fn.body ?? fn);
  return { value: 1 + points.length, decisionLines: points };
}

/**
 * Findings for every static rule on the changed `lines` (a Set) of one file.
 * Each finding: { ruleId, file, line, column, message, witness }.
 */
export function staticFindings(file, source, lines) {
  const ast = parseSource(file, source);
  const sourceLines = source.split(/\r?\n/);
  const snippet = (line) => (sourceLines[line - 1] ?? "").trim().slice(0, 160);
  const findings = [];
  const add = (ruleId, node, message, witness = {}) => findings.push({
    ruleId, file, line: node.loc.start.line, column: node.loc.start.column + 1, message,
    witness: { kind: "ast", snippet: snippet(node.loc.start.line), ...witness },
  });
  const onChanged = (node) => node.loc && lines.has(node.loc.start.line);

  const usesChildProcess = [...nodes(ast.program)].some(([n]) =>
    (n.type === "ImportDeclaration" && /^(node:)?child_process$/.test(n.source.value)) ||
    (n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "require" &&
      /^(node:)?child_process$/.test(n.arguments[0]?.value ?? "")));

  const credential = (node, name, valueNode) => {
    const value = literalValue(valueNode);
    if (value === null || value.length < 8 || PLACEHOLDER.test(value) || !isCredentialName(name)) return;
    findings.push({
      ruleId: "PV-SEC-03", file, line: node.loc.start.line, column: node.loc.start.column + 1,
      message: `hard-coded credential in "${name}"`,
      witness: { kind: "secret", name, value: redact(value) },
    });
  };

  for (const [node, parent] of nodes(ast.program)) {
    if (FUNCTION_TYPES.has(node.type) && node.loc &&
      [...lines].some((l) => l >= node.loc.start.line && l <= node.loc.end.line)) {
      const name = functionName(node, parent);
      const { value, decisionLines } = complexity(node);
      if (value > 10) {
        add("PV-MAINT-01", node, `${name}() has cyclomatic complexity ${value} (limit 10)`,
          { kind: "metric", function: name, value, limit: 10, decisionLines });
      }
      const length = node.loc.end.line - node.loc.start.line + 1;
      if (length > 60) {
        add("PV-MAINT-02", node, `${name}() is ${length} lines long (limit 60)`,
          { kind: "metric", function: name, value: length, limit: 60 });
      }
    }
    if (!onChanged(node)) continue;

    switch (node.type) {
      case "CallExpression":
      case "OptionalCallExpression": {
        const name = calleeName(node.callee);
        const [first, second] = node.arguments;
        if (name === "eval" && !isConstant(first)) {
          add("PV-SEC-01", node, "eval() of a non-constant value", { reason: "dynamic code evaluation" });
        } else if ((name === "setTimeout" || name === "setInterval") && isStringy(first) && !isConstant(first)) {
          add("PV-SEC-01", node, `${name}() with a string built at run time`, { reason: "string is evaluated as code" });
        } else if (usesChildProcess && (name === "exec" || name === "execSync") && !isConstant(first)) {
          add("PV-SEC-02", node, `${name}() runs a shell command built from non-constant input`, { reason: "OS command injection" });
        } else if (usesChildProcess && ["spawn", "spawnSync", "execFile", "execFileSync"].includes(name) &&
          node.arguments.some((a) => a.type === "ObjectExpression" && a.properties.some((p) =>
            p.key?.name === "shell" && p.value?.type === "BooleanLiteral" && p.value.value)) &&
          node.arguments.some((a) => a.type !== "ObjectExpression" && !isConstant(a) && a.type !== "ArrayExpression")) {
          add("PV-SEC-02", node, `${name}() with shell: true and non-constant input`, { reason: "OS command injection" });
        } else if (name === "insertAdjacentHTML" && !isConstant(second)) {
          add("PV-SEC-04", node, "insertAdjacentHTML() with non-constant HTML", { reason: "HTML injection (XSS)" });
        } else if ((name === "write" || name === "writeln") && objectName(node.callee) === "document" &&
          node.arguments.some((a) => !isConstant(a))) {
          add("PV-SEC-04", node, `document.${name}() with non-constant HTML`, { reason: "HTML injection (XSS)" });
        } else if ((name === "log" || name === "debug") && objectName(node.callee) === "console") {
          add("PV-MAINT-03", node, `console.${name}() left in source`);
        }
        break;
      }
      case "NewExpression":
        if (node.callee.type === "Identifier" && node.callee.name === "Function" && node.arguments.some((a) => !isConstant(a))) {
          add("PV-SEC-01", node, "new Function() built from non-constant input", { reason: "dynamic code evaluation" });
        }
        break;
      case "AssignmentExpression": {
        const prop = calleeName(node.left);
        if ((prop === "innerHTML" || prop === "outerHTML") && node.left.type !== "Identifier" && !isConstant(node.right)) {
          add("PV-SEC-04", node, `${prop} assigned non-constant HTML`, { reason: "HTML injection (XSS)" });
        }
        if (prop) credential(node, prop, node.right);
        break;
      }
      case "VariableDeclarator":
        if (node.id.type === "Identifier") credential(node, node.id.name, node.init);
        break;
      case "ObjectProperty":
      case "ClassProperty":
        if (node.key && !node.computed) credential(node, node.key.name ?? node.key.value, node.value);
        break;
      case "CatchClause":
        if (node.body.body.length === 0 && !(node.body.innerComments?.length)) {
          add("PV-REL-02", node, "empty catch block swallows the error");
        }
        break;
      case "DebuggerStatement":
        add("PV-MAINT-03", node, "debugger statement left in source");
        break;
      default:
        break;
    }
    // Well-known token formats, in any string on a changed line. Template text is
    // checked through its elements only, so a template can't be reported twice.
    const text = node.type === "StringLiteral" ? node.value : node.type === "TemplateElement" ? node.value.cooked : null;
    if (text) {
      for (const [label, pattern] of TOKEN_PATTERNS) {
        const match = pattern.exec(text);
        if (match) {
          findings.push({
            ruleId: "PV-SEC-03", file, line: node.loc.start.line, column: node.loc.start.column + 1,
            message: `${label} in a string literal`, witness: { kind: "secret", name: label, value: redact(match[0]) },
          });
        }
      }
    }
  }

  for (const comment of ast.comments ?? []) {
    if (lines.has(comment.loc.start.line) && /\b(TODO|FIXME|XXX|HACK)\b/.test(comment.value)) {
      findings.push({
        ruleId: "PV-MAINT-04", file, line: comment.loc.start.line, column: comment.loc.start.column + 1,
        message: "work-in-progress marker added", witness: { kind: "ast", snippet: comment.value.trim().slice(0, 160) },
      });
    }
  }
  // A credential can match both the name rule and a token pattern: keep one finding per location.
  const seen = new Set();
  return findings.filter((f) => {
    const key = `${f.ruleId}:${f.line}:${f.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.line - b.line || a.column - b.column || a.ruleId.localeCompare(b.ruleId));
}
