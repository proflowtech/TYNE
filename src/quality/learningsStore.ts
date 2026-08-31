/**
 * Team learnings — a human-edited, git-committed suppression list.
 *
 * Tyne already has a working per-user suppression mechanism: clicking
 * "Ignore" on a finding calls `rememberDismissedFinding`, which stores the
 * normalized title in `workspaceState` and hard-drops it from every future
 * review. That covers "stop bothering me" for one person on one machine.
 *
 * It does not cover "stop bothering the team" — workspaceState is local,
 * unversioned, and invisible outside the product. A learning like "we
 * intentionally don't use dependency injection in worker scripts" has to be
 * re-taught by every teammate, forever, because nothing carries it across
 * machines or new clones.
 *
 * `.tyne/learnings.md` is the fix: a plain file, reviewed in PRs like any
 * other config, that every teammate's Tyne reads. Everything in this module
 * is pure text parsing — no vscode, no git — so the workspace-facing read and
 * the write-back live in `validateReviewService.ts`, matching the split
 * already established for git blame (`gitManager.ts` vs `priorContext.ts`).
 *
 * Matching has three tiers, deliberately ordered by strength of evidence:
 *
 *   exact  — normalized title equality. Identical to what clicking "Ignore"
 *            already does, so a hand-written learning behaves the same as the
 *            per-user mechanism a team already understands.
 *   scoped — exact title, but only inside a path glob. Lets a learning say
 *            "procedural style is fine *in workers*" without blanket-hiding
 *            that finding across the whole repo.
 *   fuzzy  — concept-token overlap via the same canonicalization the semantic
 *            clone engine uses, so a learning survives the LLM rephrasing a
 *            finding ("Console.log left in code" vs "Debug console.log
 *            statement remains").
 *
 * The fuzzy tier is the risky one: a too-loose suppression silently hides a
 * real bug, which is strictly worse than showing a false positive. It is
 * therefore gated hard (high threshold, category must match, both sides need
 * real concept tokens) and — critically — every suppression at every tier is
 * *recorded and surfaced*, never silently dropped. A suppression you cannot
 * inspect is indistinguishable from a bug.
 *
 * ── House rules ────────────────────────────────────────────────────────────
 *
 * The file has a second, additive half. A `## Require` section holds house
 * rules — conventions the team wants *enforced*, which produce findings
 * instead of hiding them:
 *
 *     ## Require
 *     - Use Result<T,E> instead of throwing (src/core/**)
 *
 * A house rule is natural language, so unlike every other detector in the
 * quality engine it can only be checked by the model. That has a consequence
 * the code must respect everywhere: house-rule findings are *judgment, never
 * verified evidence*. They are capped, never blocking, confidence-limited,
 * and carry provenance back to the exact line of the rule that produced them,
 * so a noisy rule is easy to identify and delete.
 *
 * Bullets that appear before any section heading are suppressions, so files
 * written before house rules existed keep working unchanged.
 */

import { splitIdentifier } from './semantic/astNormalize';

export interface Learning {
  /** Normalized (lowercase, whitespace-collapsed) — the actual match key. */
  title: string;
  /** Optional human-facing reason, preserved for display, never matched on. */
  note?: string;
  /** Optional path glob this learning is limited to, e.g. `src/workers/**`. */
  scope?: string;
  /** Canonicalized concept tokens, for the fuzzy tier. */
  concepts: string[];
  /** 1-based line number in the source file, for pointing an editor at it. */
  sourceLine: number;
}

/**
 * A convention the team wants enforced. `id` is assigned per parse (`HR1`,
 * `HR2`, …) and is what the model echoes back in `ruleId`, so a finding can
 * be traced to the rule and the file line that caused it.
 */
export interface HouseRule {
  id: string;
  text: string;
  scope?: string;
  sourceLine: number;
}

export interface LearningsDocument {
  suppressions: Learning[];
  rules: HouseRule[];
}

export type LearningMatchKind = 'exact' | 'scoped' | 'rule' | 'fuzzy';

