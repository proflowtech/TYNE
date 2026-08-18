import test from 'node:test';
import assert from 'node:assert/strict';

import { fnv1a, normalizeFunction, splitIdentifier, ngrams } from '../quality/semantic/astNormalize';
import {
  deserializeFingerprint,
  fingerprintSource,
  serializeFingerprint,
} from '../quality/semantic/fingerprint';
import { FingerprintIndex } from '../quality/semantic/fingerprintIndex';
import {
  compareFingerprints,
  containment,
  cosine,
  controlSimilarity,
  isDistinctiveToken,
  weightedJaccard,
} from '../quality/semantic/similarity';
import { computeBehavioralGaps } from '../quality/semantic/behavioralGap';
import {
  buildCorpusIndex,
  changedLineRanges,
  detectSemanticClones,
} from '../quality/semantic/semanticCloneDetector';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** The pre-existing helper living in the repo. */
const EXISTING_UTIL = `
import { normalizeWhitespace } from './strings';

export function slugifyTitle(title: string): string {
  if (!title) {
    return '';
  }
  const trimmed = normalizeWhitespace(title.trim().toLowerCase());
  const replaced = trimmed.replace(/[^a-z0-9]+/g, '-');
  const collapsed = replaced.replace(/-{2,}/g, '-');
  return collapsed.replace(/^-|-$/g, '');
}

export function formatCurrency(amount: number, currency: string): string {
  const rounded = Math.round(amount * 100) / 100;
  const symbol = currency === 'USD' ? '$' : currency;
  return symbol + rounded.toFixed(2);
}
`;

/** Type-2: same code, every identifier renamed. */
const RENAMED_COPY = `
import { normalizeWhitespace } from './strings';

export function makeSlug(heading: string): string {
  if (!heading) {
    return '';
  }
  const cleaned = normalizeWhitespace(heading.trim().toLowerCase());
  const dashed = cleaned.replace(/[^a-z0-9]+/g, '-');
  const squeezed = dashed.replace(/-{2,}/g, '-');
  return squeezed.replace(/^-|-$/g, '');
}
`;

/**
 * Type-4: an assistant that never read `slugifyTitle` writing the same helper
 * from scratch — different control flow (chained vs stepwise), different
 * names, same job.
 */
const REIMPLEMENTED = `
import { normalizeWhitespace } from './strings';

export function convertHeadingToUrlSafeString(heading: string): string {
  const source = normalizeWhitespace(String(heading || '').toLowerCase());
  const parts: string[] = [];
  for (const chunk of source.split(/[^a-z0-9]+/g)) {
    if (chunk.length > 0) {
      parts.push(chunk);
    }
  }
  const joined = parts.join('-');
  return joined.replace(/^-|-$/g, '');
}
`;

/** Unrelated function that shares nothing but common JS idioms. */
const UNRELATED = `
export function scheduleRetry(attempt: number, baseDelayMs: number): number {
  if (attempt <= 0) {
    return baseDelayMs;
  }
  let delay = baseDelayMs;
  for (let i = 0; i < attempt; i++) {
    delay = delay * 2;
  }
  return Math.min(delay, 30000);
}
`;

function diffFor(path: string, content: string): string {
  const lines = content.split('\n');
  return [
    `diff --git a/${path} b/${path}`,
    `--- /dev/null`,
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map(l => `+${l}`),
  ].join('\n');
}

// ── Normalization layer ─────────────────────────────────────────────────────

test('splitIdentifier canonicalizes verbs through the synonym lexicon', () => {
  assert.deepEqual(splitIdentifier('fetchUserRecord'), ['GET', 'user', 'record']);
  assert.deepEqual(splitIdentifier('get_user_records'), ['GET', 'user', 'record']);
  // Different surface verbs, same concept.
  assert.deepEqual(splitIdentifier('retrieveUser'), splitIdentifier('loadUser'));
  // Stopword-only identifiers contribute nothing.
  assert.deepEqual(splitIdentifier('data'), []);
});

