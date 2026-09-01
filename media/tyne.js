// Tyne webview controller. Talks to TyneSidebarProvider via the documented
// message protocol. Presentation only — all git/AI/auth work happens host-side.
(function () {
  const vscode = acquireVsCodeApi();
  const persistedWebviewState = (typeof vscode.getState === 'function' && vscode.getState()) || {};

  let state = { appName: '', taskId: '', taskTitle: '', taskSource: 'Solo Mode', taskUrl: '', taskIssueType: '', goal: '', status: 'waiting', subtasks: [], validationResult: null, validationOverride: false, branchName: '', stitchCount: 0, lastStitchTime: '', pmTaskContext: null, pmTaskValidationResult: null, validateReviewResult: null, latestValidateReviewReportId: '', pmEnrichmentStatus: 'skipped', pmEnrichmentError: '', acceptanceCriteria: [], proofPointTemplates: [], validationSteps: [] };
  // Applied fixes are only undoable while the host keeps the matching edit record.
  let appliedFindingFixes = {};
  delete persistedWebviewState.appliedFindingFixes;
  let discardedFindingFixes = persistedWebviewState.discardedFindingFixes || {};
  let sentAgentFixes = persistedWebviewState.sentAgentFixes || {};
  /** Explicit checkbox overrides keyed by findingFixKey. Absent = default (applyable/agent on). */
  let batchFindingSelection = persistedWebviewState.batchFindingSelection || {};
  let findingFeedbackByKey = persistedWebviewState.findingFeedbackByKey || {};
  let pendingGoalFeedbackByKey = persistedWebviewState.pendingGoalFeedbackByKey || {};
  let actionNeededVerbosity = ['focus', 'balanced', 'thorough'].indexOf(persistedWebviewState.actionNeededVerbosity) >= 0
    ? persistedWebviewState.actionNeededVerbosity
    : 'balanced';
  let saveTimer = null;
  let resetTimer = null;
  let shippedTimer = null;
  let prPanelTimer = null;
  let localHasStitch = false;
  let tieKnotUnlocked = false;
  let activeView = 'tasks';
  let tasksInnerTab = 'thread'; // 'thread' | 'list' — Thread is default
  let isAuthenticated = false;
  let githubUsername = '';
  let userEmail = '';
  let userGithubId = '';
  let projectLeadMode = false;
  let activeDriftFile = '';
  let sessionStart = 0;
  let shipped = false;
  let userTier = 'UNKNOWN';
  let userCredits = 0;
  let tasksCache = [];
  let branchData = { currentBranchName: '', currentBranchRecord: null, selectedTaskBranch: null, branches: [] };
  let commitData = { currentBranchName: '', currentBranchCommits: [], currentBranchSessions: [], taskCommits: [], taskSessions: [], summaries: {} };
  let timeData = { taskSummary: null, branchSummary: null, projectSummary: null, dailySummary: null, weeklySummary: null, monthlySummary: null, taskLogs: [], branchLogs: [], manualEntries: [], allLogs: [], allManuals: [], analytics: null, analyticsTasks: [], selectedTaskId: null };
  let editingManualEntryId = null;
  let automationData = { settings: null, syncState: null, conflict: null, events: [], detectorState: null, userTier: 'free' };
  let automationSettingsDirty = false;
  let suppressAutomationDirty = false;
  let previewedFeedbackBody = null;
  let previewedFeedbackAction = 'post';
  let selectedCommitHash = '';
  let velocityMetric = 'commits';
  let velocityRangeDays = 14; // 7 | 14 | 30 | 0(all)
  let aiSettings = { aiAccessMode: 'max', aiProvider: 'claude', hasBYOKKey: false, byokConfig: null, aiUsageUsed: 0, aiUsageLimit: 50, validationUsage: null, validationResult: null };
  let jiraIntegration = { configured: false, connected: false, cloudId: '', siteName: '', siteUrl: '', projectKeys: [], selectedProject: null };
  let pmIntegration = { connectedTools: [], jira: null, linear: null };
  let _tasksConnectedTools = [];
  let _tasksConnectingTools = [];
  const TOOL_LABEL = { linear: 'Linear', jira: 'Jira', asana: 'Asana', notion: 'Notion', monday: 'Monday' };

  // #region agent log
  function agentDebugLog(hypothesisId, location, message, data) {
    try {
      vscode.postMessage({
        type: 'debugLog',
        payload: { runId: 'audit1', hypothesisId, location, message, data },
      });
    } catch (_err) { /* ignore */ }
  }
  // #endregion

  function mergeConnectedToolsFromSnapshot(incoming, snapshot) {
    // Host payload is authoritative when it sends connectedTools (including []).
    // Do not union with stale local/persisted tools — that made Disconnect look stuck.
    if (Array.isArray(incoming)) {
      return incoming.slice();
    }
    const next = new Set();
    const pm = (snapshot && snapshot.pmIntegration) || pmIntegration || {};
    const jira = (snapshot && snapshot.jiraIntegration) || jiraIntegration || {};
    if (jira.connected || (pm.jira || {}).connected) { next.add('jira'); }
    if ((pm.linear || {}).connected) { next.add('linear'); }
    return Array.from(next);
  }

  function pmToolIsConnected(tool) {
    // Prefer the authoritative connectedTools list from the host.
    if (Array.isArray(_tasksConnectedTools) && _tasksConnectedTools.includes(tool)) { return true; }
    const pm = pmIntegration || {};
    const connectedTools = Array.isArray(pm.connectedTools) ? pm.connectedTools : [];
    if (connectedTools.includes(tool)) { return true; }
    // Only fall back to flags when the tools list is unknown (pre-hydrate).
    if (Array.isArray(_tasksConnectedTools) || Array.isArray(pm.connectedTools)) {
      return false;
    }
    if (tool === 'jira') { return Boolean((pm.jira || {}).connected || jiraIntegration.connected); }
    if (tool === 'linear') { return Boolean((pm.linear || {}).connected); }
    return false;
  }

  function persistIntegrationState() {
    if (typeof vscode.setState !== 'function') { return; }
    const prior = (typeof vscode.getState === 'function' && vscode.getState()) || {};
    vscode.setState(Object.assign({}, prior, {
      connectedTools: _tasksConnectedTools.slice(),
      pmIntegration,
      jiraIntegration,
    }));
  }

  function syncConnectedToolsFromPayload(payload) {
    if (!payload) { return; }
    if (payload.jiraIntegration) {
      jiraIntegration = {
        ...jiraIntegration,
        ...payload.jiraIntegration,
        // Trust host — never sticky-OR previous connected:true after Disconnect.
        connected: Boolean(payload.jiraIntegration.connected),
        reconnectRequired: payload.jiraIntegration.reconnectRequired === undefined
          ? false
          : payload.jiraIntegration.reconnectRequired,
      };
    }
    if (payload.pmIntegration) {
      const incoming = payload.pmIntegration;
      const tools = Array.isArray(incoming.connectedTools)
        ? incoming.connectedTools.slice()
        : (Array.isArray(payload.connectedTools) ? payload.connectedTools.slice() : []);
      pmIntegration = {
        ...pmIntegration,
        ...incoming,
        githubConnected: incoming.githubConnected !== undefined ? incoming.githubConnected : pmIntegration.githubConnected,
        jira: {
          ...(pmIntegration.jira || {}),
          ...(incoming.jira || {}),
          connected: Boolean((incoming.jira || {}).connected),
        },
        linear: {
          ...(pmIntegration.linear || {}),
          ...(incoming.linear || {}),
          connected: Boolean((incoming.linear || {}).connected),
        },
        connectedTools: tools,
      };
      _tasksConnectedTools = tools.slice();
    } else if (Array.isArray(payload.connectedTools)) {
      _tasksConnectedTools = payload.connectedTools.slice();
      pmIntegration = { ...pmIntegration, connectedTools: _tasksConnectedTools.slice() };
    }
    _tasksConnectingTools = _tasksConnectingTools.filter(tool => !_tasksConnectedTools.includes(tool));
    persistIntegrationState();
  }

  function markPmToolConnectedLocally(tool, snapshot) {
    if (!tool) { return; }
    _tasksConnectingTools = _tasksConnectingTools.filter(t => t !== tool);
    syncConnectedToolsFromPayload(snapshot || { tool, connectedTools: [tool] });
    if (!_tasksConnectedTools.includes(tool)) { _tasksConnectedTools.push(tool); }
    pmIntegration = {
      ...pmIntegration,
      connectedTools: Array.from(new Set([...(pmIntegration.connectedTools || []), tool])),
    };
    if (tool === 'jira') {
      jiraIntegration = { ...jiraIntegration, connected: true, reconnectRequired: false };
      pmIntegration.jira = { ...(pmIntegration.jira || {}), connected: true };
    } else if (tool === 'linear') {
      pmIntegration.linear = { ...(pmIntegration.linear || {}), connected: true };
    }
    persistIntegrationState();
    // #region agent log
    agentDebugLog('C', 'tyne.js:markPmToolConnectedLocally', 'local connect mark applied', {
      tool,
      connectedTools: _tasksConnectedTools.slice(),
      jiraConnected: Boolean(jiraIntegration.connected),
      pmJira: Boolean((pmIntegration.jira || {}).connected),
      pmLinear: Boolean((pmIntegration.linear || {}).connected),
      pmToolJira: pmToolIsConnected('jira'),
      pmToolLinear: pmToolIsConnected('linear'),
    });
    // #endregion
    renderIntegrations();
    renderPmConnectButtons();
    if (typeof tasksMgr !== 'undefined' && tasksMgr) {
      tasksMgr.renderConnectionState();
      tasksMgr.renderToolBadges();
    }
  }

  // Connection flags come from the host only — never restore sticky Connected from webview persist.
  if (persistedWebviewState.pmIntegration) {
    const prior = persistedWebviewState.pmIntegration;
    pmIntegration = {
      ...pmIntegration,
      ...prior,
      githubConnected: undefined,
      connectedTools: [],
      jira: { ...(prior.jira || {}), connected: false },
      linear: { ...(prior.linear || {}), connected: false },
    };
  }
  if (persistedWebviewState.jiraIntegration) {
    jiraIntegration = {
      ...jiraIntegration,
      ...persistedWebviewState.jiraIntegration,
      connected: false,
      reconnectRequired: false,
    };
  }
  // Do not sticky-merge persisted tools — host settingsLoaded is the source of truth.

  let validationHistory = [];
  let validationTrends = null;
  let reviewTrends = null;
  let validationTier = 'free';
  let validationStages = [];
  let validationTrace = null;
  let expandedTraceSteps = {};
  let validationRunningTier = 'free';
  let valCountRemaining = null;
  let valCountTotal = null;
  let valPanelState = 'idle'; // 'idle' | 'running' | 'done' | 'error'
  let valLastError = null;
  let valTimelineExpanded = false; // show full step-by-step timeline while running
  let valDetailsExpanded = false;  // expand the result scorecard beyond the score summary
  /** Live proof-point strike state during / after Validate & Review. */
  let proofLive = {
    active: false,
    /** @type {Record<string, 'pending'|'checking'|'done'|'missed'>} */
    statusById: {},
    /** ids currently playing the strike draw animation */
    strikingIds: {},
    timers: [],
    /** AC / progress strikes buffered while the checklist is hidden during review */
    pendingMetTexts: [],
  };
  let gitStatus = { currentBranch: '', stagedFiles: 0, unstagedFiles: 0, isClean: true, hasActiveTask: false, isWeaving: false, ctaReason: 'no_active_task' };
  let codeReview = { result: null, mode: 'staged_changes', running: false, error: null, reports: [], selectedReportId: null };
  let validateReview = { result: null, reports: [], selectedReportId: null, running: false, error: null, upgradeRequired: false, filter: 'all', search: '', viewMode: 'structured', progressStage: '', startedAt: 0 };
  /** Where the current run was started: Thread stays put; Reviews page uses full-page runner. */
  let validateReviewOrigin = 'page'; // 'thread' | 'page'
  let validateReviewEtaTimer = null;
  let betaBugKind = 'bug';
  let betaBugSending = false;
  let billingCheckoutBusy = false;

  const fallbackTasks = [
    { id: 'PRO-102', title: 'Implement OAuth refresh handling and PR validation context', source: 'Solo Mode' },
    { id: 'PRO-118', title: 'Tighten billing state sync before checkout handoff', source: 'Solo Mode' },
    { id: 'PRO-121', title: 'Document VS Code authentication setup for reviewers', source: 'Solo Mode' }
  ];

  const $ = (id) => document.getElementById(id);
  const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const fmtMinutes = (m) => {
    const mins = Math.max(0, Number(m || 0));
    const h = Math.floor(mins / 60), r = mins % 60;
    return h > 0 ? h + 'h ' + r + 'm' : r + 'm';
  };
  const fmtRelative = (iso) => {
    if (!iso) return '—';
    const diff = Math.max(0, Date.now() - new Date(iso).getTime());
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return mins + 'm ago';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
  };

  function updateToggleCount(targetId, count) {
    document.querySelectorAll('.toggle-count[data-target="' + targetId + '"]').forEach(el => el.textContent = String(count));
  }

  // Defer until all integration helpers and task state are initialized.
  requestValidationHistory();
  requestValidationTrends();

  // ---------- Navigation / screens ----------
  function setTasksInnerTab(tab) {
    tasksInnerTab = tab === 'list' ? 'list' : 'thread';
    const list = $('tasksListPanel');
    const thread = $('threadPage');
    const title = $('tasksPageTitle');
    const syncBtn = $('pullTasksBtn');
    const syncDot = $('taskSyncDot');
    if (list) { list.classList.toggle('active', tasksInnerTab === 'list'); }
    if (thread) { thread.classList.toggle('active', tasksInnerTab === 'thread'); }
    if (title) { title.textContent = tasksInnerTab === 'thread' ? 'Thread' : 'Tasks'; }
    if (syncBtn) { syncBtn.classList.toggle('hidden', tasksInnerTab !== 'list'); }
    if (syncDot) { syncDot.classList.toggle('hidden', tasksInnerTab !== 'list'); }
    document.querySelectorAll('#tasksInnerTabs .tab-btn').forEach(function(btn) {
      const on = btn.dataset.tasksTab === tasksInnerTab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }
  function showAppView(view) {
    // Phase 2/3: Thread is a tab inside Tasks — never a sibling page.
    if (view === 'thread') {
      activeView = 'tasks';
      document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'tasksPage'));
      document.querySelectorAll('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === 'tasks'));
      setTasksInnerTab('thread');
      return;
    }
    // Explicit Tasks list (inner tab only).
    if (view === 'tasksList') {
      activeView = 'tasks';
      document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'tasksPage'));
      document.querySelectorAll('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === 'tasks'));
      setTasksInnerTab('list');
      return;
    }
    // Rail "Tasks" should do what it says. Startup and legacy Thread links still
    // route through showAppView('thread') so the first-run workflow stays intact.
    if (view === 'tasks') {
      activeView = 'tasks';
      document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'tasksPage'));
      document.querySelectorAll('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === 'tasks'));
      setTasksInnerTab('list');
      return;
    }
    activeView = view === 'review' ? 'validateReview' : view === 'time' ? 'analytics' : (view || 'tasks');
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === activeView + 'Page'));
    document.querySelectorAll('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === activeView));
    if (activeView === 'settings') { renderIntegrations(); }
    if (activeView === 'validateReview') { vscode.postMessage({ type: 'loadValidateReviewReports' }); vscode.postMessage({ type: 'getReviewTrends' }); }
    if (activeView === 'analytics') { vscode.postMessage({ type: 'refreshTime' }); }
  }
  function showScreen(screen) {
    if (screen === 'welcome') {
      $('welcomeView').classList.add('active');
      $('shellView').classList.remove('active');
      return;
    }
    $('welcomeView').classList.remove('active');
    $('shellView').classList.add('active');
    showAppView(screen === 'main' ? 'thread' : screen);
  }
  function setAuthenticated(v) {
    isAuthenticated = v;
    showScreen(v ? 'main' : 'welcome');
    const out = $('signoutBtn');
    if (out) out.disabled = !v;
    if (v) { hideGithubExpired(); }
    renderIntegrations();
    syncBetaBugFab();
    if (v) { vscode.postMessage({ type: 'onboardingGetStatus' }); }
    else { hideOnboarding(); }
  }

  let onboardingStep = 'path';
  let onboardingComplete = true;

  function hideOnboarding() {
    const el = $('onboardingOverlay');
    if (el) { el.classList.add('hidden'); }
  }

  function renderOnboardingBody(step) {
    const body = $('onboardingBody');
    const primary = $('onboardingPrimaryBtn');
    if (!body || !primary) { return; }
    if (step === 'path') {
      body.innerHTML =
        '<p class="onboarding-copy">Anchor work to a Solo goal, or connect Jira / Linear from Settings after this tour.</p>' +
        '<div class="onboarding-path-row">' +
        '<button type="button" class="btn primary compact" id="onboardingSoloBtn">Start with Solo goal</button>' +
        '<button type="button" class="btn compact" id="onboardingPmBtn">I will connect Jira/Linear</button>' +
        '</div>';
      primary.classList.add('hidden');
      const solo = $('onboardingSoloBtn');
      const pm = $('onboardingPmBtn');
      if (solo) solo.onclick = () => vscode.postMessage({ type: 'onboardingChooseSolo' });
      if (pm) pm.onclick = () => vscode.postMessage({ type: 'onboardingChoosePm' });
      return;
    }
    primary.classList.remove('hidden');
    if (step === 'thread') {
      body.innerHTML = '<p class="onboarding-copy">Open the Thread tab, fill the brief if needed, then click <strong>Start Thread</strong>. Tyne creates an isolated branch.</p>';
      primary.textContent = 'Open Thread';
      primary.onclick = () => {
        hideOnboarding();
        showAppView('thread');
        vscode.postMessage({ type: 'onboardingOpenedThread' });
      };
      return;
    }
    if (step === 'review') {
      body.innerHTML = '<p class="onboarding-copy">Make a small change (or review existing diffs), then run <strong>Validate &amp; Review</strong>. Hosted Core includes managed runs — no BYOK required for your first review.</p>';
      primary.textContent = 'Open Validate &amp; Review';
      primary.onclick = () => {
        hideOnboarding();
        showAppView('validateReview');
        vscode.postMessage({ type: 'onboardingOpenedReview' });
      };
      return;
    }
    body.innerHTML = '<p class="onboarding-copy">You are set. Use Threads and Validate &amp; Review anytime.</p>';
    primary.textContent = 'Done';
    primary.onclick = () => vscode.postMessage({ type: 'onboardingComplete' });
  }

  function showOnboarding(msg) {
    onboardingComplete = !!msg.complete;
    onboardingStep = msg.step || 'path';
    const el = $('onboardingOverlay');
    if (!el) { return; }
    if (!msg.authenticated || onboardingComplete) {
      hideOnboarding();
      return;
    }
    el.classList.remove('hidden');
    el.querySelectorAll('.onboarding-steps li').forEach(li => {
      const s = li.getAttribute('data-step');
      li.classList.toggle('done', s === 'sign' || (s === 'path' && onboardingStep !== 'path') || (s === 'thread' && (onboardingStep === 'review' || onboardingStep === 'done')) || (s === 'review' && onboardingStep === 'done'));
      li.classList.toggle('active', (s === 'path' && onboardingStep === 'path') || (s === 'thread' && onboardingStep === 'thread') || (s === 'review' && onboardingStep === 'review'));
    });
    renderOnboardingBody(onboardingStep);
  }

  // GitHub session-expired banner: shown when the backend rejects the saved token,
  // so validation/profile failures are explained instead of silently hidden.
  function showGithubExpired(message) {
    isAuthenticated = false;
    const banner = $('githubExpiredBanner');
    const text = $('githubExpiredText');
    if (text && message) { text.textContent = message; }
    if (banner) { banner.classList.remove('hidden'); }
  }
  function hideGithubExpired() {
    const banner = $('githubExpiredBanner');
    if (banner) { banner.classList.add('hidden'); }
  }

  // ---------- Flow state machine ----------
  function selectTask(task) {
    vscode.postMessage({ type: 'standupSelect', task });
    showAppView('thread');
  }
  function currentTaskIssueType() {
    const id = String(state.taskId || '').trim();
    const fromList = (_tasksAll || []).find(function(t) {
      return t && (t.id === id || t.externalId === id || t.id === 'jira:' + id);
    });
    return fromList ? (fromList.issueType || '') : (state.taskIssueType || '');
  }
  function startStoryDecomposeForTask(taskId, tool) {
    if (!taskId) { return; }
    const t = tool || state.taskSource || 'jira';
    // Overlay panel is page-agnostic — stay on the current page.
    storyDecompose.start(taskId, t);
  }
  // Create a lightweight "Solo Mode" task straight from the brief fields and
  // select it — lets the user add a task on the thread page without a connected
  // PM tool or leaving for the Tasks view.
  function addInlineTask() {
    const tid = ((($('taskId') || {}).value) || '').trim() || ('T-' + String(Date.now()).slice(-5));
    const title = ((($('goal') || {}).value) || '').trim() || tid;
    selectTask({ id: tid, title: title, source: 'Solo Mode' });
  }
  function runFlowAction(action) {
    if (action === 'selectTask') { selectTask(tasksCache[0] || fallbackTasks[0]); return; }
    if (action === 'addTask') { addInlineTask(); return; }
    if (action === 'createFromEpic') {
      startStoryDecomposeForTask(
        state.taskId,
        state.taskSource || (((_tasksAll || []).find(function(t) { return t && t.id === state.taskId; }) || {}).sourceTool) || 'jira',
      );
      return;
    }
    if (action === 'startThread') { vscode.postMessage({ type: 'buttonClick', action: 'startThread' }); return; }
    if (action === 'switchSelectedBranch') { vscode.postMessage({ type: 'buttonClick', action: 'switchSelectedBranch' }); return; }
    if (action === 'saveStitch') { vscode.postMessage({ type: 'buttonClick', action: 'saveStitch' }); return; }
    if (action === 'validateGoal' || action === 'validateReview') {
      if (!validateReview.running) {
        beginValidateReviewFromThread();
      }
      vscode.postMessage({ type: 'buttonClick', action: 'validateReview' });
      return;
    }
    if (action === 'generateCommitPreview') { vscode.postMessage({ type: 'buttonClick', action: 'generateCommitPreview' }); return; }
    if (action === 'tieKnot') { vscode.postMessage({ type: 'buttonClick', action: 'tieKnot' }); return; }
    if (action === 'overrideProceed') { vscode.postMessage({ type: 'buttonClick', action: 'overrideProceed' }); return; }
    if (action === 'openAi') { showAppView('settings'); }
  }
  function getFlowState() {
    const hasTask = Boolean((state.taskId || '').trim());
    const hasBrief = Boolean((state.appName || '').trim() && (state.goal || '').trim());
    const weaving = state.status === 'weaving';
    const linkedTaskBranch = branchData.selectedTaskBranch;
    const validation = state.validationResult;
    const report = validateReview && validateReview.result;
    const passed = validation && validation.status === 'pass';
    const depthPartial = Boolean(
      (validation && (validation.validationStatus === 'context_limited' || validation.status === 'partial')) ||
      (report && (report.status === 'context_limited' || report.actualModeUsed === 'triage'))
    );
    const shipAdvice = report ? deriveOverallVerdict(report) : '';
    const securityBlocked = shipAdvice === 'block' ||
      (report && String(report.securityStatus || '').toLowerCase() === 'blocked');
    const needsOverride = Boolean(
      validation && !tieKnotUnlocked && (
        !passed ||
        depthPartial ||
        shipAdvice === 'changes_requested' ||
        securityBlocked
      )
    );
    const issueType = currentTaskIssueType();
    const decomposable = isDecomposableType(issueType);
    const createLabel = /epic/i.test(issueType) ? 'Create tasks from epic' : 'Create tasks from stories';
    if (shipped) return { key: 'done', index: 4, primary: 'Next task', primaryAction: 'selectTask', secondary: '', secondaryAction: '' };
    if (!hasTask) return { key: 'task', index: 0, primary: 'Select task', primaryAction: 'selectTask', secondary: 'AI setup', secondaryAction: 'openAi' };
    // Match Task detail: Epic/Story primary action is decompose, not Start thread.
    if (!weaving && decomposable) return { key: 'decompose', index: 1, primary: createLabel, primaryAction: 'createFromEpic', secondary: hasBrief ? 'Start thread' : 'AI setup', secondaryAction: hasBrief ? 'startThread' : 'openAi' };
    if (!weaving && linkedTaskBranch) return { key: 'linked', index: 1, primary: 'Switch to branch', primaryAction: 'switchSelectedBranch', secondary: 'AI setup', secondaryAction: 'openAi' };
    if (!weaving) return { key: 'start', index: 1, primary: hasBrief ? 'Start thread' : 'Complete brief', primaryAction: hasBrief ? 'startThread' : 'selectTask', secondary: 'AI setup', secondaryAction: 'openAi' };
    // Weaving on an epic/story: Create stays primary until Validate has run.
    if (weaving && decomposable && !validation) return { key: 'stitch_decompose', index: 1, primary: createLabel, primaryAction: 'createFromEpic', secondary: 'Save stitch', secondaryAction: 'saveStitch' };
    if (weaving && gitStatus.unstagedFiles > 0 && gitStatus.stagedFiles === 0 && !validation) return { key: 'stage_hint', index: 1, primary: 'Save stitch', primaryAction: 'saveStitch', secondary: 'Run Review', secondaryAction: 'validateReview' };
    if (weaving && (state.stitchCount || 0) < 3 && !validation && gitStatus.stagedFiles === 0) return { key: 'stitch', index: 1, primary: 'Save stitch', primaryAction: 'saveStitch', secondary: 'Run Review', secondaryAction: 'validateReview' };
    if (weaving && !validation) {
      const needsKey = aiSettings.aiAccessMode === 'byok' && !aiSettings.hasBYOKKey;
      return { key: 'validate', index: 2, primary: needsKey ? 'AI setup' : 'Run Review', primaryAction: needsKey ? 'openAi' : 'validateReview', secondary: needsKey ? 'Run Review anyway' : 'Save stitch', secondaryAction: needsKey ? 'validateReview' : 'saveStitch' };
    }
    if (needsOverride) {
      return {
        key: 'blocked',
        index: 2,
        primary: 'Run Review',
        primaryAction: 'validateReview',
        secondary: 'Override',
        secondaryAction: 'overrideProceed',
      };
    }
    return { key: 'ship', index: 3, primary: 'Tie the knot', primaryAction: 'tieKnot', secondary: 'Save stitch', secondaryAction: 'saveStitch' };
  }
  function renderFlow() {
    const flow = getFlowState();
    const p = $('flowPrimaryBtn'), s = $('flowSecondaryBtn');
    const moreWrap = $('flowMoreWrap');
    const moreMenu = $('flowMoreMenu');
    const moreBtn = $('flowMoreBtn');
    const threadBusy = validateReview.running && validateReviewOrigin === 'thread';
    if (p) {
      p.textContent = threadBusy ? 'Reviewing…' : flow.primary;
      p.dataset.flowAction = flow.primaryAction;
      p.disabled = threadBusy;
    }
    if (s) {
      s.textContent = flow.secondary || '';
      s.dataset.flowAction = flow.secondaryAction || '';
    }
    if (moreWrap) { moreWrap.classList.toggle('hidden', !flow.secondary || threadBusy); }
    if (moreMenu) { moreMenu.classList.add('hidden'); }
    if (moreBtn) { moreBtn.setAttribute('aria-expanded', 'false'); }
    // "Add task" is only meaningful before a task is chosen.
    const addBtn = $('addTaskBtn');
    if (addBtn) { addBtn.classList.toggle('hidden', Boolean((state.taskId || '').trim())); }
  }

  // ---------- Metrics / status ----------
  function fmtElapsed() {
    if (!sessionStart) return '0m';
    const s = Math.floor((Date.now() - sessionStart) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  }
  function renderDeck() {
    const mTask = $('mTask');
    if (mTask) { mTask.textContent = shortTaskKey() || state.taskId || '—'; }
    const stitches = Number(state.stitchCount || 0);
    const mStitch = $('mStitch');
    if (mStitch) { mStitch.textContent = String(stitches); }
    const stitchWrap = $('mStitchWrap');
    if (stitchWrap) { stitchWrap.classList.toggle('hidden', stitches <= 0); }
    const mTime = $('mTime');
    if (mTime) {
      mTime.textContent = state.status === 'weaving' ? (fmtElapsed() + ' ago') : '0m';
    }
    renderFlow();
  }
  setInterval(renderDeck, 1000);

  function renderAiUsage() {
    const label = $('usageLabel'), text = $('usageText'), fill = $('usageFill');
    if (!label || !text || !fill) { return; }
    const validationUsage = aiSettings.validationUsage;
    const isMax = userTier === 'MAX' || userTier === 'max';
    const used = Number((validationUsage?.used ?? aiSettings.aiUsageUsed) || 0);
    const unlimited = isMax
      || validationUsage?.limit === 'unlimited'
      || validationUsage?.isUnlimited === true
      || aiSettings.aiUsageLimit === -1;
    const rawLimit = unlimited
      ? null
      : Number((validationUsage?.limit ?? aiSettings.aiUsageLimit) || 0);
    const limit = rawLimit && rawLimit > 0 ? rawLimit : null;
    const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    if (userTier === 'UNKNOWN') {
      label.textContent = 'Plan not connected'; text.textContent = '—'; fill.style.width = '0%';
    } else if (unlimited) {
      label.textContent = 'Validation usage';
      text.textContent = aiSettings.validationUsageText || 'Validations: Unlimited';
      fill.style.width = '0%';
    } else if (validationUsage && limit) {
      label.textContent = 'Validation usage';
      text.textContent = aiSettings.validationUsageText || (used + ' / ' + limit);
      fill.style.width = pct + '%';
    } else {
      label.textContent = 'Validation usage';
      text.textContent = 'loading\u2026';
      fill.style.width = '0%';
    }
  }

  function setMode(resetMs) {
    if (resetTimer) clearTimeout(resetTimer);
    const runner = $('flowRunner'), fill = $('flowRunnerFill');
    if (runner && fill && resetMs) {
      runner.classList.add('on');
      fill.style.animation = 'none';
      void fill.getBoundingClientRect();
      fill.style.animation = 'fillBar ' + resetMs + 'ms linear forwards';
      resetTimer = setTimeout(() => runner.classList.remove('on'), resetMs);
    }
  }

  // Quiet progress: route former pixel theater through the global runner bar.
  let pixelHideTimer = null;
  function showPixel(_variant, _label, autoHideMs) {
    setRunner(true);
    if (pixelHideTimer) { clearTimeout(pixelHideTimer); pixelHideTimer = null; }
    if (autoHideMs) {
      pixelHideTimer = setTimeout(function() { hidePixel(); }, autoHideMs);
    }
  }
  function hidePixel() {
    if (pixelHideTimer) { clearTimeout(pixelHideTimer); pixelHideTimer = null; }
    setRunner(false);
  }

  // Global zipline runner — shown at the top of the sidebar for any long-running
  // host action. The host posts { type: 'runner', on: true/false } to drive it,
  // so the bar stays animating for the REAL duration of the work and is the single
  // source of truth for when it stops. It's an indeterminate (looping) bar — it
  // never "completes" on its own, which previously made it look finished while the
  // page was still loading.
  let runnerSafetyTimer = null;

  let pmThinkTimer = null;
  let pmThinkActive = false;
  const PM_THINK_STEPS = [
    'Pulling issue context',
    'Reading acceptance criteria',
    'Drafting proof points',
    'Mapping validation steps',
  ];

  function startPmThinkUI(title) {
    pmThinkActive = true;
    if (pmThinkTimer) { clearInterval(pmThinkTimer); pmThinkTimer = null; }
    const shortTitle = String(title || '').trim();
    const headline = shortTitle ? ('Reading ' + shortTitle.slice(0, 48) + (shortTitle.length > 48 ? '…' : '')) : 'Extracting PM intelligence';
    showPixel('think', headline);
    let step = 0;
    const updateSteps = function() {
      document.querySelectorAll('.pm-think-step').forEach(function(el) {
        el.textContent = PM_THINK_STEPS[step];
      });
      step = (step + 1) % PM_THINK_STEPS.length;
    };
    updateSteps();
    pmThinkTimer = setInterval(updateSteps, 1800);
    document.querySelectorAll('.pm-intelligence-loading').forEach(function(el) {
      el.classList.remove('hidden');
    });
  }

  function stopPmThinkUI() {
    if (pmThinkTimer) { clearInterval(pmThinkTimer); pmThinkTimer = null; }
    if (pmThinkActive) {
      pmThinkActive = false;
      hidePixel();
    }
    document.querySelectorAll('.pm-intelligence-loading').forEach(function(el) {
      el.classList.add('hidden');
    });
  }

  function rewriteAuthError(message) {
    const m = String(message || '');
    if (/invalid github token|invalid auth token|session expired|sign in again|unauthorized|\(HTTP 401\)/i.test(m)) {
      return 'Session expired. Sign in again.';
    }
    return m;
  }

  function syncProofSection(forceCollapse) {
    const body = $('proofBody');
    const toggle = document.querySelector('.proof-toggle');
    const countEl = $('proofToggleCount');
    const notice = $('threadEnrichmentNotice');
    const subs = state.subtasks || [];
    // Templates are seeded into the checklist on the host — no second "suggested" list.
    const templateList = $('proofTemplateList');
    if (templateList) { templateList.innerHTML = ''; }
    if (notice) {
      const failed = state.pmEnrichmentStatus === 'failed';
      const empty = state.pmEnrichmentStatus === 'partial'
        && !subs.length && !(state.acceptanceCriteria || []).length
        && !(state.proofPointTemplates || []).length;
      if (failed || empty) {
        notice.classList.remove('hidden');
        notice.textContent = failed
          ? rewriteAuthError(state.pmEnrichmentError || 'PM enrichment failed.')
          : 'PM enrichment returned no proof points or subtasks.';
      } else {
        notice.classList.add('hidden');
        notice.textContent = '';
      }
    }
    const live = proofLive.active || valPanelState === 'running' || valPanelState === 'done' || valPanelState === 'error';
    let doneCount = 0;
    subs.forEach(function(t) {
      const st = proofLive.statusById[t.id] || (t.done ? 'done' : 'pending');
      if (st === 'done' || t.done) { doneCount += 1; }
    });
    const allDone = subs.length > 0 && doneCount === subs.length;
    const passed = state.validationResult && state.validationResult.status === 'pass';
    if (countEl) {
      countEl.textContent = subs.length ? doneCount + '/' + subs.length + ' done' : '';
    }
    const title = $('proofSectionTitle');
    if (title) {
      title.textContent = valPanelState === 'running'
        ? 'Reviewing'
        : (valPanelState === 'done' || valPanelState === 'error' ? 'Review' : 'Proof points');
    }
    const addRow = $('proofAddRow');
    if (addRow) { addRow.classList.toggle('hidden', valPanelState === 'running'); }
    const subList = $('subtaskList');
    if (subList) { subList.classList.toggle('hidden', valPanelState === 'running'); }
    const counter = $('valCounterBar');
    if (counter) { counter.classList.toggle('hidden', valPanelState === 'idle'); }
    const ctaRow = document.querySelector('#threadPage .thread-cta-row');
    if (ctaRow) {
      ctaRow.classList.toggle('hidden', valPanelState === 'done' || valPanelState === 'running' || valPanelState === 'error');
    }
    const metrics = $('threadReviewMetrics');
    if (metrics && (valPanelState === 'done' || valPanelState === 'running')) {
      metrics.classList.add('hidden');
      metrics.innerHTML = '';
    }
    syncThreadGithubBanner();
    if (!body || !toggle) { return; }
    const arrow = toggle.querySelector('.toggle-arrow');
    // Keep open while a review is in flight or showing results.
    if (live) {
      body.classList.remove('hidden');
      if (arrow) { arrow.innerHTML = '&#9660;'; }
      return;
    }
    if ((forceCollapse || (passed && allDone)) && subs.length) {
      body.classList.add('hidden');
      if (arrow) { arrow.innerHTML = '&#9658;'; }
    }
  }

  function syncThreadGithubBanner() {
    const banner = $('threadGithubBanner');
    if (!banner) { return; }
    const weaving = state.status === 'weaving' && Boolean(state.branchName);
    const connected = pmIntegration.githubConnected === true;
    banner.classList.toggle('hidden', !weaving || connected);
  }

  function expandProofSectionIfContent() {
    syncProofSection(false);
    if (!(state.subtasks || []).length) { return; }
    const body = $('proofBody');
    const arrow = document.querySelector('.proof-toggle .toggle-arrow');
    if (body) { body.classList.remove('hidden'); }
    if (arrow) { arrow.innerHTML = '&#9660;'; }
  }

  function setRunner(on) {
    const runner = $('globalRunner'), fill = $('globalRunnerFill');
    if (!runner || !fill) { return; }
    if (runnerSafetyTimer) { clearTimeout(runnerSafetyTimer); runnerSafetyTimer = null; }
    if (on) {
      runner.classList.add('on');
      fill.style.animation = 'none';
      void fill.getBoundingClientRect();
      fill.style.animation = 'runnerSlide 1.1s linear infinite';
      // Long fallback only — never strand the bar if a stop message is lost. The
      // host's runner:false is the normal stop; this must be far longer than any
      // real action so it never ends the animation before the work finishes.
      runnerSafetyTimer = setTimeout(() => setRunner(false), 60000);
    } else {
      runner.classList.remove('on');
      fill.style.animation = 'none';
    }
  }

  function setReviewRunner(on) {
    const runner = $('reviewRunner'), fill = $('reviewRunnerFill');
    if (!runner || !fill) { return; }
    runner.classList.toggle('on', on);
    fill.style.animation = on ? 'runnerSlide 1.1s linear infinite' : 'none';
    if (on) { setTimeout(() => setReviewRunner(false), 60000); }
  }

  function shortTaskKey() {
    const ctx = state.pmTaskContext || {};
    const fromCtx = (ctx.issueIdentifier || ctx.issueKey || '').trim();
    if (fromCtx && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(fromCtx)) { return fromCtx; }
    const fromList = (_tasksAll || []).find(function(t) { return t && t.id === state.taskId; });
    if (fromList && fromList.externalId && fromList.externalId !== fromList.title) { return fromList.externalId; }
    const raw = String(state.taskId || '').replace(/^(linear|jira|asana|notion|monday):/i, '').trim();
    if (!raw || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(raw)) { return ''; }
    return raw;
  }

  function shortBranchLabel(name) {
    const full = String(name || '').trim();
    if (!full) { return ''; }
    if (full.length <= 48) { return full; }
    const slash = full.lastIndexOf('/');
    const tail = slash >= 0 ? full.slice(slash + 1) : full;
    if (tail.length <= 48) { return tail; }
    return '…' + tail.slice(-46);
  }

  function splitHeroTitle(raw) {
    const t = String(raw || '').trim();
    const m = t.match(/^(.+?)\s*[—–-]\s+(.+)$/);
    if (m) { return { prefix: m[1].trim(), title: m[2].trim() }; }
    return { prefix: '', title: t || 'Active thread' };
  }

  function applyStatus() {
    const weaving = state.status === 'weaving';
    const inlinePill = $('threadStatusPill'), inlineTxt = $('threadStatusText');
    function paintPill(el, labelEl) {
      if (!el || !labelEl) { return; }
      el.classList.remove('standby', 'weaving', 'shipped');
      if (shipped) { el.classList.add('shipped'); labelEl.textContent = 'Shipped'; }
      else if (weaving) { el.classList.add('weaving'); labelEl.textContent = tieKnotUnlocked ? (state.validationOverride ? 'Override · your risk' : 'Clear to ship') : 'Weaving'; }
      else { el.classList.add('standby'); labelEl.textContent = 'Standby'; }
    }
    paintPill(inlinePill, inlineTxt);

    const usageWrap = $('usageWrap');
    if (usageWrap) {
      const hasUsage = userTier !== 'UNKNOWN' || Boolean(aiSettings.validationUsage);
      usageWrap.classList.toggle('hidden', !hasUsage);
    }

    const hasBYOK = aiSettings.hasBYOKKey;
    const usageBlocked = Boolean(aiSettings.validationUsage && aiSettings.validationUsage.isBlocked);
    // Core hard-caps at 5 even with BYOK; Pro can continue via BYOK after managed quota.
    const blockGoalValidation = usageBlocked && (normalizedPlanTier() === 'free' || !hasBYOK);

    const hasTask = Boolean((state.taskId || '').trim());
    $('briefSection').classList.toggle('hidden', weaving);
    // Refresh the ranked suggestion when a thread starts or ends.
    renderThreadSuggestion();
    $('briefSummary').classList.toggle('hidden', !weaving || !state.branchName);
    if (weaving && state.branchName) {
      const split = splitHeroTitle(state.taskTitle || state.goal || 'Active thread');
      const goal = (state.goal || '').trim();
      const key = shortTaskKey();
      const eyebrow = $('bsEyebrow');
      if (eyebrow) {
        eyebrow.textContent = key || split.prefix || 'Thread';
        eyebrow.classList.toggle('hidden', !key && !split.prefix);
      }
      const hero = $('bsGoal');
      if (hero) { hero.textContent = split.title; }
      const sub = $('bsGoalSub');
      if (sub) {
        const showGoal = goal
          && goal.toLowerCase() !== split.title.toLowerCase()
          && !(state.taskTitle || '').toLowerCase().includes(goal.toLowerCase());
        sub.textContent = showGoal ? goal : '';
        sub.classList.toggle('hidden', !showGoal);
      }
      const bsTask = $('bsTask');
      if (bsTask) { bsTask.textContent = key || '—'; }
      const branch = $('bsBranch');
      if (branch) {
        const full = state.branchName || '';
        branch.textContent = shortBranchLabel(full);
        branch.title = full;
      }
    }
    $('deepReviewLock').classList.toggle('hidden', !blockGoalValidation);
    $('proofSection').classList.toggle('hidden', blockGoalValidation || !hasTask);
    syncThreadGithubBanner();
    renderGitStatusHint();
    renderDeck();
    renderFlow();
  }

  function renderGitStatusHint() {
    const msgEl = $('gitStatusMsg');
    const hintEl = $('gitStatusHint');
    const stageBtn = $('gitStageBtn');
    const metaCard = document.querySelector('.thread-meta-card');
    const weaving = state.status === 'weaving';
    if (hintEl) { hintEl.classList.toggle('hidden', !weaving); hintEl.setAttribute('aria-hidden', weaving ? 'false' : 'true'); }
    if (!msgEl) { return; }
    if (!weaving) {
      msgEl.textContent = '';
      if (stageBtn) { stageBtn.classList.add('hidden'); }
      if (metaCard) { metaCard.dataset.state = 'clean'; }
      return;
    }
    const { stagedFiles, unstagedFiles, isClean, ctaReason } = gitStatus;
    let html = '';
    let showStage = false;
    let stageState = 'clean';
    if (ctaReason === 'no_changes' || isClean) {
      html = 'Working tree clean';
    } else if (stagedFiles > 0 && unstagedFiles === 0) {
      html = stagedFiles + ' staged — ready to validate or commit';
      stageState = 'ready';
    } else if (stagedFiles > 0) {
      html = stagedFiles + ' staged · ' + unstagedFiles + ' unstaged';
      showStage = true;
      stageState = 'warn';
    } else if (unstagedFiles > 0) {
      html = unstagedFiles + ' unstaged — stage to validate or commit';
      showStage = true;
      stageState = 'warn';
    }
    msgEl.textContent = html || 'Working tree clean';
    if (metaCard) { metaCard.dataset.state = stageState; }
    if (stageBtn) { stageBtn.classList.toggle('hidden', !showStage); }
  }

  // ---------- Renderers ----------
  function clearProofLiveTimers() {
    (proofLive.timers || []).forEach(function(t) { clearTimeout(t); });
    proofLive.timers = [];
  }

  function proofTokOverlap(a, b) {
    function toks(s) {
      return String(s || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(/\s+/)
        .filter(function(t) { return t.length > 2; });
    }
    const A = toks(a);
    const B = new Set(toks(b));
    if (!A.length || !B.size) { return 0; }
    let hit = 0;
    A.forEach(function(t) { if (B.has(t)) hit += 1; });
    return hit;
  }

  function proofTextMatches(itemText, candidate) {
    const text = String(itemText || '').toLowerCase().trim();
    const m = String(candidate || '').toLowerCase().trim();
    if (!text || !m) { return false; }
    if (text === m) { return true; }
    if (text.length >= 12 && m.length >= 12 && (m.includes(text) || text.includes(m))) { return true; }
    const hit = proofTokOverlap(text, m);
    if (hit >= 2) { return true; }
    if (hit === 1 && text.split(/\s+/).filter(Boolean).length <= 4) { return true; }
    return false;
  }

  function startProofLive() {
    clearProofLiveTimers();
    proofLive.active = true;
    proofLive.statusById = {};
    proofLive.strikingIds = {};
    proofLive.pendingMetTexts = [];
    (state.subtasks || []).forEach(function(t) {
      proofLive.statusById[t.id] = t.done ? 'done' : 'pending';
    });
    // While reviewing: keep the checklist hidden — only the running animation shows.
    // Expand the section so the progress card is visible.
    const body = $('proofBody');
    const arrow = document.querySelector('.proof-toggle .toggle-arrow');
    if (body) { body.classList.remove('hidden'); }
    if (arrow) { arrow.innerHTML = '&#9660;'; }
    renderSubtasks();
  }

  function stopProofLive() {
    proofLive.active = false;
    proofLive.pendingMetTexts = [];
    clearProofLiveTimers();
  }

  function setProofStatus(id, status, animateStrike) {
    if (!id) { return; }
    const prev = proofLive.statusById[id];
    if (prev === 'done' && status !== 'missed') { return; }
    proofLive.statusById[id] = status;
    if (animateStrike && status === 'done') {
      proofLive.strikingIds[id] = true;
      const t = setTimeout(function() {
        delete proofLive.strikingIds[id];
        renderSubtasks();
        if (valPanelState === 'running' || valPanelState === 'done') { renderValidationStages(); }
      }, 420);
      proofLive.timers.push(t);
    }
  }

  function advanceProofChecking() {
    // Checklist is hidden while reviewing — do not pulse individual proof points.
    if (!proofLive.active || valPanelState === 'running') { return; }
    const pending = (state.subtasks || []).filter(function(t) {
      const st = proofLive.statusById[t.id] || (t.done ? 'done' : 'pending');
      return st === 'pending';
    });
    if (!pending.length) { return; }
    setProofStatus(pending[0].id, 'checking', false);
    renderSubtasks();
  }

  function applyProofStrikeFromTexts(metTexts, opts) {
    const animate = !(opts && opts.animate === false);
    const staggerMs = (opts && opts.staggerMs) || 0;
    const texts = (metTexts || []).map(function(x) { return String(x || ''); }).filter(Boolean);
    if (!texts.length && !(opts && opts.passAll)) { return; }
    // During an in-flight review the checklist is hidden — buffer for finalize.
    if (valPanelState === 'running' && !(opts && opts.force)) {
      texts.forEach(function(t) {
        if (proofLive.pendingMetTexts.indexOf(t) === -1) { proofLive.pendingMetTexts.push(t); }
      });
      return;
    }
    const targets = [];
    (state.subtasks || []).forEach(function(t) {
      if (t.done && proofLive.statusById[t.id] === 'done') { return; }
      const hit = (opts && opts.passAll) || texts.some(function(m) { return proofTextMatches(t.text, m); });
      if (hit) { targets.push(t.id); }
    });
    targets.forEach(function(id, i) {
      const apply = function() {
        setProofStatus(id, 'done', animate);
        const sub = (state.subtasks || []).find(function(s) { return s.id === id; });
        if (sub) { sub.done = true; }
        renderSubtasks();
        if (valPanelState === 'done') { renderValidationStages(); }
      };
      if (staggerMs > 0) {
        const t = setTimeout(apply, i * staggerMs);
        proofLive.timers.push(t);
      } else {
        apply();
      }
    });
  }

  function finalizeProofLiveFromResult(r) {
    proofLive.active = true;
    const met = (proofLive.pendingMetTexts || []).slice();
    proofLive.pendingMetTexts = [];
    if (Array.isArray(r && r.completedGoals)) {
      r.completedGoals.forEach(function(g) {
        if (!g) { return; }
        met.push(typeof g === 'string' ? g : g.title);
      });
    }
    if (Array.isArray(r && r.criteriaMet)) {
      r.criteriaMet.forEach(function(c) { met.push(c); });
    }
    const report = state.validateReviewResult;
    if (report && Array.isArray(report.completedGoals)) {
      report.completedGoals.forEach(function(g) {
        if (!g) { return; }
        met.push(typeof g === 'string' ? g : g.title);
      });
    }
    if (report && report.acValidation && Array.isArray(report.acValidation.criteria)) {
      report.acValidation.criteria.forEach(function(c) {
        if (c && (c.status === 'implemented' || c.implemented === true) && c.text) {
          met.push(c.text);
        }
      });
    }
    const passAll = r && r.status === 'pass';
    applyProofStrikeFromTexts(met, { animate: true, staggerMs: 160, passAll: passAll, force: true });

    const notMet = [];
    if (Array.isArray(r && r.pendingGoals)) {
      r.pendingGoals.forEach(function(g) { if (g && g.title) { notMet.push(g.title); } });
    }
    if (Array.isArray(r && r.criteriaNotMet)) {
      r.criteriaNotMet.forEach(function(item) {
        if (!item) { return; }
        notMet.push(item.criterion || item.title || String(item));
      });
    }
    (state.subtasks || []).forEach(function(t) {
      const st = proofLive.statusById[t.id];
      if (st === 'done' || t.done) { return; }
      const explicitMiss = notMet.some(function(n) { return proofTextMatches(t.text, n); });
      if (explicitMiss || (r && (r.status === 'fail' || r.status === 'partial') && notMet.length)) {
        setProofStatus(t.id, 'missed', false);
      } else if (st === 'checking' || st === 'pending') {
        if (r && r.status !== 'pass') { setProofStatus(t.id, 'missed', false); }
      }
    });
    renderSubtasks();
  }

  function buildProofLiveList(opts) {
    const subs = state.subtasks || [];
    if (!subs.length) { return ''; }
    const showMissed = !(opts && opts.hideMissed);
    let done = 0;
    const rows = subs.map(function(t) {
      let st = proofLive.statusById[t.id] || (t.done ? 'done' : 'pending');
      if (st === 'done') { done += 1; }
      if (!showMissed && st === 'missed') { st = 'pending'; }
      const striking = proofLive.strikingIds[t.id];
      const markClass = st === 'done' ? 'done' : (st === 'checking' ? 'checking' : (st === 'missed' ? 'missed' : ''));
      const textClass = striking ? 'striking' : (st === 'done' ? 'done' : (st === 'missed' ? 'missed' : ''));
      const markInner = st === 'done' ? '✓' : (st === 'missed' ? '!' : '');
      return '<div class="proof-live-row" data-proof-id="' + escHtml(t.id) + '">' +
        '<span class="proof-live-mark ' + markClass + '" aria-hidden="true">' + markInner + '</span>' +
        '<span class="proof-live-text ' + textClass + '">' + escHtml(t.text) + '</span>' +
      '</div>';
    }).join('');
    return '<div class="proof-live" role="list" aria-label="Proof points">' +
      '<div class="proof-live-head">' +
        '<span class="proof-live-title">Proof points</span>' +
        '<span class="proof-live-count">' + done + ' / ' + subs.length + '</span>' +
      '</div>' +
      '<div class="proof-live-list">' + rows + '</div>' +
    '</div>';
  }

  function renderSubtasks() {
    const list = $('subtaskList');
    if (!list) { return; }
    // While reviewing: hide the proof checklist entirely — only the animation/process card shows.
    if (valPanelState === 'running') {
      list.innerHTML = '';
      list.classList.add('hidden');
      syncProofSection(false);
      return;
    }
    list.classList.remove('hidden');
    const subs = state.subtasks || [];
    if (!subs.length) {
      list.innerHTML = '<div class="empty">No proof points yet.</div>';
      syncProofSection(false);
      return;
    }
    const live = proofLive.active || valPanelState === 'done';
    list.innerHTML = subs.map(function(t) {
      const st = proofLive.statusById[t.id] || (t.done ? 'done' : 'pending');
      const done = st === 'done' || t.done;
      const checking = st === 'checking';
      const missed = st === 'missed';
      const striking = proofLive.strikingIds[t.id];
      const checkClass = done ? 'done' : (checking ? 'checking' : (missed ? 'missed' : ''));
      const txtClass = striking ? 'striking' : (done ? 'done' : (missed ? 'missed' : ''));
      return '<div class="subtask' + (live ? ' proof-live' : '') + '">' +
        '<button class="check ' + checkClass + '" data-id="' + escHtml(t.id) + '" aria-label="toggle">' +
        (done ? '&#10003;' : (missed ? '!' : '')) +
        '</button>' +
        '<span class="txt ' + txtClass + '">' + escHtml(t.text) + '</span>' +
        '<button class="del" data-id="' + escHtml(t.id) + '" aria-label="delete">&#10005;</button>' +
      '</div>';
    }).join('');
    syncProofSection(false);
  }

  function applyValidationUsageCounts(usage) {
    if (!usage || typeof usage !== 'object') { return; }
    if (usage.limit === 'unlimited' || usage.isUnlimited === true || usage.remaining === 'unlimited') {
      valCountRemaining = 'unlimited';
      valCountTotal = 'unlimited';
      return;
    }
    if (typeof usage.limit === 'number') {
      valCountTotal = usage.limit;
      valCountRemaining = typeof usage.remaining === 'number' ? usage.remaining : Math.max(0, usage.limit - Number(usage.used || 0));
    }
  }

  function renderValidationCounter() {
    const counter = $('valCounter');
    const fill = $('valCounterFill');
    const track = $('valCounterTrack');
    if (!counter) { return; }

    const isMax = userTier === 'MAX' || userTier === 'max';
    const isUnlimited = isMax || valCountTotal === 'unlimited' || valCountRemaining === 'unlimited';

    if (isUnlimited) {
      counter.textContent = 'Validations: \u221E (unlimited)';
      if (fill) { fill.style.width = '0%'; fill.className = 'val-counter-fill'; }
      if (track) { track.setAttribute('aria-valuenow', '0'); }
      return;
    }

    if (typeof valCountTotal !== 'number') {
      counter.textContent = 'Validations: loading\u2026';
      if (fill) { fill.style.width = '0%'; fill.className = 'val-counter-fill'; }
      return;
    }

    const remaining = typeof valCountRemaining === 'number' ? valCountRemaining : null;
    const total = valCountTotal;
    const used = remaining !== null ? Math.max(0, total - remaining) : 0;
    const pct = total > 0 ? Math.round((used / total) * 100) : 0;
    counter.textContent = 'Validations: ' + (remaining !== null ? remaining : '?') + '/' + total + ' remaining';

    if (fill) {
      fill.style.width = pct + '%';
      fill.className = 'val-counter-fill' + (pct >= 100 ? ' full' : pct >= 80 ? ' crit' : pct >= 50 ? ' warn' : '');
    }
    if (track) {
      track.setAttribute('aria-valuenow', pct);
      track.setAttribute('aria-valuemax', '100');
    }
  }

  // Status presentation (icon + lime/amber/red) for the scorecard.
  const SCORECARD_STATUS = {
    pass:    { label: 'PASS' },
    partial: { label: 'PARTIAL' },
    fail:    { label: 'FAIL' },
  };

  function scorecardCompletion(r) {
    if (typeof r.matchPercent === 'number') { return Math.max(0, Math.min(100, Math.round(r.matchPercent))); }
    if (r.status === 'pass') { return 100; }
    if (r.status === 'fail') { return 0; }
    return 60;
  }

  function scorecardCopyText(r) {
    const lines = [
      (SCORECARD_STATUS[r.status] || SCORECARD_STATUS.partial).label + ' — ' + scorecardCompletion(r) + '%',
      r.summary || '',
    ];
    if (r.riskLevel && r.riskLevel !== 'not_assessed') { lines.push('Risk: ' + capitalize(r.riskLevel)); }
    if (Array.isArray(r.criteriaMet) && r.criteriaMet.length) {
      lines.push('Criteria met:');
      r.criteriaMet.forEach(function(item) { lines.push('- ' + item); });
    }
    if (Array.isArray(r.criteriaNotMet) && r.criteriaNotMet.length) {
      lines.push('Criteria not met:');
      r.criteriaNotMet.forEach(function(item) {
        if (!item) { return; }
        lines.push('- ' + (item.criterion || 'Criterion') + ': ' + (item.reason || 'Not satisfied'));
      });
    }
    return lines.filter(Boolean).join('\n');
  }

  function compactGoalList(items, kind) {
    if (!Array.isArray(items) || !items.length) { return ''; }
    return '<ul class="scorecard-list scorecard-compact-list ' + kind + '">' + items.slice(0, 4).map(function(item) {
      const title = item && item.title ? item.title : String(item || '');
      const detail = item && (item.evidence || item.suggestedAction || item.reason) ? (item.evidence || item.suggestedAction || item.reason) : '';
      return '<li><strong>' + escHtml(title) + '</strong>' + (detail ? '<span>' + escHtml(detail) + '</span>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  function compactActionsList(items) {
    if (!Array.isArray(items) || !items.length) { return ''; }
    return '<ol class="scorecard-list scorecard-compact-list actions">' + items.slice(0, 5).map(function(item) {
      const title = item && item.title ? item.title : String(item || '');
      const file = item && item.fileHint ? item.fileHint : '';
      return '<li><strong>' + escHtml(title) + '</strong>' + (file ? '<span>' + escHtml(file) + '</span>' : '') + '</li>';
    }).join('') + '</ol>';
  }

  function compactEvidenceList(items, changedFiles) {
    const evidence = Array.isArray(items) && items.length
      ? items.slice(0, 3).map(function(item) { return item.file + (item.reason ? ': ' + item.reason : ''); })
      : (Array.isArray(changedFiles) ? changedFiles.slice(0, 3) : []);
    if (!evidence.length) { return ''; }
    return '<ul class="scorecard-list scorecard-compact-list evidence">' + evidence.map(function(item) { return '<li>' + escHtml(item) + '</li>'; }).join('') + '</ul>';
  }

  function buildDeveloperPlanSummary(plan) {
    if (!plan) { return ''; }
    const impl = Array.isArray(plan.implementationTasks) ? plan.implementationTasks.slice(0, 5) : [];
    const tests = Array.isArray(plan.testingTasks) ? plan.testingTasks.slice(0, 4) : [];
    let html = '<div class="scorecard-block developer-plan-block"><div class="scorecard-label">Developer Task Plan</div>';
    if (plan.technicalSummary) { html += '<div class="scorecard-text">' + escHtml(plan.technicalSummary) + '</div>'; }
    if (impl.length) {
      html += '<ol class="scorecard-list scorecard-compact-list actions">' + impl.map(function(task) {
        const file = Array.isArray(task.likelyFiles) && task.likelyFiles.length ? task.likelyFiles[0] : '';
        return '<li><strong>' + escHtml(task.title) + '</strong>' + (file ? '<span>' + escHtml(file) + '</span>' : '') + '</li>';
      }).join('') + '</ol>';
    }
    if (tests.length) {
      html += '<div class="scorecard-label sub">Testing</div><ul class="scorecard-list scorecard-compact-list evidence">' + tests.map(function(task) {
        return '<li>' + escHtml(task.title) + '</li>';
      }).join('') + '</ul>';
    }
    html += '</div>';
    return html;
  }

  function buildValidationContextNotice(r) {
    const warnings = Array.isArray(r.warnings) ? r.warnings.filter(Boolean) : [];
    const limited = r.validationStatus === 'context_limited' || r.contextSource === 'branch_only' || r.contextSource === 'diff_only';
    if (!warnings.length && !limited && r.enrichmentStatus !== 'failed' && r.enrichmentStatus !== 'partial') { return ''; }
    const title = limited ? 'Limited task context' : 'PM enrichment notice';
    const message = warnings[0] || (r.enrichmentStatus === 'failed'
      ? 'PM enrichment failed. Validation continued with fallback context.'
      : 'Validation used available PM context.');
    return '<div class="scorecard-context-note" role="note">' +
      '<div><strong>' + escHtml(title) + '</strong><span>' + escHtml(message) + '</span></div>' +
      (r.enrichmentStatus === 'failed' ? '<button class="btn tiny" id="retryPmEnrichmentBtn" type="button">Retry PM Enrichment</button>' : '') +
      '</div>';
  }

  // Track which collapsible scorecard sections are open.
  const scorecardSections = {};
  function scorecardSectionOpen(id) {
    return scorecardSections[id] === true;
  }

  function buildScorecardCollapsible(id, label, count, inner) {
    if (!inner) { return ''; }
    const open = scorecardSectionOpen(id);
    const chevron = open ? '▾' : '▸';
    const countBadge = count !== null && count > 0 ? '<span class="sc-sec-count">' + count + '</span>' : '';
    return '<div class="sc-section' + (open ? ' open' : '') + '" data-sc-section="' + id + '">' +
      '<button class="sc-section-toggle" type="button" data-sc-toggle="' + id + '" aria-expanded="' + String(open) + '">' +
        '<span class="sc-chevron">' + chevron + '</span>' +
        '<span class="sc-section-label">' + escHtml(label) + '</span>' +
        countBadge +
      '</button>' +
      '<div class="sc-section-body"' + (open ? '' : ' style="display:none"') + '>' + inner + '</div>' +
    '</div>';
  }

  function normalizedPlanTier() {
    const t = String(userTier || '').toLowerCase();
    if (t === 'max') { return 'max'; }
    if (t === 'pro') { return 'pro'; }
    if (t === 'core' || t === 'free') { return 'free'; }
    return 'unknown';
  }

  function planTierLabel(tier) {
    if (tier === 'max') { return 'Max'; }
    if (tier === 'pro') { return 'Pro'; }
    if (tier === 'free') { return 'Free'; }
    return '';
  }

  // Same external-open pattern as react-components/ApiConfigTab + manageBillingBtn.
  function openUpgradePage() {
    vscode.postMessage({ type: 'openExternal', url: 'https://tyne.proflowtech.io/upgrade' });
  }

  function openBillingPage() {
    vscode.postMessage({ type: 'openExternal', url: 'https://tyne.proflowtech.io/account/billing' });
  }

  // Core already gets Pro-parity PM validation + full reports (5/month).
  // CTA is about volume / Max extras — not missing PM or compact reports.
  function freeTierUpgradeCopy(r) {
    if (!r || normalizedPlanTier() !== 'free') { return ''; }
    const resultTier = String(r.tier || '').toLowerCase();
    if (resultTier === 'pro' || resultTier === 'max') { return ''; }
    return 'Upgrade to Pro for 50 validations/month, or Max for unlimited';
  }

  function buildScorecard(r, isMax) {
    const detailed = isMax || r.tier === 'max';
    const meta = SCORECARD_STATUS[r.status] || SCORECARD_STATUS.partial;
    const statusClass = r.status || 'partial';
    const score = scorecardCompletion(r);
    const report = state.validateReviewResult || null;
    const summaryText = r.summary || (r.status === 'pass' ? 'Code matches the goal.' : 'Goal not fully met.');
    const explanation = (detailed && r.detailedExplanation) ? r.detailedExplanation : (r.summary || (r.status === 'pass' ? 'Code matches the goal.' : 'Goal not fully met.'));
    const riskLabel = (r.riskLevel && r.riskLevel !== 'not_assessed') ? capitalize(r.riskLevel) : 'N/A';

    // Build real data facts row — only from actual result fields, never mock.
    const facts = [];
    facts.push('<div class="sc-fact"><span>Score</span><b>' + score + '%</b></div>');
    facts.push('<div class="sc-fact risk-' + (r.riskLevel || 'na') + '"><span>Risk</span><b>' + escHtml(riskLabel) + '</b></div>');
    if (Array.isArray(r.filesReviewed) && r.filesReviewed.length) {
      facts.push('<div class="sc-fact"><span>Files</span><b>' + r.filesReviewed.length + '</b></div>');
    } else if (report && Array.isArray(report.visualDiff) && report.visualDiff.length) {
      facts.push('<div class="sc-fact"><span>Files</span><b>' + report.visualDiff.length + '</b></div>');
    }
    if (report && Array.isArray(report.findings) && report.findings.length) {
      facts.push('<div class="sc-fact"><span>Findings</span><b>' + report.findings.length + '</b></div>');
    }
    if (report && report.securityStatus) {
      facts.push('<div class="sc-fact"><span>Security</span><b>' + escHtml(report.securityStatus.replace(/_/g, ' ')) + '</b></div>');
    }
    if (report && report.vibeCodeRisk) {
      facts.push('<div class="sc-fact"><span>Vibe</span><b>' + escHtml(capitalize(report.vibeCodeRisk)) + '</b></div>');
    }
    if (report && report.aiSlop && typeof report.aiSlop.slop_score === 'number') {
      const slopCls = report.aiSlop.slop_score > 50 ? 'risk-high' : report.aiSlop.slop_score > 25 ? 'risk-medium' : '';
      facts.push('<div class="sc-fact ' + slopCls + '"><span>AI slop</span><b>' + report.aiSlop.slop_score + '</b></div>');
    }
    if (Array.isArray(r.completedGoals) && r.completedGoals.length) {
      facts.push('<div class="sc-fact"><span>Done</span><b>' + r.completedGoals.length + '</b></div>');
    }
    if (Array.isArray(r.pendingGoals) && r.pendingGoals.length) {
      facts.push('<div class="sc-fact"><span>Pending</span><b>' + r.pendingGoals.length + '</b></div>');
    }
    if (r.durationMs) {
      const dur = fmtDurationMs(r.durationMs);
      if (dur) { facts.push('<div class="sc-fact"><span>Time</span><b>' + escHtml(dur) + '</b></div>'); }
    }
    // model_info kept for internals; model name is not shown in the report UI.

    // Header: full-size score gauge + verdict + short summary.
    let body =
      '<div class="scorecard ' + statusClass + '" role="group" aria-label="Validation result">' +
      '<div class="scorecard-head">' +
        '<div class="score-ring ' + statusClass + '" style="--pct:' + score + '" role="img" aria-label="Score ' + score + ' percent">' +
          '<span class="score-ring-num">' + score + '</span>' +
          '<span class="score-ring-denom">/100</span>' +
        '</div>' +
        '<div class="scorecard-headline">' +
          '<div class="scorecard-verdict ' + statusClass + '">' + meta.label + '</div>' +
          '<div class="scorecard-short-summary">' + escHtml(summaryText) + '</div>' +
        '</div>' +
      '</div>';

    // Real data facts row — keep short (Score / Risk / Files|Findings).
    while (facts.length > 3) { facts.pop(); }
    body += '<div class="sc-facts">' + facts.join('') + '</div>';

    // PM enrichment / context notice (if any).
    body += buildValidationContextNotice(r);

    // Collapsible sections — each independently toggled.
    const completed = compactGoalList(r.completedGoals || (Array.isArray(r.criteriaMet) ? r.criteriaMet.map(function(x) { return { title: x }; }) : []), 'completed');
    const pending = compactGoalList(r.pendingGoals || (Array.isArray(r.criteriaNotMet) ? r.criteriaNotMet.map(function(x) { return { title: x.criterion || 'Pending requirement', reason: x.reason || '' }; }) : []), 'pending');
    const actions = compactActionsList(r.developerActions || (Array.isArray(r.suggestions) ? r.suggestions.map(function(x) { return { title: x }; }) : []));
    const evidence = compactEvidenceList(r.codeEvidence, r.filesReviewed);

    const completedCount = (r.completedGoals || (Array.isArray(r.criteriaMet) ? r.criteriaMet : [])).length;
    const pendingCount = (r.pendingGoals || (Array.isArray(r.criteriaNotMet) ? r.criteriaNotMet : [])).length;
    const hasDeveloperActions = Array.isArray(r.developerActions) && r.developerActions.length > 0;
    const actionsCount = (r.developerActions || (Array.isArray(r.suggestions) ? r.suggestions : [])).length;
    const evidenceCount = (Array.isArray(r.codeEvidence) ? r.codeEvidence : (Array.isArray(r.filesReviewed) ? r.filesReviewed : [])).length;
    const criteriaMetCount = Array.isArray(r.criteriaMet) ? r.criteriaMet.length : 0;
    const criteriaNotMetCount = Array.isArray(r.criteriaNotMet) ? r.criteriaNotMet.length : 0;
    const missingCount = Array.isArray(r.missingRequirements) ? r.missingRequirements.length : 0;
    const suggestionsCount = Array.isArray(r.suggestions) ? r.suggestions.length : 0;
    const proofPointsCount = Array.isArray(r.generatedProofPoints) ? r.generatedProofPoints.length : 0;
    const qualityCount = Array.isArray(r.codeQualityNotes) ? r.codeQualityNotes.length : 0;
    const filesCount = Array.isArray(r.filesReviewed) ? r.filesReviewed.length : 0;

    // Section: Completed goals — demote below the action triad when Thread is dense.
    const prioritySections = [];
    if (pendingCount) { prioritySections.push(buildScorecardCollapsible('pending', 'Pending goals', pendingCount, pending)); }
    if (actionsCount) { prioritySections.push(buildScorecardCollapsible('actions', 'Next Developer Actions', actionsCount, actions)); }
    if (missingCount) { prioritySections.push(buildScorecardCollapsible('missing', 'Missing requirements', missingCount, vrList(r.missingRequirements, 'fail'))); }
    body += prioritySections.slice(0, 3).join('');

    const moreSections = [];
    if (completedCount) { moreSections.push(buildScorecardCollapsible('completed', 'Completed goals', completedCount, completed)); }
    if (evidenceCount) { moreSections.push(buildScorecardCollapsible('evidence', 'Code Evidence', evidenceCount, evidence)); }
    if (r.developerTaskPlan) {
      moreSections.push(buildScorecardCollapsible('devplan', 'Developer task plan', null, buildDeveloperPlanSummary(r.developerTaskPlan)));
    }
    moreSections.push(buildScorecardCollapsible('analysis', 'Analysis', null, '<div class="scorecard-text">' + escHtml(explanation) + '</div>'));
    if (criteriaMetCount) {
      moreSections.push(buildScorecardCollapsible('critMet', 'Acceptance criteria met', criteriaMetCount,
        '<ul class="scorecard-list">' + r.criteriaMet.map(function(item) { return '<li>' + escHtml(item) + '</li>'; }).join('') + '</ul>'));
    }
    if (criteriaNotMetCount) {
      moreSections.push(buildScorecardCollapsible('critNotMet', 'Acceptance criteria not met', criteriaNotMetCount,
        '<ul class="scorecard-list scorecard-list-fail">' + r.criteriaNotMet.map(function(item) {
          const criterion = item && item.criterion ? item.criterion : 'Criterion';
          const reason = item && item.reason ? item.reason : 'Not satisfied by the diff.';
          return '<li><strong>' + escHtml(criterion) + '</strong><span>' + escHtml(reason) + '</span></li>';
        }).join('') + '</ul>'));
    }
    if (suggestionsCount && !hasDeveloperActions) {
      moreSections.push(buildScorecardCollapsible('suggestions', 'Suggestions', suggestionsCount, vrList(r.suggestions)));
    }
    if (proofPointsCount) {
      moreSections.push(buildScorecardCollapsible('proofEvidence', 'Proof evidence', proofPointsCount, vrList(r.generatedProofPoints)));
    }
    if (qualityCount) {
      moreSections.push(buildScorecardCollapsible('quality', 'Code quality notes', qualityCount, vrList(r.codeQualityNotes)));
    }

    // Section: Validation stages
    if (detailed && validationStages && validationStages.length) {
      const stageRows = validationStages.map(function(s) {
        const mark = s.status === 'failed' ? 'fail' : 'ok';
        return '<div class="scorecard-stage scorecard-stage-' + mark + '">' + escHtml(s.name) + '</div>';
      }).join('');
      moreSections.push(buildScorecardCollapsible('stages', 'Validation stages', validationStages.length,
        '<div class="scorecard-stages">' + stageRows + '</div>'));
    }

    // Section: Section scores from validateReviewResult
    if (report && Array.isArray(report.sectionScores) && report.sectionScores.length) {
      const scoreRows = report.sectionScores.map(function(s) {
        const sScore = typeof s.score === 'number' ? Math.max(0, Math.min(100, Math.round(s.score))) : null;
        const sStatus = s.status || (sScore !== null ? (sScore >= 80 ? 'good' : sScore >= 50 ? 'warn' : 'bad') : 'neutral');
        return '<div class="sc-subscore' + (sScore !== null ? ' sc-subscore-' + sStatus : '') + '">' +
          '<span class="sc-subscore-label">' + escHtml(s.title || s.id) + '</span>' +
          (sScore !== null ? '<span class="sc-subscore-val">' + sScore + '</span>' : '') +
          (s.summary ? '<span class="sc-subscore-summary">' + escHtml(s.summary) + '</span>' : '') +
        '</div>';
      }).join('');
      moreSections.push(buildScorecardCollapsible('secScores', 'Section scores', report.sectionScores.length,
        '<div class="sc-subscores">' + scoreRows + '</div>'));
    }

    // Section: Security findings
    if (report && Array.isArray(report.securityFindings) && report.securityFindings.length) {
      const secRows = report.securityFindings.map(function(f) {
        return '<div class="sc-sec-finding">' +
          '<span class="sc-sec-sev sc-sec-sev-' + escHtml(f.severity || 'medium') + '">' + escHtml((f.severity || 'medium').toUpperCase()) + '</span>' +
          '<div class="sc-sec-body"><strong>' + escHtml(f.title || f.ruleId || 'Security finding') + '</strong>' +
          (f.file ? '<span>' + escHtml(f.file) + (f.line ? ':' + f.line : '') + '</span>' : '') +
          (f.remediation ? '<span class="sc-sec-fix">' + escHtml(f.remediation) + '</span>' : '') +
          '</div></div>';
      }).join('');
      moreSections.push(buildScorecardCollapsible('secFindings', 'Security findings', report.securityFindings.length,
        '<div class="sc-sec-findings">' + secRows + '</div>'));
    }

    // Section: Missing tests
    if (report && Array.isArray(report.missingTests) && report.missingTests.length) {
      const testRows = report.missingTests.map(function(t) {
        return '<div class="sc-missing-test"><strong>' + escHtml(t.title || 'Missing test') + '</strong>' +
          (t.testType ? '<span>' + escHtml(t.testType) + '</span>' : '') +
          (t.reason ? '<span>' + escHtml(t.reason) + '</span>' : '') +
        '</div>';
      }).join('');
      moreSections.push(buildScorecardCollapsible('missingTests', 'Missing tests', report.missingTests.length,
        '<div class="sc-missing-tests">' + testRows + '</div>'));
    }

    // Section: Files reviewed
    if (filesCount) {
      moreSections.push(buildScorecardCollapsible('files', 'Files reviewed', filesCount, vrList(r.filesReviewed, 'mono')));
    }

    if (moreSections.length) {
      body += '<details class="scorecard-more-sections"><summary>More details (' + moreSections.length + ')</summary>' +
        moreSections.join('') + '</details>';
    }

    // Footer: one primary + overflow (Hide / Copy / Re-run).
    body += '<div class="scorecard-actions">' +
      (detailed || r.fullReport || r.developerTaskPlan || state.validateReviewResult
        ? '<button class="btn primary" id="valFullReportBtn" type="button" aria-label="Open full validation report">Open report</button>'
        : '<button class="btn primary" id="valStagesRunAgainBtn" type="button" aria-label="Run Validate and Review again">Re-run</button>') +
      '<button class="btn" id="valStagesDismissBtn" type="button" aria-label="Hide validation result">Hide result</button>' +
      '<details class="scorecard-more"><summary class="btn">More</summary><div class="scorecard-more-actions">' +
        '<button class="btn" id="valHistoryPageBtn" type="button" aria-label="Open Validate and Review">Reviews</button>' +
        '<button class="btn" id="valStagesCopyBtn" type="button" aria-label="Copy validation report">Copy</button>' +
        (detailed || r.fullReport || r.developerTaskPlan || state.validateReviewResult
          ? '<button class="btn" id="valStagesRunAgainBtn" type="button" aria-label="Run Validate and Review again">Re-run</button>'
          : '') +
      '</div></details>' +
      '</div>';

    const upgradeCopy = freeTierUpgradeCopy(r);
    if (upgradeCopy) {
      body += '<div class="scorecard-upgrade-cta" role="note">' +
        '<span>' + escHtml(upgradeCopy) + '</span>' +
        '<button class="btn compact primary" id="valUpgradeCtaBtn" type="button">Upgrade</button>' +
        '</div>';
    }

    body += '</div>';
    return body;
  }

  // ── MAX full validation report (Detail overlay) ──────────────────────────────

  const GUIDANCE_RANK = { block: 0, improve: 1, polish: 2 };
  const GUIDANCE_META = {
    block:   { label: 'Fix', cls: 'block' },
    improve: { label: 'Improve', cls: 'improve' },
    polish:  { label: 'Polish', cls: 'polish' },
  };

  // Synthesize prioritized, actionable next steps for the developer from the
  // validation result. Unmet acceptance criteria and missing requirements are
  // blockers (Fix); suggestions are improvements; low-risk quality notes are polish.
  function buildDeveloperGuidance(r) {
    const items = [];
    (Array.isArray(r.criteriaNotMet) ? r.criteriaNotMet : []).forEach(function(c) {
      if (!c) { return; }
      items.push({ level: 'block', title: c.criterion || 'Unmet acceptance criterion', body: c.reason || 'Not satisfied by the current diff.' });
    });
    (Array.isArray(r.missingRequirements) ? r.missingRequirements : []).forEach(function(m) {
      if (m) { items.push({ level: 'block', title: 'Close a missing requirement', body: m }); }
    });
    (Array.isArray(r.suggestions) ? r.suggestions : []).forEach(function(s) {
      if (s) { items.push({ level: 'improve', title: 'Recommended improvement', body: s }); }
    });
    (Array.isArray(r.codeQualityNotes) ? r.codeQualityNotes : []).forEach(function(q) {
      if (q) { items.push({ level: r.riskLevel === 'high' ? 'block' : 'polish', title: 'Code quality', body: q }); }
    });
    return items.sort(function(a, b) { return (GUIDANCE_RANK[a.level] || 9) - (GUIDANCE_RANK[b.level] || 9); });
  }

  function buildGuidanceSection(r) {
    const items = buildDeveloperGuidance(r);
    if (!items.length) {
      return '<div class="vr-guidance-empty' + (r.status === 'pass' ? ' ok' : '') + '">' +
        (r.status === 'pass'
          ? '&#10003; All acceptance criteria are satisfied. This change is ready to ship — re-run validation after any further edits.'
          : 'No specific action items were returned. Review the analysis and acceptance criteria below, then re-validate.') +
        '</div>';
    }
    const rows = items.map(function(it, i) {
      const m = GUIDANCE_META[it.level] || GUIDANCE_META.improve;
      return '<li class="vr-guide-item ' + m.cls + '">' +
        '<span class="vr-guide-rank">' + (i + 1) + '</span>' +
        '<div class="vr-guide-body">' +
          '<div class="vr-guide-head"><span class="vr-guide-chip ' + m.cls + '">' + m.label + '</span>' +
            '<span class="vr-guide-title">' + escHtml(it.title) + '</span></div>' +
          '<div class="vr-guide-text">' + escHtml(it.body) + '</div>' +
        '</div></li>';
    }).join('');
    return '<ol class="vr-guidance-list">' + rows + '</ol>';
  }

  function vrSection(label, inner) {
    if (!inner) { return ''; }
    return '<section class="vr-section"><div class="vr-section-label">' + escHtml(label) + '</div>' + inner + '</section>';
  }

  function vrList(items, cls) {
    if (!Array.isArray(items) || !items.length) { return ''; }
    return '<ul class="vr-list ' + (cls || '') + '">' + items.map(function(x) { return '<li>' + escHtml(x) + '</li>'; }).join('') + '</ul>';
  }

  function fmtReportDate(iso) {
    try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }

  // Read-only, fully-expanded variant of the run timeline for the report overlay.
  function buildReportTimeline(trace) {
    return trace.steps.map(function(step, index) {
      const status = step.status || 'pending';
      const detail = buildTraceDetail(step);
      return '<div class="val-timeline-item ' + status + '" role="listitem">' +
        '<div class="val-timeline-rail">' +
          '<div class="val-timeline-line' + (index === trace.steps.length - 1 ? ' end' : '') + '"></div>' +
          '<div class="val-timeline-node ' + status + '">' + traceStatusIcon(status) + '</div>' +
        '</div>' +
        '<div class="val-timeline-card">' +
          '<div class="vr-step-head">' +
            '<div class="val-timeline-top">' +
              '<div class="val-timeline-title">' + escHtml(step.title || step.key) + '</div>' +
              '<div class="val-timeline-status ' + status + '">' + escHtml(traceStatusLabel(status)) + '</div>' +
            '</div>' +
            '<div class="val-timeline-meta">' + escHtml(buildTraceMeta(step)) + '</div>' +
            (step.summary ? '<div class="val-timeline-summary">' + escHtml(step.summary) + '</div>' : '') +
          '</div>' +
          (detail ? '<div class="val-timeline-detail">' + detail + '</div>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  }

  function buildValidationReport(r) {
    const meta = SCORECARD_STATUS[r.status] || SCORECARD_STATUS.partial;
    const statusClass = r.status || 'partial';
    const score = scorecardCompletion(r);
    const riskLabel = (r.riskLevel && r.riskLevel !== 'not_assessed') ? capitalize(r.riskLevel) : 'N/A';
    const goal = (state.goal || r.taskTitle || '').trim();

    const metaBits = [];
    if (r.taskId) { metaBits.push('Task ' + escHtml(r.taskId)); }
    if (r.branchName) { metaBits.push('Branch ' + escHtml(r.branchName)); }
    if (r.commitHash) { metaBits.push('Commit ' + escHtml(String(r.commitHash).slice(0, 8))); }
    metaBits.push('AXIOM Max');
    if (Array.isArray(r.filesReviewed) && r.filesReviewed.length) { metaBits.push(r.filesReviewed.length + ' file' + (r.filesReviewed.length === 1 ? '' : 's')); }
    const dur = fmtDurationMs(r.durationMs);
    if (dur) { metaBits.push(dur); }
    if (r.createdAt) { const d = fmtReportDate(r.createdAt); if (d) { metaBits.push(d); } }

    let html = '<div class="vr-head ' + statusClass + '">' +
      '<div class="score-ring ' + statusClass + '" style="--pct:' + score + '" role="img" aria-label="Score ' + score + ' percent"><span class="score-ring-num">' + score + '</span></div>' +
      '<div class="vr-head-main">' +
        '<div class="vr-verdict ' + statusClass + '">' + meta.label + '</div>' +
        '<div class="vr-head-facts">' +
          '<span class="vr-fact">Match <b>' + score + '%</b></span>' +
          '<span class="vr-fact risk-' + (r.riskLevel || 'na') + '">Risk <b>' + escHtml(riskLabel) + '</b></span>' +
        '</div>' +
        '<div class="vr-head-meta">' + metaBits.join(' &middot; ') + '</div>' +
      '</div></div>';

    html += '<div class="vr-summary">' + escHtml(r.summary || (r.status === 'pass' ? 'Code matches the goal.' : 'Goal not fully met.')) + '</div>';

    // Developer guidance — the headline value for Max.
    html += '<section class="vr-section vr-guidance-section">' +
      '<div class="vr-section-label">&#129517; Next steps for the developer</div>' +
      buildGuidanceSection(r) + '</section>';

    if (r.fullReport) {
      const normalizedFullReport = normalizeReviewMarkdown(r.fullReport);
      const reportHtml = hasStructuredTyneReport(normalizedFullReport)
        ? '<article class="vr-markdown-doc">' + markdownToReviewHtml(normalizedFullReport) + '</article>'
        : '<div class="vr-text">' + escHtml(r.fullReport) + '</div>';
      html += vrSection('Full validation report', reportHtml);
    }

    if (r.developerTaskPlan) {
      const plan = r.developerTaskPlan;
      let planHtml = plan.technicalSummary ? '<div class="vr-text">' + escHtml(plan.technicalSummary) + '</div>' : '';
      if (Array.isArray(plan.implementationTasks) && plan.implementationTasks.length) {
        planHtml += '<ol class="vr-guidance-list">' + plan.implementationTasks.map(function(task, i) {
          const files = Array.isArray(task.likelyFiles) && task.likelyFiles.length ? task.likelyFiles.join(', ') : 'Exact file unknown';
          return '<li class="vr-guide-item improve"><span class="vr-guide-rank">' + (i + 1) + '</span><div class="vr-guide-body">' +
            '<div class="vr-guide-head"><span class="vr-guide-title">' + escHtml(task.title) + '</span></div>' +
            '<div class="vr-guide-text">' + escHtml(task.description || '') + '</div>' +
            '<div class="vr-guide-text mono">' + escHtml(files) + '</div>' +
          '</div></li>';
        }).join('') + '</ol>';
      }
      if (Array.isArray(plan.testingTasks) && plan.testingTasks.length) {
        planHtml += '<div class="vr-section-label small">Testing tasks</div>' + vrList(plan.testingTasks.map(function(task) { return task.title; }));
      }
      html += vrSection('Developer Task Plan', planHtml);
    }

    const context = r.codebaseContext;
    if (context && Array.isArray(context.relevantFiles) && context.relevantFiles.length) {
      html += vrSection('Relevant files', '<ul class="vr-list mono">' + context.relevantFiles.map(function(file) {
        return '<li><strong>' + escHtml(file.path) + '</strong><span>' + escHtml(file.reason || '') + '</span></li>';
      }).join('') + '</ul>');
    }

    if (goal) { html += vrSection('Goal', '<div class="vr-text">' + escHtml(goal) + '</div>'); }
    html += vrSection('Analysis', '<div class="vr-text">' + escHtml(r.detailedExplanation || r.summary || 'No additional analysis was returned.') + '</div>');

    if (Array.isArray(r.criteriaMet) && r.criteriaMet.length) {
      html += vrSection('Acceptance criteria met', '<ul class="vr-list ok">' + r.criteriaMet.map(function(x) { return '<li>' + escHtml(x) + '</li>'; }).join('') + '</ul>');
    }
    if (Array.isArray(r.criteriaNotMet) && r.criteriaNotMet.length) {
      html += vrSection('Acceptance criteria not met', '<ul class="vr-list fail vr-criteria-fail">' + r.criteriaNotMet.map(function(c) {
        const crit = c && c.criterion ? c.criterion : 'Criterion';
        const reason = c && c.reason ? c.reason : 'Not satisfied by the diff.';
        return '<li><strong>' + escHtml(crit) + '</strong><span>' + escHtml(reason) + '</span></li>';
      }).join('') + '</ul>');
    }
    html += vrSection('Missing requirements', vrList(r.missingRequirements, 'fail'));
    if (!(Array.isArray(r.developerActions) && r.developerActions.length)) {
      html += vrSection('Suggestions', vrList(r.suggestions));
    }
    html += vrSection('Proof evidence', vrList(r.generatedProofPoints));
    html += vrSection('Code quality notes', vrList(r.codeQualityNotes));
    html += vrSection('Files reviewed', vrList(r.filesReviewed, 'mono'));

    const trace = (r.trace && Array.isArray(r.trace.steps) && r.trace.steps.length) ? r.trace : validationTrace;
    if (trace && Array.isArray(trace.steps) && trace.steps.length) {
      html += '<section class="vr-section">' +
        '<div class="vr-section-label">Validation pipeline</div>' +
        (trace.strategySummary ? '<div class="vr-text vr-strategy">' + escHtml(trace.strategySummary) + '</div>' : '') +
        '<div class="val-timeline-wrap vr-timeline">' + buildReportTimeline(trace) + '</div>' +
      '</section>';
    }
    return html;
  }

  function validationReportText(r) {
    const lines = ['VALIDATION REPORT'];
    lines.push((SCORECARD_STATUS[r.status] || SCORECARD_STATUS.partial).label + ' — Match ' + scorecardCompletion(r) + '% — Risk ' + ((r.riskLevel && r.riskLevel !== 'not_assessed') ? capitalize(r.riskLevel) : 'N/A'));
    if (r.taskId) { lines.push('Task: ' + r.taskId + (r.taskTitle ? ' — ' + r.taskTitle : '')); }
    if (r.branchName) { lines.push('Branch: ' + r.branchName); }
    if (r.commitHash) { lines.push('Commit: ' + String(r.commitHash).slice(0, 8)); }
    lines.push('', 'Summary: ' + (r.summary || ''));
    const guide = buildDeveloperGuidance(r);
    if (guide.length) {
      lines.push('', 'NEXT STEPS:');
      guide.forEach(function(g, i) { lines.push((i + 1) + '. [' + (GUIDANCE_META[g.level] || GUIDANCE_META.improve).label + '] ' + g.title + ' — ' + g.body); });
    }
    if (r.detailedExplanation) { lines.push('', 'Analysis: ' + r.detailedExplanation); }
    if (Array.isArray(r.criteriaMet) && r.criteriaMet.length) { lines.push('', 'Criteria met:'); r.criteriaMet.forEach(function(c) { lines.push('- ' + c); }); }
    if (Array.isArray(r.criteriaNotMet) && r.criteriaNotMet.length) { lines.push('', 'Criteria not met:'); r.criteriaNotMet.forEach(function(c) { if (c) { lines.push('- ' + (c.criterion || 'Criterion') + ': ' + (c.reason || '')); } }); }
    if (Array.isArray(r.missingRequirements) && r.missingRequirements.length) { lines.push('', 'Missing requirements:'); r.missingRequirements.forEach(function(m) { lines.push('- ' + m); }); }
    if (Array.isArray(r.suggestions) && r.suggestions.length && !(Array.isArray(r.developerActions) && r.developerActions.length)) {
      lines.push('', 'Suggestions:'); r.suggestions.forEach(function(s) { lines.push('- ' + s); });
    }
    if (Array.isArray(r.generatedProofPoints) && r.generatedProofPoints.length) {
      lines.push('', 'Proof evidence:'); r.generatedProofPoints.forEach(function(p) { lines.push('- ' + p); });
    }
    if (Array.isArray(r.filesReviewed) && r.filesReviewed.length) { lines.push('', 'Files reviewed:'); r.filesReviewed.forEach(function(f) { lines.push('- ' + f); }); }
    return lines.join('\n');
  }

  function openValidationDetail() {
    // Prefer the full Validate & Review document over the legacy mapped overlay.
    const review = state.validateReviewResult || validateReview.result || null;
    const reportId = (review && (review.id || ensureValidateReviewReportId(review, 0)))
      || state.latestValidateReviewReportId
      || (validateReview.result && validateReview.result.id)
      || '';

    if (review || reportId) {
      if (review) {
        ensureValidateReviewReportId(review, 0);
        validateReview.result = review;
        if (review.id && !validateReview.reports.some(function(existing) { return existing.id === review.id; })) {
          validateReview.reports = [review].concat(validateReview.reports);
        }
        state.validateReviewResult = review;
        if (review.id) { state.latestValidateReviewReportId = review.id; }
      }
      showAppView('validateReview');
      const id = (review && review.id) || reportId;
      if (id) {
        openValidateReviewReport(id, 'structured');
      } else {
        validateReview.viewMode = 'structured';
        renderValidateReview();
      }
      return;
    }

    // Fallback for mapped-only / legacy validation payloads.
    const r = state.validationResult;
    if (!r) { return; }
    const overlay = $('valDetailOverlay');
    const report = $('valDetailReport');
    if (!overlay || !report) { return; }
    report.innerHTML = buildValidationReport(r);
    report.scrollTop = 0;
    overlay.classList.remove('hidden');
    const commitBtn = $('valDetailOpenCommitBtn');
    if (commitBtn) { commitBtn.classList.toggle('hidden', !r.commitUrl); }
    const closeBtn = $('valDetailCloseBtn');
    if (closeBtn) { closeBtn.focus(); }
  }

  function closeValidationDetail() {
    const overlay = $('valDetailOverlay');
    if (overlay && !overlay.classList.contains('hidden')) { overlay.classList.add('hidden'); }
  }

  function syncTraceExpansion(trace) {
    if (!trace || !Array.isArray(trace.steps)) { return; }
    const next = {};
    trace.steps.forEach(function(step, index) {
      const shouldOpen = step.status === 'running'
        || step.status === 'failed'
        || step.status === 'warning'
        || step.key === trace.currentStepKey
        || index === trace.steps.length - 1;
      next[step.id] = Object.prototype.hasOwnProperty.call(expandedTraceSteps, step.id) ? expandedTraceSteps[step.id] : shouldOpen;
    });
    expandedTraceSteps = next;
  }

  function traceStatusIcon(status) {
    if (status === 'success') { return '&#10003;'; }
    if (status === 'failed') { return '&#10005;'; }
    if (status === 'warning') { return '&#9888;'; }
    if (status === 'running') { return '<span class="val-stage-spinner" aria-hidden="true"></span>'; }
    if (status === 'skipped') { return '&#8213;'; }
    return '&#9633;';
  }

  function traceStatusLabel(status) {
    if (status === 'success') { return 'Success'; }
    if (status === 'failed') { return 'Failed'; }
    if (status === 'warning') { return 'Warning'; }
    if (status === 'running') { return 'Running'; }
    if (status === 'skipped') { return 'Skipped'; }
    return 'Pending';
  }

  function traceProviderLabel(step) {
    const provider = step && step.provider;
    if (provider === 'axiom' || provider === 'claude' || provider === 'openai' || provider === 'deepseek') { return 'AXIOM'; }
    if (provider === 'rule_engine') { return 'Rules'; }
    if (provider === 'internal') { return 'Internal'; }
    if (provider === 'manual') { return 'Manual'; }
    return 'System';
  }

  function traceModelLabel(step) {
    if (!step || !step.model) { return ''; }
    return step.model;
  }

  function fmtTimelineStamp(startedAt, completedAt) {
    const stamp = completedAt || startedAt;
    if (!stamp) { return ''; }
    try {
      return new Date(stamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  function fmtDurationMs(ms) {
    if (!ms || ms <= 0) { return ''; }
    if (ms < 1000) { return ms + 'ms'; }
    if (ms < 60000) { return (Math.round(ms / 100) / 10) + 's'; }
    return fmtMinutes(Math.round(ms / 60000));
  }

  function buildTraceMeta(step) {
    const parts = [];
    const provider = traceProviderLabel(step);
    const model = traceModelLabel(step);
    if (provider) { parts.push(provider); }
    if (model) { parts.push(model); }
    const stamp = fmtTimelineStamp(step.startedAt, step.completedAt);
    if (stamp) { parts.push(stamp); }
    const dur = fmtDurationMs(step.durationMs);
    if (dur) { parts.push(dur); }
    if (typeof step.retryCount === 'number' && step.retryCount > 0) { parts.push('Retries ' + step.retryCount); }
    return parts.join(' · ');
  }

  function buildTraceDetail(step) {
    const blocks = [];
    if (step.description) { blocks.push('<div class="val-timeline-detail-block"><div class="val-timeline-detail-label">Step</div><div class="val-timeline-detail-text">' + escHtml(step.description) + '</div></div>'); }
    if (step.details) { blocks.push('<div class="val-timeline-detail-block"><div class="val-timeline-detail-label">Details</div><div class="val-timeline-detail-text">' + escHtml(step.details) + '</div></div>'); }
    if (step.summary && step.summary !== step.details) { blocks.push('<div class="val-timeline-detail-block"><div class="val-timeline-detail-label">Summary</div><div class="val-timeline-detail-text">' + escHtml(step.summary) + '</div></div>'); }
    if (Array.isArray(step.evidence) && step.evidence.length) {
      blocks.push('<div class="val-timeline-detail-block"><div class="val-timeline-detail-label">Evidence</div><ul class="val-timeline-evidence">' + step.evidence.map(function(item) { return '<li>' + escHtml(item) + '</li>'; }).join('') + '</ul></div>');
    }
    if (step.errorMessage) { blocks.push('<div class="val-timeline-detail-block"><div class="val-timeline-detail-label">Error</div><div class="val-timeline-detail-text error">' + escHtml(step.errorMessage) + '</div></div>'); }
    if (step.confidence !== undefined && step.confidence !== null) { blocks.push('<div class="val-timeline-detail-block"><div class="val-timeline-detail-label">Confidence</div><div class="val-timeline-detail-text">' + Math.round(Number(step.confidence) * 100) + '%</div></div>'); }
    if (step.metadata && Object.keys(step.metadata).length) {
      blocks.push('<div class="val-timeline-detail-block"><div class="val-timeline-detail-label">Trace data</div><pre class="val-timeline-json">' + escHtml(JSON.stringify(step.metadata, null, 2)) + '</pre></div>');
    }
    return blocks.join('');
  }

  function buildValidationTimeline(trace) {
    syncTraceExpansion(trace);
    return trace.steps.map(function(step, index) {
      const expanded = expandedTraceSteps[step.id] !== false;
      const current = step.status === 'running' || step.key === trace.currentStepKey;
      const status = step.status || 'pending';
      return '<div class="val-timeline-item ' + status + (current ? ' current' : '') + '" role="listitem">' +
        '<div class="val-timeline-rail">' +
          '<div class="val-timeline-line' + (index === trace.steps.length - 1 ? ' end' : '') + '"></div>' +
          '<div class="val-timeline-node ' + status + '">' + traceStatusIcon(status) + '</div>' +
        '</div>' +
        '<div class="val-timeline-card">' +
          '<button class="val-timeline-toggle" type="button" data-step-id="' + escHtml(step.id) + '" aria-expanded="' + String(expanded) + '">' +
            '<div class="val-timeline-top">' +
              '<div class="val-timeline-title">' + escHtml(step.title || step.key) + '</div>' +
              '<div class="val-timeline-status ' + status + '">' + escHtml(traceStatusLabel(status)) + '</div>' +
            '</div>' +
            '<div class="val-timeline-meta">' + escHtml(buildTraceMeta(step)) + '</div>' +
            (step.summary ? '<div class="val-timeline-summary">' + escHtml(step.summary) + '</div>' : '') +
          '</button>' +
          '<div class="val-timeline-detail' + (expanded ? '' : ' hidden') + '" id="trace-detail-' + escHtml(step.id) + '">' +
            buildTraceDetail(step) +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  // Reduce live progress (trace steps or staged list) to a compact summary:
  // what the AI is doing right now + how far along it is.
  function computeRunningProgress() {
    let names = [];
    let doneCount = 0;
    let current = '';
    if (validationTrace && Array.isArray(validationTrace.steps) && validationTrace.steps.length) {
      const steps = validationTrace.steps;
      names = steps.map(function(s) { return s.title || s.key || 'Step'; });
      steps.forEach(function(s) {
        if (s.status === 'success' || s.status === 'failed' || s.status === 'warning' || s.status === 'skipped') { doneCount++; }
        if ((s.status === 'running' || s.key === validationTrace.currentStepKey) && !current) { current = s.title || s.key; }
      });
    } else if (validationStages && validationStages.length) {
      names = validationStages.map(function(s) { return s.name; });
      validationStages.forEach(function(s) {
        if (s.status === 'completed' || s.status === 'failed') { doneCount++; }
        if (s.status === 'running' && !current) { current = s.name; }
      });
    }
    if (!current) { current = names[Math.min(doneCount, Math.max(0, names.length - 1))] || 'Reviewing your code'; }
    const total = names.length || 0;
    const step = Math.min(total || 1, doneCount + 1);
    const pct = total ? Math.round((doneCount / total) * 100) : 35;
    return { current: current, step: step, total: total, pct: pct };
  }

  // Compact "AI is working" card — Cursor-style live timeline driven by host stages.
  function buildRunningCard() {
    return buildReviewLiveTimeline();
  }

  /** Compact Thread result: Match bar + score / verdict / facts (screenshot layout). */
  function buildThreadReviewSummary(r) {
    const meta = SCORECARD_STATUS[r.status] || SCORECARD_STATUS.partial;
    const statusClass = r.status || 'partial';
    const score = scorecardCompletion(r);
    const report = state.validateReviewResult || null;

    let findings = 0;
    let urgent = 0;
    if (report && Array.isArray(report.findings)) {
      findings = report.findings.length;
      report.findings.forEach(function(f) {
        const d = displaySeverity(f.severity, f.category);
        if (d === 'critical' || d === 'major') { urgent++; }
      });
    }

    const note = threadReviewDisclaimer(r);

    let body =
      '<div class="thread-review-summary ' + statusClass + '" role="group" aria-label="Validation summary">' +
        '<div class="thread-match">' +
          '<div class="thread-match-row"><span>Match</span><b>' + score + '/100</b></div>' +
          '<div class="thread-match-track" aria-hidden="true"><i style="width:' + score + '%"></i></div>' +
        '</div>' +
        '<div class="thread-review-score-row">' +
          '<div class="thread-review-score">' +
            '<div class="thread-review-score-num"><b>' + score + '</b><span>/100</span></div>' +
            '<div class="thread-review-verdict ' + statusClass + '">' + escHtml(meta.label) + '</div>' +
          '</div>' +
          '<div class="thread-review-facts">' +
            '<div class="thread-review-fact"><span>Score</span><b>' + score + '%</b></div>' +
            '<div class="thread-review-fact"><span>Findings</span><b>' + findings + '</b></div>' +
            '<div class="thread-review-fact"><span>Urgent</span><b' + (urgent ? ' class="bad"' : '') + '>' + urgent + '</b></div>' +
          '</div>' +
        '</div>' +
        (note ? '<div class="thread-review-note">' + escHtml(note) + '</div>' : '');

    const upgradeCopy = freeTierUpgradeCopy(r);
    if (upgradeCopy) {
      body += '<div class="scorecard-upgrade-cta" role="note">' +
        '<span>' + escHtml(upgradeCopy) + '</span>' +
        '<button class="btn compact primary" id="valUpgradeCtaBtn" type="button">Upgrade</button>' +
        '</div>';
    }
    body += '</div>';
    return body;
  }

  function threadReviewDisclaimer(r) {
    if (!r) { return ''; }
    const warnings = Array.isArray(r.warnings) ? r.warnings : [];
    for (var i = 0; i < warnings.length; i++) {
      const w = warnings[i];
      const text = typeof w === 'string' ? w : (w && (w.reason || w.message || w.type)) || '';
      if (text) { return String(text); }
    }
    const report = state.validateReviewResult;
    const rw = report && Array.isArray(report.reviewWarnings) ? report.reviewWarnings : [];
    for (var j = 0; j < rw.length; j++) {
      const item = rw[j];
      const text = item && (item.reason || item.message || item.type);
      if (text) { return String(text); }
    }
    if (r.validationStatus === 'context_limited' || r.contextSource === 'branch_only' || r.contextSource === 'diff_only') {
      return 'Partial review from local analysis.';
    }
    if (r.status === 'partial' && r.summary) {
      const s = String(r.summary).trim();
      if (s.length <= 120) { return s; }
    }
    return '';
  }

  function buildProofResultActions() {
    return '<button class="btn primary" id="valStagesRunAgainBtn" type="button">Re-run</button>' +
      '<button class="btn" id="valStagesOverrideBtn" type="button">Override</button>' +
      '<button class="btn" id="valFullReportBtn" type="button">Full report</button>';
  }

  function bindProofResultActions() {
    const runAgainBtn = $('valStagesRunAgainBtn');
    if (runAgainBtn) {
      runAgainBtn.onclick = function() {
        beginValidateReviewFromThread();
        vscode.postMessage({ type: 'buttonClick', action: 'validateReview' });
      };
    }
    const overrideBtn = $('valStagesOverrideBtn');
    if (overrideBtn) {
      overrideBtn.onclick = function() { runFlowAction('overrideProceed'); };
    }
    const upgradeCtaBtn = $('valUpgradeCtaBtn');
    if (upgradeCtaBtn) { upgradeCtaBtn.onclick = function() { openUpgradePage(); }; }
    const fullReportBtn = $('valFullReportBtn');
    if (fullReportBtn) { fullReportBtn.onclick = function() { openValidationDetail(); }; }
  }

  function syncProofSectionForReview() {
    syncProofSection(false);
  }

  function renderValidationStages() {
    const slot = $('proofResultSlot');
    const list = slot || $('valStagesList');
    const panel = $('valStagesPanel');
    if (!list) { return; }

    if (valPanelState === 'idle') {
      if (slot) { slot.innerHTML = ''; slot.classList.add('hidden'); }
      const actionsIdle = $('proofResultActions');
      if (actionsIdle) { actionsIdle.innerHTML = ''; actionsIdle.classList.add('hidden'); }
      if (panel) { panel.classList.add('hidden'); }
      syncProofSectionForReview();
      return;
    }

    if (slot) { slot.classList.remove('hidden'); }
    if (panel) { panel.classList.add('hidden'); }

    const isDone = valPanelState === 'done';
    const isError = valPanelState === 'error';
    let html = '';
    const actionsEl = $('proofResultActions');

    if (isDone) {
      const r = state.validationResult;
      html = r ? buildThreadReviewSummary(r) : '';
      if (actionsEl) {
        actionsEl.innerHTML = r ? buildProofResultActions() : '';
        actionsEl.classList.toggle('hidden', !r);
      }
    } else if (valPanelState === 'running') {
      html = buildRunningCard();
      if (actionsEl) { actionsEl.innerHTML = ''; actionsEl.classList.add('hidden'); }
    } else if (isError) {
      const msg = valLastError || 'Validation service temporarily unavailable';
      html = '<div class="val-stages-error" role="alert">' +
        '<span>&#9888; ' + escHtml(msg) + '</span>' +
        '<button class="val-stages-error-retry" id="valStagesRetryBtn" aria-label="Retry validation">Retry</button>' +
        '</div>';
      list.innerHTML = html;
      if (actionsEl) { actionsEl.innerHTML = ''; actionsEl.classList.add('hidden'); }
      syncProofSectionForReview();
      const retryBtn = $('valStagesRetryBtn');
      if (retryBtn) {
        retryBtn.onclick = function() {
          beginValidateReviewFromThread();
          vscode.postMessage({ type: 'buttonClick', action: 'validateReview' });
        };
      }
      return;
    }

    list.innerHTML = html;
    syncProofSectionForReview();
    bindProofResultActions();

    const stepsToggle = $('valStepsToggleBtn');
    if (stepsToggle) { stepsToggle.onclick = function() { valTimelineExpanded = !valTimelineExpanded; renderValidationStages(); }; }

    list.querySelectorAll('[data-sc-toggle]').forEach(function(btn) {
      btn.onclick = function() {
        const sectionId = btn.getAttribute('data-sc-toggle');
        if (!sectionId) { return; }
        scorecardSections[sectionId] = !scorecardSections[sectionId];
        renderValidationStages();
      };
    });

    list.querySelectorAll('.val-timeline-toggle').forEach(function(btn) {
      btn.onclick = function() {
        const stepId = btn.getAttribute('data-step-id');
        if (!stepId) { return; }
        expandedTraceSteps[stepId] = !expandedTraceSteps[stepId];
        renderValidationStages();
      };
    });

    const historyBtn = $('valHistoryPageBtn');
    if (historyBtn) { historyBtn.onclick = function() { showAppView('validateReview'); vscode.postMessage({ type: 'loadValidateReviewReports' }); renderValidateReview(); }; }
    const retryPmEnrichmentBtn = $('retryPmEnrichmentBtn');
    if (retryPmEnrichmentBtn) {
      retryPmEnrichmentBtn.onclick = function() {
        retryPmEnrichmentBtn.disabled = true;
        retryPmEnrichmentBtn.textContent = 'Retrying...';
        vscode.postMessage({ type: 'retryPmEnrichment' });
      };
    }
  }

  function ensureValidationVisible() {
    const body = $('proofBody');
    if (body) { body.classList.remove('hidden'); }
    const arrow = document.querySelector('.proof-toggle .toggle-arrow');
    if (arrow) { arrow.innerHTML = '&#9660;'; }
    const wrap = $('validationWrap');
    if (wrap) { wrap.classList.add('hidden'); }
  }

  function renderValidation() {
    const wrap = $('validationWrap');
    const pastWrap = $('pastReviewsWrap');
    const r = state.validationResult;
    if (wrap) { wrap.classList.add('hidden'); }
    const isCore = userTier === 'CORE' || userTier === 'FREE' || userTier === 'free';
    const isProMax = userTier === 'PRO' || userTier === 'MAX' || userTier === 'pro' || userTier === 'max';
    const showHistory = r || validationHistory.length > 0 || isCore || isProMax;
    if (pastWrap) { pastWrap.classList.toggle('hidden', !showHistory); }
    if (r || valPanelState === 'running' || valPanelState === 'error') { ensureValidationVisible(); }

    const providerBadge = $('valProviderBadge');
    if (providerBadge) { providerBadge.textContent = 'AXIOM'; }
    const providerBadgeLegacy = $('valProviderBadgeLegacy');
    if (providerBadgeLegacy) { providerBadgeLegacy.textContent = 'AXIOM'; }
    if (r && r.trace) {
      validationTrace = r.trace;
      syncTraceExpansion(validationTrace);
    }
    renderValidationCounter();
    renderThreadReviewMetrics();
    renderValidationStages();

    const empty = $('valEmpty');
    const resultEl = $('valResult');
    if (empty) { empty.classList.toggle('hidden', !!r || valPanelState !== 'idle'); }
    if (resultEl) { resultEl.classList.add('hidden'); }
    if (r) {
      const resultStatus = r.status || r.overall || 'partial';
      const derivedMissing = Array.isArray(r.results)
        ? r.results.filter(item => item && item.passed === false).map(item => {
          const subtask = item.subtask || 'Requirement';
          const reason = item.reason || 'Not satisfied';
          return subtask + ': ' + reason;
        })
        : [];
      const missingRequirements = (Array.isArray(r.missingRequirements) && r.missingRequirements.length)
        ? r.missingRequirements
        : derivedMissing;
      const derivedDetail = r.detailedExplanation
        || (resultStatus !== 'pass' ? (missingRequirements[0] || r.summary || 'Validation found gaps that still need attention.') : r.summary);
      const suggestions = Array.isArray(r.suggestions) ? r.suggestions : [];
      const qualityNotes = Array.isArray(r.codeQualityNotes) ? r.codeQualityNotes : [];
      const filesReviewed = Array.isArray(r.filesReviewed) ? r.filesReviewed : [];

      const badge = $('valBadge');
      if (badge) { badge.textContent = resultStatus.toUpperCase(); badge.className = 'val-badge ' + resultStatus; }
      const match = $('valMatch');
      if (match) { match.textContent = typeof r.matchPercent === 'number' ? 'Match: ' + r.matchPercent + '%' : ''; match.classList.toggle('hidden', typeof r.matchPercent !== 'number'); }
      const risk = $('valRisk');
      if (risk) { risk.textContent = r.riskLevel ? 'Risk: ' + capitalize(r.riskLevel) : ''; risk.classList.toggle('hidden', !r.riskLevel); }
      const summary = $('valSummary');
      if (summary) { summary.textContent = r.summary || (resultStatus === 'pass' ? 'Code matches the goal.' : 'Goal not fully met.'); }
      const enhanced = $('valEnhanced');
      const hasExtraDetail = Boolean(derivedDetail || missingRequirements.length || suggestions.length || qualityNotes.length || filesReviewed.length);
      if (enhanced) { enhanced.classList.toggle('hidden', !hasExtraDetail); }
      if (hasExtraDetail) {
        setValSection('valDetailedSection', 'valDetailed', derivedDetail);
        setValList('valMissingSection', 'valMissing', missingRequirements);
        setValList('valSuggestionsSection', 'valSuggestions', suggestions);
        setValList('valQualitySection', 'valQuality', isCore ? [] : qualityNotes);
        setValList('valFilesSection', 'valFiles', isCore ? [] : filesReviewed);
      }
      const meta = $('valMeta');
      if (meta) { meta.textContent = formatValidationMeta(r); }
    }

    const controls = $('valHistoryControls');
    const trends = $('valTrends');
    if (controls) { controls.classList.toggle('hidden', !isProMax); }
    if (trends) { trends.classList.toggle('hidden', !isProMax || !validationTrends); }
    renderValidationTrends();
    renderValidationHistory();
  }

  function renderThreadReviewMetrics() {
    const wrap = $('threadReviewMetrics');
    if (!wrap) { return; }
    const metrics = [];
    const report = state.validateReviewResult;
    const incoming = report && Array.isArray(report.sectionScores) ? report.sectionScores : [];
    const pick = function(id, label) {
      const found = incoming.find(function(s) { return s && s.id === id && typeof s.score === 'number'; });
      if (!found) { return; }
      const score = Math.max(0, Math.min(100, Math.round(found.score)));
      metrics.push({ label: label, value: score + '/100', pct: score });
    };
    pick('tests', 'Test coverage');
    pick('maintainability', 'Code quality');
    if (!metrics.length) {
      const r = state.validationResult;
      if (r && typeof r.matchPercent === 'number') {
        const score = Math.max(0, Math.min(100, Math.round(r.matchPercent)));
        metrics.push({ label: 'Match', value: score + '/100', pct: score });
      }
      const done = Array.isArray(r && r.completedGoals) ? r.completedGoals.length : (Array.isArray(r && r.criteriaMet) ? r.criteriaMet.length : 0);
      const pending = Array.isArray(r && r.pendingGoals) ? r.pendingGoals.length : (Array.isArray(r && r.criteriaNotMet) ? r.criteriaNotMet.length : 0);
      const total = done + pending;
      if (total > 0) {
        metrics.push({ label: 'Goals', value: done + '/' + total, pct: Math.round((done / total) * 100) });
      }
    }
    if (!metrics.length) {
      wrap.innerHTML = '';
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    wrap.innerHTML = metrics.map(function(m) {
      return '<div class="thread-metric">' +
        '<div class="thread-metric-row"><span>' + escHtml(m.label) + '</span><span>' + escHtml(m.value) + '</span></div>' +
        '<div class="thread-metric-track"><div class="thread-metric-fill" style="width:' + m.pct + '%"></div></div>' +
      '</div>';
    }).join('');
  }

  function setValSection(sectionId, textId, value) {
    const section = $(sectionId);
    const text = $(textId);
    if (!section || !text) { return; }
    const hasValue = Boolean(value);
    section.classList.toggle('hidden', !hasValue);
    if (hasValue) { text.textContent = value; }
  }

  function setValList(sectionId, listId, items) {
    const section = $(sectionId);
    const list = $(listId);
    if (!section || !list) { return; }
    const hasItems = Array.isArray(items) && items.length > 0;
    section.classList.toggle('hidden', !hasItems);
    if (hasItems) { list.innerHTML = items.map(i => '<li>' + escHtml(i) + '</li>').join(''); }
  }

  function capitalize(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }

  function formatValidationMeta(r) {
    const parts = [];
    if (r.taskId) { parts.push('Task: ' + r.taskId); }
    if (r.taskTitle && r.taskTitle !== r.taskId) { parts.push(r.taskTitle); }
    if (r.branchName) { parts.push('Branch: ' + r.branchName); }
    if (r.commitHash) { parts.push('Commit: ' + r.commitHash.slice(0, 8)); }
    if (r.createdAt) { parts.push('Validated: ' + fmtRelative(r.createdAt)); }
    if (r.durationMs) { parts.push('Duration: ' + Math.round(r.durationMs / 1000) + 's'); }
    return parts.join(' · ');
  }

  function renderValidationTrends() {
    const el = $('valTrends');
    if (!el || !validationTrends) { return; }
    const t = validationTrends;
    if (t.trendDirection === 'not_enough_data') {
      el.innerHTML = '<div class="val-trend-card"><div class="val-trend-note">Not enough validation history to show trends yet.</div></div>';
      return;
    }
    const cards = [
      { k: 'Pass rate', v: t.passRatePercent + '%' },
      { k: 'Avg match', v: t.averageMatchPercent !== undefined ? t.averageMatchPercent + '%' : '—' },
      { k: 'Validations', v: t.validationsThisMonth + ' this month' },
      { k: 'Trend', v: t.trendDirection === 'improving' ? 'Improving' : t.trendDirection === 'declining' ? 'Declining' : 'Stable' },
    ];
    el.innerHTML = cards.map(c => '<div class="val-trend-card"><div class="val-trend-k">' + escHtml(c.k) + '</div><div class="val-trend-v">' + escHtml(c.v) + '</div></div>').join('');
  }

  function renderCodeReview() {
    const runBtn = $('runCodeReviewBtn');
    const errorEl = $('reviewError');
    const statusPill = $('reviewStatusPill');
    const statusText = $('reviewStatusText');
    const listView = $('reviewListView');
    const docView = $('reviewDocView');
    const docContainer = $('reviewDocContainer');

    if (errorEl) {
      errorEl.classList.toggle('hidden', !codeReview.error);
      errorEl.textContent = codeReview.error || '';
    }
    if (statusPill && statusText) {
      statusText.textContent = codeReview.running ? 'Running' : codeReview.result ? 'Done' : 'Ready';
      statusPill.className = 'pill ' + (codeReview.running ? 'weaving' : codeReview.result ? 'standby' : 'standby');
    }
    if (runBtn) { runBtn.disabled = codeReview.running; }

    syncCodeReviewSelection();
    renderCodeReviewReports();
    const r = getSelectedCodeReviewReport();
    const showDoc = Boolean(codeReview.selectedReportId && r);
    if (listView) { listView.classList.toggle('hidden', showDoc); }
    if (docView) { docView.classList.toggle('hidden', !showDoc); }
    if (docContainer) { docContainer.innerHTML = showDoc ? renderCodeReviewDocument(r) : ''; }
  }

  function ensureCodeReviewReportId(report) {
    if (!report) { return ''; }
    if (report.id) { return String(report.id); }
    report.id = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : ('cr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8));
    return report.id;
  }

  function syncCodeReviewSelection() {
    (codeReview.reports || []).forEach(ensureCodeReviewReportId);
    if (codeReview.result) { ensureCodeReviewReportId(codeReview.result); }
    if (codeReview.selectedReportId && !(codeReview.reports || []).some(function(report) { return report.id === codeReview.selectedReportId; })) {
      codeReview.selectedReportId = null;
    }
  }

  function openCodeReviewReport(reportId) {
    if (!reportId) { return; }
    codeReview.selectedReportId = reportId;
    codeReview.result = getSelectedCodeReviewReport();
    renderCodeReview();
  }

  function getSelectedCodeReviewReport() {
    if (codeReview.selectedReportId) {
      const selected = (codeReview.reports || []).find(function(report) { return report.id === codeReview.selectedReportId; });
      if (selected) { return selected; }
    }
    return codeReview.result || (codeReview.reports || [])[0] || null;
  }

  function codeReviewGroupKey(report) {
    const task = String(report.issueIdentifier || report.taskId || '').trim();
    if (task) { return task; }
    return String(report.currentBranch || report.branchName || 'No branch').trim() || 'No branch';
  }

  function codeReviewOptionLabel(report) {
    return [
      report.score !== undefined && report.score !== null ? (report.score + '/100') : '',
      report.status ? String(report.status).replace(/_/g, ' ') : '',
      report.reviewMode ? reviewModeLabel(report.reviewMode) : '',
      report.createdAt ? fmtRelative(report.createdAt) : '',
      shortValidateReportId(report.id),
    ].filter(Boolean).join(' · ');
  }

  function renderCodeReviewReports() {
    const listEl = $('reviewReportList');
    const emptyEl = $('reviewHistoryEmpty');
    if (!listEl) { return; }
    const reports = codeReview.reports || [];
    reports.forEach(ensureCodeReviewReportId);
    if (emptyEl) { emptyEl.classList.toggle('hidden', reports.length > 0); }
    if (!reports.length) {
      listEl.innerHTML = '';
      return;
    }

    const groups = new Map();
    reports.forEach(function(report) {
      const key = codeReviewGroupKey(report);
      if (!groups.has(key)) { groups.set(key, []); }
      groups.get(key).push(report);
    });
    groups.forEach(function(list) {
      list.sort(function(a, b) {
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      });
    });

    listEl.innerHTML = Array.from(groups.entries()).map(function(entry, idx) {
      const key = entry[0];
      const groupReports = entry[1];
      const rows = groupReports.map(function(report) {
        const when = report.createdAt ? fmtRelative(report.createdAt) : '';
        return '<button type="button" class="vr-report-row" data-report-id="' + escHtml(report.id) + '">' +
          '<span class="vr-rrow-dot warn" aria-hidden="true"></span>' +
          '<span class="vr-rrow-verdict">' + escHtml(codeReviewOptionLabel(report)) + '</span>' +
          '<span class="vr-rrow-when">' + escHtml(when) + '</span>' +
          '<span class="vr-rrow-chev" aria-hidden="true">&#8250;</span>' +
        '</button>';
      }).join('');
      return renderReportGroupCard(key, '', rows, { open: idx === 0, count: groupReports.length });
    }).join('');

    listEl.querySelectorAll('.vr-report-row').forEach(function(row) {
      row.addEventListener('click', function() {
        openCodeReviewReport(row.getAttribute('data-report-id'));
      });
    });
  }

  function reviewModeLabel(mode) {
    const map = {
      staged_changes: 'Staged changes',
      current_branch: 'Current branch',
      pm_task: 'PM task',
      before_commit: 'Before commit',
      before_pr: 'Before PR',
    };
    return map[mode] || mode || 'Review';
  }

  function renderCodeReviewDocument(r) {
    const details = r.reviewDetails || {};
    const effort = r.reviewEffort || { score: 1, label: 'Trivial', estimatedMinutes: 10 };
    const filesReviewed = details.reviewedFileCount || (details.filesSelected || []).length || 0;
    const groundedFiles = codeReviewGroundedFiles(r);
    return '<article class="cr-doc">' +
      '<header class="cr-doc-head">' +
        '<div class="cr-doc-title">Technical Review</div>' +
        '<div class="cr-doc-chips">' +
          '<span class="review-badge ' + escHtml(r.status || 'needs_work') + '">' + escHtml((r.status || 'needs_work').replace(/_/g, ' ')) + '</span>' +
          '<span class="review-score">' + escHtml(r.score ?? 0) + '/100</span>' +
          '<span class="review-risk ' + escHtml(r.riskLevel || 'medium') + '">Risk ' + escHtml(capitalize(r.riskLevel || 'medium')) + '</span>' +
          '<span class="cr-chip">' + escHtml(filesReviewed) + ' file' + (filesReviewed === 1 ? '' : 's') + '</span>' +
          (r.reviewMode ? '<span class="cr-chip">' + escHtml(reviewModeLabel(r.reviewMode)) + '</span>' : '') +
          (r.currentBranch ? '<span class="cr-chip">' + escHtml(r.currentBranch) + '</span>' : '') +
        '</div>' +
        '<p>' + escHtml(r.summary || 'Review completed.') + '</p>' +
      '</header>' +
      renderCodeReviewScopeSection(r, groundedFiles) +
      renderReviewPotentialIssues(r) +
      renderReviewDiagrams(r.sequenceDiagrams || []) +
      renderReviewEffort(effort) +
      renderReviewDetails(details, r.changedFilesSummary || []) +
    '</article>';
  }

  function codeReviewGroundedFiles(r) {
    const details = r.reviewDetails || {};
    const files = []
      .concat(r.changedFiles || [])
      .concat(details.filesSelected || [])
      .concat((r.changedFilesSummary || []).flatMap(function(s) { return s.files || []; }));
    return Array.from(new Set(files.filter(Boolean)));
  }

  function codeReviewItemIsGrounded(item, groundedFiles) {
    if (!item || !item.file) { return true; }
    return groundedFiles.includes(item.file);
  }

  function renderCodeReviewScopeSection(r, groundedFiles) {
    const files = groundedFiles.slice(0, 8);
    return '<section class="cr-section cr-scope" id="reviewScopeSection"><h3>Review scope</h3>' +
      '<p>This technical review is grounded only in the collected diff and local context. Jira/Linear scope validation lives in Validate &amp; Review.</p>' +
      '<div class="cr-doc-chips">' +
        (r.reviewMode ? '<span class="cr-chip">' + escHtml(reviewModeLabel(r.reviewMode)) + '</span>' : '') +
        (r.currentBranch ? '<span class="cr-chip">' + escHtml(r.currentBranch) + '</span>' : '') +
        '<span class="cr-chip">' + groundedFiles.length + ' grounded file' + (groundedFiles.length === 1 ? '' : 's') + '</span>' +
      '</div>' +
      (files.length ? '<div class="cr-grounded-files">' + files.map(function(file) { return '<code>' + escHtml(file) + '</code>'; }).join('') + '</div>' : '<div class="cr-empty">No grounded files were recorded for this review.</div>') +
    '</section>';
  }

  function renderReviewPotentialIssues(r) {
    const issueCards = [];
    const groundedFiles = codeReviewGroundedFiles(r);
    const skippedUngrounded = [];
    (r.mustFix || []).forEach(function(item) {
      if (!codeReviewItemIsGrounded(item, groundedFiles)) { skippedUngrounded.push(item.file); return; }
      issueCards.push(renderReviewIssueCard({
        title: item.title,
        file: item.file,
        line: item.line,
        severity: item.severity,
        category: item.category,
        body: item.reason,
        diffSuggestion: item.suggestedFix,
        committableSuggestion: Boolean(item.suggestedFix),
      }));
    });
    (r.inlineComments || []).forEach(function(item) {
      if (!codeReviewItemIsGrounded(item, groundedFiles)) { skippedUngrounded.push(item.file); return; }
      issueCards.push(renderReviewIssueCard({
        title: item.title || item.category || 'Potential issue',
        file: item.file,
        line: item.line,
        severity: item.severity,
        category: item.category,
        body: item.body || item.comment,
        diffSuggestion: item.diffSuggestion || item.suggestion,
        committableSuggestion: item.committableSuggestion,
      }));
    });
    (r.suggestions || []).forEach(function(item) {
      if (!codeReviewItemIsGrounded(item, groundedFiles)) { skippedUngrounded.push(item.file); return; }
      issueCards.push(renderReviewIssueCard({
        title: item.title,
        file: item.file,
        line: item.line,
        severity: 'low',
        category: 'suggestion',
        body: item.reason,
        diffSuggestion: item.suggestedFix,
        committableSuggestion: Boolean(item.suggestedFix),
      }));
    });
    if (!issueCards.length) {
      issueCards.push('<div class="cr-empty">No potential issues were returned.</div>');
    }
    const filteredNote = skippedUngrounded.length
      ? '<div class="cr-section-note">Hidden ungrounded AI items referencing files outside this review: ' + escHtml(Array.from(new Set(skippedUngrounded)).join(' · ')) + '</div>'
      : '';
    return '<section class="cr-section" id="reviewPotentialIssuesSection"><h3>Potential issues</h3>' + filteredNote + '<div class="cr-issue-list" id="reviewPotentialIssues">' + issueCards.join('') + '</div></section>';
  }

  function renderReviewIssueCard(item) {
    const loc = item.file ? '<div class="cr-issue-file">' + escHtml(item.file) + (item.line ? ':' + escHtml(item.line) : '') + '</div>' : '';
    return '<article class="cr-issue-card ' + escHtml(item.severity || 'medium') + '">' +
      '<div class="cr-issue-head"><span class="cr-warning">!</span><strong>' + escHtml(item.title || 'Potential issue') + '</strong><span class="cr-chip severity ' + escHtml(item.severity || 'medium') + '">' + escHtml(capitalize(item.severity || 'medium')) + '</span><span class="cr-chip">' + escHtml((item.category || 'general').replace(/_/g, ' ')) + '</span></div>' +
      loc +
      '<div class="cr-issue-body">' + escHtml(item.body || '') + '</div>' +
      renderSuggestionDiff(item.diffSuggestion) +
      (item.committableSuggestion ? '<details class="cr-details"><summary>Committable suggestion</summary><div class="cr-detail-text">Ready-to-copy suggestion. Tyne will not auto-apply it.</div></details>' : '') +
    '</article>';
  }

  function renderSuggestionDiff(text) {
    if (!text) { return ''; }
    const lines = String(text).split(/\r?\n/).filter(function(line) { return line.trim() !== ''; });
    return '<pre class="cr-suggestion-diff" id="reviewSuggestionDiff">' + lines.map(function(line) {
      const cls = line.trim().startsWith('-') ? 'remove' : line.trim().startsWith('+') ? 'add' : 'ctx';
      return '<code class="' + cls + '">' + escHtml(line) + '</code>';
    }).join('') + '</pre>';
  }

  function renderReviewDiagrams(diagrams) {
    if (!diagrams.length) { return ''; }
    return '<section class="cr-section" id="reviewSequenceDiagramsSection"><h3>Sequence diagram(s)</h3>' + diagrams.map(function(d) {
      const related = (d.relatedFiles || []).filter(Boolean);
      const files = related.length ? '<div class="cr-section-note">Grounded in ' + escHtml(related.join(' · ')) + '</div>' : '<div class="cr-section-note">No related files returned; treat as illustrative.</div>';
      return '<div class="cr-diagram"><div class="cr-diagram-title">' + escHtml(d.title || 'Flow diagram') + '</div>' + files + '<pre class="cr-mermaid" id="reviewSequenceDiagram"><code>' + escHtml(d.mermaid || '') + '</code></pre></div>';
    }).join('') + '</section>';
  }

  function renderReviewEffort(effort) {
    return '<section class="cr-section" id="reviewEffortSection"><h3>Estimated technical review effort</h3><div class="cr-effort"><span>Target ' + escHtml(effort.score || 1) + '</span><span>' + escHtml(effort.label || 'Trivial') + '</span><span>~' + escHtml(effort.estimatedMinutes || 10) + ' minutes</span></div>' + (effort.reason ? '<p>' + escHtml(effort.reason) + '</p>' : '') + '</section>';
  }

  function renderReviewDetails(details, summaries) {
    const selected = details.filesSelected || [];
    const skipped = details.filesSkipped || [];
    const none = details.noReviewableChangeFiles || [];
    const summaryHtml = summaries.length ? '<details class="cr-details" open><summary>Changed files summary (' + summaries.length + ')</summary>' + summaries.map(function(s) {
      return '<div class="cr-file-summary"><strong>' + escHtml(s.title || 'Change group') + '</strong><div>' + escHtml(s.summary || '') + '</div><small>' + escHtml((s.files || []).join(' · ')) + '</small></div>';
    }).join('') + '</details>' : '';
    return '<section class="cr-section" id="reviewDetailsSection"><h3>Review details</h3>' +
      summaryHtml +
      renderFileDetails('Files selected for processing', selected, true) +
      renderFileDetails('Files with no reviewable changes', none, false) +
      renderFileDetails('Files skipped', skipped, false) +
    '</section>';
  }

  function renderFileDetails(title, files, open) {
    if (!files || !files.length) { return ''; }
    return '<details class="cr-details" ' + (open ? 'open' : '') + '><summary>' + escHtml(title) + ' (' + files.length + ')</summary><ul>' + files.map(function(file) { return '<li>' + escHtml(file) + '</li>'; }).join('') + '</ul></details>';
  }

  function reviewStageLabel(stage) {
    const labels = {
      scope_resolution: 'Preparing review',
      collect_context: 'Collecting code context',
      local_quality_engine: 'Running local checks',
      edge_function_call: 'AI reviewing prioritized files',
      complete: 'Finalizing results'
    };
    return labels[stage] || 'Reviewing changes';
  }

  /** Ordered live-timeline stages — delightful copy, keys match host progress. */
  var REVIEW_LIVE_STAGES = [
    {
      id: 'scope_resolution',
      title: 'Resolved what to review',
      detail: 'Picking staged changes, unstaged edits, or the last commit.',
    },
    {
      id: 'collect_context',
      title: 'Gathered codebase context',
      detail: 'Pulling changed files and nearby references for grounding.',
    },
    {
      id: 'local_quality_engine',
      title: 'Running local checks',
      detail: 'Deterministic scanners before the AI pass.',
      children: [
        { label: 'Static analysis' },
        { label: 'Secrets & injection' },
        { label: 'Quality / vibe scanners' },
      ],
    },
    {
      id: 'edge_function_call',
      title: 'AI reviewing prioritized files',
      detail: 'Deep pass on risky diffs, scope drift, and verdict.',
      children: [
        { label: 'Chunked file review' },
        { label: 'Scope & security agents' },
        { label: 'Findings merge' },
      ],
    },
    {
      id: 'complete',
      title: 'Finalizing results',
      detail: 'Scoring, grounding, and packing the report.',
    },
  ];

  function reviewLiveStageIndex(stage) {
    for (var i = 0; i < REVIEW_LIVE_STAGES.length; i++) {
      if (REVIEW_LIVE_STAGES[i].id === stage) { return i; }
    }
    return 0;
  }

  function buildReviewLiveTimeline() {
    var stage = validateReview.progressStage || 'scope_resolution';
    var activeIdx = reviewLiveStageIndex(stage);
    var status = validateReview.progressStatus || 'started';
    if (status === 'done' && activeIdx < REVIEW_LIVE_STAGES.length - 1) {
      activeIdx = Math.min(activeIdx + 1, REVIEW_LIVE_STAGES.length - 1);
    }
    if (!validateReview.liveRevealed) { validateReview.liveRevealed = {}; }

    var eta = formatReviewEtaLine();
    var stepsHtml = '';
    REVIEW_LIVE_STAGES.forEach(function(step, idx) {
      if (idx > activeIdx) { return; }
      var isActive = idx === activeIdx && stage !== 'complete';
      var isDone = idx < activeIdx || (stage === 'complete' && status === 'done');
      var wasNew = !validateReview.liveRevealed[step.id];
      validateReview.liveRevealed[step.id] = true;
      var stateClass = isDone ? 'done' : (isActive ? 'active' : '');
      var enterClass = wasNew ? ' enter' : '';
      var children = '';
      if (step.children && (isActive || isDone)) {
        children = '<ul class="review-live-children">' + step.children.map(function(c) {
          return '<li><span class="review-live-child-dot" aria-hidden="true"></span>' +
            escHtml(c.label) + '</li>';
        }).join('') + '</ul>';
      }
      stepsHtml +=
        '<div class="review-live-step ' + stateClass + enterClass + '" data-stage="' + escHtml(step.id) + '">' +
          '<div class="review-live-icon" aria-hidden="true">' +
            (isDone
              ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
              : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>') +
          '</div>' +
          '<div class="review-live-copy">' +
            '<div class="review-live-title">' + escHtml(isActive && !isDone ? reviewStageLabel(step.id) : step.title) + '</div>' +
            (step.detail ? '<div class="review-live-detail">' + escHtml(step.detail) + '</div>' : '') +
            children +
          '</div>' +
        '</div>';
    });

    var working =
      '<div class="review-live-step working">' +
        '<div class="review-live-icon sparkle" aria-hidden="true">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.2 6.3L19 12l-5.8 3.7L12 22l-1.2-6.3L5 12l5.8-3.7L12 2z"/></svg>' +
        '</div>' +
        '<div class="review-live-copy">' +
          '<div class="review-live-title">Working on it…</div>' +
          '<div class="review-live-detail review-live-eta">' + escHtml(eta.elapsed + 's elapsed · ' + eta.remaining) + '</div>' +
        '</div>' +
      '</div>';

    return '<details class="review-live" open>' +
      '<summary class="review-live-head">' +
        '<span>Reviewing against your task</span>' +
        '<span class="review-live-chevron" aria-hidden="true"></span>' +
      '</summary>' +
      '<div class="review-live-spine" role="status" aria-live="polite">' +
        stepsHtml +
        (stage === 'complete' && status === 'done' ? '' : working) +
      '</div>' +
    '</details>';
  }

  function reviewStagePct(stage) {
    const map = {
      scope_resolution: 12,
      collect_context: 28,
      local_quality_engine: 48,
      edge_function_call: 72,
      complete: 92
    };
    return map[stage] || 35;
  }

  function reviewEtaRange(stage, elapsedSeconds) {
    const ranges = {
      scope_resolution: [15, 75],
      collect_context: [12, 70],
      local_quality_engine: [10, 65],
      edge_function_call: [5, 55],
      complete: [0, 3]
    };
    const base = ranges[stage] || [10, 80];
    return [
      Math.max(0, base[0] - Math.floor(elapsedSeconds / 4)),
      Math.max(base[0], base[1] - Math.floor(elapsedSeconds / 2))
    ];
  }

  function formatReviewEtaLine() {
    const elapsed = Math.max(0, Math.floor((Date.now() - (validateReview.startedAt || Date.now())) / 1000));
    const range = reviewEtaRange(validateReview.progressStage, elapsed);
    const remaining = range[1] <= 3
      ? 'almost done'
      : 'about ' + Math.max(1, range[0]) + '–' + range[1] + 's remaining';
    return { elapsed: elapsed, remaining: remaining, label: reviewStageLabel(validateReview.progressStage) };
  }

  function updateValidateReviewStatus() {
    if (!validateReview.running) { return; }
    const eta = formatReviewEtaLine();
    // Prefer ticking ETA in place — full rebuild only when the spine is missing.
    const etaEl = document.querySelector('.review-live-eta');
    if (etaEl) {
      etaEl.textContent = eta.elapsed + 's elapsed · ' + eta.remaining;
      return;
    }
    const statusEl = $('validateReviewStatus');
    if (statusEl && !statusEl.classList.contains('hidden')) {
      statusEl.className = 'review-live-host';
      statusEl.innerHTML = buildReviewLiveTimeline();
    }
  }

  function syncReviewLiveTimeline() {
    if (!validateReview.running) { return; }
    const statusEl = $('validateReviewStatus');
    if (statusEl) {
      statusEl.classList.remove('hidden');
      statusEl.className = 'review-live-host';
      statusEl.innerHTML = buildReviewLiveTimeline();
    }
  }

  function startValidateReviewEta() {
    if (!validateReview.startedAt) { validateReview.startedAt = Date.now(); }
    if (validateReviewEtaTimer) { clearInterval(validateReviewEtaTimer); }
    updateValidateReviewStatus();
    validateReviewEtaTimer = setInterval(updateValidateReviewStatus, 1000);
  }

  function stopValidateReviewEta() {
    if (validateReviewEtaTimer) { clearInterval(validateReviewEtaTimer); }
    validateReviewEtaTimer = null;
    validateReview.startedAt = 0;
    validateReview.progressStage = '';
  }

  function setFlowValidateBusy(on) {
    renderFlow();
    const runner = $('flowRunner');
    const fill = $('flowRunnerFill');
    if (runner) { runner.classList.toggle('on', !!on); }
    if (fill) {
      fill.style.width = on ? '35%' : '0%';
      fill.style.animation = on ? 'runnerSlide 1.1s linear infinite' : 'none';
    }
  }

  /** Thread CTA / Re-run: stay on Thread with inline loader. */
  function beginValidateReviewFromThread() {
    validateReviewOrigin = 'thread';
    validateReview.running = true;
    validateReview.error = null;
    validateReview.upgradeRequired = false;
    validateReview.progressStage = 'scope_resolution';
    validateReview.progressStatus = 'started';
    validateReview.liveRevealed = {};
    validateReview.startedAt = Date.now();
    valPanelState = 'running';
    valLastError = null;
    valTimelineExpanded = false;
    for (const k in scorecardSections) { delete scorecardSections[k]; }
    startProofLive();
    ensureValidationVisible();
    setFlowValidateBusy(true);
    startValidateReviewEta();
    renderValidationStages();
  }

  /** Reviews page Run button: full-page runner + auto-open report. */
  function beginValidateReviewFromPage() {
    validateReviewOrigin = 'page';
    validateReview.running = true;
    validateReview.error = null;
    validateReview.upgradeRequired = false;
    validateReview.progressStage = 'scope_resolution';
    validateReview.progressStatus = 'started';
    validateReview.liveRevealed = {};
    setValidateReviewRunner(true);
    renderValidateReview();
  }

  function setValidateReviewRunner(on, stage) {
    const runner = $('validateReviewRunner');
    const fill = $('validateReviewRunnerFill');
    if (stage) { validateReview.progressStage = stage; }
    if (runner) { runner.classList.toggle('on', on); }
    if (fill) {
      fill.style.width = on ? '35%' : '0%';
      fill.style.animation = on ? 'runnerSlide 1.1s linear infinite' : 'none';
    }
    if (on) { startValidateReviewEta(); }
    else { stopValidateReviewEta(); }
  }

  function renderValidateReview() {
    const runBtn = $('runValidateReviewBtn');
    const errorEl = $('validateReviewError');
    const listView = $('validateReviewListView');
    const docView = $('validateReviewDocView');
    const docContainer = $('validateReviewDocContainer');
    const trendsView = $('validateReviewTrendsContainer');

    if (errorEl) {
      errorEl.classList.toggle('hidden', !validateReview.error);
      if (validateReview.error && validateReview.upgradeRequired) {
        errorEl.innerHTML = escHtml(validateReview.error) +
          ' <button type="button" class="btn primary compact" id="validateReviewUpgradeBtn">Upgrade plan</button>';
        const upBtn = $('validateReviewUpgradeBtn');
        if (upBtn) { upBtn.onclick = function() { openUpgradePage(); }; }
      } else {
        errorEl.textContent = validateReview.error || '';
      }
    }
    if (runBtn) { runBtn.disabled = validateReview.running; runBtn.textContent = validateReview.running ? 'Reviewing…' : 'Run Review'; }
    setValidateReviewRunner(validateReview.running, validateReview.progressStage);
    const statusEl = $('validateReviewStatus');
    if (statusEl) {
      statusEl.classList.toggle('hidden', !validateReview.running);
      if (validateReview.running) { updateValidateReviewStatus(); }
      else { statusEl.innerHTML = ''; statusEl.className = 'review-live-host hidden'; }
    }

    renderValidateReviewReports();

    const r = getSelectedValidateReviewReport();
    const showDoc = Boolean(validateReview.selectedReportId && r);
    if (listView) { listView.classList.toggle('hidden', showDoc); }
    if (docView) { docView.classList.toggle('hidden', !showDoc); }
    if (trendsView) { trendsView.classList.toggle('hidden', showDoc); }
    if (docContainer) {
      if (showDoc) {
        try {
          docContainer.innerHTML = renderValidateReviewDocument(r);
        } catch (err) {
          console.error('Failed to render Validate & Review detail report', err);
          docContainer.innerHTML = renderValidateReviewRenderError(r, err);
        }
      } else {
        docContainer.innerHTML = '';
      }
    }
    if (showDoc && docContainer) {
      const toggleBtns = docContainer.querySelectorAll('.vr-view-toggle-btn');
      toggleBtns.forEach(function(btn) {
        btn.addEventListener('click', function() {
          if (btn.disabled) { return; }
          validateReview.viewMode = btn.dataset.view || 'structured';
          renderValidateReview();
        });
      });
      docContainer.querySelectorAll('[data-verbosity]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          const next = btn.getAttribute('data-verbosity') || 'balanced';
          if (next !== 'focus' && next !== 'balanced' && next !== 'thorough') { return; }
          if (actionNeededVerbosity === next) { return; }
          actionNeededVerbosity = next;
          persistReviewUiState();
          renderValidateReview();
        });
      });
      docContainer.querySelectorAll('[data-compliance-export]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          const format = btn.getAttribute('data-compliance-export') || 'markdown';
          const report = getSelectedValidateReviewReport() || r;
          vscode.postMessage({ type: 'exportComplianceEvidence', format: format, report: report });
        });
      });
      docContainer.querySelectorAll('[data-export-vr-pdf]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          const report = getSelectedValidateReviewReport() || r;
          vscode.postMessage({ type: 'exportValidateReviewPdf', report: report });
        });
      });
      docContainer.querySelectorAll('.vr-view-full-link[data-view]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          validateReview.viewMode = btn.dataset.view || 'full';
          renderValidateReview();
        });
      });
      docContainer.querySelectorAll('[data-wf-save]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          const card = btn.closest('[data-compliance-finding-id]');
          if (!card) return;
          const findingId = card.getAttribute('data-compliance-finding-id') || '';
          const statusEl = card.querySelector('[data-wf-field="status"]');
          const ownerEl = card.querySelector('[data-wf-field="owner"]');
          const resolutionEl = card.querySelector('[data-wf-field="resolution"]');
          const titleEl = card.querySelector('.vr-security-detail-title');
          vscode.postMessage({
            type: 'complianceFindingWorkflow',
            reportId: (r && r.id) || validateReview.selectedReportId || '',
            findingId: findingId,
            findingTitle: titleEl ? titleEl.textContent : '',
            status: statusEl ? statusEl.value : 'open',
            owner: ownerEl ? ownerEl.value : '',
            resolution: resolutionEl ? resolutionEl.value : '',
          });
        });
      });
    }
  }

  function renderValidateReviewRenderError(r, err) {
    const message = err && err.message ? err.message : 'The saved report could not be rendered.';
    return '<article class="vr-structured-doc vr-doc-aligned">' +
      '<section class="vr-visual-summary blocked">' +
        '<div class="vr-summary-main">' +
          '<div class="vr-summary-title">Detail report render failed</div>' +
          '<div class="vr-summary-copy">' + escHtml(message) + '</div>' +
        '</div>' +
      '</section>' +
      '<section class="vr-full-report-section vr-doc-aligned-content">' +
        '<div class="vr-text">' + escHtml((r && (r.fullReport || r.summary)) || 'No report body was returned.') + '</div>' +
      '</section>' +
    '</article>';
  }

  function renderReviewTrends(trends, reason) {
    const container = $('validateReviewTrendsContainer');
    if (!container) { return; }
    if (!trends) {
      container.innerHTML = '<div class="vr-trends-empty">' + escHtml(reason || 'No review trends available.') + '</div>';
      return;
    }
    const trendIcon = trends.trendDirection === 'improving' ? '↗' : trends.trendDirection === 'declining' ? '↘' : trends.trendDirection === 'stable' ? '→' : '?';
    const trendLabel = trends.trendDirection === 'not_enough_data' ? 'Not enough data' : capitalize(trends.trendDirection);

    const issueTypes = (trends.commonIssueTypes || []).map(function(item) {
      return '<div class="vr-trend-row"><span class="vr-sev-chip ' + escHtml(item.severity) + '">' + escHtml(item.severity) + '</span>' +
        '<span class="vr-trend-cat">' + escHtml(capitalize(item.category || 'other')) + '</span>' +
        '<span class="vr-trend-count">' + item.count + '</span></div>';
    }).join('');

    const riskyFiles = (trends.riskyFiles || []).map(function(item) {
      return '<div class="vr-trend-row"><code>' + escHtml(item.file) + '</code>' +
        '<span class="vr-sev-chip ' + escHtml(item.avgSeverity) + '">' + escHtml(item.avgSeverity) + '</span>' +
        '<span class="vr-trend-count">' + item.findingCount + ' finding' + (item.findingCount === 1 ? '' : 's') + '</span></div>';
    }).join('');

    const topTitles = (trends.topFindingTitles || []).map(function(item) {
      return '<div class="vr-trend-row"><span class="vr-trend-title">' + escHtml(item.title) + '</span>' +
        '<span class="vr-trend-count">' + item.count + 'x</span></div>';
    }).join('');

    const vibeBreakdown = trends.vibeCodeTrend
      ? '<div class="vr-trend-vibe"><span class="vr-vibe-high">High: ' + (trends.vibeCodeTrend.high || 0) + '</span>' +
        '<span class="vr-vibe-medium">Medium: ' + (trends.vibeCodeTrend.medium || 0) + '</span>' +
        '<span class="vr-vibe-low">Low: ' + (trends.vibeCodeTrend.low || 0) + '</span></div>'
      : '';

    const scoreSparkline = (trends.scoreTrend || []).length > 1
      ? '<div class="vr-trend-spark">' + (trends.scoreTrend || []).map(function(s) { return '<span class="vr-spark-bar" style="height:' + Math.max(2, s) + '%">' + s + '</span>'; }).join('') + '</div>'
      : '';

    container.innerHTML = '<div class="vr-trends-panel">' +
      '<div class="vr-trends-header">' +
        '<div class="vr-trends-stat"><span class="vr-trends-stat-val">' + trends.totalReviews + '</span><span class="vr-trends-stat-label">Reviews</span></div>' +
        '<div class="vr-trends-stat"><span class="vr-trends-stat-val">' + trends.averageScore + '</span><span class="vr-trends-stat-label">Avg score</span></div>' +
        '<div class="vr-trends-stat"><span class="vr-trends-stat-val">' + trends.passRatePercent + '%</span><span class="vr-trends-stat-label">Pass rate</span></div>' +
        '<div class="vr-trends-stat"><span class="vr-trends-stat-val ' + escHtml(trends.trendDirection) + '">' + trendIcon + ' ' + trendLabel + '</span><span class="vr-trends-stat-label">Trend</span></div>' +
      '</div>' +
      (scoreSparkline ? '<div class="vr-trends-section"><div class="vr-trends-section-label">Score trend (last 10)</div>' + scoreSparkline + '</div>' : '') +
      (issueTypes ? '<div class="vr-trends-section"><div class="vr-trends-section-label">Common issue types</div>' + issueTypes + '</div>' : '') +
      (riskyFiles ? '<div class="vr-trends-section"><div class="vr-trends-section-label">Risky files</div>' + riskyFiles + '</div>' : '') +
      (topTitles ? '<div class="vr-trends-section"><div class="vr-trends-section-label">Recurring findings</div>' + topTitles + '</div>' : '') +
      (vibeBreakdown ? '<div class="vr-trends-section"><div class="vr-trends-section-label">Vibe-code risk distribution</div>' + vibeBreakdown + '</div>' : '') +
    '</div>';
  }

  function reviewScoreValue(r, id) {
    const section = getReviewSectionScores(r).find(function(item) { return item.id === id; });
    if (section) { return normalizeReviewScore(section.score); }
    return normalizeReviewScore(r.score || 0);
  }

  function gaugeTone(score) {
    if (score >= 85) { return 'good'; }
    if (score >= 70) { return 'warn'; }
    return 'bad';
  }

  function shortReviewSummary(r) {
    const raw = String((r && r.summary) || '').replace(/\s+/g, ' ').trim();
    if (!raw) { return ''; }
    const first = raw.split(/\.\s+/)[0].trim();
    const clipped = first.length > 140 ? first.slice(0, 137) + '…' : first;
    return /[.!?]$/.test(clipped) ? clipped : clipped + '.';
  }

  function renderReviewMetaChips(r) {
    const chips = [];
    if (r.status) { chips.push(['Status', String(r.status).replace(/_/g, ' ')]); }
    if (r.riskLevel) { chips.push(['Risk', r.riskLevel]); }
    if (r.vibeCodeRisk) { chips.push(['Vibe', r.vibeCodeRisk]); }
    if (r.actualModeUsed) { chips.push(['Mode', r.actualModeUsed]); }
    if (r.prSizeClass) { chips.push(['PR size', r.prSizeClass]); }
    if (r.aiSlop && typeof r.aiSlop.slop_score === 'number') {
      chips.push(['AI slop', String(r.aiSlop.slop_score)]);
    }
    const findings = (r.findings || []).length;
    if (findings) { chips.push(['Findings', String(findings)]); }
    const files = (r.visualDiff || []).length;
    if (files) { chips.push(['Files', String(files)]); }
    const pending = (r.pendingGoals || []).length;
    if (pending) { chips.push(['Pending', String(pending)]); }
    const missing = (r.missingTests || []).length;
    if (missing) { chips.push(['Missing tests', String(missing)]); }
    if (r.securityStatus && r.securityStatus !== 'passed') { chips.push(['Security', String(r.securityStatus).replace(/_/g, ' ')]); }
    if (r.complianceStatus && r.complianceStatus !== 'not_enabled') {
      const raw = String(r.complianceStatus).toLowerCase().replace(/\s+/g, '_');
      const label = raw === 'blocked' || raw === 'failed' ? 'Blocked'
        : raw === 'review_required' || raw === 'needs_work' ? 'Review required'
        : raw === 'issues_detected' || raw === 'warning' ? 'Issues detected'
        : raw === 'no_violations' || raw === 'passed' ? 'No detected violations'
        : String(r.complianceStatus).replace(/_/g, ' ');
      chips.push(['Compliance', label]);
    }
    if (r.issueIdentifier) { chips.push(['Task', r.issueIdentifier]); }
    if (r.branchName) { chips.push(['Branch', r.branchName]); }
    if (!chips.length) { return ''; }
    return '<div class="vr-meta-chips">' + chips.map(function(pair) {
      return '<span class="vr-meta-chip"><em>' + escHtml(pair[0]) + '</em> ' + escHtml(pair[1]) + '</span>';
    }).join('') + '</div>';
  }

  function renderScoreGauge(label, score, active) {
    const pct = normalizeReviewScore(score);
    const tone = gaugeTone(pct);
    return '<div class="vr-gauge vr-gauge-' + tone + (active ? ' active' : '') + '" title="' + escHtml(label) + ': ' + pct + '%">' +
      '<div class="vr-gauge-meter" role="img" aria-label="' + escHtml(label) + ' ' + pct + ' percent">' +
        '<svg class="vr-gauge-svg" viewBox="0 0 36 36" aria-hidden="true">' +
          '<circle class="vr-gauge-track" cx="18" cy="18" r="15.5" pathLength="100"></circle>' +
          '<circle class="vr-gauge-fill" cx="18" cy="18" r="15.5" pathLength="100" stroke-dasharray="' + pct + ' 100"></circle>' +
        '</svg>' +
        '<b class="vr-gauge-score">' + pct + '</b>' +
      '</div>' +
      '<span class="vr-gauge-label">' + escHtml(label) + '</span>' +
    '</div>';
  }

  function languageBreakdownFromReport(r) {
    if (Array.isArray(r.languageBreakdown) && r.languageBreakdown.length) { return r.languageBreakdown; }
    const files = Array.isArray(r.visualDiff) ? r.visualDiff : [];
    const totals = {};
    files.forEach(function(file) {
      const path = String(file.file || '');
      if (!path) { return; }
      const base = path.split('/').pop() || path;
      const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
      const map = {
        ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
        py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', cpp: 'C++', cc: 'C++', cxx: 'C++', c: 'C',
        cs: 'C#', rb: 'Ruby', php: 'PHP', css: 'CSS', scss: 'SCSS', html: 'HTML',
        sh: 'Shell', bash: 'Shell', ps1: 'PowerShell', md: 'Markdown', json: 'JSON', yml: 'YAML', yaml: 'YAML',
      };
      const language = ext === 'sql'
        ? (/(^|\/)supabase\//i.test(path.replace(/\\/g, '/')) ? 'PL/pgSQL' : 'SQL')
        : (map[ext] || (ext ? ext.toUpperCase() : 'Other'));
      const weight = Math.max(Number(file.additions) || 0, 1);
      totals[language] = (totals[language] || 0) + weight;
    });
    const total = Object.keys(totals).reduce(function(sum, key) { return sum + totals[key]; }, 0);
    if (!total) { return []; }
    return Object.keys(totals).map(function(language) {
      return { language: language, lines: totals[language], percent: Math.round((totals[language] / total) * 1000) / 10 };
    }).sort(function(a, b) { return b.lines - a.lines; }).slice(0, 8);
  }

  function contributionBreakdownFromReport(r) {
    return Array.isArray(r.contributionBreakdown) ? r.contributionBreakdown : [];
  }

  function renderLanguagesPanel(r) {
    const rows = languageBreakdownFromReport(r);
    if (!rows.length) {
      return '<div class="vr-section-empty">No language data from changed files.</div>';
    }
    const colors = ['var(--accent)', 'var(--green)', 'var(--amber)', 'var(--muted)', 'var(--faint)', 'var(--border-strong)', 'var(--fg)', 'var(--muted)'];
    const bar = rows.map(function(row, index) {
      const grow = Math.max(0.1, Number(row.percent) || 0);
      return '<span class="vr-lang-seg" style="flex:' + grow + ' 0 0;background:' + colors[index % colors.length] + '" title="' + escHtml(row.language) + ' ' + row.percent + '%"></span>';
    }).join('');
    const legend = rows.map(function(row, index) {
      return '<li><span class="vr-lang-swatch" style="background:' + colors[index % colors.length] + '"></span>' +
        '<span>' + escHtml(row.language) + '</span><b>' + Number(row.percent).toFixed(1) + '%</b></li>';
    }).join('');
    return '<div class="vr-lang-bar" aria-hidden="true">' + bar + '</div><ul class="vr-lang-legend">' + legend + '</ul>';
  }

  function renderContributorsPanel(r) {
    const rows = contributionBreakdownFromReport(r);
    if (!rows.length) {
      return '<div class="vr-section-empty">No authorship signals in this review.</div>';
    }
    return '<ul class="vr-contrib-list">' + rows.map(function(row) {
      const icon = row.kind === 'ai'
        ? '<span class="vr-contrib-ai" aria-hidden="true">' + escHtml((row.label || '?').slice(0, 1).toUpperCase()) + '</span>'
        : '<span class="vr-contrib-user" aria-hidden="true"></span>';
      return '<li>' + icon +
        '<span class="vr-contrib-name">' + escHtml(row.label) + '</span>' +
        '<b>' + Number(row.percent || 0).toFixed(1) + '%</b>' +
        '<div class="vr-contrib-track"><div class="vr-contrib-fill' + (row.kind === 'ai' ? ' ai' : '') + '" style="width:' + Math.max(0, Math.min(100, row.percent || 0)) + '%"></div></div>' +
      '</li>';
    }).join('') + '</ul>';
  }

  function renderComplianceOverviewStrip(r) {
    if (!r.complianceStatus || r.complianceStatus === 'not_enabled') return '';
    var assessments = Array.isArray(r.complianceAssessments) ? r.complianceAssessments : [];
    var regressions = Array.isArray(r.complianceRegressions) ? r.complianceRegressions : [];
    var findings = Array.isArray(r.complianceFindings) ? r.complianceFindings
      : (r.findings || []).filter(function(f) { return f.category === 'compliance'; });
    function riskFromStatus(status, score) {
      var raw = String(status || '').toLowerCase();
      if (raw === 'blocked' || raw === 'failed') return 'High';
      if (raw === 'review_required' || raw === 'needs_work') return 'Medium';
      if (raw === 'issues_detected' || raw === 'warning') return 'Medium';
      if (typeof score === 'number' && score < 70) return 'Medium';
      return 'Low';
    }
    var cards = assessments.slice(0, 6).map(function(a) {
      return '<div class="vr-gov-card">' +
        '<div class="vr-gov-name">' + escHtml(a.name || a.framework || 'Framework') + '</div>' +
        '<div class="vr-gov-meta"><span>Risk:</span> <b>' + escHtml(riskFromStatus(a.status, a.score)) + '</b></div>' +
      '</div>';
    }).join('');
    if (!cards && r.complianceStatus) {
      cards = '<div class="vr-gov-card"><div class="vr-gov-name">Compliance</div>' +
        '<div class="vr-gov-meta"><span>Risk:</span> <b>' + escHtml(riskFromStatus(r.complianceStatus, reviewScoreValue(r, 'compliance'))) + '</b></div></div>';
    }
    return '<section class="vr-compliance-gov" aria-label="Compliance overview">' +
      '<div class="vr-gov-grid">' + cards + '</div>' +
      '<div class="vr-gov-stats">' +
        '<span><em>New Findings:</em> ' + findings.length + '</span>' +
        '<span><em>Regressions:</em> ' + regressions.length + '</span>' +
      '</div></section>';
  }

  function renderQualityScorecard(r) {
    const card = r.qualityScorecard || {};
    const hasQuality = typeof r.qualityScore === 'number' || card.overall != null
      || card.maintainability != null || card.vibe != null;
    if (!hasQuality) { return ''; }
    const debt = typeof r.debtMinutes === 'number' ? r.debtMinutes : (r.qualityMetrics && r.qualityMetrics.debtMinutes);
    const rating = r.qualityMetrics && r.qualityMetrics.rating;
    const debtRatio = r.qualityMetrics && r.qualityMetrics.debtRatio;
    const qualityStat = function(label, score) {
      const pct = normalizeReviewScore(score);
      const tone = gaugeTone(pct);
      return '<div class="vr-qs-item">' +
        '<span class="vr-qs-k">' + escHtml(label) + '</span>' +
        '<span class="vr-qs-track"><i class="' + tone + '" style="width:' + pct + '%"></i></span>' +
        '<b class="vr-qs-v">' + pct + '</b>' +
      '</div>';
    };
    return '<section class="vr-quality-scorecard" aria-label="Code quality scorecard">' +
      '<div class="vr-mini-label">Code Quality' + (rating ? ' · Grade ' + escHtml(String(rating)) : '') + '</div>' +
      '<div class="vr-qs-grid">' +
        qualityStat('Quality', r.qualityScore != null ? r.qualityScore : card.overall) +
        qualityStat('Maintainability', card.maintainability) +
        qualityStat('Vibe', card.vibe) +
        qualityStat('Architecture', card.architecture) +
      '</div>' +
      (debt != null ? '<p class="vr-quality-debt muted">Est. new debt: ' + escHtml(String(debt)) + ' min'
        + (debtRatio != null ? ' · debt ratio ' + escHtml(String(debtRatio)) : '')
        + '</p>' : '') +
    '</section>';
  }

  // ── Display severity (CodeRabbit-style scale) ──────────────────────────────
  // Wire format keeps critical/high/medium/low; the UI renders through this map.
  var SEVERITY_META = {
    critical: { label: 'CRITICAL' },
    major:    { label: 'MAJOR' },
    minor:    { label: 'MINOR' },
    nit:      { label: 'NIT' },
    info:     { label: 'INFO' },
  };

  function displaySeverity(severity, category) {
    var raw = String(severity || '').toLowerCase();
    if (raw === 'critical') { return 'critical'; }
    if (raw === 'major' || raw === 'high' || raw === 'error') { return 'major'; }
    if (raw === 'minor' || raw === 'medium' || raw === 'warning') { return 'minor'; }
    if (raw === 'nit' || raw === 'hint') { return 'nit'; }
    if (raw === 'low') { return category === 'style' ? 'nit' : 'minor'; }
    if (raw === 'info') { return 'info'; }
    return 'minor';
  }

  // Text-only badge: color + a CSS dot carry the severity, no emoji, no pill.
  function severityBadge(severity, category) {
    var d = displaySeverity(severity, category);
    return '<span class="vr-sev-badge vr-dsev-' + d + ' ' + escHtml(String(severity || 'medium')) + '">' +
      SEVERITY_META[d].label + '</span>';
  }

  function isImportantFinding(f) {
    var d = displaySeverity(f.severity, f.category);
    return d === 'critical' || d === 'major';
  }

  /** Focus: critical/major + applyable/agent. Balanced/Thorough: all unresolved. */
  function isFocusFinding(f) {
    if (isImportantFinding(f)) { return true; }
    var ac = f && f.actionClass;
    return ac === 'applyable' || ac === 'agent';
  }

  function renderVerbosityControl() {
    var modes = [
      { id: 'focus', label: 'Focus' },
      { id: 'balanced', label: 'Balanced' },
      { id: 'thorough', label: 'Thorough' },
    ];
    return '<div class="vr-verbosity" role="group" aria-label="Finding verbosity">' +
      '<span class="vr-verbosity-label">Depth</span>' +
      '<div class="vr-verbosity-modes">' +
      modes.map(function(m) {
        var active = actionNeededVerbosity === m.id ? ' active' : '';
        return '<button type="button" class="vr-verbosity-btn' + active + '" data-verbosity="' + m.id + '">' +
          escHtml(m.label) + '</button>';
      }).join('') +
      '</div></div>';
  }

  var VERDICT_META = {
    approve: { label: 'Approved', cls: 'ok', icon: '✓' },
    approve_with_suggestions: { label: 'Approved · suggestions', cls: 'ok', icon: '✓' },
    changes_requested: { label: 'Changes requested', cls: 'warn', icon: '!' },
    block: { label: 'Blocked', cls: 'bad', icon: '✕' },
  };

  function deriveOverallVerdict(r) {
    if (r.overallVerdict && VERDICT_META[r.overallVerdict]) { return r.overallVerdict; }
    var NEVER_BLOCK = { pm_alignment: 1, style: 1, vibe_code: 1, maintainability: 1, performance: 1 };
    function canHardBlock(f) {
      var cat = String((f && f.category) || '').toLowerCase();
      if (NEVER_BLOCK[cat]) { return false; }
      var sev = String((f && f.severity) || '').toLowerCase();
      var confidence = String((f && f.confidence) || 'medium').toLowerCase();
      if (confidence === 'low') { return false; }
      if (cat === 'security') {
        if (f.blocking === true) { return sev === 'critical' || sev === 'high' || sev === 'major'; }
        if (sev === 'critical') { return true; }
        if ((sev === 'high' || sev === 'major') && confidence === 'high') { return true; }
        return false;
      }
      if (cat === 'compliance') {
        if (sev === 'critical') { return true; }
        if ((sev === 'high' || sev === 'major') && confidence === 'high') { return true; }
        if (f.blocking === true && (sev === 'critical' || sev === 'high' || sev === 'major')) { return true; }
        return false;
      }
      if (cat === 'test_coverage' && f.blocking === true && sev === 'critical') { return true; }
      return false;
    }
    var findings = r.findings || [];
    if (findings.some(canHardBlock)) { return 'block'; }
    var worst = '';
    findings.forEach(function(f) {
      var cat = String(f.category || '').toLowerCase();
      var d = displaySeverity(f.severity, f.category);
      if (NEVER_BLOCK[cat] && d === 'critical') { d = 'major'; }
      if (d === 'critical') { worst = 'critical'; }
      else if (d === 'major' && worst !== 'critical') { worst = 'major'; }
      else if ((d === 'minor' || d === 'nit') && !worst) { worst = 'minor'; }
    });
    if (worst === 'critical') { return 'changes_requested'; }
    if (worst === 'major') { return 'changes_requested'; }
    if (worst) { return 'approve_with_suggestions'; }
    return 'approve';
  }

  function reviewSummaryStats(r) {
    const findings = Array.isArray(r.findings) ? r.findings : [];
    let urgent = 0;
    findings.forEach(function(f) {
      const d = displaySeverity(f.severity, f.category);
      if (d === 'critical' || d === 'major') { urgent += 1; }
    });
    const files = Array.isArray(r.visualDiff) ? r.visualDiff : [];
    let lines = 0;
    files.forEach(function(f) {
      lines += (Number(f.additions) || 0) + (Number(f.deletions) || 0);
    });
    if (!lines && typeof r.totalLinesChanged === 'number') { lines = r.totalLinesChanged; }
    return {
      score: normalizeReviewScore(r.score),
      findings: findings.length,
      urgent: urgent,
      files: files.length || Number(r.filesChanged) || 0,
      lines: lines,
      mode: String(r.actualModeUsed || r.mode || '').replace(/_/g, ' '),
    };
  }

  function renderScoreTicks(score) {
    const filled = Math.max(0, Math.min(10, Math.round(score / 10)));
    let html = '';
    for (let i = 0; i < 10; i++) {
      html += '<span class="vr-score-tick' + (i < filled ? ' on' : '') + '"></span>';
    }
    return html;
  }

  function reviewDepthLine(r) {
    const pipe = (r && (r.pipelineInfo || (r.modelInfo && r.modelInfo.pipelineInfo))) || {};
    const modeRaw = String(r.actualModeUsed || r.mode || pipe.mode || '').toLowerCase();
    const modeLabel = modeRaw === 'full' ? 'Full'
      : modeRaw === 'quick' ? 'Quick'
        : modeRaw === 'triage' ? 'Triage'
          : modeRaw ? modeRaw.replace(/_/g, ' ') : '';
    const pev = typeof pipe.runPevAgents === 'boolean'
      ? pipe.runPevAgents
      : modeRaw === 'full';
    const local = typeof pipe.runLocalQualityEngine === 'boolean'
      ? pipe.runLocalQualityEngine
      : true;
    const engines = pev && local ? 'PEV + local'
      : pev ? 'PEV'
        : local ? 'Local engines'
          : '';
    const packs = Number(pipe.packs || 0);
    const reviewed = Number(pipe.reviewedPacks || 0);
    const failed = Number(pipe.failedPacks || 0);
    const coverage = packs > 0
      ? (reviewed + '/' + packs + ' packs' + (failed > 0 || r.status === 'context_limited' ? ' · partial' : ''))
      : (r.status === 'context_limited' ? 'partial coverage' : '');
    const bits = [modeLabel ? modeLabel + ' review' : '', engines, coverage].filter(Boolean);
    return bits.length ? bits.join(' · ') : '';
  }

  function renderWalkthroughPanel(r) {
    var verdict = deriveOverallVerdict(r);
    var stats = reviewSummaryStats(r);
    var depthBit = reviewDepthLine(r);
    var securityClear = verdict !== 'block' && String(r.securityStatus || '').toLowerCase() !== 'blocked';
    var shipLabel = r.status === 'context_limited' || (r.actualModeUsed === 'triage')
      ? 'Incomplete'
      : verdict === 'block'
        ? 'Do not ship'
        : verdict === 'changes_requested'
          ? 'Changes requested'
          : verdict === 'approve_with_suggestions'
            ? 'Approve · suggestions'
            : 'Approve';
    var shipCls = (shipLabel === 'Approve' || shipLabel.indexOf('Approve') === 0) ? 'ok'
      : shipLabel === 'Incomplete' || shipLabel === 'Changes requested' ? 'warn' : 'bad';
    var html = '<div class="vr-summary-card">';
    html += '<div class="vr-summary-head">';
    html += '<span class="tag-outline ' + (securityClear ? 'good' : 'bad') + '" title="Hard-block security / compliance signals">' +
      (securityClear ? 'Security clear' : 'Security block') + '</span>';
    html += '<span class="tag-outline ' + (shipCls === 'ok' ? 'good' : shipCls === 'warn' ? 'warn' : 'bad') + '" title="Ship advice (not the same as security)">' +
      escHtml('Ship: ' + shipLabel) + '</span>';
    if (depthBit) {
      html += '<span class="vr-summary-depth' + (/partial/i.test(depthBit) ? ' partial' : '') + '" title="How deep this AXIOM review ran">' +
        escHtml(depthBit) + '</span>';
    }
    html += '</div>';
    html += '<div class="vr-summary-body">';
    html += '<div class="vr-summary-score">';
    html += '<div class="vr-summary-score-num"><b>' + stats.score + '</b><span>/100</span></div>';
    html += '<div class="vr-score-ticks" aria-hidden="true">' + renderScoreTicks(stats.score) + '</div>';
    html += '</div>';
    html += '<div class="vr-summary-divider" aria-hidden="true"></div>';
    html += '<div class="vr-summary-grid">';
    html += '<div><div class="k">Findings</div><div class="v">' + stats.findings + '</div></div>';
    html += '<div><div class="k">Urgent</div><div class="v' + (stats.urgent ? ' bad' : '') + '">' + stats.urgent + '</div></div>';
    html += '<div><div class="k">Files</div><div class="v">' + stats.files + '</div></div>';
    html += '<div><div class="k">Lines</div><div class="v">' + (stats.lines ? stats.lines.toLocaleString() : '0') + '</div></div>';
    html += '</div></div></div>';
    return html;
  }

  /** Slim first-viewport: score card + review notes. */
  function renderOverviewPanel(r) {
    return '<section class="vr-overview-card">' +
      renderWalkthroughPanel(r) +
      renderReviewWarnings(r) +
    '</section>';
  }

  /** Gauges / quality / compliance / meta — collapsed under Action Needed. */
  function renderOverviewDetails(r) {
    const overall = normalizeReviewScore(r.score);
    const security = reviewScoreValue(r, 'security');
    const compliance = reviewScoreValue(r, 'compliance');
    const body =
      '<div class="vr-overview-gauges">' +
        renderScoreGauge('Overall', overall, false) +
        renderScoreGauge('Security', security, false) +
        renderScoreGauge('Compliance', compliance, r.complianceStatus && r.complianceStatus !== 'not_enabled') +
      '</div>' +
      renderQualityScorecard(r) +
      renderComplianceOverviewStrip(r) +
      renderReviewMetaChips(r);
    return renderCollapsibleReviewSection('Scores & details', '', body, false, 'vr-overview-details');
  }

  function renderReviewWarnings(r) {
    const warnings = Array.isArray(r.reviewWarnings) ? r.reviewWarnings.slice() : [];
    const pipe = (r.pipelineInfo || (r.modelInfo && r.modelInfo.pipelineInfo) || {});
    const failedPacks = Number(pipe.failedPacks || 0);
    if (failedPacks > 0) {
      warnings.unshift({
        type: 'llm_review_incomplete',
        message: failedPacks + ' file pack(s) failed or timed out — coverage is incomplete',
      });
    }
    if (r.status === 'context_limited') {
      warnings.unshift({
        type: 'context_limited',
        message: 'Review coverage was incomplete (context limited)',
      });
    }
    const gStats = r.groundingStats || (r.modelInfo && r.modelInfo.groundingStats) || {};
    const dropped = Number(gStats.droppedUngroundedCount || 0);
    if (dropped > 0) {
      warnings.push({
        type: 'grounding_drops',
        message: dropped + ' finding(s) dropped (ungrounded paths)',
      });
    }
    if (r.actualModeUsed && r.requestedMode && r.actualModeUsed !== r.requestedMode) {
      warnings.push({
        type: 'mode_downgrade',
        message: 'Mode set to ' + String(r.actualModeUsed).replace(/_/g, ' ') + ' for this run',
      });
    }
    if (!warnings.length) { return ''; }
    const items = warnings.slice(0, 8).map(function(w) {
      const text = w.reason || w.message || w.type || '';
      const tone = /error|fail|invalid|block|incomplete|limited|dropped|grounding/i.test(String(w.type || '') + ' ' + String(text))
        ? 'bad'
        : 'warn';
      return '<div class="vr-note-item ' + tone + '">' + escHtml(String(text)) +
        (w.count ? ' (' + w.count + ' files)' : '') + '</div>';
    }).join('');
    return '<details class="vr-review-notes" open>' +
      '<summary>Review notes <span>(' + warnings.length + ')</span></summary>' +
      '<div class="vr-review-notes-body">' + items + '</div>' +
    '</details>';
  }

  function renderInsightsRow(r) {
    return '<div class="vr-insight-row">' +
      '<section class="vr-insight-card">' +
        '<div class="vr-insight-title">Languages</div>' +
        renderLanguagesPanel(r) +
      '</section>' +
      '<section class="vr-insight-card vr-contrib-card">' +
        '<div class="vr-insight-title">Contributors</div>' +
        '<div class="vr-insight-sub">Authorship of this change (git author / co-authors)</div>' +
        renderContributorsPanel(r) +
      '</section>' +
    '</div>';
  }

  function renderSectionsPanel(r, sectionScores) {
    const warnCount = (sectionScores || []).filter(function(s) { return s.status === 'bad' || s.status === 'warn'; }).length;
    const body = '<div class="vr-score-sections">' +
      (sectionScores || []).map(function(section) {
        return renderReviewScoreAccordion(r, section, false);
      }).join('') +
    '</div>';
    return renderCollapsibleReviewSection(
      'Sections',
      warnCount ? warnCount + ' need attention' : 'all clear',
      body,
      false,
      'vr-sections-collapsible'
    );
  }

  function renderValidateReviewDocument(r) {
    const findingCount = (r.findings || []).length;
    const changedCount = (r.visualDiff || []).length;
    const sectionScores = getReviewSectionScores(r);
    const viewMode = validateReview.viewMode || 'structured';
    const exportBar = '<div class="vr-export-bar">' +
      (viewMode === 'full'
        ? '<button type="button" class="vr-view-full-link" data-view="structured">← Overview</button>'
        : '<button type="button" class="vr-view-full-link" data-view="full">View full report →</button>') +
      '<button type="button" class="vr-export-pdf-btn" data-export-vr-pdf="1" title="Export report as PDF">Export PDF</button>' +
    '</div>';
    const toggleBar = '<div class="vr-view-toggle">' +
      '<button class="vr-view-toggle-btn' + (viewMode === 'structured' ? ' active' : '') + '" data-view="structured">Overview</button>' +
      '<button class="vr-view-toggle-btn' + (viewMode === 'full' ? ' active' : '') + '" data-view="full">Detail Report</button>' +
    '</div>';
    // Work list first: verdict → Action Needed → ornamental chrome collapsed.
    // Export / "View full report" stays at the bottom of the article.
    const topBlock = renderOverviewPanel(r) +
      renderActionNeededPanel(r) +
      renderSuppressedPanel(r) +
      renderOverviewDetails(r) +
      renderCollapsibleReviewSection('Languages & contributors', '', renderInsightsRow(r), false, 'vr-insights-collapsible');

    if (viewMode === 'full') {
      return '<article class="vr-structured-doc vr-doc-aligned">' + toggleBar + topBlock +
        renderDetailedReviewSections(r, sectionScores) +
        renderCollapsibleReviewSection('Architecture', flowSummaryText(r), renderArchitectureFlowSection(r), false, 'vr-architecture-collapsible') +
        (r.securityDataFlows && r.securityDataFlows.length
          ? renderCollapsibleReviewSection('Data flow', '', renderSecurityDataFlowSection(r), false, 'vr-security-flow-collapsible')
          : '') +
        renderCollapsibleReviewSection('Changed files', String(changedCount), renderVisualDiffSection(r), false, 'vr-diff-collapsible') +
        exportBar +
      '</article>';
    }

    return '<article class="vr-structured-doc vr-doc-aligned">' + toggleBar + topBlock +
      renderSectionsPanel(r, sectionScores) +
      renderCollapsibleReviewSection('Changed files', String(changedCount || findingCount), renderVisualDiffSection(r), false, 'vr-diff-collapsible') +
      renderCollapsibleReviewSection('Architecture', flowSummaryText(r), renderArchitectureFlowSection(r), false, 'vr-architecture-collapsible') +
      exportBar +
    '</article>';
  }

  function hasLinkedPmTaskForScope(r) {
    const issueSource = String((r && r.issueSource) || '').toLowerCase();
    if (issueSource === 'jira' || issueSource === 'linear') { return true; }
    if (r && (r.issueIdentifier || r.issueId)) { return true; }
    const taskSource = String((state && state.taskSource) || '').toLowerCase();
    if (taskSource === 'jira' || taskSource === 'linear' || taskSource.indexOf('jira:') === 0 || taskSource.indexOf('linear:') === 0) {
      return Boolean(String((state && state.taskId) || '').trim());
    }
    const ctx = state && state.pmTaskContext;
    if (ctx) {
      const ctxSource = String(ctx.source || ctx.issueSource || '').toLowerCase();
      if (ctxSource === 'jira' || ctxSource === 'linear') { return true; }
      if (ctx.issueIdentifier || ctx.issueId) { return true; }
    }
    return false;
  }

  function renderScopeAlignmentEmptyState() {
    return '<div class="vr-section-empty vr-scope-empty" role="note">Link a Jira/Linear task to check scope.</div>';
  }

  function renderAcValidationPanel(ac) {
    if (!ac || !Array.isArray(ac.criteria) || !ac.criteria.length) { return ''; }
    const pct = Math.round((ac.coverage_score || 0) * 100);
    const verdictCls = ac.verdict === 'all_ac_met' ? 'ok' : ac.verdict === 'partial_ac_met' ? 'warn' : 'bad';
    let html = '<div class="vr-ac-panel">';
    html += '<div class="vr-drift-row ' + verdictCls + '"><span>AC coverage</span><b>' + pct + '%</b></div>';
    html += '<div class="vr-drift-row"><span>Verdict</span><b>' + escHtml(String(ac.verdict || '').replace(/_/g, ' ')) + '</b></div>';
    html += '<ul class="vr-ac-list">';
    ac.criteria.forEach(function(c) {
      const cls = c.status === 'implemented' ? 'ok' : c.status === 'partial' ? 'warn' : 'bad';
      const ev = c.evidence && c.evidence.file && c.evidence.file !== '(none)'
        ? c.evidence.file.split('/').pop() + (c.evidence.lines && c.evidence.lines[0] ? ':' + c.evidence.lines[0] : '')
        : 'no evidence';
      html += '<li class="vr-ac-item ' + cls + '"><span>' + escHtml(c.id) + '</span> ' + escHtml(c.text.slice(0, 80))
        + ' <em>(' + escHtml(String(c.status || '').replace(/_/g, ' ')) + ' · ' + escHtml(ev) + ')</em></li>';
    });
    html += '</ul>';
    if (Array.isArray(ac.missing_criteria) && ac.missing_criteria.length) {
      html += '<div class="vr-drift-row bad"><span>Missing</span><b>' + escHtml(ac.missing_criteria.slice(0, 3).join('; ')) + '</b></div>';
    }
    if (Array.isArray(ac.extra_deliverables) && ac.extra_deliverables.length) {
      html += '<div class="vr-drift-row warn"><span>Extra</span><b>' + escHtml(ac.extra_deliverables.slice(0, 3).join(', ')) + '</b></div>';
    }
    html += '</div>';
    return html;
  }

  function renderDriftMatrix(matrix, explanation) {
    if (!matrix || typeof matrix !== 'object') { return ''; }
    const locked = Array.isArray(matrix.lockedDrift) ? matrix.lockedDrift
      : (Array.isArray(matrix.unmapped_additions) ? matrix.unmapped_additions : []);
    const overruled = Array.isArray(matrix.overruled) ? matrix.overruled : [];
    const reqs = Array.isArray(matrix.ticket_requirements) ? matrix.ticket_requirements : [];
    if (!reqs.length && !locked.length && !overruled.length && !explanation) { return ''; }
    let html = '<div class="vr-drift-matrix">';
    if (explanation && explanation.adjudication) {
      const rec = String(explanation.recommendation || '').replace(/_/g, ' ');
      const recCls = explanation.recommendation === 'merge_as_is' ? 'ok'
        : explanation.recommendation === 'request_split' ? 'bad' : 'warn';
      html += '<div class="vr-drift-row ' + recCls + '"><span>Recommendation</span><b>' + escHtml(rec) + '</b></div>';
      html += '<div class="vr-drift-verdict">' + escHtml(explanation.adjudication.final_verdict || '') + '</div>';
      html += '<div class="vr-drift-explain">' + escHtml(explanation.adjudication.explanation || '') + '</div>';
      if (explanation.agent_verdicts) {
        const se = explanation.agent_verdicts.staff_engineer;
        const pm = explanation.agent_verdicts.pm_ghost_cop;
        if (se) {
          html += '<details class="vr-drift-agent"><summary>Staff Engineer — ' + escHtml(String(se.verdict || '').replace(/_/g, ' ')) + '</summary>';
          html += '<p>' + escHtml(se.reasoning || '') + '</p>';
          if (Array.isArray(se.evidence) && se.evidence.length) {
            html += '<ul>' + se.evidence.slice(0, 4).map(function(e) { return '<li>' + escHtml(e) + '</li>'; }).join('') + '</ul>';
          }
          html += '</details>';
        }
        if (pm) {
          html += '<details class="vr-drift-agent"><summary>PM Ghost Cop — ' + escHtml(String(pm.verdict || '').replace(/_/g, ' ')) + '</summary>';
          html += '<p>' + escHtml(pm.reasoning || '') + '</p>';
          if (Array.isArray(pm.evidence) && pm.evidence.length) {
            html += '<ul>' + pm.evidence.slice(0, 4).map(function(e) { return '<li>' + escHtml(e) + '</li>'; }).join('') + '</ul>';
          }
          html += '</details>';
        }
        const winner = explanation.adjudication.winner === 'pm_ghost_cop' ? 'PM Ghost Cop' : 'Staff Engineer';
        html += '<div class="vr-drift-row ok"><span>Winner</span><b>' + escHtml(winner) + '</b></div>';
      }
    }
    html += '<div class="vr-drift-row"><span>Requirements</span><b>' + reqs.length + '</b></div>';
    if (locked.length) {
      html += '<div class="vr-drift-row bad"><span>Locked drift</span><b>' + escHtml(locked.join(', ')) + '</b></div>';
    }
    if (overruled.length) {
      html += '<div class="vr-drift-row ok"><span>A2A overruled</span><b>' + escHtml(overruled.join(', ')) + '</b></div>';
    }
    if (!locked.length && matrix.drift_detected === false) {
      html += '<div class="vr-drift-row ok"><span>Scope</span><b>Clean</b></div>';
    }
    html += '</div>';
    return html;
  }

  function renderAiSlopPanel(slop) {
    if (!slop || typeof slop !== 'object') { return ''; }
    const score = typeof slop.slop_score === 'number' ? slop.slop_score : 0;
    const verdict = String(slop.verdict || '').trim();
    const groups = [
      ['TODOs', slop.todos],
      ['Placeholders', slop.placeholders],
      ['Orphaned functions', slop.orphaned_functions],
      ['Empty catches', slop.empty_catches],
      ['Unresolved imports', slop.unresolved_imports],
      ['Console logs', slop.console_logs],
      ['Debugger', slop.debugger_statements],
      ['Generic errors', slop.generic_errors],
      ['Unvalidated params', slop.unvalidated_params],
      ['Async issues', slop.async_issues],
      ['Magic numbers', slop.magic_numbers],
      ['Duplicated code', slop.duplicated_code],
      ['Over-commented', slop.over_commented],
      ['Naming inconsistency', slop.inconsistent_naming],
    ];
    const hits = groups.filter(function(g) { return Array.isArray(g[1]) && g[1].length; });
    if (!score && !verdict && !hits.length) { return ''; }
    const scoreCls = score > 50 ? 'bad' : score > 25 ? 'warn' : 'ok';
    let html = '<div class="vr-ai-slop-panel">';
    html += '<div class="vr-drift-row ' + scoreCls + '"><span>Slop score</span><b>' + score + '/100</b></div>';
    if (verdict) {
      html += '<div class="vr-ai-slop-verdict">' + escHtml(verdict) + '</div>';
    }
    hits.slice(0, 8).forEach(function(g) {
      const label = g[0];
      const items = g[1];
      const sample = items.slice(0, 2).map(function(item) {
        const line = item.line ? ':' + item.line : '';
        const file = item.file ? item.file.split('/').pop() : '';
        const detail = item.text || item.message || item.code || item.function || item.param || item.value || item.type || '';
        const fix = item.fix ? ' — ' + item.fix : '';
        return escHtml((file + line + ' ' + String(detail).slice(0, 48)).trim() + fix);
      }).join('; ');
      html += '<div class="vr-drift-row"><span>' + escHtml(label) + ' (' + items.length + ')</span><b>' + sample + '</b></div>';
    });
    html += '</div>';
    return html;
  }

  function shouldOpenReviewSection(r, section) {
    if (!section) { return false; }
    if (section.id === 'scope_alignment') {
      if (!hasLinkedPmTaskForScope(r)) { return true; }
      return (r.pendingGoals || []).length > 0 || section.status === 'bad' || section.status === 'warn';
    }
    if (section.id === 'compliance') {
      return section.status === 'bad' || section.status === 'warn' || (r.complianceFindings || []).length > 0;
    }
    return section.status === 'bad' || section.status === 'warn';
  }

  // Single findings surface: critical/major expanded, everything else behind a
  // "Show N more suggestions" toggle. Verbosity Focus|Balanced|Thorough filters
  // without re-running review.
  /**
   * Findings hidden by a team learning or a prior dismissal.
   *
   * Deliberately always rendered when non-empty, collapsed by default. A
   * suppression the reviewer cannot inspect is indistinguishable from a bug,
   * so the count is never shown without a way to open it.
   */
  function renderSuppressedPanel(r) {
    const items = (r && r.suppressedFindings) || [];
    const staleItems = (r && r.staleLearnings) || [];
    if (!items.length && !staleItems.length) { return ''; }

    const MATCH_LABEL = {
      exact: 'exact title',
      scoped: 'scoped to path',
      rule: 'rule id',
      fuzzy: 'similar wording'
    };

    const rows = items.map(function(item, idx) {
      const loc = item.file
        ? escHtml(item.file) + (item.line ? ':' + item.line : '')
        : '';
      let why;
      if (item.source === 'learning') {
        // A personal entry must never be described as a team decision — it is
        // one person's preference from ~/.tyne and nobody agreed to it.
        const personal = item.learningOrigin === 'personal';
        const label = personal ? 'Your personal rule' : 'Team learning';
        const where = personal ? ' &middot; ~/.tyne/learnings.md' : (item.learningSource ? ' &middot; ' + escHtml(item.learningSource) : '');
        // git blame only means anything for the committed team file.
        const who = (!personal && item.author)
          ? ' &middot; added by ' + escHtml(item.author) + (item.addedOn ? ' on ' + escHtml(item.addedOn) : '')
          : '';
        const how = item.matchKind ? ' (' + escHtml(MATCH_LABEL[item.matchKind] || item.matchKind) + ')' : '';
        why = escHtml(label) + ': &ldquo;' + escHtml(item.learningTitle || '') + '&rdquo;' + how +
          (item.learningNote ? ' &mdash; ' + escHtml(item.learningNote) : '') + where + who;
      } else {
        why = 'You dismissed this finding previously.';
      }
      // Every hidden finding is undoable from here — the panel reports what
      // was suppressed AND lets the reviewer disagree with it.
      const undo = '<button class="vr-fa-btn vr-unsuppress" data-action="unsuppress"' +
        ' data-index="' + idx + '"' +
        ' title="' + (item.source === 'learning'
          ? 'Remove this learning from .tyne/learnings.md'
          : 'Stop hiding this finding for you') + '">Unsuppress</button>';

      return '<div class="vr-suppressed-row">' +
        '<div class="vr-suppressed-main">' +
          '<div class="vr-suppressed-title">' + escHtml(item.title || 'Finding') +
            (loc ? ' <span class="vr-suppressed-loc">' + loc + '</span>' : '') +
          '</div>' +
          undo +
        '</div>' +
        '<div class="vr-suppressed-why">' + why + '</div>' +
      '</div>';
    }).join('');

    // Housekeeping nudge, rendered inside the existing panel rather than as a
    // new surface — stale learnings are periodic maintenance, not per-review
    // noise, and this is already the place a reader thinks about suppressions.
    const stale = (r && r.staleLearnings) || [];
    const staleHtml = stale.length
      ? '<div class="vr-stale-block">' +
          '<div class="vr-stale-head">' + stale.length + ' ' +
            (stale.length === 1 ? 'learning has' : 'learnings have') +
            ' stopped doing anything' +
            ' <button class="vr-fa-btn vr-open-learnings" data-action="open_learnings" title="Open .tyne/learnings.md">Review file</button>' +
          '</div>' +
          stale.map(function(entry) {
            return '<div class="vr-stale-row">' +
              '<span class="vr-stale-kind">' + (entry.kind === 'suppression' ? 'suppression' : 'rule') +
                (entry.origin === 'personal' ? ' &middot; personal' : '') + '</span> ' +
              escHtml(entry.text || '') +
              (entry.scope ? ' <span class="vr-suppressed-loc">' + escHtml(entry.scope) + '</span>' : '') +
              '<div class="vr-suppressed-why">' + escHtml(entry.reason || '') + '</div>' +
            '</div>';
          }).join('') +
        '</div>'
      : '';

    const learningCount = items.filter(function(i) { return i.source === 'learning'; }).length;
    const subtitle = learningCount
      ? learningCount + ' hidden by team learnings' + (items.length > learningCount ? ', ' + (items.length - learningCount) + ' by your dismissals' : '')
      : items.length + ' hidden by your dismissals';

    return renderCollapsibleReviewSection(
      'Checked but not shown (' + items.length + ')',
      subtitle,
      staleHtml + '<div class="vr-suppressed-list">' + rows + '</div>',
      false,
      'vr-suppressed-collapsible'
    );
  }

  function renderActionNeededPanel(r) {
    const hasPm = hasLinkedPmTaskForScope(r);
    const pending = hasPm ? (r.pendingGoals || []).slice(0, 3) : [];
    const unresolved = (r.findings || [])
      .filter(function(f) { return !findingFeedbackByKey[findingFixKey(f.id || '')]; });
    const fixRank = function(f) {
      if (f.actionClass === 'applyable') { return 3; }
      if (f.actionClass === 'agent') { return 2; }
      if (f.suggestedFix) { return 1; }
      return 0;
    };
    const verbosity = actionNeededVerbosity === 'focus' || actionNeededVerbosity === 'thorough'
      ? actionNeededVerbosity
      : 'balanced';
    const pool = verbosity === 'focus'
      ? unresolved.filter(isFocusFinding)
      : unresolved;
    const topFindings = pool
      .filter(function(f) { return verbosity === 'focus' ? true : isImportantFinding(f); })
      .sort(function(a, b) { return fixRank(b) - fixRank(a); });
    const restFindings = verbosity === 'focus'
      ? []
      : pool
        .filter(function(f) { return !isImportantFinding(f); })
        .sort(function(a, b) { return fixRank(b) - fixRank(a); });
    const count = pending.length + topFindings.length;
    const verbosityBar = renderVerbosityControl();

    const moreBlock = restFindings.length
      ? '<details class="vr-more-findings"' + (verbosity === 'thorough' ? ' open' : '') + '>' +
          '<summary>Show ' + restFindings.length + ' more suggestion' + (restFindings.length === 1 ? '' : 's') + '</summary>' +
          renderActionFindingList(restFindings) +
        '</details>'
      : '';

    if (!count) {
      if (restFindings.length) {
        // Majors gone but minors remain — don't look "fully clean".
        return verbosityBar + renderActionToggle(
          'ok',
          'Suggestions',
          restFindings.length + ' open',
          true,
          renderBatchFixBar(restFindings) + renderActionFindingList(restFindings)
        );
      }
      const state = (!hasPm && !unresolved.length) ? 'empty' : 'ok';
      const subtitle = state === 'empty'
        ? 'No urgent items.'
        : (verbosity === 'focus' && unresolved.length
          ? 'No focus items · switch to Balanced for more'
          : 'No urgent follow-ups.');
      return verbosityBar + renderActionToggle(state, 'Suggestions', subtitle, false, '');
    }

    const openCount = count + restFindings.length;
    const subtitle = openCount + ' open';

    const batchItems = topFindings.concat(restFindings);
    return verbosityBar + renderActionToggle(
      'alert',
      'Suggestions',
      subtitle,
      true,
      renderBatchFixBar(batchItems) +
      renderPendingGoalList(pending, true) +
      renderActionFindingList(topFindings) +
      moreBlock
    );
  }

  function compactActionText(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const sentence = text.match(/^.*?[.!?](?:\s|$)/);
    const short = sentence ? sentence[0].trim() : text;
    return short.length > 100 ? short.slice(0, 97).trimEnd() + '…' : short;
  }

  /** Preview + expandable full text when compactActionText would truncate. */
  function renderCollapsibleDetail(value, summaryClass) {
    const full = String(value || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!full) { return ''; }
    const cls = summaryClass || 'vr-action-finding-summary';
    const flat = full.replace(/\s+/g, ' ').trim();
    const preview = compactActionText(flat);
    if (preview === flat) {
      return '<p class="' + cls + '">' + escHtml(full) + '</p>';
    }
    return '<details class="vr-detail-collapse">' +
      '<summary class="' + cls + '">' +
        '<span class="vr-detail-preview">' + escHtml(preview) + '</span>' +
        '<span class="vr-detail-toggle"><span class="vr-detail-more">More</span><span class="vr-detail-less">Less</span></span>' +
      '</summary>' +
      '<div class="vr-detail-full">' + escHtml(full) + '</div>' +
    '</details>';
  }

  function findingDetailText(f) {
    if (!f) { return ''; }
    const parts = [];
    if (f.explanation) { parts.push(String(f.explanation).trim()); }
    if (f.remediation) { parts.push('Recommendation: ' + String(f.remediation).trim()); }
    else if (f.architectureImpact) { parts.push(String(f.architectureImpact).trim()); }
    return parts.filter(Boolean).join('\n\n');
  }

  function renderActionFindingList(items) {
    if (!Array.isArray(items) || !items.length) { return ''; }
    return '<div class="vr-action-finding-list">' + items.map(function(f) {
      // Synthetic overflow rows from the nit throttle carry no code anchor and
      // nothing to act on — render them as a note, not an actionable card.
      if (String(f.id || '').indexOf('throttled-') === 0) {
        return '<div class="vr-finding-row vr-action-finding vr-throttle-note">' +
          '<span class="vr-throttle-text">' + escHtml(f.title || '') + '</span>' +
        '</div>';
      }
      const fixKey = findingFixKey(f.id || '');
      const appliedFix = !!appliedFindingFixes[fixKey];
      const discardedFix = !!discardedFindingFixes[fixKey];
      const sentFix = !!sentAgentFixes[fixKey];
      const actionClass = f.actionClass || 'guidance';
      const canApply = actionClass === 'applyable' && f.suggestedFix && !discardedFix;
      const id = escHtml(f.id || '');
      const fileBase = f.file ? String(f.file).split('/').pop() : '';
      const location = fileBase
        ? fileBase + (f.line ? ':' + f.line + (f.endLine && f.endLine > f.line ? '-' + f.endLine : '') : '')
        : '';
      const batchable = isBatchableFinding(f);
      const batchChecked = isBatchFindingSelected(f);
      const checkHtml = batchable
        ? '<label class="vr-batch-check-label" title="Include in batch fix">' +
            '<input type="checkbox" class="vr-batch-check" data-finding-id="' + id + '"' +
              (batchChecked ? ' checked' : '') + ' />' +
          '</label>'
        : '<span class="vr-batch-check-spacer" aria-hidden="true"></span>';
      const primary = appliedFix
        ? '<button class="vr-fa-btn undo-fix" data-action="undo_fix" data-finding-id="' + id + '">Undo</button>'
        : (canApply
          ? '<button class="vr-fa-btn apply-fix action-primary" data-action="apply_fix" data-finding-id="' + id + '">Fix</button>'
          : (sentFix
            ? '<button class="vr-fa-btn agent-fix action-primary sent" data-action="agent_fix" data-finding-id="' + id + '" disabled title="Prompt sent to your IDE agent">Sent ✓</button>'
            : '<button class="vr-fa-btn agent-fix action-primary" data-action="agent_fix" data-finding-id="' + id + '" title="Send a fix prompt to your IDE agent">Fix in IDE</button>'));
      const metaRow = (confidenceHedge(f) || location)
        ? '<div class="vr-action-finding-meta">' +
            confidenceHedge(f) +
            (location
              ? '<button type="button" class="vr-finding-loc" data-action="open_finding" data-finding-id="' + id + '">' + escHtml(location) + '</button>'
              : '') +
          '</div>'
        : '';
      // Overview Suggestions stay lean — no code/diff dumps (Detail Report still has them).
      return '<div class="vr-finding-row vr-action-finding vr-dsev-row-' + displaySeverity(f.severity, f.category) + (appliedFix ? ' fixed' : '') + '" data-finding-id="' + id + '" data-action-class="' + escHtml(actionClass) + '">' +
        '<div class="vr-action-finding-main">' +
          checkHtml +
          severityBadge(f.severity, f.category) +
          '<strong class="vr-finding-title">' + escHtml(f.title || 'Finding') + '</strong>' +
          (isSuggestionOnlyFinding(f) ? '<span class="vr-suggest-label" title="Soft category — not a merge blocker">suggestion</span>' : '') +
          houseRuleChip(f) +
          (appliedFix ? '<span class="vr-fixed-label">Fixed</span>' : '') +
        '</div>' +
        '<div class="vr-action-finding-body">' +
          metaRow +
          renderCollapsibleDetail(findingDetailText(f), 'vr-action-finding-summary') +
          '<div class="vr-finding-actions vr-action-buttons">' +
            primary +
            compareFixButton(f) +
            '<button class="vr-fa-btn" data-action="dismiss" data-finding-id="' + id + '" title="Suppresses this exact title' + (f.file ? ' in this file' : '') + ' only">Ignore</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  /**
   * Marks a finding that came from a team house rule rather than a detector.
   * These are the model judging natural-language conventions, so the chip is
   * the honest signal that this is a team preference, not proven evidence —
   * and the tooltip names the rule and its line so it can be edited.
   */
  function houseRuleChip(f) {
    const hr = f && f.houseRule;
    if (!hr) { return ''; }
    const where = hr.source ? ' · ' + hr.source : '';
    return '<span class="vr-houserule-label" title="' +
      escHtml('Team rule: ' + (hr.text || '') + where) +
      '">team rule</span>';
  }

  function isSuggestionOnlyFinding(f) {
    var NEVER_BLOCK = { pm_alignment: 1, style: 1, vibe_code: 1, maintainability: 1, performance: 1 };
    return Boolean(NEVER_BLOCK[String((f && f.category) || '').toLowerCase()]);
  }

  function renderActionToggle(state, title, subtitle, open, body) {
    return '<details class="vr-action-needed vr-action-card vr-action-' + state + '"' + (open ? ' open' : '') + '>' +
      '<summary>' +
        '<span class="vr-action-toggle-text">' +
          '<span class="vr-action-needed-title">' + escHtml(title) + '</span>' +
          '<span class="vr-action-sub">' + escHtml(subtitle) + '</span>' +
        '</span>' +
      '</summary>' +
      (body ? '<div class="vr-action-card-body">' + body + '</div>' : '') +
    '</details>';
  }

  function flowSummaryText(r) {
    const flow = flowFromReport(r);
    if (!flow || !flow.nodes || !flow.nodes.length) { return ''; }
    const ghosts = (flow.nodes || []).filter(function(n) { return n.note === 'outside diff'; }).length;
    return String((flow.nodes || []).length) + ' nodes' + (ghosts ? ' · ' + ghosts + ' outside' : '');
  }

  function renderCollapsibleReviewSection(title, summary, body, open, cls) {
    if (!body) { return ''; }
    const isSecurity = /security/i.test(cls || '');
    return '<details class="vr-collapsible-section ' + escHtml(cls || '') + (isSecurity ? ' vr-collapsible-section-security' : '') + '"' + (open ? ' open' : '') + '>' +
      '<summary>' +
        '<span class="vr-collapsible-title">' + escHtml(title) + '</span>' +
        '<span class="vr-collapsible-chevron" aria-hidden="true"></span>' +
        (summary ? '<small>' + escHtml(summary) + '</small>' : '') +
      '</summary>' +
      '<div class="vr-collapsible-body">' + body + '</div>' +
    '</details>';
  }

  function renderSecurityFindingsSection(r) {
    var dedicated = Array.isArray(r.securityFindings) ? r.securityFindings : [];
    var fromFindings = (r.findings || []).filter(function(f) { return f.category === 'security'; });
    if (!dedicated.length && !fromFindings.length) {
      return '<div class="vr-section-empty">No security findings detected.</div>';
    }

    // Prefer full finding records (with actions). Merge dedicated security rows that aren't already listed.
    var byId = {};
    fromFindings.forEach(function(f) { if (f && f.id) { byId[f.id] = f; } });
    dedicated.forEach(function(sf, index) {
      if (!sf) { return; }
      if (sf.id && byId[sf.id]) { return; }
      var dup = fromFindings.some(function(f) {
        return f.file === sf.file && f.title === sf.title;
      });
      if (dup) { return; }
      byId[sf.id || ('security_' + index)] = {
        id: sf.id || ('security_' + index),
        file: sf.file || '',
        line: sf.line,
        endLine: sf.endLine,
        severity: sf.severity || 'medium',
        category: 'security',
        title: sf.title || 'Security finding',
        explanation: [sf.impact, sf.evidence].filter(Boolean).join(' '),
        confidence: sf.confidence,
        architectureImpact: sf.remediation ? ('Remediation: ' + sf.remediation) : '',
        // Keep remediation as guidance text, not an autofix payload.
        suggestedFix: undefined,
        securityCategory: sf.category,
        detectedBy: sf.detectedBy,
        dataFlow: sf.dataFlow,
        impact: sf.impact,
        remediation: sf.remediation,
      };
    });

    var findings = Object.keys(byId).map(function(id) { return byId[id]; });
    if (!findings.length) {
      return '<div class="vr-section-empty">No security findings detected.</div>';
    }

    var detailRows = findings.slice(0, 4).map(function(f) {
      var sev = f.severity || 'medium';
      var sevIcon = sev === 'critical' ? '✕' : sev === 'high' ? '✕' : sev === 'medium' ? '⚠' : '○';
      var loc = f.file ? escHtml(f.file) + (f.line ? ':' + f.line : '') : 'changed code';
      var cat = f.securityCategory || f.category || 'security';
      var flowHtml = '';
      if (f.dataFlow && f.dataFlow.length) {
        flowHtml = '<div class="vr-security-finding-flow">' +
          f.dataFlow.map(function(step) {
            return '<span class="vr-flow-step">' + escHtml(step.description || '') + '</span>';
          }).join('<span class="vr-flow-arrow">→</span>') +
        '</div>';
      }
      return '<div class="vr-security-detail ' + escHtml(sev) + '">' +
        '<div class="vr-security-detail-head">' +
          '<div class="vr-security-detail-title-wrap">' +
            '<span class="vr-sev-badge ' + escHtml(sev) + '">' + sevIcon + ' ' + escHtml(sev) + '</span>' +
            '<span class="vr-security-detail-title">' + escHtml(f.title) + '</span>' +
          '</div>' +
          '<div class="vr-security-detail-meta">' +
            '<span class="vr-finding-cat">' + escHtml(cat) + '</span>' +
            (f.confidence ? '<span class="vr-finding-conf">' + escHtml(f.confidence) + '</span>' : '') +
            (f.detectedBy ? '<span class="vr-finding-src">' + escHtml(String(f.detectedBy).replace(/_/g, ' ')) + '</span>' : '') +
            '<span class="vr-finding-loc">' + loc + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="vr-security-detail-body">' +
          (f.impact ? '<p class="vr-finding-impact"><strong>Impact</strong> ' + escHtml(f.impact) + '</p>' : '') +
          (f.remediation ? '<p class="vr-finding-fix"><strong>Fix</strong> ' + escHtml(f.remediation) + '</p>' : '') +
          flowHtml +
        '</div>' +
      '</div>';
    }).join('');

    return '<div class="vr-security-findings-wrap">' +
      (detailRows ? '<div class="vr-security-detail-stack">' + detailRows + '</div>' : '') +
      renderFindingList(findings) +
    '</div>';
  }

  function renderSecurityDataFlowSection(r) {
    var flows = Array.isArray(r.securityDataFlows) ? r.securityDataFlows : [];
    if (!flows.length) { return ''; }
    var flowHtml = flows.slice(0, 3).map(function(flow) {
      var chain = [flow.source];
      if (Array.isArray(flow.transformations)) {
        chain = chain.concat(flow.transformations);
      }
      chain.push(flow.sink);
      var steps = chain.filter(Boolean).map(function(label) {
        return '<span class="vr-dflow-node">' + escHtml(label) + '</span>';
      }).join('<span class="vr-dflow-arrow">↓</span>');
      var files = (flow.files || []).map(function(f) {
        return '<span class="vr-dflow-file">' + escHtml(f.path) + (f.line ? ':' + f.line : '') + '</span>';
      }).join('');
      return '<div class="vr-dflow-chain">' +
        '<div class="vr-dflow-steps">' + steps + '</div>' +
        (files ? '<div class="vr-dflow-files">' + files + '</div>' : '') +
      '</div>';
    }).join('');
    return '<div class="vr-dflow-container">' + flowHtml + '</div>';
  }

  function renderCompliancePanel(r, compact) {
    var findings = Array.isArray(r.complianceFindings) ? r.complianceFindings
      : (r.findings || []).filter(function(f) { return f.category === 'compliance'; });
    var classifications = Array.isArray(r.dataClassifications) ? r.dataClassifications : [];
    var flows = Array.isArray(r.dataFlows) ? r.dataFlows : [];
    var controls = Array.isArray(r.controlsChecked) ? r.controlsChecked : [];
    var assessments = Array.isArray(r.complianceAssessments) ? r.complianceAssessments : [];
    var regressions = Array.isArray(r.complianceRegressions) ? r.complianceRegressions : [];
    var scope = r.complianceScope || {};
    var disclaimer = r.complianceDisclaimer ||
      'IMPORTANT LEGAL NOTICE: Tyne Validate & Review and any compliance-related output are automated, advisory suggestions only. They do not constitute a compliance certificate, attestation, audit opinion, legal advice, regulatory filing, warranty, or guarantee of any kind. Tyne does not certify that software, systems, processes, or organizations meet HIPAA, SOC 2, GDPR, PCI-DSS, ISO, NIST, FedRAMP, or any other legal, regulatory, industry, or contractual standard. Findings and scores are heuristic and may be incomplete, inaccurate, or out of date. Recipients remain solely responsible for independent professional review, formal certification by qualified auditors or counsel, and all compliance decisions. Use of this report does not create an attorney-client, auditor-client, or similar professional relationship with Tyne or its affiliates.';
    var disclaimerBody = String(disclaimer).replace(/^IMPORTANT LEGAL NOTICE:\s*/i, '');
    function complianceLabel(status) {
      var raw = String(status || '').toLowerCase().replace(/\s+/g, '_');
      if (raw === 'blocked' || raw === 'failed') return 'Blocked';
      if (raw === 'review_required' || raw === 'needs_work') return 'Review required';
      if (raw === 'issues_detected' || raw === 'warning') return 'Issues detected';
      if (raw === 'no_violations' || raw === 'passed' || raw === 'pass') return 'No detected violations';
      return 'Not enabled';
    }
    function controlLabel(status, passed) {
      var raw = String(status || (passed ? 'no_issues' : '')).toLowerCase();
      if (raw === 'issues_detected' || raw === 'failed') return 'Issues detected';
      if (raw === 'no_issues' || raw === 'passed') return 'No detected issues';
      return 'Not reviewed';
    }
    function coverageLabel(item) {
      if (!item || item.status === 'not_reviewed' || item.percent == null) return 'Not Reviewed';
      return Number(item.percent) + '%';
    }
    var html = '<div class="vr-compliance-wrap">';
    html += '<p class="vr-compliance-disclaimer" role="note"><strong>Important legal notice</strong> — ' +
      escHtml(disclaimerBody) + '</p>';
    if (!compact && r.privacyInfo) {
      var pi = r.privacyInfo;
      html += '<div class="vr-privacy-info" role="region" aria-label="Privacy Information">' +
        '<div class="vr-mini-label">Privacy Information</div>' +
        '<ul class="vr-mini-list">' +
          '<li><strong>Review Mode:</strong> ' + escHtml(pi.reviewMode || 'cloud') + '</li>' +
          '<li><strong>Code Processing:</strong> ' + escHtml(pi.codeProcessing || 'cloud') + '</li>' +
          '<li><strong>Evidence Storage:</strong> ' + escHtml(pi.evidenceStorage || 'enabled') + '</li>' +
          '<li><strong>Data Sent:</strong> ' + escHtml(pi.dataSent || 'Full review payload') + '</li>' +
          (pi.dataResidency ? '<li><strong>Data Residency:</strong> ' + escHtml(pi.dataResidency) + '</li>' : '') +
          (pi.llmExecutionPath ? '<li><strong>LLM Path:</strong> ' + escHtml(pi.llmExecutionPath) + '</li>' : '') +
        '</ul></div>';
    }
    if (!compact) {
    html += '<div class="vr-compliance-export btn-row">' +
      '<button type="button" class="btn btn-sm" data-compliance-export="markdown">Export Markdown</button>' +
      '<button type="button" class="btn btn-sm" data-compliance-export="json">Export JSON</button>' +
      '<button type="button" class="btn btn-sm" data-compliance-export="pdf">Export PDF</button>' +
      '</div>';
    }
    if (regressions.length) {
      html += '<div class="vr-compliance-regression" role="alert">' +
        regressions.map(function(reg) {
          return '<div><strong>Compliance Regression Detected</strong> — ' +
            escHtml(reg.message || ((reg.framework || '') + ': ' + (reg.newFindings || []).length + ' new findings')) +
            '</div>';
        }).join('') +
      '</div>';
    }
    if (assessments.length) {
      html += '<div class="vr-compliance-scorecard">' + assessments.map(function(a) {
        var coverage = Array.isArray(a.coverage) ? a.coverage : [];
        var coverageHtml = coverage.length
          ? '<div class="vr-compliance-coverage">' + coverage.map(function(c) {
              return '<div class="vr-compliance-cov-row"><span>' + escHtml(c.label || c.id) + ':</span> ' +
                '<b class="' + (c.status === 'not_reviewed' ? 'vr-metric-not_enabled' : '') + '">' +
                escHtml(coverageLabel(c)) + '</b></div>';
            }).join('') + '</div>'
          : '';
        return '<div class="vr-compliance-row">' +
          '<div class="vr-compliance-framework">' + escHtml((a.name || a.framework) + ' Assessment') + '</div>' +
          '<div class="vr-compliance-status-line"><span class="vr-compliance-k">Status:</span> ' +
          '<b class="vr-metric-' + escHtml(a.status || 'no_violations') + '">' + escHtml(complianceLabel(a.status)) + '</b></div>' +
          coverageHtml +
          '<div class="vr-compliance-scope-line"><span class="vr-compliance-k">Scope:</span> ' +
          escHtml(a.scopeNote || 'Reviewed code changes only') + '</div></div>';
      }).join('') + '</div>';
    }

    if (controls.length) {
      html += '<div class="vr-mini-block"><div class="vr-mini-label">Controls checked</div><ul class="vr-mini-list">' +
        controls.slice(0, compact ? 4 : 8).map(function(c) {
          var controlStatus = c.status || (c.passed ? 'no_issues' : 'issues_detected');
          return '<li class="' + (controlStatus === 'no_issues' || controlStatus === 'passed' ? 'pass' : controlStatus === 'issues_detected' || controlStatus === 'failed' ? 'fail' : '') + '"><strong>' +
            escHtml((c.framework ? c.framework + ' · ' : '') + (c.id || '')) + '</strong> ' +
            escHtml(c.label || '') + ' — ' + escHtml(controlLabel(controlStatus, c.passed)) + '</li>';
        }).join('') +
      '</ul></div>';
    }

    if (classifications.length) {
      html += '<div class="vr-mini-block"><div class="vr-mini-label">Data classification</div><ul class="vr-mini-list">' +
        classifications.slice(0, compact ? 3 : 6).map(function(c) {
          return '<li><strong>' + escHtml(c.type || 'Sensitive') + '</strong> ' +
            escHtml((c.source || '') + ' → ' + (c.destination || '')) +
            (c.file ? ' <span class="vr-finding-loc">' + escHtml(c.file) + (c.line ? ':' + c.line : '') + '</span>' : '') +
            '</li>';
        }).join('') +
      '</ul></div>';
    }

    if (flows.length) {
      html += '<div class="vr-mini-block"><div class="vr-mini-label">Sensitive data flow</div>' +
        flows.slice(0, compact ? 2 : 4).map(function(flow) {
          var chain = [flow.source].concat(Array.isArray(flow.transformations) ? flow.transformations : []).concat([flow.sink]).filter(Boolean);
          var issues = Array.isArray(flow.issues) ? flow.issues.filter(Boolean) : [];
          return '<div class="vr-dflow-chain">' +
            '<div class="vr-dflow-steps">' + chain.map(function(label) {
              return '<span class="vr-dflow-node">' + escHtml(label) + '</span>';
            }).join('<span class="vr-dflow-arrow">↓</span>') + '</div>' +
            (issues.length ? '<ul class="vr-mini-list fail">' + issues.map(function(i) { return '<li>' + escHtml(i) + '</li>'; }).join('') + '</ul>' : '') +
          '</div>';
        }).join('') +
      '</div>';
    }

    if (findings.length) {
      html += '<div class="vr-security-detail-stack">' +
        findings.slice(0, compact ? 3 : 6).map(function(f) {
          var sev = f.severity || 'medium';
          var sevIcon = sev === 'critical' || sev === 'high' ? '✕' : sev === 'medium' ? '⚠' : '○';
          var loc = f.file ? escHtml(f.file) + (f.line ? ':' + f.line : '') : ((f.affectedFiles && f.affectedFiles[0]) || 'changed code');
          var evidenceText = (f.evidenceRecord && f.evidenceRecord.snippet)
            || (f.evidence && typeof f.evidence === 'object' ? f.evidence.snippet : f.evidence)
            || f.impact
            || '';
          var controlMeta = [f.framework, f.frameworkVersion, f.controlId || f.control, f.ruleId].filter(Boolean).join(' · ');
          var wf = (r.complianceFindingWorkflows && r.complianceFindingWorkflows[f.id]) || f.workflow || {};
          var wfStatus = wf.status || 'open';
          return '<div class="vr-security-detail ' + escHtml(sev) + '" data-compliance-finding-id="' + escHtml(f.id || '') + '">' +
            '<div class="vr-security-detail-head">' +
              '<div class="vr-security-detail-title-wrap">' +
                '<span class="vr-sev-badge ' + escHtml(sev) + '">' + sevIcon + ' ' + escHtml(sev) + '</span>' +
                '<span class="vr-security-detail-title">' + escHtml(f.title) + '</span>' +
              '</div>' +
              '<div class="vr-security-detail-meta">' +
                '<span class="vr-finding-cat">' + escHtml(controlMeta || 'Compliance') + '</span>' +
                '<span class="vr-finding-loc">' + loc + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="vr-security-detail-body">' +
              (evidenceText ? '<p class="vr-finding-impact"><strong>Evidence</strong> ' + escHtml(evidenceText) + '</p>' : '') +
              (f.remediation ? '<p class="vr-finding-fix"><strong>Fix</strong> ' + escHtml(f.remediation) + '</p>' : '') +
              (!compact ? '<div class="vr-finding-workflow">' +
                '<label>Status <select data-wf-field="status">' +
                  ['open','assigned','in_progress','accepted_risk','resolved','rejected'].map(function(s) {
                    var labels = { open:'Open', assigned:'Assigned', in_progress:'In Progress', accepted_risk:'Accepted Risk', resolved:'Resolved', rejected:'Rejected' };
                    return '<option value="' + s + '"' + (wfStatus === s ? ' selected' : '') + '>' + labels[s] + '</option>';
                  }).join('') +
                '</select></label>' +
                '<label>Owner <input type="text" data-wf-field="owner" value="' + escHtml(wf.owner || '') + '" placeholder="owner@" /></label>' +
                '<label>Resolution <input type="text" data-wf-field="resolution" value="' + escHtml(wf.resolution || '') + '" placeholder="notes" /></label>' +
                '<button type="button" class="btn btn-sm" data-wf-save="1">Save</button>' +
              '</div>' : '') +
            '</div>' +
          '</div>';
        }).join('') +
      '</div>';
    }

    if (!findings.length && !classifications.length && !flows.length) {
      html += '<div class="vr-section-empty">No detected violations in reviewed code changes.</div>';
    }

    if ((scope.reviewed || []).length || (scope.notReviewed || []).length) {
      html += '<div class="vr-mini-block"><div class="vr-mini-label">Assessment scope</div>' +
        ((scope.reviewed || []).length ? '<p><strong>Reviewed:</strong> ' + escHtml(scope.reviewed.join(', ')) + '</p>' : '') +
        ((scope.notReviewed || []).length ? '<p><strong>Not reviewed:</strong> ' + escHtml(scope.notReviewed.join(', ')) + '</p>' : '') +
        '</div>';
    }

    html += '</div>';
    return html;
  }

  function renderVisualDiffSection(r) {
    const diffs = Array.isArray(r.visualDiff) ? r.visualDiff : [];
    if (!diffs.length) { return ''; }
    const findings = r.findings || [];
    const findingsByFile = {};
    findings.forEach(function(f) {
      if (!f.file) { return; }
      if (!findingsByFile[f.file]) { findingsByFile[f.file] = []; }
      findingsByFile[f.file].push(f);
    });
    const fileRows = diffs.map(function(d) {
      const fileFindings = findingsByFile[d.file] || [];
      const statusIcon = d.status === 'added' ? '+' : d.status === 'deleted' ? '-' : d.status === 'renamed' ? '~' : 'M';

      // Clean files collapse to a single "clean ✓" line — nothing to expand.
      if (!fileFindings.length) {
        return '<div class="vr-diff-file vr-diff-file-clean">' +
          '<span class="vr-diff-status ' + escHtml(d.status || 'modified') + '">' + statusIcon + '</span>' +
          '<code class="vr-diff-filepath">' + escHtml(d.file || '') + '</code>' +
          '<span class="vr-diff-stats">+' + (d.additions || 0) + ' -' + (d.deletions || 0) + '</span>' +
          '<span class="vr-diff-clean-mark">clean ✓</span>' +
        '</div>';
      }

      const counts = { critical: 0, major: 0, minor: 0, nit: 0, info: 0 };
      fileFindings.forEach(function(f) { counts[displaySeverity(f.severity, f.category)]++; });
      const countLabel = [
        counts.critical ? counts.critical + ' critical' : '',
        counts.major ? counts.major + ' major' : '',
        (counts.minor + counts.nit + counts.info) ? (counts.minor + counts.nit + counts.info) + ' minor' : '',
      ].filter(Boolean).join(', ');

      const findingPins = '<div class="vr-diff-findings">' + fileFindings.map(function(f) {
        const dsev = displaySeverity(f.severity, f.category);
        return '<div class="vr-diff-finding-pin ' + escHtml(f.severity || 'medium') + '" data-finding-id="' + escHtml(f.id || '') + '">' +
          '<span class="vr-sev-chip vr-dsev-' + dsev + ' ' + escHtml(f.severity || 'medium') + '">' + SEVERITY_META[dsev].label.toLowerCase() + '</span>' +
          (f.line ? '<span class="vr-diff-finding-loc">L' + f.line + (f.endLine && f.endLine > f.line ? '-' + f.endLine : '') + '</span>' : '') +
          '<span class="vr-diff-finding-title">' + escHtml(f.title || '') + '</span>' +
        '</div>';
      }).join('') + '</div>';

      return '<details class="vr-diff-file"' + (counts.critical || counts.major ? ' open' : '') + '>' +
        '<summary>' +
          '<span class="vr-diff-status ' + escHtml(d.status || 'modified') + '">' + statusIcon + '</span>' +
          '<code class="vr-diff-filepath">' + escHtml(d.file || '') + '</code>' +
          '<span class="vr-diff-stats">+' + (d.additions || 0) + ' -' + (d.deletions || 0) + '</span>' +
          '<span class="vr-diff-finding-count">' + escHtml(countLabel) + '</span>' +
        '</summary>' +
        '<div class="vr-diff-file-body">' +
          findingPins +
        '</div>' +
      '</details>';
    }).join('');
    return '<section class="vr-visual-diff-section" aria-label="Changed files">' +
      '<div class="vr-diff-file-list">' + fileRows + '</div>' +
    '</section>';
  }

  function normalizeReviewScore(value) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) { return 0; }
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function reviewStatusMeta(status, overallVerdict) {
    var verdict = String(overallVerdict || '').toLowerCase();
    if (verdict === 'block') { return { label: 'Blocked', scoreClass: 'fail' }; }
    if (verdict === 'changes_requested') { return { label: 'Needs Work', scoreClass: 'partial' }; }
    if (verdict === 'approve_with_suggestions') { return { label: 'Approved · Suggestions', scoreClass: 'pass' }; }
    if (verdict === 'approve') { return { label: 'Approved', scoreClass: 'pass' }; }
    switch (status) {
      case 'passed': return { label: 'No hard-block signals', scoreClass: 'pass' };
      case 'blocked': return { label: 'Blocked', scoreClass: 'fail' };
      case 'context_limited': return { label: 'Context Limited', scoreClass: 'partial' };
      case 'needs_work':
      default: return { label: 'Needs Work', scoreClass: 'partial' };
    }
  }

  const REVIEW_SECTION_DEFS = [
    { id: 'scope_alignment', title: 'Scope', categories: ['pm_alignment'] },
    { id: 'correctness', title: 'Correctness', categories: ['correctness', 'breaking_change'] },
    { id: 'tests', title: 'Tests', categories: ['test_coverage'] },
    { id: 'security', title: 'Security', categories: ['security'] },
    { id: 'compliance', title: 'Compliance', categories: ['compliance'] },
    { id: 'maintainability', title: 'Maintainability', categories: ['maintainability', 'performance', 'style'] },
    { id: 'vibe_code', title: 'Vibe-code risk', categories: ['vibe_code'] },
  ];

  function reviewSectionFallbackScore(id, r) {
    const card = r.qualityScorecard || {};
    if (id === 'vibe_code' && typeof card.vibe === 'number') { return normalizeReviewScore(card.vibe); }
    if (id === 'maintainability' && typeof card.maintainability === 'number') { return normalizeReviewScore(card.maintainability); }
    if (id === 'correctness' && typeof card.correctness === 'number') { return normalizeReviewScore(card.correctness); }
    const findings = Array.isArray(r.findings) ? r.findings : [];
    const byCat = function(categories) { return findings.filter(function(f) { return categories.includes(f.category); }).length; };
    const severe = findings.filter(function(f) { return f.severity === 'critical' || f.severity === 'high'; }).length;
    if (id === 'scope_alignment') { return normalizeReviewScore((r.score || 80) - ((r.pendingGoals || []).length * 10)); }
    if (id === 'correctness') { return normalizeReviewScore(100 - byCat(['correctness', 'breaking_change']) * 18 - severe * 8); }
    if (id === 'tests') { return normalizeReviewScore(100 - (r.missingTests || []).length * 18 - byCat(['test_coverage']) * 14); }
    if (id === 'security') { return r.riskLevel === 'high' ? 58 : r.riskLevel === 'medium' ? 76 : 94; }
    if (id === 'compliance') {
      const cf = Array.isArray(r.complianceFindings) ? r.complianceFindings : findings.filter(function(f) { return f.category === 'compliance'; });
      if (r.complianceStatus === 'blocked' || cf.some(function(f) {
        return f.confidence !== 'low' && (f.severity === 'critical' || (f.severity === 'high' && f.confidence === 'high'));
      })) { return 42; }
      if (r.complianceStatus === 'review_required' || r.complianceStatus === 'needs_work' || cf.some(function(f) { return f.severity === 'high' || f.severity === 'medium'; })) { return 58; }
      if (r.complianceStatus === 'issues_detected' || r.complianceStatus === 'warning' || cf.length) { return 76; }
      return 96;
    }
    if (id === 'maintainability') { return normalizeReviewScore(100 - byCat(['maintainability', 'performance', 'style']) * 12); }
    if (id === 'vibe_code') { return r.vibeCodeRisk === 'high' ? 55 : r.vibeCodeRisk === 'medium' ? 74 : 94; }
    return normalizeReviewScore(r.score || 80);
  }

  function reviewSectionStatus(score) {
    if (score >= 85) { return 'good'; }
    if (score >= 70) { return 'warn'; }
    return 'bad';
  }

  function getReviewSectionScores(r) {
    const incoming = Array.isArray(r.sectionScores) ? r.sectionScores : [];
    const card = r.qualityScorecard || {};
    return REVIEW_SECTION_DEFS.map(function(def) {
      const found = incoming.find(function(item) { return item && item.id === def.id; });
      // Local quality scorecard wins for overlapping dims (never show vibe 10 with gauge 100).
      let scoreSource = found && found.score !== undefined ? found.score : reviewSectionFallbackScore(def.id, r);
      if (def.id === 'vibe_code' && typeof card.vibe === 'number') { scoreSource = card.vibe; }
      if (def.id === 'maintainability' && typeof card.maintainability === 'number') { scoreSource = card.maintainability; }
      if (def.id === 'correctness' && typeof card.correctness === 'number') { scoreSource = card.correctness; }
      const score = normalizeReviewScore(scoreSource);
      const related = (r.findings || []).filter(function(f) { return def.categories.includes(f.category); }).map(function(f) { return f.id; });
      const linked = (found && Array.isArray(found.findingIds)) ? found.findingIds.filter(Boolean) : [];
      // Prefer IDs that still exist; otherwise category findings (fixes empty "Clear" with low score).
      const existingIds = new Set((r.findings || []).map(function(f) { return f.id; }));
      const validLinked = linked.filter(function(id) { return existingIds.has(id); });
      return {
        id: def.id,
        title: (found && found.title) || def.title,
        score: score,
        status: reviewSectionStatus(score),
        summary: (found && found.summary) || (related.length ? related.length + ' finding' + (related.length === 1 ? '' : 's') : ''),
        findingIds: validLinked.length ? validLinked : related,
      };
    });
  }

  function renderDetailedReviewSections(r, sectionScores) {
    const byId = {};
    (sectionScores || []).forEach(function(section) { byId[section.id] = section; });
    const groups = [
      { title: 'Scope', summary: '', sections: ['scope_alignment'] },
      { title: 'Code', summary: '', sections: ['correctness', 'maintainability', 'vibe_code'] },
      { title: 'Security', summary: '', sections: ['security'] },
      { title: 'Compliance', summary: '', sections: ['compliance'] },
      { title: 'Tests', summary: '', sections: ['tests'] },
    ];
    return '<section class="vr-detail-review-sections" aria-label="Detailed review sections">' +
      groups.map(function(group) {
        const sections = group.sections
          .map(function(id) { return byId[id]; })
          .filter(Boolean);
        if (!sections.length) { return ''; }
        // Every top-level row uses the same score-accordion chrome (chevron · dot · meter · score).
        if (sections.length === 1) {
          const only = Object.assign({}, sections[0], { title: group.title });
          return renderReviewScoreAccordion(r, only, shouldOpenReviewSection(r, only));
        }
        const score = Math.round(sections.reduce(function(sum, s) {
          return sum + normalizeReviewScore(s.score);
        }, 0) / sections.length);
        const status = reviewSectionStatus(score);
        const open = sections.some(function(s) { return shouldOpenReviewSection(r, s); });
        const body = sections.map(function(section) {
          return renderReviewSectionDetails(r, section);
        }).filter(Boolean).join('');
        return renderScoreAccordionShell(group.title, score, status, open, body || '<div class="vr-section-empty">Clear.</div>');
      }).join('') +
    '</section>';
  }

  function renderScoreAccordionShell(title, score, status, open, body) {
    const st = escHtml(status || 'neutral');
    const pct = normalizeReviewScore(score);
    return '<details class="vr-score-accordion ' + st + '"' + (open ? ' open' : '') + '>' +
      '<summary>' +
        '<span class="vr-score-chevron" aria-hidden="true"></span>' +
        '<span class="vr-score-title"><span class="vr-score-dot ' + st + '" aria-hidden="true"></span>' + escHtml(title) + '</span>' +
        '<span class="vr-score-meter" aria-hidden="true"><i style="width:' + pct + '%"></i></span>' +
        '<span class="vr-score-pill">' + pct + '</span>' +
      '</summary>' +
      '<div class="vr-score-body">' + (body || '') + '</div>' +
    '</details>';
  }

  function renderReviewScoreAccordion(r, section, open) {
    return renderScoreAccordionShell(
      section.title,
      section.score,
      section.status || 'neutral',
      open,
      renderReviewSectionDetails(r, section)
    );
  }

  function renderReviewSectionDetails(r, section) {
    const def = REVIEW_SECTION_DEFS.find(function(d) { return d.id === section.id; });
    const ids = Array.isArray(section.findingIds) ? section.findingIds : [];
    let findings = (r.findings || []).filter(function(f) { return ids.includes(f.id); });
    if (!findings.length && def) {
      findings = (r.findings || []).filter(function(f) { return def.categories.includes(f.category); });
    }
    let html = '';
    if (section.id === 'scope_alignment') {
      if (!hasLinkedPmTaskForScope(r)) {
        html += renderScopeAlignmentEmptyState();
      } else {
        html += renderAcValidationPanel(r.acValidation);
        html += renderDriftMatrix(r.driftMatrix, r.scopeDriftExplanation);
        html += renderMiniList('Completed', (r.completedGoals || []).map(function(goal) { return typeof goal === 'string' ? goal : goal.title; }), 'ok');
        // Overview already lists pending gaps under Action needed; keep accordion lean.
        if ((r.pendingGoals || []).length && validateReview.viewMode !== 'full') {
          html += '<div class="vr-section-empty">See Action Needed above.</div>';
        } else {
          html += renderPendingGoalList(r.pendingGoals || []);
        }
      }
    }
    if (section.id === 'tests') {
      html += renderMissingTestList(r.missingTests || []);
    }
    if (section.id === 'compliance') {
      html += renderCompliancePanel(r, true);
    } else {
      if (section.id === 'vibe_code') {
        html += renderAiSlopPanel(r.aiSlop);
      }
      html += renderFindingList(findings);
    }
    if (!findings.length) {
      if (section.id === 'vibe_code') {
        html += section.score < 85
          ? '<div class="vr-section-empty">Vibe score is based on the quality engine; no linked findings left in this report slice.</div>'
          : '<div class="vr-section-empty">No vibe-code risk.</div>';
      } else if (section.id === 'compliance' && !(r.complianceFindings || []).length && !(r.dataClassifications || []).length) {
        html += '<div class="vr-section-empty">No detected violations in reviewed code changes.</div>';
      } else if (section.score < 70 && section.id !== 'scope_alignment' && section.id !== 'tests') {
        html += '<div class="vr-section-empty">Score indicates issues, but no linked findings in this report.</div>';
      }
    }
    if (!html) {
      html = '<div class="vr-section-empty">Clear.</div>';
    }
    if (section.id === 'correctness' || section.id === 'maintainability') {
      html += renderNextActionList(r.nextActions || []);
    }
    return html;
  }

  function renderMiniList(label, items, cls) {
    const clean = (items || []).filter(Boolean).slice(0, 4);
    if (!clean.length) { return ''; }
    return '<div class="vr-mini-block"><div class="vr-mini-label">' + escHtml(label) + '</div><ul class="vr-mini-list ' + (cls || '') + '">' +
      clean.map(function(item) { return '<li>' + escHtml(item) + '</li>'; }).join('') +
    '</ul></div>';
  }

  function renderPendingGoalList(items, compact) {
    if (!Array.isArray(items) || !items.length) { return ''; }
    return '<div class="vr-mini-block' + (compact ? ' compact' : '') + '"><div class="vr-mini-label">Pending</div><div class="vr-pending-stack">' +
      items.slice(0, 4).map(function(item, index) {
        const goalId = item.id || ('pending_goal_' + index);
        const feedbackKey = findingFixKey(goalId);
        const prior = pendingGoalFeedbackByKey[feedbackKey];
        const files = Array.isArray(item.relatedFiles) ? item.relatedFiles.filter(Boolean) : [];
        const fileHint = files.length ? files[0] : '';
        const actionsHtml = prior
          ? '<div class="vr-pending-actions"><span class="vr-feedback-confirmed">' + escHtml(feedbackLabel(prior)) + '</span></div>'
          : compact
            ? ''
            : '<div class="vr-pending-actions">' +
                '<button class="vr-fa-btn fix-goal" data-action="fix_goal" data-goal-id="' + escHtml(goalId) + '" data-goal-index="' + index + '" data-file="' + escHtml(fileHint) + '" title="Open related file or copy the suggested action">I\'ll fix this</button>' +
                '<button class="vr-fa-btn out-of-scope" data-action="out_of_scope" data-goal-id="' + escHtml(goalId) + '" data-goal-index="' + index + '" title="Mark this gap as intentionally out of scope">Out of scope</button>' +
              '</div>';
        return '<div class="vr-pending-row' + (prior ? ' resolved' : '') + '" data-goal-id="' + escHtml(goalId) + '">' +
          '<div class="vr-pending-head">' +
            (item.priority ? '<span class="vr-sev-chip ' + escHtml(item.priority === 'high' ? 'high' : (item.priority === 'low' ? 'low' : 'medium')) + '">' + escHtml(item.priority) + '</span>' : '') +
            '<strong>' + escHtml(item.title || 'Pending goal') + '</strong>' +
          '</div>' +
          (compact
            ? renderCollapsibleDetail(item.suggestedAction || item.reason, 'vr-action-finding-summary')
            : (item.reason ? '<p>' + escHtml(item.reason) + '</p>' : '') +
              (item.suggestedAction ? '<p class="vr-pending-action"><b>Suggested:</b> ' + escHtml(item.suggestedAction) + '</p>' : '')) +
          (files.length ? '<code class="vr-pending-files">' + escHtml(files.slice(0, 3).join(' · ')) + '</code>' : '') +
          actionsHtml +
        '</div>';
      }).join('') +
    '</div></div>';
  }

  function renderMissingTestList(items) {
    if (!Array.isArray(items) || !items.length) { return ''; }
    return '<div class="vr-mini-block"><div class="vr-mini-label">Missing tests</div><ul class="vr-mini-list warn">' +
      items.slice(0, 4).map(function(item) {
        const meta = [item.testType, item.relatedFile].filter(Boolean).join(' · ');
        return '<li><strong>' + escHtml(item.title || 'Missing test') + '</strong>' + (meta ? '<span>' + escHtml(meta) + '</span>' : '') + '</li>';
      }).join('') +
    '</ul></div>';
  }

  function selectedValidateReviewReportId() {
    const report = getSelectedValidateReviewReport();
    return (report && report.id) || validateReview.selectedReportId || 'current';
  }

  function findingFixKey(findingId, reportId) {
    return String(reportId || selectedValidateReviewReportId()) + ':' + String(findingId || '');
  }

  function persistReviewUiState() {
    if (typeof vscode.setState === 'function') {
      persistedWebviewState.discardedFindingFixes = discardedFindingFixes;
      persistedWebviewState.findingFeedbackByKey = findingFeedbackByKey;
      persistedWebviewState.pendingGoalFeedbackByKey = pendingGoalFeedbackByKey;
      persistedWebviewState.sentAgentFixes = sentAgentFixes;
      persistedWebviewState.batchFindingSelection = batchFindingSelection;
      persistedWebviewState.actionNeededVerbosity = actionNeededVerbosity;
      vscode.setState(Object.assign({}, persistedWebviewState, {
        discardedFindingFixes: discardedFindingFixes,
        findingFeedbackByKey: findingFeedbackByKey,
        pendingGoalFeedbackByKey: pendingGoalFeedbackByKey,
        sentAgentFixes: sentAgentFixes,
        batchFindingSelection: batchFindingSelection,
        actionNeededVerbosity: actionNeededVerbosity,
      }));
    }
  }

  function isBatchFindingSelected(f) {
    const fixKey = findingFixKey(f.id || '');
    const actionClass = f.actionClass || 'guidance';
    const appliedFix = !!appliedFindingFixes[fixKey];
    const sentFix = !!sentAgentFixes[fixKey];
    if (appliedFix || sentFix) { return false; }
    if (Object.prototype.hasOwnProperty.call(batchFindingSelection, fixKey)) {
      return !!batchFindingSelection[fixKey];
    }
    // Default on for anything with a Fix / Fix in IDE primary action.
    return actionClass === 'applyable' || actionClass === 'agent' || actionClass === 'guidance';
  }

  function isBatchableFinding(f) {
    if (!f || String(f.id || '').indexOf('throttled-') === 0) { return false; }
    const fixKey = findingFixKey(f.id || '');
    if (appliedFindingFixes[fixKey] || sentAgentFixes[fixKey]) { return false; }
    if (findingFeedbackByKey[fixKey]) { return false; }
    const actionClass = f.actionClass || 'guidance';
    if (actionClass === 'applyable') { return !!f.suggestedFix; }
    return actionClass === 'agent' || actionClass === 'guidance';
  }

  function findingPayloadForHost(finding, reportId) {
    return {
      reportId: reportId,
      id: finding.id,
      file: finding.file,
      line: finding.line,
      endLine: finding.endLine,
      title: finding.title,
      explanation: finding.explanation,
      suggestedFix: finding.suggestedFix,
      remediation: finding.remediation,
      evidence: finding.evidence,
      codeSnippet: finding.codeSnippet,
      fix: finding.fix,
      agentPrompt: finding.agentPrompt,
      actionClass: finding.actionClass,
      category: finding.category,
      confidence: finding.confidence,
      severity: finding.severity,
      relatedLocations: finding.relatedLocations,
    };
  }

  function collectBatchEligibleFindings(result) {
    return (result && result.findings || []).filter(isBatchableFinding);
  }

  function countBatchSelection(items) {
    let applyN = 0;
    let agentM = 0;
    (items || []).forEach(function(f) {
      if (!isBatchFindingSelected(f)) { return; }
      const actionClass = f.actionClass || 'guidance';
      if (actionClass === 'applyable' && f.suggestedFix) { applyN++; }
      else { agentM++; }
    });
    return { applyN: applyN, agentM: agentM, total: applyN + agentM };
  }

  function maybeShowUpgradeVolumeCta(result) {
    const host = $('validateReviewUpgradeCta') || $('threadUpgradeVolumeCta');
    // Inject near validate page footer when Core quota is low after a successful review.
    let el = $('upgradeVolumeCta');
    if (!el) {
      const page = $('validateReviewPage');
      if (!page) { return; }
      el = document.createElement('div');
      el.id = 'upgradeVolumeCta';
      el.className = 'upgrade-volume-cta hidden';
      page.appendChild(el);
    }
    const tier = String(userTier || '').toUpperCase();
    if (tier !== 'CORE' && tier !== 'FREE' && tier !== 'UNKNOWN') {
      el.classList.add('hidden');
      return;
    }
    if (!result) {
      el.classList.add('hidden');
      return;
    }
    const remaining = valCountRemaining;
    const show = remaining !== 'unlimited' && remaining !== null && remaining !== undefined && Number(remaining) <= 2;
    if (!show) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    el.innerHTML = '<strong>Nice review.</strong> Core includes 5 managed Validate &amp; Review runs / month. Pro is 50 — same ticket-true quality, more volume.' +
      '<div><button type="button" class="btn primary compact" id="upgradeVolumeBtn">Upgrade to Pro</button></div>';
    const btn = $('upgradeVolumeBtn');
    if (btn) { btn.onclick = () => startBillingCheckout('pro'); }
  }

  /** Update batch bar labels/disabled state without rebuilding Action Needed (avoids collapse). */
  function syncBatchFixBarDom() {
    const bar = document.querySelector('.vr-batch-fix-bar');
    if (!bar) { return; }
    const result = validateReview.result || state.validateReviewResult || null;
    const counts = countBatchSelection(collectBatchEligibleFindings(result));
    const fixBtn = bar.querySelector('[data-action="batch_fix_selected"]');
    const applyBtn = bar.querySelector('[data-action="batch_apply_safe"]');
    const agentBtn = bar.querySelector('[data-action="batch_agent_fix"]');
    if (fixBtn) {
      fixBtn.disabled = counts.total === 0;
      fixBtn.textContent = 'Fix selected (' + counts.total + ')';
    }
    if (applyBtn) {
      applyBtn.disabled = counts.applyN === 0;
      applyBtn.textContent = 'Apply ' + counts.applyN + ' safe';
    }
    if (agentBtn) {
      agentBtn.disabled = counts.agentM === 0;
      agentBtn.textContent = 'Send ' + counts.agentM + ' to agent';
    }
  }

  function renderBatchFixBar(items) {
    if (!Array.isArray(items) || !items.length) { return ''; }
    const selectable = items.some(isBatchableFinding);
    if (!selectable) { return ''; }
    const counts = countBatchSelection(items.filter(isBatchableFinding));
    return '<div class="vr-batch-fix-bar">' +
      '<div class="vr-batch-selected">' + counts.total + ' selected</div>' +
      '<button type="button" class="btn primary compact" data-action="batch_fix_selected"' +
        (counts.total ? '' : ' disabled') +
        ' title="Apply safe patches then send the rest to your IDE agent">' +
        'Fix selected' +
      '</button>' +
    '</div>';
  }

  function feedbackLabel(verdict) {
    if (verdict === 'accepted') { return 'Useful'; }
    if (verdict === 'out_of_scope') { return 'Out of scope'; }
    return String(verdict || '').replace(/_/g, ' ');
  }

  function renderFindingActions(f, primaryHtml, moreHtml) {
    const feedbackKey = findingFixKey(f.id || '');
    const prior = findingFeedbackByKey[feedbackKey];
    if (prior) {
      return '<div class="vr-finding-actions">' +
        (primaryHtml || '') +
        '<span class="vr-feedback-confirmed">' + escHtml(feedbackLabel(prior)) + '</span>' +
        (moreHtml || '') +
      '</div>';
    }
    return '<div class="vr-finding-actions">' +
      (primaryHtml || '') +
      '<button class="vr-fa-btn accept" data-action="accept" data-finding-id="' + escHtml(f.id || '') + '" title="Mark as a useful / valid finding">Useful</button>' +
      '<details class="vr-ignore-menu">' +
        '<summary class="vr-fa-btn dismiss">Ignore</summary>' +
        '<div class="vr-ignore-options">' +
          '<button class="vr-fa-btn dismiss" data-action="dismiss" data-finding-id="' + escHtml(f.id || '') + '" title="Dismiss this finding">Dismiss</button>' +
          '<button class="vr-fa-btn not-relevant" data-action="not_relevant" data-finding-id="' + escHtml(f.id || '') + '" title="Not relevant to this change">Not relevant</button>' +
          '<button class="vr-fa-btn wrong" data-action="wrong" data-finding-id="' + escHtml(f.id || '') + '" title="False positive">Wrong</button>' +
          '<button class="vr-fa-btn team-learning" data-action="team_learning" data-finding-id="' + escHtml(f.id || '') + '" title="Write this to .tyne/learnings.md so it is suppressed for everyone — reviewable in your next PR">Suppress for team…</button>' +
        '</div>' +
      '</details>' +
      '<button class="vr-fa-btn create-task" data-action="create_task" data-finding-id="' + escHtml(f.id || '') + '" title="Create Jira/Linear task from this finding">Create task</button>' +
      (moreHtml || '') +
    '</div>';
  }

  function renderDiffBlock(diffText, label) {
    var lines = String(diffText || '').replace(/\r\n/g, '\n').split('\n');
    var body = lines.map(function(line) {
      if (/^\+\+\+|^---|^@@|^diff /.test(line)) {
        return '<span class="vr-diff-line meta">' + escHtml(line) + '</span>';
      }
      if (line.charAt(0) === '+') { return '<span class="vr-diff-line add">' + escHtml(line) + '</span>'; }
      if (line.charAt(0) === '-') { return '<span class="vr-diff-line del">' + escHtml(line) + '</span>'; }
      return '<span class="vr-diff-line">' + escHtml(line) + '</span>';
    }).join('');
    return '<div class="vr-code-block vr-fix-diff">' +
      '<div class="vr-code-block-label">' + escHtml(label || 'Suggested fix') + '</div>' +
      '<pre class="vr-code-pre">' + body + '</pre>' +
    '</div>';
  }

  function renderCodeSnippetBlock(snippet) {
    if (!snippet) { return ''; }
    return '<div class="vr-code-block vr-current-code">' +
      '<div class="vr-code-block-label">Current code</div>' +
      '<pre class="vr-code-pre">' + escHtml(String(snippet).slice(0, 800)) + '</pre>' +
    '</div>';
  }

  function renderFindingEvidence(f, canApply, discardedFix) {
    var html = renderCodeSnippetBlock(f.codeSnippet);
    if (f.fix && f.fix.diff) {
      html += renderDiffBlock(f.fix.diff, f.fix.description || 'Suggested fix');
    } else if (canApply && f.suggestedFix && !discardedFix) {
      html += '<div class="vr-code-block vr-fix-diff">' +
        '<div class="vr-code-block-label">Suggested fix</div>' +
        '<pre class="vr-code-pre vr-suggested-fix" data-finding-id="' + escHtml(f.id || '') + '">' + escHtml(f.suggestedFix) + '</pre>' +
      '</div>';
    }
    return html;
  }

  // Opens VS Code's native side-by-side diff editor (current code vs proposed)
  // via the host's previewFix handler — real gutters, syntax highlighting and
  // inline navigation, which a webview pane cannot match.
  function compareFixButton(f) {
    const hasProposal = Boolean(f.suggestedFix) || Boolean(f.fix && f.fix.diff);
    if (!hasProposal || !f.file) { return ''; }
    return '<button class="vr-fa-btn compare-fix" data-action="preview_fix" data-finding-id="' + escHtml(f.id || '') + '"' +
      ' title="Open a side-by-side diff of the current code and the proposed fix">Compare</button>';
  }

  function confidenceHedge(f) {
    var c = String(f.confidence || '').toLowerCase();
    if (c === 'low') { return '<span class="vr-confidence-chip low" title="Heuristic guess — verify before acting">Possible — verify</span>'; }
    if (c === 'medium') { return '<span class="vr-confidence-chip medium" title="Likely but not certain">Likely</span>'; }
    return '';
  }

  function relatedLocationsNote(f) {
    var locs = Array.isArray(f.relatedLocations) ? f.relatedLocations : [];
    if (!locs.length) { return ''; }
    return '<div class="vr-related-locations">' +
      '<span class="vr-mini-label">Also in:</span> ' +
      locs.slice(0, 6).map(function(l) {
        return '<code>' + escHtml(l.file + (l.startLine ? ':' + l.startLine : '')) + '</code>';
      }).join(' ') +
    '</div>';
  }

  function renderFindingList(items) {
    if (!Array.isArray(items) || !items.length) { return ''; }
    return '<div class="vr-finding-stack">' +
      items.slice(0, 8).map(function(f) {
        const fixKey = findingFixKey(f.id || '');
        const appliedFix = !!appliedFindingFixes[fixKey];
        const discardedFix = !!discardedFindingFixes[fixKey];
        const sentFix = !!sentAgentFixes[fixKey];
        const priorFeedback = findingFeedbackByKey[fixKey];
        const fileBase = f.file ? String(f.file).split('/').pop() : '';
        const loc = fileBase
          ? fileBase + (f.line ? ':' + f.line : '')
          : '';
        const cat = String(f.category || 'general').replace(/_/g, ' ');
        const catLabel = cat ? cat.charAt(0).toUpperCase() + cat.slice(1) : 'General';
        const actionClass = f.actionClass || 'guidance';
        const canApply = actionClass === 'applyable' && f.suggestedFix && !discardedFix;
        const id = escHtml(f.id || '');
        let primary = '';
        if (appliedFix) {
          primary = '<button class="vr-fa-btn undo-fix" data-action="undo_fix" data-finding-id="' + id + '">Undo</button>';
        } else if (canApply) {
          primary = '<button class="vr-fa-btn apply-fix action-primary" data-action="apply_fix" data-finding-id="' + id + '">Fix</button>';
        } else if (sentFix) {
          primary = '<button class="vr-fa-btn agent-fix action-primary sent" data-action="agent_fix" data-finding-id="' + id + '" disabled title="Prompt sent to your IDE agent">Sent ✓</button>';
        } else {
          primary = '<button class="vr-fa-btn agent-fix action-primary" data-action="agent_fix" data-finding-id="' + id + '" title="Send a fix prompt to your IDE agent">Fix in IDE</button>';
        }
        const compare = compareFixButton(f);
        const more = compare
          ? '<details class="vr-finding-more">' +
              '<summary class="vr-fa-btn vr-finding-more-btn" title="More" aria-label="More">⋯</summary>' +
              '<div class="vr-finding-more-menu">' + compare + '</div>' +
            '</details>'
          : '';
        const sevClass = escHtml(f.severity || 'medium');
        const dsev = displaySeverity(f.severity, f.category);
        const ruleId = f.ruleId ? '<div class="vr-finding-rule">' + escHtml(String(f.ruleId)) + '</div>' : '';
        return '<div class="vr-finding-row vr-finding-card ' + sevClass + ' vr-dsev-row-' + dsev + (priorFeedback ? ' resolved' : '') + '" data-finding-id="' + id + '" data-action-class="' + escHtml(actionClass) + '">' +
          '<div class="vr-finding-head">' +
            severityBadge(f.severity, f.category) +
            '<span class="vr-cat-chip">' + escHtml(catLabel) + '</span>' +
            confidenceHedge(f) +
          '</div>' +
          ruleId +
          '<button type="button" class="vr-finding-title-btn" data-action="open_finding" data-finding-id="' + id + '" title="Open in editor">' +
            '<strong class="vr-finding-title">' + escHtml(f.title || 'Finding') + '</strong>' +
          '</button>' +
          (loc ? '<button type="button" class="vr-finding-loc" data-action="open_finding" data-finding-id="' + id + '" title="Open in editor">' + escHtml(loc) + '</button>' : '') +
          renderCollapsibleDetail(findingDetailText(f), 'vr-finding-body') +
          renderFindingActions(f, primary, more) +
        '</div>';
      }).join('') +
    '</div>';
  }

  function renderNextActionList(items) {
    if (!Array.isArray(items) || !items.length) { return ''; }
    return renderMiniList('Next actions', items.map(function(item) {
      return item.title + (item.fileHint ? ' · ' + item.fileHint : '');
    }), 'actions');
  }

  function extractReviewMermaid(r) {
    const flow = r && r.architectureFlow;
    if (flow && typeof flow.mermaid === 'string' && flow.mermaid.trim()) { return flow.mermaid.trim(); }
    const markdown = normalizeReviewMarkdown((r && r.fullReport) || '');
    const match = markdown.match(/```mermaid\s*([\s\S]*?)```/i);
    return match ? match[1].trim() : '';
  }

  function inferClientArchitectureLayer(filePath, kind) {
    const path = String(filePath || '').replace(/\\/g, '/').toLowerCase();
    if (kind === 'database' || /\/migrations\/|\/schema\/|\.sql$|prisma|drizzle|typeorm/.test(path)) { return 'database'; }
    if (kind === 'external' || kind === 'auth' || /oauth|stripe|twilio|sendgrid|sentry/.test(path)) { return 'external'; }
    if (kind === 'api' || /\/api\/|\/routes\/|\/controllers\/|\/handlers\/|\/functions\/|server\/|backend\//.test(path)) { return 'backend'; }
    if (kind === 'ui' || /\/components\/|\/pages\/|\/views\/|\.tsx$|\.vue$|\.svelte$/.test(path)) { return 'extension'; }
    return 'extension';
  }

  function inferClientArchitectureKind(filePath, fallback) {
    const path = String(filePath || '').replace(/\\/g, '/').toLowerCase();
    if (/\/migrations\/|\/schema\/|\.sql$|prisma|drizzle/.test(path)) { return 'database'; }
    if (/\/api\/|\/routes\/|\/controllers\/|\/handlers\/|\/functions\/|server\//.test(path)) { return 'api'; }
    if (/oauth|stripe|twilio|sendgrid|sentry/.test(path)) { return 'auth'; }
    if (/\/components\/|\/pages\/|\/views\/|\.tsx$|\.vue$|\.svelte$/.test(path)) { return 'ui'; }
    if (/\/services\/|\/lib\/|\/utils\//.test(path)) { return 'service'; }
    return fallback || 'file';
  }

  function layerTitleFallback(layerId) {
    if (layerId === 'backend') { return 'API / Services'; }
    if (layerId === 'database') { return 'Database'; }
    if (layerId === 'external') { return 'External'; }
    return 'Application';
  }

  function shortArchLabel(value) {
    const raw = String(value || '').replace(/\\/g, '/');
    if (!raw) { return 'Node'; }
    const parts = raw.split('/');
    return parts[parts.length - 1] || raw;
  }

  var ARCH_LAYER_ORDER = ['extension', 'backend', 'database', 'external'];

  function defaultFlowLayers(includeDatabase) {
    const layers = [
      { id: 'extension', title: layerTitleFallback('extension') },
      { id: 'backend', title: layerTitleFallback('backend') },
    ];
    if (includeDatabase) {
      layers.push({ id: 'database', title: layerTitleFallback('database') });
    }
    layers.push({ id: 'external', title: layerTitleFallback('external') });
    return layers;
  }

  function enrichArchitectureNodes(nodes) {
    return (nodes || []).map(function(node) {
      const kind = node.kind || inferClientArchitectureKind(node.file, 'file');
      var layer = node.layer || inferClientArchitectureLayer(node.file, kind);
      if (kind === 'database' && layer !== 'external') { layer = 'database'; }
      return Object.assign({}, node, {
        kind: kind,
        layer: layer,
        changed: Boolean(node.changed || node.highlighted),
        verdict: node.verdict || (node.highlighted || node.kind === 'risk' ? 'wrong' : (node.changed ? 'mixed' : 'neutral')),
      });
    });
  }

  function prioritizeArchitectureNodes(nodes) {
    return enrichArchitectureNodes(nodes || []).slice(0, 40);
  }

  function annotateSystemNode(base, matchedFiles, findings, extraNote) {
    const files = (matchedFiles || []).filter(Boolean);
    const adds = files.reduce(function(sum, f) { return sum + (Number(f.additions) || 0); }, 0);
    const dels = files.reduce(function(sum, f) { return sum + (Number(f.deletions) || 0); }, 0);
    const findingHit = files.some(function(f) {
      return (findings || []).some(function(x) { return x.file === f.file; });
    });
    const names = files.slice(0, 3).map(function(f) { return shortArchLabel(f.file); });
    const noteParts = [];
    if (names.length) { noteParts.push(names.join(', ') + (files.length > 3 ? ' +' + (files.length - 3) : '')); }
    if (extraNote) { noteParts.push(extraNote); }
    return Object.assign({}, base, {
      changed: files.length > 0,
      additions: files.length ? adds : undefined,
      deletions: files.length ? dels : undefined,
      highlighted: findingHit,
      verdict: findingHit ? 'wrong' : (files.length ? 'mixed' : 'neutral'),
      note: noteParts.length ? noteParts.join(' · ') : undefined,
      file: files[0] && files[0].file,
      files: files.map(function(f) { return f.file; }).filter(Boolean),
    });
  }

  function mergeDiffIntoArchitectureNodes(nodes, visualDiff, findings) {
    const diffs = Array.isArray(visualDiff) ? visualDiff : [];
    const finds = Array.isArray(findings) ? findings : [];
    return prioritizeArchitectureNodes((nodes || []).map(function(node) {
      const file = node.file;
      const matched = file ? diffs.filter(function(f) { return f.file === file; }) : [];
      if (matched.length) {
        return annotateSystemNode(node, matched, finds, node.note);
      }
      if (node.changed || node.additions !== undefined || node.deletions !== undefined) {
        const pseudo = file ? [{ file: file, additions: node.additions || 0, deletions: node.deletions || 0 }] : [];
        return annotateSystemNode(node, pseudo, finds, node.note);
      }
      return enrichArchitectureNodes([node])[0];
    }));
  }

  function resolveFlowLayers(nodes, rawLayers) {
    const includeDatabase = (nodes || []).some(function(n) { return n.layer === 'database' || n.kind === 'database'; });
    const byId = {};
    (rawLayers || []).forEach(function(l) {
      if (l && l.id) { byId[l.id] = l.title || layerTitleFallback(l.id); }
    });
    const present = {};
    (nodes || []).forEach(function(n) {
      if (n.layer) { present[n.layer] = true; }
    });
    return ARCH_LAYER_ORDER.filter(function(id) {
      if (id === 'database' && !includeDatabase && !present.database) { return false; }
      return present[id] || id === 'extension';
    }).map(function(id) {
      return { id: id, title: byId[id] || layerTitleFallback(id) };
    }).filter(function(l) {
      return (nodes || []).some(function(n) { return n.layer === l.id; });
    });
  }

  function buildArchitectureFlowFromDiff(r) {
    const files = Array.isArray(r && r.visualDiff) ? r.visualDiff.slice(0, 12) : [];
    const findings = Array.isArray(r && r.findings) ? r.findings : [];
    if (!files.length) { return null; }

    const fileNodes = files.map(function(f, index) {
      const path = String(f.file || '').replace(/\\/g, '/');
      const kind = inferClientArchitectureKind(path, 'file');
      var layer = inferClientArchitectureLayer(path, kind);
      if (kind === 'database') { layer = 'database'; }
      return annotateSystemNode({
        id: 'file_' + (index + 1),
        label: shortArchLabel(path),
        kind: kind,
        layer: layer,
        file: path,
      }, [f], findings);
    });

    // Chaining adjacent diff entries (file1 -> file2 -> file3) invented a
    // dependency that does not exist — diff order is not call order — and
    // forced every layer into one straight line. Hang each file off its layer
    // anchor instead, which is what the backend flow already does. Anchors are
    // emitted first so the 16-node cap never strips a parent off its children.
    const anchorNodes = [];
    const anchors = {};
    const edges = [];
    fileNodes.forEach(function(node) {
      if (!anchors[node.layer]) {
        const anchorId = 'layer_' + node.layer;
        anchors[node.layer] = anchorId;
        anchorNodes.push({
          id: anchorId,
          label: layerTitleFallback(node.layer),
          kind: node.layer === 'database' ? 'database' : (node.layer === 'backend' ? 'api' : (node.layer === 'external' ? 'external' : 'service')),
          layer: node.layer,
          changed: false,
        });
      }
      edges.push({ from: anchors[node.layer], to: node.id });
    });
    const nodes = anchorNodes.concat(fileNodes);

    const totalAdditions = files.reduce(function(sum, f) { return sum + (Number(f.additions) || 0); }, 0);
    const totalDeletions = files.reduce(function(sum, f) { return sum + (Number(f.deletions) || 0); }, 0);
    const mergedNodes = mergeDiffIntoArchitectureNodes(nodes, files, findings);

    return {
      title: 'Architecture Flow',
      summary: files.length + ' changed file' + (files.length === 1 ? '' : 's') + ' mapped across your project layers.',
      layers: resolveFlowLayers(mergedNodes, null),
      nodes: mergedNodes,
      edges: edges.slice(0, 18),
      totalAdditions: totalAdditions,
      totalDeletions: totalDeletions,
      whatWentRight: [],
      whatWentWrong: [],
    };
  }

  function buildArchitectureFlowFromReport(r) {
    const files = Array.isArray(r && r.visualDiff) ? r.visualDiff : [];
    const findings = Array.isArray(r && r.findings) ? r.findings : [];
    const aiFlow = r && r.architectureFlow;
    const totalAdditions = files.reduce(function(sum, f) { return sum + (Number(f.additions) || 0); }, 0);
    const totalDeletions = files.reduce(function(sum, f) { return sum + (Number(f.deletions) || 0); }, 0);

    if (aiFlow && Array.isArray(aiFlow.nodes) && aiFlow.nodes.length) {
      const rawNodes = aiFlow.nodes.slice(0, 40).map(function(node, index) {
        return Object.assign({}, node, {
          id: node.id || ('node_' + (index + 1)),
          label: node.label || shortArchLabel(node.file) || ('Node ' + (index + 1)),
        });
      });
      const mergedNodes = mergeDiffIntoArchitectureNodes(rawNodes, files, findings);
      const nodeIds = new Set(mergedNodes.map(function(n) { return n.id; }));
      const edges = (Array.isArray(aiFlow.edges) ? aiFlow.edges : []).filter(function(e) {
        return e && nodeIds.has(e.from) && nodeIds.has(e.to);
      }).slice(0, 48);
      const changedCount = mergedNodes.filter(function(n) { return n.changed; }).length;
      const ghostCount = mergedNodes.filter(function(n) { return n.note === 'outside diff'; }).length;
      return {
        title: aiFlow.title || 'Architecture Flow',
        summary: aiFlow.summary || (changedCount
          ? (changedCount + ' area' + (changedCount === 1 ? '' : 's') + ' touched in this review')
          : 'Architecture map for this change set.'),
        layers: resolveFlowLayers(mergedNodes, aiFlow.layers),
        nodes: mergedNodes,
        edges: edges,
        readingOrder: Array.isArray(aiFlow.readingOrder) ? aiFlow.readingOrder : [],
        sequence: aiFlow.sequence || null,
        mermaid: aiFlow.mermaid || '',
        generatedBy: aiFlow.generatedBy || '',
        totalAdditions: aiFlow.totalAdditions !== undefined ? aiFlow.totalAdditions : totalAdditions,
        totalDeletions: aiFlow.totalDeletions !== undefined ? aiFlow.totalDeletions : totalDeletions,
        whatWentRight: aiFlow.whatWentRight || [],
        whatWentWrong: aiFlow.whatWentWrong || [],
        _ghostCount: ghostCount,
      };
    }

    const diffFlow = buildArchitectureFlowFromDiff(r);
    if (diffFlow) { return diffFlow; }

    return {
      title: 'Architecture Flow',
      summary: 'No proven architecture signals in this diff.',
      layers: [],
      nodes: [],
      edges: [],
      readingOrder: [],
      sequence: null,
      totalAdditions: totalAdditions,
      totalDeletions: totalDeletions,
      whatWentRight: [],
      whatWentWrong: [],
    };
  }

  // Legacy alias kept for tests / call sites.
  function buildSystemArchitectureFlow(r) {
    return buildArchitectureFlowFromReport(r || {});
  }

  function deriveArchitectureNarratives() {
    return { whatWentRight: [], whatWentWrong: [] };
  }

  function flowFromReport(r) {
    return buildArchitectureFlowFromReport(r || {});
  }

  function parseSimpleMermaidFlow(mermaid) {
    const nodes = new Map();
    const edges = [];
    String(mermaid || '').split(/\r?\n/).forEach(function(line) {
      const edge = line.match(/^\s*([A-Za-z0-9_-]+)(?:\[([^\]]+)\])?\s*-->(?:\|([^|]+)\|)?\s*([A-Za-z0-9_-]+)(?:\[([^\]]+)\])?/);
      if (!edge) { return; }
      if (!nodes.has(edge[1])) { nodes.set(edge[1], { id: edge[1], label: edge[2] || edge[1], kind: 'file' }); }
      if (!nodes.has(edge[4])) { nodes.set(edge[4], { id: edge[4], label: edge[5] || edge[4], kind: 'file' }); }
      edges.push({ from: edge[1], to: edge[4], label: edge[3] || '' });
    });
    return { nodes: Array.from(nodes.values()).slice(0, 16), edges: edges.slice(0, 18) };
  }

  function renderArchitectureFlowSection(r) {
    const flow = flowFromReport(r);
    const nodes = (flow && flow.nodes) || [];
    const changedN = nodes.filter(function(n) { return n.changed; }).length;
    const ghostN = nodes.filter(function(n) { return n.note === 'outside diff'; }).length;
    const total = [flow.totalAdditions !== undefined ? '+' + flow.totalAdditions : '', flow.totalDeletions !== undefined ? '-' + flow.totalDeletions : ''].filter(Boolean).join(' / ');
    const byline = [
      'Change impact',
      changedN ? (changedN + ' file' + (changedN === 1 ? '' : 's')) : '',
      ghostN ? (ghostN + ' outside caller' + (ghostN === 1 ? '' : 's')) : '',
      flow.generatedBy ? flow.generatedBy.replace(/_/g, ' ') : '',
    ].filter(Boolean).join(' · ');

    return '<section class="vr-architecture-flow">' +
      '<div class="vr-flow-head">' +
        '<div><h3>Architecture</h3><p>' + escHtml(byline) + '</p></div>' +
        (total ? '<span class="vr-flow-total">' + escHtml(total) + '</span>' : '') +
      '</div>' +
      ((flow.summary)
        ? '<div class="vr-flow-meta"><p>' + escHtml(flow.summary) + '</p></div>'
        : '') +
      renderReadingOrderStrip(flow) +
      renderArchitectureBoard(flow) +
      renderArchitectureSequence(flow) +
      renderChangeImpactSummary(flow) +
      '<details class="vr-arch-graph-toggle"><summary>Graph view</summary>' +
        renderFlowSvg(flow, r) +
      '</details>' +
      '<div class="vr-flow-inspector hidden" id="vrFlowInspector" aria-live="polite"></div>' +
    '</section>';
  }

  var ARCH_BOARD_SECTIONS = [
    { id: 'callers', title: 'Outside callers' },
    { id: 'extension', title: 'App & UI' },
    { id: 'backend', title: 'API & services' },
    { id: 'database', title: 'Database' },
    { id: 'effects', title: 'External & LLM' },
    { id: 'tests', title: 'Tests' },
  ];

  var ARCH_SECTION_SHORT = {
    callers: 'Callers',
    extension: 'App',
    backend: 'API',
    database: 'Database',
    effects: 'External',
    tests: 'Tests',
  };

  function clientSectionForNode(node) {
    if (node && node.section) { return node.section; }
    if (node && node.note === 'outside diff') { return 'callers'; }
    if (node && (node.kind === 'database' || node.layer === 'database')) { return 'database'; }
    if (node && (node.kind === 'llm' || node.kind === 'external')) { return 'effects'; }
    if (node && node.kind === 'test') { return 'tests'; }
    if (node && (node.kind === 'api' || node.kind === 'service' || node.kind === 'auth' || node.layer === 'backend')) {
      return 'backend';
    }
    return 'extension';
  }

  function renderArchitectureBoard(flow) {
    const nodes = (flow && flow.nodes) || [];
    if (!nodes.length) {
      return '<div class="vr-flow-empty">' + escHtml((flow && flow.summary) || 'No proven architecture signals in this diff.') + '</div>';
    }
    const byId = {};
    nodes.forEach(function(n) { byId[n.id] = n; });

    const bands = ARCH_BOARD_SECTIONS.map(function(sec) {
      const members = nodes.filter(function(n) {
        // Skip decision/terminal clutter on the board — they live in Graph view.
        if (n.kind === 'decision' || n.kind === 'terminal') { return false; }
        return clientSectionForNode(n) === sec.id;
      });
      return { id: sec.id, title: sec.title, members: members };
    }).filter(function(b) { return b.members.length > 0; });

    if (!bands.length) {
      return '<div class="vr-flow-empty">' + escHtml((flow && flow.summary) || 'No proven architecture signals in this diff.') + '</div>';
    }

    const chainKinds = { imports: 1, calls: 1, data: 1 };
    const crossEdges = ((flow && flow.edges) || []).filter(function(e) {
      if (!e || !chainKinds[e.kind]) { return false; }
      const a = byId[e.from];
      const b = byId[e.to];
      if (!a || !b) { return false; }
      return clientSectionForNode(a) !== clientSectionForNode(b);
    });

    // Group cross-section edges: fromSection → toSection
    const groups = {};
    crossEdges.forEach(function(e) {
      const a = byId[e.from];
      const b = byId[e.to];
      const key = clientSectionForNode(a) + '|' + clientSectionForNode(b);
      if (!groups[key]) { groups[key] = []; }
      groups[key].push(e);
    });

    let html = '<div class="vr-arch-board">';
    bands.forEach(function(band) {
      html += '<section class="vr-arch-band" data-section="' + escHtml(band.id) + '">' +
        '<div class="vr-arch-band-title">' + escHtml(band.title) +
          '<span class="vr-arch-band-count">' + band.members.length + '</span></div>' +
        '<div class="vr-arch-chips">' +
          band.members.map(function(n) {
            return renderArchChip(n);
          }).join('') +
        '</div></section>';
    });

    const groupKeys = Object.keys(groups);
    if (groupKeys.length) {
      html += '<div class="vr-arch-links">';
      groupKeys.forEach(function(key) {
        const parts = key.split('|');
        const fromS = ARCH_SECTION_SHORT[parts[0]] || parts[0];
        const toS = ARCH_SECTION_SHORT[parts[1]] || parts[1];
        const list = groups[key];
        const shown = list.slice(0, 4);
        const extra = list.length - shown.length;
        html += '<div class="vr-arch-link-group">' +
          '<div class="vr-arch-link-heading">' + escHtml(fromS) + ' → ' + escHtml(toS) + '</div>';
        shown.forEach(function(e) {
          const a = byId[e.from];
          const b = byId[e.to];
          html += '<div class="vr-arch-link-row">' +
            renderArchChipLink(a) +
            '<span class="vr-seq-arrow">→</span>' +
            renderArchChipLink(b) +
            (e.label ? '<span class="vr-seq-verb">' + escHtml(e.label) + '</span>' : '') +
          '</div>';
        });
        if (extra > 0) {
          html += '<div class="vr-arch-link-more">+' + extra + ' more</div>';
        }
        html += '</div>';
      });
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderArchChip(n) {
    let cls = 'vr-arch-chip';
    if (n.note === 'outside diff') { cls += ' ghost'; }
    else if (n.changed) { cls += ' changed'; }
    if (n.highlighted || n.verdict === 'wrong' || (n.findingIds && n.findingIds.length)) { cls += ' fault'; }
    const evidence = n.evidenceFile || '';
    const filePath = evidence || n.file || '';
    let attrs = ' class="' + cls + '" data-node-id="' + escHtml(n.id) + '" data-node-label="' + escHtml(n.label || n.id) + '"';
    if (filePath) {
      attrs += ' type="button" data-file-path="' + escHtml(filePath) + '"';
      if (evidence) {
        attrs += ' data-evidence-line="' + escHtml(String(n.evidenceLine || 1)) + '"';
      } else if (n.file) {
        attrs += ' data-file-list="' + escHtml(n.file) + '"';
        attrs += ' data-additions="' + escHtml(String(n.additions || 0)) + '"';
        attrs += ' data-deletions="' + escHtml(String(n.deletions || 0)) + '"';
      }
    } else {
      attrs += ' type="button" disabled';
    }
    return '<button' + attrs + '>' + escHtml(n.label || n.id) + '</button>';
  }

  function renderArchChipLink(n) {
    if (!n) { return '<span class="vr-arch-chip-inline">?</span>'; }
    const evidence = n.evidenceFile || '';
    const filePath = evidence || n.file || '';
    if (!filePath) {
      return '<span class="vr-arch-chip-inline">' + escHtml(n.label || n.id) + '</span>';
    }
    let attrs = ' class="vr-arch-chip-inline" type="button" data-file-path="' + escHtml(filePath) + '"';
    if (evidence) {
      attrs += ' data-evidence-line="' + escHtml(String(n.evidenceLine || 1)) + '"';
    }
    return '<button' + attrs + '>' + escHtml(n.label || n.id) + '</button>';
  }

  function renderReadingOrderStrip(flow) {
    const cohorts = (flow && Array.isArray(flow.readingOrder)) ? flow.readingOrder : [];
    if (!cohorts.length) { return ''; }
    return '<div class="vr-reading-order" role="list">' +
      cohorts.map(function(c, i) {
        return '<button type="button" class="vr-reading-chip" role="listitem" data-reading-cohort="' + escHtml(c.id) + '"' +
          ' data-node-ids="' + escHtml((c.nodeIds || []).join(',')) + '"' +
          ' title="' + escHtml(c.summary || '') + '">' +
          '<span class="vr-reading-num">' + (i + 1) + '</span>' +
          escHtml(c.title) +
        '</button>';
      }).join('') +
    '</div>';
  }

  function renderArchitectureSequence(flow) {
    const msgs = flow && flow.sequence && Array.isArray(flow.sequence.messages) ? flow.sequence.messages : [];
    if (msgs.length < 2) { return ''; }
    return '<div class="vr-arch-sequence">' +
      '<div class="vr-arch-sequence-label">Proven sequence</div>' +
      '<ol class="vr-arch-sequence-list">' +
        msgs.map(function(m) {
          return '<li><span class="vr-seq-from">' + escHtml(m.fromLabel) + '</span>' +
            '<span class="vr-seq-arrow">→</span>' +
            '<span class="vr-seq-to">' + escHtml(m.toLabel) + '</span>' +
            (m.label ? '<span class="vr-seq-verb">' + escHtml(m.label) + '</span>' : '') +
          '</li>';
        }).join('') +
      '</ol>' +
    '</div>';
  }

  function filterVerifiedBullets(bullets, flow) {
    const nodes = (flow && flow.nodes) || [];
    const files = {};
    const ids = {};
    const labels = {};
    nodes.forEach(function(n) {
      if (n.id) { ids[n.id] = true; }
      if (n.file) { files[String(n.file).replace(/\\/g, '/')] = true; }
      if (n.label) { labels[String(n.label).toLowerCase()] = true; }
      if (n.evidenceFile) { files[String(n.evidenceFile).replace(/\\/g, '/')] = true; }
    });
    return (Array.isArray(bullets) ? bullets : []).filter(function(b) {
      const t = String(b || '');
      if (!t.trim()) { return false; }
      // Keep only bullets that mention a real node id, file path, or node label.
      for (const f of Object.keys(files)) {
        if (f && t.indexOf(f) !== -1) { return true; }
        const base = f.split('/').pop();
        if (base && t.indexOf(base) !== -1) { return true; }
      }
      for (const id of Object.keys(ids)) {
        if (id && t.indexOf(id) !== -1) { return true; }
      }
      const lower = t.toLowerCase();
      for (const lab of Object.keys(labels)) {
        if (lab.length >= 3 && lower.indexOf(lab) !== -1) { return true; }
      }
      return false;
    }).slice(0, 6);
  }

  function renderChangeImpactSummary(flow) {
    // Changes live on the flowchart nodes — keep this panel empty unless verified bullets exist.
    const right = filterVerifiedBullets(flow && flow.whatWentRight, flow);
    const wrong = filterVerifiedBullets(flow && flow.whatWentWrong, flow);
    if (!right.length && !wrong.length) { return ''; }
    let html = '<div class="vr-change-impact-summary">';
    if (right.length) {
      html += '<div class="vr-impact-col ok"><div class="vr-impact-label">Verified strengths</div><ul>' +
        right.map(function(b) { return '<li>' + escHtml(b) + '</li>'; }).join('') + '</ul></div>';
    }
    if (wrong.length) {
      html += '<div class="vr-impact-col bad"><div class="vr-impact-label">Verified risks</div><ul>' +
        wrong.map(function(b) { return '<li>' + escHtml(b) + '</li>'; }).join('') + '</ul></div>';
    }
    html += '</div>';
    return html;
  }

  function focusChangedFileInReview(filePath) {
    if (!filePath) { return; }
    const diffCollapsible = document.querySelector('.vr-diff-collapsible');
    if (diffCollapsible) { diffCollapsible.open = true; }
    document.querySelectorAll('.vr-diff-file').forEach(function(details) {
      const code = details.querySelector('.vr-diff-filepath');
      if (code && code.textContent === filePath) {
        details.open = true;
        details.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
  }

  function showArchitectureNodeInspector(nodeId, label, files, additions, deletions) {
    const panel = document.getElementById('vrFlowInspector');
    if (!panel) { return; }
    if (!files || !files.length) {
      panel.classList.add('hidden');
      panel.innerHTML = '';
      return;
    }
    const stats = (additions !== undefined || deletions !== undefined)
      ? '<span class="vr-flow-inspector-stats">+' + (additions || 0) + ' / -' + (deletions || 0) + '</span>'
      : '';
    panel.innerHTML = '<div class="vr-flow-inspector-head"><strong>' + escHtml(label || nodeId) + '</strong>' + stats + '</div>' +
      '<div class="vr-flow-inspector-files">' +
        files.map(function(file) {
          return '<button type="button" class="vr-flow-inspector-file" data-file-path="' + escHtml(file) + '">' + escHtml(file) + '</button>';
        }).join('') +
      '</div>';
    panel.classList.remove('hidden');
  }

  // Renders the architecture flow as a flat, Mermaid-style `graph TD`: no
  // filled cards, no icons, no swimlane boxes. Shape carries kind, stroke
  // carries state, and a layered DAG layout carries the branching.
  function renderFlowSvg(flow, report, viewState) {
    const nodes = (flow && flow.nodes) || [];
    const edges = ((flow && flow.edges) || []).filter(function(edge) {
      return edge && edge.from && edge.to && edge.from !== edge.to;
    });
    if (!nodes.length) {
      return '<div class="vr-flow-empty">' + escHtml((flow && flow.summary) || 'No proven architecture signals in this diff.') + '</div>';
    }

    const byId = {};
    nodes.forEach(function(node) { byId[node.id] = node; });
    const n = function(id) { return byId[id] || { id: id, label: id, kind: 'file', layer: 'extension' }; };
    const realIds = nodes.map(function(node) { return node.id; });
    const isReal = {};
    realIds.forEach(function(id) { isReal[id] = true; });

    const CORNER = 6;
    const RANK_GAP = 30;
    const NODE_GAP_X = 16;
    const GRID_GAP_Y = 14;
    const CANVAS_PAD = 12;
    const LANE_H = 15;
    const MIN_W = 74;
    const MAX_W = 178;
    const LINE_H = 24;
    const SUB_H = 12;
    const TITLE_CHAR_W = 6;
    const MAX_W_TOTAL = 1200;
    // The sidebar is narrow, so a rank wider than this wraps into a grid and
    // grows downward instead of forcing a horizontal scroll. A caller that
    // knows the real panel width can override it.
    const TARGET_W = Math.max(240, (viewState && viewState.maxWidth) || 360);

    // Reports written before the numstat fix carry additions/deletions of 0 on
    // every node, because the collector scraped `--stat` for a per-file count
    // that only ever appears in git's summary line. A wall of "+0 -0" is worse
    // than no badge at all.
    const hasRealCounts = nodes.some(function(node) {
      return (Number(node.additions) || 0) > 0 || (Number(node.deletions) || 0) > 0;
    });

    function nodeSubText(node) {
      if (!hasRealCounts) { return ''; }
      if (!node.changed && node.additions === undefined && node.deletions === undefined) { return ''; }
      const add = Number(node.additions) || 0;
      const del = Number(node.deletions) || 0;
      if (!add && !del) { return ''; }
      return '+' + add + ' −' + del;
    }

    function nodeTitle(node) {
      return String(node.symbol || node.label || node.id || '');
    }

    function truncate(text, maxW, charW) {
      const str = String(text || '');
      const fits = Math.floor(maxW / (charW || TITLE_CHAR_W));
      if (str.length <= fits) { return str; }
      return str.slice(0, Math.max(5, fits - 1)) + '…';
    }

    // Mermaid sizes a node to its label instead of padding everything to a
    // fixed width, which is most of why its charts read as compact.
    function measure(node) {
      const title = nodeTitle(node);
      const sub = nodeSubText(node);
      const titleW = title.length * TITLE_CHAR_W + 22;
      const subW = sub.length * 5.4 + 22;
      const kind = node.kind;
      const pad = (kind === 'decision' || kind === 'external' || kind === 'llm') ? 26 : 0;
      const w = Math.max(MIN_W, Math.min(MAX_W, Math.ceil(Math.max(titleW, subW)) + pad));
      // A cylinder loses its top band to the ellipse cap and a diamond tapers
      // at both ends, so both need extra height or the label spills outside.
      const extra = kind === 'decision' ? 14 : (kind === 'database' ? 10 : 0);
      const h = (sub ? LINE_H + SUB_H : LINE_H) + extra;
      return { w: w, h: h, sub: sub, title: title };
    }

    // ── Layout: cycle removal -> ranking -> dummies -> ordering -> x ─────────
    const L = {};
    nodes.forEach(function(node) {
      const m = measure(node);
      L[node.id] = { id: node.id, w: m.w, h: m.h, sub: m.sub, title: m.title, dummy: false, layer: node.layer || 'extension' };
    });

    // Cycle removal: a back edge found while its head is still on the DFS stack
    // is flipped for layout purposes and drawn reversed later.
    const outIdx = {};
    realIds.forEach(function(id) { outIdx[id] = []; });
    edges.forEach(function(edge, i) {
      if (isReal[edge.from] && isReal[edge.to]) { outIdx[edge.from].push(i); }
    });
    const mark = {};
    const reversed = {};
    function visit(id) {
      mark[id] = 1;
      outIdx[id].forEach(function(i) {
        const to = edges[i].to;
        if (mark[to] === 1) { reversed[i] = true; return; }
        if (!mark[to]) { visit(to); }
      });
      mark[id] = 2;
    }
    realIds.forEach(function(id) { if (!mark[id]) { visit(id); } });

    const dag = [];
    edges.forEach(function(edge, i) {
      if (!isReal[edge.from] || !isReal[edge.to]) { return; }
      dag.push(reversed[i]
        ? { from: edge.to, to: edge.from, edge: edge, flipped: true }
        : { from: edge.from, to: edge.to, edge: edge, flipped: false });
    });

    // Longest-path ranking.
    const rank = {};
    realIds.forEach(function(id) { rank[id] = 0; });
    function relax() {
      for (let pass = 0; pass < realIds.length; pass++) {
        let moved = false;
        dag.forEach(function(e) {
          if (rank[e.to] < rank[e.from] + 1) { rank[e.to] = rank[e.from] + 1; moved = true; }
        });
        if (!moved) { break; }
      }
    }
    relax();

    // Keep the layers stacked top-to-bottom by flooring each layer beneath the
    // one before it, then re-relaxing so edge constraints still hold. Without
    // this the ranks are purely topological, every layer anchor lands on rank 0
    // side by side, and the application/API/database reading order is lost.
    const presentLayers = ARCH_LAYER_ORDER.filter(function(layer) {
      return realIds.some(function(id) { return L[id].layer === layer; });
    });
    const layerFloor = {};
    for (let round = 0; round < 3; round++) {
      let floor = 0;
      let bumped = false;
      presentLayers.forEach(function(layer) {
        layerFloor[layer] = floor;
        const members = realIds.filter(function(id) { return L[id].layer === layer; });
        if (!members.length) { return; }
        members.forEach(function(id) {
          if (rank[id] < floor) { rank[id] = floor; bumped = true; }
        });
        let top = floor;
        members.forEach(function(id) { if (rank[id] > top) { top = rank[id]; } });
        floor = top + 1;
      });
      if (!bumped) { break; }
      relax();
    }

    // Pull each source down to just above its earliest child, so a fan-in
    // parent sits next to its children instead of stranded at rank 0.
    const indeg = {};
    const succOf = {};
    realIds.forEach(function(id) { indeg[id] = 0; succOf[id] = []; });
    dag.forEach(function(e) { indeg[e.to]++; succOf[e.from].push(e.to); });
    realIds.forEach(function(id) {
      if (indeg[id] > 0 || !succOf[id].length) { return; }
      let min = Infinity;
      succOf[id].forEach(function(s) { if (rank[s] < min) { min = rank[s]; } });
      // Clamped to the layer's own floor so pulling an anchor down toward its
      // children can never lift it into the layer above.
      if (min !== Infinity) { rank[id] = Math.max(min - 1, layerFloor[L[id].layer] || 0); }
    });
    let minRank = Infinity;
    realIds.forEach(function(id) { if (rank[id] < minRank) { minRank = rank[id]; } });
    realIds.forEach(function(id) { rank[id] -= minRank; });

    // Dummy nodes for edges spanning more than one rank. Without these, a long
    // edge is drawn straight through whatever node boxes lie between its ends.
    const chains = [];
    let dummySeq = 0;
    dag.forEach(function(e) {
      const span = rank[e.to] - rank[e.from];
      if (span <= 1) {
        chains.push({ path: [e.from, e.to], edge: e.edge, flipped: e.flipped });
        return;
      }
      const path = [e.from];
      for (let r = rank[e.from] + 1; r < rank[e.to]; r++) {
        const id = '__d' + (dummySeq++);
        L[id] = { id: id, w: 1, h: 1, dummy: true, layer: L[e.from].layer };
        rank[id] = r;
        path.push(id);
      }
      path.push(e.to);
      chains.push({ path: path, edge: e.edge, flipped: e.flipped });
    });

    const maxRank = Object.keys(rank).reduce(function(max, id) { return Math.max(max, rank[id]); }, 0);
    const ranks = [];
    for (let r = 0; r <= maxRank; r++) { ranks.push([]); }
    Object.keys(L).forEach(function(id) { ranks[rank[id]].push(id); });

    // Adjacency over the dummy-expanded graph, used for ordering and x-placement.
    const preds = {};
    const succs = {};
    Object.keys(L).forEach(function(id) { preds[id] = []; succs[id] = []; });
    chains.forEach(function(chain) {
      for (let i = 1; i < chain.path.length; i++) {
        succs[chain.path[i - 1]].push(chain.path[i]);
        preds[chain.path[i]].push(chain.path[i - 1]);
      }
    });

    function positions(row) {
      const pos = {};
      row.forEach(function(id, i) { pos[id] = i; });
      return pos;
    }

    function crossings() {
      let total = 0;
      for (let r = 0; r + 1 < ranks.length; r++) {
        const upper = positions(ranks[r]);
        const lower = positions(ranks[r + 1]);
        const pairs = [];
        ranks[r].forEach(function(id) {
          succs[id].forEach(function(s) {
            if (lower[s] !== undefined) { pairs.push([upper[id], lower[s]]); }
          });
        });
        for (let a = 0; a < pairs.length; a++) {
          for (let b = a + 1; b < pairs.length; b++) {
            if ((pairs[a][0] - pairs[b][0]) * (pairs[a][1] - pairs[b][1]) < 0) { total++; }
          }
        }
      }
      return total;
    }

    function median(id, neighbours, pos) {
      const vals = neighbours.map(function(nid) { return pos[nid]; })
        .filter(function(v) { return v !== undefined; })
        .sort(function(a, b) { return a - b; });
      if (!vals.length) { return -1; }
      const mid = vals.length / 2;
      return vals.length % 2 ? vals[(vals.length - 1) / 2] : (vals[mid - 1] + vals[mid]) / 2;
    }

    let best = ranks.map(function(row) { return row.slice(); });
    let bestScore = crossings();
    for (let sweep = 0; sweep < 4; sweep++) {
      const down = sweep % 2 === 0;
      if (down) {
        for (let r = 1; r < ranks.length; r++) {
          const pos = positions(ranks[r - 1]);
          const keys = {};
          ranks[r].forEach(function(id, i) {
            const m = median(id, preds[id], pos);
            keys[id] = m < 0 ? i : m;
          });
          ranks[r].sort(function(a, b) { return keys[a] - keys[b]; });
        }
      } else {
        for (let r = ranks.length - 2; r >= 0; r--) {
          const pos = positions(ranks[r + 1]);
          const keys = {};
          ranks[r].forEach(function(id, i) {
            const m = median(id, succs[id], pos);
            keys[id] = m < 0 ? i : m;
          });
          ranks[r].sort(function(a, b) { return keys[a] - keys[b]; });
        }
      }
      const score = crossings();
      if (score < bestScore) {
        bestScore = score;
        best = ranks.map(function(row) { return row.slice(); });
      }
    }
    for (let r = 0; r < ranks.length; r++) { ranks[r] = best[r]; }

    // X assignment: pull each node toward the median of its neighbours, then
    // push overlaps apart while preserving the order chosen above.
    ranks.forEach(function(row) {
      let x = 0;
      row.forEach(function(id) { L[id].x = x; x += L[id].w + NODE_GAP_X; });
    });
    function centerOf(id) { return L[id].x + L[id].w / 2; }
    function separate(row) {
      for (let i = 1; i < row.length; i++) {
        const prev = L[row[i - 1]];
        const cur = L[row[i]];
        const min = prev.x + prev.w + NODE_GAP_X;
        if (cur.x < min) { cur.x = min; }
      }
      for (let i = row.length - 2; i >= 0; i--) {
        const next = L[row[i + 1]];
        const cur = L[row[i]];
        const max = next.x - NODE_GAP_X - cur.w;
        if (cur.x > max) { cur.x = max; }
      }
    }
    for (let iter = 0; iter < 6; iter++) {
      const useSucc = iter % 2 === 1;
      const order = useSucc ? ranks.slice().reverse() : ranks;
      order.forEach(function(row) {
        row.forEach(function(id) {
          const neighbours = useSucc ? succs[id] : preds[id];
          if (!neighbours.length) { return; }
          const centers = neighbours.map(centerOf).sort(function(a, b) { return a - b; });
          const mid = centers.length / 2;
          const target = centers.length % 2 ? centers[(centers.length - 1) / 2] : (centers[mid - 1] + centers[mid]) / 2;
          L[id].x = target - L[id].w / 2;
        });
        separate(row);
      });
    }

    // Disconnected subgraphs — which is what stacked layers usually are — get
    // packed from x=0 independently, so each layer drifted to its own offset
    // and the chart read as three unrelated diagrams. Centre any component
    // that shares no rank with another on the common axis.
    const componentOf = {};
    const allIds = Object.keys(L);
    let componentSeq = 0;
    allIds.forEach(function(id) {
      if (componentOf[id] !== undefined) { return; }
      const cid = componentSeq++;
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop();
        if (componentOf[cur] !== undefined) { continue; }
        componentOf[cur] = cid;
        preds[cur].concat(succs[cur]).forEach(function(next) {
          if (componentOf[next] === undefined) { stack.push(next); }
        });
      }
    });
    if (componentSeq > 1) {
      const spans = {};
      allIds.forEach(function(id) {
        const cid = componentOf[id];
        const span = spans[cid] || (spans[cid] = { min: Infinity, max: -Infinity, ranks: {} });
        if (L[id].x < span.min) { span.min = L[id].x; }
        if (L[id].x + L[id].w > span.max) { span.max = L[id].x + L[id].w; }
        span.ranks[rank[id]] = true;
      });
      let axisMin = Infinity;
      let axisMax = -Infinity;
      allIds.forEach(function(id) {
        if (L[id].x < axisMin) { axisMin = L[id].x; }
        if (L[id].x + L[id].w > axisMax) { axisMax = L[id].x + L[id].w; }
      });
      const axis = (axisMin + axisMax) / 2;
      Object.keys(spans).forEach(function(cid) {
        const span = spans[cid];
        const sharesRank = Object.keys(spans).some(function(other) {
          if (other === cid) { return false; }
          return Object.keys(span.ranks).some(function(r) { return spans[other].ranks[r]; });
        });
        if (sharesRank) { return; }
        const delta = axis - (span.min + span.max) / 2;
        allIds.forEach(function(id) {
          if (componentOf[id] !== Number(cid)) { return; }
          L[id].x += delta;
          L[id].cx = L[id].x + L[id].w / 2;
        });
      });
    }

    // Lane rules replace the old swimlane boxes: a rank inherits the layer of
    // most of its real nodes, and a rule is drawn only where that changes.
    const laneOf = [];
    ranks.forEach(function(row, r) {
      const tally = {};
      row.forEach(function(id) {
        if (L[id].dummy) { return; }
        const layer = L[id].layer;
        tally[layer] = (tally[layer] || 0) + 1;
      });
      let top = '';
      Object.keys(tally).forEach(function(layer) {
        if (!top || tally[layer] > tally[top]) { top = layer; }
      });
      laneOf[r] = top;
    });

    // A rank wider than the sidebar wraps its real nodes into a centered grid,
    // so a 12-file fan-out reads as a tidy block that grows downward instead of
    // a single row the user has to scroll sideways to see. Ranks that already
    // fit keep the median x from the DAG pass, so parents stay centred over
    // their children.
    const geom = ranks.map(function(row) {
      const reals = row.filter(function(id) { return !L[id].dummy; });
      let colW = 0;
      let maxH = 1;
      reals.forEach(function(id) {
        if (L[id].w > colW) { colW = L[id].w; }
        if (L[id].h > maxH) { maxH = L[id].h; }
      });
      const naturalW = reals.reduce(function(s, id) { return s + L[id].w; }, 0) +
        Math.max(0, reals.length - 1) * NODE_GAP_X;
      let cols = reals.length || 1;
      if (naturalW > TARGET_W && colW > 0) {
        cols = Math.max(1, Math.floor((TARGET_W + NODE_GAP_X) / (colW + NODE_GAP_X)));
        cols = Math.min(cols, reals.length);
      }
      const gridRows = Math.max(1, Math.ceil(reals.length / cols));
      return { reals: reals, colW: colW, maxH: maxH, cols: cols, gridRows: gridRows, wrapped: gridRows > 1 };
    });

    function medianParentCx(id) {
      const centers = preds[id].map(function(pid) { return L[pid].cx; })
        .filter(function(v) { return v !== undefined; })
        .sort(function(a, b) { return a - b; });
      if (!centers.length) { return null; }
      const mid = centers.length / 2;
      return centers.length % 2 ? centers[(centers.length - 1) / 2] : (centers[mid - 1] + centers[mid]) / 2;
    }

    let y = CANVAS_PAD;
    const laneMarks = [];
    ranks.forEach(function(row, r) {
      const lane = laneOf[r];
      if (lane && lane !== laneOf[r - 1]) {
        laneMarks.push({ y: y, title: layerTitleFallback(lane) });
        y += LANE_H;
      }
      const g = geom[r];

      if (g.wrapped) {
        const blockW = g.cols * g.colW + (g.cols - 1) * NODE_GAP_X;
        // Centre the block under its parents when it has any, else on the axis.
        let cx = null;
        g.reals.forEach(function(id) {
          const pc = medianParentCx(id);
          if (pc !== null) { cx = cx === null ? pc : (cx + pc) / 2; }
        });
        let blockX = cx !== null ? cx - blockW / 2 : (TARGET_W - blockW) / 2 + CANVAS_PAD;
        if (blockX < CANVAS_PAD) { blockX = CANVAS_PAD; }
        g.reals.forEach(function(id, i) {
          const nd = L[id];
          const col = i % g.cols;
          const gridRow = Math.floor(i / g.cols);
          nd.x = blockX + col * (g.colW + NODE_GAP_X) + (g.colW - nd.w) / 2;
          nd.y = y + gridRow * (g.maxH + GRID_GAP_Y) + (g.maxH - nd.h) / 2;
          nd.cx = nd.x + nd.w / 2;
          nd.cy = nd.y + nd.h / 2;
          nd.top = nd.y;
          nd.bottom = nd.y + nd.h;
        });
        const bandH = g.gridRows * g.maxH + (g.gridRows - 1) * GRID_GAP_Y;
        // Route any dummies passing through this band down its centre line.
        row.forEach(function(id) {
          if (!L[id].dummy) { return; }
          L[id].y = y + bandH / 2;
        });
        y += bandH + RANK_GAP;
        return;
      }

      // Fits in one row: keep the median x, just assign y.
      let tall = 0;
      row.forEach(function(id) { if (L[id].h > tall) { tall = L[id].h; } });
      row.forEach(function(id) {
        const nd = L[id];
        nd.y = y + (tall - nd.h) / 2;
        nd.cx = nd.x + nd.w / 2;
        nd.cy = nd.y + nd.h / 2;
        nd.top = nd.y;
        nd.bottom = nd.y + nd.h;
      });
      y += tall + RANK_GAP;
    });
    const H = Math.max(y - RANK_GAP + CANVAS_PAD, 90);

    let minX = Infinity;
    let maxX = -Infinity;
    Object.keys(L).forEach(function(id) {
      if (L[id].x < minX) { minX = L[id].x; }
      if (L[id].x + L[id].w > maxX) { maxX = L[id].x + L[id].w; }
    });
    const shift = CANVAS_PAD - minX;
    Object.keys(L).forEach(function(id) {
      L[id].x += shift;
      L[id].cx = L[id].x + L[id].w / 2;
    });
    const W = Math.min(MAX_W_TOTAL, Math.max(240, Math.round(maxX - minX) + CANVAS_PAD * 2));

    // ── Edges ───────────────────────────────────────────────────────────────
    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

    function roundedRoute(points, radius) {
      if (!points || points.length < 2) { return ''; }
      const r = Math.max(2, radius || CORNER);
      let d = 'M ' + points[0].x + ' ' + points[0].y;
      for (let i = 1; i < points.length - 1; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const next = points[i + 1];
        const rr = Math.min(r, dist(prev, curr) / 2, dist(curr, next) / 2);
        const dx1 = prev.x === curr.x ? 0 : (prev.x < curr.x ? -1 : 1);
        const dy1 = prev.y === curr.y ? 0 : (prev.y < curr.y ? -1 : 1);
        const dx2 = next.x === curr.x ? 0 : (next.x < curr.x ? -1 : 1);
        const dy2 = next.y === curr.y ? 0 : (next.y < curr.y ? -1 : 1);
        d += ' L ' + (curr.x + dx1 * rr) + ' ' + (curr.y + dy1 * rr) +
          ' Q ' + curr.x + ' ' + curr.y + ' ' + (curr.x + dx2 * rr) + ' ' + (curr.y + dy2 * rr);
      }
      const last = points[points.length - 1];
      return d + ' L ' + last.x + ' ' + last.y;
    }

    // Spread sibling connections across the node edge so a wide fan-out does
    // not emit several perfectly coincident lines out of one centre point.
    function port(id, otherId, side) {
      const nd = L[id];
      if (nd.dummy) { return { x: nd.x, y: side === 'bottom' ? nd.y : nd.y }; }
      const list = (side === 'bottom' ? succs[id] : preds[id]);
      const span = Math.max(0, nd.w - 24);
      let index = list.indexOf(otherId);
      if (index < 0) { index = 0; }
      const offset = list.length > 1 ? (index / (list.length - 1) - 0.5) * span : 0;
      return { x: Math.round(nd.cx + offset), y: side === 'bottom' ? nd.bottom : nd.top };
    }

    const edgeSvg = [];
    const labelSvg = [];
    chains.forEach(function(chain) {
      const path = chain.path;
      const points = [];
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i];
        const b = path[i + 1];
        const from = L[a].dummy ? { x: L[a].x, y: L[a].y } : port(a, b, 'bottom');
        const to = L[b].dummy ? { x: L[b].x, y: L[b].y } : port(b, a, 'top');
        if (i === 0) { points.push(from); }
        if (Math.abs(from.x - to.x) >= 3) {
          const midY = Math.round((from.y + to.y) / 2);
          points.push({ x: from.x, y: midY });
          points.push({ x: to.x, y: midY });
        }
        points.push(to);
      }
      const cls = 'vr-flow-svg-edge' + (chain.edge && chain.edge.changed ? ' new-dep' : '');
      edgeSvg.push('<path class="' + cls + '" d="' + roundedRoute(points, CORNER) + '" fill="none" marker-end="url(#vrFlowArrow)"></path>');

      // Generic containment labels ("touches" on every fan-out edge) are pure
      // noise — the shape and nesting already say it. Keep only meaningful ones
      // such as decision-branch conditions.
      const rawLabel = chain.edge && chain.edge.label;
      const NOISE = { touches: 1, contains: 1, uses: 1, imports: 1 };
      const label = rawLabel && !NOISE[String(rawLabel).trim().toLowerCase()] ? rawLabel : '';
      if (label && path.length === 2) {
        const a = points[0];
        const b = points[points.length - 1];
        const text = truncate(String(label), 84, 5);
        const w = text.length * 5 + 8;
        const cx = Math.round((a.x + b.x) / 2);
        const cy = Math.round((a.y + b.y) / 2);
        labelSvg.push(
          '<rect class="vr-flow-svg-edge-label-bg" x="' + (cx - w / 2) + '" y="' + (cy - 7) + '" width="' + w + '" height="13" rx="2"></rect>' +
          '<text class="vr-flow-svg-edge-label" x="' + cx + '" y="' + (cy + 0.5) + '" text-anchor="middle" dominant-baseline="middle">' + escHtml(text) + '</text>');
      }
    });

    // ── Nodes ───────────────────────────────────────────────────────────────
    function stateClass(node) {
      if (node.highlighted || node.verdict === 'wrong' || (node.findingIds && node.findingIds.length)) { return ' fault'; }
      if (node.note === 'outside diff') { return ' ghost'; }
      if (node.changed) { return ' changed'; }
      return '';
    }

    function nodeAttrs(node, id, extra) {
      const fileList = (node.files || []).length ? node.files : (node.file ? [node.file] : []);
      // An effect node (db/llm/external) is clickable straight to the call site
      // that proved it, even though it isn't itself a changed file.
      const evidence = node.evidenceFile ? node.evidenceFile : '';
      const clickable = (node.changed && fileList.length) || !!evidence;
      let cls = 'vr-flow-svg-node' + stateClass(node);
      if (extra) { cls += ' ' + extra; }
      if (node.kind) { cls += ' kind-' + node.kind; }
      if (node.changed) { cls += ' changed'; }
      if (node.note === 'outside diff') { cls += ' ghost'; }
      if (clickable) { cls += ' clickable'; }
      let attrs = ' class="' + cls + '" data-node-id="' + escHtml(id) + '"';
      if (clickable) {
        attrs += ' role="button" tabindex="0"';
        attrs += ' data-file-path="' + escHtml(evidence || fileList[0]) + '"';
        if (evidence) {
          attrs += ' data-evidence-line="' + escHtml(String(node.evidenceLine || 1)) + '"';
        } else {
          attrs += ' data-file-list="' + escHtml(fileList.join(',')) + '"';
          attrs += ' data-additions="' + escHtml(String(node.additions || 0)) + '"';
          attrs += ' data-deletions="' + escHtml(String(node.deletions || 0)) + '"';
        }
        attrs += ' data-node-label="' + escHtml(node.label || id) + '"';
        attrs += ' aria-label="' + escHtml((node.label || id) + (evidence ? ' — ' + evidence + ':' + (node.evidenceLine || 1) : ': ' + fileList.join(', '))) + '"';
      }
      return attrs;
    }

    // Shape carries kind. This replaces the per-kind icon glyphs, which cost
    // 18px inside every node and had to fight the hover rules in CSS.
    function shapeFor(node, p) {
      const x = p.x;
      const y = p.y;
      const w = p.w;
      const h = p.h;
      switch (node.kind) {
        case 'entry':
        case 'terminal':
          return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + (h / 2) + '"></rect>';
        case 'decision':
          return '<polygon points="' + [
            p.cx + ',' + y,
            (x + w) + ',' + (y + h / 2),
            p.cx + ',' + (y + h),
            x + ',' + (y + h / 2),
          ].join(' ') + '"></polygon>';
        case 'io':
          return '<polygon points="' + [
            (x + 10) + ',' + y,
            (x + w) + ',' + y,
            (x + w - 10) + ',' + (y + h),
            x + ',' + (y + h),
          ].join(' ') + '"></polygon>';
        case 'llm':
        case 'external':
          // A hexagon reads as "external service". The db/llm/external accent is
          // carried by the kind-* CSS class, not the shape.
          return '<polygon points="' + [
            (x + 12) + ',' + y,
            (x + w - 12) + ',' + y,
            (x + w) + ',' + (y + h / 2),
            (x + w - 12) + ',' + (y + h),
            (x + 12) + ',' + (y + h),
            x + ',' + (y + h / 2),
          ].join(' ') + '"></polygon>';
        case 'database': {
          const ry = 7;
          return '<path d="M ' + x + ' ' + (y + ry) + ' C ' + x + ' ' + y + ', ' + (x + w) + ' ' + y + ', ' + (x + w) + ' ' + (y + ry) +
            ' L ' + (x + w) + ' ' + (y + h - ry) + ' C ' + (x + w) + ' ' + (y + h) + ', ' + x + ' ' + (y + h) + ', ' + x + ' ' + (y + h - ry) + ' Z"></path>' +
            '<ellipse cx="' + p.cx + '" cy="' + (y + ry) + '" rx="' + (w / 2) + '" ry="' + ry + '"></ellipse>';
        }
        case 'module':
          return '<rect class="dashed" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="3"></rect>';
        case 'function':
          return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="3"></rect>' +
            '<line x1="' + (x + 5) + '" y1="' + y + '" x2="' + (x + 5) + '" y2="' + (y + h) + '"></line>' +
            '<line x1="' + (x + w - 5) + '" y1="' + y + '" x2="' + (x + w - 5) + '" y2="' + (y + h) + '"></line>';
        default:
          return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="3"></rect>';
      }
    }

    const nodeSvg = nodes.map(function(node) {
      const p = L[node.id];
      if (!p) { return ''; }
      const sub = p.sub;
      const inset = (node.kind === 'decision' || node.kind === 'external' || node.kind === 'llm') ? 22 : 14;
      // Push the text clear of the cylinder's ellipse cap.
      const capOffset = node.kind === 'database' ? 7 : 0;
      const titleY = (sub ? p.y + LINE_H / 2 + 3 : p.cy) + capOffset;
      const title = escHtml(truncate(p.title, p.w - inset, TITLE_CHAR_W));
      return '<g' + nodeAttrs(node, node.id) + '>' +
        shapeFor(node, p) +
        '<text class="vr-flow-svg-label" x="' + p.cx + '" y="' + titleY + '" text-anchor="middle" dominant-baseline="middle">' + title + '</text>' +
        (sub
          ? '<text class="vr-flow-svg-sub" x="' + p.cx + '" y="' + (titleY + SUB_H + 2) + '" text-anchor="middle" dominant-baseline="middle">' + escHtml(sub) + '</text>'
          : '') +
      '</g>';
    }).join('');

    const laneSvg = laneMarks.map(function(mark) {
      return '<line class="vr-flow-lane-rule" x1="0" y1="' + (mark.y + LANE_H - 5) + '" x2="' + W + '" y2="' + (mark.y + LANE_H - 5) + '"></line>' +
        '<text class="vr-flow-lane-label" x="2" y="' + (mark.y + 5) + '" dominant-baseline="middle">' + escHtml(mark.title) + '</text>';
    }).join('');

    // Ranks wrap to the sidebar width, so the chart normally fits and simply
    // caps its own width (no scroll, no upscaling a small chart to fill the
    // pane). Only a genuinely un-wrappable width — a lone very wide node — falls
    // back to a fixed pixel width the container scrolls.
    const fit = !!(viewState && viewState.fit);
    const overflow = W > TARGET_W + 40;
    const sizeAttr = (overflow && !fit)
      ? ' width="' + W + '" height="' + H + '"'
      : ' style="width:100%;max-width:' + W + 'px"';
    return '<div class="vr-flow-canvas flowchart' + (fit ? ' fit' : '') + '">' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '"' + sizeAttr + ' preserveAspectRatio="xMidYMin meet" role="img" aria-label="Project architecture flowchart">' +
      '<defs><marker id="vrFlowArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">' +
      '<path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="#8b949e" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"></path></marker></defs>' +
      laneSvg + edgeSvg.join('') + labelSvg.join('') + nodeSvg +
      '</svg></div>';
  }

  function normalizeReviewMarkdown(markdown) {
    return String(markdown || '')
      .replace(/^```markdown\s*/i, '')
      .replace(/\s*```$/g, '')
      .split(/\r?\n/)
      .map(function(line) {
        const numbered = line.trim().match(/^([1-4])\.\s+(The Verdict \(Scope Validation\)|Architecture Impact \(Visual Flow\)|Security Analysis|Code Quality & Performance)\s*$/i);
        return numbered ? '### ' + numbered[1] + '. ' + numbered[2] : line;
      })
      .join('\n')
      .trim();
  }

  function hasStructuredTyneReport(markdown) {
    const text = String(markdown || '');
    if (!/##\s+.*Tyne Review/i.test(text)) { return false; }
    const requiredSections = [
      /###\s+1\.\s+The Verdict/i,
      /###\s+2\.\s+Architecture Impact/i,
      /###\s+3\.\s+Security Analysis/i,
      /###\s+4\.\s+Code Quality/i,
    ];
    return requiredSections.filter(function(pattern) { return pattern.test(text); }).length >= 3;
  }

  function markdownToReviewHtml(markdown) {
    const lines = String(markdown || '').split(/\r?\n/);
    let html = '';
    let paragraph = [];
    let list = [];
    let inCode = false;
    let codeLang = '';
    let codeLines = [];

    const flushParagraph = () => {
      if (!paragraph.length) { return; }
      html += '<p>' + inlineMarkdown(paragraph.join(' ')) + '</p>';
      paragraph = [];
    };
    const flushList = () => {
      if (!list.length) { return; }
      html += '<ul>' + list.map(item => '<li>' + inlineMarkdown(item) + '</li>').join('') + '</ul>';
      list = [];
    };
    const flushCode = () => {
      const langClass = codeLang ? ' language-' + escHtml(codeLang) : '';
      html += '<pre class="vr-md-code' + (codeLang === 'mermaid' ? ' mermaid' : '') + '"><code class="' + langClass.trim() + '">' + escHtml(codeLines.join('\n')) + '</code></pre>';
      codeLang = '';
      codeLines = [];
    };

    lines.forEach(function(line) {
      const fence = line.match(/^```(\w+)?\s*$/);
      if (fence) {
        if (inCode) {
          flushCode();
          inCode = false;
        } else {
          flushParagraph();
          flushList();
          inCode = true;
          codeLang = fence[1] || '';
          codeLines = [];
        }
        return;
      }
      if (inCode) {
        codeLines.push(line);
        return;
      }
      if (/^\s*---+\s*$/.test(line)) {
        flushParagraph();
        flushList();
        html += '<hr>';
        return;
      }
      const numbered = line.match(/^\s*([1-4])\.\s+(The Verdict \(Scope Validation\)|Architecture Impact \(Visual Flow\)|Security Analysis|Code Quality & Performance)\s*$/i);
      if (numbered) {
        flushParagraph();
        flushList();
        html += '<h3>' + inlineMarkdown(numbered[1] + '. ' + numbered[2]) + '</h3>';
        return;
      }
      const h = line.match(/^(#{2,4})\s+(.+)$/);
      if (h) {
        flushParagraph();
        flushList();
        const level = h[1].length;
        html += '<h' + level + '>' + inlineMarkdown(h[2]) + '</h' + level + '>';
        return;
      }
      const bullet = line.match(/^\s*[*-]\s+(.+)$/);
      if (bullet) {
        flushParagraph();
        list.push(bullet[1]);
        return;
      }
      if (!line.trim()) {
        flushParagraph();
        flushList();
        return;
      }
      paragraph.push(line.trim());
    });
    if (inCode) { flushCode(); }
    flushParagraph();
    flushList();
    return html;
  }

  function inlineMarkdown(text) {
    return escHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }

  function buildReviewMarkdownFallback(r) {
    const overall = deriveOverallVerdict(r);
    const failed = overall === 'block' || overall === 'changes_requested' || r.status === 'blocked' || r.status === 'needs_work';
    const statusText = overall === 'block' || r.status === 'blocked'
      ? 'Blocked'
      : r.status === 'context_limited'
        ? 'Context Limited'
        : failed
          ? 'Needs Work'
          : (overall === 'approve_with_suggestions' ? 'Approved · Suggestions' : 'Approved');
    const statusIcon = failed ? '!' : 'OK';
    const security = (r.findings || []).some(f => f.category === 'security') ? 'Warning' : 'Clean';
    const performance = (r.findings || []).some(f => f.category === 'performance') ? 'Warning' : 'Clean';
    const ticket = r.issueIdentifier || r.threadId || 'current task';
    const completed = (r.completedGoals || []).slice(0, 3).map(function(g) {
      const title = typeof g === 'string' ? g : g.title;
      return '* **Completed:** ' + (title || 'Reviewed implemented scope.');
    }).join('\n') || '* **Completed:** Reviewed the latest code changes.';
    const drift = (r.pendingGoals || []).slice(0, 3).map(function(g) {
      return '* **Drift Detected:** ' + (g.title || 'Follow-up required.') + (g.reason ? ' ' + g.reason : '');
    }).join('\n') || '* **Drift Detected:** No explicit scope drift was returned.';
    const action = (r.nextActions || [])[0]?.title || (r.pendingGoals || [])[0]?.suggestedAction || 'Review the findings below before merging.';
    const files = (r.visualDiff || []).slice(0, 6);
    const mermaidLines = ['graph TD', '    A[Changed Code] --> B{Review Result}'];
    files.forEach(function(f, index) {
      const node = 'F' + index;
      mermaidLines.push('    B --> ' + node + '[' + String(f.file || 'File').replace(/[\[\]]/g, '') + ']');
    });
    (r.pendingGoals || []).slice(0, 1).forEach(function() {
      mermaidLines.push('    B --> D((DRIFT: Scope follow-up))');
      mermaidLines.push('    style D fill:#ffcccc,stroke:#ff0000,stroke-width:2px');
    });
    const findings = (r.findings || []).slice(0, 5).map(function(f) {
      const loc = f.file ? f.file + (f.line ? ':' + f.line : '') + ' - ' : '';
      return '**' + capitalize(f.category || 'quality') + '**\n' + loc + (f.title || 'Review finding') + '\n' + (f.explanation || '') + (f.suggestedFix ? '\n\n```typescript\n' + f.suggestedFix + '\n```' : '');
    }).join('\n\n') || 'No high-priority code quality findings were returned.';
    const complianceDisclaimer = r.complianceDisclaimer ||
      'IMPORTANT LEGAL NOTICE: Tyne Validate & Review and any compliance-related output are automated, advisory suggestions only. They do not constitute a compliance certificate, attestation, audit opinion, legal advice, regulatory filing, warranty, or guarantee of any kind. Tyne does not certify that software, systems, processes, or organizations meet HIPAA, SOC 2, GDPR, PCI-DSS, ISO, NIST, FedRAMP, or any other legal, regulatory, industry, or contractual standard. Findings and scores are heuristic and may be incomplete, inaccurate, or out of date. Recipients remain solely responsible for independent professional review, formal certification by qualified auditors or counsel, and all compliance decisions. Use of this report does not create an attorney-client, auditor-client, or similar professional relationship with Tyne or its affiliates.';
    const complianceLines = (r.complianceAssessments || []).slice(0, 6).map(function(a) {
      const raw = String(a.status || '').toLowerCase().replace(/\s+/g, '_');
      const label = raw === 'blocked' || raw === 'failed' ? 'Blocked'
        : raw === 'review_required' || raw === 'needs_work' ? 'Review required'
        : raw === 'issues_detected' || raw === 'warning' ? 'Issues detected'
        : raw === 'no_violations' || raw === 'passed' ? 'No detected violations'
        : 'Not enabled';
      const coverage = (Array.isArray(a.coverage) ? a.coverage : []).map(function(c) {
        const pct = (!c || c.status === 'not_reviewed' || c.percent == null) ? 'Not Reviewed' : (Number(c.percent) + '%');
        return '  - ' + (c.label || c.id) + ': ' + pct;
      }).join('\n');
      return '* **' + (a.name || a.framework) + ' Assessment**\n  - Status: ' + label + '\n' +
        (coverage ? coverage + '\n' : '') +
        '  - Scope: ' + (a.scopeNote || 'Reviewed code changes only');
    }).join('\n') || '* No compliance assessment enabled for this review.';
    const regressionLines = (r.complianceRegressions || []).map(function(reg) {
      return '* **Compliance Regression Detected** — ' + (reg.message || reg.framework);
    }).join('\n');
    return [
      '## ' + statusIcon + ' Tyne Review: ' + statusText,
      '',
      '**Status:** ' + (failed ? 'Scope Drift Detected' : statusText) + ' | **Security:** ' + security + ' | **Performance:** ' + performance,
      '',
      '---',
      '',
      '### 1. The Verdict (Scope Validation)',
      '*Compared against ' + ticket + '*',
      '',
      r.summary || 'Review completed.',
      completed,
      drift,
      '* **Action Required:** ' + action,
      '',
      '---',
      '',
      '### 2. Architecture Impact (Visual Flow)',
      '*How your changes alter the application data flow:*',
      '',
      '```mermaid',
      mermaidLines.join('\n'),
      '```',
      '',
      '### 3. Security Analysis',
      'Analyzed against OWASP Top 10',
      security === 'Clean' ? 'No critical vulnerabilities found.' : 'Security-related findings need review before merge.',
      '',
      '### 4. Code Quality & Performance',
      findings,
      '',
      '### 5. Compliance Assessment',
      regressionLines ? regressionLines + '\n' : '',
      complianceLines,
      '',
      '>' + complianceDisclaimer,
    ].join('\n');
  }

  function getSelectedValidateReviewReport() {
    if (validateReview.selectedReportId) {
      const selected = validateReview.reports.find(function(report) { return report.id === validateReview.selectedReportId; });
      if (selected) { return selected; }
    }
    return validateReview.result || validateReview.reports[0] || null;
  }

  function ensureValidateReviewReportId(report, index) {
    if (!report) { return ''; }
    if (report.id) { return String(report.id); }
    // Prefer a real UUID so every generated report has a unique stable id.
    report.id = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : ('vr_' + Date.now().toString(36) + '_' + String(index || 0) + '_' + Math.random().toString(36).slice(2, 8));
    return report.id;
  }

  function shortValidateReportId(id) {
    const raw = String(id || '').replace(/^validate_review_/, '');
    if (!raw) { return ''; }
    const uuidPart = raw.split('-')[0];
    return (uuidPart || raw).slice(0, 8);
  }

  function validateReportTaskKey(report) {
    const key = String(report && (report.issueIdentifier || report.issueId || report.issue_identifier || report.issue_id) || '')
      .replace(/^(linear|jira|asana|notion|monday):/i, '')
      .trim();
    return key || 'No task';
  }

  function validateReportOptionLabel(report) {
    return [
      report.score !== undefined && report.score !== null ? (report.score + '/100') : '',
      report.status ? String(report.status).replace(/_/g, ' ') : '',
      report.createdAt ? fmtRelative(report.createdAt) : '',
      shortValidateReportId(report.id),
    ].filter(Boolean).join(' · ');
  }

  function currentValidateTaskKey() {
    const fromState = String(state.taskId || '').replace(/^(linear|jira|asana|notion|monday):/i, '').trim();
    const fromPm = String((state.pmTaskContext && (state.pmTaskContext.issueIdentifier || state.pmTaskContext.issueKey)) || '')
      .replace(/^(linear|jira|asana|notion|monday):/i, '')
      .trim();
    return fromPm || fromState || '';
  }

  function groupValidateReportsByTask(reports) {
    const groups = new Map();
    (reports || []).forEach(function(report, index) {
      ensureValidateReviewReportId(report, index);
      const key = validateReportTaskKey(report);
      if (!groups.has(key)) { groups.set(key, []); }
      groups.get(key).push(report);
    });
    groups.forEach(function(list) {
      list.sort(function(a, b) {
        return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
      });
    });
    const preferred = currentValidateTaskKey();
    return Array.from(groups.entries()).sort(function(a, b) {
      if (preferred) {
        if (a[0] === preferred) { return -1; }
        if (b[0] === preferred) { return 1; }
      }
      if (a[0] === 'No task') { return 1; }
      if (b[0] === 'No task') { return -1; }
      return a[0].localeCompare(b[0]);
    });
  }

  function openValidateReviewReport(reportId, viewMode) {
    if (!reportId) { return; }
    validateReview.selectedReportId = reportId;
    validateReview.result = getSelectedValidateReviewReport();
    validateReview.viewMode = viewMode || 'structured';
    renderValidateReview();
  }

  function reportRowTone(report) {
    const s = String((report && report.status) || '').toLowerCase();
    if (s === 'pass' || s === 'passed') { return 'ok'; }
    if (s === 'fail' || s === 'failed' || s === 'blocked') { return 'bad'; }
    return 'warn';
  }

  function reportRowStatusLabel(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'pass' || s === 'passed') { return 'Passed'; }
    if (s === 'fail' || s === 'failed') { return 'Failed'; }
    if (s === 'needs_work') { return 'Needs work'; }
    if (s === 'partial') { return 'Partial'; }
    return s ? capitalize(s.replace(/_/g, ' ')) : 'Review';
  }

  // Report groups: collapsible per task so long history stays scannable.
  // Current task (or first group) stays open; others start collapsed.
  function renderReportGroupCard(taskKey, title, rowsHtml, opts) {
    const open = opts && opts.open;
    const count = (opts && opts.count) || 0;
    const countLabel = count === 1 ? '1 review' : count + ' reviews';
    return '<details class="vr-task-card" data-task-key="' + escHtml(taskKey) + '"' + (open ? ' open' : '') + '>' +
      '<summary class="vr-task-card-head">' +
        '<span class="vr-task-chip">' + escHtml(taskKey) + '</span>' +
        (title ? '<span class="vr-task-card-title" title="' + escHtml(title) + '">' + escHtml(title) + '</span>' : '') +
        '<span class="vr-task-card-count">' + escHtml(countLabel) + '</span>' +
      '</summary>' +
      '<div class="vr-report-rows">' + rowsHtml + '</div>' +
    '</details>';
  }

  function isCurrentReviewTaskKey(taskKey) {
    const issueId = state.pmTaskContext && state.pmTaskContext.issueIdentifier;
    const cur = String(state.taskId || issueId || '').trim();
    if (!cur || !taskKey) { return false; }
    const a = cur.toLowerCase();
    const b = String(taskKey).toLowerCase();
    return a === b || a.endsWith(':' + b) || b.endsWith(':' + a) || a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
  }

  function renderValidateReviewReports() {
    const listEl = $('validateReviewReportList');
    const emptyEl = $('validateReviewHistoryEmpty');
    if (!listEl) { return; }
    const reports = (validateReview.reports || []).slice();
    reports.forEach(ensureValidateReviewReportId);
    if (emptyEl) { emptyEl.classList.toggle('hidden', reports.length > 0); }
    if (!reports.length) {
      listEl.innerHTML = '';
      return;
    }

    const groups = groupValidateReportsByTask(reports);
    let openIdx = groups.findIndex(function(entry) { return isCurrentReviewTaskKey(entry[0]); });
    if (openIdx < 0) { openIdx = 0; }
    listEl.innerHTML = groups.map(function(entry, idx) {
      const taskKey = entry[0];
      const taskReports = entry[1];
      const rows = taskReports.map(function(report) {
        const tone = reportRowTone(report);
        const score = normalizeReviewScore(report.score);
        const when = report.createdAt ? fmtRelative(report.createdAt) : '';
        return '<button type="button" class="vr-report-row" data-report-id="' + escHtml(report.id) + '"' +
          ' aria-label="' + escHtml(validateReportOptionLabel(report)) + '">' +
          '<span class="vr-rrow-dot ' + tone + '" aria-hidden="true"></span>' +
          '<span class="vr-rrow-score">' + score + '</span>' +
          '<span class="vr-rrow-verdict">' + escHtml(reportRowStatusLabel(report.status)) + '</span>' +
          '<span class="vr-rrow-when">' + escHtml(when) + '</span>' +
          '<span class="vr-rrow-chev" aria-hidden="true">&#8250;</span>' +
        '</button>';
      }).join('');
      return renderReportGroupCard(taskKey, taskReports[0].issueTitle || '', rows, {
        open: idx === openIdx,
        count: taskReports.length,
      });
    }).join('');

    listEl.querySelectorAll('.vr-report-row').forEach(function(row) {
      row.addEventListener('click', function() {
        openValidateReviewReport(row.getAttribute('data-report-id'));
      });
    });
  }

  function renderValidationHistory() {
    const list = $('valHistory');
    const empty = $('valHistoryEmpty');
    const viewAll = $('valHistoryViewAll');
    const countEl = $('pastReviewsCount');
    if (!list) { return; }
    const visible = getFilteredSortedHistory();
    const total = visible.length;
    if (countEl) { countEl.textContent = total ? String(total) : ''; }
    if (empty) { empty.classList.toggle('hidden', total > 0); }
    const preview = visible.slice(0, 3);
    list.innerHTML = preview.length === 0
      ? ''
      : preview.map(function(h) {
        const statusRaw = String(h.status || '').toLowerCase();
        const statusLabel = statusRaw === 'pass' ? 'Passed' : statusRaw === 'fail' ? 'Failed' : statusRaw === 'partial' ? 'Partial' : (h.status || '—');
        const statusCls = statusRaw === 'pass' ? 'ok' : statusRaw === 'fail' ? 'bad' : 'mute';
        const when = h.createdAt ? fmtRelative(h.createdAt) : '—';
        const mid = typeof h.matchPercent === 'number'
          ? (h.matchPercent + '% match')
          : (h.taskId ? String(h.taskId).replace(/^(linear|jira):/i, '') : 'review');
        return '<div class="thread-past-row">' +
          '<span class="thread-past-when">' + escHtml(when) + '</span>' +
          '<span class="thread-past-mid">' + escHtml(mid) + '</span>' +
          '<span class="thread-past-status ' + statusCls + '">' + escHtml(statusLabel) + '</span>' +
        '</div>';
      }).join('');
    if (viewAll) {
      viewAll.classList.toggle('hidden', total <= 3);
      viewAll.textContent = total > 3 ? ('View all ' + total + ' reviews') : 'View all reviews';
    }
  }

  function getFilteredSortedHistory() {
    let list = validationHistory.slice();
    const search = ($('valHistorySearch')?.value || '').toLowerCase().trim();
    const filter = $('valHistoryFilter')?.value || '';
    const sort = $('valHistorySort')?.value || 'newest';
    if (search) {
      list = list.filter(h => JSON.stringify(h).toLowerCase().includes(search));
    }
    if (filter) {
      const now = new Date();
      list = list.filter(h => {
        if (filter === 'today') { return isSameDay(new Date(h.createdAt), now); }
        if (filter === 'this_week') { return isThisWeek(new Date(h.createdAt)); }
        if (filter === 'this_month') { return isSameMonth(new Date(h.createdAt), now); }
        if (filter === 'last_30_days') { return (now.getTime() - new Date(h.createdAt).getTime()) <= 30 * 24 * 60 * 60 * 1000; }
        if (['pass', 'partial', 'fail'].includes(filter)) { return h.status === filter; }
        if (['low', 'medium', 'high'].includes(filter)) { return h.riskLevel === filter; }
        if (['anthropic', 'openai', 'managed'].includes(filter)) { return h.provider === filter; }
        return true;
      });
    }
    list.sort((a, b) => {
      if (sort === 'newest') { return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(); }
      if (sort === 'oldest') { return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(); }
      if (sort === 'status') { return a.status.localeCompare(b.status); }
      if (sort === 'risk') { return (a.riskLevel || '').localeCompare(b.riskLevel || ''); }
      if (sort === 'match') { return (b.matchPercent || 0) - (a.matchPercent || 0); }
      if (sort === 'task') { return (a.taskId || '').localeCompare(b.taskId || ''); }
      if (sort === 'branch') { return (a.branchName || '').localeCompare(b.branchName || ''); }
      return 0;
    });
    return list;
  }

  function isSameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function isSameMonth(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth(); }
  function isThisWeek(d) { const now = new Date(); const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()); return d >= start; }

  function collectHistoryFilters() {
    const filter = $('valHistoryFilter')?.value || '';
    const search = ($('valHistorySearch')?.value || '').trim();
    const filters = { query: search };
    const now = new Date();
    if (filter === 'today') { filters.dateRange = { start: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(), end: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59).toISOString() }; }
    if (filter === 'this_week') { const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay()); filters.dateRange = { start: start.toISOString(), end: now.toISOString() }; }
    if (filter === 'this_month') { filters.dateRange = { start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), end: now.toISOString() }; }
    if (filter === 'last_30_days') { filters.dateRange = { start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(), end: now.toISOString() }; }
    if (['pass', 'partial', 'fail'].includes(filter)) { filters.statuses = [filter]; }
    if (['low', 'medium', 'high'].includes(filter)) { filters.riskLevels = [filter]; }
    if (['anthropic', 'openai', 'managed'].includes(filter)) { filters.providers = [filter]; }
    return filters;
  }

  function requestValidationHistory() { vscode.postMessage({ type: 'getValidationHistory' }); }
  function requestValidationTrends() { vscode.postMessage({ type: 'getValidationTrends' }); }

  function renderPrepStarted() {
    const panel = $('prepPanel'); if (!panel) { return; }
    panel.classList.remove('hidden');
    const lines = $('prepLines'); if (lines) { lines.textContent = 'Checking workspace… Preparing pull…'; }
  }
  function renderPrepComplete(msg) {
    const panel = $('prepPanel'); if (!panel) { return; }
    panel.classList.remove('hidden');
    const lines = $('prepLines');
    if (!lines) { return; }
    if (msg.error) { lines.textContent = 'Prep failed: ' + (msg.error || 'Unknown error'); return; }
    const parts = [
      msg.stashed ? 'Stashed' : 'No stash needed',
      msg.pullSummary || 'No remote',
      msg.clean ? 'Workspace clean' : 'Workspace not clean'
    ];
    lines.textContent = parts.join(' · ');
  }

  function renderDrift(e) {
    activeDriftFile = e.file || '';
    const panel = $('driftPanel'); if (!panel) { return; }
    panel.classList.toggle('hidden', !activeDriftFile);
    const fileEl = $('driftFile'); if (fileEl) { fileEl.textContent = activeDriftFile || ''; }
    const noteEl = $('driftNote'); if (noteEl) { noteEl.textContent = 'Severity: ' + (e.severity || 'medium'); }
  }
  function clearDrift(file) {
    if (!file || file === activeDriftFile) { activeDriftFile = ''; const p = $('driftPanel'); if (p) { p.classList.add('hidden'); } }
  }

  function renderParked(ideas) {
    const safe = Array.isArray(ideas) ? ideas : [];
    const panel = $('parkedPanel'); if (!panel) { return; }
    panel.classList.toggle('hidden', safe.length === 0);
    const titleBtn = $('parkedTitle');
    if (titleBtn) {
      titleBtn.innerHTML = '<span class="toggle-arrow">&#9658;</span> Parked ideas <span class="toggle-count" data-target="parkedBody">(' + safe.length + ')</span>';
    }
    const list = $('parkedList'); if (!list) { return; }
    list.innerHTML = '';
    safe.forEach(idea => {
      const row = document.createElement('div');
      row.className = 'subtask';
      row.innerHTML = '<span class="txt">' + escHtml(idea) + '</span>';
      list.appendChild(row);
    });
  }

  function renderTasks(tasks) {
    const incoming = Array.isArray(tasks) ? tasks.filter(t => t && t.id && t.title).slice(0, 8) : [];
    tasksCache = incoming.length ? incoming : fallbackTasks;
    // standupTaskList is no longer in the sidebar; this function is a no-op for rendering
  }

  function renderBranches() {
    const current = branchData.currentBranchRecord;
    const currentSummary = current ? commitData.summaries[current.branchName] : null;
    const currentCard = $('currentBranchCard');
    if (!current) {
      currentCard.innerHTML = '<div class="empty">No linked Tyne branch is active.</div>';
    } else {
      currentCard.innerHTML =
        '<div class="int-head"><span class="lt branch">' + escHtml(current.branchName) + '</span>' +
        '<span class="conn-badge"><span class="dot"></span>Current</span>' +
        '</div>' +
        '<div class="lm plain">' + escHtml(current.taskId) + ' · ' + escHtml(current.taskTitle) + '</div>' +
        '<div class="tags">' +
        '<span class="tag">Commits ' + escHtml(String(current.commitCount || 0)) + '</span>' +
        '<span class="tag">Sessions ' + escHtml(String(currentSummary?.totalSessions || 0)) + '</span>' +
        '</div>' +
        '<div class="btn-row">' +
        '<button class="btn primary" data-branch-action="switch" data-branch-name="' + escHtml(current.branchName) + '">Switch</button>' +
        (current.taskUrl ? '<button class="btn" data-task-url="' + escHtml(current.taskUrl) + '">Open task</button>' : '') +
        '</div>';
    }

    const history = $('branchHistoryList');
    history.innerHTML = '';
    if (!(branchData.branches || []).length) {
      history.innerHTML = '<div class="empty">No Tyne-managed branches yet.</div>';
    } else {
      branchData.branches.forEach(branch => {
        const row = document.createElement('div');
        row.className = 'list-item';
        row.innerHTML =
          '<div class="int-head"><span class="lt">' + escHtml(branch.branchName) + '</span>' +
          (branch.isCurrent ? '<span class="conn-badge"><span class="dot"></span>Current</span>' : '') +
          '</div>' +
          '<div class="lm plain">' + escHtml(branch.taskId) + ' · ' + escHtml(branch.taskTitle) + '</div>' +
          '<div class="tags">' +
          '<span class="tag">Last active ' + escHtml(new Date(branch.lastCheckedOutAt).toLocaleDateString()) + '</span>' +
          '<span class="tag">Commits ' + escHtml(String(branch.commitCount || 0)) + '</span>' +
          '<span class="tag">Sessions ' + escHtml(String((commitData.summaries[branch.branchName] || {}).totalSessions || 0)) + '</span>' +
          '</div>' +
          '<div class="btn-row">' +
          '<button class="btn primary" data-branch-action="switch" data-branch-name="' + escHtml(branch.branchName) + '">Switch</button>' +
          '<button class="btn" data-branch-action="copy" data-branch-name="' + escHtml(branch.branchName) + '">Copy</button>' +
          '<button class="btn danger" data-branch-action="delete" data-branch-name="' + escHtml(branch.branchName) + '">Delete</button>' +
          '</div>';
        history.appendChild(row);
      });
    }
    updateToggleCount('branchHistoryBody', (branchData.branches || []).length);
  }

  function renderCommitSummaryCard() {
    const summaryCard = $('taskCommitSummaryCard');
    const commits = commitData.taskCommits.length ? commitData.taskCommits : commitData.currentBranchCommits;
    const sessions = commitData.taskSessions.length ? commitData.taskSessions : commitData.currentBranchSessions;
    const latest = commits[0];
    if (!commits.length) {
      summaryCard.innerHTML = '<div class="empty">No linked commit history yet.</div>';
      return;
    }
    summaryCard.innerHTML =
      '<div class="row"><div class="k">Linked Branch</div><div class="v branch">' + escHtml(branchData.selectedTaskBranch?.branchName || commitData.currentBranchName || '—') + '</div></div>' +
      '<div class="row"><div class="k">Total Commits</div><div class="v">' + escHtml(String(commits.length)) + '</div></div>' +
      '<div class="row"><div class="k">Sessions</div><div class="v">' + escHtml(String(sessions.length)) + '</div></div>' +
      '<div class="row"><div class="k">Time Estimate</div><div class="v">' + escHtml(fmtMinutes(sessions.reduce((sum, session) => sum + (session.durationMinutes || 0), 0))) + '</div></div>' +
      '<div class="row"><div class="k">Latest Commit</div><div class="v">' + escHtml(latest.message || latest.shortHash) + '</div></div>' +
      '<div class="row"><div class="k">Last Activity</div><div class="v">' + escHtml(fmtRelative(latest.committedAt)) + '</div></div>';
  }

  function renderCommitLists() {
    const taskList = $('taskCommitList');
    const commits = commitData.taskCommits.length ? commitData.taskCommits : commitData.currentBranchCommits;
    taskList.innerHTML = '';
    const countEl = $('commitActivityCount');
    if (countEl) { countEl.textContent = commits.length ? String(commits.length) : ''; }
    if (!commits.length) {
      taskList.innerHTML = '<div class="empty">No commits linked to this task yet.</div>';
    } else {
      commits.slice(0, 5).forEach(commit => {
        const row = document.createElement('div');
        row.className = 'thread-commit-row commit-item';
        row.dataset.commitHash = commit.commitHash;
        row.innerHTML =
          '<div class="thread-commit-msg">' + escHtml(commit.message) + '</div>' +
          '<div class="thread-commit-meta">' + escHtml(commit.shortHash) + ' · ' + escHtml(fmtRelative(commit.committedAt)) + '</div>';
        row.addEventListener('click', (e) => {
          if (e.target.closest('.commit-detail-inline')) return;
          selectedCommitHash = commit.commitHash;
          renderCommitLists();
          showAppView('commits');
        });
        taskList.appendChild(row);
      });
    }

    $('commitOverviewValue').textContent = String(commitData.currentBranchCommits.length || 0);
    $('commitSessionCount').textContent = String(commitData.currentBranchSessions.length || 0);
    $('commitDurationTotal').textContent = fmtMinutes(commitData.currentBranchSessions.reduce((sum, session) => sum + (session.durationMinutes || 0), 0));
    $('commitLastActivity').textContent = commitData.currentBranchCommits[0] ? fmtRelative(commitData.currentBranchCommits[0].committedAt) : '—';

    const sessionList = $('sessionList');
    sessionList.innerHTML = '';
    if (!commitData.currentBranchSessions.length) {
      sessionList.innerHTML = '<div class="empty">No commit sessions found for this Tyne branch yet.</div>';
    } else {
      commitData.currentBranchSessions.forEach((session, index) => {
        const commits = commitData.currentBranchCommits.filter(commit => session.commitHashes.includes(commit.commitHash));
        const row = document.createElement('div');
        row.className = 'list-item';
        row.innerHTML =
          '<div class="lt">Session ' + escHtml(String(index + 1)) + '</div>' +
          '<div class="lm plain">' + escHtml(session.taskId || 'Unlinked') + ' · ' + escHtml(session.taskTitle || 'No linked task') + '</div>' +
          '<div class="tags"><span class="tag">' + escHtml(fmtMinutes(session.durationMinutes)) + '</span><span class="tag">' + escHtml(String(session.commitCount)) + ' commits</span><span class="tag">' + escHtml(String(session.totalFilesChanged)) + ' files</span><span class="tag">+' + escHtml(String(session.totalLinesAdded)) + ' / -' + escHtml(String(session.totalLinesDeleted)) + '</span></div>' +
          '<div class="commit-files">' + commits.map((commit, commitIndex) => '<button class="session-commit" data-commit-hash="' + escHtml(commit.commitHash) + '">#' + escHtml(String(commitIndex + 1)) + ' ' + escHtml(commit.shortHash) + ' · ' + escHtml(commit.message) + '</button>').join('') + '</div>';
        sessionList.appendChild(row);
      });
    }

    const commitList = $('commitList');
    commitList.innerHTML = '';
    if (!commitData.currentBranchCommits.length) {
      commitList.innerHTML = '<div class="empty">No commits found.</div>';
    } else {
      commitData.currentBranchCommits.forEach(commit => {
        const row = document.createElement('div');
        row.className = 'list-item commit-item';
        row.dataset.commitHash = commit.commitHash;
        row.innerHTML =
          '<div class="int-head"><span class="lt mono">' + escHtml(commit.shortHash) + '</span><span class="tag">' + escHtml(fmtRelative(commit.committedAt)) + '</span></div>' +
          '<div class="lm plain">' + escHtml(commit.message) + '</div>' +
          '<div class="tags"><span class="tag">' + escHtml(String(commit.totalFilesChanged)) + ' files</span><span class="tag">+' + escHtml(String(commit.totalLinesAdded)) + '</span><span class="tag">-' + escHtml(String(commit.totalLinesDeleted)) + '</span>' +
          (commit.linkedStatus
            ? '<span class="tag-outline ' + (String(commit.linkedStatus).toLowerCase() === 'linked' ? 'good' : 'soon') + '">' + escHtml(String(commit.linkedStatus).toUpperCase()) + '</span>'
            : '') +
          '</div>';
        row.addEventListener('click', (e) => {
          if (e.target.closest('.commit-detail-inline')) return;
          selectedCommitHash = commit.commitHash;
          renderCommitLists();
        });
        if (commit.commitHash === selectedCommitHash) { row.classList.add('active'); }
        commitList.appendChild(row);
      });
    }
    renderCommitDetails();
    renderVelocityChart();
    updateToggleCount('sessionBody', commitData.currentBranchSessions.length || 0);
    updateToggleCount('commitBody', commitData.currentBranchCommits.length || 0);
  }

  function renderVelocityChart() {
    const metricsEl = $('velocityMetrics');
    const heatEl = $('velocityHeat');
    const foot = $('velocityFoot');
    if (!metricsEl || !heatEl) return;

    const commits = commitData.currentBranchCommits || [];
    const sessions = commitData.currentBranchSessions || [];
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    function dayKey(d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    function parseCommitDay(c) {
      const t = new Date(c.committedAt);
      if (isNaN(t.getTime())) return null;
      return new Date(t.getFullYear(), t.getMonth(), t.getDate());
    }

    // Build day map for all commits (for streaks / all-range heat)
    const byDay = Object.create(null);
    const hourCounts = new Array(24).fill(0);
    commits.forEach(function(c) {
      const day = parseCommitDay(c);
      if (!day) return;
      const k = dayKey(day);
      if (!byDay[k]) { byDay[k] = { commits: 0, lines: 0, date: day }; }
      byDay[k].commits += 1;
      byDay[k].lines += (c.totalLinesAdded || 0) + (c.totalLinesDeleted || 0);
      const ht = new Date(c.committedAt);
      if (!isNaN(ht.getTime())) { hourCounts[ht.getHours()] += 1; }
    });

    const rangeDays = velocityRangeDays; // 0 = all
    let windowStart = null;
    if (rangeDays > 0) {
      windowStart = new Date(today);
      windowStart.setDate(today.getDate() - (rangeDays - 1));
    } else {
      const keys = Object.keys(byDay);
      if (keys.length) {
        let min = today.getTime();
        keys.forEach(function(k) { min = Math.min(min, byDay[k].date.getTime()); });
        windowStart = new Date(min);
        // Align to week start (Sunday) for heatmap columns
        windowStart.setDate(windowStart.getDate() - windowStart.getDay());
      } else {
        windowStart = new Date(today);
        windowStart.setDate(today.getDate() - 13);
      }
    }

    // Cap heatmap span so the narrow sidebar stays usable (~13 weeks)
    const maxHeatDays = 13 * 7;
    let heatStart = new Date(windowStart);
    if (rangeDays === 0) {
      const span = Math.round((today.getTime() - heatStart.getTime()) / 86400000) + 1;
      if (span > maxHeatDays) {
        heatStart = new Date(today);
        heatStart.setDate(today.getDate() - (maxHeatDays - 1));
        heatStart.setDate(heatStart.getDate() - heatStart.getDay());
      }
    } else if (rangeDays <= 14) {
      // Align heat start to week for tidy columns when short ranges
      heatStart = new Date(windowStart);
      heatStart.setDate(heatStart.getDate() - heatStart.getDay());
    }

    const buckets = [];
    for (let d = new Date(heatStart); d.getTime() <= today.getTime(); d.setDate(d.getDate() + 1)) {
      const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const k = dayKey(copy);
      const hit = byDay[k];
      buckets.push({
        date: copy,
        commits: hit ? hit.commits : 0,
        lines: hit ? hit.lines : 0,
        inRange: !windowStart || copy.getTime() >= windowStart.getTime(),
      });
    }

    const inRangeBuckets = buckets.filter(function(b) { return b.inRange; });
    const key = velocityMetric === 'lines' ? 'lines' : 'commits';
    const values = inRangeBuckets.map(function(b) { return b[key]; });
    const totalCommits = inRangeBuckets.reduce(function(s, b) { return s + b.commits; }, 0);
    const totalLines = inRangeBuckets.reduce(function(s, b) { return s + b.lines; }, 0);
    const activeDays = inRangeBuckets.filter(function(b) { return b.commits > 0; }).length;
    const peak = values.length ? Math.max.apply(null, values) : 0;

    // Streaks (calendar days with >=1 commit), computed on full byDay ending today
    function streakEndingAt(endDate) {
      let n = 0;
      const cursor = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
      while (true) {
        const hit = byDay[dayKey(cursor)];
        if (!hit || hit.commits <= 0) break;
        n += 1;
        cursor.setDate(cursor.getDate() - 1);
      }
      return n;
    }
    const currentStreak = streakEndingAt(today);
    let longestStreak = 0;
    Object.keys(byDay).forEach(function(k) {
      longestStreak = Math.max(longestStreak, streakEndingAt(byDay[k].date));
    });

    let peakHour = -1;
    let peakHourCount = 0;
    hourCounts.forEach(function(n, h) {
      if (n > peakHourCount) { peakHourCount = n; peakHour = h; }
    });
    function fmtHour(h) {
      if (h < 0) return '—';
      const suffix = h >= 12 ? 'PM' : 'AM';
      const hr = ((h + 11) % 12) + 1;
      return hr + ' ' + suffix;
    }

    const rangeLabel = rangeDays === 0 ? 'All time' : ('Last ' + rangeDays + ' days');
    const metricCards = [
      { k: 'Commits', v: String(totalCommits) },
      { k: 'Lines changed', v: totalLines.toLocaleString() },
      { k: 'Active days', v: String(activeDays) },
      { k: 'Sessions', v: String(sessions.length || 0) },
      { k: 'Current streak', v: currentStreak + 'd' },
      { k: 'Longest streak', v: longestStreak + 'd' },
      { k: 'Peak / day', v: String(peak) + (key === 'lines' ? ' ln' : '') },
      { k: 'Peak hour', v: fmtHour(peakHour) },
    ];
    metricsEl.innerHTML = metricCards.map(function(m) {
      return '<div class="cv-metric"><div class="k">' + escHtml(m.k) + '</div><div class="v">' + escHtml(m.v) + '</div></div>';
    }).join('');

    const heatValues = buckets.map(function(b) { return b[key]; });
    const maxVal = Math.max(1, peak, heatValues.length ? Math.max.apply(null, heatValues) : 0);
    heatEl.innerHTML = buckets.map(function(b) {
      const val = b[key];
      let lvl = 0;
      if (val > 0) {
        const r = val / maxVal;
        if (r <= 0.25) lvl = 1;
        else if (r <= 0.5) lvl = 2;
        else if (r <= 0.75) lvl = 3;
        else lvl = 4;
      }
      const label = b.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const detail = key === 'lines'
        ? (b.lines + ' lines')
        : (b.commits + (b.commits === 1 ? ' commit' : ' commits'));
      return '<div class="cv-cell' + (lvl ? ' l' + lvl : '') + '" title="' + escHtml(label + ' — ' + detail) + '"></div>';
    }).join('');

    if (!commits.length) {
      foot.textContent = 'No commits yet — velocity appears as you stitch on this branch.';
    } else {
      const avg = activeDays ? (totalCommits / activeDays) : 0;
      foot.textContent = rangeLabel + ' · ' + activeDays + ' active day' + (activeDays === 1 ? '' : 's')
        + ' · ~' + (Math.round(avg * 10) / 10) + ' commits/active day';
    }
  }

  function renderCommitDetails() {
    document.querySelectorAll('.commit-detail-inline').forEach(el => el.remove());
    const commit = commitData.currentBranchCommits.find(item => item.commitHash === selectedCommitHash) || commitData.taskCommits.find(item => item.commitHash === selectedCommitHash);
    if (!commit) return;
    const row = document.querySelector('#commitList .commit-item[data-commit-hash="' + selectedCommitHash + '"], #taskCommitList .commit-item[data-commit-hash="' + selectedCommitHash + '"]');
    if (!row) return;
    document.querySelectorAll('#commitList .commit-item, #taskCommitList .commit-item').forEach(el => el.classList.remove('active'));
    row.classList.add('active');
    const commitBody = $('commitBody');
    const commitArrow = document.querySelector('.section-toggle[data-target="commitBody"] .toggle-arrow');
    if (commitBody && commitBody.classList.contains('hidden')) {
      commitBody.classList.remove('hidden');
      if (commitArrow) commitArrow.textContent = '\u25BC';
    }
    const detail = document.createElement('div');
    detail.className = 'commit-detail-inline';
    detail.innerHTML =
      '<div class="row"><div class="k">Commit</div><div class="v branch">' + escHtml(commit.commitHash) + '</div></div>' +
      '<div class="row"><div class="k">Message</div><div class="v">' + escHtml(commit.message) + '</div></div>' +
      '<div class="row"><div class="k">Author</div><div class="v">' + escHtml(commit.authorName) + (commit.authorEmail ? ' &lt;' + escHtml(commit.authorEmail) + '&gt;' : '') + '</div></div>' +
      '<div class="row"><div class="k">Timestamp</div><div class="v">' + escHtml(new Date(commit.committedAt).toLocaleString()) + ' · ' + escHtml(fmtRelative(commit.committedAt)) + '</div></div>' +
      '<div class="row"><div class="k">Linked Task</div><div class="v">' + escHtml(commit.taskId || 'Unlinked') + (commit.taskTitle ? ' · ' + escHtml(commit.taskTitle) : '') + '</div></div>' +
      '<div class="row"><div class="k">Branch</div><div class="v branch">' + escHtml(commit.branchName) + '</div></div>' +
      '<div class="row"><div class="k">Files</div><div class="v">' + escHtml(String(commit.totalFilesChanged)) + ' changed · +' + escHtml(String(commit.totalLinesAdded)) + ' / -' + escHtml(String(commit.totalLinesDeleted)) + '</div></div>' +
      '<div class="btn-row"><button class="btn compact" data-commit-action="copy-hash" data-commit-hash="' + escHtml(commit.commitHash) + '">Copy hash</button><button class="btn compact" data-commit-action="copy-message" data-message="' + escHtml(commit.message) + '">Copy message</button><button class="btn compact" data-commit-action="open-graph" data-commit-hash="' + escHtml(commit.commitHash) + '">Git graph</button></div>' +
      '<div class="commit-files">' + (commit.filesChanged.length
        ? commit.filesChanged.map(file => '<button class="file-row" data-file-path="' + escHtml(file.filePath) + '"><span>' + escHtml(file.filePath) + '</span><span>' + escHtml(file.changeType) + ' · +' + escHtml(String(file.linesAdded)) + ' / -' + escHtml(String(file.linesDeleted)) + '</span></button>').join('')
        : '<div class="empty">No file metadata was available for this commit.</div>') +
      '</div>';
    row.appendChild(detail);
  }

  function showPRCreated(pr) {
    $('prSummary').textContent = 'PR #' + pr.number + ' created';
    $('prLink').dataset.url = pr.url;
    $('prPanel').classList.remove('hidden');
    if (prPanelTimer) clearTimeout(prPanelTimer);
    prPanelTimer = setTimeout(() => { $('prPanel').classList.add('hidden'); $('prLink').dataset.url = ''; }, 8000);
  }
  function showShipComplete(msg) {
    $('prSummary').textContent = msg.pushed ? ('Branch ' + (msg.branch || '') + ' pushed') : 'Committed locally';
    $('prPanel').classList.remove('hidden');
  }

  function renderSettings(s) {
    projectLeadMode = Boolean(s.projectLeadMode);
    aiSettings = {
      aiAccessMode: s.aiAccessMode || aiSettings.aiAccessMode || 'max',
      aiProvider: s.aiProvider || aiSettings.aiProvider || 'claude',
      hasBYOKKey: s.hasBYOKKey !== undefined ? Boolean(s.hasBYOKKey) : aiSettings.hasBYOKKey,
      byokConfig: s.byokConfig || aiSettings.byokConfig,
      aiUsageUsed: Number(s.aiUsageUsed || aiSettings.aiUsageUsed || 0),
      aiUsageLimit: Number(s.aiUsageLimit || aiSettings.aiUsageLimit || 50),
      validationUsage: s.validationUsage || aiSettings.validationUsage,
      validationUsageText: s.validationUsageText || aiSettings.validationUsageText,
      validationResult: s.validationResult || aiSettings.validationResult,
    };
    userTier = s.userTier || 'UNKNOWN';
    userCredits = s.userCredits || 0;
    // #region agent log
    const _beforePm = { tools: (_tasksConnectedTools || []).slice(), jira: Boolean(jiraIntegration.connected), pmJira: Boolean((pmIntegration.jira || {}).connected), pmLinear: Boolean((pmIntegration.linear || {}).connected) };
    // #endregion
    jiraIntegration = s.jiraIntegration || jiraIntegration;
    pmIntegration = s.pmIntegration || pmIntegration;
    if (s.jiraIntegration || s.pmIntegration || Array.isArray(s.connectedTools)) {
      syncConnectedToolsFromPayload(s);
    }
    // #region agent log
    agentDebugLog('B', 'tyne.js:renderSettings', 'renderSettings overwrite of integration state', {
      before: _beforePm,
      after: {
        tools: (_tasksConnectedTools || []).slice(),
        jira: Boolean(jiraIntegration.connected),
        pmJira: Boolean((pmIntegration.jira || {}).connected),
        pmLinear: Boolean((pmIntegration.linear || {}).connected),
      },
      incoming: {
        hasJira: Boolean(s.jiraIntegration),
        hasPm: Boolean(s.pmIntegration),
        incomingTools: s.connectedTools || null,
        incomingJira: Boolean((s.jiraIntegration || {}).connected),
        incomingPmJira: Boolean(((s.pmIntegration || {}).jira || {}).connected),
        incomingPmLinear: Boolean(((s.pmIntegration || {}).linear || {}).connected),
      },
    });
    // #endregion
    if (s.validationUsage) {
      applyValidationUsageCounts(s.validationUsage);
    } else if (userTier === 'MAX' || userTier === 'max') {
      valCountRemaining = 'unlimited';
      valCountTotal = 'unlimited';
    }

    const tg = document.querySelector('[data-toggle="projectLead"]');
    if (tg) { tg.classList.toggle('active', projectLeadMode); tg.setAttribute('aria-pressed', String(projectLeadMode)); }

    hydrateAccount(s.githubUsername);
    applyTierConfig();
    renderIntegrations();
    renderValidationCounter();

    const provider = aiSettings.byokConfig?.ai?.provider || aiSettings.aiProvider;
    document.querySelectorAll('#coreProviderSeg [data-provider], #premiumProviderSeg [data-provider]').forEach(b => b.classList.toggle('active', b.dataset.provider === (provider === 'anthropic' ? 'claude' : 'openai')));
    const masked = aiSettings.byokConfig?.ai?.maskedKey;
    const byokStatus = $('byokStatus');
    if (byokStatus) { byokStatus.textContent = aiSettings.hasBYOKKey ? (masked ? 'Saved: ' + masked : 'Key saved.') : 'No key saved.'; }
    const byokStatusPremium = $('byokStatusPremium');
    if (byokStatusPremium) { byokStatusPremium.textContent = aiSettings.hasBYOKKey ? (masked ? 'Saved: ' + masked : 'Key saved.') : 'No key saved.'; }
    const ov = $('overrideByokToggle');
    if (ov) {
      const isOverride = aiSettings.aiAccessMode === 'byok';
      ov.classList.toggle('active', isOverride);
      ov.setAttribute('aria-pressed', String(isOverride));
      $('byokOverrideFields').classList.toggle('hidden', !isOverride);
    }

    renderAiUsage();
    renderParked(s.parkedIdeas || []);
    applyStatus();
  }

  function getJiraSyncState() {
    const summary = tasksMgr._lastSyncSummary || {};
    const states = Array.isArray(summary.syncStates) ? summary.syncStates : [];
    return states.find(state => state.sourceTool === 'jira') || null;
  }

  function isReconnectSyncError(message) {
    return /reconnect jira|session expired|unauthorized|invalid or expired|401|403|410/i.test(message || '');
  }

  function renderPmConnectButtons() {
    document.querySelectorAll('[data-connect-tool]').forEach(btn => {
      const tool = btn.dataset.connectTool;
      const connecting = _tasksConnectingTools.includes(tool);
      const connected = pmToolIsConnected(tool);
      btn.classList.toggle('is-loading', connecting);
      btn.classList.toggle('connected', connected && !connecting);
      btn.disabled = Boolean(connecting || connected);
      btn.textContent = connecting ? 'Connecting…' : connected ? 'Connected' : (TOOL_LABEL[tool] || tool);
    });
  }

  function renderIntegrations() {
    const list = $('integrationsList');
    if (!list) {
      // #region agent log
      agentDebugLog('D', 'tyne.js:renderIntegrations', 'integrationsList missing', { activeView });
      // #endregion
      return;
    }
    let jiraBranch = 'skipped';
    let linearBranch = 'skipped';
    let renderError = null;
    try {

    const setDesc = (row, text) => {
      const desc = row.querySelector('.int-desc');
      if (desc) { desc.textContent = text; }
    };
    const setStateBtn = (btn, text, cls, disabled) => {
      if (!btn || btn.tagName === 'SPAN') { return; }
      btn.textContent = text;
      btn.className = cls;
      btn.disabled = disabled;
      btn.classList.remove('hidden');
    };
    const showAction = (btn, on) => { if (btn) { btn.classList.toggle('hidden', !on); } };
    const ensureConnTag = (row) => {
      let tag = row.querySelector('.int-conn-tag');
      if (!tag) {
        const actions = row.querySelector('.int-actions');
        if (!actions) { return null; }
        tag = document.createElement('span');
        tag.className = 'tag-outline good int-conn-tag';
        tag.textContent = 'CONNECTED';
        actions.insertBefore(tag, actions.firstChild);
      }
      return tag;
    };
    const setConnected = (row, stateBtn, on) => {
      const tag = ensureConnTag(row);
      if (tag) { tag.classList.toggle('hidden', !on); }
      if (stateBtn && stateBtn.tagName !== 'SPAN') {
        stateBtn.classList.toggle('hidden', on);
      }
    };

    // GitHub
    const ghRow = list.querySelector('[data-tool="github"]');
    if (ghRow) {
      const stateBtn = ghRow.querySelector('[data-action="connect"]');
      const disconnectBtn = ghRow.querySelector('[data-action="disconnect"]');
      if (isAuthenticated) {
        setConnected(ghRow, stateBtn, true);
        setDesc(ghRow, githubUsername ? `Signed in as @${githubUsername}` : 'Draft PRs · branch push · review links');
        showAction(disconnectBtn, true);
      } else {
        setConnected(ghRow, stateBtn, false);
        setStateBtn(stateBtn, 'Connect', 'btn compact primary', false);
        setDesc(ghRow, 'Account connection · draft PRs, branch push, review links');
        showAction(disconnectBtn, false);
      }
    }

    // Jira
    const jiraRow = list.querySelector('[data-tool="jira"]');
    if (jiraRow) {
      const selectedProject = jiraIntegration.selectedProject || null;
      const jiraState = getJiraSyncState();
      const syncError = jiraState && jiraState.errorMessage ? jiraState.errorMessage : '';
      const hasApiError = syncError && syncError !== 'No open Jira issues assigned to you';
      const pmJira = pmIntegration.jira || {};
      const githubConnected = pmIntegration.githubConnected === true
        || jiraIntegration.githubConnected === true;
      const jiraConnected = pmToolIsConnected('jira');
      const reconnectRequired = Boolean(jiraIntegration.reconnectRequired) || (jiraConnected && isReconnectSyncError(syncError));
      const stateBtn = jiraRow.querySelector('[data-action="connect"]');
      const changeBtn = jiraRow.querySelector('[data-action="change-project"]');
      const disconnectBtn = jiraRow.querySelector('[data-action="disconnect"]');

      if (!githubConnected) {
        jiraBranch = 'github_first';
        // Keep enabled — click starts GitHub login (Jira OAuth needs tyne_github_token).
        setConnected(jiraRow, stateBtn, false);
        setStateBtn(stateBtn, 'Connect GitHub first', 'btn compact primary', false);
        if (stateBtn) { stateBtn.dataset.actionId = 'jiraConnectGithubBtn'; }
        setDesc(jiraRow, 'Connect GitHub first to connect Jira.');
        showAction(changeBtn, false);
        showAction(disconnectBtn, false);
      } else if (_tasksConnectingTools.includes('jira')) {
        jiraBranch = 'connecting';
        if (stateBtn) { delete stateBtn.dataset.actionId; }
        setConnected(jiraRow, stateBtn, false);
        setStateBtn(stateBtn, 'Connecting…', 'btn compact conn-badge-neutral is-loading', true);
        setDesc(jiraRow, 'Opening browser for Jira OAuth. Allow VS Code to open when prompted, then return here.');
        showAction(changeBtn, false);
        showAction(disconnectBtn, false);
      } else if (reconnectRequired) {
        jiraBranch = 'reconnect';
        if (stateBtn) { stateBtn.dataset.actionId = 'jiraReconnectBtn'; }
        setConnected(jiraRow, stateBtn, false);
        setStateBtn(stateBtn, 'Reconnect', 'btn compact primary', false);
        setDesc(jiraRow, syncError && hasApiError ? syncError : 'Jira session expired. Reconnect Jira.');
        showAction(changeBtn, false);
        showAction(disconnectBtn, true);
      } else if (jiraConnected) {
        jiraBranch = 'connected';
        if (stateBtn) { delete stateBtn.dataset.actionId; }
        setStateBtn(stateBtn, 'Connected', 'btn compact conn-badge-good', true);
        setConnected(jiraRow, stateBtn, true);
        setDesc(jiraRow, hasApiError
          ? `Connected. Task refresh needs attention: ${syncError || 'try syncing again.'}`
          : (selectedProject ? `Project ${selectedProject.projectKey} · ${selectedProject.projectName}` : 'Connected. Choose a Jira project.'));
        showAction(changeBtn, true);
        showAction(disconnectBtn, true);
      } else {
        jiraBranch = 'connect';
        if (stateBtn) { delete stateBtn.dataset.actionId; }
        setConnected(jiraRow, stateBtn, false);
        setStateBtn(stateBtn, 'Connect', 'btn compact primary', false);
        setDesc(jiraRow, 'Connect Jira to link this repository with your sprint work.');
        showAction(changeBtn, false);
        showAction(disconnectBtn, false);
      }
    }

    // Live PM tools only (Jira handled above; Linear here).
    ['linear'].forEach(tool => {
      const row = list.querySelector(`[data-tool="${tool}"]`);
      if (!row) { return; }
      const stateBtn = row.querySelector('[data-action="connect"]');
      const disconnectBtn = row.querySelector('[data-action="disconnect"]');
      const connected = pmToolIsConnected(tool);
      // Jira/Linear OAuth requires a real GitHub token — not device-auth-only Tyne login.
      const githubConnected = pmIntegration.githubConnected === true;
      if (tool === 'linear' && !githubConnected) {
        linearBranch = 'github_first';
        setConnected(row, stateBtn, false);
        setStateBtn(stateBtn, 'Connect GitHub first', 'btn compact primary', false);
        if (stateBtn) { stateBtn.dataset.actionId = 'linearConnectGithubBtn'; }
        setDesc(row, 'Connect GitHub first to connect Linear.');
        showAction(disconnectBtn, false);
      } else if (_tasksConnectingTools.includes(tool)) {
        if (tool === 'linear') { linearBranch = 'connecting'; }
        if (stateBtn) { delete stateBtn.dataset.actionId; }
        setConnected(row, stateBtn, false);
        setStateBtn(stateBtn, 'Connecting…', 'btn compact conn-badge-neutral is-loading', true);
        setDesc(row, 'Opening browser for OAuth. Allow VS Code to open when prompted.');
        showAction(disconnectBtn, false);
      } else if (connected) {
        if (tool === 'linear') { linearBranch = 'connected'; }
        if (stateBtn) { delete stateBtn.dataset.actionId; }
        setConnected(row, stateBtn, true);
        if (tool === 'linear') {
          const linear = pmIntegration.linear || {};
          const parts = [linear.teamKey, linear.teamName].filter(Boolean).join(' · ');
          setDesc(row, parts ? `Team: ${parts}` : 'Linear connected');
        } else {
          setDesc(row, (TOOL_LABEL[tool] || tool) + ' connected');
        }
        showAction(disconnectBtn, true);
      } else {
        if (tool === 'linear') { linearBranch = 'connect'; }
        if (stateBtn) { delete stateBtn.dataset.actionId; }
        setConnected(row, stateBtn, false);
        setStateBtn(stateBtn, 'Connect', 'btn compact primary', false);
        setDesc(row, 'Connect Linear to link issues with your sprint work.');
        showAction(disconnectBtn, false);
      }
    });

    if (typeof tasksMgr !== 'undefined' && tasksMgr && typeof tasksMgr.renderJiraHeaderDot === 'function') {
      tasksMgr.renderJiraHeaderDot(tasksMgr._lastSyncSummary || {});
    }
    renderPmConnectButtons();
    } catch (err) {
      renderError = err instanceof Error ? (err.message || String(err)) : String(err);
    }
    // #region agent log
    const jiraBtn = list.querySelector('[data-tool="jira"] [data-action="connect"]');
    const linearBtn = list.querySelector('[data-tool="linear"] [data-action="connect"]');
    agentDebugLog('D', 'tyne.js:renderIntegrations', 'renderIntegrations decision', {
      activeView,
      jiraBranch,
      linearBranch,
      renderError,
      btnJira: jiraBtn ? jiraBtn.textContent : null,
      btnLinear: linearBtn ? linearBtn.textContent : null,
      btnJiraClass: jiraBtn ? jiraBtn.className : null,
      btnLinearClass: linearBtn ? linearBtn.className : null,
      connectedTools: (_tasksConnectedTools || []).slice(),
      pmToolJira: pmToolIsConnected('jira'),
      pmToolLinear: pmToolIsConnected('linear'),
      jiraConnectedFlag: Boolean(jiraIntegration.connected),
      pmJira: Boolean((pmIntegration.jira || {}).connected),
      pmLinear: Boolean((pmIntegration.linear || {}).connected),
      githubConnectedFlag: pmIntegration.githubConnected,
      isAuthenticated,
    });
    // #endregion
  }

  function hydrateAccount(name, email, githubId) {
    githubUsername = name || '';
    if (typeof email === 'string') { userEmail = email; }
    if (typeof githubId === 'string') { userGithubId = githubId; }
    const nameEl = $('accountName');
    if (nameEl) {
      nameEl.textContent = githubUsername ? '@' + githubUsername : (isAuthenticated ? 'Connected' : 'Not connected');
      nameEl.classList.toggle('hidden', isAuthenticated);
    }
    const connTag = $('accountConnTag');
    if (connTag) {
      connTag.textContent = isAuthenticated ? 'CONNECTED' : 'NOT CONNECTED';
      connTag.classList.toggle('good', isAuthenticated);
      connTag.classList.toggle('soon', !isAuthenticated);
    }
    const plan = normalizedPlanTier();
    const tierClass = { free: 't-core', pro: 't-pro', max: 't-max', CORE: 't-core', PRO: 't-pro', MAX: 't-max' };
    document.querySelectorAll('.tier-logo').forEach(el => { el.style.display = 'none'; });
    const planEl = $('accountPlan');
    const logoKey = tierClass[plan] || tierClass[userTier];
    if (logoKey) {
      const logo = document.querySelector('.' + logoKey);
      if (logo) logo.style.display = 'block';
    }
    if (planEl) {
      planEl.style.display = '';
      const label = planTierLabel(plan);
      planEl.textContent = label || (isAuthenticated ? 'Loading plan…' : 'Connect GitHub to load your plan');
    }
    const credits = $('accountCredits');
    if (credits) {
      if (plan === 'max') { credits.classList.remove('hidden'); $('accountCreditsVal').textContent = String(Math.max(0, 100 - userCredits)); }
      else credits.classList.add('hidden');
    }
    renderIntegrations();
  }

  function applyTierConfig() {
    const setShown = (id, on) => { const el = $(id); if (el) el.classList.toggle('hidden', !on); };
    const plan = normalizedPlanTier();
    const rawUnknown = userTier === 'UNKNOWN' || plan === 'unknown';
    setShown('planConnectContainer', rawUnknown);
    setShown('coreConfigContainer', plan === 'free');
    setShown('premiumConfigContainer', plan === 'pro' || plan === 'max');
    setShown('upgradePlanBtn', !rawUnknown && plan !== 'max');
    setShown('manageBillingBtn', plan === 'max');
    setShown('planMaxNote', plan === 'max');
  }

  // Populate the thread-page task picker from the cached assigned tasks. Hidden
  // when there are no tasks (e.g. no PM tool connected).
  function renderThreadTaskPicker() {
    const tasks = (_tasksAll || []).filter(t => t && t.id && t.title);
    const optionHtml = t => '<option value="' + escHtml(t.id) + '">' + escHtml((t.externalId || t.id) + ' · ' + t.title) + '</option>';
    // Grouped by the same ranking the Tasks list uses, so the task the list
    // says to start first is the first thing offered here too.
    const bandGroup = (label, name) => {
      const inBand = tasks.filter(t => t.queueBand === name);
      if (!inBand.length) { return ''; }
      return '<optgroup label="' + escHtml(label) + '">' + inBand.map(optionHtml).join('') + '</optgroup>';
    };
    const grouped = () => {
      const banded = bandGroup('Start here', 'now') + bandGroup('Up next', 'next')
        + bandGroup('Everything else', 'later') + bandGroup('Blocked', 'blocked');
      // Tasks with no queue metadata (e.g. a stale cached payload) must still be
      // selectable, so fall back to a flat list rather than an empty picker.
      return banded || tasks.map(optionHtml).join('');
    };
    const optionsHtml = (placeholder) => '<option value="">' + placeholder + '</option>' +
      '<option value="__create__">+ Create custom task…</option>' +
      grouped();
    const setPicker = (sel, field, placeholder, preselect) => {
      if (!sel) { return; }
      sel.innerHTML = optionsHtml(placeholder);
      if (preselect && state.taskId && tasks.some(t => t.id === state.taskId)) { sel.value = state.taskId; }
      // The picker always carries "+ Create custom task…", so it stays useful
      // even with no PM tool connected — keep it visible.
      if (field) { field.classList.remove('hidden'); }
    };
    setPicker($('threadTaskPicker'), $('threadTaskPickerField'), '— Select an assigned task —', true);
    // Weaving switcher is a menu: keep the placeholder so any task (or create)
    // can be chosen, instead of mirroring the title shown above it.
    setPicker($('weavingTaskPicker'), $('weavingTaskPickerField'), 'Switch task…', false);
    renderThreadSuggestion();
  }

  /**
   * Pre-weave shortcut from the recommendation straight into a thread, so the
   * developer never has to read the list, memorise a key, and hunt for it in
   * the dropdown. Hidden while weaving — the hero already names the task.
   */
  function renderThreadSuggestion() {
    const wrap = $('threadSuggest');
    const body = $('threadSuggestBody');
    if (!wrap || !body) { return; }
    const weaving = state.status === 'weaving';
    const tasks = (_tasksAll || []).filter(t => t && t.id && t.title);
    const lead = tasks.find(t => t.queueBand === 'now');
    // Hide once a task is already in the brief — Start Here only for empty waiting state.
    if (weaving || !lead || (state.taskId && String(state.taskId).trim())) {
      wrap.classList.add('hidden');
      body.innerHTML = '';
      return;
    }
    // No status column here, so the status reason still carries information.
    const why = queueWhyLine(lead, { priority: true, status: false });
    const upNext = tasks.filter(t => t.queueBand === 'next').slice(0, 3);
    body.innerHTML =
      '<div class="thread-suggest-lead" data-suggest-task-id="' + escHtml(lead.id) + '">' +
        '<div class="thread-suggest-row">' +
          priorityChip(lead.normalizedPriority) +
          '<span class="thread-suggest-key">' + escHtml(lead.externalId || '') + '</span>' +
          '<span class="thread-suggest-name">' + escHtml(lead.title) + '</span>' +
        '</div>' +
        (why ? '<div class="task-card-why">' + escHtml(why) + '</div>' : '') +
        '<button class="btn primary full thread-suggest-start" type="button" data-suggest-start="' + escHtml(lead.id) + '">Use this task</button>' +
      '</div>' +
      (upNext.length
        ? '<div class="thread-suggest-next">' +
            '<span class="thread-suggest-next-label">Up next</span>' +
            upNext.map(t =>
              '<button class="thread-suggest-chip" type="button" data-suggest-start="' + escHtml(t.id) + '" title="' + escHtml(t.title) + '">' +
                escHtml(t.externalId || t.title) +
              '</button>').join('') +
          '</div>'
        : '');
    wrap.classList.remove('hidden');
  }

  /** Shared by the picker and the ranked suggestion — one way into a thread. */
  function loadTaskIntoThread(id) {
    const cf = $('customTaskField'); if (cf) { cf.classList.add('hidden'); }
    const t = (_tasksAll || []).find(x => x && x.id === id);
    if (!t) { return; }
    // Show Create-tasks CTA immediately from cached type (do not wait for enrichment).
    syncThreadCreateTasksCta(t.issueType, t.id);
    // Load the task straight into the thread brief, running the same PM
    // enrichment (epic/stories → proof points/subtasks) used elsewhere.
    vscode.postMessage({ type: 'selectTaskIntoThread', taskId: t.id, tool: t.sourceTool });
  }

  function applyState() {
    $('appName').value = state.appName || '';
    $('taskId').value = state.taskId || '';
    $('goal').value = state.goal || '';
    renderThreadTaskPicker();
    localHasStitch = (state.stitchCount || 0) > 0 && state.status === 'weaving';
    tieKnotUnlocked = state.validationOverride || (state.validationResult && state.validationResult.status === 'pass');
    if (state.status === 'weaving' && !sessionStart) sessionStart = Date.now();
    renderSubtasks();
    expandProofSectionIfContent();
    renderValidation();
    renderBranches();
    renderCommitSummaryCard();
    renderCommitLists();
    renderAiUsage();
    applyStatus();
    syncThreadCreateTasksCta();
  }

  // ---------- Event wiring ----------

  // Validation full-report overlay (Max): static controls wired once.
  (function wireValidationDetailOverlay() {
    const scrim = $('valDetailScrim');
    if (scrim) { scrim.addEventListener('click', closeValidationDetail); }
    ['valDetailCloseBtn', 'valDetailCloseBtn2'].forEach(function(id) {
      const el = $(id);
      if (el) { el.addEventListener('click', closeValidationDetail); }
    });
    const copyBtn = $('valDetailCopyBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', function() {
        const r = state.validationResult;
        if (!r) { return; }
        navigator.clipboard.writeText(validationReportText(r));
        const prev = copyBtn.textContent;
        copyBtn.textContent = 'Copied ✓';
        setTimeout(function() { copyBtn.textContent = prev; }, 1400);
      });
    }
    const runAgainBtn = $('valDetailRunAgainBtn');
    if (runAgainBtn) {
      runAgainBtn.addEventListener('click', function() {
        closeValidationDetail();
        vscode.postMessage({ type: 'buttonClick', action: 'validateReview' });
      });
    }
    const commitBtn = $('valDetailOpenCommitBtn');
    if (commitBtn) {
      commitBtn.addEventListener('click', function() {
        const r = state.validationResult;
        if (r && r.commitUrl) { vscode.postMessage({ type: 'openExternal', url: r.commitUrl }); }
      });
    }
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { closeValidationDetail(); }
    });
  })();

  ['appName', 'taskId', 'goal'].forEach(id => {
    $(id).addEventListener('input', e => {
      state[id] = e.target.value;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => vscode.postMessage({ type: 'fieldChange', field: id, value: e.target.value }), 500);
      applyStatus();
    });
  });

  // Thread-page task picker: a quick way to load an assigned task into the brief.
  const threadTaskPicker = $('threadTaskPicker');
  if (threadTaskPicker) {
    threadTaskPicker.addEventListener('change', () => {
      const id = threadTaskPicker.value;
      if (!id) { return; }
      if (id === '__create__') {
        const cf = $('customTaskField'); if (cf) { cf.classList.remove('hidden'); }
        const ti = $('customTaskTitle'); if (ti) { ti.focus(); }
        return;
      }
      loadTaskIntoThread(id);
    });
  }

  // Ranked suggestion: one tap from "start here" into the brief.
  const threadSuggestEl = $('threadSuggest');
  if (threadSuggestEl) {
    threadSuggestEl.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('[data-suggest-start]') : null;
      if (!btn) { return; }
      loadTaskIntoThread(btn.getAttribute('data-suggest-start'));
    });
  }
  const threadSuggestAllBtn = $('threadSuggestAllBtn');
  if (threadSuggestAllBtn) {
    threadSuggestAllBtn.addEventListener('click', () => setTasksInnerTab('list'));
  }

  // Weaving-page task picker: switch to a different task while already weaving.
  const weavingTaskPicker = $('weavingTaskPicker');
  if (weavingTaskPicker) {
    weavingTaskPicker.addEventListener('change', () => {
      const id = weavingTaskPicker.value;
      if (!id || id === state.taskId) {
        // Reset the dropdown to the current task so it doesn't appear unselected.
        renderThreadTaskPicker();
        return;
      }
      if (id === '__create__') {
        const cf = $('customTaskField'); if (cf) { cf.classList.remove('hidden'); }
        const ti = $('customTaskTitle'); if (ti) { ti.focus(); }
        return;
      }
      const cf = $('customTaskField'); if (cf) { cf.classList.add('hidden'); }
      const t = (_tasksAll || []).find(x => x && x.id === id);
      if (!t) { return; }
      syncThreadCreateTasksCta(t.issueType, t.id);
      setRunner(true);
      vscode.postMessage({ type: 'switchTaskInThread', taskId: t.id, tool: t.sourceTool });
    });
  }

  // Custom task creation from the thread page dropdown.
  const customTaskCreateBtn = $('customTaskCreateBtn');
  if (customTaskCreateBtn) {
    customTaskCreateBtn.addEventListener('click', () => {
      const titleEl = $('customTaskTitle');
      const title = (titleEl && titleEl.value || '').trim();
      if (!title) {
        if (titleEl) { titleEl.focus(); }
        return;
      }
      const tid = 'T-' + String(Date.now()).slice(-5);
      const goalEl = $('goal');
      if (goalEl) { goalEl.value = title; state.goal = title; }
      const taskIdEl = $('taskId');
      if (taskIdEl) { taskIdEl.value = tid; state.taskId = tid; }
      selectTask({ id: tid, title: title, source: 'Solo Mode' });
      const cf = $('customTaskField'); if (cf) { cf.classList.add('hidden'); }
      if (titleEl) { titleEl.value = ''; }
      renderThreadTaskPicker();
    });
  }
  const customTaskTitleInput = $('customTaskTitle');
  if (customTaskTitleInput) {
    customTaskTitleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const btn = $('customTaskCreateBtn');
        if (btn) { btn.click(); }
      }
    });
  }

  // The zipline runner is driven entirely by the host (runner: on/off), which
  // brackets the real async work — so it stays visible until the page actually
  // loads. We intentionally do NOT start/stop it optimistically on every button
  // click here; a fixed timer used to hide it after 1.5s, before the work finished.

  document.addEventListener('click', e => {
    if (e.target.closest('#addSubtaskBtn')) {
      const input = $('newSubtask');
      const text = input ? input.value.trim() : '';
      if (!text) { return; }
      vscode.postMessage({ type: 'subtaskAdd', text });
      if (input) { input.value = ''; }
    }
  });

  document.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => {
    showAppView(b.dataset.nav);
    if (b.dataset.nav === 'commits' && !selectedCommitHash && commitData.currentBranchCommits.length) {
      selectedCommitHash = commitData.currentBranchCommits[0].commitHash;
      renderCommitDetails();
    }
    if (b.dataset.nav === 'analytics') {
      vscode.postMessage({ type: 'refreshTime' });
    }
    if (b.dataset.nav === 'automation') {
      vscode.postMessage({ type: 'refreshAutomation' });
    }
    if (b.dataset.nav === 'tasks') {
      vscode.postMessage({ type: 'refreshTasks' });
    }
    if (b.dataset.nav === 'validateReview') {
      showAppView('validateReview');
      vscode.postMessage({ type: 'loadValidateReviewReports' });
      renderValidateReview();
    }
    if (b.dataset.nav === 'review') {
      showAppView('validateReview');
      vscode.postMessage({ type: 'loadValidateReviewReports' });
      renderValidateReview();
    }
  }));
  const tasksInnerTabs = $('tasksInnerTabs');
  if (tasksInnerTabs) {
    tasksInnerTabs.addEventListener('click', function(e) {
      const btn = e.target.closest('[data-tasks-tab]');
      if (!btn) { return; }
      if (btn.dataset.tasksTab === 'thread') { showAppView('thread'); }
      else { showAppView('tasksList'); }
    });
  }
  $('flowPrimaryBtn').addEventListener('click', () => runFlowAction($('flowPrimaryBtn').dataset.flowAction));
  const flowSecondaryBtn = $('flowSecondaryBtn');
  if (flowSecondaryBtn) {
    flowSecondaryBtn.addEventListener('click', function() {
      const menu = $('flowMoreMenu');
      if (menu) { menu.classList.add('hidden'); }
      const moreBtn = $('flowMoreBtn');
      if (moreBtn) { moreBtn.setAttribute('aria-expanded', 'false'); }
      runFlowAction(flowSecondaryBtn.dataset.flowAction);
    });
  }
  const flowMoreBtn = $('flowMoreBtn');
  if (flowMoreBtn) {
    flowMoreBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      const menu = $('flowMoreMenu');
      if (!menu) { return; }
      const open = menu.classList.toggle('hidden') === false;
      flowMoreBtn.setAttribute('aria-expanded', String(open));
    });
  }
  document.addEventListener('click', function(e) {
    const wrap = $('flowMoreWrap');
    const menu = $('flowMoreMenu');
    if (!wrap || !menu || menu.classList.contains('hidden')) { return; }
    if (wrap.contains(e.target)) { return; }
    menu.classList.add('hidden');
    if (flowMoreBtn) { flowMoreBtn.setAttribute('aria-expanded', 'false'); }
  });
  const gitStageBtn = $('gitStageBtn');
  if (gitStageBtn) {
    gitStageBtn.addEventListener('click', function() {
      vscode.postMessage({ type: 'buttonClick', action: 'stageAll' });
    });
  }
  const valHistoryViewAll = $('valHistoryViewAll');
  if (valHistoryViewAll) {
    valHistoryViewAll.addEventListener('click', function() {
      showAppView('validateReview');
      vscode.postMessage({ type: 'loadValidateReviewReports' });
      renderValidateReview();
    });
  }

  const reviewModeSelect = $('reviewModeSelect');
  if (reviewModeSelect) {
    reviewModeSelect.addEventListener('change', () => { codeReview.mode = reviewModeSelect.value; });
  }
  const runCodeReviewBtn = $('runCodeReviewBtn');
  if (runCodeReviewBtn) {
    runCodeReviewBtn.addEventListener('click', () => {
      if (codeReview.running) { return; }
      codeReview.running = true;
      codeReview.error = null;
      codeReview.selectedReportId = null;
      setReviewRunner(true);
      vscode.postMessage({ type: 'runCodeReview', mode: codeReview.mode });
    });
  }
  const reviewBackBtn = $('reviewBackBtn');
  if (reviewBackBtn) {
    reviewBackBtn.addEventListener('click', () => {
      codeReview.selectedReportId = null;
      renderCodeReview();
    });
  }
  const runValidateReviewBtn = $('runValidateReviewBtn');
  if (runValidateReviewBtn) {
    runValidateReviewBtn.addEventListener('click', () => {
      if (validateReview.running) { return; }
      beginValidateReviewFromPage();
      const scopeSelect = $('validateReviewScopeSelect');
      const scopeVal = scopeSelect ? scopeSelect.value : 'auto';
      const scope = scopeVal === 'auto' ? undefined : scopeVal;
      const selectedSha = scopeVal === 'selected_commit' ? selectedCommitHash : undefined;
      vscode.postMessage({ type: 'runValidateReview', scope: scope, selectedCommitSha: selectedSha });
    });
  }
  const validateReviewBackBtn = $('validateReviewBackBtn');
  if (validateReviewBackBtn) {
    validateReviewBackBtn.addEventListener('click', () => {
      validateReview.selectedReportId = null;
      renderValidateReview();
    });
  }
  const validateReviewExportPdfBtn = $('validateReviewExportPdfBtn');
  if (validateReviewExportPdfBtn) {
    validateReviewExportPdfBtn.addEventListener('click', function() {
      const report = getSelectedValidateReviewReport();
      if (!report) { return; }
      vscode.postMessage({ type: 'exportValidateReviewPdf', report: report });
    });
  }
  const vrFullReportToggle = $('vrFullReportToggle');
  if (vrFullReportToggle) {
    vrFullReportToggle.addEventListener('click', () => {
      const body = $('vrFullReportBody');
      const arrow = vrFullReportToggle.querySelector('.toggle-arrow');
      body.classList.toggle('hidden');
      if (arrow) arrow.innerHTML = body.classList.contains('hidden') ? '&#9658;' : '&#9660;';
    });
  }
  const reviewFullReportToggle = $('reviewFullReportToggle');
  if (reviewFullReportToggle) {
    reviewFullReportToggle.addEventListener('click', () => {
      const body = $('reviewFullReportBody');
      const arrow = reviewFullReportToggle.querySelector('.toggle-arrow');
      body.classList.toggle('hidden');
      arrow.innerHTML = body.classList.contains('hidden') ? '&#9658;' : '&#9660;';
    });
  }

  // Finding + pending-goal action buttons
  document.addEventListener('change', function(e) {
    const check = e.target && e.target.classList && e.target.classList.contains('vr-batch-check')
      ? e.target
      : null;
    if (!check) { return; }
    const findingId = check.dataset.findingId;
    if (!findingId) { return; }
    batchFindingSelection[findingFixKey(findingId)] = !!check.checked;
    persistReviewUiState();
    // Do not re-render the whole report — that collapses Action Needed / More panels.
    syncBatchFixBarDom();
  });

  document.addEventListener('click', function(e) {
    // Keep checkbox clicks from bubbling into nested <details> toggles.
    if (e.target && ((e.target.classList && e.target.classList.contains('vr-batch-check')) || (e.target.closest && e.target.closest('.vr-batch-check-label')))) {
      e.stopPropagation();
    }

    // Batch bar uses .btn; per-finding actions use .vr-fa-btn.
    const btn = e.target.closest('.vr-fa-btn, [data-action^="batch_"]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (!action) return;

    const result = validateReview.result || (state.validateReviewResult) || null;
    if (!result) return;

    if (action === 'batch_select_all' || action === 'batch_select_none') {
      const on = action === 'batch_select_all';
      collectBatchEligibleFindings(result).forEach(function(f) {
        batchFindingSelection[findingFixKey(f.id || '')] = on;
      });
      persistReviewUiState();
      document.querySelectorAll('.vr-batch-check').forEach(function(cb) {
        cb.checked = on;
      });
      syncBatchFixBarDom();
      return;
    }

    if (action === 'batch_fix_selected' || action === 'batch_apply_safe' || action === 'batch_agent_fix') {
      const reportId = result.id || selectedValidateReviewReportId();
      const selected = collectBatchEligibleFindings(result).filter(isBatchFindingSelected);
      const findings = selected
        .filter(function(f) {
          const c = f.actionClass || 'guidance';
          if (action === 'batch_apply_safe') {
            return c === 'applyable' && f.suggestedFix;
          }
          if (action === 'batch_agent_fix') {
            return c === 'agent' || c === 'guidance';
          }
          return true; // batch_fix_selected: everything checked
        })
        .map(function(f) { return findingPayloadForHost(f, reportId); });
      if (!findings.length) { return; }
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = action === 'batch_apply_safe' ? 'Applying…'
        : action === 'batch_agent_fix' ? 'Sending…'
        : 'Fixing…';
      const type = action === 'batch_apply_safe' ? 'applyFixesBatch'
        : action === 'batch_agent_fix' ? 'agentFixBatch'
        : 'fixSelectedBatch';
      vscode.postMessage({ type: type, findings: findings });
      // Re-enable if host never answers (cancel); batch done handlers re-render.
      setTimeout(function() {
        if (btn.isConnected && btn.disabled && btn.textContent !== prev) {
          btn.disabled = false;
          syncBatchFixBarDom();
        }
      }, 120000);
      return;
    }

    // Pending-goal actions (scope alignment)
    if (action === 'fix_goal' || action === 'out_of_scope' || action === 'create_task_from_goal') {
      const index = Number(btn.dataset.goalIndex || 0);
      const goals = Array.isArray(result.pendingGoals) ? result.pendingGoals : [];
      const goal = goals[index];
      if (!goal) return;
      const relatedFile = btn.dataset.file || (Array.isArray(goal.relatedFiles) && goal.relatedFiles[0]) || '';
      if (action === 'fix_goal') {
        vscode.postMessage({
          type: 'fixPendingGoal',
          goal: {
            title: goal.title,
            reason: goal.reason,
            suggestedAction: goal.suggestedAction,
            relatedFile: relatedFile,
            relatedFiles: goal.relatedFiles || [],
          }
        });
        return;
      }
      if (action === 'out_of_scope') {
        const row = btn.closest('.vr-pending-row');
        const goalKey = findingFixKey(btn.dataset.goalId || ('pending_goal_' + index));
        pendingGoalFeedbackByKey[goalKey] = 'out_of_scope';
        persistReviewUiState();
        if (row) {
          row.classList.add('resolved');
          const actionsEl = row.querySelector('.vr-pending-actions');
          if (actionsEl) { actionsEl.innerHTML = '<span class="vr-feedback-confirmed">Out of scope</span>'; }
        }
        vscode.postMessage({
          type: 'pendingGoalFeedback',
          goal: {
            title: goal.title,
            reason: goal.reason,
            suggestedAction: goal.suggestedAction,
            verdict: 'out_of_scope',
          }
        });
        return;
      }
      if (action === 'create_task_from_goal') {
        vscode.postMessage({
          type: 'createTaskFromFinding',
          finding: {
            id: 'goal_' + (goal.title || index),
            title: goal.title || 'Scope follow-up',
            file: relatedFile,
            explanation: [goal.reason, goal.suggestedAction ? 'Suggested: ' + goal.suggestedAction : ''].filter(Boolean).join('\n'),
            severity: goal.priority === 'high' ? 'high' : 'medium',
            category: 'pm_alignment',
          }
        });
        return;
      }
    }

    // Unsuppress acts on a row in the "Checked but not shown" panel, which is
    // keyed by index into suppressedFindings — there is no live finding to
    // resolve, so it must be handled before the resolution below.
    if (action === 'open_learnings') {
      vscode.postMessage({ type: 'openLearningsFile' });
      return;
    }

    if (action === 'unsuppress') {
      const item = (result.suppressedFindings || [])[Number(btn.dataset.index)];
      if (!item) return;
      btn.disabled = true;
      btn.textContent = 'Removing…';
      vscode.postMessage({
        type: 'removeTeamLearning',
        suppression: {
          source: item.source,
          title: item.title,
          learningTitle: item.learningTitle || '',
          scope: item.learningScope || '',
          origin: item.learningOrigin || 'team'
        }
      });
      return;
    }

    const findingId = btn.dataset.findingId;
    if (!findingId) return;
    const finding = resolveReviewFinding(result, findingId);
    if (!finding) return;
    const reportId = result.id || selectedValidateReviewReportId();

    if (action === 'open_finding') {
      vscode.postMessage({
        type: 'openFinding',
        finding: { file: finding.file, line: finding.line, endLine: finding.endLine },
      });
      return;
    }

    if (action === 'create_task') {
      vscode.postMessage({
        type: 'createTaskFromFinding',
        finding: {
          id: finding.id,
          title: finding.title,
          file: finding.file,
          line: finding.line,
          explanation: finding.explanation,
          suggestedFix: finding.suggestedFix,
          severity: finding.severity,
          category: finding.category,
        }
      });
      return;
    }

    // Autofix actions (Feature 6: Preview/Apply/Discard)
    if (action === 'preview_fix') {
      vscode.postMessage({
        type: 'previewFix',
        finding: {
          id: finding.id,
          reportId: reportId,
          file: finding.file,
          line: finding.line,
          endLine: finding.endLine,
          suggestedFix: finding.suggestedFix,
          fix: finding.fix,
          codeSnippet: finding.codeSnippet,
          title: finding.title,
          actionClass: finding.actionClass,
          evidence: finding.evidence,
        }
      });
      return;
    }
    if (action === 'apply_fix') {
      btn.disabled = true;
      btn.textContent = 'Applying...';
      vscode.postMessage({
        type: 'applyFix',
        finding: {
          reportId: reportId,
          id: finding.id,
          file: finding.file,
          line: finding.line,
          endLine: finding.endLine,
          suggestedFix: finding.suggestedFix,
          title: finding.title,
          actionClass: finding.actionClass,
          category: finding.category,
          confidence: finding.confidence,
          evidence: finding.evidence,
          codeSnippet: finding.codeSnippet,
        }
      });
      return;
    }
    if (action === 'agent_fix') {
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Fixing…';
        btn.classList.add('fixing');
      }
      vscode.postMessage({
        type: 'agentFix',
        finding: {
          reportId: reportId,
          id: finding.id,
          file: finding.file,
          line: finding.line,
          endLine: finding.endLine,
          title: finding.title,
          explanation: finding.explanation,
          suggestedFix: finding.suggestedFix,
          remediation: finding.remediation,
          evidence: finding.evidence,
          codeSnippet: finding.codeSnippet,
          fix: finding.fix,
          agentPrompt: finding.agentPrompt,
          actionClass: finding.actionClass,
          category: finding.category,
        }
      });
      return;
    }
    if (action === 'undo_fix') {
      btn.disabled = true;
      btn.textContent = 'Undoing...';
      vscode.postMessage({
        type: 'undoFix',
        finding: {
          reportId: reportId,
          id: finding.id,
          file: finding.file,
          line: finding.line,
          suggestedFix: finding.suggestedFix,
          title: finding.title,
        }
      });
      return;
    }
    if (action === 'discard_fix') {
      discardedFindingFixes[findingFixKey(finding.id, reportId)] = true;
      persistReviewUiState();
      renderValidateReview();
      return;
    }

    // Team learning → host writes .tyne/learnings.md. Handled before the
    // feedback map below because it is a repo write, not a verdict.
    if (action === 'team_learning') {
      btn.disabled = true;
      btn.textContent = 'Saving…';
      vscode.postMessage({
        type: 'addTeamLearning',
        learning: {
          title: finding.title,
          file: finding.file || '',
          category: finding.category || '',
        }
      });
      return;
    }

    // Useful / Ignore options → submit feedback
    const verdictMap = { accept: 'accepted', dismiss: 'dismissed', not_relevant: 'not_relevant', wrong: 'wrong' };
    const verdict = verdictMap[action];
    if (!verdict) return;

    btn.disabled = true;
    btn.textContent = '...';
    findingFeedbackByKey[findingFixKey(finding.id, reportId)] = verdict;
    persistReviewUiState();
    vscode.postMessage({
      type: 'findingFeedback',
      feedback: {
        reportId: result.id || '',
        findingId: finding.id,
        verdict: verdict,
        findingTitle: finding.title,
        findingFile: finding.file,
        findingCategory: finding.category,
        findingSeverity: finding.severity,
      }
    });
    const row = btn.closest('.vr-finding-row');
    if (row) {
      row.classList.add('resolved');
      const actionsEl = row.querySelector('.vr-finding-actions');
      const label = action === 'accept' ? 'Useful' : action.replace(/_/g, ' ');
      if (actionsEl) { actionsEl.innerHTML = '<span class="vr-feedback-confirmed">' + escHtml(label) + '</span>'; }
    }
  });

  function resolveReviewFinding(result, findingId) {
    if (!result || !findingId) { return null; }
    const fromFindings = (result.findings || []).find(function(f) { return f.id === findingId; });
    if (fromFindings) { return fromFindings; }
    const securityFindings = Array.isArray(result.securityFindings) ? result.securityFindings : [];
    let sf = securityFindings.find(function(f) { return f.id === findingId; });
    if (!sf) {
      const match = /^security_(\d+)$/.exec(findingId);
      if (match) { sf = securityFindings[Number(match[1])]; }
    }
    if (!sf) { return null; }
    return {
      id: sf.id || findingId,
      title: sf.title,
      file: sf.file,
      line: sf.line,
      endLine: sf.endLine,
      explanation: [sf.impact, sf.evidence].filter(Boolean).join(' '),
      suggestedFix: undefined,
      severity: sf.severity || 'medium',
      category: 'security',
      actionClass: 'agent',
      fixKind: 'agent_prompt',
      agentPrompt: sf.agentPrompt,
      evidence: sf.evidence,
      remediation: sf.remediation,
    };
  }
  const addTaskBtn = $('addTaskBtn');
  if (addTaskBtn) { addTaskBtn.addEventListener('click', () => runFlowAction('addTask')); }
  $('btnRevalidate').addEventListener('click', () => runFlowAction('validateReview'));
  $('btnOverride').addEventListener('click', () => runFlowAction('overrideProceed'));
  function setBillingCheckoutBusy(busy) {
    billingCheckoutBusy = busy;
    ['upgradeToMaxBtn', 'upgradeFromSettingsLink'].forEach(function(id) {
      const el = $(id);
      if (el) {
        el.disabled = busy;
        el.setAttribute('aria-busy', busy ? 'true' : 'false');
      }
    });
  }
  function startBillingCheckout(plan) {
    if (billingCheckoutBusy) { return; }
    setBillingCheckoutBusy(true);
    showPixel('think', 'Opening secure checkout…', 1600);
    vscode.postMessage({ type: 'startBillingCheckout', plan: plan });
  }
  $('upgradeToMaxBtn').addEventListener('click', () => startBillingCheckout('max'));

  $('continueWithGithubBtn').addEventListener('click', () => { $('continueWithGithubBtn').disabled = true; vscode.postMessage({ type: 'continueWithGitHub' }); });
  const onboardingSkipTourBtn = $('onboardingSkipTourBtn');
  if (onboardingSkipTourBtn) {
    onboardingSkipTourBtn.addEventListener('click', () => vscode.postMessage({ type: 'onboardingSkipTour' }));
  }
  ['welcomeTermsLink', 'welcomePrivacyLink', 'aboutTermsLink', 'aboutPrivacyLink'].forEach(function(id) {
    const a = $(id);
    if (!a) { return; }
    a.addEventListener('click', function(e) {
      e.preventDefault();
      const url = a.getAttribute('data-url');
      if (url) { vscode.postMessage({ type: 'openExternal', url: url }); }
    });
  });
  $('connectGithubSettingsBtn').addEventListener('click', () => vscode.postMessage({ type: 'continueWithGitHub' }));
  const threadGithubConnectBtn = $('threadGithubConnectBtn');
  if (threadGithubConnectBtn) {
    threadGithubConnectBtn.addEventListener('click', () => vscode.postMessage({ type: 'continueWithGitHub' }));
  }
  $('signoutBtn').addEventListener('click', () => vscode.postMessage({ type: 'logout' }));
  const deviceAuthRetryBtn = $('deviceAuthRetryBtn');
  if (deviceAuthRetryBtn) {
    deviceAuthRetryBtn.addEventListener('click', () => {
      deviceAuthRetryBtn.classList.add('hidden');
      $('continueWithGithubBtn').disabled = true;
            vscode.postMessage({ type: 'deviceAuthRetry' });
    });
  }
  const deviceAuthCancelBtn = $('deviceAuthCancelBtn');
  if (deviceAuthCancelBtn) {
    deviceAuthCancelBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'deviceAuthCancel' });
      const panel = $('deviceAuthPending');
      if (panel) { panel.classList.add('hidden'); }
      $('continueWithGithubBtn').disabled = false;
          });
  }
  const deviceAuthOpenLink = $('deviceAuthOpenLink');
  if (deviceAuthOpenLink) {
    deviceAuthOpenLink.addEventListener('click', () => {
      const url = deviceAuthOpenLink.dataset.url;
      if (url) { vscode.postMessage({ type: 'openExternal', url }); }
    });
  }
  (function () {
    const reBtn = $('githubReconnectBtn');
    if (reBtn) {
      reBtn.addEventListener('click', () => {
        reBtn.disabled = true;
        vscode.postMessage({ type: 'reconnectGitHub' });
        setTimeout(() => { reBtn.disabled = false; }, 3000);
      });
    }
  })();
  $('clearParkedBtn').addEventListener('click', () => vscode.postMessage({ type: 'parkedIdeasClear' }));
  const upgradePlanBtn = $('upgradePlanBtn');
  if (upgradePlanBtn) { upgradePlanBtn.addEventListener('click', () => openUpgradePage()); }
  const manageBillingBtn = $('manageBillingBtn');
  if (manageBillingBtn) { manageBillingBtn.addEventListener('click', () => openBillingPage()); }
  const upgradeFromSettingsLink = $('upgradeFromSettingsLink');
  if (upgradeFromSettingsLink) {
    upgradeFromSettingsLink.addEventListener('click', e => { e.preventDefault(); startBillingCheckout('pro'); });
  }
  const saveByokBtn = $('saveByokBtn');
  if (saveByokBtn) {
    saveByokBtn.addEventListener('click', () => { vscode.postMessage({ type: 'saveByokKey', apiKey: $('byokApiKey').value, provider: aiSettings.aiProvider }); $('byokApiKey').value = ''; });
  }
  $('saveByokBtnPremium').addEventListener('click', () => { vscode.postMessage({ type: 'saveByokKey', apiKey: $('byokApiKeyPremium').value, provider: aiSettings.aiProvider }); $('byokApiKeyPremium').value = ''; });
  const testByokBtn = $('testByokBtn');
  if (testByokBtn) { testByokBtn.addEventListener('click', () => vscode.postMessage({ type: 'testByokKey', provider: aiSettings.aiProvider })); }
  $('testByokBtnPremium').addEventListener('click', () => vscode.postMessage({ type: 'testByokKey', provider: aiSettings.aiProvider }));
  const deleteByokBtn = $('deleteByokBtn');
  if (deleteByokBtn) { deleteByokBtn.addEventListener('click', () => vscode.postMessage({ type: 'deleteByokKey' })); }
  $('deleteByokBtnPremium').addEventListener('click', () => vscode.postMessage({ type: 'deleteByokKey' }));
  $('btnCopyValSummary').addEventListener('click', () => {
    const r = state.validationResult;
    if (!r) { return; }
    const text = ['Result: ' + r.status.toUpperCase(), 'Match: ' + (r.matchPercent ?? '—') + '%', 'Risk: ' + (r.riskLevel || '—'), r.summary].join('\n');
    navigator.clipboard.writeText(text);
  });
  if ($('valHistorySearch')) { $('valHistorySearch').addEventListener('input', () => { renderValidationHistory(); }); }
  if ($('valHistoryFilter')) { $('valHistoryFilter').addEventListener('change', () => { renderValidationHistory(); }); }
  if ($('valHistorySort')) { $('valHistorySort').addEventListener('change', () => { renderValidationHistory(); }); }
  const valHistoryMoreBtn = $('valHistoryMoreBtn');
  if (valHistoryMoreBtn) {
    valHistoryMoreBtn.addEventListener('click', () => { $('valHistoryMoreMenu').classList.toggle('hidden'); });
  }
  document.addEventListener('click', e => {
    const exportBtn = e.target.closest('[data-export]');
    if (exportBtn) {
      const format = exportBtn.dataset.export;
      const filters = collectHistoryFilters();
      vscode.postMessage({ type: 'exportValidationHistory', format, filters });
      $('valHistoryMoreMenu').classList.add('hidden');
      return;
    }
    const moreMenu = $('valHistoryMoreMenu');
    if (moreMenu && !moreMenu.classList.contains('hidden') && !e.target.closest('.val-more-menu-wrap')) {
      moreMenu.classList.add('hidden');
    }
  });
  $('prLink').addEventListener('click', () => { if ($('prLink').dataset.url) vscode.postMessage({ type: 'openExternal', url: $('prLink').dataset.url }); });
  $('pendingLink').addEventListener('click', () => { if ($('pendingLink').dataset.url) vscode.postMessage({ type: 'openExternal', url: $('pendingLink').dataset.url }); });

  $('overrideByokToggle').addEventListener('click', () => {
    const on = $('overrideByokToggle').getAttribute('aria-pressed') !== 'true';
    $('overrideByokToggle').setAttribute('aria-pressed', String(on));
    $('overrideByokToggle').classList.toggle('active', on);
    $('byokOverrideFields').classList.toggle('hidden', !on);
    vscode.postMessage({ type: 'settingChange', key: 'aiAccessMode', value: on ? 'byok' : 'max' });
  });

  document.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('active', on);
    if (b.dataset.toggle === 'projectLead') vscode.postMessage({ type: 'settingChange', key: 'projectLeadMode', value: on });
  }));

  // BYOK provider toggles only — do NOT bind integration Connect buttons
  // (those also use data-provider and must open OAuth, not change byokProvider).
  document.querySelectorAll('#coreProviderSeg [data-provider], #premiumProviderSeg [data-provider]').forEach(b => b.addEventListener('click', () => {
    vscode.postMessage({ type: 'settingChange', key: 'byokProvider', value: b.dataset.provider });
  }));

  // Unified integrations list: connect / disconnect / change project.
  document.addEventListener('click', e => {
    const btn = e.target.closest('.int-item [data-action]');
    if (!btn || btn.disabled) { return; }
    e.preventDefault();
    e.stopPropagation();
    const action = btn.dataset.action;
    const provider = btn.dataset.provider;
    const tool = btn.dataset.tool || provider;
    if (action === 'connect') {
      if (provider === 'github') {
        vscode.postMessage({ type: 'continueWithGitHub' });
      } else if (btn.dataset.actionId === 'jiraConnectGithubBtn' || btn.dataset.actionId === 'linearConnectGithubBtn') {
        vscode.postMessage({ type: 'continueWithGitHub' });
      } else if (provider === 'jira' || provider === 'linear') {
        vscode.postMessage({ type: 'connectPmTool', tool: provider });
      } else {
        vscode.postMessage({ type: 'connectIntegration', provider });
      }
    } else if (action === 'disconnect') {
      if (tool === 'github') { vscode.postMessage({ type: 'logout' }); }
      else { vscode.postMessage({ type: 'disconnectPmTool', tool }); }
    } else if (action === 'change-project') {
      vscode.postMessage({ type: 'changeJiraProject' });
    }
  });
  // ── Section toggles (Thread collapses + Branches/Commits/Time) ──────────────
  document.addEventListener('click', e => {
    const toggle = e.target.closest('.section-toggle');
    if (!toggle) { return; }
    const targetId = toggle.dataset.target;
    if (!targetId) { return; }
    const body = $(targetId);
    if (!body) { return; }
    const open = !body.classList.contains('hidden');
    body.classList.toggle('hidden', open);
    const arrow = toggle.querySelector('.toggle-arrow');
    if (arrow) { arrow.textContent = open ? '\u25BA' : '\u25BC'; }
  });

  // ── Delegated proof-point events inside the proof section ─────────────────────
  document.addEventListener('click', e => {
    const checkBtn = e.target.closest('#proofSection .check');
    if (checkBtn && checkBtn.dataset.id) { vscode.postMessage({ type: 'subtaskToggle', id: checkBtn.dataset.id }); return; }
    const delBtn = e.target.closest('#proofSection .del');
    if (delBtn && delBtn.dataset.id) { vscode.postMessage({ type: 'subtaskDelete', id: delBtn.dataset.id }); return; }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (valPanelState === 'done' || valPanelState === 'error') {
        valPanelState = 'idle';
        renderValidationStages();
        e.stopPropagation();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      if (valPanelState === 'done') {
        const dismissBtn = $('valStagesDismissBtn');
        if (dismissBtn) { dismissBtn.click(); e.stopPropagation(); return; }
      }
    }
    if (e.key === 'Enter') {
      const inp = e.target.closest('#proofSection #newSubtask');
      if (inp) { const btn = $('addSubtaskBtn'); if (btn) { btn.click(); } }
    }
  });

  // taskSearch element removed — search is now handled by taskSearchInput in the Tasks page
  $('refreshBranchesBtn').addEventListener('click', () => vscode.postMessage({ type: 'refreshBranches' }));
  $('refreshCommitsBtn').addEventListener('click', () => vscode.postMessage({ type: 'refreshCommits' }));
  const velocityToggle = $('velocityToggle');
  if (velocityToggle) {
    velocityToggle.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-vmetric]');
      if (!btn) return;
      velocityMetric = btn.dataset.vmetric === 'lines' ? 'lines' : 'commits';
      velocityToggle.querySelectorAll('button').forEach(function(b) {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      renderVelocityChart();
    });
  }
  const velocityRange = $('velocityRange');
  if (velocityRange) {
    velocityRange.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-vrange]');
      if (!btn) return;
      const raw = btn.getAttribute('data-vrange');
      velocityRangeDays = raw === 'all' ? 0 : (Number(raw) || 14);
      velocityRange.querySelectorAll('button').forEach(function(b) {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      renderVelocityChart();
    });
  }

  document.addEventListener('click', e => {
    const branchButton = e.target.closest('[data-branch-action]');
    if (branchButton) {
      const branchName = branchButton.dataset.branchName;
      if (branchButton.dataset.branchAction === 'switch') vscode.postMessage({ type: 'switchBranch', branchName });
      if (branchButton.dataset.branchAction === 'copy') vscode.postMessage({ type: 'copyBranchName', branchName });
      if (branchButton.dataset.branchAction === 'delete') vscode.postMessage({ type: 'deleteBranch', branchName });
    }
    const commitButton = e.target.closest('[data-commit-action]');
    if (commitButton) {
      if (commitButton.dataset.commitAction === 'copy-hash') vscode.postMessage({ type: 'copyCommitHash', commitHash: commitButton.dataset.commitHash });
      if (commitButton.dataset.commitAction === 'copy-message') vscode.postMessage({ type: 'copyCommitMessage', message: commitButton.dataset.message });
      if (commitButton.dataset.commitAction === 'open-graph') vscode.postMessage({ type: 'openCommitGraph', commitHash: commitButton.dataset.commitHash });
    }
    const sessionCommit = e.target.closest('[data-commit-hash]');
    if (sessionCommit) {
      selectedCommitHash = sessionCommit.dataset.commitHash;
      renderCommitDetails();
    }
    const fileButton = e.target.closest('[data-file-path]');
    if (fileButton) {
      const filePath = fileButton.dataset.filePath;
      const evidenceLine = fileButton.dataset.evidenceLine;
      if (filePath && evidenceLine) {
        // An effect node — jump straight to the call site that proves it.
        vscode.postMessage({ type: 'openFinding', finding: { file: filePath, line: Number(evidenceLine) } });
      } else if (filePath) {
        vscode.postMessage({ type: 'openChangedFile', filePath: filePath });
        focusChangedFileInReview(filePath);
      }
      const flowNode = fileButton.closest('.vr-flow-svg-node.clickable');
      if (flowNode) {
        document.querySelectorAll('.vr-flow-svg-node.selected').forEach(function(el) { el.classList.remove('selected'); });
        flowNode.classList.add('selected');
        const files = String(flowNode.dataset.fileList || filePath || '').split(',').filter(Boolean);
        showArchitectureNodeInspector(
          flowNode.dataset.nodeId,
          flowNode.dataset.nodeLabel,
          files,
          Number(flowNode.dataset.additions || 0),
          Number(flowNode.dataset.deletions || 0)
        );
      }
      return;
    }
    const readingChip = e.target.closest('.vr-reading-chip');
    if (readingChip) {
      const cohort = readingChip.dataset.readingCohort || '';
      document.querySelectorAll('.vr-arch-band.cohort-focus').forEach(function(el) {
        el.classList.remove('cohort-focus');
      });
      document.querySelectorAll('.vr-flow-svg-node.selected, .vr-flow-svg-node.cohort-focus').forEach(function(el) {
        el.classList.remove('selected');
        el.classList.remove('cohort-focus');
      });
      document.querySelectorAll('.vr-reading-chip.active').forEach(function(el) { el.classList.remove('active'); });
      readingChip.classList.add('active');
      const band = cohort && document.querySelector('.vr-arch-band[data-section="' + cohort + '"]');
      if (band) {
        band.classList.add('cohort-focus');
        if (band.scrollIntoView) { band.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      } else {
        const ids = String(readingChip.dataset.nodeIds || '').split(',').filter(Boolean);
        ids.forEach(function(id) {
          const el = document.querySelector('.vr-flow-svg-node[data-node-id="' + id + '"], .vr-arch-chip[data-node-id="' + id + '"]');
          if (el) { el.classList.add('cohort-focus'); }
        });
      }
      return;
    }
    // Only explicit buttons/links open the task externally. Task cards must NOT
    // open the browser on click — they open the internal detail drawer (handled
    // by the .task-card listener). The predicate (shared with the test harness)
    // is scoped to button/anchor so a card can never trigger an external open.
    const taskButton = TyneTaskInteractions.findExternalTaskOpenTarget(e.target);
    if (taskButton && taskButton.dataset.taskUrl) {
      vscode.postMessage({ type: 'openExternal', url: taskButton.dataset.taskUrl });
    }
    const d = e.target.closest('[data-drift-action]');
    if (d) vscode.postMessage({ type: 'driftAction', file: activeDriftFile, action: d.dataset.driftAction });
  });

  // ---------- Inbound messages ----------
  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'onboardingStatus') {
      showOnboarding(msg);
    } else if (msg.type === 'stateLoaded') {
      state = Object.assign(state, msg.state);
      if (state.validateReviewResult) {
        validateReview.result = state.validateReviewResult;
        if (state.validateReviewResult.id && !validateReview.reports.some(function(report) { return report.id === state.validateReviewResult.id; })) {
          validateReview.reports = [state.validateReviewResult].concat(validateReview.reports);
        }
      }
      applyState();
      showScreen(isAuthenticated ? 'main' : 'welcome');
      if (isAuthenticated) { vscode.postMessage({ type: 'onboardingGetStatus' }); }
    } else if (msg.command === 'HYDRATE_PROFILE') {
      userTier = msg.payload.tier || 'UNKNOWN';
      userCredits = msg.payload.credits || 0;
      if (userTier === 'MAX' || userTier === 'max') {
        valCountRemaining = 'unlimited';
        valCountTotal = 'unlimited';
      }
      hydrateAccount(msg.payload.githubUsername, msg.payload.email, msg.payload.githubId);
      applyTierConfig();
      applyStatus();
      renderAiUsage();
      renderValidationCounter();
    } else if (msg.type === 'profileLoadFailed') {
      userTier = 'UNKNOWN';
      document.querySelectorAll('.tier-logo').forEach(el => { el.style.display = 'none'; });
      const p = $('accountPlan'); if (p) { p.style.display = ''; p.textContent = 'Unable to load profile'; }
      applyTierConfig();
      applyStatus();
      renderAiUsage();
    } else if (msg.type === 'billingCheckoutOpened') {
      setBillingCheckoutBusy(false);
      showPixel('think', 'Checkout opened — your plan will refresh automatically', 2600);
    } else if (msg.type === 'billingCheckoutError') {
      setBillingCheckoutBusy(false);
      showPixel('warn', msg.message || 'Could not start checkout', 2600);
    } else if (msg.type === 'billingPlanUpdated') {
      setBillingCheckoutBusy(false);
      showPixel('think', 'Plan updated to ' + String(msg.tier || '').toUpperCase(), 2600);
    } else if (msg.type === 'billingRefreshStopped') {
      setBillingCheckoutBusy(false);
      showPixel('warn', 'Payment is still processing. Reopen Settings to refresh.', 2600);
    } else if (msg.type === 'settingsLoaded') {
      aiSettings.byokConfig = msg.byokConfig || aiSettings.byokConfig;
      aiSettings.hasBYOKKey = msg.hasBYOKKey;
      aiSettings.aiAccessMode = msg.aiAccessMode;
      aiSettings.aiProvider = msg.aiProvider;
      syncConnectedToolsFromPayload(msg);
      aiSettings.validationUsage = msg.validationUsage;
      aiSettings.validationUsageText = msg.validationUsageText;
      aiSettings.validationResult = msg.validationResult;
      state.validationResult = msg.validationResult || state.validationResult;
      renderSettings(msg);
      renderValidation();
    } else if (msg.type === 'integrationStateUpdated') {
      syncConnectedToolsFromPayload(msg);
      renderIntegrations();
      renderPmConnectButtons();
      if (typeof tasksMgr !== 'undefined' && tasksMgr) {
        tasksMgr.renderConnectionState();
        tasksMgr.renderToolBadges();
      }
    }
    else if (msg.type === 'branchDataLoaded') { branchData = msg; renderBranches(); renderFlow(); }
    else if (msg.type === 'commitDataLoaded') { commitData = msg; renderCommitSummaryCard(); renderCommitLists(); renderBranches(); }
    else if (msg.type === 'prepStarted') { renderPrepStarted(); }
    else if (msg.type === 'prepComplete') { renderPrepComplete(msg); }
    else if (msg.type === 'driftDetected') { renderDrift(msg.event); }
    else if (msg.type === 'driftDismissed' || msg.type === 'driftParked') { clearDrift(msg.file); }
    else if (msg.type === 'parkedIdeaSaved') { renderParked(msg.parkedIdeas); clearDrift(); }
    else if (msg.type === 'aiSettingsSaved') {
      const coreKey = $('byokApiKey');
      if (coreKey) { coreKey.value = ''; }
      const premKey = $('byokApiKeyPremium');
      if (premKey) { premKey.value = ''; }
      aiSettings.byokConfig = { ai: { provider: msg.provider, hasKey: true, maskedKey: msg.maskedKey, updatedAt: new Date().toISOString() } };
      renderSettings({ ...aiSettings, byokConfig: aiSettings.byokConfig });
      renderValidation();
    }
    else if (msg.type === 'byokKeyDeleted') {
      aiSettings.byokConfig = null;
      aiSettings.hasBYOKKey = false;
      renderSettings({ ...aiSettings, hasBYOKKey: false, byokConfig: null });
    }
    else if (msg.type === 'byokKeyTested') {
      const status = msg.ok ? 'BYOK key is valid.' : ('BYOK test failed: ' + (msg.error || 'Unknown error'));
      const statusEl = $('byokStatusPremium') || $('byokStatus');
      if (statusEl) { statusEl.textContent = status; }
    }
    else if (msg.type === 'validationRunning') {
      validationRunningTier = msg.tier || 'free';
      validationStages = (msg.stages || []).map(function(s) { return { stage: s.stage, name: s.name, status: 'pending', details: undefined }; });
      if (validationStages.length > 0) { validationStages[0].status = 'running'; }
      validationTrace = msg.trace || validationTrace;
      if (validationTrace) { syncTraceExpansion(validationTrace); }
      valPanelState = 'running';
      valLastError = null;
      valTimelineExpanded = false;
      valDetailsExpanded = false;
      for (const k in scorecardSections) { delete scorecardSections[k]; }
      if (!proofLive.active) { startProofLive(); }
      const body = $('validationBody');
      if (body && body.classList.contains('hidden')) {
        const toggle = document.querySelector('[data-target="validationBody"]');
        if (toggle) { toggle.click(); }
      }
      renderValidationStages();
    }
    else if (msg.type === 'validationComplete') {
      hidePixel();
      state.validationResult = msg.result;
      state.pmTaskValidationResult = msg.pmValidationResult || null;
      aiSettings.validationResult = msg.result;
      tieKnotUnlocked = (msg.result.status || msg.result.overall) === 'pass';
      validationRunningTier = (msg.result && msg.result.tier) ? msg.result.tier : validationRunningTier;
      validationTrace = msg.trace || msg.result?.trace || validationTrace;
      if (validationTrace) { syncTraceExpansion(validationTrace); }
      if (msg.stages && msg.stages.length > 0) {
        validationStages = msg.stages.map(function(s) { return { stage: s.stage, name: s.name, status: s.status || 'completed', details: s.details }; });
      } else if (validationStages.length > 0) {
        validationStages = validationStages.map(function(s) { return { stage: s.stage, name: s.name, status: 'completed', details: s.details }; });
      }
      if (msg.validationCountRemaining !== undefined || msg.validationCountTotal !== undefined) {
        applyValidationUsageCounts({
          remaining: msg.validationCountRemaining,
          limit: msg.validationCountTotal,
        });
      }
      valPanelState = 'done';
      valLastError = null;
      finalizeProofLiveFromResult(msg.result || {});
      ensureValidationVisible();
      renderValidation();
      renderValidationStages();
      tasksMgr.renderTaskDetailValidation();
      applyStatus();
      syncProofSection(true);
    }
    else if (msg.type === 'pmEnrichmentUpdated') {
      state.pmEnrichmentStatus = msg.pmEnrichmentStatus || state.pmEnrichmentStatus;
      state.pmEnrichmentError = msg.pmEnrichmentError || '';
      if (msg.goal) { state.goal = msg.goal; const g = $('goal'); if (g) { g.value = msg.goal; } }
      if (msg.acceptanceCriteria) { state.acceptanceCriteria = msg.acceptanceCriteria; }
      if (msg.proofPointTemplates) { state.proofPointTemplates = msg.proofPointTemplates; }
      if (msg.validationSteps) { state.validationSteps = msg.validationSteps; }
      if (msg.subtasks) { state.subtasks = msg.subtasks; renderSubtasks(); }
      if (msg.pmTaskContext) { state.pmTaskContext = msg.pmTaskContext; }
      const retryBtn = $('retryPmEnrichmentBtn');
      if (retryBtn) {
        retryBtn.disabled = false;
        retryBtn.textContent = state.pmEnrichmentStatus === 'success' ? 'Updated' : 'Retry PM Enrichment';
      }
      syncProofSection(false);
      expandProofSectionIfContent();
      if (_activeTaskId && (!msg.taskId || _activeTaskId === msg.taskId) && state.pmTaskContext) {
        tasksMgr.renderPmIntelligence(state.pmTaskContext);
      }
    }
    else if (msg.type === 'taskCreationEligibility') {
      state.taskIssueType = msg.issueType || '';
      syncThreadCreateTasksCta(msg.issueType, msg.taskId);
    }
    else if (msg.type === 'validationError') {
      hidePixel();
      valPanelState = 'error';
      valLastError = msg.message || 'Validation failed. Try again.';
      validationTrace = msg.trace || validationTrace;
      if (validationTrace) { syncTraceExpansion(validationTrace); }
      stopProofLive();
      renderValidationStages();
      renderValidation();
      tasksMgr.renderTaskDetailValidation();
    }
    else if (msg.type === 'codeReviewResult') {
      codeReview.running = false;
      if (msg.result) {
        const id = ensureCodeReviewReportId(msg.result);
        codeReview.result = msg.result;
        codeReview.selectedReportId = id;
        codeReview.reports = [msg.result].concat((codeReview.reports || []).filter(function(report) { return report.id !== id; }));
      }
      codeReview.error = null;
      setReviewRunner(false);
      renderCodeReview();
    }
    else if (msg.type === 'codeReviewError') {
      codeReview.running = false;
      codeReview.error = msg.message || 'Code review failed.';
      setReviewRunner(false);
      renderCodeReview();
    }
    else if (msg.type === 'validationHistory') { validationHistory = msg.history || []; validationTier = msg.tier || 'free'; renderValidation(); }
    else if (msg.type === 'validationTrends') { validationTrends = msg.trends; renderValidation(); }
    else if (msg.type === 'reviewTrends') { reviewTrends = msg.trends; renderReviewTrends(msg.trends, msg.reason); }
    else if (msg.type === 'validationExported') { /* exported to msg.filePath */ }
    else if (msg.type === 'busy') {
      if (msg.on && msg.kind === 'think') showPixel('think', 'AI reviewing goal');
      else if (msg.on && msg.kind === 'push') showPixel('push', 'Pushing to remote');
      else if (!msg.on) hidePixel();
    }
    else if (msg.type === 'runner') {
      setRunner(msg.on);
    }
    else if (msg.type === 'synthStarted') { showPixel('generate', 'AI writing commit'); }
    else if (msg.type === 'standupReady') { renderTasks(msg.tasks || []); }
    else if (msg.type === 'githubSessionExpired') { showGithubExpired(msg.message); }
    else if (msg.type === 'githubSessionRestored') { hideGithubExpired(); }
    else if (msg.type === 'showReviewPage') { showAppView('validateReview'); renderValidateReview(); }
    else if (msg.type === 'showValidateReviewPage') {
      showAppView('validateReview');
      vscode.postMessage({ type: 'loadValidateReviewReports' });
      if (msg.reportId) {
        validateReview.selectedReportId = msg.reportId;
        openValidateReviewReport(msg.reportId, 'structured');
      } else if (msg.openLatest) {
        const latest = state.validateReviewResult || validateReview.result
          || (validateReview.reports && validateReview.reports[0]) || null;
        if (latest && latest.id) {
          validateReview.selectedReportId = latest.id;
          openValidateReviewReport(latest.id, 'structured');
        } else {
          renderValidateReview();
        }
      } else {
        renderValidateReview();
      }
    }
    else if (msg.type === 'validateReviewRunning') {
      hidePixel();
      validateReview.running = true;
      validateReview.error = null;
      validateReview.upgradeRequired = false;
      if (validateReviewOrigin === 'thread') {
        // Stay on Thread — inline loader already started (or recover if host echoed first).
        if (!validateReview.startedAt) { validateReview.startedAt = Date.now(); }
        if (!validateReview.progressStage) { validateReview.progressStage = 'scope_resolution'; }
        valPanelState = 'running';
        valLastError = null;
        if (!proofLive.active) { startProofLive(); }
        ensureValidationVisible();
        setFlowValidateBusy(true);
        startValidateReviewEta();
        renderValidationStages();
      } else {
        showAppView('validateReview');
        if (!proofLive.active) { startProofLive(); }
        setValidateReviewRunner(true);
        renderValidateReview();
      }
    }
    else if (msg.type === 'validateReviewResult') {
      hidePixel();
      validateReview.running = false;
      if (msg.result) {
        // Stamp active task onto the result so the list groups under that task card
        // even when the edge payload omitted thread/issue fields.
        const taskKey = currentValidateTaskKey();
        if (taskKey && !msg.result.issueIdentifier) { msg.result.issueIdentifier = taskKey; }
        if (!msg.result.issueTitle && (state.taskTitle || state.goal)) {
          msg.result.issueTitle = state.taskTitle || state.goal;
        }
        if (!msg.result.issueId && state.taskId) { msg.result.issueId = state.taskId; }
        if (!msg.result.threadId && state.taskId) { msg.result.threadId = state.taskId; }
        if (!msg.result.createdAt) { msg.result.createdAt = new Date().toISOString(); }
        ensureValidateReviewReportId(msg.result, 0);
      }
      validateReview.result = msg.result;
      if (msg.result && msg.result.id && !validateReview.reports.some(function(report) { return report.id === msg.result.id; })) {
        validateReview.reports = [msg.result].concat(validateReview.reports);
      }
      state.validateReviewResult = msg.result || state.validateReviewResult;
      if (msg.result && msg.result.id) { state.latestValidateReviewReportId = msg.result.id; }
      validateReview.error = null;
      stopValidateReviewEta();
      setFlowValidateBusy(false);
      vscode.postMessage({ type: 'onboardingFirstReviewDone' });
      maybeShowUpgradeVolumeCta(msg.result);
      if (validateReviewOrigin === 'thread') {
        // Stay on Thread — compact summary via validationComplete; do not auto-open doc.
        validateReview.selectedReportId = null;
        const pageRunner = $('validateReviewRunner');
        if (pageRunner) { pageRunner.classList.remove('on'); }
      } else {
        validateReview.selectedReportId = msg.result?.id || validateReview.selectedReportId;
        validateReview.viewMode = 'structured';
        setValidateReviewRunner(false);
        renderValidateReview();
      }
    }
    else if (msg.type === 'review_progress') {
      validateReview.progressStage = msg.stage;
      validateReview.progressStatus = msg.status;
      if (validateReview.running) {
        if (msg.status === 'done') { advanceProofChecking(); }
        if (validateReviewOrigin === 'thread') {
          renderValidationStages();
        } else {
          setValidateReviewRunner(true, msg.stage);
        }
        syncReviewLiveTimeline();
      }
    }
    else if (msg.type === 'proof_strike_progress') {
      if (!proofLive.active) { startProofLive(); }
      const implemented = [];
      (msg.items || []).forEach(function(item) {
        if (!item) { return; }
        if (item.status === 'implemented') { implemented.push(item.text); }
      });
      if (implemented.length) {
        // While reviewing, buffer only — checklist stays hidden until finalize.
        applyProofStrikeFromTexts(implemented, { animate: valPanelState !== 'running', staggerMs: valPanelState === 'running' ? 0 : 140 });
      }
      if (valPanelState === 'running') {
        renderValidationStages();
      } else {
        (msg.items || []).forEach(function(item) {
          if (!item || item.status !== 'missing') { return; }
          (state.subtasks || []).forEach(function(t) {
            if (proofTextMatches(t.text, item.text) && proofLive.statusById[t.id] !== 'done') {
              setProofStatus(t.id, 'checking', false);
            }
          });
        });
        renderSubtasks();
        renderValidationStages();
      }
    }
    else if (msg.type === 'review_partial_result') {
      if (msg.findings && Array.isArray(msg.findings) && msg.findings.length) {
        validateReview.partialFindings = (validateReview.partialFindings || []).concat(msg.findings).slice(0, 40);
        if (!validateReview.result) {
          validateReview.result = {
            status: 'needs_work',
            score: 0,
            riskLevel: 'medium',
            vibeCodeRisk: 'medium',
            summary: 'Local findings ready — LLM review still running…',
            findings: validateReview.partialFindings,
            completedGoals: [],
            pendingGoals: [],
            missingTests: [],
            nextActions: [],
            visualDiff: [],
          };
          renderValidateReview();
        }
      }
    }
    else if (msg.type === 'scopeBlowoutWarning') {
      hidePixel();
      validateReview.running = false;
      setFlowValidateBusy(false);
      setValidateReviewRunner(false);
      var blowoutMsg = msg.message || 'Scope blowout detected after Fix-in-IDE.';
      var proceed = window.confirm(
        blowoutMsg + '\n\nContinue and spend a validation credit?'
      );
      if (proceed) {
        if (validateReviewOrigin === 'thread') {
          beginValidateReviewFromThread();
        } else {
          beginValidateReviewFromPage();
          showAppView('validateReview');
        }
        vscode.postMessage({
          type: 'runValidateReview',
          scope: msg.scope,
          selectedCommitSha: msg.selectedCommitSha,
          acknowledgeScopeBlowout: true,
        });
      } else if (validateReviewOrigin === 'thread') {
        valPanelState = 'error';
        valLastError = 'Re-validate cancelled — scope blowout after Fix-in-IDE.';
        renderValidationStages();
      } else {
        validateReview.error = 'Re-validate cancelled — scope blowout after Fix-in-IDE.';
        renderValidateReview();
      }
    }
    else if (msg.type === 'validateReviewError') {
      hidePixel();
      validateReview.running = false;
      validateReview.error = msg.message || 'Review failed.';
      validateReview.upgradeRequired = Boolean(msg.upgradeRequired) || /upgrade to|limit reached|5 Core validations/i.test(validateReview.error || '');
      setFlowValidateBusy(false);
      stopValidateReviewEta();
      stopProofLive();
      if (validateReviewOrigin === 'thread') {
        valPanelState = 'error';
        valLastError = validateReview.error;
        ensureValidationVisible();
        renderValidationStages();
        renderFlow();
      } else {
        setValidateReviewRunner(false);
        renderValidateReview();
      }
    }
    else if (msg.type === 'validateReviewReportsLoaded') {
      const prior = validateReview.result;
      // History rows can omit client-enriched quality aggregates; merge them onto the
      // matching report so the overview quality gauges do not flash away on reload.
      validateReview.reports = (msg.reports || []).map(function(report) {
        if (!prior || !prior.id || report.id !== prior.id) { return report; }
        return Object.assign({}, report, {
          qualityScore: report.qualityScore != null ? report.qualityScore : prior.qualityScore,
          qualityScorecard: report.qualityScorecard || prior.qualityScorecard,
          qualityMetrics: report.qualityMetrics || prior.qualityMetrics,
          debtMinutes: report.debtMinutes != null ? report.debtMinutes : prior.debtMinutes,
          languageBreakdown: report.languageBreakdown || prior.languageBreakdown,
          contributionBreakdown: report.contributionBreakdown || prior.contributionBreakdown,
        });
      });
      if (prior && prior.id && !validateReview.reports.some(function(report) { return report.id === prior.id; })) {
        validateReview.reports = [prior].concat(validateReview.reports);
      }
      if (validateReview.selectedReportId) {
        validateReview.result = getSelectedValidateReviewReport();
      } else if (!validateReview.result && validateReview.reports.length) {
        validateReview.result = validateReview.reports[0];
      }
      renderValidateReview();
    }
    else if (msg.type === 'AUTH_STATE_CHANGE') { setAuthenticated(Boolean(msg.isAuthenticated)); }
    else if (msg.type === 'betaBugSubmitted') {
      betaBugSending = false;
      const submit = $('betaBugSubmitBtn');
      if (submit) { submit.disabled = false; submit.textContent = 'Send'; }
      const msgEl = $('betaBugMessage');
      if (msgEl) { msgEl.value = ''; }
      setBetaBugKind('bug');
      closeBetaBugSheet();
      showPixel('think', 'Thanks — bug received', 1400);
    }
    else if (msg.type === 'betaBugError') {
      betaBugSending = false;
      const submit = $('betaBugSubmitBtn');
      if (submit) { submit.disabled = false; submit.textContent = 'Send'; }
      const err = $('betaBugError');
      if (err) {
        err.textContent = msg.message || 'Could not send report.';
        err.classList.remove('hidden');
      }
    }
    else if (msg.type === 'githubConnectStatus') {
      if (msg.status === 'pending') {
        $('welcomePending').classList.remove('hidden');
        $('pendingCode').textContent = msg.userCode || '----';
        $('pendingLink').textContent = (msg.verificationUri || 'https://github.com/login/device').replace('https://', '');
        $('pendingLink').dataset.url = msg.verificationUri || 'https://github.com/login/device';
      } else if (msg.status === 'error') {
        $('continueWithGithubBtn').disabled = false;
                $('welcomePending').classList.add('hidden');
      }
    }
    else if (msg.type === 'deviceAuthStatus') {
      const panel = $('deviceAuthPending');
      const label = $('deviceAuthLabel');
      const code = $('deviceAuthCode');
      const hint = $('deviceAuthHint');
      const retry = $('deviceAuthRetryBtn');
      const openBtn = $('deviceAuthOpenLink');
      if (!panel) { return; }
      $('welcomePending').classList.add('hidden');
      panel.classList.remove('hidden');
      if (msg.userCode && code) { code.textContent = msg.userCode; }
      if (msg.verificationUri && openBtn) { openBtn.dataset.url = msg.verificationUri; }
      const terminal = msg.status === 'expired' || msg.status === 'denied' || msg.status === 'error' || msg.status === 'cancelled' || msg.status === 'success';
      if (retry) { retry.classList.toggle('hidden', !msg.canRetry && msg.status !== 'expired' && msg.status !== 'denied' && msg.status !== 'error' && msg.status !== 'cancelled'); }
      if (terminal) {
        $('continueWithGithubBtn').disabled = false;
              } else {
        $('continueWithGithubBtn').disabled = true;
              }
      if (label) {
        if (msg.status === 'waiting' || msg.status === 'browser_opened' || msg.status === 'started') {
          label.textContent = 'Confirm in browser';
        } else if (msg.status === 'expired') {
          label.textContent = 'Code expired';
        } else if (msg.status === 'denied') {
          label.textContent = 'Authorization denied';
        } else if (msg.status === 'error') {
          label.textContent = 'Login error';
        } else if (msg.status === 'success') {
          label.textContent = 'Device authorized';
        } else if (msg.status === 'cancelled') {
          label.textContent = 'Cancelled';
        }
      }
      if (hint) {
        hint.textContent = msg.message || '';
        hint.classList.toggle('welcome-device-error', msg.status === 'expired' || msg.status === 'denied' || msg.status === 'error');
        hint.classList.toggle('welcome-device-ok', msg.status === 'success');
      }
      if (msg.status === 'success') {
        // Mock dogfood success — stay on welcome; tokens live under tyne_session_*.
        setTimeout(function() {
          panel.classList.add('hidden');
          $('continueWithGithubBtn').disabled = false;
                  }, 2500);
      }
    }
    else if (msg.type === 'statusChanged') { state.status = msg.status; state.branchName = msg.branchName || state.branchName; if (state.status === 'weaving') { sessionStart = Date.now(); showPixel('weave', 'Weaving thread', 1700); } applyStatus(); }
    else if (msg.type === 'stitchSaved') { state.stitchCount = msg.stitchCount; state.lastStitchTime = msg.lastStitchTime; localHasStitch = true; showPixel('weave', 'Stitch saved', 1100); applyStatus(); }
    else if (msg.type === 'stitchUndone') { state.stitchCount = msg.stitchCount; applyStatus(); }
    else if (msg.type === 'hasStitch') { localHasStitch = msg.value; applyStatus(); }
    else if (msg.type === 'tieKnotUnlocked') { state.validationOverride = true; tieKnotUnlocked = true; applyStatus(); }
    else if (msg.type === 'stateCleared') {
      shipped = true;
      showPixel('push', msg.pushed ? 'Shipped' : 'Committed', 2000);
      showShipComplete(msg);
      if (shippedTimer) clearTimeout(shippedTimer);
      shippedTimer = setTimeout(() => {
        shipped = false; sessionStart = 0;
        state = { appName: '', taskId: '', taskTitle: '', taskSource: 'Solo Mode', taskUrl: '', goal: '', status: 'waiting', subtasks: [], validationResult: null, validationOverride: false, branchName: '', stitchCount: 0, lastStitchTime: '', pmTaskContext: null, pmTaskValidationResult: null, validateReviewResult: null, latestValidateReviewReportId: '', pmEnrichmentStatus: 'skipped', pmEnrichmentError: '', acceptanceCriteria: [], proofPointTemplates: [], validationSteps: [] };
        localHasStitch = false; tieKnotUnlocked = false; activeDriftFile = '';
        $('prepPanel').classList.add('hidden'); $('driftPanel').classList.add('hidden'); $('prPanel').classList.add('hidden');
        applyState();
      }, 9000);
    }
    else if (msg.type === 'prCreated') { showPRCreated(msg); }
    else if (msg.type === 'timeDataLoaded') { timeData = msg; renderTimeData(); }
    else if (msg.type === 'manualTimeSaved') { editingManualEntryId = null; hideManualTimeForm(); }
    else if (msg.type === 'manualTimeDeleted') { }
    else if (msg.type === 'manualTimeError') { showManualTimeError(msg.errors); }
    else if (msg.type === 'tasksDataLoaded') {
      tasksMgr.onDataLoaded(msg);
    }
    else if (msg.type === 'tasksQueryResult') {
      _tasksRankMode = msg.rankMode !== false;
      tasksMgr.renderTaskList(msg.tasks);
      if (msg.parseErrors && msg.parseErrors.length) { tasksMgr.showQueryErrors(msg.parseErrors); }
      else { tasksMgr.showQueryErrors([]); }
    }
    else if (msg.type === 'tasksSyncing') {
      tasksMgr.setSyncStatus('syncing', 'Syncing…');
    }
    else if (msg.type === 'taskDetailLoaded') {
      tasksMgr.onDetailLoaded(msg.details, msg.offline);
    }
    else if (msg.type === 'taskDetailError') {
      tasksMgr.onDetailError(msg.message);
    }
    else if (msg.type === 'pmTaskIntelligenceLoading') {
      tasksMgr.onPmIntelligenceLoading(msg.taskId);
    }
    else if (msg.type === 'pmEnrichmentLoading') {
      startPmThinkUI(msg.title || msg.taskId || '');
      tasksMgr.onPmIntelligenceLoading(msg.taskId);
    }
    else if (msg.type === 'pmEnrichmentDone') {
      stopPmThinkUI();
    }
    else if (msg.type === 'pmTaskIntelligenceLoaded') {
      tasksMgr.onPmIntelligenceLoaded(msg.taskId, msg.intelligence, msg.forceRefresh);
    }
    else if (msg.type === 'pmTaskIntelligenceError') {
      tasksMgr.onPmIntelligenceError(msg.taskId, msg.message);
    }
    else if (msg.type === 'storyDecomposeProgress') { storyDecompose.onProgress(msg); }
    else if (msg.type === 'storyDecomposeQuestions') { storyDecompose.onQuestions(msg); }
    else if (msg.type === 'storyDecomposeResult') { storyDecompose.onResult(msg); }
    else if (msg.type === 'storyDecomposeCreated') { storyDecompose.onCreated(msg); }
    else if (msg.type === 'storyDecomposeExisting') { storyDecompose.onExisting(msg); }
    else if (msg.type === 'storyDecomposeEnrichmentWarning') { storyDecompose.onEnrichmentWarning(msg); }
    else if (msg.type === 'storyDecomposeError') { storyDecompose.onError(msg); }
    else if (msg.type === 'prefillThread') {
      tasksMgr.prefillThread(msg);
    }
    else if (msg.type === 'validationReset') {
      // A new task was loaded — drop the previous task's scorecard so it doesn't
      // look like the new task auto-validated.
      state.validationResult = null;
      state.validationOverride = false;
      validationTrace = null;
      valPanelState = 'idle';
      tieKnotUnlocked = false;
      renderValidation();
      applyStatus();
    }
    else if (msg.type === 'navigateTo') {
      // Phase 3: no standalone Thread page. Legacy page:'thread' still redirects.
      if (msg.page === 'thread' || msg.tab === 'thread') {
        showAppView('thread');
      } else {
        showAppView(msg.page);
        if (msg.tab === 'list') { setTasksInnerTab('list'); }
      }
    }
    else if (msg.type === 'pmConnectBlocked') {
      const tool = msg.tool;
      if (tool) { _tasksConnectingTools = _tasksConnectingTools.filter(t => t !== tool); }
      const notice = $('taskTierNotice');
      if (notice) { notice.classList.remove('hidden'); }
      renderIntegrations();
      renderPmConnectButtons();
    }
    else if (msg.type === 'pmConnecting') {
      const tool = msg.tool;
      if (tool && !_tasksConnectingTools.includes(tool)) {
        _tasksConnectingTools.push(tool);
      }
      renderIntegrations();
      renderPmConnectButtons();
    }
    else if (msg.type === 'pmConnectSuccess') {
      // #region agent log
      agentDebugLog('C', 'tyne.js:pmConnectSuccess', 'webview received pmConnectSuccess', {
        tool: msg.tool,
        incomingTools: msg.connectedTools || null,
        incomingPmLinear: Boolean(((msg.pmIntegration || {}).linear || {}).connected),
        incomingPmJira: Boolean(((msg.pmIntegration || {}).jira || {}).connected),
        incomingJira: Boolean((msg.jiraIntegration || {}).connected),
      });
      // #endregion
      markPmToolConnectedLocally(msg.tool, msg);
    }
    else if (msg.type === 'pmConnectFailed') {
      const tool = msg.tool;
      if (tool) { _tasksConnectingTools = _tasksConnectingTools.filter(t => t !== tool); }
      if (msg.needsGithub) {
        pmIntegration = { ...pmIntegration, githubConnected: false };
        jiraIntegration = { ...jiraIntegration, githubConnected: false };
      }
      renderIntegrations();
      renderPmConnectButtons();
    }
    else if (msg.type === 'presetsLoaded') {
      tasksMgr._presets = msg.presets || [];
      tasksMgr.renderPresetMenu();
    }
    else if (msg.type === 'presetSaved') {
      tasksMgr._presets = (tasksMgr._presets || []).filter(p => p.id !== msg.preset.id).concat([msg.preset]);
      tasksMgr.renderPresetMenu();
      const drawer = $('savePresetDrawer'); if (drawer) { drawer.classList.add('hidden'); }
    }
    else if (msg.type === 'presetApplied') {
      tasksMgr.applyPresetToUI(msg.preset);
      const menu = $('taskPresetMenu'); if (menu) { menu.classList.add('hidden'); }
    }
    else if (msg.type === 'presetError') {
      const bar = $('queryErrorBar'); const txt = $('queryErrorText');
      if (bar && txt) { txt.textContent = 'Preset: ' + (msg.message || 'Error'); bar.classList.remove('hidden'); }
    }
    else if (msg.type === 'taskCreated') {
      tasksMgr.closeCreateDrawer();
      const ti = $('createTaskTitle'); if (ti) { ti.value = ''; }
    }
    else if (msg.type === 'taskUpdated') {
      tasksMgr.closeEditDrawer();
      tasksMgr.hideConflict();
    }
    else if (msg.type === 'subtaskAdded') {
      const inp = $('newSubtaskInput'); if (inp) { inp.value = ''; }
    }
    else if (msg.type === 'commentAdded') {
      const inp = $('newCommentInput'); if (inp) { inp.value = ''; }
    }
    else if (msg.type === 'taskWriteBlocked') {
      const bar = $('queryErrorBar'); const txt = $('queryErrorText');
      if (bar && txt) { txt.textContent = msg.reason || 'Upgrade to Pro or Max to edit tasks.'; bar.classList.remove('hidden'); }
    }
    else if (msg.type === 'taskWriteError') {
      const editErr = $('editTaskError');
      if (editErr) { editErr.textContent = msg.message || 'Save failed.'; editErr.classList.remove('hidden'); }
      const createErr = $('createTaskError');
      if (createErr) { createErr.textContent = msg.message || 'Create failed.'; createErr.classList.remove('hidden'); }
    }
    else if (msg.type === 'fixApplied') {
      if (msg.success) {
        appliedFindingFixes[findingFixKey(msg.findingId, msg.reportId)] = true;
        renderValidateReview();
      } else {
        document.querySelectorAll('.vr-finding-row[data-finding-id="' + msg.findingId + '"]').forEach(function(row) {
          const applyBtn = row.querySelector('.vr-fa-btn.apply-fix');
          if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Fix'; }
        });
      }
    }
    else if (msg.type === 'fixBatchApplied') {
      const results = Array.isArray(msg.results) ? msg.results : [];
      results.forEach(function(r) {
        if (r && r.success && r.findingId) {
          appliedFindingFixes[findingFixKey(r.findingId, msg.reportId)] = true;
          batchFindingSelection[findingFixKey(r.findingId, msg.reportId)] = false;
        }
      });
      persistReviewUiState();
      renderValidateReview();
    }
    else if (msg.type === 'fixSelectedBatchDone') {
      // Re-enable the bar after cancel / empty selection; success paths re-render.
      syncBatchFixBarDom();
    }
    else if (msg.type === 'fixUndone') {
      if (msg.success) {
        delete appliedFindingFixes[findingFixKey(msg.findingId, msg.reportId)];
        renderValidateReview();
      } else if (msg.canUndo === false) {
        delete appliedFindingFixes[findingFixKey(msg.findingId, msg.reportId)];
        renderValidateReview();
      } else {
        document.querySelectorAll('.vr-finding-row[data-finding-id="' + msg.findingId + '"]').forEach(function(row) {
          const undoBtn = row.querySelector('.vr-fa-btn.undo-fix');
          if (undoBtn) { undoBtn.disabled = false; undoBtn.textContent = 'Undo'; }
        });
      }
    }
    else if (msg.type === 'agentFixDone') {
      if (msg.handedOff) {
        sentAgentFixes[findingFixKey(msg.findingId, msg.reportId)] = true;
        persistReviewUiState();
        renderValidateReview();
      } else {
        document.querySelectorAll('.vr-finding-row[data-finding-id="' + msg.findingId + '"]').forEach(function(row) {
          const agentBtn = row.querySelector('.vr-fa-btn.agent-fix');
          if (agentBtn) {
            agentBtn.disabled = false;
            agentBtn.textContent = 'Fix in IDE';
            agentBtn.classList.remove('fixing');
          }
        });
      }
    }
    else if (msg.type === 'agentFixBatchDone') {
      const ids = Array.isArray(msg.findingIds) ? msg.findingIds : [];
      if (msg.handedOff) {
        ids.forEach(function(id) {
          sentAgentFixes[findingFixKey(id, msg.reportId)] = true;
          batchFindingSelection[findingFixKey(id, msg.reportId)] = false;
        });
        persistReviewUiState();
        renderValidateReview();
      } else {
        renderValidateReview();
      }
    }
    else if (msg.type === 'findingFeedbackConfirmed') {
      // Already handled by the click listener marking the row as resolved
    }
    else if (msg.type === 'findingFeedbackError') {
      // Re-enable buttons on error
      document.querySelectorAll('.vr-fa-btn').forEach(function(btn) {
        if (btn.disabled && btn.textContent === '...') { btn.disabled = false; btn.textContent = btn.dataset.action === 'accept' ? 'Useful' : btn.dataset.action === 'dismiss' ? 'Dismiss' : btn.dataset.action === 'not_relevant' ? 'Not relevant' : 'Wrong'; }
      });
    }
    else if (msg.type === 'teamLearningSaved') {
      document.querySelectorAll('.vr-fa-btn.team-learning').forEach(function(btn) {
        if (btn.disabled) { btn.disabled = false; btn.textContent = 'Suppress for team…'; }
      });
    }
    else if (msg.type === 'teamLearningRemoved') {
      document.querySelectorAll('.vr-fa-btn.vr-unsuppress').forEach(function(btn) {
        if (btn.disabled) { btn.disabled = false; btn.textContent = 'Unsuppress'; }
      });
    }
    else if (msg.type === 'teamLearningError') {
      document.querySelectorAll('.vr-fa-btn.team-learning').forEach(function(btn) {
        if (btn.disabled) { btn.disabled = false; btn.textContent = 'Suppress for team…'; }
      });
      document.querySelectorAll('.vr-fa-btn.vr-unsuppress').forEach(function(btn) {
        if (btn.disabled) { btn.disabled = false; btn.textContent = 'Unsuppress'; }
      });
    }
    else if (msg.type === 'conflictCheckResult') {
      if (msg.conflict) { tasksMgr.showConflict(msg.conflict); }
      else { tasksMgr.hideConflict(); }
    }
    else if (msg.type === 'capabilitiesLoaded') {
      tasksMgr._lastCapabilities = msg.capabilities;
      if (msg.capabilities) {
        tasksMgr._canCreate = !!msg.capabilities.canCreateTask;
        tasksMgr._canEdit = !!(msg.capabilities.canEditTitle || msg.capabilities.canEditDescription || msg.capabilities.canEditStatus);
        tasksMgr._canAddSubtask = !!msg.capabilities.canAddSubtask;
        tasksMgr._canAddComment = msg.capabilities.canAddComment !== false;
      }
      tasksMgr.applyWriteGating();
    }
    else if (msg.type === 'taskDeletedExternally') {
      tasksMgr.renderTaskList(_tasksAll.filter(t => t.id !== msg.taskId));
    }
    else if (msg.type === 'gitStatusLoaded') {
      gitStatus = { currentBranch: msg.currentBranch || '', stagedFiles: msg.stagedFiles || 0, unstagedFiles: msg.unstagedFiles || 0, isClean: Boolean(msg.isClean), hasActiveTask: Boolean(msg.hasActiveTask), isWeaving: Boolean(msg.isWeaving), ctaReason: msg.ctaReason || 'no_active_task' };
      renderGitStatusHint();
      renderFlow();
    }
    else if (msg.type === 'automationDataLoaded') {
      automationData = {
        settings: msg.settings,
        syncState: msg.syncState,
        conflict: msg.conflict,
        events: msg.events || [],
        detectorState: msg.detectorState,
        userTier: msg.userTier || 'free',
      };
      renderAutomationData();
      if ((msg.userTier || 'free') === 'max') {
        vscode.postMessage({ type: 'listCustomCompliancePolicies' });
      }
    }
    else if (msg.type === 'customCompliancePoliciesLoaded') {
      renderCustomPolicyList(msg.policies || []);
    }
    else if (msg.type === 'customCompliancePolicyCreated') {
      if ($('customPolicyName')) $('customPolicyName').value = '';
      if ($('customPolicyPattern')) $('customPolicyPattern').value = '';
    }
    else if (msg.type === 'commitDetectorState') {
      automationData.detectorState = msg.state;
      renderCommitDetectorState();
    }
    else if (msg.type === 'automationFeedbackPreview') {
      previewedFeedbackBody = msg.preview;
      const card = $('automationFeedbackPreviewCard');
      const txt = $('automationFeedbackPreviewText');
      if (card && txt) { txt.value = msg.preview; card.classList.remove('hidden'); card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    }
  });

  // ---------- Time helpers ----------
  function fmtMin(minutes) {
    const m = Math.max(0, Math.round(minutes || 0));
    if (m === 0) { return '0m'; }
    const h = Math.floor(m / 60);
    const rem = m % 60;
    if (h === 0) { return rem + 'm'; }
    if (rem === 0) { return h + 'h'; }
    return h + 'h ' + rem + 'm';
  }

  function renderTimeData() {
    renderAnalyticsDashboard();
    renderTaskTimeSummaryCard();
    renderTimeSessionList();
    renderManualTimeList();
  }

  function renderAnalyticsDashboard() {
    const a = timeData.analytics;
    const tasks = timeData.analyticsTasks || [];
    const selectedId = timeData.selectedTaskId || (a && a.taskId) || '';
    const sel = $('analyticsTaskSelect');
    if (sel) {
      if (!tasks.length) {
        sel.innerHTML = '<option value="">No tasks with time yet</option>';
      } else {
        sel.innerHTML = tasks.map(t => {
          const label = (t.taskTitle || t.taskId) + ' · ' + fmtMin(t.totalMinutes || 0);
          return '<option value="' + escHtml(t.taskId) + '"' +
            (t.taskId === selectedId ? ' selected' : '') + '>' + escHtml(label) + '</option>';
        }).join('');
      }
    }

    const greet = $('analyticsGreet');
    const sub = $('analyticsSub');
    if (!a) {
      if (greet) { greet.textContent = 'Developer Time Breakdown'; }
      if (sub) { sub.textContent = 'Select a task to see detailed work time.'; }
      return;
    }
    const title = a.prTitle || state.taskTitle || selectedId || 'Current work';
    if (greet) { greet.textContent = 'PR / Task: ' + title; }
    if (sub) {
      const bits = [];
      if (a.taskId || selectedId) { bits.push(a.taskId || selectedId); }
      if (a.branchName || state.branchName) { bits.push(a.branchName || state.branchName); }
      bits.push(a.trackingAccuracy === 'hybrid' ? 'Hybrid tracking' : 'Estimated from Git');
      if (a.velocityTrend && a.velocityTrend !== 'unknown') { bits.push('Velocity: ' + a.velocityTrend); }
      sub.textContent = bits.join(' · ');
    }

    const score = typeof a.productivityScore === 'number' ? a.productivityScore : 0;
    const scoreEl = $('analyticsScoreValue');
    if (scoreEl) { scoreEl.textContent = a.totalMinutes > 0 ? String(score) : '—'; }
    const ring = $('analyticsRingFg');
    if (ring) {
      const circ = 2 * Math.PI * 30;
      const pct = a.totalMinutes > 0 ? Math.max(0, Math.min(100, score)) / 100 : 0;
      ring.style.strokeDasharray = String(circ);
      ring.style.strokeDashoffset = String(circ * (1 - pct));
      ring.style.stroke = score >= 80 ? 'var(--green)' : score >= 60 ? 'var(--amber)' : 'var(--accent)';
    }
    const scoreFoot = $('analyticsScoreFoot');
    if (scoreFoot) {
      scoreFoot.textContent = a.qualityScore != null
        ? ('Quality ' + a.qualityScore + '/100')
        : 'Score / 100';
    }

    const totalEl = $('analyticsTotalTime');
    if (totalEl) { totalEl.textContent = fmtMin(a.totalMinutes); }

    const bars = $('analyticsTimeBars');
    if (bars) {
      const tb = a.timeBreakdown || {};
      const order = ['coding', 'testing', 'debugging', 'review', 'waiting', 'other', 'idle'];
      const labels = { coding: 'Coding', testing: 'Testing', debugging: 'Debug', review: 'Review', waiting: 'Waiting', other: 'Other', idle: 'Idle' };
      const total = Math.max(1, a.totalMinutes || 0);
      bars.innerHTML = order
        .filter(k => (tb[k] || 0) > 0)
        .map(k => {
          const m = tb[k] || 0;
          const pct = Math.round((m / total) * 100);
          return '<div class="analytics-bar-row"><span>' + labels[k] + '</span>' +
            '<div class="analytics-bar-track"><div class="analytics-bar-fill ' + k + '" style="width:' + pct + '%"></div></div>' +
            '<span>' + escHtml(fmtMin(m)) + '</span></div>';
        })
        .join('') || '<div class="empty" style="margin:0">No breakdown yet</div>';
    }

    const code = $('analyticsCodeMetrics');
    if (code) {
      const cm = a.codeMetrics || {};
      code.innerHTML =
        '<div class="analytics-metric"><div class="k">Added</div><div class="v">+' + escHtml(String(cm.linesAdded || 0)) + '</div></div>' +
        '<div class="analytics-metric"><div class="k">Deleted</div><div class="v">−' + escHtml(String(cm.linesDeleted || 0)) + '</div></div>' +
        '<div class="analytics-metric"><div class="k">Files</div><div class="v">' + escHtml(String(cm.filesChanged || 0)) + '</div></div>' +
        '<div class="analytics-metric"><div class="k">Commits</div><div class="v">' + escHtml(String(cm.commitCount || 0)) + '</div></div>' +
        '<div class="analytics-metric"><div class="k">LOC/hr</div><div class="v">' + escHtml(String(cm.locPerHour || 0)) + '</div></div>' +
        '<div class="analytics-metric"><div class="k">Avg commit</div><div class="v">' + escHtml(String(cm.averageCommitSize || 0)) + '</div></div>';
    }

    const aiBody = $('analyticsAiBody');
    if (aiBody) {
      const ai = a.aiUsed || {};
      const models = ai.models || [];
      if (!models.length && !(ai.validationRuns > 0)) {
        aiBody.innerHTML = '<div class="empty" style="margin:0">No Tyne AI usage yet.</div>';
      } else {
        aiBody.innerHTML =
          '<div class="analytics-big" style="font-size:18px">' + escHtml(String(ai.aiAssistanceRatio || 0)) + '%</div>' +
          '<div class="analytics-card-foot" style="margin:0">of coding assisted · ' + escHtml(String(ai.validationRuns || 0)) + ' runs</div>' +
          '<div class="analytics-ai-models">' +
          models.slice(0, 3).map(m =>
            '<div class="analytics-ai-row"><span class="name">' + escHtml(m.model) + '</span><span class="pct">' + escHtml(String(m.percentage)) + '%</span></div>'
          ).join('') +
          '</div>';
      }
    }

    const insights = $('analyticsInsights');
    if (insights) {
      const list = a.insights || [];
      insights.innerHTML = list.length
        ? '<ul>' + list.map(i => '<li>' + escHtml(i) + '</li>').join('') + '</ul>'
        : '<div class="empty" style="margin:0">Insights appear after you track time.</div>';
    }

    const detailTotal = $('analyticsDetailTotal');
    if (detailTotal) { detailTotal.textContent = 'TOTAL: ' + fmtMin(a.totalMinutes); }

    const foot = $('analyticsDetailFoot');
    if (foot) {
      const tb = a.timeBreakdown || {};
      const parts = [];
      if (tb.coding) { parts.push('Coding ' + fmtMin(tb.coding)); }
      if (tb.testing) { parts.push('Testing ' + fmtMin(tb.testing)); }
      if (tb.debugging) { parts.push('Debug ' + fmtMin(tb.debugging)); }
      if (tb.review) { parts.push('Review ' + fmtMin(tb.review)); }
      if (tb.waiting) { parts.push('Waiting ' + fmtMin(tb.waiting)); }
      foot.textContent = parts.length ? parts.join(' · ') : 'Add commits or manual time on this task to build a timeline.';
    }

    const tl = $('analyticsTimeline');
    if (tl) {
      const items = a.timeline || [];
      if (!items.length) {
        tl.innerHTML = '<div class="empty">No sessions yet for this task.</div>';
      } else {
        const maxMin = Math.max(1, ...items.map(i => i.durationMinutes || 0));
        const labels = {
          coding: 'CODING', testing: 'TESTING', debugging: 'DEBUGGING',
          review: 'PROOF-READ', waiting: 'WAITING', other: 'OTHER', idle: 'IDLE',
        };
        tl.innerHTML = items.map(item => {
          const t = item.startTime
            ? new Date(item.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '—';
          const pct = Math.max(4, Math.round(((item.durationMinutes || 0) / maxMin) * 100));
          const act = item.activity || 'other';
          const aiLine = act === 'waiting'
            ? 'AI: N/A'
            : (item.aiModel ? ('AI: ' + item.aiModel) : 'AI: None');
          return '<div class="analytics-tl-item">' +
            '<div class="analytics-tl-time">' + escHtml(t) + '</div>' +
            '<div class="analytics-tl-body">' +
            '<div class="title"><span class="analytics-tl-pill ' + escHtml(act) + '">' +
            escHtml(labels[act] || act.toUpperCase()) + '</span>' +
            '<span>' + escHtml(fmtMin(item.durationMinutes)) + '</span></div>' +
            '<div class="analytics-tl-track"><div class="analytics-tl-fill ' + escHtml(act) +
            '" style="width:' + pct + '%"></div></div>' +
            '<div class="meta">"' + escHtml(item.label || '') + '" · ' + escHtml(aiLine) + '</div>' +
            '</div></div>';
        }).join('');
      }
    }
  }

  function renderTaskTimeSummaryCard() {
    const el = $('taskTimeSummaryCard');
    if (!el) { return; }
    const s = timeData.taskSummary;
    if (!s || s.totalMinutes === 0 && s.sessionCount === 0 && !timeData.manualEntries.length) {
      el.innerHTML = '<div class="empty">No time tracked yet. Commit on a Tyne branch or add manual time.</div>';
      return;
    }
    const lastAct = s.lastActivityAt ? fmtRelative(s.lastActivityAt) : '—';
    el.innerHTML =
      '<div class="row"><div class="k">Total</div><div class="v green">' + escHtml(fmtMin(s.totalMinutes)) + '</div></div>' +
      '<div class="row"><div class="k">Automatic Git</div><div class="v">' + escHtml(fmtMin(s.automaticMinutes)) + '</div></div>' +
      '<div class="row"><div class="k">Manual</div><div class="v">' + escHtml(fmtMin(s.manualMinutes)) + '</div></div>' +
      (s.overrideMinutes > 0 ? '<div class="row"><div class="k">Override</div><div class="v">' + escHtml(fmtMin(s.overrideMinutes)) + '</div></div>' : '') +
      '<div class="row"><div class="k">Sessions</div><div class="v">' + escHtml(String(s.sessionCount)) + '</div></div>' +
      '<div class="row"><div class="k">Commits</div><div class="v">' + escHtml(String(s.commitCount)) + '</div></div>' +
      '<div class="row"><div class="k">Last active</div><div class="v">' + escHtml(lastAct) + '</div></div>' +
      '<div class="notice info" style="margin-top:8px"><div class="notice-copy">Estimated from Git activity</div></div>';
  }

  function renderTimeSessionList() {
    const el = $('timeSessionList');
    if (!el) { return; }
    const logs = (timeData.taskLogs || []).filter(l => l.source === 'automatic_git');
    if (!logs.length) {
      el.innerHTML = '<div class="empty">No commit sessions found for this branch yet.</div>';
    } else {
      el.innerHTML = logs.map(log => {
        const isSingle = (log.commitHashes || []).length <= 1;
        return '<div class="list-item time-session-item">' +
          '<div class="int-head"><span class="lt mono">' + escHtml(fmtMin(log.durationMinutes)) + '</span>' +
          '<span class="tag">' + escHtml(fmtRelative(log.startTime || log.createdAt)) + '</span>' +
          '<span class="tag source-git">Git Activity</span></div>' +
          '<div class="lm plain">' +
          (log.startTime ? escHtml(new Date(log.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : '—') +
          ' → ' +
          (log.endTime ? escHtml(new Date(log.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : '—') +
          ' · ' + escHtml(String((log.commitHashes || []).length)) + ' commit(s)' +
          '</div>' +
          (isSingle ? '<div class="notice info" style="margin:4px 0 0"><div class="notice-copy">Single commit session. Add manual time if needed.</div></div>' : '') +
          '</div>';
      }).join('');
    }
    updateToggleCount('timeSessionBody', logs.length);
  }

  function renderManualTimeList() {
    const el = $('manualTimeList');
    if (!el) { return; }
    const entries = timeData.manualEntries || [];
    if (!entries.length) {
      el.innerHTML = '<div class="empty">No manual time entries yet.</div>';
    } else {
      el.innerHTML = entries.map(e =>
        '<div class="list-item">' +
        '<div class="int-head"><span class="lt">' + escHtml(e.date) + '</span>' +
        '<span class="tag">' + escHtml(fmtMin(e.durationMinutes)) + '</span>' +
        '<span class="tag source-manual">Manual</span></div>' +
        (e.note ? '<div class="lm plain">' + escHtml(e.note) + '</div>' : '') +
        '<div class="tags">' +
        '<button class="btn compact" data-manual-action="edit" data-manual-id="' + escHtml(e.id) + '">Edit</button>' +
        '<button class="btn compact" data-manual-action="delete" data-manual-id="' + escHtml(e.id) + '">Delete</button>' +
        '</div></div>'
      ).join('');
    }
    updateToggleCount('manualTimeBody', entries.length);
  }

  function showManualTimeError(errors) {
    const el = $('manualTimeError');
    const txt = $('manualTimeErrorText');
    if (!el || !txt) { return; }
    const msg = Array.isArray(errors) ? errors.map(e => e.message).join(' ') : String(errors);
    txt.textContent = msg;
    el.classList.remove('hidden');
  }

  function hideManualTimeForm() {
    const card = $('manualTimeFormCard');
    if (card) { card.classList.add('hidden'); }
    const err = $('manualTimeError');
    if (err) { err.classList.add('hidden'); }
    const fields = ['mtDate', 'mtDuration', 'mtStartTime', 'mtEndTime', 'mtNote'];
    fields.forEach(id => { const el = $(id); if (el) { el.value = ''; } });
    editingManualEntryId = null;
  }

  function showManualTimeForm(entry) {
    const card = $('manualTimeFormCard');
    if (!card) { return; }
    const body = $('manualTimeBody');
    const arrow = document.querySelector('.section-toggle[data-target="manualTimeBody"] .toggle-arrow');
    if (body && body.classList.contains('hidden')) {
      body.classList.remove('hidden');
      if (arrow) arrow.textContent = '\u25BC';
    }
    card.classList.remove('hidden');
    const err = $('manualTimeError');
    if (err) { err.classList.add('hidden'); }
    if (entry) {
      editingManualEntryId = entry.id;
      const mtDate = $('mtDate'); if (mtDate) { mtDate.value = entry.date || ''; }
      const mtDuration = $('mtDuration'); if (mtDuration) { mtDuration.value = entry.durationMinutes || ''; }
      const mtStartTime = $('mtStartTime'); if (mtStartTime) { mtStartTime.value = entry.startTime || ''; }
      const mtEndTime = $('mtEndTime'); if (mtEndTime) { mtEndTime.value = entry.endTime || ''; }
      const mtNote = $('mtNote'); if (mtNote) { mtNote.value = entry.note || ''; }
    } else {
      editingManualEntryId = null;
      const today = new Date().toISOString().slice(0, 10);
      const mtDate = $('mtDate'); if (mtDate) { mtDate.value = today; }
    }
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---------- Time event wiring ----------
  const refreshTimeBtn = $('refreshTimeBtn');
  if (refreshTimeBtn) { refreshTimeBtn.addEventListener('click', () => vscode.postMessage({ type: 'refreshTime' })); }

  const analyticsTaskSelect = $('analyticsTaskSelect');
  if (analyticsTaskSelect) {
    analyticsTaskSelect.addEventListener('change', () => {
      const taskId = analyticsTaskSelect.value || undefined;
      vscode.postMessage({ type: 'selectAnalyticsTask', taskId });
    });
  }

  const addManualTimeHeaderBtn = $('addManualTimeHeaderBtn');
  if (addManualTimeHeaderBtn) {
    addManualTimeHeaderBtn.addEventListener('click', () => {
      const body = $('manualTimeBody');
      const arrow = document.querySelector('.section-toggle[data-target="manualTimeBody"] .toggle-arrow');
      if (body && body.classList.contains('hidden')) {
        body.classList.remove('hidden');
        if (arrow) arrow.textContent = '\u25BC';
      }
      showManualTimeForm(null);
    });
  }

  const cancelManualTimeBtn = $('cancelManualTimeBtn');
  if (cancelManualTimeBtn) { cancelManualTimeBtn.addEventListener('click', () => hideManualTimeForm()); }

  const saveManualTimeBtn = $('saveManualTimeBtn');
  if (saveManualTimeBtn) {
    saveManualTimeBtn.addEventListener('click', () => {
      const err = $('manualTimeError');
      if (err) { err.classList.add('hidden'); }
      const date = ($('mtDate') || {}).value || '';
      const duration = parseInt(($('mtDuration') || {}).value || '0', 10);
      const startTime = ($('mtStartTime') || {}).value || undefined;
      const endTime = ($('mtEndTime') || {}).value || undefined;
      const note = ($('mtNote') || {}).value || undefined;
      const entry = { date, durationMinutes: duration, startTime: startTime || undefined, endTime: endTime || undefined, note: note || undefined };
      if (editingManualEntryId) {
        vscode.postMessage({ type: 'editManualTime', id: editingManualEntryId, entry });
      } else {
        vscode.postMessage({ type: 'addManualTime', entry });
      }
    });
  }

  document.addEventListener('click', e => {
    const manualBtn = e.target.closest('[data-manual-action]');
    if (manualBtn) {
      const id = manualBtn.dataset.manualId;
      if (manualBtn.dataset.manualAction === 'delete') {
        vscode.postMessage({ type: 'deleteManualTime', id });
      } else if (manualBtn.dataset.manualAction === 'edit') {
        const entry = (timeData.manualEntries || []).find(en => en.id === id);
        if (entry) { showManualTimeForm(entry); }
      }
    }
  }, true);

  // ---------- Task Management ----------

  let _tasksAll = [];
  let _tasksTier = 'free';
  let _tasksIsFreeTier = true;
  // True while the list is in Recommended order — band groups only make sense
  // then, since an explicit user sort must keep the order the user asked for.
  let _tasksRankMode = true;
  let _activeTaskId = null;
  let _activeTaskTool = null;
  let _detailCommentCount = 3;
  let _detailDescExpanded = false;
  let _taskSearchDebounce = null;

  function escHtmlTask(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  const STATUS_LABELS = { todo: 'Todo', in_progress: 'In Progress', in_review: 'In Review', done: 'Done', blocked: 'Blocked', canceled: 'Canceled', unknown: 'Unknown' };
  const PRIORITY_LABELS = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'None', unknown: '—' };

  function badge(cls, text) { return `<span class="badge badge-${cls}">${escHtmlTask(text)}</span>`; }
  function statusBadge(s) { return badge(s || 'unknown', STATUS_LABELS[s] || s || '—'); }
  function priorityBadge(p) { return p && p !== 'none' && p !== 'unknown' ? badge(p, PRIORITY_LABELS[p] || p) : ''; }
  function toolBadge(t) { return `<span class="badge badge-tool">${escHtmlTask(TOOL_LABEL[t] || t)}</span>`; }

  // Work-item type pill: Epic = pink, Story = blue, everything else = white.
  // Outline only — the fill stays transparent so it never reads as a status chip.
  function issueTypeClass(issueType) {
    const t = (issueType || '').trim().toLowerCase();
    if (t === 'epic') { return 'epic'; }
    if (t === 'story' || t === 'user story' || t === 'feature') { return 'story'; }
    return 'task';
  }
  function issueTypeLabel(issueType) {
    // Title-case so "sub-task"/"STORY" render consistently.
    return (issueType || '').trim().replace(/\w[^\s-]*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  }
  // Empty when the provider exposes no type (Linear has no issue types) — we
  // never guess "Task" for something we did not actually classify.
  function issueTypePill(issueType) {
    const label = issueTypeLabel(issueType);
    if (!label) { return ''; }
    return `<span class="type-pill type-pill-${issueTypeClass(issueType)}">${escHtmlTask(label)}</span>`;
  }

  const PRIORITY_CHIP_LABEL = { urgent: 'P0', high: 'P1', medium: 'P2', low: 'P3' };
  // Medium is the default most PM tools stamp on everything, so showing it adds
  // noise without adding signal. Only render priorities that change a decision.
  function hasPriorityChip(priority) {
    return Boolean(PRIORITY_CHIP_LABEL[priority]) && priority !== 'medium';
  }
  function priorityChip(priority) {
    if (!hasPriorityChip(priority)) { return ''; }
    return `<span class="prio-chip prio-${escHtmlTask(priority)}" title="${escHtmlTask(priority)} priority">${PRIORITY_CHIP_LABEL[priority]}</span>`;
  }

  /**
   * Due date as a compact, semantically coloured chip. Overdue and due-today
   * are decisions, not metadata — they must not drown in the meta line.
   */
  function dueChip(dueDate) {
    if (!dueDate) { return ''; }
    const due = new Date(dueDate);
    if (Number.isNaN(due.getTime())) { return ''; }
    const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOfDay(due) - startOfDay(new Date())) / 86400000);
    let cls = '', label;
    if (days < 0) { cls = 'over'; label = (-days) + 'd overdue'; }
    else if (days === 0) { cls = 'today'; label = 'Due today'; }
    else if (days === 1) { cls = 'today'; label = 'Due tomorrow'; }
    else if (days <= 7) { cls = 'soon'; label = 'Due ' + fmtDate(dueDate); }
    else { label = 'Due ' + fmtDate(dueDate); }
    return '<span class="tc-due ' + cls + '">' + escHtmlTask(label) + '</span>';
  }

  /**
   * The "why" line carries only what the card does not already show. Repeating
   * the priority chip or the status column as a reason adds a visual tier
   * without adding information, which is what flattened the hierarchy.
   */
  function queueWhyLine(t, shows) {
    const reasons = Array.isArray(t.queueReasons) ? t.queueReasons : [];
    const dropPriority = shows.priority && hasPriorityChip(t.normalizedPriority);
    return reasons.filter(r => {
      if (dropPriority && (r === 'Urgent' || r === 'High priority')) { return false; }
      if (shows.status && (r === 'In progress' || r === 'In review')) { return false; }
      return true;
    }).join(' · ');
  }
  function workspaceOptionLabel(tool) {
    if (tool === 'jira') {
      const jira = pmIntegration.jira || {};
      const parts = [jira.projectKey, jira.projectName].filter(Boolean);
      return 'Jira: ' + (parts.join(' · ') || jira.siteName || 'Connected project');
    }
    if (tool === 'linear') {
      const linear = pmIntegration.linear || {};
      const parts = [linear.teamKey, linear.teamName].filter(Boolean);
      return 'Linear: ' + (parts.join(' · ') || linear.workspaceName || 'Connected workspace');
    }
    return TOOL_LABEL[tool] || tool;
  }

  // ── Story decomposition (Epic/Story → technical tasks) ──────────────────────
  // Mirrors isDecomposableIssueType in storyDecompositionHarness.ts.
  const STORY_DECOMPOSE_TYPES = /^(story|epic|user story|feature)$/i;
  function isDecomposableType(issueType) { return STORY_DECOMPOSE_TYPES.test((issueType || '').trim()); }

  // Single Thread CTA lives on #flowPrimaryBtn (via getFlowState). Keep issueType in sync.
  function syncThreadCreateTasksCta(issueTypeHint, taskIdHint) {
    const taskId = String(taskIdHint || state.taskId || '').trim();
    if (!taskId) {
      state.taskIssueType = '';
      renderFlow();
      return;
    }
    const fromList = (_tasksAll || []).find(function(t) {
      return t && (t.id === taskId || t.externalId === taskId || t.id === 'jira:' + taskId);
    });
    if (arguments.length >= 1) {
      state.taskIssueType = String(issueTypeHint || '');
    } else if (fromList) {
      state.taskIssueType = fromList.issueType || '';
    }
    renderFlow();
  }

  // Inline stroke icons (currentColor) — the design system uses icons, not emoji.
  const SD_ICONS = {
    sparkle: '<path d="M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z"/>',
    check: '<path d="M2.5 8.5l3.5 3.5 7.5-8"/>',
    circle: '<circle cx="8" cy="8" r="5.25"/>',
    dot: '<circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/>',
    chevron: '<path d="M6 3.5L10.5 8 6 12.5"/>',
    play: '<path d="M4.5 2.5l9 5.5-9 5.5z"/>',
    arrowRight: '<path d="M2.5 8h11M9.5 4l4 4-4 4"/>',
  };
  function sdIcon(name, cls) {
    return '<svg class="sd-icon' + (cls ? ' ' + cls : '') + '" viewBox="0 0 16 16" fill="none" '
      + 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" '
      + 'aria-hidden="true">' + (SD_ICONS[name] || '') + '</svg>';
  }

  const SD_ANALYZE_STEPS = [
    { id: 'read_story', label: 'Reading story description' },
    { id: 'parse_criteria', label: 'Parsing acceptance criteria' },
    { id: 'scan_codebase', label: 'Scanning codebase architecture' },
    { id: 'find_modules', label: 'Finding impacted modules' },
  ];
  const SD_GENERATE_STEPS = [
    { id: 'apply_answers', label: 'Applying your preferences' },
    { id: 'llm', label: 'Generating technical tasks' },
    { id: 'assemble', label: 'Assembling task breakdown' },
  ];

  const storyDecompose = {
    taskId: '', tool: '', phase: 'idle',
    questions: [], answers: {}, customNotes: {}, _goalHint: '',
    result: null, tasks: [], _enrichmentWarning: '',
    /** Optional YYYY-MM-DD applied to every task created from this story. */
    dueDate: '',
    _steps: {}, _stepList: [],
    _progressTimer: null, _progressStart: 0, _progressEstimateMs: 0,

    panel() { return $('storyDecomposePanel'); },

    reset() {
      this._stopProgress();
      this.taskId = ''; this.tool = ''; this.phase = 'idle';
      this.questions = []; this.answers = {}; this.customNotes = {}; this._goalHint = '';
      this.result = null;
      this.tasks = []; this._enrichmentWarning = ''; this.dueDate = '';
      const p = this.panel();
      if (p) { p.classList.add('hidden'); p.innerHTML = ''; }
    },

    start(taskId, tool) {
      this.reset();
      this.taskId = taskId; this.tool = tool; this.phase = 'analyzing';
      this._renderQuiet('Reading epic/story and preparing justification questions…');
      vscode.postMessage({ type: 'storyDecomposeAnalyze', taskId, tool });
    },

    // Progress steps are only rendered during generation; analysis stays quiet.
    onProgress(msg) {
      if (msg.taskId !== this.taskId || this.phase !== 'generating') { return; }
      this._steps[msg.step] = msg.status;
      this._renderSteps();
    },

    onEnrichmentWarning(msg) {
      if (msg.taskId !== this.taskId) { return; }
      this._enrichmentWarning = msg.message || '';
    },

    onQuestions(msg) {
      if (msg.taskId !== this.taskId) { return; }
      this._stopProgress();
      this.questions = Array.isArray(msg.questions) ? msg.questions : [];
      this._goalHint = msg.goal || '';
      // Preselect recommended radios; freeform starts empty.
      this.answers = {};
      this.customNotes = {};
      this.questions.forEach(q => {
        if (q.inputKind === 'freeform' || !(q.options || []).length) { return; }
        const rec = (q.options || []).find(o => o.recommended) || (q.options || [])[0];
        if (rec) { this.answers[q.id] = rec.id; }
      });
      // Always show Q&A after Create tasks — never auto-skip to generation.
      this.phase = 'questions';
      this._renderQuestions();
    },

    generate() {
      // Flush freeform / custom text into answers before posting.
      this._collectCustomAnswers();
      const missing = (this.questions || []).find(q => {
        const val = String(this.answers[q.id] || '').trim();
        if (q.inputKind === 'freeform' || !(q.options || []).length) { return !val; }
        if (val === 'custom') { return !String(this.customNotes[q.id] || '').trim(); }
        return !val;
      });
      if (missing) {
        const el = document.querySelector('[data-sd-question="' + missing.id + '"] .sd-custom-input, [data-sd-question="' + missing.id + '"]');
        if (el && el.focus) { el.focus(); }
        return;
      }
      // When user picked "custom", send the note text as the answer value.
      Object.keys(this.answers).forEach(id => {
        if (this.answers[id] === 'custom' && this.customNotes[id]) {
          this.answers[id] = String(this.customNotes[id]).trim();
        } else if (this.customNotes[id] && this.answers[id] && this.answers[id] !== 'custom') {
          this.answers[id] = this.answers[id] + ' — ' + String(this.customNotes[id]).trim();
        }
      });
      this.phase = 'generating';
      this._stepList = SD_GENERATE_STEPS;
      this._steps = { apply_answers: 'done', llm: 'active', assemble: 'pending' };
      this._renderLoading('Generating task breakdown', 6000);
      vscode.postMessage({ type: 'storyDecomposeGenerate', taskId: this.taskId, answers: this.answers });
    },

    _collectCustomAnswers() {
      (this.questions || []).forEach(q => {
        const area = document.querySelector('[data-sd-question="' + q.id + '"] .sd-custom-input');
        if (!area) { return; }
        const text = String(area.value || '').trim();
        this.customNotes[q.id] = text;
        if (q.inputKind === 'freeform' || !(q.options || []).length) {
          if (text) { this.answers[q.id] = text; }
        }
      });
    },

    onResult(msg) {
      if (msg.taskId !== this.taskId) { return; }
      this._stopProgress();
      this.result = msg.result || { tasks: [] };
      this.phase = 'preview';
      this._renderPreview();
    },

    create(inPmTool) {
      if (!this.result || !this.result.tasks || !this.result.tasks.length) { return; }
      // Read the date before the preview markup is replaced by the loader.
      const dueEl = $('sdDueDate');
      if (dueEl) { this.dueDate = String(dueEl.value || '').trim(); }
      // Connected PM → always push (Create in Tyne alone is for offline only).
      const pushPm = inPmTool || (typeof pmToolIsConnected === 'function' && pmToolIsConnected(this.tool));
      this.phase = 'creating';
      this._renderQuiet(pushPm
        ? 'Creating tasks in ' + (TOOL_LABEL[this.tool] || 'your PM tool') + ' and Tyne…'
        : 'Creating tasks in Tyne…');
      vscode.postMessage({
        type: 'storyDecomposeCreate',
        taskId: this.taskId,
        tasks: this.result.tasks,
        createInJira: !!pushPm,
        dueDate: this.dueDate || undefined,
      });
    },

    onCreated(msg) {
      if (msg.taskId !== this.taskId) { return; }
      this._stopProgress();
      this.phase = 'done';
      this._renderSuccess(msg);
    },

    onError(msg) {
      if (msg.taskId && msg.taskId !== this.taskId) { return; }
      this._stopProgress();
      this.phase = 'error';
      const p = this.panel();
      if (!p) { return; }
      p.classList.remove('hidden');
      p.innerHTML =
        '<div class="sd-head">Create Tasks from Story</div>' +
        '<div class="notice bad">' + escHtmlTask(msg.message || 'Story decomposition failed.') + '</div>' +
        '<div class="btn-row">' +
          (msg.upgradeRequired ? '' : '<button class="btn primary compact" data-sd-action="retry" type="button">Try again</button>') +
          '<button class="btn ghost compact" data-sd-action="close" type="button">Close</button>' +
        '</div>';
    },

    cancel() {
      if (this.taskId) { vscode.postMessage({ type: 'storyDecomposeCancel', taskId: this.taskId }); }
      this.reset();
    },

    // Quiet inline loader for fast phases — no step list, no progress bar.
    _renderQuiet(label) {
      const p = this.panel();
      if (!p) { return; }
      p.classList.remove('hidden');
      p.innerHTML =
        '<div class="sd-quiet"><span class="sd-quiet-dot" aria-hidden="true"></span>' +
        '<span>' + escHtmlTask(label) + '</span></div>' +
        '<div class="btn-row"><button class="btn ghost compact" data-sd-action="cancel" type="button">Cancel</button></div>';
    },

    // ── Loading UI (steps + progress bar + ETA) ──────────────────────────────
    _renderLoading(title, estimateMs) {
      const p = this.panel();
      if (!p) { return; }
      p.classList.remove('hidden');
      p.innerHTML =
        '<div class="sd-head">' + escHtmlTask(title) + '</div>' +
        '<div class="sd-steps" id="sdSteps"></div>' +
        '<div class="sd-progress-track"><div class="sd-progress-fill" id="sdProgressFill" style="width:4%"></div></div>' +
        '<div class="sd-eta" id="sdEta">Estimated time remaining: ' + Math.ceil(estimateMs / 1000) + 's</div>' +
        '<div class="btn-row"><button class="btn ghost compact" data-sd-action="cancel" type="button">Cancel</button></div>';
      this._renderSteps();
      this._startProgress(estimateMs);
    },

    _renderSteps() {
      const el = $('sdSteps');
      if (!el) { return; }
      el.innerHTML = this._stepList.map(step => {
        const status = this._steps[step.id] || 'pending';
        const icon = status === 'done' ? sdIcon('check') : status === 'active' ? sdIcon('dot') : sdIcon('circle');
        return '<div class="sd-step sd-step-' + status + '">' +
          icon +
          '<span class="sd-step-label">' + escHtmlTask(step.label) + '</span>' +
          '<span class="sd-step-state">' + (status === 'done' ? 'Done' : status === 'active' ? 'In progress' : '') + '</span>' +
        '</div>';
      }).join('');
    },

    _startProgress(estimateMs) {
      this._stopProgress();
      this._progressStart = Date.now();
      this._progressEstimateMs = estimateMs;
      this._progressTimer = setInterval(() => {
        const elapsed = Date.now() - this._progressStart;
        const pct = Math.min(92, Math.round((elapsed / this._progressEstimateMs) * 100));
        const fill = $('sdProgressFill');
        if (fill) { fill.style.width = Math.max(4, pct) + '%'; }
        const eta = $('sdEta');
        if (eta) {
          const remaining = Math.ceil(Math.max(0, this._progressEstimateMs - elapsed) / 1000);
          eta.textContent = remaining > 0 ? 'Estimated time remaining: ' + remaining + 's' : 'Almost done…';
        }
      }, 200);
    },

    _stopProgress() {
      if (this._progressTimer) { clearInterval(this._progressTimer); this._progressTimer = null; }
      const fill = $('sdProgressFill');
      if (fill) { fill.style.width = '100%'; }
    },

    // ── Clarifying / justification questions ─────────────────────────────────
    _renderQuestions() {
      const p = this.panel();
      if (!p) { return; }
      p.classList.remove('hidden');
      const qHtml = this.questions.map((q, index) => {
        const freeform = q.inputKind === 'freeform' || !(q.options || []).length;
        const options = freeform ? '' : (q.options || []).map(o => {
          const checked = this.answers[q.id] === o.id ? ' checked' : '';
          return '<label class="sd-option">' +
            '<input type="radio" name="sdq_' + escHtmlTask(q.id) + '" value="' + escHtmlTask(o.id) + '"' + checked + ' />' +
            '<span class="sd-option-label">' + escHtmlTask(o.label) + '</span>' +
            (o.recommended ? '<span class="sd-badge-recommended">Recommended</span>' : '') +
          '</label>';
        }).join('');
        const showCustom = freeform || q.allowCustom;
        const customVal = escHtmlTask(this.customNotes && this.customNotes[q.id] || (freeform ? (this.answers[q.id] || '') : ''));
        const custom = showCustom
          ? '<textarea class="sd-custom-input" rows="2" data-sd-custom="' + escHtmlTask(q.id) + '" placeholder="' +
            (freeform ? 'Your answer…' : 'Optional notes or custom split details…') + '">' + customVal + '</textarea>'
          : '';
        const body = String(q.question || '').split('\n').map(line => escHtmlTask(line)).join('<br/>');
        return '<div class="sd-question" data-sd-question="' + escHtmlTask(q.id) + '">' +
          '<div class="sd-question-title">' +
            (this.questions.length > 1 ? '<span class="sd-question-num">' + (index + 1) + '</span>' : '') +
            body +
          '</div>' +
          (options ? '<div class="sd-options">' + options + '</div>' : '') +
          custom +
        '</div>';
      }).join('');
      const warn = this._enrichmentWarning
        ? '<div class="notice warn">PM enrichment unavailable, so these questions use the raw issue text only. ' +
          escHtmlTask(this._enrichmentWarning) + '</div>'
        : '';
      const goalHint = this._goalHint
        ? '<div class="sd-subhead">AI reading: ' + escHtmlTask(String(this._goalHint).slice(0, 160)) +
          (String(this._goalHint).length > 160 ? '…' : '') + '</div>'
        : '';
      p.innerHTML =
        '<div class="sd-head">Justify the task split</div>' +
        '<div class="sd-subhead sd-subhead-ok">' + sdIcon('check') + 'Read complete — answer ' + this.questions.length +
          ' question' + (this.questions.length === 1 ? '' : 's') + ' before tasks are created</div>' +
        goalHint +
        warn +
        qHtml +
        '<div class="btn-row">' +
          '<button class="btn ghost compact" data-sd-action="cancel" type="button">Back</button>' +
          '<button class="btn primary compact" data-sd-action="generate" type="button">Generate Tasks</button>' +
        '</div>';
    },

    // ── Preview generated tasks ──────────────────────────────────────────────
    _renderPreview() {
      const p = this.panel();
      if (!p) { return; }
      const result = this.result || { tasks: [] };
      const tasks = result.tasks || [];
      p.classList.remove('hidden');
      const taskHtml = tasks.map(t => {
        const files = (t.affectedFiles || []).map(escHtmlTask).join(', ');
        const deps = (t.dependencies || []).map(escHtmlTask).join(', ');
        const ac = (t.acceptanceCriteria || []).map(c => '<li>' + escHtmlTask(c) + '</li>').join('');
        const proofs = (t.proofPoints || []).map(c => '<li>' + escHtmlTask(c) + '</li>').join('');
        return '<details class="sd-task">' +
          '<summary class="sd-task-summary">' +
            sdIcon('chevron', 'sd-task-chevron') +
            '<span class="sd-task-title">' + escHtmlTask(t.title) + '</span>' +
            '<span class="sd-task-estimate">' + escHtmlTask(String(t.estimatedHours)) + 'h</span>' +
          '</summary>' +
          '<div class="sd-task-body">' +
            (t.description ? '<div class="sd-task-desc">' + escHtmlTask(t.description) + '</div>' : '') +
            (ac ? '<div class="sd-task-section"><div class="sd-task-label">Acceptance criteria</div><ul>' + ac + '</ul></div>' : '') +
            (proofs ? '<div class="sd-task-section"><div class="sd-task-label">Proof points</div><ul>' + proofs + '</ul></div>' : '') +
            (files ? '<div class="sd-task-section"><div class="sd-task-label">Files</div><div>' + files + '</div></div>' : '') +
            (deps ? '<div class="sd-task-section"><div class="sd-task-label">Depends on</div><div>' + deps + '</div></div>' : '') +
            (t.developerContext ? '<div class="sd-task-section"><div class="sd-task-label">Developer context</div><div>' + escHtmlTask(t.developerContext) + '</div></div>' : '') +
          '</div>' +
        '</details>';
      }).join('');
      const toolLabel = TOOL_LABEL[this.tool] || 'Jira';
      const sourceNote = result.generatedBy === 'heuristic'
        ? '<div class="sd-subhead sd-note">Generated offline with Tyne’s heuristic splitter (AI backend unavailable).</div>'
        : '';
      p.innerHTML =
        '<div class="sd-head">Review generated tasks</div>' +
        '<div class="sd-subhead sd-subhead-ok">' + sdIcon('check') + 'Generated ' + tasks.length + ' technical task' +
          (tasks.length === 1 ? '' : 's') + ' from your story</div>' +
        sourceNote +
        taskHtml +
        '<div class="sd-totals">' +
          'Total estimated time: ~' + escHtmlTask(String(result.totalEstimatedHours || 0)) + ' hours' +
          (result.recommendedSprint ? ' · ' + escHtmlTask(result.recommendedSprint) : '') +
        '</div>' +
        // One date for the whole batch: these are siblings of the same story, so
        // per-task dates would be a lot of controls for a rare need.
        '<div class="sd-due-row">' +
          '<label class="sd-due-label" for="sdDueDate">Due date <span class="sd-due-opt">optional</span></label>' +
          '<input type="date" id="sdDueDate" class="sd-due-input" value="' + escHtmlTask(this.dueDate || '') + '" />' +
        '</div>' +
        '<div class="btn-row">' +
          '<button class="btn ghost compact" data-sd-action="back-questions" type="button">Back</button>' +
          '<button class="btn ghost compact" data-sd-action="create-tyne" type="button">Create in Tyne</button>' +
          '<button class="btn primary compact" data-sd-action="create-both" type="button">Create in ' + escHtmlTask(toolLabel) + ' + Tyne</button>' +
        '</div>';
    },

    _renderSuccess(msg) {
      const created = Array.isArray(msg.createdInPm) ? msg.createdInPm : [];
      const toolLabel = TOOL_LABEL[msg.tool] || 'PM tool';
      const notes =
        (created.length
          ? '<div class="sd-subhead sd-subhead-ok">' + sdIcon('check') + 'Created ' + created.length +
            ' sub-task' + (created.length === 1 ? '' : 's') + ' in ' + escHtmlTask(toolLabel) + '</div>'
          : '<div class="sd-subhead">Saved in Tyne only — not pushed to ' + escHtmlTask(toolLabel) + '.</div>') +
        (msg.pmError ? '<div class="notice warn">' + escHtmlTask(toolLabel) + ' creation failed: ' + escHtmlTask(msg.pmError) + '</div>' : '');
      this.tasks = Array.isArray(msg.tasks) ? msg.tasks : [];
      this._renderPicker('Tasks created', notes);
    },

    // Existing decomposition reopened from the task drawer.
    onExisting(msg) {
      if (!msg.taskId) { return; }
      this._stopProgress();
      this.taskId = msg.taskId;
      this.tool = msg.tool || 'jira';
      this.phase = 'picker';
      this.tasks = Array.isArray(msg.tasks) ? msg.tasks : [];
      if (!this.tasks.length) { return; }
      this._renderPicker('Tasks from this epic',
        '<div class="sd-subhead">Already decomposed into ' + this.tasks.length + ' task' +
        (this.tasks.length === 1 ? '' : 's') + '. Pick one to start.</div>');
    },

    /**
     * Task picker — the generated tasks in recommended order. Blocked tasks are
     * still startable (the order is advice, not a lock) but say what they wait on.
     */
    _renderPicker(title, notesHtml) {
      const p = this.panel();
      if (!p) { return; }
      this.phase = 'picker';
      p.classList.remove('hidden');
      const rows = this.tasks.map(t => {
        const blocked = Array.isArray(t.blockedBy) && t.blockedBy.length;
        const meta = [
          t.pmKey ? escHtmlTask(t.pmKey) : '',
          t.estimatedHours ? escHtmlTask(String(t.estimatedHours)) + 'h' : '',
          blocked ? 'after ' + escHtmlTask(t.blockedBy.join(', ')) : 'ready to start',
        ].filter(Boolean).join(' · ');
        return '<div class="sd-pick-row' + (blocked ? ' sd-pick-blocked' : '') + '">' +
          '<span class="sd-pick-order">' + escHtmlTask(String(t.order || '')) + '</span>' +
          '<span class="sd-pick-body">' +
            '<span class="sd-pick-title">' + escHtmlTask(t.title) + '</span>' +
            '<span class="sd-pick-meta">' + meta + '</span>' +
          '</span>' +
          '<button class="btn ghost compact sd-pick-btn" data-sd-action="start-task" ' +
            'data-pm-key="' + escHtmlTask(t.pmKey || '') + '" ' +
            'data-title="' + escHtmlTask(t.title) + '" type="button">Start</button>' +
        '</div>';
      }).join('');
      p.innerHTML =
        '<div class="sd-head">' + escHtmlTask(title) + '</div>' +
        (notesHtml || '') +
        '<div class="sd-pick-list">' + rows + '</div>' +
        '<div class="sd-subhead sd-note-quiet">Starting one task parks the rest here — nothing is lost.</div>' +
        '<div class="btn-row">' +
          '<button class="btn ghost compact" data-sd-action="regenerate" type="button">Regenerate</button>' +
          '<button class="btn ghost compact" data-sd-action="close" type="button">Close</button>' +
        '</div>';
    },

    onClick(e) {
      const btn = e.target.closest('[data-sd-action]');
      if (!btn) { return; }
      const action = btn.dataset.sdAction;
      if (action === 'cancel') {
        // From the questions phase "Back" returns to the story card; from a
        // loading phase it aborts the run.
        this.cancel();
      }
      else if (action === 'close') { this.reset(); }
      else if (action === 'retry') { const t = this.taskId, tool = this.tool; this.start(t, tool); }
      else if (action === 'generate') { this.generate(); }
      else if (action === 'back-questions') {
        if (this.questions.length) { this.phase = 'questions'; this._renderQuestions(); }
        else { this.cancel(); }
      }
      else if (action === 'create-tyne') { this.create(false); }
      else if (action === 'create-both') { this.create(true); }
      else if (action === 'start-task') {
        vscode.postMessage({
          type: 'storyDecomposeStartTask',
          parentTaskId: this.taskId,
          pmKey: btn.dataset.pmKey || '',
          title: btn.dataset.title || '',
        });
      }
      else if (action === 'regenerate') {
        vscode.postMessage({ type: 'storyDecomposeRegenerate', taskId: this.taskId, tool: this.tool });
        this.phase = 'analyzing';
        this._renderQuiet('Re-analyzing story…');
      }
    },

    onChange(e) {
      const input = e.target;
      if (input && input.classList && input.classList.contains('sd-custom-input')) {
        const id = input.getAttribute('data-sd-custom');
        if (id) { this.customNotes[id] = input.value; }
        return;
      }
      if (!input || input.type !== 'radio' || !input.name || input.name.indexOf('sdq_') !== 0) { return; }
      this.answers[input.name.slice(4)] = input.value;
    },
  };

  const tasksMgr = {

    _presets: [],
    _canWrite: false,
    _canCreate: false,
    _canEdit: false,
    _canAddSubtask: false,
    _canAddComment: true,
    _activeFilters: {},
    _currentTaskSnapshot: null,
    _editingTaskId: null,
    _editingTaskTool: null,
    _lastSyncSummary: {},

    onDataLoaded(msg) {
      _tasksAll = msg.tasks || [];
      syncConnectedToolsFromPayload(msg);
      _tasksTier = msg.tier || 'free';
      _tasksIsFreeTier = !!msg.isFreeTier;
      this._canWrite = !!msg.canWrite;
      this._presets = msg.presets || [];
      const summary = msg.syncSummary || {};
      this._lastSyncSummary = summary;
      this.renderConnectionState();
      this.renderWorkspaceSelector();
      this.renderSyncStatus(summary);
      renderIntegrations();
      renderPmConnectButtons();
      this.renderPresetMenu();
      this.applyWriteGating();
      if (msg.defaultPreset) { this.applyPresetToUI(msg.defaultPreset); }
      this.runQuery();
      renderThreadTaskPicker();
      syncThreadCreateTasksCta();
    },

    setSyncStatus(status, label) {
      const dot = $('taskSyncDot');
      const syncBtn = $('pullTasksBtn');
      if (dot) { dot.className = 'sync-dot ' + (status || ''); dot.title = label || '—'; }
      if (syncBtn) { syncBtn.title = label || 'Sync tasks'; }
    },

    renderSyncStatus(summary) {
      const states = summary.syncStates || [];
      const anyAuthFailed = states.some(s => s.syncStatus === 'failed' && isReconnectSyncError(s.errorMessage || ''));
      const anyFailed = states.some(s => s.syncStatus === 'failed');
      const anySyncing = states.some(s => s.syncStatus === 'syncing');
      const allOnline = states.length > 0 && states.every(s => s.syncStatus === 'online');
      const lastSynced = summary.lastOnlineAt ? fmtRelative(summary.lastOnlineAt) : null;
      const total = summary.totalCached || 0;

      let status = 'idle', label = '—';
      const failedState = states.find(s => s.syncStatus === 'failed');
      if (anySyncing) { status = 'syncing'; label = 'Syncing…'; }
      else if (anyAuthFailed) { status = 'failed'; label = 'Reconnect required'; }
      else if (anyFailed) {
        status = 'warning';
        label = (failedState && failedState.errorMessage) ? String(failedState.errorMessage) : 'Connected · sync issue';
      }
      else if (allOnline) {
        const emptyAssigned = states.find(s => s.errorMessage && /no open jira issues assigned/i.test(s.errorMessage));
        if (emptyAssigned && emptyAssigned.errorMessage) {
          status = 'online';
          label = String(emptyAssigned.errorMessage);
        } else {
          status = 'online';
          label = lastSynced ? `Synced ${lastSynced}` : 'Online';
        }
      }
      else if (!_tasksConnectedTools.length) { status = 'offline'; label = 'No tool connected'; }
      else { status = 'offline'; label = lastSynced ? `Last synced ${lastSynced}` : 'Offline'; }

      this.setSyncStatus(status, `${label}${total > 0 ? ' · ' + total + ' cached' : ''}`);
      this.renderJiraHeaderDot(summary);
    },

    renderJiraHeaderDot(summary) {
      const dot = $('jiraHeadDot');
      const badge = $('jiraHeadStatus');
      if (!dot || !badge) { return; }
      const states = Array.isArray(summary.syncStates) ? summary.syncStates : [];
      const jiraState = states.find(state => state.sourceTool === 'jira') || null;
      let cls = 'is-grey';
      let label = 'Jira not configured';

      if (!jiraIntegration.configured) {
        label = 'Connect Jira and choose a project';
      } else if (jiraIntegration.connected && jiraState && jiraState.syncStatus === 'failed' && isReconnectSyncError(jiraState.errorMessage || '')) {
        cls = 'is-red';
        label = 'Jira session needs reconnect.';
      } else if (jiraIntegration.connected) {
        cls = 'is-green';
        label = jiraState && jiraState.syncStatus === 'failed' ? 'Jira connected. Task refresh needs attention.' : 'Jira connected';
      }

      dot.className = `jira-head-dot ${cls}`;
      badge.title = label;
    },

    renderConnectionState() {
      const connectCard = $('taskConnectCard');
      const toolsRow = $('taskToolsRow');
      const controls = $('taskControls');
      const tierNotice = $('taskTierNotice');

      const hasTools = _tasksConnectedTools.length > 0;
      if (connectCard) { connectCard.classList.toggle('hidden', hasTools); }
      if (toolsRow) { toolsRow.classList.add('hidden'); }
      if (controls) { controls.classList.toggle('hidden', !hasTools); }
      if (tierNotice) { tierNotice.classList.add('hidden'); }
      // Make the active task scope explicit. Tyne pulls "assigned to me" tasks,
      // so label the list accordingly whenever a PM tool is connected.
      const scopeLabel = $('taskScopeLabel');
      if (scopeLabel) { scopeLabel.classList.toggle('hidden', !hasTools); }

      const pmSelect = $('pmToolSelect');
      if (pmSelect && _tasksIsFreeTier && _tasksConnectedTools.length === 1) {
        Array.from(pmSelect.options).forEach(opt => {
          if (opt.value && opt.value !== _tasksConnectedTools[0]) { opt.disabled = true; }
        });
      }

      const taskSourceFilter = $('taskSourceFilter');
      if (taskSourceFilter && _tasksIsFreeTier && _tasksConnectedTools.length === 1) {
        Array.from(taskSourceFilter.options).forEach(opt => {
          if (opt.value && opt.value !== _tasksConnectedTools[0]) { opt.disabled = true; }
        });
      }

      this.renderToolBadges();
    },

    renderWorkspaceSelector() {
      const row = $('taskWorkspaceRow');
      const select = $('taskWorkspaceSelect');
      if (!row || !select) { return; }
      const connected = Array.isArray(_tasksConnectedTools) ? _tasksConnectedTools.filter(t => t === 'jira' || t === 'linear') : [];
      row.classList.toggle('hidden', connected.length === 0);
      const current = select.value || '';
      const options = ['<option value="">All connected workspaces</option>'].concat(
        connected.map(tool => '<option value="' + escHtmlTask(tool) + '">' + escHtmlTask(workspaceOptionLabel(tool)) + '</option>')
      );
      select.innerHTML = options.join('');
      select.value = connected.includes(current) ? current : '';
    },

    renderToolBadges() {
      const el = $('taskToolsBadges');
      if (!el) { return; }
      el.innerHTML = _tasksConnectedTools.map(t =>
        `<span class="tool-badge">
          <span class="tool-badge-disc"></span>
          ${escHtmlTask(TOOL_LABEL[t] || t)}
          <button class="tool-badge-disconnect" data-tool="${t}" title="Disconnect ${t}">×</button>
        </span>`
      ).join('');
    },

    runQuery() {
      const q = ($('taskSearchInput') || {}).value || '';
      const source = ($('taskSourceFilter') || {}).value || '';
      const workspaceSource = ($('taskWorkspaceSelect') || {}).value || '';
      const sortVal = ($('taskSortSelect') || {}).value || 'recommended:desc';
      const [sortKey, sortDir] = sortVal.split(':');

      if (!_tasksIsFreeTier) {
        const filters = Object.assign({}, this._activeFilters);
        if (workspaceSource) { filters.sourceTools = [workspaceSource]; }
        else if (source) { filters.sourceTools = [source]; }
        const sort = { rules: [{ key: sortKey, direction: sortDir }] };
        vscode.postMessage({ type: 'queryTasksAdvanced', query: q, filters, sort });
      } else {
        const filters = {};
        if (workspaceSource) { filters.sourceTools = [workspaceSource]; }
        else if (source) { filters.sourceTools = [source]; }
        vscode.postMessage({ type: 'queryTasks', query: q, filters, sort: { key: sortKey, direction: sortDir } });
      }
    },

    applyWriteGating() {
      const canCreate = this._canWrite && this._canCreate !== false;
      const canEdit = this._canWrite && this._canEdit !== false;
      const newTaskBtn = $('newTaskBtn');
      const newTaskSep = $('newTaskSep');
      if (newTaskBtn) { newTaskBtn.classList.toggle('hidden', !canCreate); }
      if (newTaskSep) { newTaskSep.classList.toggle('hidden', !canCreate); }
      const addSubRow = $('addSubtaskRow');
      if (addSubRow) { addSubRow.classList.toggle('hidden', !(this._canWrite && this._canAddSubtask)); }
      const addCmtRow = $('addCommentRow');
      if (addCmtRow) { addCmtRow.classList.toggle('hidden', !(this._canWrite && this._canAddComment !== false)); }
      const tdEditBtn = $('tdEditBtn');
      if (tdEditBtn) {
        tdEditBtn.style.opacity = canEdit ? '' : '0.45';
        tdEditBtn.title = canEdit ? '' : (this._canWrite ? 'This PM tool cannot edit tasks yet' : 'Requires Pro or Max');
      }
      const upgradeNotice = $('tfpUpgradeNotice');
      const savePresetBtn = $('savePresetBtn');
      if (upgradeNotice) { upgradeNotice.classList.toggle('hidden', !_tasksIsFreeTier); }
      if (savePresetBtn) { savePresetBtn.classList.toggle('hidden', _tasksIsFreeTier); }
    },

    collectAdvancedFilters() {
      const statuses = Array.from(document.querySelectorAll('#tfpStatuses input:checked')).map(el => el.value);
      const priorities = Array.from(document.querySelectorAll('#tfpPriorities input:checked')).map(el => el.value);
      const dueDate = ($('tfpDueDate') || {}).value || '';
      const updated = ($('tfpUpdated') || {}).value || '';
      const hasBranch = ($('tfpHasBranch') || {}).checked;
      const hasCommits = ($('tfpHasCommits') || {}).checked;
      const hasTime = ($('tfpHasTime') || {}).checked;
      const f = {};
      if (statuses.length) { f.statuses = statuses; }
      if (priorities.length) { f.priorities = priorities; }
      if (dueDate) { f.dueDatePreset = dueDate; }
      if (updated) { f.updatedPreset = updated; }
      if (hasBranch) { f.hasBranch = true; }
      if (hasCommits) { f.hasCommits = true; }
      if (hasTime) { f.hasTimeTracked = true; }
      return f;
    },

    renderFilterChips() {
      const chipsRow = $('taskChipsRow');
      const chips = $('taskChips');
      const gearBtn = $('taskGearBtn');
      if (!chips || !chipsRow) { return; }
      const f = this._activeFilters;
      const src = ($('taskSourceFilter') || {}).value || '';
      const parts = [];
      if (src) { parts.push({ label: src, key: '_source' }); }
      if (f.statuses && f.statuses.length) { parts.push({ label: f.statuses.join(', '), key: 'statuses' }); }
      if (f.priorities && f.priorities.length) { parts.push({ label: f.priorities.join(', '), key: 'priorities' }); }
      if (f.dueDatePreset && f.dueDatePreset !== 'none') { parts.push({ label: 'Due: ' + f.dueDatePreset, key: 'dueDatePreset' }); }
      if (f.updatedPreset && f.updatedPreset !== 'none') { parts.push({ label: f.updatedPreset, key: 'updatedPreset' }); }
      if (f.hasBranch) { parts.push({ label: 'branch', key: 'hasBranch' }); }
      if (f.hasCommits) { parts.push({ label: 'commits', key: 'hasCommits' }); }
      if (f.hasTimeTracked) { parts.push({ label: 'time', key: 'hasTimeTracked' }); }
      chipsRow.classList.toggle('hidden', parts.length === 0);
      if (gearBtn) { gearBtn.classList.toggle('gear-active', parts.length > 0); }
      chips.innerHTML = parts.map(p =>
        `<span class="filter-chip">${escHtmlTask(p.label)}<button class="chip-remove" data-chip-key="${p.key}" title="Remove filter">&times;</button></span>`
      ).join('');
    },

    renderPresetMenu() {
      const items = $('presetMenuItems');
      if (!items) { return; }
      if (!this._presets.length) { items.innerHTML = ''; return; }
      items.innerHTML = this._presets.map(p =>
        `<div class="preset-row">
          <button class="gear-text-btn preset-apply-btn" data-preset-id="${p.id}">${escHtmlTask(p.name)}${p.isDefault ? ' \u2605' : ''}</button>
          <button class="preset-delete-btn" data-preset-id="${p.id}" title="Delete">&times;</button>
        </div>`
      ).join('');
    },

    applyPresetToUI(preset) {
      if (!preset) { return; }
      this._activeFilters = Object.assign({}, preset.filters || {});
      const search = $('taskSearchInput');
      if (search && preset.query) { search.value = preset.query; }
      if (preset.sort && preset.sort.rules && preset.sort.rules[0]) {
        const rule = preset.sort.rules[0];
        const sortSel = $('taskSortSelect');
        if (sortSel) { sortSel.value = rule.key + ':' + rule.direction; }
      }
      this.renderFilterChips();
      this.runQuery();
    },

    showQueryErrors(errors) {
      const bar = $('queryErrorBar');
      const txt = $('queryErrorText');
      if (!bar || !txt) { return; }
      if (!errors || !errors.length) { bar.classList.add('hidden'); return; }
      bar.classList.remove('hidden');
      txt.textContent = 'Query: ' + errors.join(' · ');
    },

    openEditDrawer(task) {
      if (!this._canWrite) {
        const n = $('editUpgradeNotice'); if (n) { n.classList.remove('hidden'); }
        return;
      }
      this._editingTaskId = task.id;
      this._editingTaskTool = task.sourceTool;
      const t = $('editTaskTitle'); if (t) { t.value = task.title || ''; }
      const s = $('editTaskStatus'); if (s) { s.value = task.normalizedStatus || 'todo'; }
      const p = $('editTaskPriority'); if (p) { p.value = task.normalizedPriority || 'medium'; }
      const d = $('editTaskDueDate'); if (d) { d.value = task.dueDate ? task.dueDate.slice(0,10) : ''; }
      const desc = $('editTaskDescription'); if (desc) { desc.value = task.description || ''; }
      const drawer = $('taskEditDrawer'); if (drawer) { drawer.classList.remove('hidden'); }
      vscode.postMessage({ type: 'detectConflict', taskId: task.id, tool: task.sourceTool });
    },

    closeEditDrawer() {
      const drawer = $('taskEditDrawer'); if (drawer) { drawer.classList.add('hidden'); }
      const err = $('editTaskError'); if (err) { err.classList.add('hidden'); }
      this._editingTaskId = null; this._editingTaskTool = null;
    },

    submitEdit() {
      const taskId = this._editingTaskId;
      const sourceTool = this._editingTaskTool;
      if (!taskId || !sourceTool) { return; }
      const title = ($('editTaskTitle') || {}).value || '';
      const status = ($('editTaskStatus') || {}).value || 'todo';
      const priority = ($('editTaskPriority') || {}).value || 'medium';
      const dueDate = ($('editTaskDueDate') || {}).value || undefined;
      const description = ($('editTaskDescription') || {}).value || undefined;
      vscode.postMessage({ type: 'updateTask', taskId, sourceTool, input: { title, status, priority, dueDate, description } });
    },

    openCreateDrawer() {
      if (!this._canWrite) {
        const n = $('createUpgradeNotice'); if (n) { n.classList.remove('hidden'); }
        return;
      }
      const connected = _tasksConnectedTools;
      const sel = $('createTaskTool');
      if (sel && connected.length) {
        Array.from(sel.options).forEach(opt => { opt.disabled = !connected.includes(opt.value); });
        if (!connected.includes(sel.value) && connected.length) { sel.value = connected[0]; }
      }
      const drawer = $('taskCreateDrawer'); if (drawer) { drawer.classList.remove('hidden'); }
    },

    closeCreateDrawer() {
      const drawer = $('taskCreateDrawer'); if (drawer) { drawer.classList.add('hidden'); }
      const err = $('createTaskError'); if (err) { err.classList.add('hidden'); }
    },

    submitCreate() {
      const tool = ($('createTaskTool') || {}).value;
      const title = ($('createTaskTitle') || {}).value || '';
      if (!tool || !title.trim()) {
        const err = $('createTaskError'); if (err) { err.classList.remove('hidden'); err.textContent = 'Title is required.'; }
        return;
      }
      const desc = ($('createTaskDesc') || {}).value || undefined;
      const status = ($('createTaskStatus') || {}).value || 'todo';
      const priority = ($('createTaskPriority') || {}).value || 'medium';
      const dueDate = ($('createTaskDueDate') || {}).value || undefined;
      vscode.postMessage({ type: 'createTask', input: { sourceTool: tool, title: title.trim(), description: desc, status, priority, dueDate } });
    },

    showConflict(conflict) {
      const banner = $('taskConflictBanner');
      const msg = $('taskConflictMsg');
      if (!banner || !conflict) { return; }
      if (msg) { msg.textContent = conflict.message || 'This task changed externally. Reload before saving?'; }
      this._currentTaskSnapshot = conflict.latestPmSnapshot || null;
      banner.classList.remove('hidden');
    },

    hideConflict() { const b = $('taskConflictBanner'); if (b) { b.classList.add('hidden'); } },

    renderTaskList(tasks) {
      const list = $('taskList');
      const empty = $('taskListEmpty');
      if (!list) { return; }
      if (!tasks || !tasks.length) {
        list.innerHTML = '';
        if (empty) {
          const jiraState = ((this._lastSyncSummary || {}).syncStates || []).find(s => s.sourceTool === 'jira');
          const syncErr = jiraState && jiraState.errorMessage ? String(jiraState.errorMessage) : '';
          empty.classList.add('task-empty-state');
          if (jiraState && jiraState.syncStatus === 'failed' && syncErr) {
            empty.innerHTML = '<div>' + escHtmlTask(syncErr) + '</div><div class="task-empty-actions">'
              + '<button class="btn primary compact" type="button" data-task-empty-action="reconnect-jira">Reconnect Jira</button>'
              + '<button class="btn ghost compact" type="button" data-task-empty-action="change-jira-project">Change Project</button>'
              + '<button class="btn ghost compact" type="button" data-task-empty-action="refresh-tasks">Refresh</button>'
              + '</div>';
          } else if (/no open jira issues assigned/i.test(syncErr)) {
            empty.innerHTML = '<div>No open Jira issues assigned to you.</div><div class="task-empty-actions">'
              + '<button class="btn primary compact" type="button" data-task-empty-action="refresh-tasks">Refresh tasks</button>'
              + '<button class="btn ghost compact" type="button" data-task-empty-action="change-jira-project">Change Project</button>'
              + '</div>';
          } else if (!jiraIntegration.selectedProject && jiraIntegration.connected) {
            empty.innerHTML = '<div>Jira is connected, but no project is selected.</div><div class="task-empty-actions">'
              + '<button class="btn primary compact" type="button" data-task-empty-action="change-jira-project">Change Project</button>'
              + '<button class="btn ghost compact" type="button" data-task-empty-action="refresh-tasks">Refresh</button>'
              + '</div>';
          } else {
            empty.innerHTML = _tasksConnectedTools.length
              ? '<div>No tasks match your filters.</div><div class="task-empty-actions">'
                + '<button class="btn primary compact" type="button" data-task-empty-action="clear-filters">Clear filters</button>'
                + '<button class="btn ghost compact" type="button" data-task-empty-action="refresh-tasks">Refresh</button>'
                + '</div>'
              : '<div>Connect Jira or Linear to pull your tasks.</div><div class="task-empty-actions">'
                + '<button class="btn primary compact" type="button" data-task-empty-action="connect-linear">Connect Linear</button>'
                + '<button class="btn ghost compact" type="button" data-task-empty-action="connect-jira">Connect Jira</button>'
                + '</div>';
          }
          empty.style.display = '';
        }
        return;
      }
      if (empty) { empty.style.display = 'none'; }
      list.innerHTML = _tasksRankMode ? this.renderQueueBands(tasks) : this.renderTaskGroups(tasks);
    },

    /**
     * Recommended mode: lead with the single task to start, then the short
     * queue behind it. Everything else keeps the familiar project grouping, so
     * the list is still a complete view rather than a filtered one.
     */
    renderQueueBands(tasks) {
      const isDone = t => t.normalizedStatus === 'done' || t.normalizedStatus === 'canceled';
      const band = name => tasks.filter(t => !isDone(t) && t.queueBand === name);
      const now = band('now');
      const next = band('next');
      const blocked = band('blocked');
      // Anything without a recognised band falls through to "everything else"
      // rather than vanishing — an unranked payload must never empty the list.
      const banded = new Set(['now', 'next', 'blocked']);
      const rest = tasks.filter(t => !isDone(t) && !banded.has(t.queueBand));
      const done = tasks.filter(isDone);

      const bandSection = (title, hint, list, cls) => {
        if (!list.length) { return ''; }
        return `<section class="task-band-group ${cls}">
          <div class="task-band-summary">
            <span class="task-band-title">${escHtmlTask(title)}</span>
            ${hint ? `<span class="task-band-hint">${escHtmlTask(hint)}</span>` : ''}
            <span class="task-group-count">${list.length}</span>
          </div>
          <div class="task-group-body">${list.map(t => this.renderTaskCard(t)).join('')}</div>
        </section>`;
      };

      let html = '';
      html += bandSection('Start here', now.length && now[0].id === _activeTaskId ? 'Active thread' : '', now, 'band-now');
      html += bandSection('Up next', '', next, 'band-next');
      if (rest.length) {
        html += `<details class="task-band-group band-later" open>
          <summary class="task-band-summary">
            <span class="task-band-title">Later</span>
            <span class="task-group-count">${rest.length}</span>
          </summary>
          <div class="task-group-body">${this.renderTaskGroups(rest, true)}</div>
        </details>`;
      }
      if (blocked.length) {
        html += `<details class="task-band-group band-blocked">
          <summary class="task-band-summary">
            <span class="task-band-title">Blocked</span>
            <span class="task-group-count">${blocked.length}</span>
          </summary>
          <div class="task-group-body">${blocked.map(t => this.renderTaskCard(t)).join('')}</div>
        </details>`;
      }
      if (done.length) {
        html += `<details class="task-done-group">
          <summary class="task-project-summary task-done-summary">
            <span>Done</span>
            <span class="task-group-count">${done.length}</span>
          </summary>
          <div class="task-group-body">${done.map(t => this.renderTaskCard(t)).join('')}</div>
        </details>`;
      }
      return html;
    },

    renderTaskGroups(tasks, pendingOnly) {
      const isDone = t => t.normalizedStatus === 'done' || t.normalizedStatus === 'canceled';
      const pending = tasks.filter(t => !isDone(t));
      const done = pendingOnly ? [] : tasks.filter(isDone);

      const projectGroupsHtml = list => {
        const grouped = new Map();
        list.forEach(task => {
          const project = task.sourceProject || TOOL_LABEL[task.sourceTool] || 'Tasks';
          const group = grouped.get(project) || [];
          group.push(task);
          grouped.set(project, group);
        });
        return Array.from(grouped.entries()).map(([project, projectTasks]) =>
          `<section class="task-project-group">
            <div class="task-project-summary">
              <span>${escHtmlTask(project)}</span>
              <span class="task-group-count">${projectTasks.length}</span>
            </div>
            <div class="task-group-body">${projectTasks.map(t => this.renderTaskCard(t)).join('')}</div>
          </section>`
        ).join('');
      };

      // Active work first. Done stays collapsed so old tickets don't crowd the list.
      let html = projectGroupsHtml(pending);
      if (done.length) {
        html += `<details class="task-done-group">
          <summary class="task-project-summary task-done-summary">
            <span>Done</span>
            <span class="task-group-count">${done.length}</span>
          </summary>
          <div class="task-group-body">${done.map(t => this.renderTaskCard(t)).join('')}</div>
        </details>`;
      }
      return html;
    },

    renderTaskCard(t) {
      const updated = t.updatedAt ? fmtRelative(t.updatedAt) : '';
      const toolState = Array.isArray(this._lastSyncSummary.syncStates)
        ? this._lastSyncSummary.syncStates.find(state => state.sourceTool === t.sourceTool)
        : null;
      const cachedLabel = t.isCachedOnly && t.sourceTool === 'jira' && toolState && toolState.syncStatus === 'offline' ? 'Offline' : 'Cached';
      const cached = t.isCachedOnly ? cachedLabel : '';
      const key = t.externalId && t.externalId !== t.title ? t.externalId : '';
      const tool = TOOL_LABEL[t.sourceTool] || t.sourceTool || '';
      // No assignee: pulls are assigned-to-me, so it repeated the same name on
      // every row. No due date here either — it gets a semantic chip up top.
      const meta = [key, tool, updated, cached].filter(Boolean).join(' · ');
      const isActive = t.id === _activeTaskId;
      const statusLabel = STATUS_LABELS[t.normalizedStatus] || t.status || 'Open';
      // Type pill only when it changes what starting means (Epic/Story → Split).
      // A "Task" pill on nearly every row was label noise.
      const typeCls = issueTypeClass(t.issueType);
      const parentType = typeCls === 'epic' || typeCls === 'story';
      const terminal = t.normalizedStatus === 'done' || t.normalizedStatus === 'canceled';
      // The "why" line is what turns a reordered list into a decision the
      // developer can check — never show rank without it. Only the lead card
      // carries it. Status is a quiet dot now, so status reasons stay in.
      const why = t.queueBand === 'now' ? queueWhyLine(t, { priority: true, status: false }) : '';
      return `<div class="task-card${isActive ? ' active' : ''}${t.isCachedOnly ? ' cached-only' : ''}${t.queueBand === 'now' ? ' queue-now' : ''}"
        data-task-id="${escHtmlTask(t.id)}"
        data-task-tool="${escHtmlTask(t.sourceTool)}"
        data-task-ext-id="${escHtmlTask(t.externalId)}"
        data-task-title="${escHtmlTask(t.title)}">
        <div class="tc-row">
          <span class="tc-dot ${escHtmlTask(t.normalizedStatus || 'unknown')}" title="${escHtmlTask(statusLabel)}"></span>
          ${priorityChip(t.normalizedPriority)}
          ${parentType ? issueTypePill(t.issueType) : ''}
          <span class="task-card-title">${escHtmlTask(t.title)}</span>
          ${dueChip(t.dueDate)}
          ${terminal ? '' : `<button class="tc-start" type="button" tabindex="-1"
            data-task-start="${escHtmlTask(t.id)}" data-task-tool="${escHtmlTask(t.sourceTool)}"${parentType ? ' data-task-decompose="1"' : ''}
            title="${parentType ? 'Split into tasks' : 'Start a thread on this task'}">${parentType ? 'Split' : 'Start'}</button>`}
        </div>
        ${meta ? `<div class="task-card-meta">${escHtmlTask(meta)}</div>` : ''}
        ${why ? `<div class="task-card-why">${escHtmlTask(why)}</div>` : ''}
      </div>`;
    },

    onDetailLoaded(details, offline) {
      if (!details) {
        if (offline) { this.showDetailError('You are offline. Showing cached data only.'); }
        else { this.showDetailError('Task details unavailable.'); }
        return;
      }
      _activeTaskId = details.id;
      _activeTaskTool = details.sourceTool;
      _detailCommentCount = 3;
      _detailDescExpanded = false;
      this.renderDetail(details, offline);
      this.runQuery();
    },

    onDetailError(msg) {
      this.showDetailError(msg || 'Could not load task details.');
    },

    showDetailError(msg) {
      const drawer = $('taskDetailDrawer');
      if (drawer) {
        drawer.classList.remove('hidden');
        const title = $('taskDetailTitle');
        if (title) { title.textContent = 'Error'; }
        const desc = $('taskDetailDesc');
        if (desc) { desc.textContent = msg; }
      }
    },

    renderDetail(d, offline) {
      const drawer = $('taskDetailDrawer');
      if (!drawer) { return; }
      drawer.classList.remove('hidden');
      drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      const detailsBody = $('taskDetailsBody');
      const detailsToggle = $('taskDetailsToggle');
      if (detailsBody) { detailsBody.classList.add('hidden'); }
      if (detailsToggle) { detailsToggle.textContent = '\u25b8 Details'; }

      const set = (id, html) => { const el = $(id); if (el) { el.innerHTML = html; } };
      const setText = (id, t) => { const el = $(id); if (el) { el.textContent = t; } };

      setText('taskDetailTitle', d.title || '—');

      const metaItems = [
        d.externalId ? `<span class="task-detail-key">${escHtmlTask(d.externalId)}</span>` : '',
        issueTypePill(d.issueType),
        toolBadge(d.sourceTool),
        statusBadge(d.normalizedStatus),
        d.normalizedPriority && d.normalizedPriority !== 'none' ? priorityBadge(d.normalizedPriority) : '',
      ].filter(Boolean).join(' ');
      const metaRows = [
        d.assigneeName ? `Assignee: ${escHtmlTask(d.assigneeName)}` : '',
        d.dueDate ? `Due: ${fmtDate(d.dueDate)}` : '',
        d.sourceProject ? `Project: ${escHtmlTask(d.sourceProject)}` : '',
        d.parentKey ? `Parent: ${escHtmlTask(d.parentKey)}${d.parentTitle ? ' · ' + escHtmlTask(d.parentTitle) : ''}` : '',
        offline ? '<em>Offline — showing cached</em>' : '',
      ].filter(Boolean).join(' · ');
      set('taskDetailMeta', `<div class="tm-row">${metaItems}</div>${metaRows ? `<div class="tm-sub">${metaRows}</div>` : ''}`);

      const desc = $('taskDetailDesc');
      const descToggle = $('taskDetailDescToggle');
      if (desc) {
        const labelHtml = Array.isArray(d.labels) && d.labels.length
          ? `<div class="task-card-labels" style="margin-bottom:8px">${d.labels.map(label => `<span class="filter-chip">${escHtmlTask(label)}</span>`).join('')}</div>`
          : '';
        desc.innerHTML = labelHtml + this.safeMarkdown(d.description || '<em>No description.</em>');
        desc.classList.remove('expanded');
        _detailDescExpanded = false;
        if (desc.scrollHeight > 124 && descToggle) { descToggle.classList.remove('hidden'); }
        else if (descToggle) { descToggle.classList.add('hidden'); }
      }

      const subSec = $('taskDetailSubtasksSection');
      const subEl = $('taskDetailSubtasks');
      if (subSec && subEl) {
        const subs = d.subtasks || [];
        if (subs.length) {
          subSec.classList.remove('hidden');
          subEl.innerHTML = subs.map(s => {
            const done = s.normalizedStatus === 'done';
            const meta = [s.assigneeName, s.dueDate ? fmtDate(s.dueDate) : ''].filter(Boolean).join(' · ');
            return `<div class="subtask-row">
              <span class="subtask-check">${done ? '✓' : '○'}</span>
              <span class="subtask-title${done ? ' done' : ''}">${escHtmlTask(s.title)}</span>
              ${meta ? `<span class="subtask-meta">${escHtmlTask(meta)}</span>` : ''}
            </div>`;
          }).join('');
        } else { subSec.classList.add('hidden'); }
      }

      this.renderComments(d.comments || []);

      const histSec = $('taskDetailHistorySection');
      const histEl = $('taskDetailHistory');
      if (histSec && histEl) {
        const hist = d.historyLast30Days || [];
        // Only show when the PM tool actually returns history — empty/unavailable is noise.
        if (hist.length) {
          histSec.classList.remove('hidden');
          histEl.innerHTML = hist.map(h => {
            const body = h.fromValue && h.toValue
              ? `${escHtmlTask(h.type)}: ${escHtmlTask(h.fromValue)} → ${escHtmlTask(h.toValue)}`
              : escHtmlTask(h.title || h.type);
            return `<div class="history-row">
              <span class="history-icon">○</span>
              <span class="history-body">${body}${h.actorName ? ` <em>by ${escHtmlTask(h.actorName)}</em>` : ''}</span>
              <span class="history-time">${h.createdAt ? fmtRelative(h.createdAt) : ''}</span>
            </div>`;
          }).join('');
        } else {
          histSec.classList.add('hidden');
          histEl.innerHTML = '';
        }
      }

      const startBtn = $('taskDetailStartThreadBtn');
      if (startBtn) {
        startBtn.dataset.taskId = d.id;
        startBtn.dataset.taskTitle = d.title;
        startBtn.dataset.taskTool = d.sourceTool;
        // Use a distinct data attribute so the delegated external-open handler
        // (which matches button[data-task-url]) does not open Jira when this
        // button is clicked — the Start Thread button must navigate internally.
        startBtn.dataset.taskSourceUrl = d.sourceUrl || '';
        // Stories and Epics get decomposed into technical tasks instead of
        // starting a thread directly.
        const decomposable = isDecomposableType(d.issueType);
        startBtn.dataset.decompose = decomposable ? '1' : '';
        startBtn.innerHTML = decomposable
          ? sdIcon('sparkle') + (issueTypeClass(d.issueType) === 'epic'
            ? 'Create tasks from epic'
            : 'Create tasks from stories')
          : sdIcon('play') + 'Start thread';
      }
      // Opening a different task closes any in-flight decomposition UI.
      if (storyDecompose.taskId && storyDecompose.taskId !== d.id) { storyDecompose.reset(); }
      const tdCopyIdBtn = $('tdCopyIdBtn');
      if (tdCopyIdBtn) { tdCopyIdBtn.dataset.taskId = d.externalId || d.id; }
      const tdCopyLinkBtn = $('tdCopyLinkBtn');
      if (tdCopyLinkBtn) { tdCopyLinkBtn.dataset.url = d.sourceUrl || ''; }
      const tdRefreshBtn = $('tdRefreshBtn');
      if (tdRefreshBtn) { tdRefreshBtn.dataset.taskId = d.id; tdRefreshBtn.dataset.tool = d.sourceTool; }
      const tdOpenPmBtn = $('tdOpenPmBtn');
      if (tdOpenPmBtn) {
        tdOpenPmBtn.dataset.url = d.sourceUrl || '';
        tdOpenPmBtn.textContent = `Open in ${TOOL_LABEL[d.sourceTool] || 'PM'} ↗`;
      }
      const validateBtn = $('taskDetailValidateBtn');
      if (validateBtn) {
        validateBtn.disabled = !state.taskId || state.taskId !== d.id;
        validateBtn.title = validateBtn.disabled ? 'Start a thread for this task to validate changes.' : '';
      }
      const generateBtn = $('taskDetailGenerateCommitBtn');
      if (generateBtn) {
        generateBtn.disabled = !state.taskId || state.taskId !== d.id || state.status !== 'weaving';
        generateBtn.title = generateBtn.disabled ? 'Start a thread for this task to generate a commit preview.' : '';
      }
      const refreshBtn = $('refreshPmIntelligenceBtn');
      if (refreshBtn) { refreshBtn.dataset.taskId = d.id; }
      if (d.pmIntelligence) { this.renderPmIntelligence(d.pmIntelligence); }
      this.renderTaskDetailValidation();
    },

    onPmIntelligenceLoading(taskId) {
      if (taskId && _activeTaskId !== taskId) { return; }
      const loading = $('pmIntelligenceLoading');
      if (loading) { loading.classList.remove('hidden'); }
      const error = $('pmIntelligenceError');
      if (error) { error.classList.add('hidden'); error.textContent = ''; }
      // Hide intelligence blocks while extracting so partial data doesn't flash.
      ['pmGoalSection', 'pmSubtasksSection', 'pmAcceptanceCriteriaSection', 'pmProofPointsSection', 'pmValidationStepsSection'].forEach(function(id) {
        const el = $(id);
        if (el && id !== 'pmGoalSection') { el.classList.add('hidden'); }
      });
      const goalText = $('pmGoalText');
      if (goalText) { goalText.textContent = ''; }
    },

    onPmIntelligenceLoaded(taskId, intelligence, forceRefresh) {
      if (taskId && _activeTaskId !== taskId) { return; }
      stopPmThinkUI();
      const error = $('pmIntelligenceError');
      if (error) { error.classList.add('hidden'); }
      this.renderPmIntelligence(intelligence);
      if (forceRefresh) {
        const refreshBtn = $('refreshPmIntelligenceBtn');
        if (refreshBtn) { refreshBtn.textContent = 'Refresh Intelligence'; }
      }
    },

    onPmIntelligenceError(taskId, message) {
      if (taskId && _activeTaskId !== taskId) { return; }
      stopPmThinkUI();
      const loading = $('pmIntelligenceLoading');
      if (loading) { loading.classList.add('hidden'); }
      const error = $('pmIntelligenceError');
      if (error) { error.classList.remove('hidden'); error.textContent = message || 'Could not extract PM intelligence.'; }
    },

    renderPmIntelligence(i) {
      if (!i) { return; }
      const set = (id, html) => { const el = $(id); if (el) { el.innerHTML = html; } };
      const show = (id, items) => {
        const el = $(id);
        if (!el) { return; }
        if (items && items.length) {
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      };
      const setList = (id, items) => {
        const el = $(id);
        if (!el) { return; }
        if (items && items.length) {
          el.innerHTML = items.map(item => `<div class="pm-intelligence-item">${escHtmlTask(item)}</div>`).join('');
        } else {
          el.innerHTML = '';
        }
      };
      const setSubtaskList = (id, items) => {
        const el = $(id);
        if (!el) { return; }
        if (items && items.length) {
          el.innerHTML = items.map(item => {
            const title = typeof item === 'string' ? item : (item.title || '');
            const description = item.description ? `<div class="pm-intelligence-sub">${escHtmlTask(item.description)}</div>` : '';
            return `<div class="pm-intelligence-item"><strong>${escHtmlTask(title)}</strong>${description}</div>`;
          }).join('');
        } else {
          el.innerHTML = '';
        }
      };

      const goalEl = $('pmGoalText');
      if (goalEl) { goalEl.textContent = i.goal || 'No goal extracted.'; }
      show('pmSubtasksSection', i.subtasks);
      setSubtaskList('pmSubtasksList', i.subtasks);
      show('pmAcceptanceCriteriaSection', i.acceptanceCriteria);
      setList('pmAcceptanceCriteriaList', i.acceptanceCriteria);
      show('pmProofPointsSection', i.proofPointTemplates);
      setList('pmProofPointsList', i.proofPointTemplates);
      show('pmValidationStepsSection', i.validationSteps);
      setList('pmValidationStepsList', i.validationSteps);
      this.renderTaskDetailValidation();
    },

    renderTaskDetailValidation() {
      const section = $('pmValidationResultSection');
      const body = $('pmValidationResultText');
      if (!section || !body) { return; }
      const isActiveTask = _activeTaskId && state.taskId && _activeTaskId === state.taskId;
      const result = isActiveTask ? state.pmTaskValidationResult : null;
      if (!result) {
        section.classList.add('hidden');
        body.innerHTML = '';
        return;
      }
      section.classList.remove('hidden');
      const passed = Array.isArray(result.passedCriteria) ? result.passedCriteria.length : 0;
      const failed = Array.isArray(result.failedCriteria) ? result.failedCriteria.length : 0;
      const missing = Array.isArray(result.missingWork) ? result.missingWork.length : 0;
      const match = typeof result.matchPercent === 'number' ? ` · Match ${result.matchPercent}%` : '';
      body.innerHTML =
        `<div class="pm-intelligence-item"><strong>${escHtmlTask(String((result.status || 'partial').toUpperCase()))}</strong>${escHtmlTask(match)}</div>` +
        `<div class="pm-intelligence-sub">${escHtmlTask(result.summary || 'Validation completed.')}</div>` +
        `<div class="pm-intelligence-sub">Passed: ${passed} · Failed: ${failed} · Missing: ${missing}</div>`;
    },

    renderComments(comments) {
      const sec = $('taskDetailCommentsSection');
      const el = $('taskDetailComments');
      const moreBtn = $('taskDetailMoreCommentsBtn');
      if (!sec || !el) { return; }
      if (!comments.length) { sec.classList.add('hidden'); return; }
      sec.classList.remove('hidden');
      const showing = comments.slice(0, _detailCommentCount);
      el.innerHTML = showing.map(c =>
        `<div class="comment-row">
          <span class="comment-author">${escHtmlTask(c.authorName || 'Unknown')}</span>
          <span class="comment-time">${c.createdAt ? fmtRelative(c.createdAt) : ''}</span>
          <div class="comment-body">${escHtmlTask(c.body)}</div>
        </div>`
      ).join('');
      if (moreBtn) {
        if (comments.length > _detailCommentCount) {
          moreBtn.classList.remove('hidden');
          moreBtn.textContent = `Show ${comments.length - _detailCommentCount} more comments`;
          moreBtn.onclick = () => {
            _detailCommentCount = comments.length;
            this.renderComments(comments);
          };
        } else { moreBtn.classList.add('hidden'); }
      }
    },

    safeMarkdown(text) {
      if (!text) { return ''; }
      return escHtmlTask(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
        .replace(/\n/g, '<br>');
    },

    prefillThread(msg) {
      const tidEl = $('taskId');
      const goalEl = $('goal');
      const appNameEl = $('appName');
      if (tidEl) { tidEl.value = msg.taskId || ''; state.taskId = msg.taskId || state.taskId; }
      if (goalEl) { goalEl.value = msg.goal || msg.taskTitle || ''; state.goal = msg.goal || msg.taskTitle || state.goal; }
      if (msg.taskTitle) { state.taskTitle = msg.taskTitle; }
      if (msg.taskSource) { state.taskSource = msg.taskSource; }
      if (msg.taskUrl) { state.taskUrl = msg.taskUrl; }
      state.taskIssueType = msg.issueType || '';
      if (appNameEl && !appNameEl.value) { appNameEl.value = state.appName || ''; }
      renderThreadTaskPicker();
      if (msg.subtasks && Array.isArray(msg.subtasks)) {
        state.subtasks = msg.subtasks;
        renderSubtasks();
      }
      if (msg.acceptanceCriteria && Array.isArray(msg.acceptanceCriteria)) {
        state.acceptanceCriteria = msg.acceptanceCriteria;
      }
      if (msg.proofPointTemplates && Array.isArray(msg.proofPointTemplates)) {
        state.proofPointTemplates = msg.proofPointTemplates;
      }
      if (msg.validationSteps && Array.isArray(msg.validationSteps)) {
        state.validationSteps = msg.validationSteps;
      }
      if (msg.pmTaskContext) {
        state.pmTaskContext = msg.pmTaskContext;
      }
      if (msg.pmEnrichmentStatus) { state.pmEnrichmentStatus = msg.pmEnrichmentStatus; }
      if (msg.pmEnrichmentError !== undefined) { state.pmEnrichmentError = msg.pmEnrichmentError || ''; }
      expandProofSectionIfContent();
      syncThreadCreateTasksCta(msg.issueType || state.taskIssueType, msg.taskId || state.taskId);
      // Host already applied task/goal via loadTaskIntoThread — do not fieldChange
      // or scheduleEnrichmentFromThreadEdit will re-bill PM enrichment.
      applyStatus();
    },

    closeDetail() {
      const drawer = $('taskDetailDrawer');
      if (drawer) { drawer.classList.add('hidden'); }
      _activeTaskId = null;
      _activeTaskTool = null;
      this.runQuery();
    },
  };

  // ── Task event wiring ────────────────────────────────────────────────────────

  const pullTasksBtn = $('pullTasksBtn');
  if (pullTasksBtn) { pullTasksBtn.addEventListener('click', () => vscode.postMessage({ type: 'pullTasks' })); }

  const connectPmToolBtn = $('connectPmToolBtn');
  if (connectPmToolBtn) {
    connectPmToolBtn.addEventListener('click', () => {
      const sel = $('pmToolSelect');
      const tool = sel ? sel.value : '';
      if (!tool) { return; }
      vscode.postMessage({ type: 'connectPmTool', tool });
    });
  }

  document.addEventListener('click', e => {
    const disc = e.target.closest('.tool-badge-disconnect');
    if (disc && disc.dataset.tool) {
      vscode.postMessage({ type: 'disconnectPmTool', tool: disc.dataset.tool });
      return;
    }
    const emptyAction = e.target.closest('[data-task-empty-action]');
    if (emptyAction) {
      const action = emptyAction.dataset.taskEmptyAction;
      if (action === 'refresh-tasks') { vscode.postMessage({ type: 'pullTasks' }); return; }
      if (action === 'change-jira-project') { vscode.postMessage({ type: 'changeJiraProject' }); return; }
      if (action === 'reconnect-jira' || action === 'connect-jira') { vscode.postMessage({ type: 'connectPmTool', tool: 'jira' }); return; }
      if (action === 'connect-linear') { vscode.postMessage({ type: 'connectPmTool', tool: 'linear' }); return; }
      if (action === 'clear-filters') {
        const search = $('taskSearchInput');
        if (search) { search.value = ''; }
        const source = $('taskSourceFilter');
        if (source) { source.value = ''; }
        const workspace = $('taskWorkspaceSelect');
        if (workspace) { workspace.value = ''; }
        document.querySelectorAll('#tfpStatuses input, #tfpPriorities input').forEach(el => { el.checked = false; });
        ['tfpDueDate', 'tfpUpdated', 'taskSortSelect'].forEach(function(id) {
          const el = $(id);
          if (!el) { return; }
          el.value = id === 'taskSortSelect' ? 'recommended:desc' : '';
        });
        ['tfpHasBranch', 'tfpHasCommits', 'tfpHasTime'].forEach(function(id) {
          const el = $(id);
          if (el) { el.checked = false; }
        });
        tasksMgr._activeFilters = {};
        tasksMgr.renderFilterChips();
        tasksMgr.runQuery();
        return;
      }
    }
    // Quick actions on the card must win over the card's own click: Start jumps
    // straight into a thread, Split opens the decomposition flow. Checked before
    // findTaskCard because the buttons live inside .task-card.
    const quick = e.target.closest('[data-task-start]');
    if (quick && quick.dataset.taskStart) {
      if (quick.dataset.taskDecompose) {
        storyDecompose.start(quick.dataset.taskStart, quick.dataset.taskTool || 'jira');
      } else {
        loadTaskIntoThread(quick.dataset.taskStart);
      }
      return;
    }
    const card = TyneTaskInteractions.findTaskCard(e.target);
    if (card && card.dataset.taskId) {
      _activeTaskId = card.dataset.taskId;
      _activeTaskTool = card.dataset.taskTool;
      // Detail drawer for metadata + Thread load so proof points generate/show.
      // Does NOT open Jira (external-open is scoped to explicit buttons/links).
      vscode.postMessage({ type: 'openTaskDetail', taskId: card.dataset.taskId, tool: card.dataset.taskTool });
      loadTaskIntoThread(card.dataset.taskId);
      tasksMgr.runQuery();
      return;
    }
  });

  const taskDetailCloseBtn = $('taskDetailCloseBtn');
  if (taskDetailCloseBtn) { taskDetailCloseBtn.addEventListener('click', () => tasksMgr.closeDetail()); }

  const taskDetailDescToggle = $('taskDetailDescToggle');
  if (taskDetailDescToggle) {
    taskDetailDescToggle.addEventListener('click', () => {
      const desc = $('taskDetailDesc');
      if (!desc) { return; }
      _detailDescExpanded = !_detailDescExpanded;
      desc.classList.toggle('expanded', _detailDescExpanded);
      taskDetailDescToggle.textContent = _detailDescExpanded ? 'Show less' : 'Show more';
    });
  }

  const taskDetailStartThreadBtn = $('taskDetailStartThreadBtn');
  if (taskDetailStartThreadBtn) {
    taskDetailStartThreadBtn.addEventListener('click', () => {
      const b = taskDetailStartThreadBtn;
      if (b.dataset.decompose === '1') {
        storyDecompose.start(b.dataset.taskId, b.dataset.taskTool);
        return;
      }
      vscode.postMessage({ type: 'startThreadFromTask', taskId: b.dataset.taskId, title: b.dataset.taskTitle, tool: b.dataset.taskTool, url: b.dataset.taskSourceUrl });
    });
  }
  const storyDecomposePanelEl = $('storyDecomposePanel');
  if (storyDecomposePanelEl) {
    storyDecomposePanelEl.addEventListener('click', e => storyDecompose.onClick(e));
    storyDecomposePanelEl.addEventListener('change', e => storyDecompose.onChange(e));
  }
  const taskDetailValidateBtn = $('taskDetailValidateBtn');
  if (taskDetailValidateBtn) {
    taskDetailValidateBtn.addEventListener('click', () => runFlowAction('validateReview'));
  }
  const taskDetailGenerateCommitBtn = $('taskDetailGenerateCommitBtn');
  if (taskDetailGenerateCommitBtn) {
    taskDetailGenerateCommitBtn.addEventListener('click', () => runFlowAction('generateCommitPreview'));
  }

  function fmtDate(iso) {
    if (!iso) { return '—'; }
    try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
    catch { return iso; }
  }

  function addTaskFilterListeners() {
    const searchEl = $('taskSearchInput');
    if (searchEl) {
      searchEl.addEventListener('input', () => {
        clearTimeout(_taskSearchDebounce);
        _taskSearchDebounce = setTimeout(() => tasksMgr.runQuery(), 250);
      });
    }
  }
  addTaskFilterListeners();

  // ── ⚙ Gear panel (unified: filter + sort + presets + tools + new task) ────────
  const taskGearBtn = $('taskGearBtn');
  const taskGearPanel = $('taskGearPanel');
  if (taskGearBtn && taskGearPanel) {
    taskGearBtn.addEventListener('click', e => { e.stopPropagation(); taskGearPanel.classList.toggle('hidden'); });
  }

  // Apply filters from gear panel
  const tfpApplyBtn = $('tfpApplyBtn');
  if (tfpApplyBtn) {
    tfpApplyBtn.addEventListener('click', () => {
      tasksMgr._activeFilters = tasksMgr.collectAdvancedFilters();
      tasksMgr.renderFilterChips();
      tasksMgr.runQuery();
      if (taskGearPanel) { taskGearPanel.classList.add('hidden'); }
    });
  }

  // Sort change triggers query immediately
  const taskSortSel = $('taskSortSelect');
  if (taskSortSel) { taskSortSel.addEventListener('change', () => tasksMgr.runQuery()); }

  // Source filter change
  const taskSourceFilterEl = $('taskSourceFilter');
  if (taskSourceFilterEl) { taskSourceFilterEl.addEventListener('change', () => tasksMgr.runQuery()); }

  const taskWorkspaceSelectEl = $('taskWorkspaceSelect');
  if (taskWorkspaceSelectEl) { taskWorkspaceSelectEl.addEventListener('change', () => tasksMgr.runQuery()); }

  // Clear filters
  const tfpClearBtn = $('tfpClearBtn');
  if (tfpClearBtn) {
    tfpClearBtn.addEventListener('click', () => {
      document.querySelectorAll('#tfpStatuses input, #tfpPriorities input').forEach(el => { el.checked = false; });
      const tfpDue = $('tfpDueDate'); if (tfpDue) { tfpDue.value = ''; }
      const tfpUpd = $('tfpUpdated'); if (tfpUpd) { tfpUpd.value = ''; }
      const tfpB = $('tfpHasBranch'); if (tfpB) { tfpB.checked = false; }
      const tfpC = $('tfpHasCommits'); if (tfpC) { tfpC.checked = false; }
      const tfpT = $('tfpHasTime'); if (tfpT) { tfpT.checked = false; }
      tasksMgr._activeFilters = {};
      tasksMgr.renderFilterChips();
      tasksMgr.runQuery();
      if (taskGearPanel) { taskGearPanel.classList.add('hidden'); }
    });
  }

  // Preset: save
  const savePresetBtn = $('savePresetBtn');
  if (savePresetBtn) {
    savePresetBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (taskGearPanel) { taskGearPanel.classList.add('hidden'); }
      const drawer = $('savePresetDrawer'); if (drawer) { drawer.classList.remove('hidden'); }
    });
  }

  // New task
  const newTaskBtn = $('newTaskBtn');
  if (newTaskBtn) {
    newTaskBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (taskGearPanel) { taskGearPanel.classList.add('hidden'); }
      tasksMgr.openCreateDrawer();
    });
  }

  // Delegated: pill connect, preset apply/delete, chip remove
  document.addEventListener('click', e => {
    // PM tool pill (initial connect screen + gear panel)
    const connTool = e.target.closest('[data-connect-tool]');
    if (connTool && connTool.dataset.connectTool) {
      vscode.postMessage({ type: 'connectPmTool', tool: connTool.dataset.connectTool });
      if (taskGearPanel) { taskGearPanel.classList.add('hidden'); }
      return;
    }
    // Preset apply
    const applyBtn = e.target.closest('.preset-apply-btn');
    if (applyBtn && applyBtn.dataset.presetId) {
      vscode.postMessage({ type: 'applyPreset', id: applyBtn.dataset.presetId });
      if (taskGearPanel) { taskGearPanel.classList.add('hidden'); }
      return;
    }
    // Preset delete
    const delBtn = e.target.closest('.preset-delete-btn');
    if (delBtn && delBtn.dataset.presetId) {
      vscode.postMessage({ type: 'deletePreset', id: delBtn.dataset.presetId });
      tasksMgr._presets = tasksMgr._presets.filter(p => p.id !== delBtn.dataset.presetId);
      tasksMgr.renderPresetMenu();
      return;
    }
    // Filter chip remove
    const chipRem = e.target.closest('.chip-remove');
    if (chipRem && chipRem.dataset.chipKey) {
      delete tasksMgr._activeFilters[chipRem.dataset.chipKey];
      tasksMgr.renderFilterChips();
      tasksMgr.runQuery();
      return;
    }
  });

  // Clear all chips
  const clearAllChipsBtn = $('clearAllChipsBtn');
  if (clearAllChipsBtn) {
    clearAllChipsBtn.addEventListener('click', () => {
      tasksMgr._activeFilters = {};
      tasksMgr.renderFilterChips();
      tasksMgr.runQuery();
    });
  }

  // Close gear panel on outside click
  document.addEventListener('click', () => {
    if (taskGearPanel) { taskGearPanel.classList.add('hidden'); }
  });

  // ── Details toggle (collapse/expand desc + subtasks + comments + history) ─────
  const taskDetailsToggle = $('taskDetailsToggle');
  const taskDetailsBody = $('taskDetailsBody');
  if (taskDetailsToggle && taskDetailsBody) {
    taskDetailsToggle.addEventListener('click', () => {
      const open = !taskDetailsBody.classList.contains('hidden');
      taskDetailsBody.classList.toggle('hidden', open);
      taskDetailsToggle.textContent = open ? '\u25b8 Details' : '\u25be Details';
    });
  }

  // ── Generic section toggles (Branches / Commits / Time) ──────────────────────
  document.addEventListener('click', e => {
    // section-toggle clicks are already handled by the single delegated
    // listener defined earlier (see "Section toggles"). A second handler here
    // toggled the same body a second time, cancelling the first out \u2014 which is
    // why the Validation arrow appeared dead. Intentionally a no-op now.
  });

  // ── Create drawer ─────────────────────────────────────────────────────────────
  const createDrawerCloseBtn = $('createDrawerCloseBtn');
  if (createDrawerCloseBtn) { createDrawerCloseBtn.addEventListener('click', () => tasksMgr.closeCreateDrawer()); }
  const createTaskCancelBtn = $('createTaskCancelBtn');
  if (createTaskCancelBtn) { createTaskCancelBtn.addEventListener('click', () => tasksMgr.closeCreateDrawer()); }
  const createTaskSubmitBtn = $('createTaskSubmitBtn');
  if (createTaskSubmitBtn) { createTaskSubmitBtn.addEventListener('click', () => tasksMgr.submitCreate()); }

  // ── Edit drawer (triggered from secondary row Edit button) ───────────────────
  const tdEditBtn = $('tdEditBtn');
  if (tdEditBtn) {
    tdEditBtn.addEventListener('click', () => {
      if (!_activeTaskId) { return; }
      const cached = _tasksAll.find(t => t.id === _activeTaskId) || {};
      tasksMgr.openEditDrawer({ id: _activeTaskId, sourceTool: _activeTaskTool || cached.sourceTool, ...cached });
    });
  }
  const editTaskSaveBtn = $('editTaskSaveBtn');
  if (editTaskSaveBtn) { editTaskSaveBtn.addEventListener('click', () => tasksMgr.submitEdit()); }
  const editTaskCancelBtn = $('editTaskCancelBtn');
  if (editTaskCancelBtn) { editTaskCancelBtn.addEventListener('click', () => tasksMgr.closeEditDrawer()); }

  // ── Secondary row buttons (always visible in detail) ─────────────────────────
  const tdRefreshBtnEl = $('tdRefreshBtn');
  if (tdRefreshBtnEl) { tdRefreshBtnEl.addEventListener('click', () => { if (_activeTaskId) { vscode.postMessage({ type: 'refreshTaskDetail', taskId: _activeTaskId, tool: _activeTaskTool }); } }); }
  const refreshPmIntelligenceBtnEl = $('refreshPmIntelligenceBtn');
  if (refreshPmIntelligenceBtnEl) { refreshPmIntelligenceBtnEl.addEventListener('click', () => { if (_activeTaskId) { vscode.postMessage({ type: 'refreshPmTaskIntelligence', taskId: _activeTaskId }); refreshPmIntelligenceBtnEl.textContent = 'Refreshing…'; } }); }
  const tdCopyIdBtnEl = $('tdCopyIdBtn');
  if (tdCopyIdBtnEl) { tdCopyIdBtnEl.addEventListener('click', () => { vscode.postMessage({ type: 'copyTaskId', taskId: tdCopyIdBtnEl.dataset.taskId }); }); }
  const tdCopyLinkBtnEl = $('tdCopyLinkBtn');
  if (tdCopyLinkBtnEl) { tdCopyLinkBtnEl.addEventListener('click', () => { vscode.postMessage({ type: 'copyTaskLink', url: tdCopyLinkBtnEl.dataset.url }); }); }
  const tdOpenPmBtnEl = $('tdOpenPmBtn');
  if (tdOpenPmBtnEl) { tdOpenPmBtnEl.addEventListener('click', () => { if (tdOpenPmBtnEl.dataset.url) { vscode.postMessage({ type: 'openExternal', url: tdOpenPmBtnEl.dataset.url }); } }); }

  // ── Add subtask inline ────────────────────────────────────────────────────────
  const addSubtaskSubmitBtn = $('addSubtaskSubmitBtn');
  if (addSubtaskSubmitBtn) {
    addSubtaskSubmitBtn.addEventListener('click', () => {
      const inp = $('newSubtaskInput');
      const title = inp ? inp.value.trim() : '';
      if (!title || !_activeTaskId) { return; }
      vscode.postMessage({ type: 'addSubtask', taskId: _activeTaskId, sourceTool: _activeTaskTool, input: { title } });
    });
  }
  const newSubtaskInput = $('newSubtaskInput');
  if (newSubtaskInput) {
    newSubtaskInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { const btn = $('addSubtaskSubmitBtn'); if (btn) { btn.click(); } }
    });
  }

  // ── Add comment inline ────────────────────────────────────────────────────────
  const addCommentSubmitBtn = $('addCommentSubmitBtn');
  if (addCommentSubmitBtn) {
    addCommentSubmitBtn.addEventListener('click', () => {
      const inp = $('newCommentInput');
      const body = inp ? inp.value.trim() : '';
      if (!body || !_activeTaskId) { return; }
      vscode.postMessage({ type: 'addComment', taskId: _activeTaskId, sourceTool: _activeTaskTool, body });
    });
  }
  const newCommentInput = $('newCommentInput');
  if (newCommentInput) {
    newCommentInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { const btn = $('addCommentSubmitBtn'); if (btn) { btn.click(); } }
    });
  }

  // ── Conflict banner ───────────────────────────────────────────────────────────
  const conflictReloadBtn = $('conflictReloadBtn');
  if (conflictReloadBtn) {
    conflictReloadBtn.addEventListener('click', () => {
      tasksMgr.hideConflict();
      if (_activeTaskId && _activeTaskTool) {
        vscode.postMessage({ type: 'refreshTaskDetail', taskId: _activeTaskId, tool: _activeTaskTool });
      }
      tasksMgr.closeEditDrawer();
    });
  }
  const conflictKeepBtn = $('conflictKeepBtn');
  if (conflictKeepBtn) { conflictKeepBtn.addEventListener('click', () => tasksMgr.hideConflict()); }
  const conflictCancelBtn = $('conflictCancelBtn');
  if (conflictCancelBtn) { conflictCancelBtn.addEventListener('click', () => { tasksMgr.hideConflict(); tasksMgr.closeEditDrawer(); }); }

  // ── Save preset drawer ────────────────────────────────────────────────────────
  const savePresetDrawerCloseBtn = $('savePresetDrawerCloseBtn');
  if (savePresetDrawerCloseBtn) { savePresetDrawerCloseBtn.addEventListener('click', () => { const d = $('savePresetDrawer'); if (d) { d.classList.add('hidden'); } }); }
  const presetSaveCancelBtn = $('presetSaveCancelBtn');
  if (presetSaveCancelBtn) { presetSaveCancelBtn.addEventListener('click', () => { const d = $('savePresetDrawer'); if (d) { d.classList.add('hidden'); } }); }
  const presetSaveSubmitBtn = $('presetSaveSubmitBtn');
  if (presetSaveSubmitBtn) {
    presetSaveSubmitBtn.addEventListener('click', () => {
      const name = ($('presetNameInput') || {}).value || '';
      if (!name.trim()) { return; }
      const isDefault = !!($('presetIsDefault') || {}).checked;
      const q = ($('taskSearchInput') || {}).value || '';
      const sortVal = ($('taskSortSelect') || {}).value || 'recommended:desc';
      const [sortKey, sortDir] = sortVal.split(':');
      vscode.postMessage({ type: 'savePreset', name: name.trim(), query: q || undefined, filters: tasksMgr._activeFilters || {}, sort: { rules: [{ key: sortKey, direction: sortDir }] }, isDefault });
      const nameInp = $('presetNameInput'); if (nameInp) { nameInp.value = ''; }
      const d = $('savePresetDrawer'); if (d) { d.classList.add('hidden'); }
    });
  }

  // ---------- Automation message handlers ----------
  // (registered in the existing window.addEventListener('message') block above)

  // ---------- Automation renderers ----------
  function renderAutomationData() {
    renderAutomationStatusCard();
    renderAutomationConflictCard();
    renderAutomationEventList();
    renderCommitDetectorState();
    populateAutomationSettings();
    renderMaxReportSettings();
    renderMaxOnlyVisibility();
    renderAutomationActionState();
  }

  // Task-specific actions require an active task (a live sync state). Disable them
  // otherwise so users don't click into a no-op / error when nothing is in progress.
  function renderAutomationActionState() {
    const hasTask = !!automationData.syncState;
    ['automationPreviewFeedbackBtn', 'automationPostFeedbackBtn', 'automationMarkDoneBtn', 'automationCompleteBtn'].forEach(id => {
      const el = $(id);
      if (el) {
        el.disabled = !hasTask;
        el.title = hasTask ? '' : 'Start a thread on a task to use this action.';
      }
    });
  }

  function renderMaxOnlyVisibility() {
    const isMax = automationData.userTier === 'max';
    document.querySelectorAll('.max-only').forEach(el => {
      el.classList.toggle('hidden', !isMax);
    });
  }

  function renderCommitDetectorState() {
    const el = $('commitDetectionStatus');
    if (!el) { return; }
    const state = automationData.detectorState || {};
    if (state.hookInstalled) {
      el.textContent = 'Git hook active';
      el.className = 'status-linked';
    } else if (state.mode === 'watcher') {
      el.textContent = 'Watcher fallback';
      el.className = 'status-partial';
    } else {
      el.textContent = state.error || 'No repo detected';
      el.className = 'status-unlinked';
    }
  }

  function pmStatusLabel(s) {
    const map = { todo: 'Todo', in_progress: 'In Progress', in_review: 'In Review', done: 'Done', blocked: 'Blocked', canceled: 'Canceled', unknown: 'Unknown' };
    return map[s] || s || '—';
  }

  function localStatusLabel(s) {
    const map = { not_started: 'Not Started', active: 'Active', paused: 'Paused', ready_to_complete: 'Ready', completed: 'Completed', sync_error: 'Sync Error', unknown: 'Unknown' };
    return map[s] || s || '—';
  }

  function automationStatusClass(s) {
    if (s === 'success') { return 'status-linked'; }
    if (s === 'failed') { return 'status-unlinked'; }
    if (s === 'partial_success') { return 'status-partial'; }
    return '';
  }

  function renderAutomationStatusCard() {
    const el = $('automationStatusCard');
    if (!el) { return; }
    const ss = automationData.syncState;
    if (!ss) {
      el.innerHTML = '<div class="empty">No active task. Start a thread to use automation.</div>';
      return;
    }
    const pmStatus = pmStatusLabel(ss.pmStatus);
    const localStatus = localStatusLabel(ss.localStatus);
    const lastSynced = ss.lastSyncedAt ? fmtRelative(ss.lastSyncedAt) : '—';
    const pmMatch = ss.pmStatus === 'done' ? 'status-linked' : (ss.pmStatus === 'in_progress' || ss.pmStatus === 'in_review' ? 'status-partial' : '');
    const localMatch = ss.localStatus === 'completed' ? 'status-linked' : ss.localStatus === 'active' ? 'status-partial' : '';
    el.innerHTML =
      '<div class="row"><div class="k">Task</div><div class="v">' + escHtml(ss.taskId || '—') + (ss.taskTitle ? ' · ' + escHtml(ss.taskTitle) : '') + '</div></div>' +
      '<div class="row"><div class="k">PM Tool</div><div class="v">' + escHtml(ss.pmTool || '—') + '</div></div>' +
      '<div class="row"><div class="k">PM Status</div><div class="v"><span class="tag ' + pmMatch + '">PM: ' + escHtml(pmStatus) + '</span></div></div>' +
      '<div class="row"><div class="k">Tyne Status</div><div class="v"><span class="tag ' + localMatch + '">Tyne: ' + escHtml(localStatus) + '</span></div></div>' +
      '<div class="row"><div class="k">Branch</div><div class="v mono">' + escHtml(ss.branchName || '—') + '</div></div>' +
      '<div class="row"><div class="k">Last Synced</div><div class="v">' + escHtml(lastSynced) + '</div></div>' +
      (ss.syncError ? '<div class="notice bad" style="margin-top:8px"><div class="notice-copy">' + escHtml(ss.syncError) + '</div></div>' : '');
  }

  function renderAutomationConflictCard() {
    const card = $('automationConflictCard');
    const txt = $('automationConflictText');
    if (!card || !txt) { return; }
    const conflict = automationData.conflict;
    if (!conflict) {
      card.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    txt.textContent = 'PM Status: ' + pmStatusLabel(conflict.pmStatus) + ' · Tyne Status: ' + localStatusLabel(conflict.localStatus) + '. Task status changed in PM tool. Refresh Tyne task state?';
  }

  function renderAutomationEventList() {
    const el = $('automationEventList');
    if (!el) { return; }
    const events = (automationData.events || []).slice().reverse();
    if (!events.length) {
      el.innerHTML = '<div class="empty">No automation events yet.</div>';
      return;
    }
    el.innerHTML = events.map(ev => {
      const actionLabel = { close_task: 'Mark Done', post_feedback: 'Post Feedback', complete_task_and_post_feedback: 'Complete + Feedback', sync_status: 'Sync Status', move_pm_to_in_progress: 'Move to In Progress' }[ev.actionType] || ev.actionType;
      const statusClass = automationStatusClass(ev.status);
      return '<div class="list-item">' +
        '<div class="int-head"><span class="lt">' + escHtml(actionLabel) + '</span>' +
        '<span class="tag ' + statusClass + '">' + escHtml(ev.status) + '</span>' +
        '<span class="tag">' + escHtml(fmtRelative(ev.createdAt)) + '</span></div>' +
        (ev.resultMessage ? '<div class="lm plain">' + escHtml(ev.resultMessage) + '</div>' : '') +
        (ev.errorMessage ? '<div class="lm plain" style="color:var(--red)">' + escHtml(ev.errorMessage) + '</div>' : '') +
        (ev.messagePreview ? '<div class="lm plain mono" style="font-size:10px">' + escHtml(ev.messagePreview.slice(0, 80)) + '…</div>' : '') +
        '</div>';
    }).join('');
  }

  function setAutomationDirty(dirty) {
    automationSettingsDirty = dirty;
    const badge = $('automationUnsaved');
    if (badge) { badge.classList.toggle('hidden', !dirty); }
  }

  function populateAutomationSettings() {
    const s = automationData.settings;
    if (!s) { return; }
    // Programmatic population must not mark the form dirty.
    suppressAutomationDirty = true;
    const set = (id, val) => { const el = $(id); if (el) { el.value = val; } };
    const check = (id, val) => { const el = $(id); if (el) { el.checked = !!val; } };
    // Push-based and after-task-done triggers are not wired to any runtime event
    // source, so they are no longer offered. Migrate any legacy saved value to a
    // valid, working option for display.
    const closeTrigger = (s.autoCloseTrigger === 'on_push' || s.autoCloseTrigger === 'manual_and_on_push')
      ? 'manual' : (s.autoCloseTrigger || 'manual');
    const feedbackTrigger = (s.autoFeedbackTrigger === 'after_push' || s.autoFeedbackTrigger === 'after_task_done')
      ? 'after_commit' : (s.autoFeedbackTrigger || 'after_commit');
    set('autoCloseTrigger', closeTrigger);
    set('autoFeedbackTrigger', feedbackTrigger);
    check('autoCloseOnCommit', s.autoCloseOnCommit);
    check('requireValidationBeforeAutoClose', s.requireValidationBeforeAutoClose);
    check('requireValidationBeforeFeedback', s.requireValidationBeforeFeedback);
    check('autoPostFeedbackAfterClose', s.autoPostFeedbackAfterClose);
    check('syncPmStatusToTyne', s.syncPmStatusToTyne);
    check('syncTyneStatusToPm', s.syncTyneStatusToPm);
    check('autoMovePmToInProgressOnStart', s.autoMovePmToInProgressOnStart);
    check('complianceChecksEnabled', automationData.userTier === 'max' && s.complianceChecksEnabled);
    const complianceFrameworks = new Set(s.complianceFrameworks || ['HIPAA']);
    document.querySelectorAll('[data-compliance-framework]').forEach(el => {
      el.checked = complianceFrameworks.has(el.getAttribute('data-compliance-framework'));
    });
    const privacyMode = s.privacyMode || 'cloud';
    document.querySelectorAll('input[name="privacyMode"]').forEach(el => {
      el.checked = el.value === privacyMode;
    });
    const residencyEl = $('dataResidency');
    if (residencyEl) { residencyEl.value = s.dataResidency || 'us'; }
    const enterpriseHint = $('enterpriseEndpointHint');
    if (enterpriseHint) {
      enterpriseHint.classList.toggle('hidden', (s.dataResidency || 'us') !== 'enterprise_managed');
    }
    // Freshly populated from saved state — clear any dirty flag and re-enable listener.
    suppressAutomationDirty = false;
    setAutomationDirty(false);
  }

  const MAX_SECTIONS = ['validation_stages', 'risk_assessment', 'performance_metrics', 'security_check', 'code_quality', 'recommendations'];

  function renderMaxReportSettings() {
    const s = automationData.settings;
    if (!s) { return; }
    const activeSections = new Set(s.maxFeedbackSections || MAX_SECTIONS);
    document.querySelectorAll('[data-section]').forEach(el => {
      const section = el.getAttribute('data-section');
      if (MAX_SECTIONS.includes(section)) {
        el.checked = activeSections.has(section);
      }
    });
  }

  // ---------- Automation event wiring ----------
  const refreshAutomationBtn = $('refreshAutomationBtn');
  if (refreshAutomationBtn) { refreshAutomationBtn.addEventListener('click', () => vscode.postMessage({ type: 'refreshAutomation' })); }

  const automationRefreshStatusBtn = $('automationRefreshStatusBtn');
  if (automationRefreshStatusBtn) { automationRefreshStatusBtn.addEventListener('click', () => vscode.postMessage({ type: 'automationSyncStatus' })); }

  const automationResolveConflictBtn = $('automationResolveConflictBtn');
  if (automationResolveConflictBtn) { automationResolveConflictBtn.addEventListener('click', () => vscode.postMessage({ type: 'automationSyncStatus' })); }

  const automationPreviewFeedbackBtn = $('automationPreviewFeedbackBtn');
  if (automationPreviewFeedbackBtn) {
    automationPreviewFeedbackBtn.addEventListener('click', () => {
      const card = $('automationFeedbackPreviewCard');
      if (card) { card.classList.add('hidden'); }
      previewedFeedbackBody = null;
      previewedFeedbackAction = 'post';
      vscode.postMessage({ type: 'automationPreviewFeedback' });
    });
  }

  const automationClosePreviewBtn = $('automationClosePreviewBtn');
  if (automationClosePreviewBtn) {
    automationClosePreviewBtn.addEventListener('click', () => {
      const card = $('automationFeedbackPreviewCard');
      if (card) { card.classList.add('hidden'); }
      previewedFeedbackBody = null;
      previewedFeedbackAction = 'post';
    });
  }

  const automationPostPreviewedBtn = $('automationPostPreviewedBtn');
  if (automationPostPreviewedBtn) {
    automationPostPreviewedBtn.addEventListener('click', () => {
      const editor = $('automationFeedbackPreviewText');
      previewedFeedbackBody = editor ? editor.value : previewedFeedbackBody;
      vscode.postMessage({
        type: previewedFeedbackAction === 'complete' ? 'automationCompleteAndFeedback' : 'automationPostFeedback',
        bodyOverride: previewedFeedbackBody,
      });
      const card = $('automationFeedbackPreviewCard');
      if (card) { card.classList.add('hidden'); }
      previewedFeedbackBody = null;
      previewedFeedbackAction = 'post';
    });
  }

  const automationPostFeedbackBtn = $('automationPostFeedbackBtn');
  if (automationPostFeedbackBtn) {
    automationPostFeedbackBtn.addEventListener('click', () => {
      previewedFeedbackAction = 'post';
      vscode.postMessage({ type: 'automationPreviewFeedback' });
    });
  }

  const automationMarkDoneBtn = $('automationMarkDoneBtn');
  if (automationMarkDoneBtn) {
    automationMarkDoneBtn.addEventListener('click', () => vscode.postMessage({ type: 'automationMarkDone' }));
  }

  const automationCompleteBtn = $('automationCompleteBtn');
  if (automationCompleteBtn) {
    automationCompleteBtn.addEventListener('click', () => {
      previewedFeedbackAction = 'complete';
      vscode.postMessage({ type: 'automationPreviewFeedback' });
    });
  }

  const automationSaveSettingsBtn = $('automationSaveSettingsBtn');
  if (automationSaveSettingsBtn) {
    automationSaveSettingsBtn.addEventListener('click', () => {
      const g = (id) => { const el = $(id); return el ? el.value : ''; };
      const c = (id) => { const el = $(id); return el ? el.checked : false; };
      const complianceFrameworks = Array.from(document.querySelectorAll('[data-compliance-framework]:checked'))
        .map(el => el.getAttribute('data-compliance-framework'));
      const privacyModeEl = document.querySelector('input[name="privacyMode"]:checked');
      const settings = {
        autoCloseTrigger: g('autoCloseTrigger'),
        autoFeedbackTrigger: g('autoFeedbackTrigger'),
        autoCloseOnCommit: c('autoCloseOnCommit'),
        requireValidationBeforeAutoClose: c('requireValidationBeforeAutoClose'),
        requireValidationBeforeFeedback: c('requireValidationBeforeFeedback'),
        autoPostFeedbackAfterClose: c('autoPostFeedbackAfterClose'),
        syncPmStatusToTyne: c('syncPmStatusToTyne'),
        syncTyneStatusToPm: c('syncTyneStatusToPm'),
        autoMovePmToInProgressOnStart: c('autoMovePmToInProgressOnStart'),
        complianceChecksEnabled: automationData.userTier === 'max' && c('complianceChecksEnabled'),
        // Honor the exact selection (empty allowed); do not silently re-add HIPAA.
        complianceFrameworks: automationData.userTier === 'max' ? complianceFrameworks : [],
        privacyMode: privacyModeEl ? privacyModeEl.value : 'cloud',
        dataResidency: g('dataResidency') || 'us',
        evidencePersistenceDisabled: privacyModeEl && privacyModeEl.value === 'local_compliance',
      };
      vscode.postMessage({ type: 'automationSaveSettings', settings });
      setAutomationDirty(false);
    });
  }

  // Mark the settings form dirty on any user edit (ignoring programmatic population),
  // so users get an "Unsaved changes" cue before navigating away.
  const automationSettingsCard = $('automationSettingsCard');
  if (automationSettingsCard) {
    automationSettingsCard.addEventListener('change', (e) => {
      if (suppressAutomationDirty) { return; }
      // Custom-policy builder inputs have their own Add button; don't flag those.
      if (e.target && e.target.closest && e.target.closest('#customCompliancePolicyForm')) { return; }
      setAutomationDirty(true);
    });
  }

  const dataResidencySelect = $('dataResidency');
  if (dataResidencySelect) {
    dataResidencySelect.addEventListener('change', () => {
      const enterpriseHint = $('enterpriseEndpointHint');
      if (enterpriseHint) {
        enterpriseHint.classList.toggle('hidden', dataResidencySelect.value !== 'enterprise_managed');
      }
    });
  }

  const reinstallCommitHookBtn = $('reinstallCommitHookBtn');
  if (reinstallCommitHookBtn) {
    reinstallCommitHookBtn.addEventListener('click', () => vscode.postMessage({ type: 'reinstallCommitHook' }));
  }

  function renderCustomPolicyList(policies) {
    const list = $('customPolicyList');
    if (!list) return;
    const rows = Array.isArray(policies) ? policies : [];
    list.innerHTML = rows.map(function(p) {
      return '<li><span><strong>' + escHtml(p.name || '') + '</strong> · ' +
        escHtml(p.category || 'Enterprise') + ' · ' + escHtml(p.severity || '') + ' · ' +
        escHtml(p.action || (p.blocking ? 'block' : 'review')) +
        '</span><button type="button" class="btn btn-sm" data-delete-custom-policy="' + escHtml(p.id || '') + '">Delete</button></li>';
    }).join('') || '<li class="muted">No custom policies yet.</li>';
    list.querySelectorAll('[data-delete-custom-policy]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        vscode.postMessage({ type: 'deleteCustomCompliancePolicy', id: btn.getAttribute('data-delete-custom-policy') });
      });
    });
  }

  const customPolicyCreateBtn = $('customPolicyCreateBtn');
  if (customPolicyCreateBtn) {
    customPolicyCreateBtn.addEventListener('click', function() {
      const name = ($('customPolicyName') || {}).value || '';
      const category = ($('customPolicyCategory') || {}).value || 'Enterprise Policy';
      const pattern = ($('customPolicyPattern') || {}).value || '';
      const severity = ($('customPolicySeverity') || {}).value || 'critical';
      const action = ($('customPolicyAction') || {}).value || 'block';
      const sink = ($('customPolicySink') || {}).value || 'log';
      if (!name.trim() || !pattern.trim()) {
        return;
      }
      vscode.postMessage({
        type: 'createCustomCompliancePolicy',
        policy: {
          name: name.trim(),
          category: category.trim() || 'Enterprise Policy',
          pattern: pattern.trim(),
          patterns: [pattern.trim()],
          severity: severity,
          action: action,
          sinks: [sink],
          dataTypes: /email|phone|ssn|pii/i.test(pattern + category) ? ['PII'] : undefined,
          remediation: 'Remove the prohibited data handling or update the enterprise policy.',
        },
      });
    });
  }

  const maxReportSaveSettingsBtn = $('maxReportSaveSettingsBtn');
  if (maxReportSaveSettingsBtn) {
    maxReportSaveSettingsBtn.addEventListener('click', () => {
      const sections = [];
      document.querySelectorAll('[data-section]').forEach(el => {
        if (el.checked) {
          const section = el.getAttribute('data-section');
          if (MAX_SECTIONS.includes(section) && !sections.includes(section)) {
            sections.push(section);
          }
        }
      });
      vscode.postMessage({ type: 'automationSaveMaxReportSettings', sections });
    });
  }

  // ── Beta bug reporter (Settings entry + sheet) ────────────────────────────
  function syncBetaBugFab() {
    const fab = $('betaBugFab');
    if (!fab) { return; }
    fab.classList.toggle('hidden', !isAuthenticated);
  }

  function betaBugContextLine() {
    const task = shortTaskKey() || '';
    const page = activeView || 'thread';
    return [task, page, 'Tyne beta'].filter(Boolean).join(' · ');
  }

  function openBetaBugSheet() {
    const sheet = $('betaBugSheet');
    const msg = $('betaBugMessage');
    const email = $('betaBugEmail');
    const err = $('betaBugError');
    const ctx = $('betaBugContext');
    if (!sheet) { return; }
    if (err) { err.classList.add('hidden'); err.textContent = ''; }
    if (ctx) { ctx.textContent = betaBugContextLine(); }
    if (email && !email.value && userEmail) { email.value = userEmail; }
    sheet.classList.remove('hidden');
    if (msg) { msg.focus(); }
  }

  function closeBetaBugSheet() {
    const sheet = $('betaBugSheet');
    if (sheet) { sheet.classList.add('hidden'); }
  }

  function setBetaBugKind(kind) {
    betaBugKind = kind || 'bug';
    document.querySelectorAll('.beta-bug-kind').forEach(function(btn) {
      const on = btn.getAttribute('data-kind') === betaBugKind;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  const betaBugFab = $('betaBugFab');
  if (betaBugFab) {
    betaBugFab.addEventListener('click', openBetaBugSheet);
  }
  ['betaBugCloseBtn', 'betaBugCancelBtn', 'betaBugScrim'].forEach(function(id) {
    const el = $(id);
    if (el) { el.addEventListener('click', closeBetaBugSheet); }
  });
  document.querySelectorAll('.beta-bug-kind').forEach(function(btn) {
    btn.addEventListener('click', function() {
      setBetaBugKind(btn.getAttribute('data-kind'));
    });
  });
  const betaBugSubmitBtn = $('betaBugSubmitBtn');
  if (betaBugSubmitBtn) {
    betaBugSubmitBtn.addEventListener('click', function() {
      if (betaBugSending) { return; }
      const message = (($('betaBugMessage') || {}).value || '').trim();
      const email = (($('betaBugEmail') || {}).value || '').trim();
      const err = $('betaBugError');
      if (message.length < 3) {
        if (err) { err.textContent = 'Add a short note about what went wrong.'; err.classList.remove('hidden'); }
        return;
      }
      if (!email || email.indexOf('@') < 1) {
        if (err) { err.textContent = 'Add your email so we can follow up.'; err.classList.remove('hidden'); }
        const emailEl = $('betaBugEmail');
        if (emailEl) { emailEl.focus(); }
        return;
      }
      betaBugSending = true;
      betaBugSubmitBtn.disabled = true;
      betaBugSubmitBtn.textContent = 'Sending…';
      if (err) { err.classList.add('hidden'); }
      vscode.postMessage({
        type: 'submitBetaBug',
        kind: betaBugKind,
        message: message,
        email: email,
        githubUsername: githubUsername || '',
        githubId: userGithubId || '',
        page: activeView || 'thread',
        taskId: state.taskId || '',
        taskTitle: state.taskTitle || state.goal || '',
      });
    });
  }

  syncBetaBugFab();

  vscode.postMessage({ type: 'ready' });

})();
