/**
 * Behavioural gap analysis — what the existing function does that the new one
 * doesn't.
 *
 * A similarity percentage is a verdict about the reviewer's *code*; it invites
 * a shrug. A gap list is a statement about the reviewer's *behaviour*:
 *
 *   "slugifyTitle also trims whitespace and collapses repeated dashes
 *    (src/util/text.ts:18). Your version does neither."
 *
 * That is usually the more important finding. When an assistant rewrites a
 * helper it never read, the rewrite tends to cover the happy path and drop the
 * edge cases that were added to the original over months of bug reports.
 *
 * IMPORTANT — what this can and cannot claim.
 *
 * A gap is a *token-level* difference: the original uses a mechanism the
 * rewrite does not. That is NOT the same as a behavioural loss, because the
 * rewrite may achieve the same effect another way. The canonical example is in
 * this engine's own tests: `slugifyTitle` calls `.trim()` and collapses
 * `/-{2,}/g`, while the rewrite splits on `/[^a-z0-9]+/g` and drops empty
 * chunks — which trims and collapses implicitly. Both "gaps" are real token
 * differences and neither is a real bug.
 *
 * So the report is a *hypothesis generator*: it points at the exact places the
 * two implementations diverge and asks the reviewer to confirm coverage. It
 * must never assert that behaviour was lost, and it must not escalate a
 * finding's category on that basis. Proving equivalence needs differential
 * execution, which is a separate capability.
 *
 * Everything here is a set difference over data the detector already computed.
 * No LLM, no extra parsing, no heuristic guessing about intent.
 */

import type { ControlProfile } from './astNormalize';
import type { FunctionFingerprint } from './fingerprint';

export type GapKind =
  | 'missing_pattern'
  | 'missing_call'
  | 'missing_constant'
  | 'missing_error_handling'
  | 'missing_branch'
  | 'missing_await';

export interface BehavioralGap {
  kind: GapKind;
  /** The api token or control dimension this gap came from. */
  token: string;
  /** Reviewer-facing phrasing, already quoted for markdown. */
  description: string;
  /** Line in the *existing* function where the behaviour lives, when known. */
  targetLine?: number;
  /**
   * `notable` gaps are the ones worth a reviewer's attention (a regex, a
   * guard, error handling). `minor` gaps are listed for completeness. Neither
   * is evidence that behaviour was actually lost — see the module header.
   */
  weight: 'notable' | 'minor';
}

export interface BehavioralGapReport {
  /** Behaviour present in the existing function, absent from the new one. */
  missing: BehavioralGap[];
  /** Behaviour the new function adds. Context, never a defect. */
  extra: BehavioralGap[];
  /** Count of `notable` missing gaps — drives how prominently we surface it. */
  notableCount: number;
  /** One-line summary, or empty when the two are behaviourally aligned. */
  summary: string;
}

/** Beyond this the list stops being readable and starts being a wall. */
const MAX_LISTED = 5;

// ── Token phrasing ──────────────────────────────────────────────────────────

/**
 * Calls whose absence genuinely signals dropped behaviour.
 *
 * Note this is deliberately NOT `isDistinctiveToken` from the scorer. Rarity
 * and behavioural meaning are different questions, and `trim` is the example
 * that proves it: it is far too common to help *match* two functions, but
 * dropping it changes the output, so it absolutely belongs in a gap report.
 * Reusing the scorer's predicate here silently hid exactly the gaps most worth
 * showing.
 */
const BEHAVIOURAL_CALLS = new Set([
  'trim', 'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'normalize',
  'replace', 'replaceAll', 'encodeURIComponent', 'decodeURIComponent',
  'escape', 'unescape', 'parse', 'stringify', 'round', 'floor', 'ceil',
  'abs', 'min', 'max', 'isNaN', 'isFinite', 'toFixed', 'padStart', 'padEnd',
]);

/** Structural plumbing — its absence says nothing about behaviour. */
const GENERIC_CALLS = new Set([
  'push', 'pop', 'shift', 'unshift', 'splice', 'slice', 'concat', 'join', 'split',
  'map', 'filter', 'reduce', 'forEach', 'find', 'some', 'every', 'keys', 'values',
  'entries', 'has', 'get', 'set', 'add', 'delete', 'toString', 'valueOf', 'sort',
  'reverse', 'includes', 'indexOf', 'log', 'warn', 'info', 'then', 'catch',
  'String', 'Number', 'Boolean', 'Array', 'Object',
]);