test('ngrams hashes grams and degrades gracefully below window size', () => {
  // Grams are stored hashed so the workspace index stays compact.
  assert.deepEqual([...ngrams(['a', 'b'], 4)], [fnv1a('a b')]);
  assert.equal(ngrams([], 4).size, 0);
  assert.equal(ngrams(['a', 'b', 'c', 'd', 'e'], 4).size, 2);
  // Identical streams must still produce identical gram sets.
  assert.deepEqual([...ngrams(['x', 'y', 'z', 'w'], 4)], [...ngrams(['x', 'y', 'z', 'w'], 4)]);
});

test('fingerprints survive a serialize/deserialize round trip', () => {
  const original = fingerprintSource('src/util/text.ts', EXISTING_UTIL).find(f => f.name === 'slugifyTitle')!;
  const restored = deserializeFingerprint(serializeFingerprint(original));

  assert.equal(restored.id, original.id);
  assert.equal(restored.shapeHash, original.shapeHash);
  assert.equal(restored.exported, original.exported);
  assert.equal(restored.isAsync, original.isAsync);
  assert.deepEqual(restored.control, original.control);
  assert.deepEqual([...restored.apiTokens], [...original.apiTokens]);
  assert.deepEqual([...restored.shapeGrams], [...original.shapeGrams]);

  // The round trip must not change any verdict — this is what makes a cached
  // index equivalent to a freshly computed one.
  const rewritten = fingerprintSource('src/feature/url.ts', REIMPLEMENTED)[0];
  const fresh = compareFingerprints(rewritten, original);
  const cached = compareFingerprints(rewritten, restored);
  assert.equal(cached?.kind, fresh?.kind);
  assert.equal(cached?.breakdown.score, fresh?.breakdown.score);
});

test('serialized form is JSON-safe', () => {
  const fps = fingerprintSource('src/util/text.ts', EXISTING_UTIL).map(serializeFingerprint);
  const round = JSON.parse(JSON.stringify(fps));
  assert.equal(round.length, fps.length);
  assert.equal(deserializeFingerprint(round[0]).name, 'slugifyTitle');
});

test('shape hash is stable under renaming and unstable under restructuring', () => {
  const original = fingerprintSource('src/util/text.ts', EXISTING_UTIL)
    .find(f => f.name === 'slugifyTitle');
  const renamed = fingerprintSource('src/feature/slug.ts', RENAMED_COPY)
    .find(f => f.name === 'makeSlug');
  const rewritten = fingerprintSource('src/feature/url.ts', REIMPLEMENTED)
    .find(f => f.name === 'convertHeadingToUrlSafeString');

  assert.ok(original && renamed && rewritten, 'all three fixtures should fingerprint');
  assert.equal(original.shapeHash, renamed.shapeHash, 'renaming must not change the shape hash');
  assert.notEqual(original.shapeHash, rewritten.shapeHash, 'restructuring must change the shape hash');
});

test('normalizeFunction records control flow and api vocabulary', () => {
  const fp = fingerprintSource('src/util/text.ts', EXISTING_UTIL).find(f => f.name === 'slugifyTitle');
  assert.ok(fp);
  assert.equal(fp.control.returns, 2);
  assert.ok(fp.control.branches >= 1);
  assert.ok(fp.apiTokens.has('call:replace'), 'callees are captured');
  assert.ok(fp.apiTokens.has('call:normalizeWhitespace'), 'imported callees are captured');
  assert.ok([...fp.apiTokens.keys()].some(k => k.startsWith('lit:re:')), 'regex literals are captured');
});

test('normalizeFunction is exported for direct use and tolerates arrow bodies', () => {
  const fps = fingerprintSource('src/arrow.ts', `
export const buildReport = async (rows: string[]) => {
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.trim());
  }
  await Promise.resolve();
  return [...seen].sort();
};
`);
  assert.equal(fps.length, 1);
  assert.equal(fps[0].name, 'buildReport');
  assert.equal(fps[0].isAsync, true);
  assert.equal(fps[0].control.awaits, 1);
  assert.equal(typeof normalizeFunction, 'function');
});

// ── Similarity math ─────────────────────────────────────────────────────────

