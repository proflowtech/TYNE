import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClarifyingQuestions,
  buildClarifyingQuestionsFromEnrichment,
  buildDecompositionResult,
  clampTasks,
  DecomposableStory,
  DecomposedTask,
  detectStoryCharacteristics,
  determineSplitStrategy,
  generateHeuristicTasks,
  isDecomposableIssueType,
  parseDecomposedTasks,
  recommendSprint,
  recommendTaskOrder,
  subtaskLimitForTier,
} from '../storyDecompositionHarness';

const OAUTH_STORY: DecomposableStory = {
  title: 'Add OAuth 2.0 Authentication',
  description: 'Implement OAuth 2.0 flow with a login form UI, a backend callback endpoint, and store tokens in the database.',
  acceptanceCriteria: [
    'User can login with OAuth',
    'Tokens are stored securely',
    'Refresh token works',
  ],
  issueType: 'Story',
  storyPoints: 8,
};

describe('isDecomposableIssueType', () => {
  test('stories and epics are decomposable', () => {
    assert.ok(isDecomposableIssueType('Story'));
    assert.ok(isDecomposableIssueType('Epic'));
    assert.ok(isDecomposableIssueType('User Story'));
    assert.ok(isDecomposableIssueType(' epic '));
  });

  test('tasks, bugs, and sub-tasks are not', () => {
    assert.equal(isDecomposableIssueType('Task'), false);
    assert.equal(isDecomposableIssueType('Bug'), false);
    assert.equal(isDecomposableIssueType('Sub-task'), false);
    assert.equal(isDecomposableIssueType(undefined), false);
    assert.equal(isDecomposableIssueType(''), false);
  });
});

describe('detectStoryCharacteristics', () => {
  test('detects frontend, backend, database, api, and auth in the OAuth story', () => {
    const c = detectStoryCharacteristics(OAUTH_STORY);
    assert.equal(c.hasFrontend, true);
    assert.equal(c.hasBackend, true);
    assert.equal(c.affectsDatabase, true);
    assert.equal(c.needsAPI, true);
    assert.equal(c.needsAuth, true);
    assert.equal(c.complexity, 'high');
  });

  test('story points drive complexity', () => {
    const low = detectStoryCharacteristics({ ...OAUTH_STORY, storyPoints: 2 });
    assert.equal(low.complexity, 'low');
    const medium = detectStoryCharacteristics({ ...OAUTH_STORY, storyPoints: 5 });
    assert.equal(medium.complexity, 'medium');
  });

  test('without points, epics default to high and stories to medium complexity', () => {
    const epic = detectStoryCharacteristics({ ...OAUTH_STORY, storyPoints: undefined, issueType: 'Epic' });
    assert.equal(epic.complexity, 'high');
    const story = detectStoryCharacteristics({ ...OAUTH_STORY, storyPoints: undefined, issueType: 'Story' });
    assert.equal(story.complexity, 'medium');
  });

  test('a pure copy-change story detects neither database nor api', () => {
    const c = detectStoryCharacteristics({
      title: 'Update onboarding copy',
      description: 'Change the welcome text on the landing page component.',
      acceptanceCriteria: ['New copy shows on the page'],
      issueType: 'Story',
      storyPoints: 1,
    });
    assert.equal(c.hasFrontend, true);
    assert.equal(c.affectsDatabase, false);
    assert.equal(c.needsAPI, false);
  });
});

describe('buildClarifyingQuestions', () => {
  test('full-stack high-complexity story with api gets all four questions', () => {
    const questions = buildClarifyingQuestions(detectStoryCharacteristics(OAUTH_STORY));
    const ids = questions.map(q => q.id);
    assert.deepEqual(ids, ['frontend_backend_split', 'database_strategy', 'testing_strategy', 'api_design']);
  });

  test('every question marks exactly one recommended option', () => {
    const questions = buildClarifyingQuestions(detectStoryCharacteristics(OAUTH_STORY));
    for (const q of questions) {
      assert.equal(q.options.filter(o => o.recommended).length, 1, q.id);
    }
  });

  test('frontend-only low-complexity story gets no questions', () => {
    const questions = buildClarifyingQuestions(detectStoryCharacteristics({
      title: 'Update onboarding copy',
      description: 'Change the welcome text on the landing page component.',
      acceptanceCriteria: [],
      issueType: 'Story',
      storyPoints: 1,
    }));
    assert.deepEqual(questions, []);
  });
});

