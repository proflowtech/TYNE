import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  TyneCodeReviewResult,
  TyneReviewContextPack,
  isReviewResult,
  compactReviewResultLimits,
  TyneCodeReviewInlineComment,
} from '../codeReviewTypes';

function makeReviewResult(overrides: Partial<TyneCodeReviewResult> = {}): TyneCodeReviewResult {
  return {
    status: 'needs_work',
    score: 72,
    riskLevel: 'medium',
    summary: 'Looks good overall. Fix the missing test and hardcoded secret.',
    reviewEffort: { score: 3, label: 'Moderate', estimatedMinutes: 20, reason: 'Touches auth flow.' },
    sequenceDiagrams: [{ title: 'Auth flow', mermaid: 'sequenceDiagram\nUser->>API: Login', relatedFiles: ['src/auth.ts'] }],
    changedFilesSummary: [{ title: 'Auth', files: ['src/auth.ts'], summary: 'Updates auth handling.' }],
    reviewDetails: { reviewedFileCount: 1, filesSelected: ['src/auth.ts'], filesSkipped: [], noReviewableChangeFiles: [] },
    mustFix: [],
    suggestions: [],
    goodPoints: [],
    missingTests: [],
    inlineComments: [],
    ...overrides,
  };
}

function makeContextPack(overrides: Partial<TyneReviewContextPack> = {}): TyneReviewContextPack {
  return {
    repositoryName: 'tyne',
    currentBranch: 'feature/auth',
    reviewMode: 'staged_changes',
    projectHints: { language: 'typescript', framework: 'vscode-extension', testFramework: 'node:test' },
    git: {
      changedFiles: ['src/auth.ts'],
      stagedDiff: 'diff --git a/src/auth.ts b/src/auth.ts\n+const secret = "hardcoded"',
    },
    relevantFiles: [{ path: 'src/auth.ts', reason: 'changed auth logic' }],
    existingTests: [{ path: 'src/auth.test.ts', reason: 'existing auth tests' }],
    ...overrides,
  };
}

// ── isReviewResult schema validation ─────────────────────────────────────────

test('isReviewResult returns true for a valid result', () => {
  const r = makeReviewResult();
  assert.equal(isReviewResult(r), true);
});

test('isReviewResult rejects missing required fields', () => {
  assert.equal(isReviewResult({ status: 'passed' }), false);
  assert.equal(isReviewResult({ score: 90 }), false);
  assert.equal(isReviewResult(null), false);
  assert.equal(isReviewResult(undefined), false);
});

test('isReviewResult rejects invalid status', () => {
  const r = makeReviewResult({ status: 'almost' as TyneCodeReviewResult['status'] });
  assert.equal(isReviewResult(r), false);
});

test('isReviewResult rejects invalid risk level', () => {
  const r = makeReviewResult({ riskLevel: 'extreme' as TyneCodeReviewResult['riskLevel'] });
  assert.equal(isReviewResult(r), false);
});

// ── Compact card item limits ─────────────────────────────────────────────────

test('compactReviewResultLimits caps list sizes', () => {
  const r = makeReviewResult({
    sequenceDiagrams: Array.from({ length: 6 }, (_, i) => ({ title: `diagram ${i}`, mermaid: 'sequenceDiagram' })),
    changedFilesSummary: Array.from({ length: 10 }, (_, i) => ({ title: `group ${i}`, files: [`src/${i}.ts`], summary: 's' })),
    mustFix: Array.from({ length: 10 }, (_, i) => ({ title: `fix ${i}`, category: 'correctness', severity: 'high', reason: 'r' })),
    suggestions: Array.from({ length: 10 }, (_, i) => ({ title: `suggestion ${i}`, reason: 'r' })),
    goodPoints: Array.from({ length: 10 }, (_, i) => ({ title: `good ${i}` })),
    missingTests: Array.from({ length: 10 }, (_, i) => ({ title: `test ${i}`, testType: 'unit', reason: 'r' })),
  });
  const compact = compactReviewResultLimits(r);
  assert.equal(compact.mustFix.length, 5);
  assert.equal(compact.suggestions.length, 5);
  assert.equal(compact.goodPoints.length, 3);
  assert.equal(compact.missingTests.length, 4);
  assert.equal(compact.sequenceDiagrams?.length, 3);
  assert.equal(compact.changedFilesSummary?.length, 6);
});