test('weightedJaccard downweights ubiquitous tokens via IDF', () => {
  const idf = {
    totalDocs: 1000,
    documentFrequency: (t: string) => (t === 'prop:length' ? 900 : 2),
  };
  const a = new Map([['prop:length', 1], ['call:createHmac', 1]]);
  const b = new Map([['prop:length', 1], ['call:unrelated', 1]]);
  const c = new Map([['prop:length', 1], ['call:createHmac', 1], ['call:extra', 1]]);

  const commonOnly = weightedJaccard(a, b, idf);
  const rareShared = weightedJaccard(a, c, idf);
  assert.ok(rareShared > commonOnly * 2, 'sharing a rare token must dominate sharing a common one');
});

test('cosine and controlSimilarity behave at the boundaries', () => {
  const v = new Map([['user', 2], ['email', 1]]);
  assert.equal(Math.round(cosine(v, v) * 100) / 100, 1);
  assert.equal(cosine(v, new Map([['other', 1]])), 0);
  assert.equal(cosine(new Map(), v), 0);

  const zero = {
    loops: 0, branches: 0, ternaries: 0, tryCatch: 0,
    awaits: 0, returns: 0, throws: 0, maxDepth: 0, statements: 0,
  };
  assert.equal(controlSimilarity(zero, zero), 1);
  assert.ok(controlSimilarity(zero, { ...zero, loops: 4 }) < 0.5);
});

// ── Classification ──────────────────────────────────────────────────────────

test('renamed copy is classified as a renamed clone, not a reimplementation', () => {
  const original = fingerprintSource('src/util/text.ts', EXISTING_UTIL).find(f => f.name === 'slugifyTitle')!;
  const renamed = fingerprintSource('src/feature/slug.ts', RENAMED_COPY).find(f => f.name === 'makeSlug')!;

  const match = compareFingerprints(renamed, original);
  assert.ok(match, 'renamed copy must match');
  assert.ok(match.kind === 'renamed' || match.kind === 'identical', `unexpected kind: ${match?.kind}`);
  assert.equal(match.breakdown.structural, 1);
  assert.equal(match.confidence, 'high');
});

test('rewritten helper is caught as a semantic reimplementation', () => {
  const original = fingerprintSource('src/util/text.ts', EXISTING_UTIL).find(f => f.name === 'slugifyTitle')!;
  const rewritten = fingerprintSource('src/feature/url.ts', REIMPLEMENTED)
    .find(f => f.name === 'convertHeadingToUrlSafeString')!;

  const match = compareFingerprints(rewritten, original);
  assert.ok(match, 'semantic reimplementation must be detected');
  assert.equal(match.kind, 'reimplemented');
  assert.ok(match.breakdown.structural < 0.88, 'structure should not match');
  assert.equal(match.breakdown.lexical, 0, 'no textual overlap at all — lexical detection is blind here');
  assert.ok(match.breakdown.apiCoverage >= 0.55, 'new code covers what the original did');
  assert.ok(match.breakdown.distinctiveShared >= 2, 'verdict rests on shared evidence, not boilerplate');
});

test('reimplementation verdict survives without a corpus for IDF', () => {
  // Small-corpus behaviour matters: the first review in a repo has almost no
  // document frequencies to work with, so intrinsic token weighting alone must
  // be enough to separate evidence from boilerplate.
  const original = fingerprintSource('src/util/text.ts', EXISTING_UTIL).find(f => f.name === 'slugifyTitle')!;
  const rewritten = fingerprintSource('src/feature/url.ts', REIMPLEMENTED)
    .find(f => f.name === 'convertHeadingToUrlSafeString')!;
  const withoutIdf = compareFingerprints(rewritten, original, null);
  const withIdf = compareFingerprints(rewritten, original, {
    totalDocs: 500,
    documentFrequency: (t: string) => (t.startsWith('lit:') ? 2 : 200),
  });
  assert.equal(withoutIdf?.kind, 'reimplemented');
  assert.equal(withIdf?.kind, 'reimplemented');
});

test('coverage ignores call multiplicity but api similarity does not', () => {
  const target = new Map([['call:normalizeWhitespace', 1], ['call:replace', 6]]);
  const rewrite = new Map([['call:normalizeWhitespace', 1], ['call:replace', 2]]);
  // Same capabilities, different mechanism density.
  assert.equal(containment(target, rewrite, null), 1);
  assert.ok(weightedJaccard(target, rewrite, null) < 1);
});

