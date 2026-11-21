// Mutant generation and application.
//
// Mutants are generated from the Babel AST but applied by splicing the original
// source text, so formatting outside the mutated span is preserved and the diff
// shown to users is a single, readable change. Babel's start/end are offsets
// into the JS string, so splicing works directly on the source string.

import { parse } from "@babel/parser";
import { createHash } from "node:crypto";

const ROR = { "<": "<=", "<=": "<", ">": ">=", ">=": ">", "==": "!=", "!=": "==", "===": "!==", "!==": "===" };
const AOR = { "+": "-", "-": "+", "*": "/", "/": "*", "%": "*", "**": "*" };
const LCR = { "&&": "||", "||": "&&" };
const NAMES = {
  "<": "LT", "<=": "LTE", ">": "GT", ">=": "GTE", "==": "EQ", "!=": "NEQ", "===": "SEQ", "!==": "SNEQ",
  "+": "ADD", "-": "SUB", "*": "MUL", "/": "DIV", "%": "MOD", "**": "POW", "&&": "AND", "||": "OR",
};

// AST keys that never hold runtime code (or aren't child nodes at all).
const SKIP_KEYS = new Set([
  "loc", "start", "end", "extra", "range", "leadingComments", "trailingComments", "innerComments",
  "comments", "tokens", "typeAnnotation", "returnType", "typeParameters", "typeArguments",
  "superTypeParameters", "implements", "predicate",
]);
// Subtrees never mutated: imports, template literals (like f-strings), directives.
const SKIP_NODES = new Set([
  "ImportDeclaration", "ExportAllDeclaration", "TemplateLiteral", "TaggedTemplateExpression",
  "Directive", "DirectiveLiteral",
]);
// TypeScript nodes that contain runtime expressions; every other TS* node is type-only.
const RUNTIME_TS = new Set([
  "TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "TSTypeAssertion",
  "TSParameterProperty", "TSInstantiationExpression", "TSExportAssignment",
]);
const STATEMENT_LISTS = new Set(["Program", "BlockStatement", "StaticBlock", "SwitchCase"]);

export class MutantMismatch extends Error {}

export function parseSource(file, source) {
  const ts = /\.[cm]?tsx?$/.test(file);
  return parse(source, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    plugins: ts ? ["typescript", ...(file.endsWith(".tsx") ? ["jsx"] : [])] : ["jsx"],
  });
}

/**
 * Depth-first walk yielding [node, parent, stmt], where `stmt` describes the
 * nearest enclosing ExpressionStatement and whether it sits in a statement list
 * (needed to avoid ASI hazards; see `add` below).
 */
export function* walk(node, parent = null, stmt = null) {
  if (node.type.startsWith("TS") && !RUNTIME_TS.has(node.type)) return;
  yield [node, parent, stmt];
  if (SKIP_NODES.has(node.type)) return;
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = node[key];
    const children = Array.isArray(value) ? value : [value];
    for (const child of children) {
      if (!child || typeof child.type !== "string") continue;
      const childStmt = child.type === "ExpressionStatement"
        ? { start: child.start, listed: STATEMENT_LISTS.has(node.type) }
        : stmt;
      yield* walk(child, node, childStmt);
    }
  }
}