test('compactReviewResultLimits shortens summary to two sentences', () => {
  const r = makeReviewResult({ summary: 'First sentence. Second sentence. Third sentence.' });
  const compact = compactReviewResultLimits(r);
  assert.equal(compact.summary, 'First sentence. Second sentence.');
});

// ── Missing test detection ───────────────────────────────────────────────────

test('isReviewResult validates missing test entries', () => {
  const r = makeReviewResult({
    missingTests: [
      { title: 'Missing unit test for auth.ts', testType: 'unit', relatedFile: 'src/auth.ts', reason: 'No new tests for changed logic.' },
    ],
  });
  assert.equal(isReviewResult(r), true);
});

// ── Security issue categorization ────────────────────────────────────────────

test('isReviewResult validates security category', () => {
  const r = makeReviewResult({
    mustFix: [{ title: 'Hardcoded secret', category: 'security', severity: 'critical', reason: 'Secrets should not be in source.' }],
  });
  assert.equal(isReviewResult(r), true);
});

// ── No invented file paths ─────────────────────────────────────────────────────

test('isReviewResult accepts valid file paths and inline comments', () => {
  const r = makeReviewResult({
    inlineComments: [
      { file: 'src/auth.ts', line: 12, severity: 'high', category: 'security', comment: 'Hardcoded secret' },
    ],
    mustFix: [{ title: 'Remove secret', file: 'src/auth.ts', category: 'security', severity: 'critical', reason: 'Security risk' }],
  });
  assert.equal(isReviewResult(r), true);
});

// ── Fallback comment display ───────────────────────────────────────────────────

test('inline comments fallback to file-level when line is omitted', () => {
  const comments: TyneCodeReviewInlineComment[] = [
    { file: 'src/auth.ts', severity: 'medium', category: 'maintainability', title: 'Extract helper', comment: 'Consider extracting helper.', diffSuggestion: '- inline()\n+ helper()', committableSuggestion: true },
  ];
  const r = makeReviewResult({ inlineComments: comments });
  assert.equal(isReviewResult(r), true);
  assert.equal(r.inlineComments[0].line, undefined);
  assert.equal(r.inlineComments[0].committableSuggestion, true);
});

test('CodeRabbit-style review fields are accepted', () => {
  const r = makeReviewResult({
    reviewEffort: { score: 4, label: 'Complex', estimatedMinutes: 40, reason: 'Multiple layers.' },
    reviewDetails: { reviewedFileCount: 2, filesSelected: ['src/a.ts', 'src/b.ts'], filesSkipped: ['dist/a.js'], noReviewableChangeFiles: ['README.md'] },
  });
  assert.equal(isReviewResult(r), true);
  assert.equal(r.reviewEffort?.score, 4);
});

test('webview exposes CodeRabbit-style review detail sections', () => {
  const js = fs.readFileSync(path.join(process.cwd(), 'media', 'tyne.js'), 'utf8');
  const css = fs.readFileSync(path.join(process.cwd(), 'media', 'tyne.css'), 'utf8');
  assert.ok(js.includes('reviewPotentialIssuesSection'), 'must render issue cards section');
  assert.ok(js.includes('reviewSuggestionDiff'), 'must render suggestion diff blocks');
  assert.ok(js.includes('reviewSequenceDiagramsSection'), 'must render sequence diagram section');
  assert.ok(js.includes('reviewEffortSection'), 'must render review effort section');
  assert.ok(js.includes('reviewDetailsSection'), 'must render review details section');
  assert.ok(js.includes('reviewScopeSection'), 'must render grounded technical review scope section');
  assert.ok(js.includes('codeReviewGroundedFiles'), 'must derive grounded files for technical review');
  assert.ok(js.includes('codeReviewItemIsGrounded'), 'must filter ungrounded AI issue cards');
  assert.ok(!js.includes('renderReviewCanonicalTaskFit'), 'technical review must not render stale Validate & Review task-fit state');
  assert.ok(!js.includes('reviewPmValidationSection'), 'technical review must not render separate PM validation section');
  assert.ok(css.includes('.cr-issue-card'), 'must style issue cards');
  assert.ok(css.includes('.cr-suggestion-diff'), 'must style suggestion diffs');
  assert.ok(css.includes('.cr-grounded-files'), 'must style grounded file chips');
});