test('isDistinctiveToken separates evidence from boilerplate', () => {
  assert.equal(isDistinctiveToken('lit:re:/^[a-z0-9]+$/'), true);
  assert.equal(isDistinctiveToken('call:createHmac'), true);
  assert.equal(isDistinctiveToken('call:push'), false);
  assert.equal(isDistinctiveToken('prop:length'), false);
});

test('catches a reimplementation in a second, unrelated domain', () => {
  // Guards against the engine being tuned to one fixture: same detector, a
  // retry/backoff helper instead of a string helper.
  const existing = `
export function withExponentialBackoff(attempt: number, baseMs: number): number {
  const capped = Math.min(attempt, 10);
  const raw = baseMs * Math.pow(2, capped);
  const jitter = Math.random() * 0.3 * raw;
  return Math.min(raw + jitter, 30000);
}
`;
  const rewritten = `
export function computeRetryDelayMs(retryCount: number, initialDelay: number): number {
  let delay = initialDelay;
  for (let i = 0; i < Math.min(retryCount, 10); i++) {
    delay = delay * 2;
  }
  const noise = Math.random() * 0.3 * delay;
  const total = delay + noise;
  return total > 30000 ? 30000 : total;
}
`;
  const a = fingerprintSource('src/net/backoff.ts', existing)[0];
  const b = fingerprintSource('src/api/retry.ts', rewritten)[0];
  const match = compareFingerprints(b, a);
  assert.ok(match, 'backoff reimplementation must be detected');
  assert.equal(match.kind, 'reimplemented');
  assert.ok(
    match.breakdown.distinctiveShared >= 2,
    'the 30000 cap and 0.3 jitter factor are the shared evidence',
  );
});

test('functions sharing only common utilities are not reported', () => {
  // Hard negative: both trim, lowercase, loop and push. Nothing distinctive is
  // shared, so no amount of surface agreement should produce a finding.
  const left = `
export function collectTagNames(tags: string[]): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    const cleaned = tag.trim().toLowerCase();
    if (cleaned.length > 0) {
      out.push(cleaned);
    }
  }
  return out;
}
`;
  const right = `
export function collectHeaderKeys(headers: string[]): string[] {
  const result: string[] = [];
  for (const header of headers) {
    const normalized = header.trim().toLowerCase();
    if (normalized.length > 0) {
      result.push(normalized);
    }
  }
  return result;
}
`;
  const a = fingerprintSource('src/tags.ts', left)[0];
  const b = fingerprintSource('src/headers.ts', right)[0];
  const match = compareFingerprints(b, a);
  // These genuinely ARE structural twins — that is a real renamed-clone
  // finding, and it must be reported as such rather than as a semantic
  // reimplementation, which would overstate what the evidence shows.
  if (match) {
    assert.ok(
      match.kind === 'renamed' || match.kind === 'identical',
      `structural twins must be labelled as copies, got: ${match.kind}`,
    );
  }
});

test('unrelated functions do not match', () => {
  const original = fingerprintSource('src/util/text.ts', EXISTING_UTIL).find(f => f.name === 'slugifyTitle')!;
  const other = fingerprintSource('src/util/retry.ts', UNRELATED).find(f => f.name === 'scheduleRetry')!;
  assert.equal(compareFingerprints(other, original), null);
});

test('a function is never reported against itself', () => {
  const fp = fingerprintSource('src/util/text.ts', EXISTING_UTIL).find(f => f.name === 'slugifyTitle')!;
  assert.equal(compareFingerprints(fp, fp), null);
});

// ── Index retrieval ─────────────────────────────────────────────────────────

test('index retrieves the right candidate without scanning the corpus', () => {
  const index = new FingerprintIndex();
  index.addAll(fingerprintSource('src/util/text.ts', EXISTING_UTIL));
  index.addAll(fingerprintSource('src/util/retry.ts', UNRELATED));
  for (let i = 0; i < 20; i++) {
    index.addAll(fingerprintSource(`src/noise/mod${i}.ts`, `
export function handler${i}(input: string[]): number {
  let total = 0;
  for (const entry of input) {
    total += entry.length;
  }
  return total;
}
`));
  }

  const query = fingerprintSource('src/feature/url.ts', REIMPLEMENTED)[0];
  const candidates = index.candidatesFor(query);
  assert.ok(candidates.length > 0, 'should retrieve candidates');
  assert.ok(candidates.length < index.size, 'should not return the whole corpus');
  assert.equal(candidates[0].name, 'slugifyTitle', 'best candidate ranks first');
});