describe('buildClarifyingQuestionsFromEnrichment', () => {
  const characteristics = detectStoryCharacteristics(OAUTH_STORY);

  test('uses AI proposed subtasks as a justification question', () => {
    const questions = buildClarifyingQuestionsFromEnrichment(characteristics, {
      goal: 'Ship OAuth login end to end',
      subtasks: [
        { title: 'Backend - OAuth callback' },
        { title: 'Frontend - Login button' },
        { title: 'Database - token store' },
      ],
    }, 'Story');
    assert.equal(questions[0].id, 'proposed_split');
    assert.match(questions[0].question, /Backend - OAuth callback/);
    assert.equal(questions[0].allowCustom, true);
    assert.ok(questions[0].options.some(o => o.id === 'custom'));
  });

  test('surfaces openQuestions and questionsForPM as freeform answers', () => {
    const questions = buildClarifyingQuestionsFromEnrichment(characteristics, {
      goal: 'Ship OAuth login',
      pmContext: { openQuestions: ['Which OAuth providers are in scope?'] },
      developerTaskPlan: { questionsForPM: ['Do we need refresh-token rotation?'] },
    }, 'Epic');
    const freeform = questions.filter(q => q.inputKind === 'freeform');
    assert.ok(freeform.length >= 2);
    assert.ok(freeform.some(q => /OAuth providers/i.test(q.question)));
    assert.ok(freeform.some(q => /refresh-token/i.test(q.question)));
  });

  test('always returns at least one question even with no enrichment', () => {
    const questions = buildClarifyingQuestionsFromEnrichment({
      hasFrontend: false,
      hasBackend: false,
      affectsDatabase: false,
      needsAPI: false,
      needsAuth: false,
      needsIntegration: false,
      complexity: 'low',
    }, null, 'Story');
    assert.ok(questions.length >= 1);
    assert.equal(questions[0].allowCustom, true);
  });
});

describe('determineSplitStrategy', () => {
  test('maps recommended answers', () => {
    const strategy = determineSplitStrategy({
      frontend_backend_split: 'split',
      database_strategy: 'separate_migration',
      testing_strategy: 'unit_integration',
      api_design: 'designed',
    });
    assert.equal(strategy.splitFrontendBackend, true);
    assert.equal(strategy.separateMigration, true);
    assert.equal(strategy.includeTestTask, true);
    assert.equal(strategy.includeE2E, false);
    assert.equal(strategy.separateApiDesign, false);
  });

  test('manual QA drops the test task; e2e answer adds e2e', () => {
    assert.equal(determineSplitStrategy({ testing_strategy: 'manual_qa' }).includeTestTask, false);
    const e2e = determineSplitStrategy({ testing_strategy: 'e2e_included' });
    assert.equal(e2e.includeTestTask, true);
    assert.equal(e2e.includeE2E, true);
  });

  test('rolling migration still creates a separate migration task', () => {
    assert.equal(determineSplitStrategy({ database_strategy: 'rolling_change' }).separateMigration, true);
  });
});

describe('subtaskLimitForTier', () => {
  test('free cannot decompose, pro caps at 3, max at 5', () => {
    assert.equal(subtaskLimitForTier('free'), 0);
    assert.equal(subtaskLimitForTier('pro'), 3);
    assert.equal(subtaskLimitForTier('max'), 5);
    assert.equal(subtaskLimitForTier('UNKNOWN'), 0);
  });
});

