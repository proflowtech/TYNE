/**
 * Detects control-flow branch points the diff actually touched — early-return
 * guards and switch statements — via the TypeScript AST. Same honesty rule as
 * the effect detector: a decision diamond only appears when a changed line sits
 * on the branch condition, so the chart never invents flow the diff didn't add.
 *
 * We deliberately promote only guards and switches. They have clear, nameable
 * outcomes (an exit, or a set of cases); a plain if/else without a clear exit
 * would force us to guess where each arm flows, which is exactly what we refuse
 * to do.
 */

import * as ts from 'typescript';
import { detectLanguage } from './astFacts';

export interface DecisionOutcome {
  label: string;
  kind: 'error' | 'return' | 'normal';
}

export interface DecisionSite {
  file: string;
  line: number;
  functionName?: string;
  kind: 'guard' | 'switch';
  condition: string;
  outcomes: DecisionOutcome[];
}

const NEST_LIMIT = 1; // only top-level and one-deep branches stay legible

function condText(node: ts.Node, sf: ts.SourceFile): string {
  return node.getText(sf).replace(/\s+/g, ' ').trim().slice(0, 40);
}

function nestingDepth(node: ts.Node): number {
  let depth = 0;
  let cur: ts.Node | undefined = node.parent;
  while (cur && !ts.isFunctionLike(cur)) {
    if (ts.isIfStatement(cur) || ts.isForStatement(cur) || ts.isForOfStatement(cur) ||
        ts.isForInStatement(cur) || ts.isWhileStatement(cur) || ts.isSwitchStatement(cur) ||
        ts.isCatchClause(cur)) {
      depth++;
    }
    cur = cur.parent;
  }
  return depth;
}

function enclosingName(node: ts.Node, sf: ts.SourceFile): string | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && cur.name && ts.isIdentifier(cur.name)) return cur.name.text;
    if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
      const parent = cur.parent;
      if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    }
    cur = cur.parent;
  }
  return undefined;
}

/** The exit a guard's then-branch performs, if it is a pure early exit. */
function guardExit(then: ts.Statement): DecisionOutcome | null {
  const stmt = ts.isBlock(then)
    ? then.statements.find(s => ts.isReturnStatement(s) || ts.isThrowStatement(s) || ts.isBreakStatement(s) || ts.isContinueStatement(s))
    : then;
  if (!stmt) return null;
  if (ts.isThrowStatement(stmt)) return { label: 'throws', kind: 'error' };
  if (ts.isReturnStatement(stmt)) return { label: 'returns', kind: 'return' };
  if (ts.isBreakStatement(stmt)) return { label: 'breaks', kind: 'normal' };
  if (ts.isContinueStatement(stmt)) return { label: 'continues', kind: 'normal' };
  return null;
}

function caseLabel(clause: ts.CaseOrDefaultClause, sf: ts.SourceFile): string {
  if (ts.isDefaultClause(clause)) return 'default';
  const expr = clause.expression;
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text.slice(0, 18);
  return expr.getText(sf).replace(/['"]/g, '').slice(0, 18);
}

/**
 * @param changedLines when provided, only branches whose condition sits on a
 *   changed line are returned.
 */
export function detectDecisions(filePath: string, content: string, changedLines?: Set<number>): DecisionSite[] {
  const language = detectLanguage(filePath);
  if (language !== 'typescript' && language !== 'javascript') return [];

  try {
    const kind = /\.tsx$/i.test(filePath) ? ts.ScriptKind.TSX
      : /\.jsx$/i.test(filePath) ? ts.ScriptKind.JSX
        : language === 'javascript' ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, kind);
    const sites: DecisionSite[] = [];

    const visit = (node: ts.Node) => {
      if (sites.length < 8) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const onChange = !changedLines || changedLines.has(line);

        if (ts.isIfStatement(node) && !node.elseStatement && onChange && nestingDepth(node) <= NEST_LIMIT) {
          const exit = guardExit(node.thenStatement);
          if (exit) {
            sites.push({
              file: filePath, line, functionName: enclosingName(node, sf),
              kind: 'guard', condition: condText(node.expression, sf), outcomes: [exit],
            });
          }
        } else if (ts.isSwitchStatement(node) && onChange && nestingDepth(node) <= NEST_LIMIT) {
          const clauses = node.caseBlock.clauses.slice(0, 4);
          const outcomes = clauses.map(c => ({ label: caseLabel(c, sf), kind: 'normal' as const }));
          if (outcomes.length >= 2) {
            sites.push({
              file: filePath, line, functionName: enclosingName(node, sf),
              kind: 'switch', condition: condText(node.expression, sf), outcomes,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return sites;
  } catch {
    return [];
  }
}
