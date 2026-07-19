/**
 * Cyclomatic / nesting / LOC heuristics for maintainability.
 * # ponytail: keyword counting, not CFG; good enough for diff-scoped gates.
 */
import type { FileFacts, FunctionFact } from './astFacts';
import type { QualityFinding } from './qualityTypes';

const BRANCH_RE = /\b(if|else if|elif|case|catch|except|for|while|&&|\|\||\?)\b/g;

export function estimateComplexity(body: string): number {
  const matches = body.match(BRANCH_RE);
  return 1 + (matches ? matches.length : 0);
}

export function estimateNesting(body: string): number {
  let max = 0;
  let depth = 0;
  for (const ch of body) {
    if (ch === '{' || ch === ':') {
      // python uses indent; brace languages use {}
    }
    if (ch === '{') { depth++; max = Math.max(max, depth); }
    if (ch === '}') depth = Math.max(0, depth - 1);
  }
  // python fallback: leading spaces
  if (max === 0) {
    for (const line of body.split(/\n/)) {
      const indent = line.match(/^(\s*)/)?.[1].length || 0;
      max = Math.max(max, Math.floor(indent / 2));
    }
  }
  return max;
}

export function scanComplexity(facts: FileFacts[]): QualityFinding[] {
  const findings: QualityFinding[] = [];
  for (const file of facts) {
    for (const fn of file.functions) {
      const complexity = estimateComplexity(fn.body);
      const nesting = estimateNesting(fn.body);
      const loc = fn.body.split(/\n/).length;

      if (complexity >= 15) {
        findings.push(finding(file.path, fn, 'QUALITY_COMPLEXITY', 'complexity', complexity,
          `High cyclomatic complexity (${complexity}) in ${fn.name}`,
          'Split into smaller functions with a single responsibility.',
          complexity >= 25 ? 'high' : 'medium',
          Math.min(90, complexity * 3)));
      }
      if (nesting >= 5) {
        findings.push(finding(file.path, fn, 'QUALITY_NESTING', 'complexity', nesting,
          `Deep nesting (${nesting}) in ${fn.name}`,
          'Flatten with early returns or helper extraction.',
          'medium',
          nesting * 8));
      }
      if (loc >= 80) {
        findings.push(finding(file.path, fn, 'QUALITY_GOD_FUNCTION', 'god_function', loc,
          `Large function ${fn.name} (${loc} lines)`,
          'Extract cohesive helpers; keep functions under ~50 lines.',
          loc >= 150 ? 'high' : 'medium',
          Math.min(120, Math.round(loc / 2))));
      }
    }
  }
  return findings.slice(0, 24);
}

function finding(
  file: string,
  fn: FunctionFact,
  ruleId: string,
  subcategory: QualityFinding['subcategory'],
  metricValue: number,
  title: string,
  suggestedFix: string,
  severity: QualityFinding['severity'],
  debtMinutes: number,
): QualityFinding {
  return {
    id: `${ruleId}:${file}:${fn.startLine}`,
    ruleId,
    subcategory,
    category: 'maintainability',
    severity,
    confidence: 'high',
    title,
    explanation: title,
    file,
    line: fn.startLine,
    endLine: fn.endLine,
    evidence: `complexity/nesting/loc metric=${metricValue}`,
    suggestedFix,
    detectedBy: 'metric',
    blocking: false,
    metricValue,
    debtMinutes,
    language: fn.language,
  };
}

export function summarizeComplexity(facts: FileFacts[]): { maxComplexity: number; avgComplexity: number; maxNesting: number } {
  const values: number[] = [];
  let maxNesting = 0;
  for (const file of facts) {
    for (const fn of file.functions) {
      values.push(estimateComplexity(fn.body));
      maxNesting = Math.max(maxNesting, estimateNesting(fn.body));
    }
  }
  if (!values.length) return { maxComplexity: 0, avgComplexity: 0, maxNesting: 0 };
  return {
    maxComplexity: Math.max(...values),
    avgComplexity: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
    maxNesting,
  };
}