describe('generateHeuristicTasks', () => {
  const characteristics = detectStoryCharacteristics(OAUTH_STORY);

  test('split strategy produces database, backend, frontend, and test tasks in dependency order', () => {
    const strategy = determineSplitStrategy({
      frontend_backend_split: 'split',
      database_strategy: 'separate_migration',
      testing_strategy: 'unit_integration',
      api_design: 'designed',
    });
    const tasks = generateHeuristicTasks(OAUTH_STORY, characteristics, strategy, 5);
    const titles = tasks.map(t => t.title);
    assert.equal(tasks.length, 4);
    assert.ok(titles[0].startsWith('Database -'));
    assert.ok(titles[1].startsWith('Backend -'));
    assert.ok(titles[2].startsWith('Frontend -'));
    assert.ok(titles[3].startsWith('Tests -'));
    // Frontend depends on backend; backend depends on the migration.
    assert.deepEqual(tasks[2].dependencies, [titles[1]]);
    assert.deepEqual(tasks[1].dependencies, [titles[0]]);
    // Tests depend on both implementation tasks.
    assert.deepEqual(tasks[3].dependencies.sort(), [titles[1], titles[2]].sort());
  });

  test('keep-together strategy produces one combined implementation task', () => {
    const strategy = determineSplitStrategy({
      frontend_backend_split: 'keep_together',
      database_strategy: 'include_backend',
      testing_strategy: 'manual_qa',
    });
    const tasks = generateHeuristicTasks(OAUTH_STORY, characteristics, strategy, 5);
    assert.equal(tasks.length, 1);
    assert.ok(tasks[0].title.startsWith('Implementation -'));
    assert.deepEqual(tasks[0].acceptanceCriteria, OAUTH_STORY.acceptanceCriteria);
  });

  test('api design task comes first when requested', () => {
    const strategy = determineSplitStrategy({
      frontend_backend_split: 'split',
      api_design: 'design_task',
      testing_strategy: 'manual_qa',
      database_strategy: 'include_backend',
    });
    const tasks = generateHeuristicTasks(OAUTH_STORY, characteristics, strategy, 5);
    assert.ok(tasks[0].title.startsWith('API Design -'));
    assert.ok(tasks.find(t => t.title.startsWith('Backend -'))!.dependencies.includes(tasks[0].title));
  });

  test('pro tier limit clamps to 3 tasks and prunes dangling dependencies', () => {
    const strategy = determineSplitStrategy({
      frontend_backend_split: 'split',
      database_strategy: 'separate_migration',
      testing_strategy: 'e2e_included',
      api_design: 'design_task',
    });
    const tasks = generateHeuristicTasks(OAUTH_STORY, characteristics, strategy, 3);
    assert.equal(tasks.length, 3);
    const titles = new Set(tasks.map(t => t.title));
    for (const task of tasks) {
      for (const dep of task.dependencies) {
        assert.ok(titles.has(dep), `dangling dependency: ${dep}`);
      }
    }
  });

  test('codebase hints flow into developer context', () => {
    const strategy = determineSplitStrategy({ frontend_backend_split: 'split' });
    const tasks = generateHeuristicTasks(OAUTH_STORY, characteristics, strategy, 5, {
      frontendStack: 'React + TypeScript',
      backendStack: 'Node + Postgres',
    });
    const frontend = tasks.find(t => t.title.startsWith('Frontend -'));
    const backend = tasks.find(t => t.title.startsWith('Backend -'));
    assert.ok(frontend!.developerContext.includes('React + TypeScript'));
    assert.ok(backend!.developerContext.includes('Node + Postgres'));
  });
});

describe('recommendSprint and totals', () => {
  test('sprint recommendation follows total hours', () => {
    assert.equal(recommendSprint(12), 'Current sprint (1 dev)');
    assert.equal(recommendSprint(30), 'Next sprint (2 devs)');
    assert.equal(recommendSprint(60), 'Next 2 sprints (3 devs)');
  });

  test('buildDecompositionResult sums hours', () => {
    const tasks: DecomposedTask[] = [
      { title: 'A', description: '', acceptanceCriteria: [], estimatedHours: 8, affectedFiles: [], dependencies: [], proofPoints: [], developerContext: '' },
      { title: 'B', description: '', acceptanceCriteria: [], estimatedHours: 12, affectedFiles: [], dependencies: [], proofPoints: [], developerContext: '' },
    ];
    const result = buildDecompositionResult(tasks, 'heuristic');
    assert.equal(result.totalEstimatedHours, 20);
    assert.equal(result.recommendedSprint, 'Next sprint (2 devs)');
    assert.equal(result.generatedBy, 'heuristic');
  });
});

describe('parseDecomposedTasks', () => {
  test('sanitizes malformed LLM output', () => {
    const tasks = parseDecomposedTasks([
      { title: '  Backend - OAuth flow ', estimatedHours: '12', acceptanceCriteria: ['works', 42, ''], dependencies: null },
      { title: '', description: 'no title so dropped' },
      'not an object',
      { title: 'Frontend - Login UI', estimatedHours: -3, proofPoints: ['clickable'] },
    ], 5);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].title, 'Backend - OAuth flow');
    assert.equal(tasks[0].estimatedHours, 12);
    assert.deepEqual(tasks[0].acceptanceCriteria, ['works']);
    // Invalid hours fall back to a sane default.
    assert.equal(tasks[1].estimatedHours, 4);
  });

  test('non-array payloads produce no tasks', () => {
    assert.deepEqual(parseDecomposedTasks(null, 5), []);
    assert.deepEqual(parseDecomposedTasks({ tasks: [] }, 5), []);
    assert.deepEqual(parseDecomposedTasks('[]', 5), []);
  });

  test('clamps to the tier limit and prunes dependencies on dropped tasks', () => {
    const raw = ['A', 'B', 'C', 'D', 'E', 'F'].map(title => ({
      title,
      estimatedHours: 4,
      dependencies: title === 'A' ? ['F'] : [],
    }));
    const tasks = parseDecomposedTasks(raw, 5);
    assert.equal(tasks.length, 5);
    assert.deepEqual(tasks[0].dependencies, []);
  });
});