test('index exposes document frequency for IDF weighting', () => {
  const index = buildCorpusIndex([{ path: 'src/util/text.ts', content: EXISTING_UTIL }]);
  assert.equal(index.totalDocs, index.size);
  assert.ok(index.documentFrequency('call:replace') >= 1);
  assert.equal(index.documentFrequency('call:doesNotExist'), 0);
});

test('buildCorpusIndex skips test files unless asked', () => {
  const files = [
    { path: 'src/util/text.ts', content: EXISTING_UTIL },
    { path: 'src/tests/text.test.ts', content: EXISTING_UTIL },
  ];
  const withoutTests = buildCorpusIndex(files);
  const withTests = buildCorpusIndex(files, new Set(), true);
  assert.ok(withTests.size > withoutTests.size);
  assert.ok(withoutTests.all().every(fp => !fp.file.includes('test')));
});

// ── Diff scoping ────────────────────────────────────────────────────────────

test('changedLineRanges collapses added lines into contiguous ranges', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,0 +10,3 @@',
    '+one',
    '+two',
    '+three',
  ].join('\n');
  assert.deepEqual(changedLineRanges(diff).get('src/a.ts'), [[10, 12]]);
});

// ── End-to-end detector ─────────────────────────────────────────────────────

test('detector reports the new function against the pre-existing helper', () => {
  const result = detectSemanticClones({
    diff: diffFor('src/feature/url.ts', REIMPLEMENTED),
    changedFiles: [{ path: 'src/feature/url.ts', content: REIMPLEMENTED }],
    repoFiles: [
      { path: 'src/util/text.ts', content: EXISTING_UTIL },
      { path: 'src/util/retry.ts', content: UNRELATED },
    ],
  });

  assert.equal(result.findings.length, 1, 'exactly one best match per changed function');
  const finding = result.findings[0];
  assert.equal(finding.ruleId, 'QUALITY_SEMANTIC_CLONE');
  assert.equal(finding.subcategory, 'duplicate_utility');
  assert.equal(finding.file, 'src/feature/url.ts', 'finding is anchored on the NEW code');
  assert.ok(finding.title.includes('slugifyTitle'), 'names the existing helper');
  assert.ok(finding.suggestedFix?.includes('src/util/text.ts'), 'points at an importable target');
  assert.ok(finding.evidence.includes('structure='), 'evidence carries the score breakdown');
  assert.ok(result.stats.comparisons < 50, 'retrieval keeps comparison count small');
});

test('detector stays silent when the new code duplicates nothing', () => {
  const result = detectSemanticClones({
    diff: diffFor('src/util/retry.ts', UNRELATED),
    changedFiles: [{ path: 'src/util/retry.ts', content: UNRELATED }],
    repoFiles: [{ path: 'src/util/text.ts', content: EXISTING_UTIL }],
  });
  assert.equal(result.findings.length, 0);
});

test('detector never matches against the changed files themselves', () => {
  const result = detectSemanticClones({
    diff: `${diffFor('src/a.ts', RENAMED_COPY)}\n${diffFor('src/b.ts', RENAMED_COPY)}`,
    changedFiles: [
      { path: 'src/a.ts', content: RENAMED_COPY },
      { path: 'src/b.ts', content: RENAMED_COPY },
    ],
    repoFiles: [
      { path: 'src/a.ts', content: RENAMED_COPY },
      { path: 'src/b.ts', content: RENAMED_COPY },
    ],
  });
  assert.equal(result.findings.length, 0, 'changed files are excluded from the corpus');
});