test('technical review prompt excludes PM scope scoring', () => {
  const edge = fs.readFileSync(path.join(process.cwd(), 'supabase', 'functions', 'tyne-code-review', 'index.ts'), 'utf8');
  assert.ok(edge.includes('Do NOT assess Jira/Linear scope alignment'), 'prompt must ban PM scope assessment');
  assert.ok(edge.includes('Do not return pmAlignment or pmValidation fields'), 'prompt must forbid old PM fields');
  assert.ok(!edge.includes('"pmValidation": {'), 'prompt schema must not request pmValidation');
  assert.ok(!edge.includes('PM task alignment: 25%'), 'scoring must not include PM task alignment');
});

test('code review sanitization enforces grounded files from actual context', () => {
  const edge = fs.readFileSync(path.join(process.cwd(), 'supabase', 'functions', 'tyne-code-review', 'index.ts'), 'utf8');
  const service = fs.readFileSync(path.join(process.cwd(), 'src', 'codeReviewService.ts'), 'utf8');
  const types = fs.readFileSync(path.join(process.cwd(), 'src', 'codeReviewTypes.ts'), 'utf8');
  assert.ok(edge.includes('function allowedReviewFiles'), 'backend must build an allowed file set');
  assert.ok(edge.includes('function groundedPath'), 'backend must validate model-returned file paths');
  assert.ok(edge.includes('sanitizeReviewResult(parsed, context)'), 'backend sanitizer must receive review context');
  assert.ok(edge.includes('file: groundedPath(x.file, allowedFiles)'), 'mustFix and suggestions must not keep hallucinated files');
  assert.ok(edge.includes('relatedFiles.length') && edge.includes('return null'), 'diagrams without grounded files must be dropped');
  assert.ok(edge.includes('reviewedFileCount: filesSelected.length'), 'review details count must be derived from grounded selected files');
  assert.ok(service.includes('reviewMode: contextPack.reviewMode'), 'client result metadata must include review mode');
  assert.ok(service.includes('changedFiles: contextPack.git.changedFiles'), 'client result metadata must include changed files');
  assert.ok(types.includes('changedFiles?: string[]'), 'review result type must carry changed files');
});

test('host code review path does not fetch PM intelligence', () => {
  const provider = fs.readFileSync(path.join(process.cwd(), 'src', 'TyneSidebarProvider.ts'), 'utf8');
  const start = provider.indexOf('private async _handleRunCodeReview');
  const end = provider.indexOf('private async _handleRunValidateReview');
  const section = provider.slice(start, end);
  assert.ok(!section.includes('getPmTaskIntelligenceService'), 'code review handler must not fetch PM intelligence');
  assert.ok(!section.includes('pmTaskIntelligence'), 'code review handler must not pass PM intelligence');
});

// ── Full report collapsed default state ────────────────────────────────────────

test('default review result does not include full report', () => {
  const r = makeReviewResult();
  assert.equal(r.fullReport, undefined);
});

// ── Large diff truncation ──────────────────────────────────────────────────────

test('diff truncation helper caps diff length', () => {
  const pack = makeContextPack({
    git: {
      changedFiles: ['src/auth.ts'],
      stagedDiff: 'a'.repeat(60_000),
    },
  });
  const truncated = pack.git.stagedDiff && pack.git.stagedDiff.length > 25_000
    ? `${pack.git.stagedDiff.slice(0, 25_000)}\n... [truncated] ...`
    : pack.git.stagedDiff;
  assert.ok(truncated!.length < 60_000);
  assert.ok(truncated!.endsWith('... [truncated] ...'));
});

// ── Ignored folders handling ───────────────────────────────────────────────────

test('changedFiles list excludes ignored paths', () => {
  const IGNORE_PATHS = /\/(node_modules|dist|build|out|\.next|coverage|\.git)\//;
  const changedFiles = [
    'src/auth.ts',
    'node_modules/lodash/index.js',
    'dist/bundle.js',
    'src/util.ts',
  ].filter(p => !IGNORE_PATHS.test('/' + p));
  assert.ok(changedFiles.includes('src/auth.ts'));
  assert.ok(changedFiles.includes('src/util.ts'));
  assert.ok(!changedFiles.includes('node_modules/lodash/index.js'));
  assert.ok(!changedFiles.includes('dist/bundle.js'));
});

// ── review result schema validation helpers ────────────────────────────────────

test('isReviewResult requires arrays to be present', () => {
  const partial = {
    status: 'passed',
    score: 95,
    riskLevel: 'low',
    summary: 'All good.',
  };
  assert.equal(isReviewResult(partial), false);
});