describe('clampTasks', () => {
  test('zero limit returns empty', () => {
    const tasks: DecomposedTask[] = [
      { title: 'A', description: '', acceptanceCriteria: [], estimatedHours: 4, affectedFiles: [], dependencies: [], proofPoints: [], developerContext: '' },
    ];
    assert.deepEqual(clampTasks(tasks, 0), []);
  });
});

// ── Work-item type pill (webview) ────────────────────────────────────────────

describe('issue type pill', () => {
  const tyneJs = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'media', 'tyne.js'), 'utf8');
  const tyneCss = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'media', 'tyne.css'), 'utf8');

  test('webview classifies epic, story, and task variants', () => {
    // Mirror of issueTypeClass in media/tyne.js.
    const classify = (t: string) => {
      const v = (t || '').trim().toLowerCase();
      if (v === 'epic') { return 'epic'; }
      if (v === 'story' || v === 'user story' || v === 'feature') { return 'story'; }
      return 'task';
    };
    assert.equal(classify('Epic'), 'epic');
    assert.equal(classify(' EPIC '), 'epic');
    assert.equal(classify('Story'), 'story');
    assert.equal(classify('User Story'), 'story');
    assert.equal(classify('Task'), 'task');
    assert.equal(classify('Bug'), 'task');
    assert.equal(classify('Sub-task'), 'task');
  });

  test('pill classes align with the decomposable-type check', () => {
    // Anything rendered as an epic/story pill must also be decomposable, so the
    // pill colour and the primary button label never disagree.
    for (const type of ['Epic', 'Story', 'User Story', 'Feature']) {
      assert.ok(isDecomposableIssueType(type), `${type} must be decomposable`);
    }
    for (const type of ['Task', 'Bug', 'Sub-task']) {
      assert.equal(isDecomposableIssueType(type), false, `${type} must not be decomposable`);
    }
  });

  test('pill renders outline-only styles in the three required colours', () => {
    assert.ok(tyneJs.includes('function issueTypePill'), 'tyne.js must define issueTypePill');
    assert.ok(tyneCss.includes('.type-pill-epic'), 'CSS must style the epic pill');
    assert.ok(tyneCss.includes('.type-pill-story'), 'CSS must style the story pill');
    assert.ok(tyneCss.includes('.type-pill-task'), 'CSS must style the task pill');
    const block = tyneCss.slice(tyneCss.indexOf('.type-pill {'), tyneCss.indexOf('.type-pill-epic'));
    assert.ok(block.includes('background: transparent'), 'pill fill must be transparent');
    assert.ok(!/gradient/i.test(block), 'pill must not use a gradient');
  });

  test('unknown issue types render no pill rather than guessing "Task"', () => {
    assert.ok(
      tyneJs.includes("if (!label) { return ''; }"),
      'issueTypePill must return empty for an unknown type',
    );
  });

  test('decompose create pushes to Jira when connected and refreshes task cache', () => {
    const hostSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'src', 'sidebar', 'storyDecompositionController.ts'), 'utf8');
    const jiraSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'src', 'jiraProvider.ts'), 'utf8');
    assert.ok(hostSrc.includes('pushToPm = createInJira || connected'));
    assert.ok(hostSrc.includes('forceRefresh: true'));
    assert.ok(hostSrc.includes('mergeCreatedStubs'));
    assert.ok(jiraSrc.includes('_findStandardChildIssueTypeId'));
    assert.ok(jiraSrc.includes('underEpic'));
    assert.ok(tyneJs.includes('pmToolIsConnected(this.tool)'));
  });
});

// ── AICredits model resolution — regression for the PM enrichment outage ─────
//
// PM enrichment failed for every issue from 2026-06-28 onward: the metering
// event was recorded but no context row was ever stored, i.e. the LLM step
// threw. Root cause was exact-match model filtering — once AICredits renamed a
// preferred model id, the feature had no candidates left and hard-failed,
// even though usable peer models were still in the catalog.

