// Tyne webview controller. Talks to TyneSidebarProvider via the documented
// message protocol. Presentation only — all git/AI/auth work happens host-side.
(function () {
  const vscode = acquireVsCodeApi();
  const persistedWebviewState = (typeof vscode.getState === 'function' && vscode.getState()) || {};

  let state = { appName: '', taskId: '', taskTitle: '', taskSource: 'Solo Mode', taskUrl: '', goal: '', status: 'waiting', subtasks: [], validationResult: null, validationOverride: false, branchName: '', stitchCount: 0, lastStitchTime: '', pmTaskContext: null, pmTaskValidationResult: null, validateReviewResult: null, latestValidateReviewReportId: '', pmEnrichmentStatus: 'skipped', pmEnrichmentError: '', acceptanceCriteria: [], proofPointTemplates: [], validationSteps: [] };
  let appliedFindingFixes = persistedWebviewState.appliedFindingFixes || {};
  let findingFeedbackByKey = persistedWebviewState.findingFeedbackByKey || {};
  let pendingGoalFeedbackByKey = persistedWebviewState.pendingGoalFeedbackByKey || {};
  let saveTimer = null;
  let resetTimer = null;
  let shippedTimer = null;
  let prPanelTimer = null;
  let localHasStitch = false;
  let tieKnotUnlocked = false;
  let activeView = 'thread';
  let isAuthenticated = false;
  let githubUsername = '';
  let projectLeadMode = false;
  let activeDriftFile = '';
  let sessionStart = 0;
  let shipped = false;
  let userTier = 'UNKNOWN';
  let userCredits = 0;
  let tasksCache = [];
  let branchData = { currentBranchName: '', currentBranchRecord: null, selectedTaskBranch: null, branches: [] };
  let commitData = { currentBranchName: '', currentBranchCommits: [], currentBranchSessions: [], taskCommits: [], taskSessions: [], summaries: {} };
  let timeData = { taskSummary: null, branchSummary: null, projectSummary: null, dailySummary: null, weeklySummary: null, monthlySummary: null, taskLogs: [], branchLogs: [], manualEntries: [], allLogs: [], allManuals: [] };
  let editingManualEntryId = null;
  let automationData = { settings: null, syncState: null, conflict: null, events: [], detectorState: null, userTier: 'free' };
  let previewedFeedbackBody = null;
  let previewedFeedbackAction = 'post';
  let selectedCommitHash = '';
  let velocityMetric = 'commits';
  let aiSettings = { aiAccessMode: 'byok', aiProvider: 'claude', hasBYOKKey: false, byokConfig: null, aiUsageUsed: 0, aiUsageLimit: 50, validationUsage: null, validationResult: null };
  let jiraIntegration = { configured: false, connected: false, cloudId: '', siteName: '', siteUrl: '', projectKeys: [], selectedProject: null };
  let pmIntegration = { connectedTools: [], jira: null, linear: null };
  let _tasksConnectedTools = Array.isArray(persistedWebviewState.connectedTools) ? persistedWebviewState.connectedTools.slice() : [];
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
    const next = new Set(Array.isArray(incoming) ? incoming : []);
    const pm = (snapshot && snapshot.pmIntegration) || pmIntegration || {};
    const jira = (snapshot && snapshot.jiraIntegration) || jiraIntegration || {};
    (Array.isArray(_tasksConnectedTools) ? _tasksConnectedTools : []).forEach(tool => next.add(tool));
    (Array.isArray(pm.connectedTools) ? pm.connectedTools : []).forEach(tool => next.add(tool));
    if (jira.connected || (pm.jira || {}).connected) { next.add('jira'); }
    if ((pm.linear || {}).connected) { next.add('linear'); }
    return Array.from(next);
  }

  function pmToolIsConnected(tool) {
    const pm = pmIntegration || {};
    const connectedTools = Array.isArray(pm.connectedTools) ? pm.connectedTools : [];
    if (Array.isArray(_tasksConnectedTools) && _tasksConnectedTools.includes(tool)) { return true; }
    if (connectedTools.includes(tool)) { return true; }
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
        connected: Boolean(payload.jiraIntegration.connected || jiraIntegration.connected),
        reconnectRequired: payload.jiraIntegration.reconnectRequired === undefined
          ? jiraIntegration.reconnectRequired
          : payload.jiraIntegration.reconnectRequired,
      };
    }
    if (payload.pmIntegration) {
      const incoming = payload.pmIntegration;
      pmIntegration = {
        ...pmIntegration,
        ...incoming,
        githubConnected: incoming.githubConnected !== undefined ? incoming.githubConnected : pmIntegration.githubConnected,
        jira: {
          ...(pmIntegration.jira || {}),
          ...(incoming.jira || {}),
          connected: Boolean((incoming.jira || {}).connected || (pmIntegration.jira || {}).connected || jiraIntegration.connected),
        },
        linear: {
          ...(pmIntegration.linear || {}),
          ...(incoming.linear || {}),
          connected: Boolean((incoming.linear || {}).connected || (pmIntegration.linear || {}).connected),
        },
        connectedTools: mergeConnectedToolsFromSnapshot(incoming.connectedTools || payload.connectedTools || [], payload),
      };
    }
    const incomingTools = payload.connectedTools || (payload.pmIntegration && payload.pmIntegration.connectedTools);
    if (Array.isArray(incomingTools)) {
      _tasksConnectedTools = mergeConnectedToolsFromSnapshot(incomingTools, payload);
      _tasksConnectingTools = _tasksConnectingTools.filter(tool => !_tasksConnectedTools.includes(tool));
      if (!payload.pmIntegration) {
        pmIntegration = { ...pmIntegration, connectedTools: _tasksConnectedTools.slice() };
      }
    }
    persistIntegrationState();
  }

  function markPmToolConnectedLocally(tool, snapshot) {
    if (!tool) { return; }
    _tasksConnectingTools = _tasksConnectingTools.filter(t => t !== tool);
    syncConnectedToolsFromPayload(snapshot || { tool, connectedTools: [tool] });
    if (!_tasksConnectedTools.includes(tool)) { _tasksConnectedTools.push(tool); }
    pmIntegration = {
      ...pmIntegration,
      githubConnected: pmIntegration.githubConnected !== undefined ? pmIntegration.githubConnected : isAuthenticated,
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

  if (persistedWebviewState.pmIntegration) {
    pmIntegration = { ...pmIntegration, ...persistedWebviewState.pmIntegration };
  }
  if (persistedWebviewState.jiraIntegration) {
    jiraIntegration = { ...jiraIntegration, ...persistedWebviewState.jiraIntegration };
  }
  _tasksConnectedTools = mergeConnectedToolsFromSnapshot(_tasksConnectedTools, {
    pmIntegration,
    jiraIntegration,
    connectedTools: _tasksConnectedTools,
  });

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
  let gitStatus = { currentBranch: '', stagedFiles: 0, unstagedFiles: 0, isClean: true, hasActiveTask: false, isWeaving: false, ctaReason: 'no_active_task' };
  let codeReview = { result: null, mode: 'staged_changes', running: false, error: null, reports: [], selectedReportId: null };
  let validateReview = { result: null, reports: [], selectedReportId: null, running: false, error: null, filter: 'all', search: '', viewMode: 'structured' };

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
  function showAppView(view) {
    activeView = view === 'review' ? 'validateReview' : (view || 'thread');
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === activeView + 'Page'));
    document.querySelectorAll('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === activeView));
    if (activeView === 'settings') { renderIntegrations(); }
    if (activeView === 'validateReview') { vscode.postMessage({ type: 'loadValidateReviewReports' }); vscode.postMessage({ type: 'getReviewTrends' }); }
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
    if (action === 'startThread') { vscode.postMessage({ type: 'buttonClick', action: 'startThread' }); return; }
    if (action === 'switchSelectedBranch') { vscode.postMessage({ type: 'buttonClick', action: 'switchSelectedBranch' }); return; }
    if (action === 'saveStitch') { vscode.postMessage({ type: 'buttonClick', action: 'saveStitch' }); return; }
    if (action === 'validateGoal' || action === 'validateReview') { showPixel('think', 'Reviewing last edited code…'); vscode.postMessage({ type: 'buttonClick', action: 'validateReview' }); return; }
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
    const passed = validation && validation.status === 'pass';
    if (shipped) return { key: 'done', index: 4, primary: 'Next task', primaryAction: 'selectTask', secondary: '', secondaryAction: '' };
    if (!hasTask) return { key: 'task', index: 0, primary: 'Select task', primaryAction: 'selectTask', secondary: 'AI setup', secondaryAction: 'openAi' };
    if (!weaving && linkedTaskBranch) return { key: 'linked', index: 1, primary: 'Switch to branch', primaryAction: 'switchSelectedBranch', secondary: 'AI setup', secondaryAction: 'openAi' };
    if (!weaving) return { key: 'start', index: 1, primary: hasBrief ? 'Start thread' : 'Complete brief', primaryAction: hasBrief ? 'startThread' : 'selectTask', secondary: 'AI setup', secondaryAction: 'openAi' };
    if (weaving && gitStatus.unstagedFiles > 0 && gitStatus.stagedFiles === 0 && !validation) return { key: 'stage_hint', index: 1, primary: 'Save stitch', primaryAction: 'saveStitch', secondary: 'Validate & Review', secondaryAction: 'validateReview' };
    if (weaving && (state.stitchCount || 0) < 3 && !validation && gitStatus.stagedFiles === 0) return { key: 'stitch', index: 1, primary: 'Save stitch', primaryAction: 'saveStitch', secondary: 'Validate & Review', secondaryAction: 'validateReview' };
    if (weaving && !validation) {
      const needsKey = aiSettings.aiAccessMode === 'byok' && !aiSettings.hasBYOKKey;
      return { key: 'validate', index: 2, primary: needsKey ? 'AI setup' : 'Validate & Review', primaryAction: needsKey ? 'openAi' : 'validateReview', secondary: needsKey ? 'Validate & Review anyway' : 'Save stitch', secondaryAction: needsKey ? 'validateReview' : 'saveStitch' };
    }
    if (validation && !passed && !tieKnotUnlocked) return { key: 'blocked', index: 2, primary: 'Re-run Validate & Review', primaryAction: 'validateReview', secondary: 'Override', secondaryAction: 'overrideProceed' };
    return { key: 'ship', index: 3, primary: 'Tie the knot', primaryAction: 'tieKnot', secondary: 'Save stitch', secondaryAction: 'saveStitch' };
  }
  function renderFlow() {
    const flow = getFlowState();
    const p = $('flowPrimaryBtn'), s = $('flowSecondaryBtn');
    const secWrap = p && p.nextElementSibling;
    if (p) { p.textContent = flow.primary; p.dataset.flowAction = flow.primaryAction; }
    if (s) {
      s.textContent = flow.secondary || '';
      s.dataset.flowAction = flow.secondaryAction || '';
      if (secWrap) { secWrap.classList.toggle('hidden', !flow.secondary); }
    }
    document.querySelectorAll('#stepper .step').forEach((el, i) => {
      el.classList.toggle('active', i === flow.index);
      el.classList.toggle('done', i < flow.index);
    });
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

  // ---------- Pixel animation overlay ----------
  const PIXEL = {
    think:    { cols: 5, rows: 5 },
    generate: { cols: 5, rows: 5 },
    weave:    { cols: 8, rows: 4 },
    push:     { cols: 5, rows: 5 }
  };
  let pixelHideTimer = null;
  let pixelSafetyTimer = null;
  function showPixel(variant, label, autoHideMs) {
    const cfg = PIXEL[variant] || PIXEL.think;
    const stage = $('pixelStage');
    stage.className = 'pixel-stage ' + variant;
    stage.style.gridTemplateColumns = 'repeat(' + cfg.cols + ', 9px)';
    const total = cfg.cols * cfg.rows;
    let html = '';
    for (let i = 0; i < total; i++) html += '<span class="px" style="--i:' + i + '"></span>';
    stage.innerHTML = html;
    $('pixelLabel').textContent = label || 'Working';
    $('pixelOverlay').classList.add('on');
    if (pixelHideTimer) { clearTimeout(pixelHideTimer); pixelHideTimer = null; }
    if (pixelSafetyTimer) { clearTimeout(pixelSafetyTimer); pixelSafetyTimer = null; }
    if (autoHideMs) pixelHideTimer = setTimeout(hidePixel, autoHideMs);
    else pixelSafetyTimer = setTimeout(hidePixel, 90000); // never strand the overlay
  }
  function hidePixel() {
    if (pixelHideTimer) { clearTimeout(pixelHideTimer); pixelHideTimer = null; }
    if (pixelSafetyTimer) { clearTimeout(pixelSafetyTimer); pixelSafetyTimer = null; }
    $('pixelOverlay').classList.remove('on');
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

  function syncProofSection(forceCollapse) {
    const body = $('proofBody');
    const toggle = document.querySelector('.proof-toggle');
    const countEl = $('proofToggleCount');
    const subs = state.subtasks || [];
    const doneCount = subs.filter(function(t) { return t.done; }).length;
    const allDone = subs.length > 0 && doneCount === subs.length;
    const passed = state.validationResult && state.validationResult.status === 'pass';
    if (countEl) {
      countEl.textContent = subs.length ? (doneCount + '/' + subs.length + ' done') : '';
    }
    if (!body || !toggle) { return; }
    const arrow = toggle.querySelector('.toggle-arrow');
    if ((forceCollapse || (passed && allDone)) && subs.length) {
      body.classList.add('hidden');
      if (arrow) { arrow.innerHTML = '&#9658;'; }
    }
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
    const pill = $('statusPill'), txt = $('statusText'), ascii = $('statusAscii');
    pill.classList.remove('standby', 'weaving', 'shipped');
    let statusKey = 'standby';
    if (shipped) { pill.classList.add('shipped'); txt.textContent = 'Shipped'; statusKey = 'shipped'; }
    else if (weaving) { pill.classList.add('weaving'); txt.textContent = tieKnotUnlocked ? 'Ready to ship' : 'Weaving'; statusKey = 'weaving'; }
    else { pill.classList.add('standby'); txt.textContent = 'Standby'; statusKey = 'standby'; }
    if (ascii) { ascii.setAttribute('data-status', statusKey); }

    const usageWrap = $('usageWrap');
    if (usageWrap) {
      const hasUsage = userTier !== 'UNKNOWN' || Boolean(aiSettings.validationUsage);
      usageWrap.classList.toggle('hidden', !hasUsage);
    }

    const hasBYOK = aiSettings.hasBYOKKey;
    const usageBlocked = Boolean(aiSettings.validationUsage && aiSettings.validationUsage.isBlocked);
    const blockGoalValidation = usageBlocked && !hasBYOK;

    const hasTask = Boolean((state.taskId || '').trim());
    $('briefSection').classList.toggle('hidden', weaving);
    $('briefSummary').classList.toggle('hidden', !weaving || !state.branchName);
    if (weaving && state.branchName) {
      const split = splitHeroTitle(state.taskTitle || state.goal || 'Active thread');
      const goal = (state.goal || '').trim();
      const key = shortTaskKey();
      const eyebrowParts = [key, split.prefix].filter(Boolean);
      const eyebrow = $('bsEyebrow');
      if (eyebrow) {
        eyebrow.textContent = eyebrowParts.join(' · ');
        eyebrow.classList.toggle('hidden', !eyebrowParts.length);
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
    renderGitStatusHint();
    renderDeck();
    renderFlow();
  }

  function renderGitStatusHint() {
    const el = $('gitStatusHint');
    const msgEl = $('gitStatusMsg');
    const stageBtn = $('gitStageBtn');
    if (!el || !msgEl) { return; }
    const weaving = state.status === 'weaving';
    if (!weaving) {
      el.classList.add('hidden');
      msgEl.innerHTML = '';
      if (stageBtn) { stageBtn.classList.add('hidden'); }
      return;
    }
    const { stagedFiles, unstagedFiles, isClean, ctaReason } = gitStatus;
    let html = '';
    let showStage = false;
    if (ctaReason === 'no_changes' || isClean) {
      html = 'Working tree clean';
    } else if (stagedFiles > 0 && unstagedFiles === 0) {
      html = '<span class="thread-stage-hl">' + stagedFiles + ' staged</span> — ready to validate or commit';
    } else if (stagedFiles > 0) {
      html = '<span class="thread-stage-hl">' + stagedFiles + ' staged</span> · <span class="thread-stage-warn">' + unstagedFiles + ' unstaged</span>';
      showStage = true;
    } else if (unstagedFiles > 0) {
      html = '<span class="thread-stage-warn">' + unstagedFiles + ' unstaged</span> — stage to validate or commit';
      showStage = true;
    }
    if (html) {
      msgEl.innerHTML = html;
      el.classList.remove('hidden');
      if (stageBtn) { stageBtn.classList.toggle('hidden', !showStage); }
    } else {
      el.classList.add('hidden');
      if (stageBtn) { stageBtn.classList.add('hidden'); }
    }
  }

  // ---------- Renderers ----------
  function renderSubtasks() {
    const list = $('subtaskList');
    if (!list) { return; }
    const subs = state.subtasks || [];
    if (!subs.length) {
      list.innerHTML = '<div class="empty">No proof points yet.</div>';
      return;
    }
    list.innerHTML = subs.map(t =>
      '<div class="subtask">' +
      '<button class="check ' + (t.done ? 'done' : '') + '" data-id="' + escHtml(t.id) + '" aria-label="toggle">' +
      (t.done ? '&#10003;' : '') +
      '</button>' +
      '<span class="txt ' + (t.done ? 'done' : '') + '">' + escHtml(t.text) + '</span>' +
      '<button class="del" data-id="' + escHtml(t.id) + '" aria-label="delete">&#10005;</button>' +
      '</div>'
    ).join('');
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
    pass:    { icon: '✅', label: 'PASS' },
    partial: { icon: '⚠️', label: 'PARTIAL' },
    fail:    { icon: '❌', label: 'FAIL' },
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
    if (report && report.modelInfo && report.modelInfo.primaryModel) {
      const modelShort = String(report.modelInfo.primaryModel).split('/').pop();
      facts.push('<div class="sc-fact"><span>Model</span><b>' + escHtml(modelShort) + '</b></div>');
    }

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

    // Real data facts row — always visible.
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
    const actionsCount = (r.developerActions || (Array.isArray(r.suggestions) ? r.suggestions : [])).length;
    const evidenceCount = (Array.isArray(r.codeEvidence) ? r.codeEvidence : (Array.isArray(r.filesReviewed) ? r.filesReviewed : [])).length;
    const criteriaMetCount = Array.isArray(r.criteriaMet) ? r.criteriaMet.length : 0;
    const criteriaNotMetCount = Array.isArray(r.criteriaNotMet) ? r.criteriaNotMet.length : 0;
    const missingCount = Array.isArray(r.missingRequirements) ? r.missingRequirements.length : 0;
    const suggestionsCount = Array.isArray(r.suggestions) ? r.suggestions.length : 0;
    const qualityCount = Array.isArray(r.codeQualityNotes) ? r.codeQualityNotes.length : 0;
    const filesCount = Array.isArray(r.filesReviewed) ? r.filesReviewed.length : 0;

    // Section: Completed goals
    body += buildScorecardCollapsible('completed', 'Completed goals', completedCount, completed);

    // Section: Pending goals
    body += buildScorecardCollapsible('pending', 'Pending goals', pendingCount, pending);

    // Section: Developer actions
    body += buildScorecardCollapsible('actions', 'Next Developer Actions', actionsCount, actions);

    // Section: Code evidence
    body += buildScorecardCollapsible('evidence', 'Code Evidence', evidenceCount, evidence);

    // Section: Developer task plan
    if (r.developerTaskPlan) {
      body += buildScorecardCollapsible('devplan', 'Developer task plan', null, buildDeveloperPlanSummary(r.developerTaskPlan));
    }

    // Section: Analysis
    body += buildScorecardCollapsible('analysis', 'Analysis', null, '<div class="scorecard-text">' + escHtml(explanation) + '</div>');

    // Section: Criteria met
    if (criteriaMetCount) {
      body += buildScorecardCollapsible('critMet', 'Acceptance criteria met', criteriaMetCount,
        '<ul class="scorecard-list">' + r.criteriaMet.map(function(item) { return '<li>' + escHtml(item) + '</li>'; }).join('') + '</ul>');
    }

    // Section: Criteria not met
    if (criteriaNotMetCount) {
      body += buildScorecardCollapsible('critNotMet', 'Acceptance criteria not met', criteriaNotMetCount,
        '<ul class="scorecard-list scorecard-list-fail">' + r.criteriaNotMet.map(function(item) {
          const criterion = item && item.criterion ? item.criterion : 'Criterion';
          const reason = item && item.reason ? item.reason : 'Not satisfied by the diff.';
          return '<li><strong>' + escHtml(criterion) + '</strong><span>' + escHtml(reason) + '</span></li>';
        }).join('') + '</ul>');
    }

    // Section: Missing requirements
    if (missingCount) {
      body += buildScorecardCollapsible('missing', 'Missing requirements', missingCount, vrList(r.missingRequirements, 'fail'));
    }

    // Section: Suggestions
    if (suggestionsCount) {
      body += buildScorecardCollapsible('suggestions', 'Suggestions', suggestionsCount, vrList(r.suggestions));
    }

    // Section: Code quality notes
    if (qualityCount) {
      body += buildScorecardCollapsible('quality', 'Code quality notes', qualityCount, vrList(r.codeQualityNotes));
    }

    // Section: Validation stages
    if (detailed && validationStages && validationStages.length) {
      const stageRows = validationStages.map(function(s) {
        const icon = s.status === 'failed' ? '❌' : '✅';
        return '<div class="scorecard-stage"><span aria-hidden="true">' + icon + '</span>' + escHtml(s.name) + '</div>';
      }).join('');
      body += buildScorecardCollapsible('stages', 'Validation stages', validationStages.length,
        '<div class="scorecard-stages">' + stageRows + '</div>');
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
      body += buildScorecardCollapsible('secScores', 'Section scores', report.sectionScores.length,
        '<div class="sc-subscores">' + scoreRows + '</div>');
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
      body += buildScorecardCollapsible('secFindings', 'Security findings', report.securityFindings.length,
        '<div class="sc-sec-findings">' + secRows + '</div>');
    }

    // Section: Missing tests
    if (report && Array.isArray(report.missingTests) && report.missingTests.length) {
      const testRows = report.missingTests.map(function(t) {
        return '<div class="sc-missing-test"><strong>' + escHtml(t.title || 'Missing test') + '</strong>' +
          (t.testType ? '<span>' + escHtml(t.testType) + '</span>' : '') +
          (t.reason ? '<span>' + escHtml(t.reason) + '</span>' : '') +
        '</div>';
      }).join('');
      body += buildScorecardCollapsible('missingTests', 'Missing tests', report.missingTests.length,
        '<div class="sc-missing-tests">' + testRows + '</div>');
    }

    // Section: Files reviewed
    if (filesCount) {
      body += buildScorecardCollapsible('files', 'Files reviewed', filesCount, vrList(r.filesReviewed, 'mono'));
    }

    // Footer: action buttons.
    body += '<div class="scorecard-actions">' +
      (detailed || r.fullReport || r.developerTaskPlan || state.validateReviewResult ? '<button class="btn" id="valFullReportBtn" type="button" aria-label="Open full validation report">Open report</button>' : '') +
      '<button class="btn" id="valHistoryPageBtn" type="button" aria-label="Open Validate and Review">Reviews</button>' +
      '<button class="btn" id="valStagesCopyBtn" type="button" aria-label="Copy validation report">Copy</button>' +
      '<button class="btn" id="valStagesDismissBtn" type="button" aria-label="Hide validation result">Hide result</button>' +
      '<button class="btn primary" id="valStagesRunAgainBtn" type="button" aria-label="Run Validate and Review again">Re-run</button>' +
      '</div>';

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
    html += vrSection('Suggestions', vrList(r.suggestions));
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
    if (Array.isArray(r.suggestions) && r.suggestions.length) { lines.push('', 'Suggestions:'); r.suggestions.forEach(function(s) { lines.push('- ' + s); }); }
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
        openValidateReviewReport(id, 'full');
      } else {
        validateReview.viewMode = 'full';
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

  // Compact "AI is working" card shown while a validation run is in flight.
  // Keeps the panel small; the full step-by-step timeline is opt-in.
  function buildRunningCard() {
    const p = computeRunningProgress();
    const counter = p.total ? ('Step ' + p.step + ' of ' + p.total) : 'Working';
    let html =
      '<div class="val-working" role="status" aria-live="polite">' +
        '<span class="val-working-spinner" aria-hidden="true"></span>' +
        '<div class="val-working-body">' +
          '<div class="val-working-head">' +
            '<span class="val-working-title">' + escHtml(p.current) + '</span>' +
            '<span class="val-working-step">' + counter + '</span>' +
          '</div>' +
          '<div class="val-working-track"><div class="val-working-fill" style="width:' + Math.max(8, p.pct) + '%"></div></div>' +
        '</div>' +
      '</div>';
    const hasTimeline = validationTrace && Array.isArray(validationTrace.steps) && validationTrace.steps.length;
    if (hasTimeline) {
      html += '<button class="val-steps-toggle" id="valStepsToggleBtn" type="button" aria-expanded="' + String(valTimelineExpanded) + '">' +
        (valTimelineExpanded ? '▾ Hide steps' : '▸ Show steps') + '</button>';
      if (valTimelineExpanded) { html += '<div class="val-timeline-wrap">' + buildValidationTimeline(validationTrace) + '</div>'; }
    }
    return html;
  }

  function renderValidationStages() {
    const panel = $('valStagesPanel');
    const list = $('valStagesList');
    if (!panel || !list) { return; }
    const titleEl = panel.querySelector('.val-stages-title');

    if (valPanelState === 'idle') {
      panel.classList.add('hidden');
      return;
    }

    panel.classList.remove('hidden');
    if (titleEl) {
      titleEl.textContent = valPanelState === 'running'
        ? 'Validating'
        : valPanelState === 'error'
          ? 'Validation failed'
          : 'Validation result';
    }
    const isMax = validationRunningTier === 'max';
    const isDone = valPanelState === 'done';
    const isError = valPanelState === 'error';

    let html = '';

    if (isDone) {
      const r = state.validationResult;
      html = r ? buildScorecard(r, isMax) : '';
    } else if (valPanelState === 'running') {
      html = buildRunningCard();
    } else if (isError) {
      const msg = valLastError || 'Validation service temporarily unavailable';
      html = '<div class="val-stages-error" role="alert">' +
        '<span>&#9888; ' + escHtml(msg) + '</span>' +
        '<button class="val-stages-error-retry" id="valStagesRetryBtn" aria-label="Retry validation">Retry</button>' +
        '</div>';
      list.innerHTML = html;
      const retryBtn = $('valStagesRetryBtn');
    if (retryBtn) { retryBtn.onclick = function() { vscode.postMessage({ type: 'buttonClick', action: 'validateReview' }); }; }
      return;
    }

    list.innerHTML = html;
    list.setAttribute('role', 'list');

    const stepsToggle = $('valStepsToggleBtn');
    if (stepsToggle) { stepsToggle.onclick = function() { valTimelineExpanded = !valTimelineExpanded; renderValidationStages(); }; }

    // Bind collapsible section toggles in the scorecard.
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

    const runAgainBtn = $('valStagesRunAgainBtn');
    if (runAgainBtn) { runAgainBtn.onclick = function() { vscode.postMessage({ type: 'buttonClick', action: 'validateReview' }); }; }
    const dismissBtn = $('valStagesDismissBtn');
    if (dismissBtn) { dismissBtn.onclick = function() { valPanelState = 'idle'; renderValidationStages(); }; }
    const copyBtn = $('valStagesCopyBtn');
    if (copyBtn) { copyBtn.onclick = function() {
      const r = state.validationResult;
      if (!r) { return; }
      navigator.clipboard.writeText(scorecardCopyText(r));
      const prev = copyBtn.textContent;
      copyBtn.textContent = 'Copied ✓';
      setTimeout(function() { copyBtn.textContent = prev; }, 1400);
    }; }
    const fullReportBtn = $('valFullReportBtn');
    if (fullReportBtn) { fullReportBtn.onclick = function() { openValidationDetail(); }; }
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
    const wrap = $('validationWrap');
    if (wrap) { wrap.classList.remove('hidden'); }
    const body = $('validationBody');
    if (body && body.classList.contains('hidden')) { body.classList.remove('hidden'); }
    const arrow = document.querySelector('.section-toggle[data-target="validationBody"] .toggle-arrow');
    if (arrow) { arrow.textContent = '\u25BC'; }
  }

  function renderValidation() {
    const wrap = $('validationWrap');
    const pastWrap = $('pastReviewsWrap');
    const r = state.validationResult;
    if (!wrap) { return; }
    const isCore = userTier === 'CORE' || userTier === 'FREE' || userTier === 'free';
    const isProMax = userTier === 'PRO' || userTier === 'MAX' || userTier === 'pro' || userTier === 'max';
    const showHistory = r || validationHistory.length > 0 || isCore || isProMax;
    wrap.classList.toggle('hidden', !showHistory);
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
    // The compact scorecard (inside #valStagesPanel) is now the single source of
    // truth for results. Keep the empty-state hint only while idle with no run,
    // and retire the old verbose result card entirely to avoid a duplicate.
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
    if (!report.id) {
      report.id = 'review_' + [
        report.createdAt || 'local',
        report.currentBranch || 'branch',
        report.reviewMode || 'mode',
        (report.changedFiles || []).join('_') || 'files',
      ].join('_').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 120);
    }
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

  function renderCodeReviewReports() {
    const listEl = $('reviewReportList');
    const emptyEl = $('reviewHistoryEmpty');
    const countEl = $('reviewListCount');
    if (!listEl) { return; }
    const reports = codeReview.reports || [];
    if (countEl) { countEl.textContent = String(reports.length) + ' result' + (reports.length === 1 ? '' : 's'); }
    if (emptyEl) { emptyEl.classList.toggle('hidden', reports.length > 0); }
    listEl.innerHTML = reports.map(function(report) {
      const reportId = ensureCodeReviewReportId(report);
      const selected = codeReview.selectedReportId === report.id ? ' selected' : '';
      const details = report.reviewDetails || {};
      const issueCount = (report.mustFix || []).length + (report.inlineComments || []).length;
      const meta = [
        report.reviewMode ? reviewModeLabel(report.reviewMode) : '',
        report.currentBranch ? report.currentBranch : '',
        report.score !== undefined ? report.score + '/100' : '',
        report.riskLevel ? 'Risk ' + capitalize(report.riskLevel) : '',
        details.reviewedFileCount ? details.reviewedFileCount + ' file' + (details.reviewedFileCount === 1 ? '' : 's') : '',
        issueCount ? issueCount + ' issue' + (issueCount === 1 ? '' : 's') : '',
        report.createdAt ? fmtRelative(report.createdAt) : '',
      ].filter(Boolean).join(' · ');
      return '<button class="vr-report-card' + selected + '" type="button" data-code-review-id="' + escHtml(reportId) + '">' +
        '<div class="vr-report-top"><strong>' + escHtml(report.summary || 'Code review result') + '</strong><span class="review-badge ' + escHtml(report.status || 'needs_work') + '">' + escHtml((report.status || 'needs_work').replace(/_/g, ' ')) + '</span></div>' +
        '<div class="vr-report-meta">' + escHtml(meta || 'Ready to inspect') + '</div>' +
      '</button>';
    }).join('');
    listEl.querySelectorAll('[data-code-review-id]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        openCodeReviewReport(btn.getAttribute('data-code-review-id'));
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

  function setValidateReviewRunner(on) {
    const runner = $('validateReviewRunner');
    const fill = $('validateReviewRunnerFill');
    if (runner) { runner.classList.toggle('active', on); }
    if (fill) { fill.style.width = on ? '100%' : '0%'; }
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
      errorEl.textContent = validateReview.error || '';
    }
    if (runBtn) { runBtn.disabled = validateReview.running; runBtn.textContent = validateReview.running ? 'Reviewing…' : 'Run Review'; }

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
      docContainer.querySelectorAll('[data-compliance-export]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          const format = btn.getAttribute('data-compliance-export') || 'markdown';
          const report = getSelectedValidateReviewReport() || r;
          vscode.postMessage({ type: 'exportComplianceEvidence', format: format, report: report });
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
    if (r.modelInfo && r.modelInfo.primaryModel) { chips.push(['Model', r.modelInfo.primaryModel]); }
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
    const colors = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#a371f7', '#79c0ff', '#ffa657', '#8b949e'];
    const bar = rows.map(function(row, index) {
      return '<span class="vr-lang-seg" style="width:' + row.percent + '%;background:' + colors[index % colors.length] + '" title="' + escHtml(row.language) + ' ' + row.percent + '%"></span>';
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

  function renderOverviewPanel(r) {
    const summary = shortReviewSummary(r);
    const overall = normalizeReviewScore(r.score);
    const security = reviewScoreValue(r, 'security');
    const compliance = reviewScoreValue(r, 'compliance');
    return '<section class="vr-overview-card">' +
      '<div class="vr-overview-gauges">' +
        renderScoreGauge('Overall', overall, false) +
        renderScoreGauge('Security', security, false) +
        renderScoreGauge('Compliance', compliance, r.complianceStatus && r.complianceStatus !== 'not_enabled') +
      '</div>' +
      renderComplianceOverviewStrip(r) +
      (summary ? '<p class="vr-short-summary">' + escHtml(summary) + '</p>' : '') +
      renderReviewMetaChips(r) +
    '</section>';
  }

  function renderInsightsRow(r) {
    return '<div class="vr-insight-row">' +
      '<section class="vr-insight-card">' +
        '<div class="vr-insight-title">Languages</div>' +
        renderLanguagesPanel(r) +
      '</section>' +
      '<section class="vr-insight-card vr-contrib-card">' +
        '<div class="vr-insight-title">Contributors</div>' +
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
    const toggleBar = '<div class="vr-view-toggle">' +
      '<button class="vr-view-toggle-btn' + (viewMode === 'structured' ? ' active' : '') + '" data-view="structured">Overview</button>' +
      '<button class="vr-view-toggle-btn' + (viewMode === 'full' ? ' active' : '') + '" data-view="full">Detail Report</button>' +
    '</div>';
    const topBlock = renderOverviewPanel(r) +
      renderActionNeededPanel(r) +
      renderInsightsRow(r);

    if (viewMode === 'full') {
      return '<article class="vr-structured-doc vr-doc-aligned">' + toggleBar + topBlock +
        renderDetailedReviewSections(r, sectionScores) +
        renderCollapsibleReviewSection('Architecture', flowSummaryText(r), renderArchitectureFlowSection(r), false, 'vr-architecture-collapsible') +
        (r.securityDataFlows && r.securityDataFlows.length
          ? renderCollapsibleReviewSection('Data flow', '', renderSecurityDataFlowSection(r), false, 'vr-security-flow-collapsible')
          : '') +
        renderCollapsibleReviewSection('Changed files', String(changedCount), renderVisualDiffSection(r), false, 'vr-diff-collapsible') +
      '</article>';
    }

    return '<article class="vr-structured-doc vr-doc-aligned">' + toggleBar + topBlock +
      renderSectionsPanel(r, sectionScores) +
      renderCollapsibleReviewSection('Changed files', String(changedCount || findingCount), renderVisualDiffSection(r), false, 'vr-diff-collapsible') +
      renderCollapsibleReviewSection('Architecture', flowSummaryText(r), renderArchitectureFlowSection(r), false, 'vr-architecture-collapsible') +
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

  function renderActionNeededPanel(r) {
    const hasPm = hasLinkedPmTaskForScope(r);
    const pending = hasPm ? (r.pendingGoals || []).slice(0, 3) : [];
    const topFindings = (r.findings || [])
      .filter(function(f) { return f.severity === 'critical' || f.severity === 'high'; })
      .slice(0, 4);
    const count = pending.length + topFindings.length;

    if (!hasPm && !topFindings.length) {
      return renderActionToggle('empty', 'Action Needed', 'No urgent items.', false, '');
    }
    if (!count) {
      return renderActionToggle('ok', 'Action Needed', 'No urgent follow-ups.', false, '');
    }

    const items = []
      .concat(pending.map(function(goal) {
        return '<li><strong>Scope</strong> ' + escHtml(goal.title || goal) + '</li>';
      }))
      .concat(topFindings.map(function(f) {
        return '<li><strong>' + escHtml((f.severity || 'high').toUpperCase()) + '</strong> ' + escHtml(f.title || 'Finding') +
          (f.file ? ' <span class="vr-finding-loc">' + escHtml(f.file) + (f.line ? ':' + f.line : '') + '</span>' : '') +
        '</li>';
      }))
      .join('');
    return renderActionToggle(
      'alert',
      'Action Needed',
      count + ' urgent follow-up' + (count === 1 ? '' : 's') + ' to review',
      false,
      '<ul class="vr-action-list">' + items + '</ul>'
    );
  }

  function renderActionToggle(state, title, subtitle, open, body) {
    const iconClass = state === 'alert' ? 'vr-action-icon-alert' : state === 'ok' ? 'vr-action-icon-ok' : 'vr-action-icon-empty';
    const icon = state === 'alert' ? '!' : state === 'ok' ? '✓' : '○';
    return '<details class="vr-action-needed vr-action-card vr-action-' + state + '"' + (open ? ' open' : '') + '>' +
      '<summary>' +
        '<span class="vr-action-icon ' + iconClass + '">' + icon + '</span>' +
        '<span class="vr-action-toggle-text">' +
          '<span class="vr-action-needed-title">' + escHtml(title) + '</span>' +
          '<span class="vr-action-sub">' + escHtml(subtitle) + '</span>' +
        '</span>' +
        '<span class="vr-action-toggle-chevron" aria-hidden="true"></span>' +
      '</summary>' +
      (body ? '<div class="vr-action-card-body">' + body + '</div>' : '') +
    '</details>';
  }

  function flowSummaryText(r) {
    const flow = flowFromReport(r);
    if (!flow || !flow.nodes || !flow.nodes.length) { return ''; }
    return String((flow.nodes || []).length) + ' nodes';
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
      'Tyne provides developer-assistance compliance assessments based on reviewed code changes and available evidence. This is not a compliance certification, audit, legal opinion, or guarantee of security.';
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
    html += '<p class="vr-compliance-disclaimer" role="note">' + escHtml(disclaimer) + '</p>';
    if (r.privacyInfo) {
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
    html += '<div class="vr-compliance-export btn-row">' +
      '<button type="button" class="btn btn-sm" data-compliance-export="markdown">Export Markdown</button>' +
      '<button type="button" class="btn btn-sm" data-compliance-export="json">Export JSON</button>' +
      '<button type="button" class="btn btn-sm" data-compliance-export="pdf">Export PDF</button>' +
      '</div>';
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
      const findingPins = fileFindings.length
        ? '<div class="vr-diff-findings">' + fileFindings.map(function(f) {
            return '<div class="vr-diff-finding-pin ' + escHtml(f.severity || 'medium') + '" data-finding-id="' + escHtml(f.id || '') + '">' +
              '<span class="vr-sev-chip ' + escHtml(f.severity || 'medium') + '">' + escHtml(f.severity || 'medium') + '</span>' +
              '<span class="vr-diff-finding-title">' + escHtml(f.title || '') + '</span>' +
              (f.line ? '<span class="vr-diff-finding-loc">L' + f.line + '</span>' : '') +
            '</div>';
          }).join('') + '</div>'
        : '';
      return '<details class="vr-diff-file">' +
        '<summary>' +
          '<span class="vr-diff-status ' + escHtml(d.status || 'modified') + '">' + statusIcon + '</span>' +
          '<code class="vr-diff-filepath">' + escHtml(d.file || '') + '</code>' +
          '<span class="vr-diff-stats">+' + (d.additions || 0) + ' -' + (d.deletions || 0) + '</span>' +
          (fileFindings.length ? '<span class="vr-diff-finding-count">' + fileFindings.length + ' finding' + (fileFindings.length === 1 ? '' : 's') + '</span>' : '') +
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

  function reviewStatusMeta(status) {
    switch (status) {
      case 'passed': return { label: 'Validation Passed', scoreClass: 'pass' };
      case 'blocked': return { label: 'Blocked', scoreClass: 'fail' };
      case 'context_limited': return { label: 'Context Limited', scoreClass: 'partial' };
      case 'needs_work':
      default: return { label: 'Needs Work', scoreClass: 'partial' };
    }
  }

  const REVIEW_SECTION_DEFS = [
    { id: 'scope_alignment', title: 'Scope alignment', categories: ['pm_alignment'] },
    { id: 'correctness', title: 'Correctness', categories: ['correctness', 'breaking_change'] },
    { id: 'tests', title: 'Tests', categories: ['test_coverage'] },
    { id: 'security', title: 'Security', categories: ['security'] },
    { id: 'compliance', title: 'Compliance', categories: ['compliance'] },
    { id: 'maintainability', title: 'Maintainability', categories: ['maintainability', 'performance', 'style'] },
    { id: 'vibe_code', title: 'Vibe-code risk', categories: ['vibe_code'] },
  ];

  function reviewSectionFallbackScore(id, r) {
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
    return REVIEW_SECTION_DEFS.map(function(def) {
      const found = incoming.find(function(item) { return item && item.id === def.id; });
      const score = normalizeReviewScore(found && found.score !== undefined ? found.score : reviewSectionFallbackScore(def.id, r));
      const related = (r.findings || []).filter(function(f) { return def.categories.includes(f.category); }).map(function(f) { return f.id; });
      return {
        id: def.id,
        title: (found && found.title) || def.title,
        score: score,
        status: (found && found.status) || reviewSectionStatus(score),
        summary: (found && found.summary) || (related.length ? related.length + ' finding' + (related.length === 1 ? '' : 's') : ''),
        findingIds: (found && Array.isArray(found.findingIds) && found.findingIds.length) ? found.findingIds : related,
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
        const accordions = group.sections
          .map(function(id) { return byId[id]; })
          .filter(Boolean)
          .map(function(section) { return renderReviewScoreAccordion(r, section, false); })
          .join('');
        if (!accordions) { return ''; }
        return '<details class="vr-detail-review-group">' +
          '<summary class="vr-detail-review-head"><span>' + escHtml(group.title) + '</span></summary>' +
          '<div class="vr-detail-review-body">' + accordions + '</div>' +
        '</details>';
      }).join('') +
    '</section>';
  }

  function renderReviewScoreAccordion(r, section, open) {
    const details = renderReviewSectionDetails(r, section);
    const statusIcon = section.status === 'good' ? '✓' : section.status === 'bad' ? '✕' : section.status === 'warn' ? '!' : '○';
    const titleIcon = section.id === 'security' ? '◈'
      : section.id === 'compliance' ? '⚖'
      : section.id === 'scope_alignment' ? '◎'
      : section.id === 'correctness' ? '✓'
      : section.id === 'tests' ? '𝚃'
      : section.id === 'maintainability' ? '✎'
      : section.id === 'vibe_code' ? '♦'
      : '○';
    return '<details class="vr-score-accordion ' + escHtml(section.status || 'neutral') + '"' + (open ? ' open' : '') + '>' +
      '<summary>' +
        '<span class="vr-score-title"><span class="vr-score-title-icon" aria-hidden="true">' + titleIcon + '</span>' + escHtml(section.title) + '</span>' +
        '<span class="vr-score-meter" aria-hidden="true"><i style="width:' + normalizeReviewScore(section.score) + '%"></i></span>' +
        '<span class="vr-score-pill"><span class="vr-score-status ' + escHtml(section.status || 'neutral') + '">' + statusIcon + '</span>' + normalizeReviewScore(section.score) + '</span>' +
      '</summary>' +
      '<div class="vr-score-body">' +
        details +
      '</div>' +
    '</details>';
  }

  function renderReviewSectionDetails(r, section) {
    const ids = Array.isArray(section.findingIds) ? section.findingIds : [];
    const findings = (r.findings || []).filter(function(f) { return ids.includes(f.id); });
    let html = '';
    if (section.id === 'scope_alignment') {
      if (!hasLinkedPmTaskForScope(r)) {
        html += renderScopeAlignmentEmptyState();
      } else {
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
      html += renderFindingList(findings);
    }
    if (section.id === 'vibe_code' && !findings.length) {
      html += '<div class="vr-section-empty">No vibe-code risk.</div>';
    }
    if (section.id === 'compliance' && !findings.length && !(r.complianceFindings || []).length && !(r.dataClassifications || []).length) {
      html += '<div class="vr-section-empty">No detected violations in reviewed code changes.</div>';
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
          : '<div class="vr-pending-actions">' +
              '<button class="vr-fa-btn fix-goal" data-action="fix_goal" data-goal-id="' + escHtml(goalId) + '" data-goal-index="' + index + '" data-file="' + escHtml(fileHint) + '" title="Open related file or copy the suggested action">I\'ll fix this</button>' +
              '<button class="vr-fa-btn out-of-scope" data-action="out_of_scope" data-goal-id="' + escHtml(goalId) + '" data-goal-index="' + index + '" title="Mark this gap as intentionally out of scope">Out of scope</button>' +
              '<button class="vr-fa-btn create-task" data-action="create_task_from_goal" data-goal-id="' + escHtml(goalId) + '" data-goal-index="' + index + '" title="Create a follow-up Jira/Linear task">Create task</button>' +
            '</div>';
        return '<div class="vr-pending-row' + (prior ? ' resolved' : '') + '" data-goal-id="' + escHtml(goalId) + '">' +
          '<div class="vr-pending-head">' +
            (item.priority ? '<span class="vr-sev-chip ' + escHtml(item.priority === 'high' ? 'high' : (item.priority === 'low' ? 'low' : 'medium')) + '">' + escHtml(item.priority) + '</span>' : '') +
            '<strong>' + escHtml(item.title || 'Pending goal') + '</strong>' +
          '</div>' +
          (item.reason ? '<p>' + escHtml(item.reason) + '</p>' : '') +
          (item.suggestedAction ? '<p class="vr-pending-action"><b>Suggested:</b> ' + escHtml(item.suggestedAction) + '</p>' : '') +
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

  function persistAppliedFindingFixes() {
    persistReviewUiState();
  }

  function persistReviewUiState() {
    if (typeof vscode.setState === 'function') {
      persistedWebviewState.appliedFindingFixes = appliedFindingFixes;
      persistedWebviewState.findingFeedbackByKey = findingFeedbackByKey;
      persistedWebviewState.pendingGoalFeedbackByKey = pendingGoalFeedbackByKey;
      vscode.setState(Object.assign({}, persistedWebviewState, {
        appliedFindingFixes: appliedFindingFixes,
        findingFeedbackByKey: findingFeedbackByKey,
        pendingGoalFeedbackByKey: pendingGoalFeedbackByKey,
      }));
    }
  }

  function feedbackLabel(verdict) {
    if (verdict === 'accepted') { return 'Useful'; }
    if (verdict === 'out_of_scope') { return 'Out of scope'; }
    return String(verdict || '').replace(/_/g, ' ');
  }

  function renderFindingActions(f) {
    const feedbackKey = findingFixKey(f.id || '');
    const prior = findingFeedbackByKey[feedbackKey];
    if (prior) {
      return '<div class="vr-finding-actions"><span class="vr-feedback-confirmed">' + escHtml(feedbackLabel(prior)) + '</span></div>';
    }
    return '<div class="vr-finding-actions">' +
      '<button class="vr-fa-btn accept" data-action="accept" data-finding-id="' + escHtml(f.id || '') + '" title="Mark as a useful / valid finding">Useful</button>' +
      '<details class="vr-ignore-menu">' +
        '<summary class="vr-fa-btn dismiss">Ignore</summary>' +
        '<div class="vr-ignore-options">' +
          '<button class="vr-fa-btn dismiss" data-action="dismiss" data-finding-id="' + escHtml(f.id || '') + '" title="Dismiss this finding">Dismiss</button>' +
          '<button class="vr-fa-btn not-relevant" data-action="not_relevant" data-finding-id="' + escHtml(f.id || '') + '" title="Not relevant to this change">Not relevant</button>' +
          '<button class="vr-fa-btn wrong" data-action="wrong" data-finding-id="' + escHtml(f.id || '') + '" title="False positive">Wrong</button>' +
        '</div>' +
      '</details>' +
      '<button class="vr-fa-btn create-task" data-action="create_task" data-finding-id="' + escHtml(f.id || '') + '" title="Create Jira/Linear task from this finding">Create task</button>' +
    '</div>';
  }

  function renderFindingList(items) {
    if (!Array.isArray(items) || !items.length) { return ''; }
    return '<div class="vr-finding-stack">' +
      items.slice(0, 8).map(function(f) {
        const fixKey = findingFixKey(f.id || '');
        const appliedFix = !!appliedFindingFixes[fixKey];
        const priorFeedback = findingFeedbackByKey[fixKey];
        const loc = f.file ? f.file + (f.line ? ':' + f.line : '') : '';
        const archImpact = f.architectureImpact ? '<div class="vr-arch-impact">' + escHtml(f.architectureImpact) + '</div>' : '';
        const fixButtons = f.suggestedFix
          ? '<div class="vr-autofix-actions">' +
              '<button class="vr-fa-btn preview-fix" data-action="preview_fix" data-finding-id="' + escHtml(f.id || '') + '" title="Show a side-by-side diff of the proposed fix">' + (appliedFix ? 'View file' : 'Preview') + '</button>' +
              '<button class="vr-fa-btn apply-fix' + (appliedFix ? ' applied' : '') + '" data-action="apply_fix" data-finding-id="' + escHtml(f.id || '') + '" title="Apply suggested fix to file"' + (appliedFix ? ' disabled' : '') + '>' + (appliedFix ? 'Applied' : 'Apply') + '</button>' +
              (appliedFix ? '<button class="vr-fa-btn undo-fix" data-action="undo_fix" data-finding-id="' + escHtml(f.id || '') + '" title="Undo applied fix">Undo</button>' : '') +
              (!appliedFix ? '<button class="vr-fa-btn discard-fix" data-action="discard_fix" data-finding-id="' + escHtml(f.id || '') + '" title="Discard suggested fix">Discard</button>' : '') +
            '</div>'
          : '';
        const sevClass = escHtml(f.severity || 'medium');
        const sevIcon = f.severity === 'critical' ? '✕' : f.severity === 'high' ? '✕' : f.severity === 'medium' ? '⚠' : '○';
        return '<div class="vr-finding-row ' + sevClass + (priorFeedback ? ' resolved' : '') + '" data-finding-id="' + escHtml(f.id || '') + '">' +
          '<div class="vr-finding-head">' +
            '<span class="vr-sev-badge ' + sevClass + '">' + sevIcon + ' ' + sevClass + '</span>' +
          '</div>' +
          '<button type="button" class="vr-finding-title-btn" data-action="open_finding" data-finding-id="' + escHtml(f.id || '') + '" title="Open in editor">' +
            '<strong class="vr-finding-title">' + escHtml(f.title || 'Finding') + '</strong>' +
          '</button>' +
          (loc ? '<button type="button" class="vr-finding-loc" data-action="open_finding" data-finding-id="' + escHtml(f.id || '') + '" title="Open in editor">' + escHtml(loc) + '</button>' : '') +
          (f.explanation ? '<p class="vr-finding-body">' + escHtml(f.explanation) + '</p>' : '') +
          archImpact +
          (f.suggestedFix ? '<pre class="vr-suggested-fix" data-finding-id="' + escHtml(f.id || '') + '">' + escHtml(f.suggestedFix) + '</pre>' : '') +
          fixButtons +
          renderFindingActions(f) +
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
    return enrichArchitectureNodes(nodes || []).slice(0, 16);
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

    const nodes = files.map(function(f, index) {
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

    const edges = [];
    for (let i = 1; i < nodes.length; i++) {
      if (nodes[i].layer === nodes[i - 1].layer) {
        edges.push({ from: nodes[i - 1].id, to: nodes[i].id });
      }
    }

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
      const rawNodes = aiFlow.nodes.slice(0, 16).map(function(node, index) {
        return Object.assign({}, node, {
          id: node.id || ('node_' + (index + 1)),
          label: node.label || shortArchLabel(node.file) || ('Node ' + (index + 1)),
        });
      });
      const mergedNodes = mergeDiffIntoArchitectureNodes(rawNodes, files, findings);
      const nodeIds = new Set(mergedNodes.map(function(n) { return n.id; }));
      const edges = (Array.isArray(aiFlow.edges) ? aiFlow.edges : []).filter(function(e) {
        return e && nodeIds.has(e.from) && nodeIds.has(e.to);
      }).slice(0, 18);
      const changedCount = mergedNodes.filter(function(n) { return n.changed; }).length;
      return {
        title: aiFlow.title || 'Architecture Flow',
        summary: aiFlow.summary || (changedCount
          ? (changedCount + ' area' + (changedCount === 1 ? '' : 's') + ' touched in this review')
          : 'Architecture map for this change set.'),
        layers: resolveFlowLayers(mergedNodes, aiFlow.layers),
        nodes: mergedNodes,
        edges: edges,
        totalAdditions: aiFlow.totalAdditions !== undefined ? aiFlow.totalAdditions : totalAdditions,
        totalDeletions: aiFlow.totalDeletions !== undefined ? aiFlow.totalDeletions : totalDeletions,
        whatWentRight: aiFlow.whatWentRight || [],
        whatWentWrong: aiFlow.whatWentWrong || [],
      };
    }

    const diffFlow = buildArchitectureFlowFromDiff(r);
    if (diffFlow) { return diffFlow; }

    return {
      title: 'Architecture Flow',
      summary: 'No architecture changes detected in this review.',
      layers: [],
      nodes: [],
      edges: [],
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
    const total = [flow.totalAdditions !== undefined ? '+' + flow.totalAdditions : '', flow.totalDeletions !== undefined ? '-' + flow.totalDeletions : ''].filter(Boolean).join(' / ');
    return '<section class="vr-architecture-flow">' +
      ((flow.summary || total)
        ? '<div class="vr-flow-meta">' +
            (flow.summary ? '<p>' + escHtml(flow.summary) + '</p>' : '') +
            (total ? '<span class="vr-flow-total">' + escHtml(total) + '</span>' : '') +
          '</div>'
        : '') +
      renderFlowSvg(flow, r) +
      '<div class="vr-flow-inspector hidden" id="vrFlowInspector" aria-live="polite"></div>' +
    '</section>';
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

  function renderChangeImpactSummary() {
    // Changes live on the flowchart nodes; no separate prose panel.
    return '';
  }

  function renderFlowSvg(flow, report) {
    const nodes = (flow && flow.nodes) || [];
    const edges = (flow && flow.edges) || [];
    if (!nodes.length) {
      return '<div class="vr-flow-empty">' + escHtml(flow.summary || 'No architecture changes detected in this review.') + '</div>';
    }

    const byId = {};
    nodes.forEach(function(n) { byId[n.id] = n; });
    const n = function(id) { return byId[id] || { id: id, label: id, kind: 'file', layer: 'extension' }; };

    const W = 380;
    const CORNER = 8;
    const GROUP_HEADER = 26;
    const GROUP_PAD = 14;
    const NODE_GAP = 14;
    const NODE_PAD = 10;
    const GROUP_GAP = 22;
    const NODE_W = 168;

    function nodeDetailLines(node) {
      const lines = [];
      if (node.changed && (node.additions !== undefined || node.deletions !== undefined)) {
        lines.push('+' + (node.additions || 0) + ' / -' + (node.deletions || 0));
      }
      const files = (node.files || []).slice(0, 2).map(shortArchLabel);
      files.forEach(function(name) { lines.push(name); });
      if ((node.files || []).length > 2) {
        lines.push('+' + ((node.files || []).length - 2) + ' more');
      } else if (!files.length && node.file) {
        lines.push(shortArchLabel(node.file));
      } else if (!files.length && node.note) {
        lines.push(String(node.note).slice(0, 32));
      }
      return lines;
    }

    function nodeHeight(node) {
      const lines = nodeDetailLines(node);
      const titleBand = 16;
      if (!lines.length) { return NODE_PAD * 2 + titleBand; }
      return NODE_PAD * 2 + titleBand + lines.length * 13;
    }

    function truncateLabel(label, maxW) {
      const text = String(label || '');
      if (text.length <= maxW / 6) { return text; }
      return text.slice(0, Math.max(8, Math.floor(maxW / 6) - 1)) + '…';
    }

    const layers = (flow.layers && flow.layers.length)
      ? flow.layers
      : resolveFlowLayers(nodes, null);

    const positions = {};
    let y = 8;
    const groupBoxes = [];

    layers.forEach(function(layer) {
      const layerNodes = nodes.filter(function(node) { return node.layer === layer.id; });
      if (!layerNodes.length) { return; }

      const groupY = y;
      const contentY = groupY + GROUP_HEADER + GROUP_PAD;
      const nodeX = Math.round((W - NODE_W) / 2);
      let nodeY = contentY;
      let maxBottom = contentY;

      layerNodes.forEach(function(node) {
        const h = nodeHeight(node);
        positions[node.id] = {
          x: nodeX, y: nodeY, w: NODE_W, h: h,
          cx: nodeX + NODE_W / 2, cy: nodeY + h / 2,
          top: nodeY, bottom: nodeY + h, left: nodeX, right: nodeX + NODE_W,
        };
        nodeY += h + NODE_GAP;
        maxBottom = nodeY - NODE_GAP;
      });

      const groupH = maxBottom - groupY + GROUP_PAD;
      groupBoxes.push({ x: nodeX - GROUP_PAD, y: groupY, w: NODE_W + GROUP_PAD * 2, h: groupH, title: layer.title || layerTitleFallback(layer.id) });
      y = groupY + groupH + GROUP_GAP;
    });

    const H = Math.max(y + 8, 120);

    function strokeFor(node) {
      if (node.highlighted || node.verdict === 'wrong') { return '#f85149'; }
      if (node.changed || node.verdict === 'mixed') { return '#58a6ff'; }
      return '#6e7681';
    }

    function dist(a, b) {
      return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function roundedRoute(points, radius) {
      if (!points || points.length < 2) { return ''; }
      const r = Math.max(2, radius || CORNER);
      let d = 'M ' + points[0].x + ' ' + points[0].y;
      for (let i = 1; i < points.length - 1; i++) {
        const prev = points[i - 1];
        const curr = points[i];
        const next = points[i + 1];
        const len1 = dist(prev, curr);
        const len2 = dist(curr, next);
        const rr = Math.min(r, len1 / 2, len2 / 2);
        const dx1 = prev.x === curr.x ? 0 : (prev.x < curr.x ? -1 : 1);
        const dy1 = prev.y === curr.y ? 0 : (prev.y < curr.y ? -1 : 1);
        const dx2 = next.x === curr.x ? 0 : (next.x < curr.x ? -1 : 1);
        const dy2 = next.y === curr.y ? 0 : (next.y < curr.y ? -1 : 1);
        const p1a = { x: curr.x + dx1 * rr, y: curr.y + dy1 * rr };
        const p1b = { x: curr.x + dx2 * rr, y: curr.y + dy2 * rr };
        d += ' L ' + p1a.x + ' ' + p1a.y + ' Q ' + curr.x + ' ' + curr.y + ' ' + p1b.x + ' ' + p1b.y;
      }
      const last = points[points.length - 1];
      d += ' L ' + last.x + ' ' + last.y;
      return d;
    }

    function routeEdgeBetween(fromPos, toPos) {
      if (!fromPos || !toPos) { return ''; }
      const midY = Math.round((fromPos.bottom + toPos.top) / 2);
      if (Math.abs(fromPos.cx - toPos.cx) < 4) {
        return '<path class="vr-flow-svg-edge" d="' + roundedRoute([
          { x: fromPos.cx, y: fromPos.bottom },
          { x: toPos.cx, y: toPos.top },
        ], CORNER) + '" fill="none" marker-end="url(#vrFlowArrow)"></path>';
      }
      return '<path class="vr-flow-svg-edge" d="' + roundedRoute([
        { x: fromPos.cx, y: fromPos.bottom },
        { x: fromPos.cx, y: midY },
        { x: toPos.cx, y: midY },
        { x: toPos.cx, y: toPos.top },
      ], CORNER) + '" fill="none" marker-end="url(#vrFlowArrow)"></path>';
    }

    function nodeTextBlock(node, p, titleY) {
      const lines = nodeDetailLines(node);
      if (!lines.length) { return ''; }
      return lines.map(function(line, index) {
        return '<text class="vr-flow-svg-sub" x="' + p.cx + '" y="' + (titleY + 14 + index * 13) + '" text-anchor="middle">' + escHtml(line) + '</text>';
      }).join('');
    }

    function nodeAttrs(node, id, extraClass) {
      const clickable = node.changed && ((node.files || []).length || node.file);
      const fileList = (node.files || []).length ? node.files : (node.file ? [node.file] : []);
      let cls = 'vr-flow-svg-node';
      if (extraClass) { cls += ' ' + extraClass; }
      if (node.changed) { cls += ' changed'; }
      if (clickable) { cls += ' clickable'; }
      let attrs = ' class="' + cls + '" data-node-id="' + escHtml(id) + '"';
      if (clickable) {
        attrs += ' role="button" tabindex="0"';
        attrs += ' data-file-path="' + escHtml(fileList[0]) + '"';
        attrs += ' data-file-list="' + escHtml(fileList.join(',')) + '"';
        attrs += ' data-node-label="' + escHtml(node.label || id) + '"';
        attrs += ' data-additions="' + escHtml(String(node.additions || 0)) + '"';
        attrs += ' data-deletions="' + escHtml(String(node.deletions || 0)) + '"';
        attrs += ' aria-label="' + escHtml((node.label || id) + ': ' + fileList.join(', ')) + '"';
      }
      return attrs;
    }

    function boxNode(id) {
      const node = n(id);
      const p = positions[id];
      if (!p) { return ''; }
      const stroke = strokeFor(node);
      const fill = node.changed ? '#152238' : '#30363d';
      const title = escHtml(truncateLabel(node.label || id, p.w));
      const titleY = p.y + NODE_PAD + 12;
      return '<g' + nodeAttrs(node, id) + '>' +
        '<rect x="' + p.x + '" y="' + p.y + '" width="' + p.w + '" height="' + p.h + '" rx="5" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"></rect>' +
        '<text class="vr-flow-svg-label" x="' + p.cx + '" y="' + titleY + '" text-anchor="middle" dominant-baseline="middle">' + title + '</text>' +
        nodeTextBlock(node, p, titleY) +
      '</g>';
    }

    function dbNode(id) {
      const node = n(id);
      const p = positions[id];
      if (!p) { return ''; }
      const stroke = strokeFor(node);
      const fill = node.changed ? '#152238' : '#30363d';
      const h = p.h;
      const w = p.w;
      const x = p.x;
      const y = p.y;
      const ry = 9;
      const titleY = y + ry + 18;
      return '<g' + nodeAttrs(node, id, 'database') + '>' +
        '<path d="M ' + x + ' ' + (y + ry) + ' C ' + x + ' ' + y + ', ' + (x + w) + ' ' + y + ', ' + (x + w) + ' ' + (y + ry) +
          ' L ' + (x + w) + ' ' + (y + h - ry) + ' C ' + (x + w) + ' ' + (y + h) + ', ' + x + ' ' + (y + h) + ', ' + x + ' ' + (y + h - ry) + ' Z" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"></path>' +
        '<ellipse cx="' + p.cx + '" cy="' + (y + ry) + '" rx="' + (w / 2) + '" ry="' + ry + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"></ellipse>' +
        '<text class="vr-flow-svg-label" x="' + p.cx + '" y="' + titleY + '" text-anchor="middle" dominant-baseline="middle">' + escHtml(truncateLabel(node.label || 'Database', p.w)) + '</text>' +
        nodeTextBlock(node, p, titleY) +
      '</g>';
    }

    function groupBox(x, y, w, h, title) {
      const dividerY = y + GROUP_HEADER;
      return '<rect class="vr-flow-svg-group" x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="8"></rect>' +
        '<line class="vr-flow-svg-group-divider" x1="' + (x + 1) + '" y1="' + dividerY + '" x2="' + (x + w - 1) + '" y2="' + dividerY + '"></line>' +
        '<text class="vr-flow-svg-group-label" x="' + (x + 12) + '" y="' + (y + 18) + '" dominant-baseline="middle">' + escHtml(title) + '</text>';
    }

    const groupsSvg = groupBoxes.map(function(g) {
      return groupBox(g.x, g.y, g.w, g.h, g.title);
    }).join('');

    const edgesSvg = edges.map(function(edge) {
      return routeEdgeBetween(positions[edge.from], positions[edge.to]);
    }).join('');

    const nodesSvg = nodes.map(function(node) {
      if (node.kind === 'database' || node.layer === 'database') {
        return dbNode(node.id);
      }
      return boxNode(node.id);
    }).join('');

    return '<div class="vr-flow-canvas flowchart"><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMin meet" role="img" aria-label="Project architecture flowchart">' +
      '<defs><marker id="vrFlowArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#9da7b3"></path></marker></defs>' +
      groupsSvg + edgesSvg + nodesSvg +
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
    const failed = r.status === 'blocked' || r.status === 'needs_work';
    const statusText = failed ? 'Validation Failed' : r.status === 'context_limited' ? 'Context Limited' : 'Validation Passed';
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
      'Tyne provides developer-assistance compliance assessments based on reviewed code changes and available evidence. This is not a compliance certification, audit, legal opinion, or guarantee of security.';
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
    if (!report.id) {
      report.id = 'validate_review_' + [
        report.createdAt || 'local',
        report.commitSha || report.branchName || report.issueIdentifier || 'report',
        index || 0,
      ].join('_').replace(/[^A-Za-z0-9_-]+/g, '_');
    }
    return report.id;
  }

  function openValidateReviewReport(reportId, viewMode) {
    if (!reportId) { return; }
    validateReview.selectedReportId = reportId;
    validateReview.result = getSelectedValidateReviewReport();
    validateReview.viewMode = viewMode || 'structured';
    renderValidateReview();
  }

  function reportMatchesSearch(report, search) {
    if (!search) { return true; }
    const files = (report.visualDiff || []).map(function(f) { return f.file; }).join(' ');
    const text = [
      report.issueIdentifier,
      report.issueTitle,
      report.threadId,
      report.branchName,
      report.commitSha,
      report.status,
      report.summary,
      files,
    ].filter(Boolean).join(' ').toLowerCase();
    return text.includes(search);
  }

  function renderValidateReviewReports() {
    const listEl = $('validateReviewReportList');
    const emptyEl = $('validateReviewHistoryEmpty');
    const countEl = $('validateReviewListCount');
    if (!listEl) { return; }
    const search = (validateReview.search || '').toLowerCase().trim();
    const filter = validateReview.filter || 'all';
    const reports = (validateReview.reports || []).filter(function(report) {
      return (filter === 'all' || report.status === filter) && reportMatchesSearch(report, search);
    });
    if (countEl) {
      countEl.textContent = String(reports.length || 0);
    }
    if (emptyEl) { emptyEl.classList.toggle('hidden', reports.length > 0); }

    // Keep the list calm: show recent reviews, tuck the rest behind a disclosure.
    const RECENT = 5;
    const recent = reports.slice(0, RECENT);
    const older = reports.slice(RECENT);
    function cardHtml(report, index) {
      const reportId = ensureValidateReviewReportId(report, index);
      const selected = validateReview.selectedReportId === reportId ? ' selected' : '';
      const changedCount = (report.visualDiff || []).length;
      const findingCount = (report.findings || []).length;
      const title = report.issueTitle || report.summary || 'Review';
      return '<div class="vr-report-card' + selected + '" role="button" tabindex="0" data-report-id="' + escHtml(reportId) + '">' +
        '<div class="vr-report-top"><strong>' + escHtml(title) + '</strong><span class="review-badge ' + escHtml(report.status || 'needs_work') + '">' + escHtml((report.status || 'needs_work').replace(/_/g, ' ')) + '</span></div>' +
        '<div class="vr-report-meta">' + escHtml([report.score !== undefined ? report.score + '/100' : '', findingCount ? findingCount + ' finding' + (findingCount === 1 ? '' : 's') : '', changedCount ? changedCount + ' file' + (changedCount === 1 ? '' : 's') : '', report.createdAt ? fmtRelative(report.createdAt) : ''].filter(Boolean).join(' · ')) + '</div>' +
      '</div>';
    }

    let html = recent.map(cardHtml).join('');
    if (older.length) {
      html += '<details class="vr-older-reports">' +
        '<summary>Past reviews · ' + older.length + ' more</summary>' +
        '<div class="vr-report-list">' + older.map(function(report, i) { return cardHtml(report, RECENT + i); }).join('') + '</div>' +
      '</details>';
    }
    listEl.innerHTML = html;
    listEl.querySelectorAll('[data-report-id]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        openValidateReviewReport(btn.getAttribute('data-report-id'));
      });
      btn.addEventListener('keydown', function(event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openValidateReviewReport(btn.getAttribute('data-report-id'));
        }
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
          '<div class="tags"><span class="tag">' + escHtml(String(commit.totalFilesChanged)) + ' files</span><span class="tag">+' + escHtml(String(commit.totalLinesAdded)) + '</span><span class="tag">-' + escHtml(String(commit.totalLinesDeleted)) + '</span><span class="tag status-' + escHtml(commit.linkedStatus) + '">' + escHtml(commit.linkedStatus) + '</span></div>';
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
    const chart = $('velocityChart');
    if (!chart) return;
    const sub = $('velocitySub');
    const commits = commitData.currentBranchCommits || [];
    if (!commits.length) {
      chart.innerHTML = '<div class="chart-empty">No commits yet — your velocity will appear here as you stitch.</div>';
      if (sub) sub.textContent = 'Last 14 days';
      return;
    }
    const DAYS = 14;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const buckets = [];
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      buckets.push({ date: d, commits: 0, lines: 0 });
    }
    const startMs = buckets[0].date.getTime();
    commits.forEach(c => {
      const t = new Date(c.committedAt);
      if (isNaN(t.getTime())) return;
      const dayMs = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
      const idx = Math.round((dayMs - startMs) / 86400000);
      if (idx >= 0 && idx < DAYS) {
        buckets[idx].commits += 1;
        buckets[idx].lines += (c.totalLinesAdded || 0) + (c.totalLinesDeleted || 0);
      }
    });
    const key = velocityMetric === 'lines' ? 'lines' : 'commits';
    const values = buckets.map(b => b[key]);
    const max = Math.max(1, Math.max.apply(null, values));
    const totalCommits = buckets.reduce((s, b) => s + b.commits, 0);
    const totalLines = buckets.reduce((s, b) => s + b.lines, 0);
    const activeDays = buckets.filter(b => b.commits > 0).length;
    const peak = Math.max.apply(null, values);

    const bars = buckets.map(b => {
      const h = Math.round((b[key] / max) * 100);
      const label = b.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const val = key === 'lines'
        ? (b.lines + ' lines changed')
        : (b.commits + (b.commits === 1 ? ' commit' : ' commits'));
      return '<div class="vbar-col" title="' + escHtml(label + ' · ' + val) + '">' +
        '<div class="vbar-fill" style="height:' + h + '%"></div></div>';
    }).join('');

    const firstLabel = buckets[0].date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    chart.innerHTML =
      '<div class="vbars">' + bars + '</div>' +
      '<div class="vlabels"><span>' + escHtml(firstLabel) + '</span><span>Today</span></div>' +
      '<div class="vstat-row">' +
        '<div class="vstat"><b>' + totalCommits + '</b>commits</div>' +
        '<div class="vstat"><b>' + (key === 'lines' ? totalLines.toLocaleString() : peak) + '</b>' + (key === 'lines' ? 'lines changed' : 'peak / day') + '</div>' +
        '<div class="vstat"><b>' + activeDays + '</b>active days</div>' +
      '</div>';
    if (sub) sub.textContent = 'Last 14 days · ' + (key === 'lines' ? 'lines changed' : 'commits per day');
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
      aiAccessMode: s.aiAccessMode || aiSettings.aiAccessMode || 'byok',
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
    if (Array.isArray(s.connectedTools)) {
      _tasksConnectedTools = mergeConnectedToolsFromSnapshot(s.connectedTools, s);
      _tasksConnectingTools = _tasksConnectingTools.filter(tool => !_tasksConnectedTools.includes(tool));
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
    document.querySelectorAll('[data-provider]').forEach(b => b.classList.toggle('active', b.dataset.provider === aiSettings.aiProvider));
    document.querySelectorAll('#coreProviderSeg [data-provider], #premiumProviderSeg [data-provider]').forEach(b => b.classList.toggle('active', b.dataset.provider === (provider === 'anthropic' ? 'claude' : 'openai')));
    const masked = aiSettings.byokConfig?.ai?.maskedKey;
    $('byokStatus').textContent = aiSettings.hasBYOKKey ? (masked ? 'Saved: ' + masked : 'Key saved.') : 'No key saved.';
    $('byokStatusPremium').textContent = aiSettings.hasBYOKKey ? (masked ? 'Saved: ' + masked : 'Key saved.') : 'No key saved.';
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
      if (!btn) { return; }
      btn.textContent = text;
      btn.className = cls;
      btn.disabled = disabled;
    };
    const showAction = (btn, on) => { if (btn) { btn.classList.toggle('hidden', !on); } };

    // GitHub
    const ghRow = list.querySelector('[data-tool="github"]');
    if (ghRow) {
      const stateBtn = ghRow.querySelector('[data-action="connect"]');
      const disconnectBtn = ghRow.querySelector('[data-action="disconnect"]');
      if (isAuthenticated) {
        setStateBtn(stateBtn, 'Connected', 'btn compact conn-badge-good', true);
        setDesc(ghRow, githubUsername ? `Signed in as @${githubUsername}` : 'Account connected · draft PRs, branch push, review links');
        showAction(disconnectBtn, true);
      } else {
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
      const githubConnected = pmIntegration.githubConnected !== undefined
        ? pmIntegration.githubConnected
        : (jiraIntegration.githubConnected !== undefined ? jiraIntegration.githubConnected : isAuthenticated);
      const jiraConnected = pmToolIsConnected('jira');
      const reconnectRequired = Boolean(jiraIntegration.reconnectRequired) || (jiraConnected && isReconnectSyncError(syncError));
      const stateBtn = jiraRow.querySelector('[data-action="connect"]');
      const changeBtn = jiraRow.querySelector('[data-action="change-project"]');
      const disconnectBtn = jiraRow.querySelector('[data-action="disconnect"]');

      if (!githubConnected) {
        jiraBranch = 'github_first';
        setStateBtn(stateBtn, 'Connect GitHub first', 'btn compact conn-badge-neutral', true);
        if (stateBtn) { stateBtn.dataset.actionId = 'jiraConnectGithubBtn'; }
        setDesc(jiraRow, 'Connect GitHub first to connect Jira.');
        showAction(changeBtn, false);
        showAction(disconnectBtn, false);
      } else if (_tasksConnectingTools.includes('jira')) {
        jiraBranch = 'connecting';
        setStateBtn(stateBtn, 'Connecting…', 'btn compact conn-badge-neutral is-loading', true);
        setDesc(jiraRow, 'Opening browser for Jira OAuth. Allow VS Code to open when prompted, then Tyne will finish setup.');
        showAction(changeBtn, false);
        showAction(disconnectBtn, false);
      } else if (reconnectRequired) {
        jiraBranch = 'reconnect';
        setStateBtn(stateBtn, 'Reconnect required', 'btn compact primary', false);
        if (stateBtn) { stateBtn.dataset.actionId = 'jiraReconnectBtn'; }
        setDesc(jiraRow, syncError && hasApiError ? syncError : 'Jira session expired. Reconnect Jira.');
        showAction(changeBtn, false);
        showAction(disconnectBtn, true);
      } else if (jiraConnected) {
        jiraBranch = 'connected';
        setStateBtn(stateBtn, 'Connected', 'btn compact conn-badge-good', true);
        setDesc(jiraRow, hasApiError
          ? `Connected. Task refresh needs attention: ${syncError || 'try syncing again.'}`
          : (selectedProject ? `Project: ${selectedProject.projectKey} — ${selectedProject.projectName}` : 'Connected. Choose a Jira project.'));
        showAction(changeBtn, true);
        showAction(disconnectBtn, true);
      } else {
        jiraBranch = 'connect';
        setStateBtn(stateBtn, 'Connect', 'btn compact primary', false);
        setDesc(jiraRow, 'Connect Jira to link this repository with your sprint work.');
        showAction(changeBtn, false);
        showAction(disconnectBtn, false);
      }
    }

    // PM tools (Linear live; Slack/Asana/Monday not yet integrated).
    const COMING_SOON_TOOLS = ['slack', 'asana', 'monday'];
    ['linear', 'slack', 'asana', 'monday'].forEach(tool => {
      const row = list.querySelector(`[data-tool="${tool}"]`);
      if (!row) { return; }
      const stateBtn = row.querySelector('[data-action="connect"]');
      const disconnectBtn = row.querySelector('[data-action="disconnect"]');
      if (COMING_SOON_TOOLS.includes(tool)) {
        setStateBtn(stateBtn, 'Coming soon', 'btn compact conn-badge-neutral', true);
        showAction(disconnectBtn, false);
        return;
      }
      const connected = pmToolIsConnected(tool);
      const githubConnected = pmIntegration.githubConnected !== undefined ? pmIntegration.githubConnected : isAuthenticated;
      if (tool === 'linear' && !githubConnected) {
        linearBranch = 'github_first';
        setStateBtn(stateBtn, 'Connect GitHub first', 'btn compact conn-badge-neutral', true);
        setDesc(row, 'Connect GitHub first to connect Linear.');
        showAction(disconnectBtn, false);
      } else if (_tasksConnectingTools.includes(tool)) {
        if (tool === 'linear') { linearBranch = 'connecting'; }
        setStateBtn(stateBtn, 'Connecting…', 'btn compact conn-badge-neutral is-loading', true);
        setDesc(row, 'Opening browser for OAuth. Allow VS Code to open when prompted.');
        showAction(disconnectBtn, false);
      } else if (connected) {
        if (tool === 'linear') { linearBranch = 'connected'; }
        setStateBtn(stateBtn, 'Connected', 'btn compact conn-badge-good', true);
        if (tool === 'linear') {
          const linear = pmIntegration.linear || {};
          const parts = [linear.teamKey, linear.teamName].filter(Boolean).join(' · ');
          setDesc(row, parts ? `Team: ${parts}` : 'Linear connected.');
        }
        showAction(disconnectBtn, true);
      } else {
        if (tool === 'linear') { linearBranch = 'connect'; }
        setStateBtn(stateBtn, 'Connect', 'btn compact primary', false);
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

  function hydrateAccount(name) {
    githubUsername = name || '';
    const nameEl = $('accountName');
    if (nameEl) nameEl.textContent = githubUsername ? '@' + githubUsername : (isAuthenticated ? 'Connected' : 'Not connected');
    const tierClass = { CORE: 't-core', PRO: 't-pro', MAX: 't-max' };
    document.querySelectorAll('.tier-logo').forEach(el => { el.style.display = 'none'; });
    const planEl = $('accountPlan');
    if (tierClass[userTier]) {
      const logo = document.querySelector('.' + tierClass[userTier]);
      if (logo) logo.style.display = 'block';
      if (planEl) planEl.style.display = 'none';
    } else if (planEl) {
      planEl.style.display = '';
      planEl.textContent = isAuthenticated ? 'Loading plan…' : 'Connect GitHub to load your plan';
    }
    const credits = $('accountCredits');
    if (credits) {
      if (userTier === 'MAX') { credits.classList.remove('hidden'); $('accountCreditsVal').textContent = String(Math.max(0, 100 - userCredits)); }
      else credits.classList.add('hidden');
    }
    renderIntegrations();
  }

  function applyTierConfig() {
    const setShown = (id, on) => $(id).classList.toggle('hidden', !on);
    setShown('planConnectContainer', userTier === 'UNKNOWN');
    setShown('coreConfigContainer', userTier === 'CORE');
    setShown('premiumConfigContainer', userTier === 'PRO' || userTier === 'MAX');
  }

  // Populate the thread-page task picker from the cached assigned tasks. Hidden
  // when there are no tasks (e.g. no PM tool connected).
  function renderThreadTaskPicker() {
    const tasks = (_tasksAll || []).filter(t => t && t.id && t.title);
    const html = '<option value="">— Select an assigned task —</option>' +
      tasks.map(t => '<option value="' + escHtml(t.id) + '">' + escHtml((t.externalId || t.id) + ' · ' + t.title) + '</option>').join('');
    const setPicker = (sel, field) => {
      if (!sel) { return; }
      sel.innerHTML = html;
      if (state.taskId && tasks.some(t => t.id === state.taskId)) { sel.value = state.taskId; }
      if (field) { field.classList.toggle('hidden', tasks.length === 0); }
    };
    setPicker($('threadTaskPicker'), $('threadTaskPickerField'));
    setPicker($('weavingTaskPicker'), $('weavingTaskPickerField'));
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
    syncProofSection(true);
    renderValidation();
    renderBranches();
    renderCommitSummaryCard();
    renderCommitLists();
    renderAiUsage();
    applyStatus();
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
      const t = (_tasksAll || []).find(x => x && x.id === id);
      if (!t) { return; }
      // Load the task straight into the thread brief, running the same PM
      // enrichment (epic/stories → proof points/subtasks) used elsewhere.
      vscode.postMessage({ type: 'selectTaskIntoThread', taskId: t.id, tool: t.sourceTool });
    });
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
      const t = (_tasksAll || []).find(x => x && x.id === id);
      if (!t) { return; }
      setRunner(true);
      vscode.postMessage({ type: 'switchTaskInThread', taskId: t.id, tool: t.sourceTool });
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
    if (b.dataset.nav === 'time') {
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
      showAppView('review');
      renderCodeReview();
    }
  }));
  $('flowPrimaryBtn').addEventListener('click', () => runFlowAction($('flowPrimaryBtn').dataset.flowAction));
  $('flowSecondaryBtn').addEventListener('click', () => runFlowAction($('flowSecondaryBtn').dataset.flowAction));
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
      validateReview.running = true;
      validateReview.error = null;
      setValidateReviewRunner(true);
      const scopeSelect = $('validateReviewScopeSelect');
      const scopeVal = scopeSelect ? scopeSelect.value : 'auto';
      const scope = scopeVal === 'auto' ? undefined : scopeVal;
      const selectedSha = scopeVal === 'selected_commit' ? selectedCommitHash : undefined;
      vscode.postMessage({ type: 'runValidateReview', scope: scope, selectedCommitSha: selectedSha });
    });
  }
  const validateReviewSearch = $('validateReviewSearch');
  if (validateReviewSearch) {
    validateReviewSearch.addEventListener('input', () => {
      validateReview.search = validateReviewSearch.value || '';
      renderValidateReview();
    });
  }
  const validateReviewStatusFilter = $('validateReviewStatusFilter');
  if (validateReviewStatusFilter) {
    validateReviewStatusFilter.addEventListener('change', () => {
      validateReview.filter = validateReviewStatusFilter.value || 'all';
      renderValidateReview();
    });
  }
  const validateReviewBackBtn = $('validateReviewBackBtn');
  if (validateReviewBackBtn) {
    validateReviewBackBtn.addEventListener('click', () => {
      validateReview.selectedReportId = null;
      renderValidateReview();
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
  document.addEventListener('click', function(e) {
    const btn = e.target.closest('.vr-fa-btn');
    if (!btn) return;
    const action = btn.dataset.action;
    if (!action) return;

    const result = validateReview.result || (state.validateReviewResult) || null;
    if (!result) return;

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
          title: finding.title,
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
      const row = btn.closest('.vr-finding-row');
      if (row) {
        const pre = row.querySelector('.vr-suggested-fix');
        const fixActions = row.querySelector('.vr-autofix-actions');
        if (pre) { pre.style.display = 'none'; }
        if (fixActions) { fixActions.style.display = 'none'; }
      }
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
    };
  }
  const addTaskBtn = $('addTaskBtn');
  if (addTaskBtn) { addTaskBtn.addEventListener('click', () => runFlowAction('addTask')); }
  $('btnRevalidate').addEventListener('click', () => runFlowAction('validateReview'));
  $('btnOverride').addEventListener('click', () => runFlowAction('overrideProceed'));
  $('upgradeToMaxBtn').addEventListener('click', () => vscode.postMessage({ type: 'openExternal', url: 'https://tyne.proflowtech.io/upgrade' }));

  $('continueWithGithubBtn').addEventListener('click', () => { $('continueWithGithubBtn').disabled = true; $('skipAuthBtn').disabled = true; vscode.postMessage({ type: 'continueWithGitHub' }); });
  $('skipAuthBtn').addEventListener('click', () => showScreen('main'));
  $('connectGithubSettingsBtn').addEventListener('click', () => vscode.postMessage({ type: 'continueWithGitHub' }));
  $('signoutBtn').addEventListener('click', () => vscode.postMessage({ type: 'logout' }));
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
  $('manageBillingBtn').addEventListener('click', () => vscode.postMessage({ type: 'openExternal', url: 'https://tyne.proflowtech.io/account/billing' }));
  $('upgradeFromSettingsLink').addEventListener('click', e => { e.preventDefault(); vscode.postMessage({ type: 'openExternal', url: 'https://tyne.proflowtech.io/upgrade' }); });
  $('saveByokBtn').addEventListener('click', () => { vscode.postMessage({ type: 'saveByokKey', apiKey: $('byokApiKey').value, provider: aiSettings.aiProvider }); $('byokApiKey').value = ''; });
  $('saveByokBtnPremium').addEventListener('click', () => { vscode.postMessage({ type: 'saveByokKey', apiKey: $('byokApiKeyPremium').value, provider: aiSettings.aiProvider }); $('byokApiKeyPremium').value = ''; });
  $('testByokBtn').addEventListener('click', () => vscode.postMessage({ type: 'testByokKey', provider: aiSettings.aiProvider }));
  $('testByokBtnPremium').addEventListener('click', () => vscode.postMessage({ type: 'testByokKey', provider: aiSettings.aiProvider }));
  $('deleteByokBtn').addEventListener('click', () => vscode.postMessage({ type: 'deleteByokKey' }));
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

  document.querySelectorAll('[data-provider]').forEach(b => b.addEventListener('click', () => {
    vscode.postMessage({ type: 'settingChange', key: 'byokProvider', value: b.dataset.provider });
  }));

  // Unified integrations list: connect / disconnect / change project.
  document.addEventListener('click', e => {
    const btn = e.target.closest('.int-item [data-action]');
    if (!btn) { return; }
    const action = btn.dataset.action;
    const provider = btn.dataset.provider;
    const tool = btn.dataset.tool;
    if (action === 'connect') {
      if (provider === 'github') { vscode.postMessage({ type: 'continueWithGitHub' }); }
      else { vscode.postMessage({ type: 'connectIntegration', provider }); }
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
      velocityToggle.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
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
      if (filePath) {
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
    if (msg.type === 'stateLoaded') {
      state = Object.assign(state, msg.state);
      if (state.validateReviewResult) {
        validateReview.result = state.validateReviewResult;
        if (state.validateReviewResult.id && !validateReview.reports.some(function(report) { return report.id === state.validateReviewResult.id; })) {
          validateReview.reports = [state.validateReviewResult].concat(validateReview.reports);
        }
      }
      applyState();
      showScreen(isAuthenticated ? 'main' : 'welcome');
    } else if (msg.command === 'HYDRATE_PROFILE') {
      userTier = msg.payload.tier || 'UNKNOWN';
      userCredits = msg.payload.credits || 0;
      if (userTier === 'MAX' || userTier === 'max') {
        valCountRemaining = 'unlimited';
        valCountTotal = 'unlimited';
      }
      hydrateAccount(msg.payload.githubUsername);
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
      $('byokApiKey').value = ''; $('byokApiKeyPremium').value = '';
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
      const statusEl = msg.provider === 'openai' ? $('byokStatusPremium') : $('byokStatus');
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
      ensureValidationVisible();
      renderValidation();
      tasksMgr.renderTaskDetailValidation();
      applyStatus();
      syncProofSection(true);
    }
    else if (msg.type === 'pmEnrichmentUpdated') {
      state.pmEnrichmentStatus = msg.pmEnrichmentStatus || state.pmEnrichmentStatus;
      state.pmEnrichmentError = msg.pmEnrichmentError || '';
      const retryBtn = $('retryPmEnrichmentBtn');
      if (retryBtn) {
        retryBtn.disabled = false;
        retryBtn.textContent = state.pmEnrichmentStatus === 'success' ? 'Updated' : 'Retry PM Enrichment';
      }
    }
    else if (msg.type === 'validationError') {
      hidePixel();
      valPanelState = 'error';
      valLastError = msg.message || 'Validation failed. Try again.';
      validationTrace = msg.trace || validationTrace;
      if (validationTrace) { syncTraceExpansion(validationTrace); }
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
    else if (msg.type === 'showReviewPage') { showAppView('review'); renderCodeReview(); }
    else if (msg.type === 'showValidateReviewPage') { showAppView('validateReview'); vscode.postMessage({ type: 'loadValidateReviewReports' }); renderValidateReview(); }
    else if (msg.type === 'validateReviewRunning') { validateReview.running = true; validateReview.error = null; setValidateReviewRunner(true); renderValidateReview(); }
    else if (msg.type === 'validateReviewResult') {
      validateReview.running = false;
      validateReview.result = msg.result;
      validateReview.selectedReportId = msg.result?.id || validateReview.selectedReportId;
      validateReview.viewMode = 'structured';
      if (msg.result && msg.result.id && !validateReview.reports.some(function(report) { return report.id === msg.result.id; })) {
        validateReview.reports = [msg.result].concat(validateReview.reports);
      }
      state.validateReviewResult = msg.result || state.validateReviewResult;
      if (msg.result && msg.result.id) { state.latestValidateReviewReportId = msg.result.id; }
      validateReview.error = null;
      setValidateReviewRunner(false);
      renderValidateReview();
    }
    else if (msg.type === 'validateReviewError') { validateReview.running = false; validateReview.error = msg.message || 'Review failed.'; setValidateReviewRunner(false); renderValidateReview(); }
    else if (msg.type === 'validateReviewReportsLoaded') {
      validateReview.reports = msg.reports || [];
      if (validateReview.result && validateReview.result.id && !validateReview.reports.some(function(report) { return report.id === validateReview.result.id; })) {
        validateReview.reports = [validateReview.result].concat(validateReview.reports);
      }
      if (!validateReview.result && validateReview.reports.length) { validateReview.result = validateReview.reports[0]; }
      renderValidateReview();
    }
    else if (msg.type === 'AUTH_STATE_CHANGE') { setAuthenticated(Boolean(msg.isAuthenticated)); }
    else if (msg.type === 'githubConnectStatus') {
      if (msg.status === 'pending') {
        $('welcomePending').classList.remove('hidden');
        $('pendingCode').textContent = msg.userCode || '----';
        $('pendingLink').textContent = (msg.verificationUri || 'https://github.com/login/device').replace('https://', '');
        $('pendingLink').dataset.url = msg.verificationUri || 'https://github.com/login/device';
      } else if (msg.status === 'error') {
        $('continueWithGithubBtn').disabled = false;
        $('skipAuthBtn').disabled = false;
        $('welcomePending').classList.add('hidden');
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
    else if (msg.type === 'timeBreakdownLoaded') { renderTimeBreakdown(msg.items); }
    else if (msg.type === 'tasksDataLoaded') {
      tasksMgr.onDataLoaded(msg);
    }
    else if (msg.type === 'tasksQueryResult') {
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
      showAppView(msg.page);
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
        persistAppliedFindingFixes();
        renderValidateReview();
      } else {
        const row = document.querySelector('.vr-finding-row[data-finding-id="' + msg.findingId + '"]');
        if (row) {
          const applyBtn = row.querySelector('.vr-fa-btn.apply-fix');
          if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Apply'; }
        }
      }
    }
    else if (msg.type === 'fixUndone') {
      if (msg.success) {
        delete appliedFindingFixes[findingFixKey(msg.findingId, msg.reportId)];
        persistAppliedFindingFixes();
        renderValidateReview();
      } else {
        const row = document.querySelector('.vr-finding-row[data-finding-id="' + msg.findingId + '"]');
        if (row) {
          const undoBtn = row.querySelector('.vr-fa-btn.undo-fix');
          if (undoBtn) { undoBtn.disabled = false; undoBtn.textContent = 'Undo'; }
        }
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
    else if (msg.type === 'conflictCheckResult') {
      if (msg.conflict) { tasksMgr.showConflict(msg.conflict); }
      else { tasksMgr.hideConflict(); }
    }
    else if (msg.type === 'capabilitiesLoaded') {
      tasksMgr._lastCapabilities = msg.capabilities;
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
    renderTaskTimeSummaryCard();
    renderTimeSessionList();
    renderManualTimeList();
    renderTimeSummaries();
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

  function renderTimeSummaries() {
    const el = $('timeSummariesCard');
    if (!el) { return; }
    const rows = [];
    function pushPeriod(label, summary) {
      if (!summary || summary.totalMinutes === 0) {
        rows.push('<div class="row"><div class="k">' + escHtml(label) + '</div><div class="v">0m</div></div>');
        return;
      }
      rows.push('<div class="row"><div class="k">' + escHtml(label) + ' Total</div><div class="v green">' + escHtml(fmtMin(summary.totalMinutes)) + '</div></div>');
      rows.push('<div class="row"><div class="k">Automatic Git</div><div class="v">' + escHtml(fmtMin(summary.automaticMinutes)) + '</div></div>');
      rows.push('<div class="row"><div class="k">Manual</div><div class="v">' + escHtml(fmtMin(summary.manualMinutes)) + '</div></div>');
      rows.push('<div class="row"><div class="k">Commits</div><div class="v">' + escHtml(String(summary.commitCount || 0)) + '</div></div>');
    }
    pushPeriod('Today', timeData.dailySummary);
    pushPeriod('This Week', timeData.weeklySummary);
    pushPeriod('This Month', timeData.monthlySummary);
    const project = timeData.projectSummary;
    if (!project || project.totalMinutes === 0) {
      rows.push('<div class="row"><div class="k">Project Total</div><div class="v">0m</div></div>');
    } else {
      rows.push('<div class="row"><div class="k">Project Total</div><div class="v green">' + escHtml(fmtMin(project.totalMinutes)) + '</div></div>');
      rows.push('<div class="row"><div class="k">Tasks</div><div class="v">' + escHtml(String(project.taskCount || 0)) + '</div></div>');
      rows.push('<div class="row"><div class="k">Branches</div><div class="v">' + escHtml(String(project.branchCount || 0)) + '</div></div>');
      rows.push('<div class="row"><div class="k">Sessions</div><div class="v">' + escHtml(String(project.sessionCount || 0)) + '</div></div>');
    }
    el.innerHTML = rows.join('');
  }

  function renderTimeBreakdown(items) {
    const el = $('timeBreakdownList');
    if (!el) { return; }
    if (!items || !items.length) {
      el.innerHTML = '<div class="empty">No data for this breakdown.</div>';
      return;
    }
    el.innerHTML = items.map(item =>
      '<div class="list-item">' +
      '<div class="int-head"><span class="lt">' + escHtml(item.label) + '</span>' +
      '<span class="tag">' + escHtml(fmtMin(item.totalMinutes)) + '</span></div>' +
      '<div class="tags">' +
      '<span class="tag source-git">Git: ' + escHtml(fmtMin(item.automaticMinutes)) + '</span>' +
      '<span class="tag source-manual">Manual: ' + escHtml(fmtMin(item.manualMinutes)) + '</span>' +
      (item.commitCount ? '<span class="tag">' + escHtml(String(item.commitCount)) + ' commits</span>' : '') +
      '</div></div>'
    ).join('');
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

  const breakdownSelect = $('breakdownSelect');
  if (breakdownSelect) {
    breakdownSelect.addEventListener('change', () => {
      const type = breakdownSelect.value;
      if (!type) return;
      const body = $('timeBreakdownBody');
      const arrow = document.querySelector('.section-toggle[data-target="timeBreakdownBody"] .toggle-arrow');
      if (body) { body.classList.remove('hidden'); }
      if (arrow) { arrow.textContent = '\u25BC'; }
      vscode.postMessage({ type: 'requestTimeBreakdown', breakdownType: type, filters: {} });
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

  const tasksMgr = {

    _presets: [],
    _canWrite: false,
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
      if (anySyncing) { status = 'syncing'; label = 'Syncing…'; }
      else if (anyAuthFailed) { status = 'failed'; label = 'Reconnect required'; }
      else if (anyFailed) { status = 'warning'; label = 'Connected · sync issue'; }
      else if (allOnline) { status = 'online'; label = lastSynced ? `Synced ${lastSynced}` : 'Online'; }
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
      const sortVal = ($('taskSortSelect') || {}).value || 'updatedAt:desc';
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
      const newTaskBtn = $('newTaskBtn');
      const newTaskSep = $('newTaskSep');
      if (newTaskBtn) { newTaskBtn.classList.toggle('hidden', !this._canWrite); }
      if (newTaskSep) { newTaskSep.classList.toggle('hidden', !this._canWrite); }
      const addSubRow = $('addSubtaskRow');
      if (addSubRow) { addSubRow.classList.toggle('hidden', !this._canWrite); }
      const addCmtRow = $('addCommentRow');
      if (addCmtRow) { addCmtRow.classList.toggle('hidden', !this._canWrite); }
      const tdEditBtn = $('tdEditBtn');
      if (tdEditBtn) { tdEditBtn.style.opacity = this._canWrite ? '' : '0.45'; tdEditBtn.title = this._canWrite ? '' : 'Requires Pro or Max'; }
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
          empty.textContent = _tasksConnectedTools.length ? 'No tasks match your filters.' : 'Connect Jira or Linear to pull your tasks.';
          empty.style.display = '';
        }
        return;
      }
      if (empty) { empty.style.display = 'none'; }
      list.innerHTML = this.renderTaskGroups(tasks);
    },

    renderTaskGroups(tasks) {
      const isDone = t => t.normalizedStatus === 'done' || t.normalizedStatus === 'canceled';
      const pending = tasks.filter(t => !isDone(t));
      const done = tasks.filter(isDone);

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
      const due = t.dueDate ? `Due ${fmtDate(t.dueDate)}` : '';
      const updated = t.updatedAt ? fmtRelative(t.updatedAt) : '';
      const toolState = Array.isArray(this._lastSyncSummary.syncStates)
        ? this._lastSyncSummary.syncStates.find(state => state.sourceTool === t.sourceTool)
        : null;
      const cachedLabel = t.isCachedOnly && t.sourceTool === 'jira' && toolState && toolState.syncStatus === 'offline' ? 'Offline' : 'Cached';
      const cached = t.isCachedOnly ? cachedLabel : '';
      const key = t.externalId && t.externalId !== t.title ? t.externalId : '';
      const tool = TOOL_LABEL[t.sourceTool] || t.sourceTool || '';
      const meta = [tool, key, t.assigneeName, updated, due, cached].filter(Boolean).join(' · ');
      const isActive = t.id === _activeTaskId;
      return `<div class="task-card${isActive ? ' active' : ''}${t.isCachedOnly ? ' cached-only' : ''}"
        data-task-id="${escHtmlTask(t.id)}"
        data-task-tool="${escHtmlTask(t.sourceTool)}"
        data-task-ext-id="${escHtmlTask(t.externalId)}"
        data-task-title="${escHtmlTask(t.title)}">
        <div class="task-card-main">
          <span class="task-card-title">${escHtmlTask(t.title)}</span>
          <span class="task-card-status">${escHtmlTask(STATUS_LABELS[t.normalizedStatus] || t.status || 'Open')}</span>
        </div>
        ${meta ? `<div class="task-card-meta">${escHtmlTask(meta)}</div>` : ''}
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
      }
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
      if (appNameEl && !appNameEl.value) { appNameEl.value = state.appName || ''; }
      renderThreadTaskPicker();
      if (msg.subtasks && Array.isArray(msg.subtasks)) {
        state.subtasks = msg.subtasks;
        renderSubtasks();
      }
      syncProofSection(false);
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
      vscode.postMessage({ type: 'fieldChange', field: 'taskId', value: msg.taskId || '' });
      vscode.postMessage({ type: 'fieldChange', field: 'goal', value: msg.goal || msg.taskTitle || '' });
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
    const card = TyneTaskInteractions.findTaskCard(e.target);
    if (card && card.dataset.taskId) {
      _activeTaskId = card.dataset.taskId;
      _activeTaskTool = card.dataset.taskTool;
      // Clicking a task opens its detail drawer + PM enrichment card (the AI reads
      // the linked epic/stories and subtasks to generate proof points). It does NOT
      // open Jira (the external-open handler is scoped to explicit buttons/links).
      vscode.postMessage({ type: 'openTaskDetail', taskId: card.dataset.taskId, tool: card.dataset.taskTool });
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
      vscode.postMessage({ type: 'startThreadFromTask', taskId: b.dataset.taskId, title: b.dataset.taskTitle, tool: b.dataset.taskTool, url: b.dataset.taskSourceUrl });
    });
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
      const sortVal = ($('taskSortSelect') || {}).value || 'updatedAt:desc';
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

  function populateAutomationSettings() {
    const s = automationData.settings;
    if (!s) { return; }
    const set = (id, val) => { const el = $(id); if (el) { el.value = val; } };
    const check = (id, val) => { const el = $(id); if (el) { el.checked = !!val; } };
    set('autoCloseTrigger', s.autoCloseTrigger || 'manual');
    set('autoFeedbackTrigger', s.autoFeedbackTrigger || 'after_commit');
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
        complianceFrameworks: automationData.userTier === 'max' && complianceFrameworks.length ? complianceFrameworks : ['HIPAA'],
        privacyMode: privacyModeEl ? privacyModeEl.value : 'cloud',
        dataResidency: g('dataResidency') || 'us',
        evidencePersistenceDisabled: privacyModeEl && privacyModeEl.value === 'local_compliance',
      };
      vscode.postMessage({ type: 'automationSaveSettings', settings });
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

  const maxReportTabBar = $('maxReportTabBar');
  if (maxReportTabBar) {
    maxReportTabBar.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-btn');
      if (!btn) { return; }
      const tab = btn.getAttribute('data-tab');
      maxReportTabBar.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('#maxReportTabPanels .tab-panel').forEach(p => {
        p.classList.toggle('active', p.getAttribute('data-tab') === tab);
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

  vscode.postMessage({ command: 'WEBVIEW_READY' });
  vscode.postMessage({ type: 'ready' });

})();