export function mutantId(m) {
  const raw = [m.file, `${m.start}-${m.end}`, m.operator, m.replacement].join("\0");
  return "m_" + createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

const paren = (text) => `(${text})`;

class Generator {
  constructor(file, source, lines) {
    this.file = file;
    this.source = source;
    this.lines = lines;
    this.mutants = [];
  }

  seg(node) {
    return this.source.slice(node.start, node.end);
  }

  add(node, operator, replacement, stmt) {
    const original = this.seg(node);
    if (replacement === original) return;
    // A replacement that starts with "(" at the start of a statement could be
    // parsed as a call on the previous line when that line has no semicolon.
    if (stmt?.listed && node.start === stmt.start && replacement.startsWith("(")) {
      replacement = ";" + replacement;
    }
    const m = {
      file: this.file, line: node.loc.start.line, column: node.loc.start.column,
      start: node.start, end: node.end, operator, original, replacement,
    };
    this.mutants.push({ id: mutantId(m), ...m });
  }

  binary(node, table, prefix, stmt) {
    if (node.left.type === "PrivateName") return;
    const op = table[node.operator];
    const text = `${paren(this.seg(node.left))} ${op} ${paren(this.seg(node.right))}`;
    this.add(node, `${prefix}_${NAMES[node.operator]}_TO_${NAMES[op]}`, paren(text), stmt);
  }

  visit(node, parent, stmt) {
    if (!node.loc || (this.lines && !this.lines.has(node.loc.start.line))) return;
    switch (node.type) {
      case "BinaryExpression":
        if (node.operator in ROR) this.binary(node, ROR, "ROR", stmt);
        else if (node.operator in AOR) this.binary(node, AOR, "AOR", stmt);
        break;
      case "LogicalExpression":
        if (node.operator in LCR) this.binary(node, LCR, "LCR", stmt);
        break;
      case "UnaryExpression":
        if (node.operator === "!") this.add(node, "NOT_DROP", paren(this.seg(node.argument)), stmt);
        break;
      case "BooleanLiteral":
        this.add(node, "CRP_BOOL", node.value ? "false" : "true", stmt);
        break;
      case "NumericLiteral":
        this.add(node, "CRP_NUM_INCREMENT", String(node.value + 1), stmt);
        break;
      case "ReturnStatement": {
        const arg = node.argument;
        const isUndefined = !arg || (arg.type === "Identifier" && arg.name === "undefined") ||
          (arg.type === "UnaryExpression" && arg.operator === "void");
        if (!isUndefined) this.add(arg, "RVR_TO_UNDEFINED", "undefined", null);
        break;
      }
      case "ExpressionStatement": {
        let expr = node.expression;
        if (expr.type === "AwaitExpression") expr = expr.argument;
        if (expr.type === "CallExpression" || expr.type === "OptionalCallExpression") {
          this.add(node, "SDL_CALL", ";", null);
        } else if ((expr.type === "AssignmentExpression" && expr.operator !== "=") ||
          expr.type === "UpdateExpression") {
          this.add(node, "SDL_UPDATE", ";", null);
        }
        break;
      }
      // String literals are deliberately not mutated: most string mutants are
      // equivalent (log messages, labels) and add noise without adding evidence.
    }
  }
}

/**
 * Generate mutants for nodes that start on `lines` (a Set; all lines if null).
 * Mutants that don't parse are dropped, so every returned mutant is valid code.
 */
export function generateMutants(file, source, lines = null) {
  const gen = new Generator(file, source, lines);
  for (const [node, parent, stmt] of walk(parseSource(file, source).program)) {
    gen.visit(node, parent, stmt);
  }

  const seen = new Set();
  const valid = [];
  for (const m of gen.mutants) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    try {
      parseSource(file, applyMutant(source, m));
    } catch (err) {
      if (err instanceof MutantMismatch) throw err;
      continue;
    }
    valid.push(m);
  }
  return valid.sort((a, b) => a.start - b.start || a.operator.localeCompare(b.operator));
}

/** Return `source` with the mutant's span replaced; refuses stale descriptors. */
export function applyMutant(source, m) {
  if (source.slice(m.start, m.end) !== m.original) {
    throw new MutantMismatch(`${m.id}: source at ${m.file}:${m.line} no longer matches`);
  }
  return source.slice(0, m.start) + m.replacement + source.slice(m.end);
}

/** A minimal two-line diff of the first affected line, for reports. */
export function mutantDiff(source, m) {
  const before = source.split(/\r?\n/)[m.line - 1].trim();
  const after = applyMutant(source, m).split(/\r?\n/)[m.line - 1].trim();
  return `- ${before}\n+ ${after}`;
}

/** Lines that start an executable statement (not declarations-only, blocks or imports). */
export function statementLines(file, source) {
  const skip = new Set(["BlockStatement", "EmptyStatement", "FunctionDeclaration", "ClassDeclaration",
    "ImportDeclaration", "ExportNamedDeclaration", "ExportDefaultDeclaration", "ExportAllDeclaration"]);
  const lines = new Set();
  for (const [node] of walk(parseSource(file, source).program)) {
    const isStatement = node.type.endsWith("Statement") || node.type === "VariableDeclaration";
    if (isStatement && !skip.has(node.type)) lines.add(node.loc.start.line);
  }
  return lines;
}