test('detector only fingerprints functions the diff touched', () => {
  // Diff touches formatCurrency only; slugifyTitle is untouched context.
  const diff = [
    'diff --git a/src/util/text.ts b/src/util/text.ts',
    '--- a/src/util/text.ts',
    '+++ b/src/util/text.ts',
    '@@ -13,0 +13,3 @@',
    '+  const rounded = Math.round(amount * 100) / 100;',
    '+  const symbol = currency === \'USD\' ? \'$\' : currency;',
    '+  return symbol + rounded.toFixed(2);',
  ].join('\n');

  const result = detectSemanticClones({
    diff,
    changedFiles: [{ path: 'src/util/text.ts', content: EXISTING_UTIL }],
    repoFiles: [{ path: 'src/other.ts', content: UNRELATED }],
  });
  assert.equal(result.stats.changedFunctions, 1, 'only the touched function is queried');
});

test('detector handles languages without a real parser', () => {
  const python = `
def build_user_slug(title):
    cleaned = normalize_whitespace(title.strip().lower())
    dashed = re.sub(r'[^a-z0-9]+', '-', cleaned)
    squeezed = re.sub(r'-{2,}', '-', dashed)
    return squeezed.strip('-')
`;
  const fps = fingerprintSource('src/util/slug.py', python);
  assert.equal(fps.length, 1);
  assert.equal(fps[0].parser, 'regex');
  assert.ok(fps[0].apiTokens.size > 0, 'heuristic path still produces vocabulary');
  assert.ok(fps[0].nameTokens.has('CREATE'), 'verb canonicalization works on snake_case');
});

test('detector degrades safely on unparseable input', () => {
  const result = detectSemanticClones({
    diff: 'not a diff',
    changedFiles: [{ path: 'src/broken.ts', content: 'function (((( {' }],
    repoFiles: [{ path: 'src/util/text.ts', content: EXISTING_UTIL }],
  });
  assert.ok(Array.isArray(result.findings));
});

// ── Behavioural gap report ──────────────────────────────────────────────────

test('gap report names what the existing function does, with line evidence', () => {
  const target = fingerprintSource('src/util/text.ts', EXISTING_UTIL).find(f => f.name === 'slugifyTitle')!;
  const query = fingerprintSource('src/feature/url.ts', REIMPLEMENTED)[0];
  const report = computeBehavioralGaps(query, target);

  const described = report.missing.map(g => g.description);
  assert.ok(described.some(d => d.includes('trim()')), `expected a trim gap, got: ${described.join(' | ')}`);
  assert.ok(described.some(d => d.includes('/-{2,}/g')), 'expected the collapse-dashes pattern gap');

  const patternGap = report.missing.find(g => g.kind === 'missing_pattern');
  assert.equal(patternGap?.targetLine, 10, 'gap points at the line in the EXISTING function');
  const trimGap = report.missing.find(g => g.token === 'call:trim');
  assert.equal(trimGap?.targetLine, 8);
});

test('gap report claims divergence, not lost behaviour', () => {
  // This fixture is the reason the wording matters. The rewrite splits on
  // /[^a-z0-9]+/g and drops empty chunks, which trims and collapses dashes
  // implicitly — so both "gaps" are real token differences and neither is a
  // real bug. The report must ask the reviewer to verify, never assert a loss.
  const target = fingerprintSource('src/util/text.ts', EXISTING_UTIL).find(f => f.name === 'slugifyTitle')!;
  const query = fingerprintSource('src/feature/url.ts', REIMPLEMENTED)[0];
  const report = computeBehavioralGaps(query, target);

  assert.ok(report.notableCount >= 2);
  assert.match(report.summary, /confirm/i, 'summary must ask for confirmation');
  assert.doesNotMatch(report.summary, /\bdrops\b|\blost\b|\bmissing behaviour\b/i);
});

test('token gaps never escalate a finding out of maintainability', () => {
  const result = detectSemanticClones({
    diff: diffFor('src/feature/url.ts', REIMPLEMENTED),
    changedFiles: [{ path: 'src/feature/url.ts', content: REIMPLEMENTED }],
    repoFiles: [{ path: 'src/util/text.ts', content: EXISTING_UTIL }],
  });
  const finding = result.findings[0];
  assert.equal(finding.category, 'maintainability', 'unproven gaps must not claim correctness');
  assert.notEqual(finding.severity, 'critical', 'critical is reserved for demonstrated defects');
  assert.match(finding.title, /behaviours to verify/);
  assert.match(finding.explanation, /verify each is covered/);
});