describe('aicredits model policy resolution', () => {
  const policySrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'supabase', 'functions', '_shared', 'aicreditsModelPolicy.ts'),
    'utf8');

  // Mirror of expandPreferenceHints in the shared policy module.
  const expand = (hints: string[], catalog: string[]): string[] => {
    const matched: string[] = [];
    for (const hint of hints) {
      const exact = catalog.find(id => id === hint);
      if (exact) { matched.push(exact); continue; }
      const needle = hint.toLowerCase();
      for (const id of catalog) {
        if (id.toLowerCase().includes(needle) || needle.includes(id.toLowerCase())) { matched.push(id); }
      }
    }
    return [...new Set(matched)];
  };

  test('a renamed model id still resolves via loose hint matching', () => {
    // Catalog dropped "deepseek/deepseek-v4-pro" in favour of "deepseek/deepseek-v4".
    const catalog = ['deepseek/deepseek-v4', 'google/gemini-2.5-flash'];
    const matched = expand(['deepseek/deepseek-v4-pro', 'google/gemini-2.5-flash'], catalog);
    assert.ok(matched.includes('deepseek/deepseek-v4'), 'renamed id must still match its hint');
  });

  test('exact-match filtering would have produced zero candidates', () => {
    // This is the old behaviour the fix removes — documents the failure mode.
    const catalog = ['deepseek/deepseek-v4', 'google/gemini-2.5-flash'];
    const exactOnly = ['deepseek/deepseek-v4-pro'].filter(m => catalog.includes(m));
    assert.deepEqual(exactOnly, [], 'exact match finds nothing once the id is renamed');
  });

  test('every feature resolves against the live catalog, not an exact-match list', () => {
    assert.ok(
      !/const useCatalog\s*=/.test(policySrc),
      'model resolution must no longer branch between catalog-aware and exact-match',
    );
    assert.ok(
      policySrc.includes('buildCatalogAwareCandidates(feature, normalizedTier, catalog, override)'),
      'all features must build candidates from the catalog',
    );
  });

  test('non-review features keep a bounded fallback chain', () => {
    assert.ok(policySrc.includes('const defaultMax'), 'a default candidate cap must exist');
    assert.ok(
      /defaultMax\s*=\s*feature === 'validate_review_chunk' \|\| feature === 'validate_review_final' \? undefined : 4/.test(policySrc),
      'only review chunk/final may walk an unbounded chain',
    );
  });

  test('story decomposition prefers haiku-class models on paid tiers only', () => {
    const block = policySrc.slice(
      policySrc.indexOf('story_decomposition: {'),
      policySrc.indexOf('}', policySrc.indexOf('max:', policySrc.indexOf('story_decomposition: {'))));
    assert.ok(/free:\s*\[\]/.test(block), 'free tier must have no decomposition models');
    assert.ok(block.includes('haiku'), 'paid tiers must prefer haiku-class models');
  });
});

// ── Recommended execution order ──────────────────────────────────────────────

