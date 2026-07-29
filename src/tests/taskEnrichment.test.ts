/**
 * Phase 1 Task/Thread merge — shared enrichment service invariants + behaviour.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  clearEnrichmentState,
  getEnrichmentState,
  isEnrichmentTriggerField,
  isTaskCreationEligible,
  runEnrichment,
} from '../taskEnrichmentService';

const root = join(__dirname, '../..');
const hostSrc = readFileSync(join(root, 'src/TyneSidebarProvider.ts'), 'utf8')
  + '\n' + readFileSync(join(root, 'src/sidebar/sidebarHtml.ts'), 'utf8')
  + '\n' + readFileSync(join(root, 'src/sidebar/storyDecompositionController.ts'), 'utf8')
  + '\n' + readFileSync(join(root, 'src/sidebar/pmIntelligenceController.ts'), 'utf8');
const tyneJs = readFileSync(join(root, 'media/tyne.js'), 'utf8');
const serviceSrc = readFileSync(join(root, 'src/taskEnrichmentService.ts'), 'utf8');

describe('taskEnrichmentService — state machine', () => {
  beforeEach(() => clearEnrichmentState());

  it('runEnrichment stores complete + intelligence', async () => {
    const intel = { goal: 'Ship login', acceptanceCriteria: ['works'], proofPointTemplates: ['demo'], validationSteps: [], subtasks: [] };
    const state = await runEnrichment('TASK-1', {
      issueType: 'Story',
      extract: async () => ({ intelligence: intel as never }),
    });
    assert.equal(state.status, 'complete');
    assert.equal(getEnrichmentState('TASK-1').intelligence?.goal, 'Ship login');
    assert.equal(isTaskCreationEligible('TASK-1'), true);
  });

  it('isTaskCreationEligible false for non-decomposable types even when complete', async () => {
    await runEnrichment('BUG-1', {
      issueType: 'Bug',
      extract: async () => ({ intelligence: { goal: 'x' } as never }),
    });
    assert.equal(isTaskCreationEligible('BUG-1'), false);
  });

  it('marks empty intelligence separately from a real completion', async () => {
    const state = await runEnrichment('EMPTY-1', {
      issueType: 'Epic',
      extract: async () => ({
        intelligence: {
          goal: '',
          subtasks: [],
          acceptanceCriteria: [],
          proofPointTemplates: [],
          validationSteps: [],
        } as never,
      }),
    });
    assert.equal(state.status, 'complete_empty');
    assert.equal(isTaskCreationEligible('EMPTY-1'), false);
  });

  it('isTaskCreationEligible false while running / on error', async () => {
    const p = runEnrichment('EPIC-1', {
      issueType: 'Epic',
      extract: async () => {
        assert.equal(getEnrichmentState('EPIC-1').status, 'running');
        assert.equal(isTaskCreationEligible('EPIC-1'), false);
        return { intelligence: null, error: 'boom' };
      },
    });
    const done = await p;
    assert.equal(done.status, 'error');
    assert.equal(isTaskCreationEligible('EPIC-1'), false);
  });

  it('isEnrichmentTriggerField covers thread brief edits', () => {
    assert.equal(isEnrichmentTriggerField('goal'), true);
    assert.equal(isEnrichmentTriggerField('taskId'), true);
    assert.equal(isEnrichmentTriggerField('appName'), false);
  });
});

describe('Phase 1 wiring — shared service from both paths', () => {
  it('sidebar imports and uses taskEnrichmentService', () => {
    assert.ok(hostSrc.includes("from './taskEnrichmentService'"));
    assert.ok(hostSrc.includes('runEnrichment('));
    assert.ok(hostSrc.includes('_scheduleEnrichmentFromThreadEdit'));
    assert.ok(hostSrc.includes('_runEnrichmentForActiveThreadTask'));
  });

  it('Start Thread enrichment goes through runEnrichment', () => {
    const fnStart = hostSrc.indexOf('async extractIntelligenceForStartThread(');
    assert.notEqual(fnStart, -1);
    const fnBody = hostSrc.slice(fnStart, fnStart + 1800);
    assert.ok(fnBody.includes('runEnrichment(taskId'), 'Start Thread extract must call runEnrichment');
  });

  it('Thread fieldChange schedules enrichment for goal/taskId', () => {
    const fnStart = hostSrc.indexOf('private _handleFieldChange(');
    const fnBody = hostSrc.slice(fnStart, fnStart + 600);
    assert.ok(fnBody.includes('isEnrichmentTriggerField'));
    assert.ok(fnBody.includes('_scheduleEnrichmentFromThreadEdit'));
  });

  it('updateTask re-enriches active thread task via shared path', () => {
    const fnStart = hostSrc.indexOf('private async _handleUpdateTask(');
    const fnBody = hostSrc.slice(fnStart, fnStart + 1200);
    assert.ok(fnBody.includes("_runEnrichmentForActiveThreadTask('task_update')"));
  });

  it('story decompose enrichment uses runEnrichment', () => {
    const fnStart = hostSrc.indexOf('async enrichStoryForDecomposition(');
    const fnBody = hostSrc.slice(fnStart, fnStart + 1500);
    assert.ok(fnBody.includes('runEnrichment(taskId'));
  });

  it('Thread Create-tasks CTA gates on cached issueType, not enrichment complete', () => {
    assert.ok(hostSrc.includes('_postThreadCreateTasksVisibility'));
    assert.ok(hostSrc.includes('isDecomposableIssueType(issueType)'));
    assert.ok(hostSrc.includes('_findCachedTask'));
    assert.ok(!hostSrc.includes('isTaskCreationEligible('), 'CTA must not use enrichment-gated eligibility');
    const postState = hostSrc.indexOf('private _postState(');
    const postStateBody = hostSrc.slice(postState, postState + 900);
    assert.ok(postStateBody.includes('_postThreadCreateTasksVisibility()'), 'stateLoaded path must re-show CTA');
    const loadFn = hostSrc.indexOf('private async _loadTaskIntoThread(');
    const loadBody = hostSrc.slice(loadFn, loadFn + 2500);
    assert.ok(loadBody.includes('_postThreadCreateTasksVisibility(taskId)'), 'CTA before enrichment await');
    assert.ok(loadBody.includes('issueType: cachedType'), 'prefillThread must carry issueType');
    assert.ok(tyneJs.includes('function syncThreadCreateTasksCta'));
    assert.ok(tyneJs.includes('isDecomposableType(issueType)'));
    assert.ok(tyneJs.includes('state.taskIssueType'));
    assert.ok(tyneJs.includes("state.taskIssueType = msg.issueType || ''"), 'host eligibility must clear stale Epic/Story type');
    assert.ok(tyneJs.includes("primaryAction: 'createFromEpic'"), 'Thread primary must become Create-from-epic for decomposable types');
    // One CTA only: flow primary — no duplicate dedicated Create-tasks field.
    assert.ok(!hostSrc.includes('id="threadCreateTasksField"'));
    assert.ok(!hostSrc.includes('id="threadCreateTasksBtn"'));
  });

  it('Thread view surfaces Create Task when eligible', () => {
    assert.ok(tyneJs.includes("msg.type === 'taskCreationEligibility'"));
    assert.ok(tyneJs.includes("primaryAction: 'createFromEpic'"));
    assert.ok(hostSrc.includes("type: 'taskCreationEligibility'"));
    assert.ok(hostSrc.includes('id="proofTemplateList"'));
    assert.ok(tyneJs.includes('tasksMgr.renderPmIntelligence(state.pmTaskContext)'));
  });

  it('Fix 2: decompose wizard is a page-agnostic overlay', () => {
    assert.ok(hostSrc.includes('story-decompose-overlay'));
    assert.ok(hostSrc.includes('id="storyDecomposePanel"'));
    assert.ok(!hostSrc.includes('Panel lives in the Task detail drawer'));
    assert.ok(tyneJs.includes('Overlay panel is page-agnostic'));
    assert.ok(!tyneJs.includes("showAppView('tasks');\n    vscode.postMessage({ type: 'openTaskDetail'"));
  });

  it('Fix 3: Thread shows proof templates and expands on enrichment', () => {
    assert.ok(tyneJs.includes('function expandProofSectionIfContent'));
    assert.ok(tyneJs.includes('threadEnrichmentNotice'));
    assert.ok(hostSrc.includes('id="threadEnrichmentNotice"'));
    assert.ok(serviceSrc.includes("complete_empty"));
    assert.ok(serviceSrc.includes('hasEnrichmentContent'));
  });

  it('selecting a task hydrates/fetches PM intelligence for proof points', () => {
    assert.ok(hostSrc.includes('_ensurePmIntelligencePosted'));
    const openFn = hostSrc.indexOf('private async _handleOpenTaskDetail(');
    const openBody = hostSrc.slice(openFn, openFn + 1800);
    assert.ok(openBody.includes('_ensurePmIntelligencePosted'), 'card select must surface enrichment');
    const loadFn = hostSrc.indexOf('private async _loadTaskIntoThread(');
    const loadBody = hostSrc.slice(loadFn, loadFn + 1200);
    assert.ok(loadBody.includes('hasActionableEnrichment(stored)'), 'Thread must not reuse goal-only cached intelligence');
    assert.ok(tyneJs.includes('if (d.pmIntelligence) { this.renderPmIntelligence(d.pmIntelligence); }'));
    assert.ok(tyneJs.includes('loadTaskIntoThread(card.dataset.taskId)'), 'card click must load Thread');
    assert.ok(serviceSrc.includes('hasActionableEnrichment'));
  });

  it('Phase 2/3: Thread is a tab inside Tasks, not a sibling page', () => {
    assert.ok(hostSrc.includes('id="tasksInnerTabs"'));
    assert.ok(hostSrc.includes('id="tasksListPanel"'));
    assert.ok(hostSrc.includes('id="threadPage"'));
    assert.ok(hostSrc.includes('class="tab-panel active" id="threadPage"') || hostSrc.includes('class="tab-panel" id="threadPage"'));
    assert.ok(!hostSrc.includes('class="page active" id="threadPage"'));
    assert.ok(!hostSrc.includes('class="page" id="threadPage"'));
    assert.ok(!hostSrc.includes('data-nav="thread"'), 'Phase 3: Thread rail removed');
    assert.ok(tyneJs.includes("view === 'thread'"));
    assert.ok(tyneJs.includes("setTasksInnerTab('thread')"));
    assert.ok(tyneJs.includes("showAppView(screen === 'main' ? 'thread'"));
    assert.ok(hostSrc.includes('data-tasks-tab="thread"'));
    assert.ok(hostSrc.indexOf('data-tasks-tab="thread"') < hostSrc.indexOf('data-tasks-tab="list"'), 'Thread tab comes first');
    assert.ok(hostSrc.includes('id="tasksPageTitle"'));
    assert.ok(!hostSrc.includes('<span class="page-title">Thread</span>'), 'no nested Thread heading');
    // Phase 3: host navigates to Tasks + Thread tab (legacy page:'thread' still accepted in webview).
    assert.ok(hostSrc.includes("page: 'tasks', tab: 'thread'") || hostSrc.includes('page: \'tasks\', tab: \'thread\''));
    assert.ok(tyneJs.includes("msg.page === 'thread' || msg.tab === 'thread'"));
    assert.ok(!hostSrc.includes("page: 'thread'"));
  });

  it('service module stays free of vscode imports', () => {
    assert.ok(!serviceSrc.includes("from 'vscode'"));
    assert.ok(!serviceSrc.includes('from "vscode"'));
  });
});
