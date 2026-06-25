// Tyne webview controller. Talks to TyneSidebarProvider via the documented
// message protocol. Presentation only — all git/AI/auth work happens host-side.
(function () {
  const vscode = acquireVsCodeApi();

  let state = { appName: '', taskId: '', taskTitle: '', taskSource: 'Solo Mode', taskUrl: '', goal: '', status: 'waiting', subtasks: [], validationResult: null, validationOverride: false, branchName: '', stitchCount: 0, lastStitchTime: '' };
  let saveTimer = null;
  let resetTimer = null;
  let shippedTimer = null;
  let prPanelTimer = null;
  let localHasStitch = false;
  let tieKnotUnlocked = false;
  let activeView = 'thread';
  let isAuthenticated = false;
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
  let automationData = { settings: null, syncState: null, conflict: null, events: [] };
  let previewedFeedbackBody = null;
  let selectedCommitHash = '';
  let velocityMetric = 'commits';
  let aiSettings = { aiAccessMode: 'byok', aiProvider: 'claude', hasBYOKKey: false, byokConfig: null, aiUsageUsed: 0, aiUsageLimit: 50, validationUsage: null, validationResult: null };
  let validationHistory = [];
  let validationTrends = null;
  let validationTier = 'free';

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

  vscode.postMessage({ command: 'WEBVIEW_READY' });
  vscode.postMessage({ type: 'ready' });
  requestValidationHistory();
  requestValidationTrends();

  // ---------- Navigation / screens ----------
  function showAppView(view) {
    activeView = view || 'thread';
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === activeView + 'Page'));
    document.querySelectorAll('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.nav === activeView));
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
    // GitHub is the app's login, so in Integrations show it as the connected
    // account rather than a redundant connect action.
    const badge = $('githubConnBadge');
    if (badge) badge.classList.toggle('hidden', !v);
    const conn = $('connectGithubBtn');
    if (conn) conn.classList.toggle('hidden', v);
    const out = $('signoutBtn');
    if (out) out.disabled = !v;
  }

  // ---------- Flow state machine ----------
  function selectTask(task) {
    vscode.postMessage({ type: 'standupSelect', task });
    showAppView('thread');
  }
  function runFlowAction(action) {
    if (action === 'selectTask') { selectTask(tasksCache[0] || fallbackTasks[0]); return; }
    if (action === 'startThread') { vscode.postMessage({ type: 'buttonClick', action: 'startThread' }); return; }
    if (action === 'switchSelectedBranch') { vscode.postMessage({ type: 'buttonClick', action: 'switchSelectedBranch' }); return; }
    if (action === 'saveStitch') { vscode.postMessage({ type: 'buttonClick', action: 'saveStitch' }); return; }
    if (action === 'validateGoal') { showPixel('think', 'AI reviewing goal'); vscode.postMessage({ type: 'buttonClick', action: 'validateGoal' }); return; }
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
    if (weaving && (state.stitchCount || 0) < 3 && !validation) return { key: 'stitch', index: 1, primary: 'Save stitch', primaryAction: 'saveStitch', secondary: 'Validate', secondaryAction: 'validateGoal' };
    if (weaving && !validation) {
      const needsKey = aiSettings.aiAccessMode === 'byok' && !aiSettings.hasBYOKKey;
      return { key: 'validate', index: 2, primary: needsKey ? 'AI setup' : 'Validate goal', primaryAction: needsKey ? 'openAi' : 'validateGoal', secondary: needsKey ? 'Validate anyway' : 'Save stitch', secondaryAction: needsKey ? 'validateGoal' : 'saveStitch' };
    }
    if (validation && !passed && !tieKnotUnlocked) return { key: 'blocked', index: 2, primary: 'Run again', primaryAction: 'validateGoal', secondary: 'Override', secondaryAction: 'overrideProceed' };
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
  }

  // ---------- Metrics / status ----------
  function fmtElapsed() {
    if (!sessionStart) return '0m';
    const s = Math.floor((Date.now() - sessionStart) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  }
  function renderDeck() {
    $('mTask').textContent = state.taskId || '—';
    $('mStitch').textContent = String(state.stitchCount || 0);
    const elapsed = state.status === 'weaving' ? fmtElapsed() : '0m';
    $('mTime').textContent = elapsed;
    renderFlow();
  }
  setInterval(renderDeck, 1000);

  function renderAiUsage() {
    const used = Number(aiSettings.aiUsageUsed || 0);
    const limit = Math.max(1, Number(aiSettings.aiUsageLimit || 50));
    const pct = Math.min(100, Math.round((used / limit) * 100));
    const label = $('usageLabel'), text = $('usageText'), fill = $('usageFill');
    if (userTier === 'UNKNOWN') {
      label.textContent = 'Plan not connected'; text.textContent = '—'; fill.style.width = '0%';
    } else if (userTier === 'MAX') {
      const usedPct = Math.max(0, 100 - userCredits);
      label.textContent = 'Daily usage'; text.textContent = usedPct + '%'; fill.style.width = usedPct + '%';
    } else {
      label.textContent = aiSettings.aiAccessMode === 'byok' ? 'BYOK AI' : 'Free usage';
      text.textContent = used + ' / ' + limit; fill.style.width = pct + '%';
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

  function applyStatus() {
    const weaving = state.status === 'weaving';
    const pill = $('statusPill'), txt = $('statusText'), ascii = $('statusAscii');
    pill.classList.remove('standby', 'weaving', 'shipped');
    let statusKey = 'standby';
    if (shipped) { pill.classList.add('shipped'); txt.textContent = 'Shipped'; statusKey = 'shipped'; }
    else if (weaving) { pill.classList.add('weaving'); txt.textContent = tieKnotUnlocked ? 'Ready to ship' : 'Weaving'; statusKey = 'weaving'; }
    else { pill.classList.add('standby'); txt.textContent = 'Standby'; statusKey = 'standby'; }
    if (ascii) { ascii.setAttribute('data-status', statusKey); }

    if (weaving && state.branchName) { $('bsGoal').textContent = state.goal || ''; $('bsBranch').textContent = state.branchName; }

    // AI usage collapse: only show when weaving
    const usageWrap = $('usageWrap');
    if (usageWrap) { usageWrap.classList.toggle('hidden', !weaving); }

    const hasBYOK = aiSettings.hasBYOKKey;
    const isCore = userTier === 'CORE';
    const isPro = userTier === 'PRO';
    const blockGoalValidation = (isCore || isPro) && !hasBYOK;

    const hasTask = Boolean((state.taskId || '').trim());
    $('briefSection').classList.toggle('hidden', weaving);
    $('briefSummary').classList.toggle('hidden', !weaving || !state.branchName);
    if (weaving && state.branchName) {
      $('bsGoal').textContent = state.goal || '';
      $('bsBranch').textContent = state.branchName;
    }
    $('deepReviewLock').classList.toggle('hidden', !blockGoalValidation);
    $('proofSection').classList.toggle('hidden', blockGoalValidation || !hasTask);
    renderDeck();
    renderFlow();
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
  }

  function renderValidation() {
    const wrap = $('validationWrap');
    const r = state.validationResult;
    if (!wrap) { return; }
    const isCore = userTier === 'CORE' || userTier === 'FREE' || userTier === 'free';
    const isProMax = userTier === 'PRO' || userTier === 'MAX' || userTier === 'pro' || userTier === 'max';
    const showHistory = r || validationHistory.length > 0 || isCore || isProMax;
    wrap.classList.toggle('hidden', !showHistory);

    const counter = $('valCounter');
    const providerBadge = $('valProviderBadge');
    if (counter) { counter.textContent = aiSettings.validationUsageText || 'Validations: loading…'; }
    if (providerBadge) { providerBadge.textContent = aiSettings.byokConfig?.ai?.provider || aiSettings.aiProvider || ''; }

    const empty = $('valEmpty');
    const resultEl = $('valResult');
    if (empty) { empty.classList.toggle('hidden', !!r); }
    if (resultEl) { resultEl.classList.toggle('hidden', !r); }
    if (r) {
      const badge = $('valBadge');
      if (badge) { badge.textContent = r.status; badge.className = 'val-badge ' + r.status; }
      const match = $('valMatch');
      if (match) { match.textContent = typeof r.matchPercent === 'number' ? 'Match: ' + r.matchPercent + '%' : ''; match.classList.toggle('hidden', typeof r.matchPercent !== 'number'); }
      const risk = $('valRisk');
      if (risk) { risk.textContent = r.riskLevel ? 'Risk: ' + capitalize(r.riskLevel) : ''; risk.classList.toggle('hidden', !r.riskLevel); }
      const summary = $('valSummary');
      if (summary) { summary.textContent = r.summary || (r.status === 'pass' ? 'Code matches the goal.' : 'Goal not fully met.'); }
      const enhanced = $('valEnhanced');
      if (enhanced) { enhanced.classList.toggle('hidden', isCore); }
      if (!isCore) {
        setValSection('valDetailedSection', 'valDetailed', r.detailedExplanation);
        setValList('valMissingSection', 'valMissing', r.missingRequirements);
        setValList('valSuggestionsSection', 'valSuggestions', r.suggestions);
        setValList('valQualitySection', 'valQuality', r.codeQualityNotes);
        setValList('valFilesSection', 'valFiles', r.filesReviewed);
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

  function renderValidationHistory() {
    const list = $('valHistory');
    const empty = $('valHistoryEmpty');
    if (!list) { return; }
    const visible = getFilteredSortedHistory();
    if (empty) { empty.classList.toggle('hidden', visible.length > 0); }
    list.innerHTML = visible.length === 0
      ? ''
      : visible.map(h => {
        const isEnhanced = h.provider !== undefined;
        const line = isEnhanced
          ? [h.status.toUpperCase(), h.matchPercent !== undefined ? h.matchPercent + '%' : '', h.riskLevel ? 'Risk: ' + capitalize(h.riskLevel) : '', h.taskId, h.branchName, h.commitHash ? h.commitHash.slice(0, 8) : ''].filter(Boolean).join(' · ')
          : [h.status.toUpperCase(), h.taskId, h.branchName, h.commitHash ? h.commitHash.slice(0, 8) : '', h.provider || '', fmtRelative(h.createdAt)].filter(Boolean).join(' · ');
        const meta = isEnhanced && h.taskTitle ? escHtml(h.taskTitle) : '';
        return '<div class="val-history-item"><div class="val-history-line">' + escHtml(line) + '</div>' + (meta ? '<div class="val-history-meta">' + meta + '</div>' : '') + '</div>';
      }).join('');
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
    const latest = commitData.taskCommits[0];
    if (!commitData.taskCommits.length) {
      summaryCard.innerHTML = '<div class="empty">No linked commit history yet.</div>';
      return;
    }
    summaryCard.innerHTML =
      '<div class="row"><div class="k">Linked Branch</div><div class="v branch">' + escHtml(branchData.selectedTaskBranch?.branchName || commitData.currentBranchName || '—') + '</div></div>' +
      '<div class="row"><div class="k">Total Commits</div><div class="v">' + escHtml(String(commitData.taskCommits.length)) + '</div></div>' +
      '<div class="row"><div class="k">Sessions</div><div class="v">' + escHtml(String(commitData.taskSessions.length)) + '</div></div>' +
      '<div class="row"><div class="k">Time Estimate</div><div class="v">' + escHtml(fmtMinutes(commitData.taskSessions.reduce((sum, session) => sum + (session.durationMinutes || 0), 0))) + '</div></div>' +
      '<div class="row"><div class="k">Latest Commit</div><div class="v">' + escHtml(latest.message || latest.shortHash) + '</div></div>' +
      '<div class="row"><div class="k">Last Activity</div><div class="v">' + escHtml(fmtRelative(latest.committedAt)) + '</div></div>';
  }

  function renderCommitLists() {
    const taskList = $('taskCommitList');
    taskList.innerHTML = '';
    if (!commitData.taskCommits.length) {
      taskList.innerHTML = '<div class="empty">No commits linked to this task yet.</div>';
    } else {
      commitData.taskCommits.slice(0, 5).forEach(commit => {
        const row = document.createElement('div');
        row.className = 'list-item commit-item';
        row.dataset.commitHash = commit.commitHash;
        row.innerHTML =
          '<div class="int-head"><span class="lt mono">' + escHtml(commit.shortHash) + '</span><span class="tag">' + escHtml(fmtRelative(commit.committedAt)) + '</span></div>' +
          '<div class="lm plain">' + escHtml(commit.message) + '</div>' +
          '<div class="tags"><span class="tag">' + escHtml(String(commit.totalFilesChanged)) + ' files</span><span class="tag">+' + escHtml(String(commit.totalLinesAdded)) + '</span><span class="tag">-' + escHtml(String(commit.totalLinesDeleted)) + '</span></div>';
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
      if (commitArrow) commitArrow.textContent = '\u25be';
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

    const tg = document.querySelector('[data-toggle="projectLead"]');
    if (tg) { tg.classList.toggle('active', projectLeadMode); tg.setAttribute('aria-pressed', String(projectLeadMode)); }

    hydrateAccount(s.githubUsername);
    applyTierConfig();

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

  function hydrateAccount(githubUsername) {
    const nameEl = $('accountName');
    if (nameEl) nameEl.textContent = githubUsername ? '@' + githubUsername : (isAuthenticated ? 'Connected' : 'Not connected');
    const ghSub = $('githubConnSub');
    if (ghSub) ghSub.textContent = githubUsername ? ('Signed in as @' + githubUsername) : 'Account connection · draft PRs, branch push, review links';
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
  }

  function applyTierConfig() {
    const setShown = (id, on) => $(id).classList.toggle('hidden', !on);
    setShown('planConnectContainer', userTier === 'UNKNOWN');
    setShown('coreConfigContainer', userTier === 'CORE');
    setShown('premiumConfigContainer', userTier === 'PRO' || userTier === 'MAX');
  }

  function applyState() {
    $('appName').value = state.appName || '';
    $('taskId').value = state.taskId || '';
    $('goal').value = state.goal || '';
    localHasStitch = (state.stitchCount || 0) > 0 && state.status === 'weaving';
    tieKnotUnlocked = state.validationOverride || (state.validationResult && state.validationResult.status === 'pass');
    if (state.status === 'weaving' && !sessionStart) sessionStart = Date.now();
    renderSubtasks();
    renderValidation();
    renderBranches();
    renderCommitSummaryCard();
    renderCommitLists();
    renderAiUsage();
    applyStatus();
  }

  // ---------- Event wiring ----------
  ['appName', 'taskId', 'goal'].forEach(id => {
    $(id).addEventListener('input', e => {
      state[id] = e.target.value;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => vscode.postMessage({ type: 'fieldChange', field: id, value: e.target.value }), 500);
      applyStatus();
    });
  });
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
  }));
  $('flowPrimaryBtn').addEventListener('click', () => runFlowAction($('flowPrimaryBtn').dataset.flowAction));
  $('flowSecondaryBtn').addEventListener('click', () => runFlowAction($('flowSecondaryBtn').dataset.flowAction));
  $('btnRevalidate').addEventListener('click', () => runFlowAction('validateGoal'));
  $('btnOverride').addEventListener('click', () => runFlowAction('overrideProceed'));
  $('upgradeToMaxBtn').addEventListener('click', () => vscode.postMessage({ type: 'openExternal', url: 'https://tyne.proflowtech.io/upgrade' }));

  $('continueWithGithubBtn').addEventListener('click', () => { $('continueWithGithubBtn').disabled = true; $('skipAuthBtn').disabled = true; vscode.postMessage({ type: 'continueWithGitHub' }); });
  $('skipAuthBtn').addEventListener('click', () => showScreen('main'));
  $('connectGithubBtn').addEventListener('click', () => vscode.postMessage({ type: 'continueWithGitHub' }));
  $('connectGithubSettingsBtn').addEventListener('click', () => vscode.postMessage({ type: 'continueWithGitHub' }));
  $('signoutBtn').addEventListener('click', () => vscode.postMessage({ type: 'logout' }));
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
    if (arrow) { arrow.textContent = open ? '\u25b8' : '\u25be'; }
  });

  // ── Delegated proof-point events inside the proof section ─────────────────────
  document.addEventListener('click', e => {
    const checkBtn = e.target.closest('#proofSection .check');
    if (checkBtn && checkBtn.dataset.id) { vscode.postMessage({ type: 'subtaskToggle', id: checkBtn.dataset.id }); return; }
    const delBtn = e.target.closest('#proofSection .del');
    if (delBtn && delBtn.dataset.id) { vscode.postMessage({ type: 'subtaskDelete', id: delBtn.dataset.id }); return; }
  });
  document.addEventListener('keydown', e => {
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

  // Integrations dropdown
  const addIntBtn = $('addIntegrationBtn');
  if (addIntBtn) {
    addIntBtn.addEventListener('click', () => {
      const open = $('integrationMenu').classList.toggle('open');
      addIntBtn.setAttribute('aria-expanded', String(open));
    });
  }
  document.querySelectorAll('.int-row').forEach(row => {
    row.addEventListener('click', () => {
      vscode.postMessage({ type: 'connectIntegration', provider: row.dataset.provider });
    });
  });

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
      vscode.postMessage({ type: 'openChangedFile', filePath: fileButton.dataset.filePath });
    }
    const taskButton = e.target.closest('[data-task-url]');
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
      applyState();
      showScreen(isAuthenticated ? 'main' : 'welcome');
    } else if (msg.command === 'HYDRATE_PROFILE') {
      userTier = msg.payload.tier || 'UNKNOWN';
      userCredits = msg.payload.credits || 0;
      hydrateAccount(msg.payload.githubUsername);
      applyTierConfig();
      applyStatus();
      renderAiUsage();
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
      aiSettings.validationUsage = msg.validationUsage;
      aiSettings.validationUsageText = msg.validationUsageText;
      aiSettings.validationResult = msg.validationResult;
      state.validationResult = msg.validationResult || state.validationResult;
      renderSettings(msg);
      renderValidation();
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
    else if (msg.type === 'validationComplete') { hidePixel(); state.validationResult = msg.result; aiSettings.validationResult = msg.result; tieKnotUnlocked = msg.result.status === 'pass'; renderValidation(); applyStatus(); }
    else if (msg.type === 'validationError') { hidePixel(); renderValidation(); }
    else if (msg.type === 'validationHistory') { validationHistory = msg.history || []; validationTier = msg.tier || 'free'; renderValidation(); }
    else if (msg.type === 'validationTrends') { validationTrends = msg.trends; renderValidation(); }
    else if (msg.type === 'validationExported') { /* exported to msg.filePath */ }
    else if (msg.type === 'busy') {
      if (msg.on && msg.kind === 'think') showPixel('think', 'AI reviewing goal');
      else if (msg.on && msg.kind === 'push') showPixel('push', 'Pushing to remote');
      else if (!msg.on) hidePixel();
    }
    else if (msg.type === 'synthStarted') { showPixel('generate', 'AI writing commit'); }
    else if (msg.type === 'standupReady') { renderTasks(msg.tasks || []); }
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
    else if (msg.type === 'validationComplete') { hidePixel(); state.validationResult = msg.result; tieKnotUnlocked = msg.result.overall === 'pass'; renderValidation(); applyStatus(); }
    else if (msg.type === 'tieKnotUnlocked') { state.validationOverride = true; tieKnotUnlocked = true; applyStatus(); }
    else if (msg.type === 'stateCleared') {
      shipped = true;
      showPixel('push', msg.pushed ? 'Shipped' : 'Committed', 2000);
      showShipComplete(msg);
      if (shippedTimer) clearTimeout(shippedTimer);
      shippedTimer = setTimeout(() => {
        shipped = false; sessionStart = 0;
        state = { appName: '', taskId: '', taskTitle: '', taskSource: 'Solo Mode', taskUrl: '', goal: '', status: 'waiting', subtasks: [], validationResult: null, validationOverride: false, branchName: '', stitchCount: 0, lastStitchTime: '' };
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
    else if (msg.type === 'prefillThread') {
      tasksMgr.prefillThread(msg);
    }
    else if (msg.type === 'navigateTo') {
      showAppView(msg.page);
    }
    else if (msg.type === 'pmConnectBlocked') {
      const notice = $('taskTierNotice');
      if (notice) { notice.classList.remove('hidden'); }
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
    else if (msg.type === 'automationDataLoaded') {
      automationData = { settings: msg.settings, syncState: msg.syncState, conflict: msg.conflict, events: msg.events || [] };
      renderAutomationData();
    }
    else if (msg.type === 'automationFeedbackPreview') {
      previewedFeedbackBody = msg.preview;
      const card = $('automationFeedbackPreviewCard');
      const txt = $('automationFeedbackPreviewText');
      if (card && txt) { txt.textContent = msg.preview; card.classList.remove('hidden'); card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
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
      if (arrow) arrow.textContent = '\u25be';
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
        if (arrow) arrow.textContent = '\u25be';
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
      if (arrow) { arrow.textContent = '\u25be'; }
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
  let _tasksConnectedTools = [];
  let _tasksTier = 'free';
  let _tasksIsFreeTier = true;
  let _activeTaskId = null;
  let _activeTaskTool = null;
  let _detailCommentCount = 3;
  let _detailDescExpanded = false;
  let _taskSearchDebounce = null;

  function escHtmlTask(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  const TOOL_LABEL = { linear: 'Linear', jira: 'Jira', asana: 'Asana', notion: 'Notion', monday: 'Monday' };
  const STATUS_LABELS = { todo: 'Todo', in_progress: 'In Progress', in_review: 'In Review', done: 'Done', blocked: 'Blocked', canceled: 'Canceled', unknown: 'Unknown' };
  const PRIORITY_LABELS = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'None', unknown: '—' };

  function badge(cls, text) { return `<span class="badge badge-${cls}">${escHtmlTask(text)}</span>`; }
  function statusBadge(s) { return badge(s || 'unknown', STATUS_LABELS[s] || s || '—'); }
  function priorityBadge(p) { return p && p !== 'none' && p !== 'unknown' ? badge(p, PRIORITY_LABELS[p] || p) : ''; }
  function toolBadge(t) { return `<span class="badge badge-tool">${escHtmlTask(TOOL_LABEL[t] || t)}</span>`; }

  const tasksMgr = {

    _presets: [],
    _canWrite: false,
    _activeFilters: {},
    _currentTaskSnapshot: null,
    _editingTaskId: null,
    _editingTaskTool: null,

    onDataLoaded(msg) {
      _tasksAll = msg.tasks || [];
      _tasksConnectedTools = msg.connectedTools || [];
      _tasksTier = msg.tier || 'free';
      _tasksIsFreeTier = !!msg.isFreeTier;
      this._canWrite = !!msg.canWrite;
      this._presets = msg.presets || [];
      const summary = msg.syncSummary || {};
      this.renderConnectionState();
      this.renderSyncStatus(summary);
      this.renderPresetMenu();
      this.applyWriteGating();
      if (msg.defaultPreset) { this.applyPresetToUI(msg.defaultPreset); }
      this.runQuery();
    },

    setSyncStatus(status, label) {
      const dot = $('taskSyncDot');
      const syncBtn = $('pullTasksBtn');
      if (dot) { dot.className = 'sync-dot ' + (status || ''); dot.title = label || '—'; }
      if (syncBtn) { syncBtn.title = label || 'Sync tasks'; }
    },

    renderSyncStatus(summary) {
      const states = summary.syncStates || [];
      const anyFailed = states.some(s => s.syncStatus === 'failed');
      const anySyncing = states.some(s => s.syncStatus === 'syncing');
      const allOnline = states.length > 0 && states.every(s => s.syncStatus === 'online');
      const lastSynced = summary.lastOnlineAt ? fmtRelative(summary.lastOnlineAt) : null;
      const total = summary.totalCached || 0;

      let status = 'idle', label = '—';
      if (anySyncing) { status = 'syncing'; label = 'Syncing…'; }
      else if (anyFailed) { status = 'failed'; label = 'Sync failed'; }
      else if (allOnline) { status = 'online'; label = lastSynced ? `Synced ${lastSynced}` : 'Online'; }
      else if (!_tasksConnectedTools.length) { status = 'offline'; label = 'No tool connected'; }
      else { status = 'offline'; label = lastSynced ? `Last synced ${lastSynced}` : 'Offline'; }

      this.setSyncStatus(status, `${label}${total > 0 ? ' · ' + total + ' cached' : ''}`);
    },

    renderConnectionState() {
      const connectCard = $('taskConnectCard');
      const toolsRow = $('taskToolsRow');
      const controls = $('taskControls');
      const tierNotice = $('taskTierNotice');

      const hasTools = _tasksConnectedTools.length > 0;
      if (connectCard) { connectCard.classList.toggle('hidden', hasTools); }
      if (toolsRow) { toolsRow.classList.toggle('hidden', !hasTools); }
      if (controls) { controls.classList.toggle('hidden', !hasTools); }
      if (tierNotice) { tierNotice.classList.add('hidden'); }

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
      const sortVal = ($('taskSortSelect') || {}).value || 'updatedAt:desc';
      const [sortKey, sortDir] = sortVal.split(':');

      if (!_tasksIsFreeTier) {
        const filters = Object.assign({}, this._activeFilters);
        if (source) { filters.sourceTools = [source]; }
        const sort = { rules: [{ key: sortKey, direction: sortDir }] };
        vscode.postMessage({ type: 'queryTasksAdvanced', query: q, filters, sort });
      } else {
        const filters = {};
        if (source) { filters.sourceTools = [source]; }
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
        if (empty) { empty.style.display = ''; }
        return;
      }
      if (empty) { empty.style.display = 'none'; }
      list.innerHTML = tasks.map(t => this.renderTaskCard(t)).join('');
    },

    renderTaskCard(t) {
      const due = t.dueDate ? `Due ${fmtDate(t.dueDate)}` : '';
      const updated = t.updatedAt ? fmtRelative(t.updatedAt) : '';
      const cached = t.isCachedOnly ? `<span class="badge badge-cached">Cached</span>` : '';
      const isActive = t.id === _activeTaskId;
      return `<div class="task-card${isActive ? ' active' : ''}${t.isCachedOnly ? ' cached-only' : ''}"
        data-task-id="${escHtmlTask(t.id)}"
        data-task-tool="${escHtmlTask(t.sourceTool)}"
        data-task-ext-id="${escHtmlTask(t.externalId)}"
        data-task-title="${escHtmlTask(t.title)}"
        data-task-url="${escHtmlTask(t.sourceUrl || '')}">
        <div class="task-card-head">
          <span class="task-card-title">${escHtmlTask(t.title)}</span>
        </div>
        <div class="task-card-badges">
          ${statusBadge(t.normalizedStatus)}
          ${priorityBadge(t.normalizedPriority)}
          ${toolBadge(t.sourceTool)}
          ${cached}
        </div>
        <div class="task-card-meta">
          <span class="tc-id">${escHtmlTask(t.externalId || t.id)}</span>
          ${t.assigneeName ? `<span>${escHtmlTask(t.assigneeName)}</span>` : ''}
          ${updated ? `<span>${updated}</span>` : ''}
          ${due ? `<span>${due}</span>` : ''}
        </div>
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
        `<span>${escHtmlTask(d.externalId || d.id)}</span>`,
        toolBadge(d.sourceTool),
        statusBadge(d.normalizedStatus),
        d.normalizedPriority && d.normalizedPriority !== 'none' ? priorityBadge(d.normalizedPriority) : '',
      ].filter(Boolean).join(' ');
      const metaRows = [
        d.assigneeName ? `Assignee: ${escHtmlTask(d.assigneeName)}` : '',
        d.dueDate ? `Due: ${fmtDate(d.dueDate)}` : '',
        d.sourceProject ? `Project: ${escHtmlTask(d.sourceProject)}` : '',
        d.lastSyncedAt ? `Synced: ${fmtRelative(d.lastSyncedAt)}` : '',
        offline ? '<em>Offline — showing cached</em>' : '',
      ].filter(Boolean).join(' · ');
      set('taskDetailMeta', `<div class="tm-row">${metaItems}</div><div style="margin-top:4px">${metaRows}</div>`);

      const desc = $('taskDetailDesc');
      const descToggle = $('taskDetailDescToggle');
      if (desc) {
        desc.innerHTML = this.safeMarkdown(d.description || '<em>No description.</em>');
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
          histSec.classList.remove('hidden');
          histEl.innerHTML = '<div class="empty">History not available from this PM tool.</div>';
        }
      }

      const startBtn = $('taskDetailStartThreadBtn');
      if (startBtn) {
        startBtn.dataset.taskId = d.id;
        startBtn.dataset.taskTitle = d.title;
        startBtn.dataset.taskTool = d.sourceTool;
        startBtn.dataset.taskUrl = d.sourceUrl || '';
      }
      const tdCopyIdBtn = $('tdCopyIdBtn');
      if (tdCopyIdBtn) { tdCopyIdBtn.dataset.taskId = d.externalId || d.id; }
      const tdCopyLinkBtn = $('tdCopyLinkBtn');
      if (tdCopyLinkBtn) { tdCopyLinkBtn.dataset.url = d.sourceUrl || ''; }
      const tdRefreshBtn = $('tdRefreshBtn');
      if (tdRefreshBtn) { tdRefreshBtn.dataset.taskId = d.id; tdRefreshBtn.dataset.tool = d.sourceTool; }
      const tdOpenPmBtn = $('tdOpenPmBtn');
      if (tdOpenPmBtn) { tdOpenPmBtn.dataset.url = d.sourceUrl || ''; }
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
      if (goalEl) { goalEl.value = msg.taskTitle || ''; state.goal = msg.taskTitle || state.goal; }
      if (appNameEl && !appNameEl.value) { appNameEl.value = state.appName || ''; }
      vscode.postMessage({ type: 'fieldChange', field: 'taskId', value: msg.taskId || '' });
      vscode.postMessage({ type: 'fieldChange', field: 'goal', value: msg.taskTitle || '' });
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
    const card = e.target.closest('.task-card');
    if (card && card.dataset.taskId) {
      _activeTaskId = card.dataset.taskId;
      _activeTaskTool = card.dataset.taskTool;
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
      vscode.postMessage({ type: 'startThreadFromTask', taskId: b.dataset.taskId, title: b.dataset.taskTitle, tool: b.dataset.taskTool, url: b.dataset.taskUrl });
    });
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
    const toggle = e.target.closest('.section-toggle');
    if (!toggle) return;
    const body = document.getElementById(toggle.dataset.target);
    if (!body) return;
    const open = !body.classList.contains('hidden');
    body.classList.toggle('hidden', open);
    const arrow = toggle.querySelector('.toggle-arrow');
    if (arrow) arrow.textContent = open ? '\u25b8' : '\u25be';
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
    populateAutomationSettings();
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
    set('autoFeedbackTrigger', s.autoFeedbackTrigger || 'after_task_done');
    check('requireValidationBeforeAutoClose', s.requireValidationBeforeAutoClose);
    check('requireValidationBeforeFeedback', s.requireValidationBeforeFeedback);
    check('autoPostFeedbackAfterClose', s.autoPostFeedbackAfterClose);
    check('syncPmStatusToTyne', s.syncPmStatusToTyne);
    check('syncTyneStatusToPm', s.syncTyneStatusToPm);
    check('autoMovePmToInProgressOnStart', s.autoMovePmToInProgressOnStart);
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
      vscode.postMessage({ type: 'automationPreviewFeedback' });
    });
  }

  const automationClosePreviewBtn = $('automationClosePreviewBtn');
  if (automationClosePreviewBtn) {
    automationClosePreviewBtn.addEventListener('click', () => {
      const card = $('automationFeedbackPreviewCard');
      if (card) { card.classList.add('hidden'); }
      previewedFeedbackBody = null;
    });
  }

  const automationPostPreviewedBtn = $('automationPostPreviewedBtn');
  if (automationPostPreviewedBtn) {
    automationPostPreviewedBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'automationPostFeedback', bodyOverride: previewedFeedbackBody });
      const card = $('automationFeedbackPreviewCard');
      if (card) { card.classList.add('hidden'); }
      previewedFeedbackBody = null;
    });
  }

  const automationPostFeedbackBtn = $('automationPostFeedbackBtn');
  if (automationPostFeedbackBtn) {
    automationPostFeedbackBtn.addEventListener('click', () => vscode.postMessage({ type: 'automationPostFeedback' }));
  }

  const automationMarkDoneBtn = $('automationMarkDoneBtn');
  if (automationMarkDoneBtn) {
    automationMarkDoneBtn.addEventListener('click', () => vscode.postMessage({ type: 'automationMarkDone' }));
  }

  const automationCompleteBtn = $('automationCompleteBtn');
  if (automationCompleteBtn) {
    automationCompleteBtn.addEventListener('click', () => vscode.postMessage({ type: 'automationCompleteAndFeedback' }));
  }

  const automationSaveSettingsBtn = $('automationSaveSettingsBtn');
  if (automationSaveSettingsBtn) {
    automationSaveSettingsBtn.addEventListener('click', () => {
      const g = (id) => { const el = $(id); return el ? el.value : ''; };
      const c = (id) => { const el = $(id); return el ? el.checked : false; };
      const settings = {
        autoCloseTrigger: g('autoCloseTrigger'),
        autoFeedbackTrigger: g('autoFeedbackTrigger'),
        requireValidationBeforeAutoClose: c('requireValidationBeforeAutoClose'),
        requireValidationBeforeFeedback: c('requireValidationBeforeFeedback'),
        autoPostFeedbackAfterClose: c('autoPostFeedbackAfterClose'),
        syncPmStatusToTyne: c('syncPmStatusToTyne'),
        syncTyneStatusToPm: c('syncTyneStatusToPm'),
        autoMovePmToInProgressOnStart: c('autoMovePmToInProgressOnStart'),
      };
      vscode.postMessage({ type: 'automationSaveSettings', settings });
    });
  }

})();