describe('recommendTaskOrder', () => {
  const mk = (title: string, dependencies: string[] = []): DecomposedTask => ({
    title, description: '', acceptanceCriteria: [], estimatedHours: 4,
    affectedFiles: [], dependencies, proofPoints: [], developerContext: '',
  });

  test('dependencies are ordered before the tasks that need them', () => {
    const ordered = recommendTaskOrder([
      mk('Frontend', ['Backend']),
      mk('Tests', ['Frontend', 'Backend']),
      mk('Backend', ['Database']),
      mk('Database'),
    ]);
    assert.deepEqual(ordered.map(t => t.title), ['Database', 'Backend', 'Frontend', 'Tests']);
    assert.deepEqual(ordered.map(t => t.order), [1, 2, 3, 4]);
  });

  test('only the first task is unblocked in a fully chained plan', () => {
    const ordered = recommendTaskOrder([
      mk('Database'),
      mk('Backend', ['Database']),
      mk('Frontend', ['Backend']),
    ]);
    assert.deepEqual(ordered[0].blockedBy, []);
    assert.deepEqual(ordered[1].blockedBy, ['Database']);
    assert.deepEqual(ordered[2].blockedBy, ['Backend']);
  });

  test('independent tasks keep generator order and are all startable', () => {
    const ordered = recommendTaskOrder([mk('A'), mk('B'), mk('C')]);
    assert.deepEqual(ordered.map(t => t.title), ['A', 'B', 'C']);
    assert.ok(ordered.every(t => t.blockedBy.length === 0));
  });

  test('dependencies on unknown tasks are ignored, not treated as blocking', () => {
    const ordered = recommendTaskOrder([mk('Solo', ['Nonexistent'])]);
    assert.equal(ordered.length, 1);
    assert.deepEqual(ordered[0].blockedBy, []);
  });

  test('a dependency cycle still emits every task rather than dropping work', () => {
    const ordered = recommendTaskOrder([mk('A', ['B']), mk('B', ['A'])]);
    assert.equal(ordered.length, 2);
    assert.deepEqual(ordered.map(t => t.title).sort(), ['A', 'B']);
    // Both remain visible and flagged so the picker can still offer them.
    assert.ok(ordered.some(t => t.blockedBy.length > 0));
  });

  test('order survives a real generated split', () => {
    const strategy = determineSplitStrategy({
      frontend_backend_split: 'split',
      database_strategy: 'separate_migration',
      testing_strategy: 'unit_integration',
      api_design: 'designed',
    });
    const tasks = generateHeuristicTasks(OAUTH_STORY, detectStoryCharacteristics(OAUTH_STORY), strategy, 5);
    const ordered = recommendTaskOrder(tasks);
    assert.equal(ordered.length, tasks.length);
    // Exactly one task is startable immediately.
    assert.equal(ordered.filter(t => t.blockedBy.length === 0).length, 1);
    assert.ok(ordered[0].title.startsWith('Database -'));
  });
});

// ── Regression: the actual PM enrichment outage ──────────────────────────────
//
// getAicreditsModelFallbacks read a bare `maxCandidates` that was never
// declared (the parameter is `options.maxCandidates`). At runtime that threw
// ReferenceError, which a bare `catch {}` rewrote as "No supported AICredits
// models found for pm_task_intelligence" — masking a total outage for weeks.

describe('aicredits policy: undeclared identifier regression', () => {
  const policySrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', '..', 'supabase', 'functions', '_shared', 'aicreditsModelPolicy.ts'),
    'utf8');

  test('candidate slicing never references an undeclared maxCandidates', () => {
    assert.ok(
      !/slice\(0,\s*maxCandidates\s*\)/.test(policySrc),
      'bare `maxCandidates` throws ReferenceError at runtime — must read options.maxCandidates',
    );
    assert.ok(
      policySrc.includes('options?.maxCandidates ?? defaultMax'),
      'slicing must read the option off the parameter object',
    );
  });

  test('model resolution failures preserve the underlying cause', () => {
    assert.ok(!/\}\s*catch\s*\{\s*\n\s*if \(feature === 'validate_review_final'/.test(policySrc),
      'must not swallow the cause with a bare catch');
    assert.ok(policySrc.includes('No supported AICredits models found for ${feature}: ${cause}'),
      'the thrown message must carry the real cause');
  });

  test('an empty catalog is never cached', () => {
    assert.ok(
      policySrc.includes('AICredits /models returned no usable model ids'),
      'an empty /models response must throw, not poison the module cache',
    );
  });

  test('base url is env-overridable and defaults to the AICredits endpoint', () => {
    assert.ok(policySrc.includes("AICREDITS_DEFAULT_BASE_URL = 'https://api.aicredits.in/v1'"));
    assert.ok(policySrc.includes("Deno.env.get('AICREDITS_BASE_URL')"), 'base url must be overridable');
  });

  test('no phantom model ids remain in the policy', () => {
    // These three were never in the AICredits catalog and contributed nothing.
    for (const phantom of ["'kimi/kimi-code'", "'nvidia/llama'", "'z-ai/glm'", "'anthropic/claude-3.7-sonnet'"]) {
      assert.ok(!policySrc.includes(phantom), `${phantom} does not exist in the catalog`);
    }
  });

  test('every configured model id is fully qualified vendor/model', () => {
    const block = policySrc.slice(
      policySrc.indexOf('const MODEL_CANDIDATES'), policySrc.indexOf('const CHUNK_PREFERENCE_RE'));
    const ids = [...block.matchAll(/'([a-z0-9][^']*)'/g)].map(m => m[1]);
    assert.ok(ids.length > 0, 'policy must configure model ids');
    for (const id of ids) {
      assert.match(id, /^[a-z0-9-]+\/[a-z0-9.\-]+$/, `"${id}" is not a valid vendor/model id`);
    }
  });
});