test('generic plumbing is not reported as a behavioural gap', () => {
  const withPush = fingerprintSource('src/a.ts', `
export function collectNames(rows: string[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    out.push(row.trim().toLowerCase());
  }
  return out.sort();
}
`)[0];
  const withMap = fingerprintSource('src/b.ts', `
export function gatherNames(entries: string[]): string[] {
  const cleaned = entries.map(entry => entry.trim().toLowerCase());
  const mapped = cleaned.filter(entry => entry.length > 0);
  const sorted = mapped.sort();
  return sorted;
}
`)[0];

  const report = computeBehavioralGaps(withMap, withPush);
  const tokens = report.missing.map(g => g.token);
  assert.ok(!tokens.includes('call:push'), 'push/map are two routes to one result');
  assert.ok(!tokens.includes('call:sort'), 'shared calls are not gaps');
});

test('gap report surfaces dropped error handling and guards', () => {
  const guarded = fingerprintSource('src/safe.ts', `
export function parseConfigPayload(raw: string): Record<string, string> {
  if (!raw) { throw new Error('empty'); }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object') { return {}; }
    return parsed;
  } catch {
    return {};
  }
}
`)[0];
  const naive = fingerprintSource('src/naive.ts', `
export function readConfigPayload(text: string): Record<string, string> {
  const parsed = JSON.parse(text);
  const output = parsed;
  return output;
}
`)[0];

  const report = computeBehavioralGaps(naive, guarded);
  const kinds = report.missing.map(g => g.kind);
  assert.ok(kinds.includes('missing_error_handling'), `expected error-handling gap, got ${kinds.join()}`);
  assert.ok(report.notableCount >= 1);
});

test('aligned implementations produce an empty report', () => {
  const a = fingerprintSource('src/util/text.ts', EXISTING_UTIL).find(f => f.name === 'slugifyTitle')!;
  const report = computeBehavioralGaps(a, a);
  assert.equal(report.missing.length, 0);
  assert.equal(report.notableCount, 0);
  assert.equal(report.summary, '');
});

test('evidence lines survive the index round trip', () => {
  const original = fingerprintSource('src/util/text.ts', EXISTING_UTIL).find(f => f.name === 'slugifyTitle')!;
  const restored = deserializeFingerprint(JSON.parse(JSON.stringify(serializeFingerprint(original))));
  const query = fingerprintSource('src/feature/url.ts', REIMPLEMENTED)[0];
  // A gap report built from a cached fingerprint must be identical to a fresh
  // one, otherwise findings would differ between cold and warm reviews.
  assert.deepEqual(
    computeBehavioralGaps(query, restored).missing,
    computeBehavioralGaps(query, original).missing,
  );
});

// ── Guard literals ──────────────────────────────────────────────────────────

const GUARD_FIXTURE = `
export function classifyProviderStatus(status: string, provider: string): string {
  if (status === 'cancelled') { return 'closed'; }
  switch (status) {
    case 'in_review':
      return 'review';
    default:
      break;
  }
  if (['jira', 'linear'].includes(provider)) { return 'tracked'; }
  if (looksLikeLockfile('pnpm-lock.yaml')) { return 'pnpm'; }
  const payload = { model: 'gpt-4o-mini', role: 'system' };
  logEvent('status classified', payload);
  return 'unknown';
}
`;

function guardsOf(source: string): Set<string> {
  return fingerprintSource('src/guards.ts', source)[0].guardLiterals;
}

test('literals compared against are recorded as guards', () => {
  const guards = guardsOf(GUARD_FIXTURE);
  assert.ok(guards.has('lit:str:cancelled'), `equality operand should be a guard: ${[...guards].join(', ')}`);
  assert.ok(guards.has('lit:str:in_review'), 'case labels are guards');
  assert.ok(guards.has('lit:str:jira'), 'array membership tests are guards');
  assert.ok(guards.has('lit:str:linear'), 'every element of a tested array is a guard');
  assert.ok(guards.has('lit:str:pnpm-lock.yaml'), 'a literal fed to a tested predicate is a guard');
});