function describeToken(
  token: string,
  isGuard: boolean,
): { kind: GapKind; text: string; weight: 'notable' | 'minor' } | null {
  const separator = token.indexOf(':');
  if (separator < 0) return null;
  const kind = token.slice(0, separator);
  const value = token.slice(separator + 1);

  if (kind === 'lit') {
    if (value.startsWith('re:')) {
      return { kind: 'missing_pattern', text: `applies the pattern \`${value.slice(3)}\``, weight: 'notable' };
    }
    if (value.startsWith('num:')) {
      return isGuard
        ? { kind: 'missing_constant', text: `checks against \`${value.slice(4)}\``, weight: 'notable' }
        : { kind: 'missing_constant', text: `uses the constant \`${value.slice(4)}\``, weight: 'minor' };
    }
    if (value.startsWith('str#')) {
      // Length-bucketed long strings carry no identity worth reporting.
      return null;
    }
    if (value.startsWith('str:')) {
      const literal = value.slice(4);
      if (!literal) return null;
      // A string the target *compares against* is a case it handles; a string
      // it merely emits is configuration. Measured on this repo, treating all
      // string literals as notable escalated 14 pairs whose only "gaps" were
      // payload values (`'gpt-4o-mini'`, `'system'`) and log messages.
      return isGuard
        ? { kind: 'missing_constant', text: `handles the value \`'${literal}'\``, weight: 'notable' }
        : { kind: 'missing_constant', text: `uses the value \`'${literal}'\``, weight: 'minor' };
    }
    return null;
  }

  if (kind === 'call') {
    // Only calls that mean something behaviourally, or that are rare enough to
    // be domain logic, are worth listing. Generic plumbing (`push`, `map`) is
    // just a different route to the same result.
    if (BEHAVIOURAL_CALLS.has(value)) {
      return { kind: 'missing_call', text: `calls \`${value}()\``, weight: 'notable' };
    }
    if (GENERIC_CALLS.has(value)) return null;
    return { kind: 'missing_call', text: `calls \`${value}()\``, weight: 'minor' };
  }

  // Property reads and type references are too weak to present as gaps.
  return null;
}

// ── Report ──────────────────────────────────────────────────────────────────

/**
 * Compare a new function against the existing one it duplicates.
 * `target` is always the pre-existing side.
 */
export function computeBehavioralGaps(
  query: FunctionFingerprint,
  target: FunctionFingerprint,
): BehavioralGapReport {
  const missing: BehavioralGap[] = [];
  const extra: BehavioralGap[] = [];

  for (const token of target.apiTokens.keys()) {
    if (query.apiTokens.has(token)) continue;
    const described = describeToken(token, target.guardLiterals.has(token));
    if (!described) continue;
    missing.push({
      kind: described.kind,
      token,
      description: described.text,
      targetLine: target.evidence.get(token),
      weight: described.weight,
    });
  }

  for (const token of query.apiTokens.keys()) {
    if (target.apiTokens.has(token)) continue;
    const described = describeToken(token, query.guardLiterals.has(token));
    if (!described) continue;
    extra.push({
      kind: described.kind,
      token,
      description: described.text,
      targetLine: query.evidence.get(token),
      weight: 'minor',
    });
  }

  missing.push(...controlFlowGaps(query.control, target.control));

  // Notable first, then whichever carries a line reference — a gap the reader
  // can click is worth more than one they have to hunt for.
  const rank = (g: BehavioralGap) =>
    (g.weight === 'notable' ? 0 : 10) + (g.targetLine ? 0 : 1);
  missing.sort((a, b) => rank(a) - rank(b));
  extra.sort((a, b) => rank(a) - rank(b));

  const notableCount = missing.filter(g => g.weight === 'notable').length;
  return {
    missing: missing.slice(0, MAX_LISTED),
    extra: extra.slice(0, MAX_LISTED),
    notableCount,
    summary: buildSummary(missing, notableCount, target),
  };
}

function controlFlowGaps(query: ControlProfile, target: ControlProfile): BehavioralGap[] {
  const gaps: BehavioralGap[] = [];

  if (target.tryCatch > query.tryCatch) {
    gaps.push({
      kind: 'missing_error_handling',
      token: 'control:tryCatch',
      description: 'wraps its work in error handling',
      weight: 'notable',
    });
  }
  if (target.throws > query.throws) {
    gaps.push({
      kind: 'missing_error_handling',
      token: 'control:throws',
      description: 'raises an error on invalid input',
      weight: 'notable',
    });
  }
  // One extra branch is noise; two or more is a dropped case.
  const branchGap = (target.branches + target.ternaries) - (query.branches + query.ternaries);
  if (branchGap >= 2) {
    gaps.push({
      kind: 'missing_branch',
      token: 'control:branches',
      description: `has ${branchGap} more conditional branches — likely edge cases yours does not cover`,
      weight: 'notable',
    });
  }
  if (target.awaits > 0 && query.awaits === 0) {
    gaps.push({
      kind: 'missing_await',
      token: 'control:awaits',
      description: 'awaits an asynchronous step',
      weight: 'notable',
    });
  }
  return gaps;
}

function buildSummary(
  missing: BehavioralGap[],
  notableCount: number,
  target: FunctionFingerprint,
): string {
  if (!missing.length) return '';
  const notable = missing.filter(g => g.weight === 'notable').slice(0, 3);
  const listed = (notable.length ? notable : missing.slice(0, 2)).map(g => g.description);
  const phrase = joinReadable(listed);
  const lead = `\`${target.name}()\` also ${phrase}`;
  return notableCount >= 2
    ? `${lead}. Your version has no equivalent step — confirm those cases are covered another way before reusing or replacing either one.`
    : `${lead} — confirm your version covers that case.`;
}

function joinReadable(parts: string[]): string {
  if (parts.length <= 1) return parts[0] || '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/** Markdown bullet list for the finding explanation. */
export function formatGapList(report: BehavioralGapReport, targetFile: string): string {
  if (!report.missing.length) return '';
  const lines = report.missing.map(gap => {
    const where = gap.targetLine ? ` (${targetFile}:${gap.targetLine})` : '';
    return `• it ${gap.description}${where}`;
  });
  return lines.join('\n');
}