export interface LearningMatch {
  learning: Learning;
  kind: LearningMatchKind;
  /** Concept overlap 0-1. Only meaningful for the fuzzy tier. */
  score: number;
}

const BULLET_LINE = /^\s*[-*]\s+(.+)$/;
/** Separates title from an optional trailing reason: `- Title — because X`. */
const NOTE_SEPARATOR = ' — ';
/** Trailing path glob: `- Title — reason (src/workers/**)`. */
const SCOPE_SUFFIX = /\s*\(([^()]*[/*][^()]*)\)\s*$/;

/**
 * Same normalization as `normalizeTitle` in `findingsMerger.ts` and
 * `rememberDismissedFinding` in `validateReviewService.ts`. Duplicated
 * rather than imported: it's a one-line rule with no room to drift, and
 * importing it here would pull a quality-engine module into three unrelated
 * places for a single lowercase-and-trim.
 */
function normalizeLearningTitle(title: unknown): string {
  return String(title || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const HEADING_LINE = /^\s{0,3}#{1,6}\s+(.+?)\s*$/;
/** Headings that switch the parser into the additive half. */
const RULES_HEADING = /^(require|rules|house rules|enforce|conventions)$/i;
/** Headings that switch it back. Anything else is treated as prose. */
const SUPPRESS_HEADING = /^(suppress|suppressions|ignore|known false positives)$/i;

/** Cap on rules sent to the model — a long list dilutes attention and costs tokens. */
export const MAX_HOUSE_RULES = 20;
/** A rule this short cannot be specific enough to check without guessing. */
export const MIN_RULE_LENGTH = 12;

/**
 * Parse the whole file: suppressions and house rules.
 *
 * Section state starts as `suppress`, so a file written before house rules
 * existed — bare bullets, no headings — parses exactly as it always did.
 */
export function parseLearningsDocument(content: string): LearningsDocument {
  const suppressions: Learning[] = [];
  const rules: HouseRule[] = [];
  const lines = String(content || '').split('\n');
  let section: 'suppress' | 'rules' = 'suppress';

  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(HEADING_LINE);
    if (heading) {
      const label = heading[1].trim();
      if (RULES_HEADING.test(label)) { section = 'rules'; }
      else if (SUPPRESS_HEADING.test(label)) { section = 'suppress'; }
      // Any other heading (the file title, prose subheads) leaves state alone.
      continue;
    }

    const match = lines[i].match(BULLET_LINE);
    if (!match) { continue; }
    const body = match[1].trim();
    if (!body) { continue; }

    const scopeMatch = body.match(SCOPE_SUFFIX);
    const scope = scopeMatch ? scopeMatch[1].trim() : undefined;
    const withoutScope = scopeMatch ? body.slice(0, scopeMatch.index).trim() : body;

    if (section === 'rules') {
      // Rules keep their full text — including any " — " which reads as part
      // of the sentence here, not as a separate note field.
      if (withoutScope.length < MIN_RULE_LENGTH) { continue; }
      if (rules.length >= MAX_HOUSE_RULES) { continue; }
      rules.push({
        id: `HR${rules.length + 1}`,
        text: withoutScope,
        scope,
        sourceLine: i + 1,
      });
      continue;
    }

    const sepIndex = withoutScope.indexOf(NOTE_SEPARATOR);
    const rawTitle = sepIndex >= 0 ? withoutScope.slice(0, sepIndex) : withoutScope;
    const note = sepIndex >= 0 ? withoutScope.slice(sepIndex + NOTE_SEPARATOR.length).trim() : undefined;
    const title = normalizeLearningTitle(rawTitle);
    if (!title) { continue; }

    suppressions.push({
      title,
      note: note || undefined,
      scope,
      concepts: conceptTokens(title),
      sourceLine: i + 1,
    });
  }

  return { suppressions, rules };
}

/** House rules only. */
export function parseHouseRules(content: string): HouseRule[] {
  return parseLearningsDocument(content).rules;
}

/** Suppressions only — the original entry point, unchanged for callers. */
export function parseLearningsFile(content: string): Learning[] {
  return parseLearningsDocument(content).suppressions;
}

/** Rules that apply to at least one of the changed files. */
export function rulesForFiles(rules: HouseRule[], files: string[]): HouseRule[] {
  return rules.filter(rule =>
    !rule.scope || files.some(file => matchesScope(file, rule.scope as string)));
}

/** The set of match keys a parsed learnings file suppresses. */
export function learningsToTitleSet(learnings: Learning[]): Set<string> {
  return new Set(learnings.map(l => l.title));
}

// ── Matching ────────────────────────────────────────────────────────────────

/**
 * Words that carry no intent in a finding title. Without this, every finding
 * shares "code", "function", "this" and the fuzzy tier fires on everything.
 */
const CONCEPT_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'that', 'this', 'code', 'file',
  'line', 'lines', 'function', 'method', 'class', 'variable', 'value', 'values',
  'should', 'must', 'may', 'can', 'will', 'not', 'but', 'are', 'was', 'has',
  'have', 'been', 'left', 'used', 'using', 'use', 'new', 'old', 'more', 'less',
  'issue', 'problem', 'potential', 'possible', 'consider', 'avoid', 'missing',
]);

/**
 * Canonical concept tokens for a finding or learning title.
 *
 * Reuses `splitIdentifier` from the semantic clone engine — the same verb
 * lexicon that already collapses `fetchUser`/`retrieveUser`/`loadUser` onto
 * one concept. That machinery was built and calibrated for duplication
 * detection, and "are these two titles about the same thing?" is the identical
 * question, so it is reused rather than re-derived.
 */
export function conceptTokens(title: string): string[] {
  const words = String(title || '')
    .toLowerCase()
    .split(/[^a-z0-9_$.]+/)
    .filter(Boolean);

  const out = new Set<string>();
  for (const word of words) {
    // `splitIdentifier` also splits dotted/camel forms like `console.log`.
    for (const token of splitIdentifier(word)) {
      const key = token.toLowerCase();
      if (key.length < 3 || CONCEPT_STOPWORDS.has(key)) { continue; }
      out.add(token);
    }
  }
  return [...out];
}

/**
 * Containment: what fraction of the *learning's* concepts appear in the
 * finding's.
 *
 * Not Jaccard — measured against real titles, Jaccard scores the motivating
 * case ("Console.log left in code" vs "Debug console.log statement remains")
 * at 0.40, because it penalises the finding for the extra words the LLM added
 * when rephrasing. Rephrasing is exactly the thing this tier exists to
 * survive, so the question is one-directional: does the finding still say
 * everything the learning said?
 */
export function conceptContainment(learningConcepts: string[], findingConcepts: string[]): number {
  if (!learningConcepts.length || !findingConcepts.length) { return 0; }
  const inFinding = new Set(findingConcepts);
  let covered = 0;
  for (const token of new Set(learningConcepts)) {
    if (inFinding.has(token)) { covered++; }
  }
  return covered / new Set(learningConcepts).size;
}

/**
 * Fuzzy-tier gates. All three exist because containment on its own is
 * dangerously permissive: a two-word learning like "missing test" is contained
 * in "missing test for authentication bypass", which would silently bury a
 * security finding.
 *
 *   FUZZY_THRESHOLD      — containment must be near-total, not merely related.
 *   FUZZY_MIN_CONCEPTS   — the *learning* must be specific enough to be worth
 *                          generalising. Short generic learnings stay
 *                          exact-match-only, by design.
 *   NEVER_FUZZY          — categories where silently hiding a finding is never
 *                          an acceptable trade, whatever the score.
 */
export const FUZZY_THRESHOLD = 0.85;
export const FUZZY_MIN_CONCEPTS = 3;
export const NEVER_FUZZY_CATEGORIES = new Set([
  'security', 'compliance', 'breaking_change', 'pm_alignment',
]);

/** Glob match supporting `*` (within a segment) and `**` (across segments). */
export function matchesScope(filePath: string, scope: string): boolean {
  const path = String(filePath || '').replace(/\\/g, '/').toLowerCase().trim();
  const pattern = String(scope || '').replace(/\\/g, '/').toLowerCase().trim();
  if (!path || !pattern) { return false; }

  const regex = pattern
    .split('')
    .reduce((acc, ch, i, arr) => {
      if (ch === '*') {
        if (arr[i - 1] === '*') { return acc; }        // already handled below
        if (arr[i + 1] === '*') { return acc + '.*'; }  // `**` → any depth
        return acc + '[^/]*';                            // `*` → within a segment
      }
      return acc + ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }, '');

  try {
    // A bare directory prefix like `src/workers/**` should also match the
    // directory itself, so anchor loosely at the end.
    return new RegExp(`^${regex}$`).test(path) || new RegExp(`^${regex}`).test(path);
  } catch {
    return false;
  }
}

/**
 * Find the learning that suppresses a finding, strongest tier first.
 * Returns null when nothing matches.
 */
export function matchLearning(
  finding: { title?: string; file?: string; ruleId?: string; category?: string },
  learnings: Learning[],
): LearningMatch | null {
  const title = normalizeLearningTitle(finding.title);
  if (!title) { return null; }
  const file = String(finding.file || '');
  const ruleId = String(finding.ruleId || '').toLowerCase().trim();
  const category = String(finding.category || '').toLowerCase().trim();
  const findingConcepts = conceptTokens(title);

  let fuzzyBest: LearningMatch | null = null;

  for (const learning of learnings) {
    const inScope = !learning.scope || (Boolean(file) && matchesScope(file, learning.scope));

    // Tier 1/2 — exact title. A scoped learning simply does not apply outside
    // its glob; other learnings still get their turn.
    if (learning.title === title) {
      if (!inScope) { continue; }
      return { learning, kind: learning.scope ? 'scoped' : 'exact', score: 1 };
    }

    // Tier 3 — ruleId. Stable across rephrasing, and an exact identifier
    // rather than a text guess, so it carries no fuzzy-tier risk.
    if (ruleId && learning.title === ruleId) {
      if (!inScope) { continue; }
      return { learning, kind: 'rule', score: 1 };
    }

    if (!inScope) { continue; }

    // Tier 4 — fuzzy. Gated hard; see the constants above.
    if (NEVER_FUZZY_CATEGORIES.has(category)) { continue; }
    if (learning.concepts.length < FUZZY_MIN_CONCEPTS) { continue; }
    if (findingConcepts.length < FUZZY_MIN_CONCEPTS) { continue; }
    const score = conceptContainment(learning.concepts, findingConcepts);
    if (score >= FUZZY_THRESHOLD && (!fuzzyBest || score > fuzzyBest.score)) {
      fuzzyBest = { learning, kind: 'fuzzy', score };
    }
  }

  return fuzzyBest;
}

// ── Writing ─────────────────────────────────────────────────────────────────

/** One line, matching the parse format. `title` is kept human-readable — only the parser normalizes. */
export function formatLearningEntry(title: string, note?: string, scope?: string): string {
  const cleanTitle = String(title || '').trim();
  const cleanNote = note ? String(note).trim() : '';
  const cleanScope = scope ? String(scope).trim() : '';
  const base = cleanNote ? `- ${cleanTitle}${NOTE_SEPARATOR}${cleanNote}` : `- ${cleanTitle}`;
  return cleanScope ? `${base} (${cleanScope})` : base;
}

const DEFAULT_HEADER = [
  '# Tyne Learnings',
  '',
  'Team-maintained suppressions — reviewed in pull requests like any other config.',
  'Each bullet is: exact finding title, optionally " — " a reason, optionally a',
  'trailing path glob in parentheses to limit where it applies.',
  '',
  'Matching, strongest first: exact title, exact title within the glob, exact',
  'ruleId, then a conservative concept match for longer titles so a learning',
  'survives the model rephrasing a finding. Security, compliance, breaking-change',
  'and scope findings are never suppressed by the concept match — those require',
  'an exact title.',
  '',
  'Everything suppressed here still appears in the review under "hidden by team',
  'learnings", with the learning that hid it.',
  '',
  '(Every line below this point that starts with "-" is a live entry — do not',
  'add example or placeholder bullets, only real ones.)',
].join('\n');

/**
 * Add one learning to an existing file's content, idempotently.
 *
 * Idempotent because the natural caller is "the user clicked Ignore" — if two
 * teammates independently dismiss the same finding, the second write must be
 * a no-op, not a duplicate bullet that silently grows on every dismissal.
 */
export function appendLearning(
  content: string,
  title: string,
  note?: string,
  scope?: string,
): { content: string; added: boolean } {
  const normalizedNew = normalizeLearningTitle(title);
  if (!normalizedNew) { return { content, added: false }; }

  const existing = parseLearningsFile(content);
  if (existing.some(entry => entry.title === normalizedNew && (entry.scope || '') === (scope || ''))) {
    return { content, added: false };
  }

  const bullet = formatLearningEntry(title, note, scope);
  const base = content.trim() ? content.trimEnd() : DEFAULT_HEADER;
  return { content: `${base}\n${bullet}\n`, added: true };
}

/**
 * Add a house rule under a `## Require` section, creating the section if the
 * file does not have one yet. Idempotent on the rule text.
 */
export function appendHouseRule(
  content: string,
  text: string,
  scope?: string,
): { content: string; added: boolean } {
  const clean = String(text || '').trim();
  if (clean.length < MIN_RULE_LENGTH) { return { content, added: false }; }

  const existing = parseHouseRules(content);
  const key = clean.toLowerCase().replace(/\s+/g, ' ');
  if (existing.some(r => r.text.toLowerCase().replace(/\s+/g, ' ') === key && (r.scope || '') === (scope || ''))) {
    return { content, added: false };
  }

  const bullet = scope ? `- ${clean} (${scope})` : `- ${clean}`;
  const base = content.trim() ? content.trimEnd() : DEFAULT_HEADER;

  // Append under an existing Require section when there is one, so rules stay
  // grouped rather than scattered through the file.
  const lines = base.split('\n');
  let insertAt = -1;
  let inRules = false;
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(HEADING_LINE);
    if (heading) {
      if (RULES_HEADING.test(heading[1].trim())) { inRules = true; insertAt = i; continue; }
      if (inRules) { break; }
      inRules = false;
      continue;
    }
    if (inRules && lines[i].trim()) { insertAt = i; }
  }

  if (insertAt >= 0) {
    lines.splice(insertAt + 1, 0, bullet);
    return { content: `${lines.join('\n')}\n`, added: true };
  }
  return { content: `${base}\n\n## Require\n${bullet}\n`, added: true };
}

/**
 * Remove one learning by its match key, leaving the rest of the file — header,
 * comments, ordering — byte-identical.
 *
 * The counterpart to `appendLearning`, and the thing that makes the
 * "Checked but not shown" panel actionable rather than read-only. Deleting the
 * exact line rather than rewriting the file matters: the file is a
 * human-edited, PR-reviewed artefact, so a removal should produce a one-line
 * diff a reviewer can approve at a glance.
 *
 * `scope` must match too, so removing an unscoped learning never silently
 * deletes a narrower, deliberately-scoped one with the same title.
 */
export function removeLearning(
  content: string,
  title: string,
  scope?: string,
): { content: string; removed: boolean } {
  const target = normalizeLearningTitle(title);
  if (!target) { return { content, removed: false }; }

  const match = parseLearningsFile(content).find(
    entry => entry.title === target && (entry.scope || '') === (scope || ''),
  );
  if (!match) { return { content, removed: false }; }

  const lines = String(content || '').split('\n');
  lines.splice(match.sourceLine - 1, 1);
  return { content: lines.join('\n'), removed: true };
}