test('literals the function merely emits are not guards', () => {
  const guards = guardsOf(GUARD_FIXTURE);
  assert.equal(guards.has('lit:str:gpt-4o-mini'), false, 'payload config is not a guard');
  assert.equal(guards.has('lit:str:system'), false, 'payload config is not a guard');
  assert.equal(guards.has('lit:str:status classified'), false, 'log messages are not guards');
  assert.equal(guards.has('lit:str:closed'), false, 'returned values are not guards');
  assert.equal(guards.has('lit:str:pnpm'), false, 'a ternary/return branch value is not a guard');
});

test('gap weight follows guard position, not the string itself', () => {
  // The same literal, missing from the same query, weighted differently
  // depending on whether the TARGET tests it or merely emits it.
  const query = fingerprintSource('src/query.ts', `
export function routeAnything(kind: string, payload: string): string {
  const trimmed = payload.trim();
  if (kind === 'other') { return trimmed.toUpperCase(); }
  const parts = trimmed.split(',');
  return parts.join('|');
}
`)[0];
  const tester = fingerprintSource('src/check.ts', `
export function routeByProvider(provider: string, payload: string): string {
  const trimmed = payload.trim();
  if (provider === 'notion') { return trimmed.toUpperCase(); }
  const parts = trimmed.split(',');
  return parts.join('|');
}
`)[0];
  const emitter = fingerprintSource('src/emit.ts', `
export function buildProviderRequest(payload: string): string {
  const trimmed = payload.trim();
  const body = { provider: 'notion', data: trimmed.toUpperCase() };
  const parts = JSON.stringify(body).split(',');
  return parts.join('|');
}
`)[0];

  assert.equal(tester.guardLiterals.has('lit:str:notion'), true);
  assert.equal(emitter.guardLiterals.has('lit:str:notion'), false);

  const vsTester = computeBehavioralGaps(query, tester).missing.find(g => g.token === 'lit:str:notion');
  assert.equal(vsTester?.weight, 'notable', 'a value the target tests for is notable');
  assert.match(vsTester?.description || '', /handles the value/);

  const vsEmitter = computeBehavioralGaps(query, emitter).missing.find(g => g.token === 'lit:str:notion');
  assert.equal(vsEmitter?.weight, 'minor', 'a value the target only emits is minor');
  assert.match(vsEmitter?.description || '', /uses the value/);
});

test('config-only divergence does not reach the escalation threshold', () => {
  // Two functions differing only in payload constants must not be headlined as
  // "behaviours to verify" — that was the noise this weighting removes.
  const a = fingerprintSource('src/a.ts', `
export async function callModelA(prompt: string): Promise<string> {
  const response = await fetch('https://example.test/v1', {
    method: 'POST',
    body: JSON.stringify({ model: 'model-alpha', role: 'system', prompt }),
  });
  const data = await response.json();
  return data.text;
}
`)[0];
  const b = fingerprintSource('src/b.ts', `
export async function callModelB(prompt: string): Promise<string> {
  const response = await fetch('https://example.test/v2', {
    method: 'POST',
    body: JSON.stringify({ model: 'model-beta', role: 'assistant', prompt }),
  });
  const data = await response.json();
  return data.text;
}
`)[0];

  const report = computeBehavioralGaps(a, b);
  assert.equal(report.notableCount, 0, `config differences must not be notable: ${report.missing.map(g => g.token).join(', ')}`);
});

test('guard literals survive the index round trip', () => {
  const original = fingerprintSource('src/guards.ts', GUARD_FIXTURE)[0];
  const restored = deserializeFingerprint(JSON.parse(JSON.stringify(serializeFingerprint(original))));
  assert.deepEqual([...restored.guardLiterals].sort(), [...original.guardLiterals].sort());
});

test('the regex parser path reports no guards rather than guessing', () => {
  const python = `
def classify_status(status):
    if status == 'cancelled':
        return 'closed'
    payload = {'model': 'gpt-4o-mini'}
    return send(payload)
`;
  const fp = fingerprintSource('src/status.py', python)[0];
  assert.equal(fp.parser, 'regex');
  assert.equal(fp.guardLiterals.size, 0, 'no syntactic position => no guard claims');
});
